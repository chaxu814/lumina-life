// ============================================================
// ipc/memoryIpc.ts — Memory + Config + Vector Search IPC
// v2.5 重构: 从 main.ts (1065行) 提取
// ============================================================

import { ipcMain, app } from 'electron'
import { join } from 'path'
import fs from 'fs'
import { getMemoryStore, MemoryVectorStore } from '../memory/memoryStore'
import { getSessionManager, type SessionData } from '../sessionManager'
import { MessageHistory, isMultimodalMessage, extractMultimodalText, type MultimodalContentItem } from '../msgHistory'
import { ScrollContext } from '../memory/scrollContext'

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

  ipcMain.handle('memory:enable-embedding-server', async (_event, params: {
    url?: string
  }) => {
    const success = await vectorStore.enableEmbeddingServer(params.url)
    if (success) {
      saveConfig({ ...loadConfig(), embedding: { provider: 'embedding_server', url: params.url } })
    }
    return { ok: success, mode: vectorStore.embeddingMode }
  })

  ipcMain.handle('memory:embedding-status', async () => ({
    mode: vectorStore.embeddingMode,
    config: vectorStore.getEmbeddingConfig(),
  }))

  // 🆕 Embedding 热更新
  ipcMain.handle('memory:update-embedding', async (_event, params: {
    mode?: 'ollama' | 'embedding_server' | 'tfidf' | 'none'
    ollamaUrl?: string
    ollamaModel?: string
    embeddingServerUrl?: string
  }) => {
    try {
      if (params.mode === 'ollama' && params.ollamaUrl) {
        await vectorStore.enableOllamaEmbedding(params.ollamaUrl, params.ollamaModel)
      } else if (params.mode === 'embedding_server' && params.embeddingServerUrl) {
        await vectorStore.enableEmbeddingServer(params.embeddingServerUrl)
      }
      
      // 更新配置
      const config = loadConfig()
      config.embedding = {
        provider: params.mode || 'tfidf',
        url: params.ollamaUrl || params.embeddingServerUrl || '',
        model: params.ollamaModel || '',
      }
      saveConfig(config)
      
      return { ok: true, mode: vectorStore.embeddingMode }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // ─── v2.5: Rerank 配置 ───────────────────────────

  ipcMain.handle('memory:enable-rerank', async (_event, params: {
    url?: string; model?: string; topK?: number
  }) => {
    const success = await vectorStore.enableRerank(params.url, params.model, params.topK)
    if (success) {
      saveConfig({ ...loadConfig(), rerank: { enabled: true, url: params.url, model: params.model, topK: params.topK } })
    }
    return { ok: success, status: vectorStore.rerankStatus }
  })

  ipcMain.handle('memory:rerank-status', async () => ({
    ...vectorStore.rerankStatus,
  }))

  // v2.5: 自动从配置恢复 rerank 设置
  const savedConfig = loadConfig()
  if (savedConfig.rerank?.enabled) {
    vectorStore.enableRerank(
      savedConfig.rerank.url || 'http://localhost:11434',
      savedConfig.rerank.model || 'bge-reranker-v2-m3',
      savedConfig.rerank.topK || 10
    ).then(success => {
      if (success) console.log('[MemoryIpc] ✅ 已从配置恢复 Rerank')
    })
  }

  // ─── v2.6: 成对 Q&A 检索 ──────────────────────────

  // 全局 SessionManager 和 MessageHistory 实例
  const sessionManager = getSessionManager()
  const scrollContext = new ScrollContext()

  /**
   * 从指定会话加载消息并构建 MessageHistory
   */
  function loadHistoryForSession(sessionId: string): MessageHistory | null {
    const session = sessionManager.loadSession(sessionId)
    if (!session || !session.messages) return null

    const history = new MessageHistory(session.messages, scrollContext)
    return history
  }

  /**
   * 从当前活跃会话加载消息
   */
  function loadCurrentHistory(): MessageHistory | null {
    // 获取最近活跃的会话
    const sessions = sessionManager.listSessions({ limit: 1 })
    if (sessions.length === 0) return null
    return loadHistoryForSession(sessions[0].id)
  }

  // Q&A 检索 — 按会话 ID
  ipcMain.handle('memory:qa-search', async (_event, params: {
    sessionId?: string
    query?: string
    limit?: number
  }) => {
    try {
      const history = params.sessionId ? loadHistoryForSession(params.sessionId) : loadCurrentHistory()
      if (!history) {
        return { ok: false, error: '未找到会话历史', pairs: [] }
      }

      const pairs = params.query ? history.findQAPairs(params.query, params.limit || 10) : history.getAllQAPairs(params.limit || 50)
      return { ok: true, pairs }
    } catch (err) {
      return { ok: false, error: (err as Error).message, pairs: [] }
    }
  })

  // Q&A 检索 — 获取所有会话的问答对
  ipcMain.handle('memory:qa-all', async (_event, params: { limit?: number }) => {
    try {
      const sessions = sessionManager.listSessions({ limit: 50 })
      const allPairs: Array<{ question: string; answer: string; sessionId: string; timestamp?: number }> = []

      for (const session of sessions) {
        const history = loadHistoryForSession(session.id)
        if (history) {
          const pairs = history.getAllQAPairs(params.limit || 20)
          for (const pair of pairs) {
            allPairs.push({ ...pair, sessionId: session.id })
          }
        }
      }

      // 按时间倒序
      allPairs.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      return { ok: true, pairs: allPairs.slice(0, params.limit || 100) }
    } catch (err) {
      return { ok: false, error: (err as Error).message, pairs: [] }
    }
  })
}
