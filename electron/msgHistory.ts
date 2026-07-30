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

  constructor(initialMessages: AgentMessage[] = []) {
    this.messages = [...initialMessages]
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

    // 生成摘要文本
    const summaryLines = midMsgs
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => `${m.role === 'user' ? '👤' : '🤖'}: ${(m.content || '').slice(0, 200)}`)
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
    .map(m => `${m.role === 'user' ? '👤' : '🤖'}: ${(m.content || '').slice(0, 200)}`)
    .slice(0, 20)
    .join('\n')

  return [
    ...systemMsgs,
    { role: 'system', content: `📋 【对话摘要】\n${summaryText}\n【摘要结束】` },
    ...recentMsgs,
  ]
}
