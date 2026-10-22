// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// hooks/types.ts — Agent 生命周期 Hook 类型定义 (v3.5)
//
// 借鉴 QwenPaw Hook 系统:
//   - beforeReasoning / afterReasoning
//   - beforeToolCall / afterToolCall
//   - onError / onCompaction
// ============================================================

import type { AgentMessage, AgentRunConfig, AgentEvent, LLMToolCall } from '../tools/types'

export type { AgentMessage, AgentRunConfig, AgentEvent, LLMToolCall }

export type HookPriority = 'highest' | 'high' | 'normal' | 'low' | 'lowest'

export interface HookContext {
  /** Agent 运行配置 */
  config: AgentRunConfig
  /** 当前会话 ID */
  sessionId: string
  /** 当前 turn 计数 */
  turnCount: number
  /** 消息历史 */
  messages: AgentMessage[]
  /** 任意附加数据 */
  extra?: Record<string, unknown>
}

export interface BeforeReasoningInput {
  ctx: HookContext
  /** 当前用户输入 */
  userInput: string
  /** 将被发送的完整消息数组 (可修改) */
  messages: AgentMessage[]
  /** 将被附加的工具定义 */
  tools?: unknown[]
  /** 请求体 (可修改) */
  requestBody: Record<string, unknown>
}

export interface AfterReasoningInput {
  ctx: HookContext
  /** LLM 返回的原始文本 */
  response: string
  /** 工具调用 (如有) */
  toolCalls?: LLMToolCall[]
  /** Token 使用量 */
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

export interface BeforeToolCallInput {
  ctx: HookContext
  toolName: string
  toolArgs: Record<string, unknown>
  /** 设置为 true 可阻止此工具调用 */
  veto?: boolean
  vetoReason?: string
  /** 要求用户审批 (设置 severity) */
  requireApproval?: 'low' | 'medium' | 'high' | 'critical'
}

export interface AfterToolCallInput {
  ctx: HookContext
  toolName: string
  toolArgs: Record<string, unknown>
  result: string
  error?: string
  durationMs: number
}

export interface OnErrorInput {
  ctx: HookContext
  error: Error
  stage: 'reasoning' | 'tool_call' | 'compaction' | 'unknown'
  recoverable: boolean
}

export interface OnCompactionInput {
  ctx: HookContext
  beforeTokens: number
  afterTokens: number
  summary: string
}

/**
 * Hook 函数签名
 */
export type BeforeReasoningHook = (input: BeforeReasoningInput) => Promise<void | BeforeReasoningInput>
export type AfterReasoningHook = (input: AfterReasoningInput) => Promise<void>
export type BeforeToolCallHook = (input: BeforeToolCallInput) => Promise<void | BeforeToolCallInput>
export type AfterToolCallHook = (input: AfterToolCallInput) => Promise<void>
export type OnErrorHook = (input: OnErrorInput) => Promise<void>
export type OnCompactionHook = (input: OnCompactionInput) => Promise<void>

export interface HookRegistration {
  id: string
  name: string
  description: string
  priority: HookPriority
  /** 哪些 persona 启用此 Hook (空 = 全部) */
  personas?: string[]
  enabled: boolean
  beforeReasoning?: BeforeReasoningHook
  afterReasoning?: AfterReasoningHook
  beforeToolCall?: BeforeToolCallHook
  afterToolCall?: AfterToolCallHook
  onError?: OnErrorHook
  onCompaction?: OnCompactionHook
}
