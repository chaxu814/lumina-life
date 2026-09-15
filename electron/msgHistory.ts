// ============================================================
// msgHistory.ts — 消息历史管理 (v7.0)
//
// 从 agentRunner.ts 提取的消息历史管理逻辑：
//   - 消息添加与自动裁剪
//   - 上下文压缩与 token 预算管理
//   - 快照与回滚
//
// 保持独立可测试，不依赖 AgentRunner 实例。
// ============================================================

import type { AgentMessage } from './tools/types'
import { TokenEstimator } from './tokenEstimator'
import { COMPACTOR_RECENT_PAIRS } from './agentCompactor'
import { ScrollContext, type ScrollRecallResult } from './memory/scrollContext'

// ═══════════════════════════════════════════════════════════
// 多模态消息类型与工具
// ═══════════════════════════════════════════════════════════

export interface MultimodalContentItem {
  type: 'text' | 'image_url' | 'video' | 'audio'
  text?: string
  image_url?: { url: string }
}

/**
 * 检测消息是否包含多模态内容（图片、视频、音频）
 */
export function isMultimodalMessage(msg: AgentMessage): boolean {
  if (typeof msg.content === 'string') return false
  if (!Array.isArray(msg.content)) return false
  return msg.content.some((item: any) => item.type === 'image_url' || item.type === 'video' || item.type === 'audio')
}

/**
 * 从多模态消息中提取文本描述（用于压缩）
 */
export function extractMultimodalText(msg: AgentMessage): string {
  if (typeof msg.content === 'string') return msg.content
  
  const parts: string[] = []
  for (const item of (msg.content as any[]) || []) {
    if (item.type === 'text' && item.text) {
      parts.push(item.text)
    } else if (item.type === 'image_url') {
      const url = item.image_url?.url || '[图片]'
      parts.push(`[图片: ${url.length > 60 ? url.slice(0, 60) + '...' : url}]`)
    } else if (item.type === 'video') {
      parts.push('[视频]')
    } else if (item.type === 'audio') {
      parts.push('[音频]')
    }
  }
  return parts.join('\n') || '[多模态消息]'
}

/**
 * 压缩多模态消息：将图片/视频/音频替换为文本描述
 */
export function compressMultimodalMessage(msg: AgentMessage): AgentMessage {
  if (!isMultimodalMessage(msg)) return msg
  
  const text = extractMultimodalText(msg)
  return {
    ...msg,
    content: text,
  }
}

// ═══════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════

/** 消息压缩 token 预算上限 */
export const TOKEN_BUDGET = 80_000

/** 保留的最近消息数 */
export const KEEP_RECENT = 8

/** 触发压缩的消息数阈值 */
export const COMPACT_THRESHOLD = 60

// ═══════════════════════════════════════════════════════════
// 消息历史类
// ═══════════════════════════════════════════════════════════

export class MessageHistory {
  private messages: AgentMessage[] = []
  private estimator = new TokenEstimator()
  private _scrollContext?: ScrollContext

  constructor(initialMessages: AgentMessage[] = [], scrollContext?: ScrollContext) {
    this.messages = [...initialMessages]
    this._scrollContext = scrollContext
  }

  /** 设置 ScrollContext（延迟注入，避免循环依赖） */
  setScrollContext(scrollContext: ScrollContext): void {
    this._scrollContext = scrollContext
  }

  /** 获取所有消息 */
  getAll(): AgentMessage[] {
    return this.messages
  }

  /** 获取消息数 */
  get length(): number {
    return this.messages.length
  }

  /** 添加消息 */
  push(msg: AgentMessage): void {
    this.messages.push(msg)
  }

  /** 在指定位置截断 */
  splice(start: number, deleteCount?: number): AgentMessage[] {
    return this.messages.splice(start, deleteCount ?? this.messages.length - start)
  }

  /** 获取 slice */
  slice(start?: number, end?: number): AgentMessage[] {
    return this.messages.slice(start, end)
  }

  /** 设置整个历史 */
  set(msgs: AgentMessage[]): void {
    this.messages = msgs
  }

  /** 估算 token 总消耗 */
  estimateTokens(): number {
    return this.messages.reduce((sum, m) => sum + (m.content?.length || 0), 0) * 4
  }

  /** 是否需要压缩 */
  needsCompaction(): boolean {
    const estimatedTokens = this.estimateTokens()
    return estimatedTokens > TOKEN_BUDGET || this.messages.length > COMPACT_THRESHOLD
  }

  /**
   * Scroll 模式：将超出活跃窗口的消息驱逐到索引，不丢失细节。
   * 返回被驱逐的消息数量。
   */
  scrollEvict(sessionId: string, agentId: string | undefined, keepRecent = COMPACTOR_RECENT_PAIRS): { evictedCount: number; indexedSummary: string } {
    if (!this._scrollContext) {
      return { evictedCount: 0, indexedSummary: '' }
    }

    try {
      const result = this._scrollContext.evictToIndex(sessionId, agentId, this.messages, keepRecent)
      if (result.evictedCount > 0) {
        // 保留最近的消息
        this.messages = this.messages.slice(-keepRecent)
        console.log(`[MessageHistory] 📚 Scroll 索引化: 驱逐 ${result.evictedCount} 条历史消息`)
      }
      return result
    } catch (e) {
      console.warn('[MessageHistory] scrollEvict 失败:', e)
      return { evictedCount: 0, indexedSummary: '' }
    }
  }

  /**
   * Scroll 模式：从索引召回历史，回填到上下文。
   * 返回可注入上下文的文本块。
   */
  recallScroll(query: string, limit = 10): string {
    if (!this._scrollContext) {
      return ''
    }

    try {
      const results: ScrollRecallResult[] = (this._scrollContext as any).recall({
        query,
        limit,
      }) as ScrollRecallResult[]

      if (!results || results.length === 0) {
        return ''
      }

      // 格式化召回结果，供注入上下文使用
      const snippets = results.map((r, i) => {
        const date = new Date(r.entry.createdAt).toLocaleString('zh-CN', {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })
        return `[${date}] #${i + 1} (${r.entry.role}): ${r.snippet.slice(0, 200)}`
      })

      const formatted = `📚 【历史对话召回 — 共 ${results.length} 条相关记忆】\n` +
        snippets.join('\n') +
        `\n\n【召回结束】`

      return formatted
    } catch (e) {
      console.warn('[MessageHistory] recallScroll 失败:', e)
      return ''
    }
  }

  /**
   * 执行上下文压缩
   * 保留 system 消息 + 最近 N 条，中间消息生成摘要
   */
  compact(): { before: number; after: number; summarySize: number } {
    const before = this.messages.length
    const systemMsgs = this.messages.filter(m => m.role === 'system')

    if (this.messages.length <= KEEP_RECENT + systemMsgs.length + 2) {
      return { before, after: this.messages.length, summarySize: 0 }
    }

    const recentCount = Math.min(KEEP_RECENT, Math.floor(this.messages.length * 0.3))
    const recentMsgs = this.messages.slice(-recentCount)

    // 被压缩的中间消息
    const midMsgs = this.messages.slice(
      systemMsgs.length,
      this.messages.length - recentCount
    )

    if (midMsgs.length < 3) {
      return { before, after: this.messages.length, summarySize: 0 }
    }

    // 生成摘要文本（🆕 多模态消息压缩为文本描述）
    const summaryLines = midMsgs
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => {
        const displayMsg = isMultimodalMessage(m) ? compressMultimodalMessage(m) : m
        const content = typeof displayMsg.content === 'string' ? displayMsg.content : JSON.stringify(displayMsg.content)
        return `${m.role === 'user' ? '👤' : '🤖'}: ${content.slice(0, 200)}`
      })
      .slice(0, 20)
      .join('\n')

    // 注入摘要并重建
    this.messages = [
      ...systemMsgs,
      {
        role: 'system',
        content: `📋 【对话摘要 — 以下为早期对话的结构化压缩】\n${summaryLines}\n\n【摘要结束】`,
      },
      ...recentMsgs,
    ]

    const after = this.messages.length
    return { before, after, summarySize: midMsgs.length }
  }

  /**
   * 获取快照（用于回滚）
   */
  snapshot(): AgentMessage[] {
    return [...this.messages]
  }

  /**
   * 回滚到快照
   */
  rollback(snapshot: AgentMessage[]): void {
    this.messages = snapshot
  }

  // ── 成对 Q&A 检索 ───────────────────────────────────

  /**
   * 查找最近的问答对（用户提问 + 助手回答）
   * @param query 搜索关键词（匹配用户问题或助手回答）
   * @param limit 返回条数上限
   * @returns 问答对数组，每对包含 question/answer
   */
  findQAPairs(query: string, limit = 10): Array<{ question: string; answer: string }> {
    const pairs: Array<{ question: string; answer: string }> = []
    const msgs = this.messages

    for (let i = 0; i < msgs.length - 1; i++) {
      const curr = msgs[i]
      const next = msgs[i + 1]

      // 用户消息 + 助手回复
      if (curr.role === 'user' && next.role === 'assistant') {
        const question = typeof curr.content === 'string' ? curr.content : extractMultimodalText(curr)
        const answer = typeof next.content === 'string' ? next.content : extractMultimodalText(next)

        // 关键词匹配（简单实现）
        if (!query || question.toLowerCase().includes(query.toLowerCase()) || answer.toLowerCase().includes(query.toLowerCase())) {
          pairs.push({
            question: question.slice(0, 500),
            answer: answer.slice(0, 1000),
          })
        }
      }
    }

    return pairs.slice(-limit)
  }

  /**
   * 获取所有问答对（用于历史搜索 UI）
   */
  getAllQAPairs(limit = 50): Array<{ question: string; answer: string }> {
    return this.findQAPairs('', limit)
  }
}

// ═══════════════════════════════════════════════════════════
// 独立的压缩函数（供外部使用）
// ═══════════════════════════════════════════════════════════

/**
 * 压缩消息数组——纯函数版
 * 不影响原数组，返回新数组
 */
export function compactMessages(
  messages: AgentMessage[],
  options?: { budget?: number; keepRecent?: number }
): AgentMessage[] {
  const budget = options?.budget ?? TOKEN_BUDGET
  const keepRecent = options?.keepRecent ?? KEEP_RECENT

  const estimatedTokens = messages.reduce((sum, m) => sum + (m.content?.length || 0), 0) * 4
  if (estimatedTokens < budget && messages.length <= COMPACT_THRESHOLD) {
    return messages
  }

  const systemMsgs = messages.filter(m => m.role === 'system')
  if (messages.length <= keepRecent + systemMsgs.length + 2) {
    return messages
  }

  const recentMsgs = messages.slice(-keepRecent)
  const midMsgs = messages.slice(systemMsgs.length, messages.length - keepRecent)

  if (midMsgs.length < 3) return messages

  const summaryText = midMsgs
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => {
      const displayMsg = isMultimodalMessage(m) ? compressMultimodalMessage(m) : m
      const content = typeof displayMsg.content === 'string' ? displayMsg.content : JSON.stringify(displayMsg.content)
      return `${m.role === 'user' ? '👤' : '🤖'}: ${content.slice(0, 200)}`
    })
    .slice(0, 20)
    .join('\n')

  return [
    ...systemMsgs,
    { role: 'system', content: `📋 【对话摘要】\n${summaryText}\n【摘要结束】` },
    ...recentMsgs,
  ]
}
