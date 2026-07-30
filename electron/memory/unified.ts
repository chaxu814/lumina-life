// ============================================================
// memory/unified.ts — 统一记忆系统入口 (v1.0)
//
// 🔧 P2-fix: 将 3+ 套记忆系统统一为一个入口
//   现有系统：
//     1. memoryStore.ts       — SQLite 持久化（事实/反思/人格/对话）
//     2. memoryRefiner.ts     — 自动精炼
//     3. memoryEvidence.ts    — 证据链
//     4. tools/impl/memory.ts — 工具层旧式记忆
//     5. tools/impl/memory_v2.ts — 工具层记忆
//     6. summarizer.ts        — 上下文压缩
//
//   本模块提供 UnifiedMemory 入口，自动路由到正确系统。
// ============================================================

import { getMemoryStore } from './memoryStore'
import type { FactEntry, ReflectionEntry, StructuredMemory } from './memoryStore'

// ═══════════════════════════════════════════════════════════
// 统一记忆查询选项
// ═══════════════════════════════════════════════════════════

export interface MemoryQuery {
  type?: 'facts' | 'reflections' | 'conversation' | 'semantic' | 'all'
  category?: string
  limit?: number
  keywords?: string
  sessionId?: string
  confidenceMin?: number
}

export interface MemoryEntry {
  id: number | string
  type: 'fact' | 'reflection' | 'conversation' | 'semantic' | 'persona'
  content: string
  category?: string
  confidence?: number
  source?: string
  timestamp: string
  metadata?: Record<string, any>
}

// ═══════════════════════════════════════════════════════════
// UnifiedMemory — 统一记忆门面
// ═══════════════════════════════════════════════════════════

class UnifiedMemory {
  private _stats = {
    totalSaves: 0,
    totalQueries: 0,
    errors: 0,
  }

  get stats() { return { ...this._stats } }

  // =============================================================
  // 写入
  // =============================================================

  /**
   * 保存一条记忆到最合适的系统
   */
  async save(
    content: string,
    options?: {
      type?: 'fact' | 'reflection' | 'semantic'
      category?: string
      confidence?: number
      source?: string
      key?: string  // 用于 semantic 类型
    },
  ): Promise<{ ok: boolean; id?: number | string; error?: string }> {
    this._stats.totalSaves++

    try {
      const store = getMemoryStore()
      const type = options?.type || 'fact'
      const category = options?.category || 'agent_memory'

      switch (type) {
        case 'fact': {
          const id = store.addFact({
            category,
            content,
            confidence: options?.confidence ?? 1.0,
            source: options?.source || 'agent_save',
          })
          return { ok: true, id }
        }

        case 'reflection': {
          const id = store.addReflection({
            topic: category,
            insight: content,
            action: '',
          })
          return { ok: true, id }
        }

        case 'semantic': {
          if (options?.key) {
            store.addMemory({ key: options.key, value: content })
            return { ok: true, id: options.key }
          }
          return { ok: false, error: 'semantic 类型需要 key 参数' }
        }

        default:
          return { ok: false, error: `未知记忆类型: ${type}` }
      }
    } catch (err: any) {
      this._stats.errors++
      return { ok: false, error: err.message }
    }
  }

  // =============================================================
  // 查询
  // =============================================================

  /**
   * 查询记忆（自动路由到正确系统）
   */
  async query(query: MemoryQuery): Promise<MemoryEntry[]> {
    this._stats.totalQueries++
    const results: MemoryEntry[] = []

    try {
      const store = getMemoryStore()
      const limit = query.limit || 10

      switch (query.type) {
        case 'facts': {
          const facts = store.getFacts(query.category)
          for (const f of facts.slice(0, limit)) {
            results.push(this._factToEntry(f))
          }
          break
        }
        case 'reflections': {
          const reflections = store.getReflections(limit)
          for (const r of reflections) {
            results.push({
              id: Date.now(),
              type: 'reflection',
              content: r.insight,
              category: r.topic,
              timestamp: r.timestamp,
            })
          }
          break
        }
        case 'semantic': {
          const allMemories = store.getAllMemories()
          for (const m of allMemories) {
            if (results.length >= limit) break
            if (query.keywords && !m.key.includes(query.keywords) && !m.value.includes(query.keywords)) continue
            results.push({
              id: m.key,
              type: 'semantic',
              content: m.value,
              timestamp: '',
              metadata: m.metadata,
            })
          }
          break
        }
        case 'all':
        default: {
          // 合并来自各系统的结果
          const facts = store.getFacts(query.category)
          for (const f of facts.slice(0, Math.ceil(limit / 2))) {
            results.push(this._factToEntry(f))
          }
          const reflections = store.getReflections(Math.ceil(limit / 2))
          for (const r of reflections) {
            results.push({
              id: Date.now(),
              type: 'reflection',
              content: r.insight,
              category: r.topic,
              timestamp: r.timestamp,
            })
          }
          break
        }
      }
    } catch (err: any) {
      this._stats.errors++
      console.warn(`[UnifiedMemory] 查询失败: ${err.message}`)
    }

    // 如果有 keywords 过滤
    if (query.keywords) {
      const kw = query.keywords.toLowerCase()
      return results.filter(r => r.content.toLowerCase().includes(kw) || (r.category || '').toLowerCase().includes(kw))
    }

    return results
  }

  /**
   * 关键词搜索记忆
   */
  async search(keywords: string, limit: number = 10): Promise<MemoryEntry[]> {
    return this.query({ keywords, limit, type: 'all' })
  }

  /**
   * 获取完整结构化记忆（合并所有系统）
   */
  async getAllStructured(): Promise<StructuredMemory | null> {
    try {
      const store = getMemoryStore()
      return store.getStructuredMemory()
    } catch {
      return null
    }
  }

  /**
   * 清理
   */
  async clear(type?: 'facts' | 'reflections' | 'all'): Promise<{ ok: boolean; count?: number; error?: string }> {
    try {
      const store = getMemoryStore()
      let count = 0
      // 使用 SQL 直接清理（MemoryStore 未暴露 clear* 方法）
      if (!type || type === 'facts' || type === 'all') {
        const r = store['db'].prepare('DELETE FROM facts').run()
        count += r.changes
      }
      if (!type || type === 'reflections' || type === 'all') {
        const r = store['db'].prepare('DELETE FROM reflections').run()
        count += r.changes
      }
      return { ok: true, count }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  }

  // =============================================================
  // 内部
  // =============================================================

  private _factToEntry(f: FactEntry): MemoryEntry {
    return {
      id: f.id,
      type: 'fact',
      content: f.content,
      category: f.category,
      confidence: f.confidence,
      source: f.source,
      timestamp: f.timestamp,
    }
  }
}

// ═══════════════════════════════════════════════════════════
// 单例导出
// ═══════════════════════════════════════════════════════════

let _instance: UnifiedMemory | null = null

export function getUnifiedMemory(): UnifiedMemory {
  if (!_instance) _instance = new UnifiedMemory()
  return _instance
}

export function initUnifiedMemory(): UnifiedMemory {
  _instance = new UnifiedMemory()
  return _instance
}
