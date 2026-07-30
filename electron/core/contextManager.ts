// ============================================================
// core/contextManager.ts — 上下文管理模块 (v9.3)
//
// 从 agentRunner.ts 提取：上下文窗口检测、消息截断、持久化、
// Token 估算等上下文管理功能。
// ============================================================

import type { AgentMessage, AgentRunConfig } from '../tools/types'
import { getMemoryStore } from '../memory/memoryStore'

// ═══════════════════════════════════════════════════════════
// 上下文窗口检测
// ═══════════════════════════════════════════════════════════

/**
 * 检测消息列表是否接近上下文窗口限制。
 * @returns 超过限制比例，0 表示未超过
 */
export function detectContextLimit(
  messages: AgentMessage[],
  contextWindow: number,
  tokenEstimator: { estimateTokens: (msgs: AgentMessage[]) => number },
): number {
  if (!contextWindow || contextWindow <= 0) return 0
  const estimated = tokenEstimator.estimateTokens(messages)
  const ratio = estimated / contextWindow
  return ratio > 0.85 ? ratio : 0
}

// ═══════════════════════════════════════════════════════════
// 消息截断
// ═══════════════════════════════════════════════════════════

/**
 * 安全截断消息列表至目标 token 以内。
 * 保留 system prompt + 用户最近几轮对话。
 */
export function trimContext(
  messages: AgentMessage[],
  contextLimit: number,
  tokenEstimator: { estimateTokens: (msgs: AgentMessage[]) => number },
): AgentMessage[] {
  const safeLimit = Math.floor(contextLimit * 0.85)
  if (messages.length <= 3) return messages

  // 保留 system prompt
  const systemIdx = messages.findIndex(m => m.role === 'system')
  const systemPart = systemIdx >= 0 ? messages.slice(0, systemIdx + 1) : []
  const conversation = systemIdx >= 0 ? messages.slice(systemIdx + 1) : messages

  // 从尾部开始保留（最近的对话）
  const result = [...systemPart]
  for (let i = conversation.length - 1; i >= 0; i--) {
    const testMsgs = [...result, ...conversation.slice(i)]
    if (tokenEstimator.estimateTokens(testMsgs) <= safeLimit) {
      return testMsgs
    }
  }

  // 极端情况：连 system prompt 都超了，硬截断
  while (tokenEstimator.estimateTokens(result) > safeLimit && result.length > 1) {
    result.pop()
  }
  return result
}

// ═══════════════════════════════════════════════════════════
// Token 估算回退
// ═══════════════════════════════════════════════════════════

/**
 * 当 LLM API 不返回 usage 时的回退估算。
 * 按 ~3.5 字符/token 估算。
 */
export function estimateTokenUsage(
  text: string,
  messages: AgentMessage[],
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number },
): { prompt_tokens: number; completion_tokens: number; total_tokens: number } {
  // 如果 API 返回了有效用量，直接使用
  if (usage?.total_tokens && usage.total_tokens > 0) {
    return {
      prompt_tokens: usage.prompt_tokens || 0,
      completion_tokens: usage.completion_tokens || 0,
      total_tokens: usage.total_tokens,
    }
  }
  // 估算 completion tokens
  const completionTokens = Math.max(1, Math.ceil(text.length / 3.5))
  // 估算 prompt tokens（从 messages 推算）
  const promptText = messages.map(m => (m.content || '') + (m.name || '')).join(' ')
  const promptTokens = Math.max(1, Math.ceil(promptText.length / 3.5))
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  }
}

// ═══════════════════════════════════════════════════════════
// 对话持久化
// ═══════════════════════════════════════════════════════════

/**
 * 将未持久化的消息写入 SQLite conversation_history。
 */
export function persistConversationHistory(
  messages: AgentMessage[],
  sessionId: string,
  lastPersistedIndex: number,
): number {
  try {
    const store = getMemoryStore()
    if (!store) return lastPersistedIndex
    let newIndex = lastPersistedIndex
    for (let i = lastPersistedIndex + 1; i < messages.length; i++) {
      const msg = messages[i]
      const toolCalls = (msg as any).tool_calls
        ? JSON.stringify((msg as any).tool_calls)
        : undefined
      store.addConversation(sessionId, msg.role, msg.content || '', toolCalls)
      newIndex = i
    }
    return newIndex
  } catch {
    // 持久化失败不影响对话
    return lastPersistedIndex
  }
}
