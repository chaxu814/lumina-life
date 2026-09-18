// ============================================================
// memory/layeredMemoryAdapter.ts — 把 MemoryStore 适配为五层记忆源
//
// 纯适配器：不重新实现检索，只把 MemoryStore 的事实/反思/画像/人格/对话
// 映射到 layeredMemory 的 LayeredMemorySource。工作层通过底层 SQLite
// 跨会话取最近原始对话（MemoryStore.getConversation 是按 sessionId 的）。
//
// 任何查询失败都安全降级，绝不影响主链路。
// ============================================================

import type { MemoryStore } from './memoryStore'
import type { LayeredMemorySource } from './layeredMemory'

interface ConvRow {
  role: string
  content: string
  created_at?: string
}

/** 用 MemoryStore 构造五层记忆源 */
export function createMemoryStoreAdapter(store: MemoryStore | null | undefined): LayeredMemorySource {
  if (!store) {
    return {
      getRecentConversation: () => [],
      getRecentSummaries: () => [],
      getFacts: () => [],
      getReflections: () => [],
      getUserProfile: () => null,
      getPersona: () => null,
    }
  }

  return {
    getRecentConversation(limit: number): Array<{ role: string; content: string; createdAt?: string }> {
      try {
        // 跳过 system/tool 噪声，只取用户与助手的最近来回，跨会话
        const rows = store.getDb().prepare(
          `SELECT role, content, created_at FROM conversation_history
           WHERE role IN ('user','assistant') AND TRIM(content) != ''
           ORDER BY id DESC LIMIT ?`
        ).all(limit * 2) as ConvRow[]
        // 上面按时间倒序取，再反转成时间正序（便于工作层上下文连贯）
        return rows
          .slice(0, limit)
          .reverse()
          .map(r => ({ role: r.role, content: r.content, createdAt: r.created_at }))
      } catch {
        return []
      }
    },

    getRecentSummaries(limit: number): string[] {
      try { return store.getRecentSummaries(limit) } catch { return [] }
    },

    getFacts(limit: number) {
      try {
        const rows = store.getFacts(undefined, limit)
        return rows.map((r: any) => ({
          content: r.content,
          category: r.category,
          confidence: r.confidence,
          source: r.source,
          timestamp: r.timestamp,
        }))
      } catch { return [] }
    },

    getReflections(limit: number) {
      try { return store.getReflections(limit) } catch { return [] }
    },

    getUserProfile() {
      try { return store.getUserProfile() } catch { return null }
    },

    getPersona() {
      try { return store.getPersona() } catch { return null }
    },
  }
}

// 供便捷调用：传入 MemoryStore 直接拿 LayeredMemorySource
export function layeredSourceFromStore(store: MemoryStore | null | undefined): LayeredMemorySource {
  return createMemoryStoreAdapter(store)
}
