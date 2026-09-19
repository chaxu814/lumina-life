// ============================================================
// memory/scrollContext.ts — Scroll Context 索引化记忆 (P0-1)
//
// 对标 QwenPaw Scroll Context：
//   - 完整保留所有对话历史，不删除
//   - 维护活跃窗口（最近 N 轮完整消息）
//   - 超出窗口的消息进入「已索引」状态，持久化到 SQLite
//   - 支持按日期 / 关键词 / CJK 子串检索，并可注入回上下文
//   - 与现有 msgHistory / agentCompactor / sessionManager 协作
// ============================================================

import { getMemoryStore, type MemoryStore } from './memoryStore'
import { getAgentChatsManager } from '../agentChatsManager'
import { buildStructuredSummary, COMPACTOR_RECENT_PAIRS } from '../agentCompactor'
import type { AgentMessage } from '../tools/types'

// ═══════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════

export interface ScrollIndexEntry {
  id: number
  sessionId: string
  agentId?: string
  role: string
  content: string
  createdAt: string
  keywords?: string[]
  summary?: string
}

export interface ScrollWindow {
  /** 当前保留在活跃窗口中的消息（原始消息） */
  active: AgentMessage[]
  /** 已索引消息的摘要，用于快速回填 */
  indexedSummary: string
  /** 最早一条活跃消息在完整历史中的位置（可选） */
  activeStartIndex?: number
}

export interface ScrollRecallOptions {
  sessionId?: string
  agentId?: string
  query?: string
  startDate?: string
  endDate?: string
  limit?: number
}

export interface ScrollRecallResult {
  entry: ScrollIndexEntry
  score: number
  snippet: string
}

// ═══════════════════════════════════════════════════════════
// ScrollContext
// ═══════════════════════════════════════════════════════════

export class ScrollContext {
  private memoryStore: MemoryStore
  private chatsManager = getAgentChatsManager()

  constructor() {
    this.memoryStore = getMemoryStore()
  }

  // ── 生命周期 ───────────────────────────────────────────

  /** 初始化索引表（幂等） */
  init(): void {
    this.memoryStore.getDb().exec(`
      CREATE TABLE IF NOT EXISTS scroll_index (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        agent_id TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_calls TEXT,
        created_at TEXT DEFAULT (datetime('now','localtime')),
        keywords TEXT DEFAULT '',
        summary TEXT DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_scroll_session ON scroll_index(session_id);
      CREATE INDEX IF NOT EXISTS idx_scroll_agent ON scroll_index(agent_id);
      CREATE INDEX IF NOT EXISTS idx_scroll_created ON scroll_index(created_at);
    `)
  }

  // ── 索引化 ─────────────────────────────────────────────

  /**
   * 将一批消息从活跃窗口"驱逐"到索引。
   * 返回被驱逐的消息数量，以及更新后的摘要。
   */
  evictToIndex(
    sessionId: string,
    agentId: string | undefined,
    messages: AgentMessage[],
    keepRecent = COMPACTOR_RECENT_PAIRS,
  ): { evictedCount: number; indexedSummary: string } {
    if (messages.length <= keepRecent) {
      return { evictedCount: 0, indexedSummary: '' }
    }

    const splitIndex = messages.length - keepRecent
    const toEvict = messages.slice(0, splitIndex)

    const db = this.memoryStore.getDb()
    const insert = db.prepare(
      `INSERT INTO scroll_index (session_id, agent_id, role, content, tool_calls, created_at, keywords, summary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )

    for (const msg of toEvict) {
      const createdAt = new Date().toISOString()
      // 提取纯文本内容（支持多模态）
      const content = typeof msg.content === 'string'
        ? msg.content
        : JSON.stringify(msg.content)
      const keywords = this.extractKeywords(content)
      const summary = this.summarizeMessage(msg)
      insert.run(
        sessionId,
        agentId || null,
        msg.role,
        content,
        (msg as any).tool_calls ? JSON.stringify((msg as any).tool_calls) : null,
        createdAt,
        keywords.join(','),
        summary,
      )
    }

    // 生成结构化摘要，保留被驱逐消息的关键信息
    const indexedSummary = buildStructuredSummary([], toEvict, null)

    return {
      evictedCount: toEvict.length,
      indexedSummary,
    }
  }

  /**
   * 从索引中检索历史消息，支持回填到上下文。
   */
  recall(options: ScrollRecallOptions = {}): ScrollRecallResult[] {
    const { sessionId, agentId, query = '', startDate, endDate, limit = 20 } = options

    let sql = 'SELECT * FROM scroll_index WHERE 1=1'
    const params: any[] = []

    if (sessionId) {
      sql += ' AND session_id = ?'
      params.push(sessionId)
    }
    if (agentId) {
      sql += ' AND agent_id = ?'
      params.push(agentId)
    }
    if (startDate) {
      sql += ' AND created_at >= ?'
      params.push(startDate)
    }
    if (endDate) {
      sql += ' AND created_at <= ?'
      params.push(endDate)
    }

    // 全文匹配优先：关键词或摘要命中
    if (query.trim()) {
      const like = `%${query.trim()}%`
      sql += ` AND (content LIKE ? OR summary LIKE ? OR keywords LIKE ?)`
      params.push(like, like, like)
    }

    sql += ' ORDER BY created_at DESC LIMIT ?'
    params.push(limit)

    const db = this.memoryStore.getDb()
    const rows = db.prepare(sql).all(...params) as any[]

    return rows.map((row) => {
      const content = row.content as string
      const snippet = this.buildSnippet(content, query)
      const score = this.scoreResult(row, query)

      return {
        entry: {
          id: row.id as number,
          sessionId: row.session_id as string,
          agentId: row.agent_id as string | undefined,
          role: row.role as string,
          content,
          createdAt: row.created_at as string,
          keywords: (row.keywords as string || '').split(',').filter(Boolean),
          summary: row.summary as string | undefined,
        },
        score,
        snippet,
      }
    })
  }

  /**
   * 将检索结果整理成可注入上下文的文本块。
   */
  formatForContext(results: ScrollRecallResult[], maxChars = 4000): string {
    if (!results.length) {return ''}

    const lines: string[] = ['📚 【Scroll 召回索引】']
    for (const r of results) {
      const date = r.entry.createdAt.slice(0, 10)
      const role = r.entry.role
      const text = r.snippet || r.entry.content
      lines.push(`- [${date}] ${role}: ${text}`)
    }

    const block = lines.join('\n')
    if (block.length > maxChars) {
      return block.slice(0, maxChars) + '\n...（Scroll 召回已截断）'
    }
    return block
  }

  // ── 工具方法 ───────────────────────────────────────────

  private extractKeywords(text: string): string[] {
    if (!text) {return []}
    const words = text
      .replace(/[^\u4e00-\u9fa5a-zA-Z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 2)
    return Array.from(new Set(words)).slice(0, 12)
  }

  private summarizeMessage(msg: AgentMessage): string {
    const content = typeof msg.content === 'string'
      ? (msg.content || '').slice(0, 120)
      : JSON.stringify(msg.content).slice(0, 120)
    if (!content) {return ''}
    return `${msg.role}: ${content}`
  }

  private buildSnippet(content: string, query: string): string {
    if (!query.trim()) {return content.slice(0, 120)}
    const lower = content.toLowerCase()
    const idx = lower.indexOf(query.toLowerCase())
    if (idx === -1) {return content.slice(0, 120)}
    const start = Math.max(0, idx - 40)
    const end = Math.min(content.length, idx + query.length + 80)
    return (start > 0 ? '...' : '') + content.slice(start, end) + (end < content.length ? '...' : '')
  }

  private scoreResult(row: any, query: string): number {
    let score = 0
    if (row.role === 'user') {score += 1}
    if (query && (row.content as string).toLowerCase().includes(query.toLowerCase())) {score += 2}
    if (row.summary && query && (row.summary as string).toLowerCase().includes(query.toLowerCase())) {score += 1}
    return score
  }
}
