// ============================================================
// agentCompactor.ts — QwenPaw 风格上下文压缩器 (v9.0)
//
// 从 agentRunner.ts 提取，独立负责：
//   1. 结构化摘要生成（QwenPaw 格式）
//   2. 增量更新已有摘要
//   3. Token 预算检查 + 主动压缩触发
//
// 设计原则（借鉴 QwenPaw LightContextManager）：
//   - 压缩前做 token 预算检查
//   - 用结构化格式保留关键信息（目标、决策、进展）
//   - 保留最近 N 轮完整对话，不压缩
//   - 支持增量更新：已有摘要时追加而非重新生成
// ============================================================

import { TokenEstimator } from './tokenEstimator'
import type { AgentMessage } from './tools/types'

// ═══════════════════════════════════════════════════════════
//  配置常量
// ═══════════════════════════════════════════════════════════

/** Token 预算硬上限（LM Studio Qwen 9B 实际支持 ~128K，与 lumina-providers.json 同步） */
export const COMPACTOR_TOKEN_BUDGET = 131_072

/** 消息条数上限（v6.0-fix: 从 120 降到 80），配合 65% 的压缩阈值压缩更快生效 */
export const COMPACTOR_MESSAGE_LIMIT = 80

/** 保留的最近完整消息数（增大保留窗口，让 LLM 记得更长期的上下文） */
export const COMPACTOR_RECENT_PAIRS = 50

/** 
 * 压缩触发阈值（v6.0-fix: 从 90% 降到 65%）
 *   长上下文下 LLM 推理时间随 token 数非线性增长。
 *   90% 才压缩 → 此时推理已极慢，前端 180s 超时仍可能触发。
 *   65% 压缩 → 在推理变慢前主动瘦身，避免超时。
 */
export const COMPACTOR_TRIGGER_RATIO = 0.65

// ═══════════════════════════════════════════════════════════
//  结构化摘要
// ═══════════════════════════════════════════════════════════

export interface CompactorSummary {
  /** 结构化摘要文本 */
  text: string
  /** 压缩掉的中间消息数 */
  compressedCount: number
  /** 是否增量更新 */
  isIncremental: boolean
  /** 压缩后的消息数 */
  retainedCount: number
}

/**
 * 从消息列表中提取结构化摘要（QwenPaw 风格）
 * 
 * 格式：
 *   📋 【对话摘要】
 *   【历史摘要延续】← 仅增量更新时
 *   ## 用户关注
 *   ## 关键决策
 *   ## 涉及的文件
 *   ## 最近回复
 */
export function buildStructuredSummary(
  systemMsgs: AgentMessage[],
  midMsgs: AgentMessage[],
  existingSummary: string | null,
): string {
  const entries = midMsgs.filter(m => m.role === 'user' || m.role === 'assistant')

  const userAsks: string[] = []
  const decisions: string[] = []
  const filePaths: string[] = []
  const agentAnswers: string[] = []

  for (const m of entries) {
    const content = (m.content || '').slice(0, 600)
    if (m.role === 'user') {
      userAsks.push(content)
    } else if (m.role === 'assistant') {
      agentAnswers.push(content)
      if (/决定|选[择用]|采用|使用|改为|更(新|改)|修复|确定|确认/i.test(content)) {
        decisions.push(content.slice(0, 150))
      }
      const winPaths = content.match(/[A-Z]:\\[^\s,;)]+/g) || []
      const unixPaths = content.match(/\/[^\s,;)]+/g) || []
      const paths = [...winPaths, ...unixPaths]
      if (paths.length > 0) filePaths.push(...paths)
    }
  }

  const parts: string[] = ['📋 【对话摘要 — QwenPaw 风格结构化压缩】']

  // 已有摘要 → 增量更新
  if (existingSummary) {
    const existingContent = existingSummary
      .replace(/^📋 【对话摘要[^】]*】\n*/, '')
      .replace(/\n【摘要结束】$/, '')
      .trim()
    if (existingContent) {
      parts.push(`\n【历史摘要延续】\n${existingContent}`)
    }
  }

  const recentUserAsks = userAsks.slice(-12)
  const recentAgentAnswers = agentAnswers.slice(-12)

  if (recentUserAsks.length > 0) {
    parts.push(`\n## 用户关注\n${recentUserAsks.map((q, i) => `${i + 1}. ${q}`).join('\n')}`)
  }

  if (decisions.length > 0) {
    const uniqueDecisions = [...new Set(decisions)]
    parts.push(`\n## 关键决策\n${uniqueDecisions.map((d, i) => `- **决策${i + 1}**: ${d}`).join('\n')}`)
  }

  if (filePaths.length > 0) {
    const uniquePaths = [...new Set(filePaths)]
    parts.push(`\n## 涉及的文件\n${uniquePaths.map(p => `- \`${p}\``).join('\n')}`)
  }

  if (recentAgentAnswers.length > 0) {
    parts.push(`\n## 最近回复\n${recentAgentAnswers.map(a => `- ${a.slice(0, 400)}`).join('\n')}`)
  }

  parts.push('\n【摘要结束】')
  return parts.join('\n')
}

/**
 * 判断是否需要压缩
 * @returns true = 需要压缩
 */
export function needsCompaction(
  estimatedTokens: number,
  messageCount: number,
): boolean {
  if (estimatedTokens >= Math.floor(COMPACTOR_TOKEN_BUDGET * COMPACTOR_TRIGGER_RATIO)) {
    return true
  }
  if (messageCount >= COMPACTOR_MESSAGE_LIMIT) {
    return true
  }
  return false
}

/**
 * 执行上下文压缩，返回压缩结果
 * 
 * 支持降级：LLM 压缩函数不可用时自动回退到文本截断
 * 
 * @param messages 当前完整的消息列表
 * @param compressedSummary 已有的压缩摘要（可为 null）
 * @param llmCompressFn 可选的 LLM 压缩函数（异步），失败时回退到规则压缩
 * @returns 压缩后的消息列表 + 摘要信息，或 null（不需要压缩）
 */
export async function compactMessagesAsync(
  messages: AgentMessage[],
  compressedSummary: string | null,
  llmCompressFn?: (text: string) => Promise<string>,
): Promise<{
  messages: AgentMessage[]
  summary: CompactorSummary
} | null> {
  const estimator = new TokenEstimator()
  const estimatedTokens = estimator.estimateMessages(messages)

  if (!needsCompaction(estimatedTokens, messages.length) && !compressedSummary) {
    return null
  }

  // 如果有 LLM 压缩函数，尝试 LLM 压缩（可提供更高质量的摘要）
  if (llmCompressFn) {
    try {
      // 尝试 LLM 压缩
      const allContent = messages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => `[${m.role}]: ${(m.content || '').slice(0, 500)}`)
        .join('\n---\n')
      const llmSummary = await llmCompressFn(allContent)
      if (llmSummary && llmSummary.length > 50) {
        // LLM 压缩成功 — 使用 LLM 生成的摘要
        const systemMsgs = messages.filter(m => m.role === 'system')
        const recentMsgs = messages.slice(-COMPACTOR_RECENT_PAIRS)
        const midMsgs = messages.slice(systemMsgs.length, messages.length - COMPACTOR_RECENT_PAIRS)
        return {
          messages: [
            ...systemMsgs,
            { role: 'system', content: `📋 【对话摘要 — LLM 压缩】\n${llmSummary}\n【摘要结束】` },
            ...recentMsgs,
          ],
          summary: {
            text: llmSummary,
            compressedCount: midMsgs.length,
            isIncremental: !!compressedSummary,
            retainedCount: COMPACTOR_RECENT_PAIRS,
          },
        }
      }
    } catch {
      console.warn('[agentCompactor] LLM 压缩失败，回退到规则压缩')
    }
  }

  // 降级：使用规则压缩（同步，无 LLM 调用）
  return compactMessages(messages, compressedSummary)
}

/**
 * 执行上下文压缩，返回压缩结果
 * 
 * @param messages 当前完整的消息列表
 * @param compressedSummary 已有的压缩摘要（可为 null）
 * @returns 压缩后的消息列表 + 摘要信息，或 null（不需要压缩）
 */
export function compactMessages(
  messages: AgentMessage[],
  compressedSummary: string | null,
): {
  messages: AgentMessage[]
  summary: CompactorSummary
} | null {
  const estimator = new TokenEstimator()
  const estimatedTokens = estimator.estimateMessages(messages)

  if (!needsCompaction(estimatedTokens, messages.length) && !compressedSummary) {
    return null
  }

  const systemMsgs = messages.filter(m => m.role === 'system')

  // 找出旧的压缩摘要
  const existingSummaryIndex = systemMsgs.findIndex(
    m => typeof m.content === 'string' && m.content.startsWith('📋 【对话摘要')
  )
  const existingSummaryInMessages = existingSummaryIndex >= 0
    ? systemMsgs[existingSummaryIndex].content
    : null
  const effectiveExistingSummary = compressedSummary || existingSummaryInMessages

  // 保留最近完整消息
  const recentMsgs = messages.slice(-COMPACTOR_RECENT_PAIRS)

  // 中间消息（需要被压缩的部分）
  const systemEndIndex = systemMsgs.length
  const midMsgs = messages.slice(
    systemEndIndex,
    messages.length - COMPACTOR_RECENT_PAIRS,
  )
  if (midMsgs.length < 3 && !effectiveExistingSummary) return null

  // 生成结构化摘要
  const summaryText = buildStructuredSummary(systemMsgs, midMsgs, effectiveExistingSummary)

  // 移除旧的摘要 system message
  const cleanedSystemMsgs = existingSummaryIndex >= 0
    ? [...systemMsgs.slice(0, existingSummaryIndex), ...systemMsgs.slice(existingSummaryIndex + 1)]
    : systemMsgs

  return {
    messages: [
      ...cleanedSystemMsgs,
      { role: 'system', content: summaryText },
      ...recentMsgs,
    ],
    summary: {
      text: summaryText,
      compressedCount: midMsgs.length,
      isIncremental: !!effectiveExistingSummary,
      retainedCount: COMPACTOR_RECENT_PAIRS,
    },
  }
}
