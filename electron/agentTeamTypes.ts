// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// agentTeamTypes.ts — Agent 类型定义 (v6.0)
//
// v6.0: 真·多 Agent 团队架构。
//   Lumina = 老大（唯一对用户接口）
//   Yak   = 代码工程师（后台工作者）
//   热茶  = 审查员（后台工作者）
//   三 Agent 可独立配置 LLM。
// ============================================================

// ── 角色身份定义 ──────────────────────────────────────

export type AgentArchetype =
  | 'companion'    // 陪伴型
  | 'technician'   // 技术型
  | 'analyst'      // 分析型
  | 'creative'     // 创意型
  | 'caretaker'    // 照顾型

export type EmotionalTone =
  | 'warm' | 'cool' | 'playful' | 'sarcastic' | 'serious'
  | 'anxious' | 'confident' | 'grumpy' | 'cheerful'

export type KnowledgeDomain =
  | 'code' | 'data' | 'writing' | 'design' | 'research'
  | 'entertainment' | 'life' | 'tech_news' | 'emotion' | 'system'

// ═══ LLM 配置 ═══

export type LlmProvider =
  | 'lmstudio' | 'openai' | 'deepseek' | 'dashscope'
  | 'ollama' | 'siliconflow' | 'custom'

export interface AgentLlmConfig {
  enabled: boolean
  provider: LlmProvider
  model: string
  endpoint: string
  apiKey?: string
  maxContextTokens?: number
  timeout?: number
}

// ═══ v6.0: 团队架构 ═══

/** 团队成员 ID */
export type TeamMemberId = 'lumina' | 'yak' | 'recha'

/** 团队成员定义 */
export interface TeamMember {
  id: TeamMemberId
  name: string
  icon: string
  role: 'boss' | 'worker'
  /** 角色描述（给 Lumina 看，不给用户看） */
  description: string
  /** 专属能力 */
  capabilities: string[]
  /** 知识盲区 */
  blindSpots: string[]
  /** 系统提示词（纯功能描述，无人格扮演） */
  systemPrompt: string
  /** LLM 配置 */
  llmConfig?: AgentLlmConfig
  /** 是否已配置（有 LLM 且 enabled） */
  configured: boolean
  /** TTS 音色 */
  ttsVoice: string
}

/** 委托请求 — Lumina 派活给 Yak/热茶 */
export interface DelegationRequest {
  /** 目标成员 ID */
  to: TeamMemberId
  /** 委托任务描述 */
  task: string
  /** 任务类型 */
  taskType: 'code_write' | 'code_debug' | 'code_explain' | 'code_review' | 'logic_check' | 'risk_assess' | 'counter_argument'
  /** 上下文（本次对话的相关消息） */
  context?: string
  /** 附加文件路径 */
  filePaths?: string[]
  /** 超时（毫秒），默认 120000 */
  timeout?: number
  // 编排选项
  /** 是否启用自动验证（默认根据 taskType 自动判断） */
  autoVerify?: boolean
  /** 自定义验证命令 */
  verifyCommands?: string[]
  /** 是否启用阶段门控（复杂任务自动分阶段执行） */
  usePhaseGate?: boolean
  /** 强制指定复杂度（覆盖自动分析） */
  forceComplexity?: 'simple' | 'complex'
  // 🆕 Phase 1: 委托重试配置
  /** 最大重试次数（默认 2，0 = 不重试） */
  maxRetries?: number
  /** 重试策略 — 降级方式 */
  retryStrategy?: 'same' | 'simplify' | 'escalate'
  // 🆕 Phase 2: 循环控制
  /** 循环配置（覆盖默认值） */
  loopConfig?: Partial<AgentLoopConfig>
  /** 循环阶段的用户批准节点 */
  approvalGates?: LoopPhase[]

  // ═══ v02: 委托上下文传递（修复"Worker 看不到对话历史/任务目标/工具"） ═══
  /**
   * 完整对话历史（用户说了什么、Lumina 之前回复了什么）。
   * Worker 据此理解任务来龙去脉，不再只看到孤零零一条任务。
   */
  conversationHistory?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>
  /**
   * 用户原始请求 / 任务目标。与 task 可能相同，
   * 但当 task 是拆出的子任务时，taskGoal 保留上层原始意图。
   */
  taskGoal?: string
  /**
   * 该 Worker 实际可用的工具名列表。
   * 注入 system prompt，让 Worker 知道自己能调哪些工具。
   */
  availableTools?: string[]
  /** 项目上下文 — Worker 工作时需要知道的根目录/相关文件/技术栈 */
  projectContext?: {
    cwd: string
    relevantFiles?: string[]
    techStack?: string
  }
}

/** 委托结果 — Yak/热茶返回给 Lumina */
export interface DelegationResult {
  /** 是否成功 */
  success: boolean
  /** 结果文本（原始输出，Lumina 需整理成人话） */
  content: string
  /** 错误信息 */
  error?: string
  /** 反问 — Worker 在执行中需要确认的问题（如：F(0)算第1项还是第0项？） */
  questions?: string[]
  /** 工具调用次数 */
  toolCallsCount: number
  /** 耗时（毫秒） */
  elapsedMs: number
  /** 🆕 Phase 1: 重试信息 — 如实记录本轮委托的重试详情 */
  retryInfo?: {
    /** 实际重试次数（0 = 一次性成功，无重试） */
    totalRetries: number
    /** 各轮次的错误原因 */
    attemptErrors: string[]
    /** 是否在重试中降级处理（如简化任务描述、用更小模型、减少工具） */
    wasDegraded: boolean
    /** 最终是否由降级策略成功 */
    recoveredByDegrade: boolean
  }
}

// ═══════════════════════════════════════════════════════════
// 🆕 Phase 2: AgentLoop 结构 — 循环控制核心
// ═══════════════════════════════════════════════════════════

/** 循环停止条件 */
export type LoopStopCondition =
  /** 全部验证通过 */
  | 'all_passed'
  /** 达到最大迭代次数 */
  | 'max_iterations'
  /** 用户手动终止 */
  | 'user_cancelled'
  /** 用户满意度达到阈值 */
  | 'user_satisfied'
  /** 迭代收敛（连续 N 轮输出不再有实质变化） */
  | 'converged'
  /** 某关键阶段不可恢复地失败 */
  | 'critical_failure'

/** 循环阶段状态 */
export type LoopPhase = 'delegate' | 'verify' | 'fix' | 'review' | 'complete'

/** 循环阶段记录 */
export interface LoopStepRecord {
  phase: LoopPhase
  /** 委托目标 */
  target: TeamMemberId
  /** 任务摘要 */
  taskSummary: string
  /** 是否成功 */
  success: boolean
  /** 结果摘要 */
  resultPreview: string
  /** 错误（如果有） */
  error?: string
  /** 时间戳 */
  timestamp: number
  /** 耗时 ms */
  elapsedMs: number
}

/** Agent 循环配置 */
export interface AgentLoopConfig {
  /** 最大委托重试次数 */
  maxRetries: number
  /** 是否启用自动验证闭环 */
  autoVerify: boolean
  /** 是否启用自动修复循环 */
  autoFix: boolean
  /** 最大修复轮数（autoFix 生效时） */
  maxFixRounds: number
  /** 最大总迭代次数 */
  maxIterations: number
  /** 收敛窗口大小（连续多少轮输出不再改变算"收敛"） */
  convergenceWindow: number
  /** 收敛阈值（文本相似度超过此值视为"不再改变"） */
  convergenceThreshold: number
  /** 关键阶段失败后是否继续（如 verify 失败仍可 review） */
  continueOnCriticalFail: boolean
  /** 用户确认节点（哪些阶段需要用户批准才能继续） */
  approvalGates: LoopPhase[]
  /** 🆕 Phase 3: 情感感知 — 是否启用情绪影响循环决策 */
  emotionAware: boolean
  /** 🆕 Phase 3: 情绪阈值 — 超过此强度的情绪会影响循环行为 */
  emotionThreshold: number
}

export const DEFAULT_AGENT_LOOP_CONFIG: AgentLoopConfig = {
  maxRetries: 2,
  autoVerify: true,
  autoFix: true,
  maxFixRounds: 3,
  maxIterations: 10,
  convergenceWindow: 3,
  convergenceThreshold: 0.85,
  continueOnCriticalFail: false,
  approvalGates: [],
  emotionAware: true,
  emotionThreshold: 0.6,
}

/** 循环运行时上下文 */
export interface AgentLoopContext {
  /** 委托配置 */
  config: AgentLoopConfig
  /** 当前迭代计数 */
  currentIteration: number
  /** 当前重试计数 */
  currentRetry: number
  /** 是否已降级 */
  isDegraded: boolean
  /** 各轮步骤记录 */
  steps: LoopStepRecord[]
  /** 停止条件（如果循环已结束） */
  stopCondition?: LoopStopCondition
  /** 停止原因 */
  stopReason?: string
  /** 🆕 Phase 3: 当前 Agent 情绪标签 */
  currentMood?: string
  /** 🆕 Phase 3: 情绪强度 */
  moodIntensity?: number
  /** 🆕 Phase 3: 最近连续输出列表（用于收敛检测） */
  recentOutputs: string[]
}

// ═══ v8.1 新增: 团队通知板 & 共享上下文 ═══

/** 团队通知条目 */
export interface NoticeEntry {
  id: string
  from: TeamMemberId
  message: string
  priority: 'low' | 'normal' | 'high'
  timestamp: string
  read: boolean
}

/** 团队共享上下文条目 */
export interface TeamContextEntry {
  key: string
  value: string
  updatedBy: TeamMemberId
  timestamp: string
}

// ═══ v5.0 遗留: 三模式类型（保留，供 UI 使用） ═══

export type AgentMode = 'chat' | 'code' | 'analyze' | 'creative'

export interface ModeConfig {
  id: AgentMode
  name: string
  icon: string
  description: string
  soulFile: string
  triggers: string[]
  ttsVoice: string
  stylePrompt: string
  extraRules: string
  visible: boolean
}

// ═══ 社交引擎类型（保留） ═══

export interface AgentPersona {
  id: string
  name: string
  icon: string
  archetype: AgentArchetype
  personality: string
  defaultTone: EmotionalTone
  currentTone: EmotionalTone
  knowledgeDomains: KnowledgeDomain[]
  knowledgeBlindSpots: string[]
  speechStyle: string
  catchphrases: string[]
  systemPrompt: string
  allowedTools: string[]
  visible: boolean
  isPrimary: boolean
  ttsVoice: string
  createdAt: string
  activityLevel: number
  memoryContext: string
  lastActive: string
  llmConfig?: AgentLlmConfig
}

export interface AgentRelationship {
  pairKey: string
  agentA: string
  agentB: string
  type: 'friend' | 'colleague' | 'rival' | 'mentor'
  affinity: number
  trust: number
  argumentCount: number
  collaborationCount: number
  lastInteraction: string
  evolutionLog: string[]
}

export interface AgentState {
  id: string
  name: string
  currentTone: EmotionalTone
  activityLevel: number
  busyLevel: number
  isActive: boolean
  lastActive: string
  recentTopics: string[]
  emotion: { joy: number; fatigue: number; focus: number; anxiety: number; curiosity: number }
  /** 是否在线 */
  online?: boolean
  /** 在线状态 */
  status?: 'online' | 'offline' | 'busy'
  /** 个性 */
  persona?: any
  /** 心情标签 */
  mood?: string
  /** 当前心情 */
  currentMood?: string
  /** 精力值 */
  energy?: number
  /** 今日交互次数 */
  dailyUserInteractions?: number
}

export type TeamMood = 'energetic' | 'relaxed' | 'focused' | 'playful' | 'tired' | 'argumentative' | 'stressed' | 'quiet'
export type ConversationMode =
  | 'casual_chat' | 'code_collaboration' | 'morning_ritual'
  | 'evening_ritual' | 'afternoon_ritual' | 'decision_discussion'
  | 'argument' | 'brainstorming' | 'silent' | 'spontaneous'
  | 'collaborative' | 'debate' | 'screen_watch' | 'decision'
export type TrackType = 'chat' | 'code' | 'coding'

export interface TeamState {
  active: boolean
  mood: TeamMood
  conversationMode: ConversationMode
  topicFocus: string | null
  silenceSince: string | null
  lastHeardFrom: Record<string, string>
  /** 当前话题（社交引擎用） */
  currentTopic?: string
  /** 是否正在讨论（社交引擎用） */
  isDiscussing?: boolean
}

export interface TeamConfig {
  maxRounds: number
  cooldownSeconds: number
  replyTimeoutSeconds: number
  requireUnanimity: boolean
  allowArguments: boolean
  autoModeration: boolean
  enableMorningRitual: boolean
  enableEveningRitual: boolean
  enableProactiveChat: boolean
  minIdleSeconds: number
  /** 早安仪式时间（HH:mm） */
  morningRitualTime?: string
  /** 晚安仪式时间（HH:mm） */
  eveningRitualTime?: string
  /** 屏幕讨论是否启用 */
  screenDiscussionEnabled?: boolean
}

export const DEFAULT_TEAM_CONFIG: TeamConfig = {
  maxRounds: 3,
  cooldownSeconds: 60,
  replyTimeoutSeconds: 30,
  requireUnanimity: false,
  allowArguments: true,
  autoModeration: true,
  enableMorningRitual: false,
  enableEveningRitual: false,
  enableProactiveChat: false,
  minIdleSeconds: 300,
}

// 添加缺失的类型（供 teamProactiveSystem 使用）
export interface DecisionOption {
  label: string
  description: string
  proposer: string
  supporters: string[]
  opponents: string[]
  confidence: number
}

export interface ConversationContext {
  teamState: TeamState
  history: AgentMessage[]
  pendingDecision: DecisionProposal | null
  lastSpontaneousTime: number
  trackType: TrackType
  // 🔧 社交引擎运行时字段（set by triggerConversation）
  topic: string
  mode: ConversationMode
  paused?: boolean
  participants?: TeamMemberId[]
  /** Track 配置对象（含 .type, .maxRounds 等） */
  track?: TrackConfig
  currentRound?: number
  maxRounds?: number
  _emptyReplyCount?: number
  _consecutiveTimeouts?: number
  lastActivityTime?: number
  /** 触发原因（仅社交引擎内部使用） */
  trigger?: string
}

export interface AgentMessage {
  role: string
  content: string
  fromId?: string
  toId?: string
  icon?: string
  timestamp?: number
  toolCalls?: any[]
  // 社交引擎实际使用的字段
  id?: string
  agentId?: string
  from?: string
  to?: string   // v6.0 社交引擎使用 'to' 而非 'toId'
}

export interface DecisionProposal {
  /** 提案 ID */
  id?: string
  /** 决策问题 */
  question: string
  /** 上下文描述 */
  context?: string
  /** 选项列表 */
  options: DecisionOption[]
  votes: Record<string, string>
  result: string | null
  reasoning: Record<string, string>
  createdAt: string
  resolvedAt: string | null
}

export interface TrackConfig {
  type: TrackType
  systemPrompt: string
  availableTools: string[]
  maxRounds: number
  useCodeReview: boolean
}

export const DEFAULT_CHAT_TRACK: TrackConfig = {
  type: 'chat',
  systemPrompt: '',
  availableTools: [],
  maxRounds: 3,
  useCodeReview: false,
}

export const DEFAULT_CODE_TRACK: TrackConfig = {
  type: 'code',
  systemPrompt: '',
  availableTools: [],
  maxRounds: 5,
  useCodeReview: true,
}
