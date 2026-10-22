// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tokenEstimator.ts — Token 估算器 (v2.7)
//
// 借鉴 QwenPaw EstimatedTokenCounter:
//   不需要精确 tokenizer，用启发式算法快速估算 token 数
//   用于判断何时触发上下文压缩
//
// 中文: ~1.5 chars/token
// 英文: ~4 chars/token
// 混合: ~2.5 chars/token
// ============================================================

// ═══════════════════════════════════════════════════════════
// Token 估算
// ═══════════════════════════════════════════════════════════

export class TokenEstimator {
  private totalTokens = 0
  private compressionThreshold: number
  private warningThreshold: number

  constructor(options?: { threshold?: number; warningRatio?: number }) {
    this.compressionThreshold = options?.threshold ?? 131072  // 128K tokens (与 LM Studio 9B 模型实际上下文窗口匹配)
    this.warningThreshold = this.compressionThreshold * (options?.warningRatio ?? 0.80)
  }

  /** 估算单段文本的 token 数 */
  estimate(text: string): number {
    if (!text) {return 0}
    const chars = text.length
    // 统计中文字符比例
    const cjkCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length
    const cjkRatio = cjkCount / chars
    // 混合估算: 中文 ~1.5 chars/token, 英文 ~4 chars/token
    const avgCharsPerToken = cjkRatio * 1.5 + (1 - cjkRatio) * 4
    return Math.ceil(chars / avgCharsPerToken)
  }

  /** 估算消息数组的总 token 数 */
  estimateMessages(messages: Array<{ content: string | any[]; role?: string; tool_calls?: unknown[] }>): number {
    let total = 0
    for (const msg of messages) {
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
      total += this.estimate(content)
      // 工具调用额外开销
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          total += this.estimate(JSON.stringify(tc))
        }
      }
    }
    return total
  }

  /** 累加 token */
  add(tokens: number): void {
    this.totalTokens += tokens
  }

  /** 获取累计 tokens */
  getTotal(): number {
    return this.totalTokens
  }

  /** 重置 */
  reset(): void {
    this.totalTokens = 0
  }

  /** 是否需要压缩 */
  needsCompaction(): boolean {
    return this.totalTokens >= this.compressionThreshold
  }

  /** 是否需要警告 */
  needsWarning(): boolean {
    return this.totalTokens >= this.warningThreshold
  }

  /** 获取压缩紧迫度 (0-1) */
  compactionUrgency(): number {
    if (this.totalTokens >= this.compressionThreshold) {return 1.0}
    if (this.totalTokens <= this.warningThreshold * 0.5) {return 0}
    return (this.totalTokens - this.warningThreshold * 0.5) /
           (this.compressionThreshold - this.warningThreshold * 0.5)
  }

  /** 格式化 token 数 */
  static format(n: number): string {
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
  }
}
