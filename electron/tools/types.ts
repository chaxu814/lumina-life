// ============================================================
// types.ts — Agent 工具系统类型定义
// ============================================================

export interface ToolParamSchema {
  type: string
  description: string
  required?: boolean
  enum?: string[]
  default?: any
}

export interface ToolDef {
  name: string
  description: string
  category?: string
  params?: Record<string, ToolParamSchema>
  parameters?: Record<string, any>  // JSON Schema 格式
  handler?: (...args: any[]) => Promise<any>
  toolsets: string[]
  dangerous?: boolean
  blockedInChild?: boolean
}

export interface ToolCall {
  id: string
  name: string
  args: Record<string, any>
}

export interface ToolResult {
  callId: string
  ok: boolean
  content: string
  error?: string
  durationMs?: number
}

export interface LLMToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  // v10.9: 支持多模态 — content 可以是字符串或 OpenAI Vision 格式的数组
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>
  tool_calls?: LLMToolCall[]
  tool_call_id?: string
  name?: string
}

export interface AgentRunConfig {
  mode: 'chat' | 'agent' | 'developer'
  model: string
  baseUrl: string
  apiKey: string
  temperature?: number
  maxTokens?: number
  maxToolCalls?: number
  systemPrompt?: string
  personaId?: string
  /** v2.5: 禁用的工具名列表（由技能开关控制） */
  disabledTools?: string[]
  /** v2.16: 跳过审批流程（团队子 Agent 不需要用户逐项确认） */
  skipApproval?: boolean
  /** v2.16: 手动指定上下文窗口大小 (tokens)，0=自动检测 */
  contextWindow?: number
  /** v3.0: 委托配置注入（用于 delegate_to 等工具创建子 AgentRunner） */
  delegationConfig?: { callerId: string; baseConfig: any } | null
  /** 🆕 v3.6: 标记为子 Agent（过滤 blockedInChild 工具） */
  isChildAgent?: boolean
  /** 🆕 v1.0: 社交模式 — 缩短超时、减少重试，适用于团队对话/委托 */
  socialMode?: boolean
  /** 🆕 v4.0: LLM 请求超时（毫秒） */
  timeout?: number
  /** 🆕 v5.1: 团队群聊模式 — 为 true 时加载团队 persona/AGENTS.md/SOUL/teamContext */
  isGroupChat?: boolean
  /** 🧠 v10.6: 思考过程面板开关 — false 时后端不发送 thinking_stream 事件 */
  trackReasoning?: boolean
  /** 🆕 v15.0: 说出来模式 — 让 Agent 在搜索/工具调用时说出思考过程，而非安静执行 */
  verbalizeThinking?: boolean
  /** 🆕 陪伴会话（如 Live2D 桌宠）：关闭"问句自动联网预搜索"，闲聊/身份问题不再被强制搜索；模型仍可自行调用 web_search */
  noAutoSearch?: boolean
  /** v3.30 团队成本分级：动态 worker 用小模型干杂活时，覆盖 persona 配置中的模型名（baseUrl/apiKey 仍跟随 persona） */
  modelOverride?: string
}

export type AgentEvent =
  | { type: 'thinking'; text?: string }
  | { type: 'thinking_stream'; text?: string; isFirst?: boolean; isLast?: boolean }
  | { type: 'text_stream'; content?: string }
  | { type: 'tool_start'; tool: string; args: Record<string, any> }
  | { type: 'tool_end'; tool: string; result: ToolResult }
  | { type: 'text'; content: string }
  | { type: 'done'; totalTokens?: number }
  | { type: 'error'; error: string }
  | { type: 'approval:pending'; toolName: string; requestId: string; approvalType?: string; timeout?: number; args?: Record<string, any>; summary?: string }
  | { type: 'approval:resolved'; requestId: string; decision: string }
  | { type: 'memory_summary'; summary: string }
  | { type: 'token_update'; totalTokens: number; delta: number; usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }; promptTokens?: number; contextWindow?: number }
  | { type: 'incremental_tool'; toolCall: LLMToolCall }
