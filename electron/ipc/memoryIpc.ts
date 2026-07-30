// ============================================================
// ipc/memoryIpc.ts — Memory + Config + Vector Search IPC
// v2.5 重构: 从 main.ts (1065行) 提取
// ============================================================

import { ipcMain, app } from 'electron'
import { join } from 'path'
import fs from 'fs'
import { getMemoryStore, MemoryVectorStore } from '../memory/memoryStore'

const configPath = join(app.getPath('userData'), 'lumina-config.json')
const memoryPath = join(app.getPath('userData'), 'lumina-memory.db')

// 全局向量存储实例
const vectorStore = new MemoryVectorStore()

function loadConfig(): Record<string, any> {
  try { if (fs.existsSync(configPath)) return JSON.parse(fs.readFileSync(configPath, 'utf-8')) } catch {}
  return {}
}

function saveConfig(config: Record<string, any>): void {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
}

export function registerMemoryIpc(): void {
  // ─── Config ──────────────────────────────────────

  ipcMain.handle('config:get', () => loadConfig())
  ipcMain.handle('config:set', (_event, updates: Record<string, any>) => {
    const merged = { ...loadConfig(), ...updates }
    saveConfig(merged)
    return merged
  })
  ipcMain.handle('config:saveToDb', async (_event, key: string, value: any) => {
    const store = getMemoryStore(memoryPath)
    store.saveUserProfile({ preferences: [`${key}:${JSON.stringify(value)}`] })
    return { ok: true }
  })
  ipcMain.handle('config:loadFromDb', async (_event, key: string) => {
    const profile = getMemoryStore(memoryPath).getUserProfile()
    const pref = profile?.preferences?.find(p => p.startsWith(`${key}:`))
    if (!pref) return null
    try { return JSON.parse(pref.slice(key.length + 1)) } catch { return null }
  })

  // ─── Memory ──────────────────────────────────────

  ipcMain.handle('memory:save', (_event, params: { category: string; content: string }) => {
    const store = getMemoryStore(memoryPath)
    switch (params.category) {
      case 'preference': store.saveUserProfile({ preferences: [params.content] }); break
      case 'habit': store.saveUserProfile({ habits: [params.content] }); break
      case 'lesson': store.saveMemoryConfig({ lessons: [params.content] }); break
      case 'convention': store.saveMemoryConfig({ projectConventions: [params.content] }); break
      case 'fact': store.addFact({ category: 'user', content: params.content, confidence: 1.0, source: 'user_said' }); break
      case 'reflection': store.addReflection({ topic: '会话反思', insight: params.content, action: '' }); break
      default: store.saveMemoryConfig({ systemInfo: [params.content] }); break
    }
    return { ok: true }
  })

  ipcMain.handle('memory:get', (_event, section: string) => {
    const store = getMemoryStore(memoryPath)
    if (section === 'user') return store.getUserProfile()
    if (section === 'memory') return store.getMemoryConfig()
    if (section === 'facts') return store.getFacts()
    if (section === 'reflections') return store.getReflections()
    if (section === 'persona') return store.getPersona()
    return store.getStructuredMemory()
  })

  ipcMain.handle('memory:all', () => getMemoryStore(memoryPath).getMemoryInjectionText())
  ipcMain.handle('memory:profile', () => getMemoryStore(memoryPath).getStructuredMemory())

  // ─── Vector Search ───────────────────────────────

  ipcMain.handle('memory:vector-search', async (_event, params: {
    query: string; topK?: number; minScore?: number
  }) => {
    const store = getMemoryStore(memoryPath)
    const structured = store.getStructuredMemory()

    // 索引现有记忆到向量存储
    if (vectorStore.size === 0) {
      for (const fact of structured.facts) {
        vectorStore.addEntry(`[事实:${fact.category}] ${fact.content}`, {
          type: 'fact', category: fact.category, confidence: fact.confidence,
        })
      }
      for (const ref of structured.reflections) {
        vectorStore.addEntry(`[反思:${ref.topic}] ${ref.insight}`, {
          type: 'reflection', topic: ref.topic,
        })
      }
      if (structured.user.preferences.length > 0) {
        vectorStore.addEntry(`[偏好] ${structured.user.preferences.join(' | ')}`, { type: 'preference' })
      }
      if (structured.user.habits.length > 0) {
        vectorStore.addEntry(`[习惯] ${structured.user.habits.join(' | ')}`, { type: 'habit' })
      }
      for (const lesson of structured.memory.lessons) {
        vectorStore.addEntry(`[教训] ${lesson}`, { type: 'lesson' })
      }
      for (const conv of structured.memory.projectConventions) {
        vectorStore.addEntry(`[约定] ${conv}`, { type: 'convention' })
      }
    }

    const results = await vectorStore.search(params.query, params.topK || 5, params.minScore || 0.05)
    return { results }
  })

  // 记忆运维 — 统计
  ipcMain.handle('memory:stats', async () => {
    const store = getMemoryStore(memoryPath)
    const facts = store.getFacts()
    const reflections = store.getReflections()
    const profile = store.getUserProfile()
    const config = store.getMemoryConfig()
    const structured = store.getStructuredMemory()

    return {
      totalFacts: (facts || []).length,
      totalReflections: (reflections || []).length,
      totalPreferences: (profile?.preferences || []).length,
      totalHabits: (profile?.habits || []).length,
      totalLessons: (config?.lessons || []).length,
      totalConventions: (config?.projectConventions || []).length,
      vectorStoreSize: vectorStore.size,
      embeddingMode: vectorStore.embeddingMode,
      lastIndexed: Date.now(),
      dbSize: fs.existsSync(memoryPath) ? fs.statSync(memoryPath).size : 0,
    }
  })

  // 记忆运维 — 重建向量索引
  ipcMain.handle('memory:reindex', async () => {
    const store = getMemoryStore(memoryPath)
    const structured = store.getStructuredMemory()

    vectorStore.clear()
    let indexed = 0

    for (const fact of structured.facts) {
      vectorStore.addEntry(`[事实:${fact.category}] ${fact.content}`, {
        type: 'fact', category: fact.category, confidence: fact.confidence,
      })
      indexed++
    }
    for (const ref of structured.reflections) {
      vectorStore.addEntry(`[反思:${ref.topic}] ${ref.insight}`, {
        type: 'reflection', topic: ref.topic,
      })
      indexed++
    }
    if (structured.user.preferences.length > 0) {
      vectorStore.addEntry(`[偏好] ${structured.user.preferences.join(' | ')}`, { type: 'preference' })
      indexed++
    }
    if (structured.user.habits.length > 0) {
      vectorStore.addEntry(`[习惯] ${structured.user.habits.join(' | ')}`, { type: 'habit' })
      indexed++
    }
    for (const lesson of structured.memory.lessons) {
      vectorStore.addEntry(`[教训] ${lesson}`, { type: 'lesson' })
      indexed++
    }
    for (const conv of structured.memory.projectConventions) {
      vectorStore.addEntry(`[约定] ${conv}`, { type: 'convention' })
      indexed++
    }

    return { ok: true, indexed, vectorSize: vectorStore.size }
  })

  // 记忆运维 — 清空记忆分类
  ipcMain.handle('memory:clear-category', async (_event, category: string) => {
    // 通过 MemoryStore 的公共 API 处理
    const store = getMemoryStore(memoryPath)
    switch (category) {
      case 'facts':
        // 无法直接清空，标记返回
        return { ok: false, error: 'facts 不支持批量清空，请使用前端逐条删除' }
      case 'reflections':
        return { ok: false, error: 'reflections 不支持批量清空' }
      case 'all':
        // 全部清空: 重新初始化 memory store
        return { ok: false, error: '请使用 memory:reindex 重建索引而非清空' }
      default:
        return { ok: false, error: `未知类别: ${category}` }
    }
  })

  // ─── v2.5: Ollama Embedding 配置 ─────────────────

  ipcMain.handle('memory:enable-ollama', async (_event, params: {
    url?: string; model?: string
  }) => {
    const success = await vectorStore.enableOllamaEmbedding(params.url, params.model)
    // 持久化配置
    if (success) {
      saveConfig({ ...loadConfig(), embedding: { provider: 'ollama', url: params.url, model: params.model } })
    }
    return { ok: success, mode: vectorStore.embeddingMode }
  })

  ipcMain.handle('memory:embedding-status', async () => ({
    mode: vectorStore.embeddingMode,
  }))

  // v2.5: 自动从配置恢复 embedding 设置
  const savedConfig = loadConfig()
  if (savedConfig.embedding?.provider === 'ollama') {
    vectorStore.enableOllamaEmbedding(
      savedConfig.embedding.url || 'http://localhost:11434',
      savedConfig.embedding.model || 'nomic-embed-text'
    ).then(success => {
      if (success) console.log('[MemoryIpc] ✅ 已从配置恢复 Ollama embedding')
    })
  }
}
