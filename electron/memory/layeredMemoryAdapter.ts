// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
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
      } catch (e) {
        // 🔧 原为静默返回 []：记忆故障被伪装成「用户没有记忆」，
        // Agent 于是表现得像初次见面那样继续对话，
        // 而用户只会觉得「它怎么什么都不记得了」，且无任何线索可查。
        // 这里不能抛错（记忆故障不该拖垮整个 Agent），
        // 但必须留痕：至少让诊断面板能看出「记忆系统出过问题」。
        console.warn('[layeredMemory] 读取记忆数据失败（已按空处理，疑似 DB 损坏或被占用）:', e)
        return []
      }
    },

    getRecentSummaries(limit: number): string[] {
      try { return store.getRecentSummaries(limit) } catch (e) {
        // 🔧 原为静默返回 []：记忆故障被伪装成「用户没有记忆」，
        // Agent 于是表现得像初次见面那样继续对话，
        // 而用户只会觉得「它怎么什么都不记得了」，且无任何线索可查。
        // 这里不能抛错（记忆故障不该拖垮整个 Agent），
        // 但必须留痕：至少让诊断面板能看出「记忆系统出过问题」。
        console.warn('[layeredMemory] 读取记忆数据失败（已按空处理，疑似 DB 损坏或被占用）:', e)
        return []
      }
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
      } catch (e) {
        // 🔧 原为静默返回 []：记忆故障被伪装成「用户没有记忆」，
        // Agent 于是表现得像初次见面那样继续对话，
        // 而用户只会觉得「它怎么什么都不记得了」，且无任何线索可查。
        // 这里不能抛错（记忆故障不该拖垮整个 Agent），
        // 但必须留痕：至少让诊断面板能看出「记忆系统出过问题」。
        console.warn('[layeredMemory] 读取记忆数据失败（已按空处理，疑似 DB 损坏或被占用）:', e)
        return []
      }
    },

    getReflections(limit: number) {
      try { return store.getReflections(limit) } catch (e) {
        // 🔧 原为静默返回 []：记忆故障被伪装成「用户没有记忆」，
        // Agent 于是表现得像初次见面那样继续对话，
        // 而用户只会觉得「它怎么什么都不记得了」，且无任何线索可查。
        // 这里不能抛错（记忆故障不该拖垮整个 Agent），
        // 但必须留痕：至少让诊断面板能看出「记忆系统出过问题」。
        console.warn('[layeredMemory] 读取记忆数据失败（已按空处理，疑似 DB 损坏或被占用）:', e)
        return []
      }
    },

    getUserProfile() {
      try { return store.getUserProfile() } catch (e) {
        // 🔧 原为静默返回 null：记忆故障被伪装成「用户没有记忆」，
        // Agent 于是表现得像初次见面那样继续对话，
        // 而用户只会觉得「它怎么什么都不记得了」，且无任何线索可查。
        // 这里不能抛错（记忆故障不该拖垮整个 Agent），
        // 但必须留痕：至少让诊断面板能看出「记忆系统出过问题」。
        console.warn('[layeredMemory] 读取用户档案失败（已按空处理，疑似 DB 损坏或被占用）:', e)
        return null
      }
    },

    getPersona() {
      try { return store.getPersona() } catch (e) {
        // 🔧 原为静默返回 null：记忆故障被伪装成「用户没有记忆」，
        // Agent 于是表现得像初次见面那样继续对话，
        // 而用户只会觉得「它怎么什么都不记得了」，且无任何线索可查。
        // 这里不能抛错（记忆故障不该拖垮整个 Agent），
        // 但必须留痕：至少让诊断面板能看出「记忆系统出过问题」。
        console.warn('[layeredMemory] 读取用户档案失败（已按空处理，疑似 DB 损坏或被占用）:', e)
        return null
      }
    },
  }
}

// 供便捷调用：传入 MemoryStore 直接拿 LayeredMemorySource
export function layeredSourceFromStore(store: MemoryStore | null | undefined): LayeredMemorySource {
  return createMemoryStoreAdapter(store)
}
