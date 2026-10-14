// ============================================================
// agentSocialEngine.ts — Agent 间社交对话引擎 (v6.0)
//
// v6.0 重构 — 调和方案：
//   ⚠️ 白屏修复：编程任务期间完全禁止社交引擎
//   🎭 仅朋友圈可见：社交对话输出到 Moments，不出现在用户聊天窗口
//   🔒 配置检查：三 Agent 都配 LLM + 用户空闲时才触发
//   🚫 CodeTrack 移除：编程走 Lumina 委托流程，不走社交引擎
//
// 功能:
//   1. 自发社交 — Agent 基于团队状态自主发起话题（→ 朋友圈）
//   2. 日常仪式 — 早安/晚安/午后闲聊（→ 朋友圈）
// ============================================================

import type {
  AgentMessage, ConversationContext, ConversationMode, TeamMemberId,
  AgentState, TeamState, DecisionProposal, TrackConfig,
  TrackType,
} from './agentTeamTypes'
import { DEFAULT_CHAT_TRACK, DEFAULT_CODE_TRACK } from './agentTeamTypes'
import { getTeamManager } from './agentTeamManager'
import { globalEventBus, BusEvents } from './eventBus'
import { TEAM_PERSONAS, TEAM_MEMBERS } from './agentTeamPersonas'
import { getAgentConfig } from './agentConfig'
import { llmCoordinator, PRIORITY } from './llmCoordinator'  // 🆕 v2.18: 智能 LLM 调度
// 朋友圈 — 社交对话输出到朋友圈
import { postObservation, postThought, postChatSummary } from './moments/autoPoster'
import { getRelationshipStore } from './agentRelationships'

// ═══════════════════════════════════════════════════════════
// v4.0: 话题库按轨道分离
// ═══════════════════════════════════════════════════════════

interface TopicTemplate {
  topic: string
  mode: ConversationMode
  track: TrackType        // 🆕 v4.0: 所属轨道
  initiator: string
  participants: string[]
  maxRounds: number
  weight: number
  condition?: (team: TeamState) => boolean
  requireTools?: boolean   // 🆕 v4.0: 是否需要工具支持
}

const SPONTANEOUS_TOPICS: TopicTemplate[] = [
  // ═══════════ ChatTrack — 社交闲聊 ═══════════
  {
    topic: '早间签到',
    mode: 'morning_ritual',
    track: 'chat',
    initiator: 'lumina',
    participants: ['lumina', 'recha', 'yak'],
    maxRounds: 3,     // 🆕 v4.0: 6→3
    weight: 10,
    condition: (t) => {
      const h = new Date().getHours()
      return h >= 7 && h <= 10 && t.mood !== 'playful'
    },
  },
  {
    topic: '晚间回顾',
    mode: 'evening_ritual',
    track: 'chat',
    initiator: 'yak',
    participants: ['lumina', 'recha', 'yak'],
    maxRounds: 3,     // 🆕 v4.0: 6→3
    weight: 10,
    condition: (t) => {
      const h = new Date().getHours()
      return h >= 21 && h <= 23
    },
  },
  {
    topic: '午后茶歇',
    mode: 'afternoon_ritual',
    track: 'chat',
    initiator: 'recha',
    participants: ['recha', 'lumina'],
    maxRounds: 3,     // 🆕 v4.0: 4→3
    weight: 8,
    condition: (t) => {
      const h = new Date().getHours()
      return h >= 14 && h <= 16
    },
  },
  {
    topic: '互相鼓励',
    mode: 'spontaneous',
    track: 'chat',
    initiator: 'lumina',
    participants: ['lumina', 'recha', 'yak'],
    maxRounds: 3,     // 🆕 v4.0: 4→3
    weight: 4,
    condition: (t) => t.mood === 'tired' || t.mood === 'stressed',
  },
  {
    topic: '分享今日趣事',
    mode: 'spontaneous',
    track: 'chat',
    initiator: 'lumina',
    participants: ['lumina', 'recha', 'yak'],
    maxRounds: 3,     // 🆕 v4.0: 4→3
    weight: 4,
    condition: () => Math.random() < 0.18,
  },

  // ═══════════ CodeTrack — 编程执行 ═══════════
  {
    topic: '代码审查与重构',
    mode: 'collaborative',
    track: 'coding',
    initiator: 'recha',
    participants: ['recha', 'yak'],
    maxRounds: 0,     // 0 = 不限制，由 CodeTrack 自行管理
    weight: 5,
    requireTools: true,
    condition: () => Math.random() < 0.15,
  },
  {
    topic: '性能优化脑暴',
    mode: 'collaborative',
    track: 'coding',
    initiator: 'recha',
    participants: ['lumina', 'recha', 'yak'],
    maxRounds: 0,
    weight: 5,
    requireTools: true,
    condition: () => Math.random() < 0.15,
  },
  {
    topic: '代码架构评审',
    mode: 'collaborative',
    track: 'coding',
    initiator: 'yak',
    participants: ['recha', 'yak'],
    maxRounds: 0,
    weight: 5,
    requireTools: true,
    condition: () => Math.random() < 0.2,
  },
  {
    topic: 'Bug 狩猎大会',
    mode: 'collaborative',
    track: 'coding',
    initiator: 'recha',
    participants: ['lumina', 'recha', 'yak'],
    maxRounds: 0,
    weight: 4,
    requireTools: true,
    condition: () => Math.random() < 0.15,
  },
  {
    topic: '重构 vs 重写之争',
    mode: 'debate',
    track: 'chat',  // 🆕 v4.0: 争论不涉及代码改动 → ChatTrack
    initiator: 'recha',
    participants: ['recha', 'yak'],
    maxRounds: 3,
    weight: 3,
    condition: () => Math.random() < 0.12,
  },
]

// ═══════════════════════════════════════════════════════════
// v4.0: MoE Prompt 构建 — 只激活当前 speaker
// ═══════════════════════════════════════════════════════════

/** 获取队友的简短摘要（仅在需要时注入） */
function getTeammateSummary(agentId: string): string {
  const p = TEAM_PERSONAS[agentId]
  if (!p) {return ''}
  return `${p.icon} ${p.name}：${p.personality.slice(0, 80)}`
}

/**
 * v4.0 MoE 化 Prompt: 只激活当前 speaker
 *
 * 旧版: 每条 prompt 包含所有队友的完整性格描述 → 注意力稀释
 * 新版: 只注入当前 speaker 的角色 + 必要的上下文
 *       队友信息仅在"上一轮是队友发言"时注入（作为对话延续的上下文）
 */
function buildMoEPrompt(
  speaker: string,
  speakerPersona: ReturnType<typeof getAgentPersonaSafe>,
  ctx: ConversationContext,
  history: AgentMessage[],
): string {
  const persona = speakerPersona
  const personaName = persona?.name || speaker

  // ── 核心：speaker 自己的角色 ──
  let prompt = persona?.systemPrompt || ''
  prompt += `\n\n【当前: ${personaName} 的回合】\n`

  // ── 话题 ──
  prompt += `话题: ${ctx.topic}\n`

  // 🆕 fix-重复啰嗦: 代码题用简洁模式，非代码题保留排版
  const isCodeTask = /代码|bug|debug|实现|算法|api|接口|function |class /i.test(ctx.topic)
  if (isCodeTask) {
    prompt += `\n【输出风格 — 代码题】\n`
    prompt += `- 最多 3 段：问题 → 核心修复 → 一例调用\n`
    prompt += `- 禁止表格、禁止"两种替代方案"、禁止重新定义基础概念\n`
    prompt += `- 上下文里已解释过的概念，只说"沿用前述方案"并直接给新内容\n`
  } else {
    prompt += `\n【输出风格】\n`
    prompt += `- 别堆代码块。解释代码时只说关键逻辑和亮点，不要贴完整代码\n`
    prompt += `- 多用表格和结构化排版。像 WPS 文档那样干净、有条理\n`
    prompt += `- 参考 QwenPaw 的风格：标题分明、列表对齐、层次清晰\n`
    prompt += `- 必要时用 | 表格 | 对比 | 一目了然\n`
  }

  // ── 模式提示（按需注入） ──
  if (ctx.mode === 'morning_ritual') {
    prompt += '现在是早晨，请用轻松愉快的语气打个招呼。\n'
  } else if (ctx.mode === 'evening_ritual') {
    prompt += '现在是一天结束的时候，请回顾一下今天做了什么。\n'
  } else if (ctx.mode === 'debate') {
    prompt += `【技术辩论】你和队友对技术方案有不同看法。清晰表达你的观点和理由，目标是最佳方案。\n`
  }

  // ── 对话历史（精简） ──
  if (history.length > 0) {
    prompt += `\n对话历史：\n`
    const maxHistory = 3  // 🆕 v4.0: MoE 化 — 只保留最近 3 条
    for (const msg of history.slice(-maxHistory)) {
      const aid = msg.agentId ?? msg.from ?? 'unknown'
      const prevPersona = getAgentPersonaSafe(aid)
      // 精简：只保留前 150 字
      const shortContent = msg.content.length > 150
        ? msg.content.slice(0, 150) + '...'
        : msg.content
      prompt += `\`${prevPersona?.name || aid}\`: ${shortContent}\n`
    }
    prompt += `\n现在轮到 \`${personaName}\` 了，请自然回应。\n`
  }

  return prompt
}

// ═══════════════════════════════════════════════════════════
// v4.0: 空回复检测
// ═══════════════════════════════════════════════════════════

/** 检测回复是否为空洞内容 */
function isSubstantialReply(text: string): boolean {
  if (!text || text.trim().length < 15) {return false}
  // 纯语气词
  if (/^[\s]*[嗯哦啊哈呃诶呵嘿嗐嘛呢吧呀噢喔]+[\s!！。.,，…~～]*$/.test(text.trim())) {return false}
  // 无意义的单句
  if (/^(嗯嗯|哦哦|哈哈|好的|行|对|是的|没错|好嘞|ok|OK)[\s!！。.]*$/i.test(text.trim())) {return false}
  // 只有一个字的回应
  if (text.trim().length <= 3) {return false}
  return true
}

// ═══════════════════════════════════════════════════════════
// AgentSocialEngine 主类
// ═══════════════════════════════════════════════════════════

export class AgentSocialEngine {
  private team = getTeamManager()
  private llmCall: (personaId: string, prompt: string, context?: Record<string, unknown>) => Promise<string>
  /** 🆕 v1.0: 工具调用 LLM — 用于 CodeTrack（v6.0 已禁用） */
  private toolLlmCall?: (personaId: string, prompt: string, context?: Record<string, unknown>) => Promise<string>
  private activeConversation: ConversationContext | null = null
  private conversationQueue: ConversationContext[] = []
  private isProcessing = false
  private lastSpontaneousTime = 0
  private lastScreenDiscussionTime = 0
  private dailySpontaneousCount = 0
  /** 🆕 v4.0: 用户是否正在等待（打断社交） */
  private _userIsWaiting = false
  /** 🆕 v6.0: 是否正在进行编程任务 */
  private _isCodingTask = false

  constructor(
    llmCall: (personaId: string, prompt: string, context?: Record<string, unknown>) => Promise<string>,
    toolLlmCall?: (personaId: string, prompt: string, context?: Record<string, unknown>) => Promise<string>,
  ) {
    this.llmCall = llmCall
    this.toolLlmCall = toolLlmCall
  }

  // ═══════════════════════════════════════════════════════
  // 社交引擎守卫 — 防止白屏 + 配置检查
  // ═══════════════════════════════════════════════════════

  /** 🆕 v6.0: 编程任务开始 → 锁定社交引擎 */
  onCodingTaskStart(): void {
    this._isCodingTask = true
    if (this.isProcessing) {
      console.log('[SocialEngine] 🔒 编程任务开始，终止当前社交对话')
      this.activeConversation = null
      this.isProcessing = false
    }
    this.conversationQueue = []
  }

  /** 🆕 v6.0: 编程任务结束 → 解锁社交引擎 */
  onCodingTaskEnd(): void {
    this._isCodingTask = false
    console.log('[SocialEngine] 🔓 编程任务结束，社交引擎恢复')
  }

  /**
   * 🆕 v6.0: 检查是否应该阻止社交引擎
   * @returns true = 阻止（不该触发社交）
   */
  private _shouldBlockSocialEngine(): boolean {
    // 1. 编程任务进行中 → 阻止（修复白屏的核心）
    if (this._isCodingTask) {
      console.log('[SocialEngine] ⛔ 阻止社交：编程任务进行中')
      return true
    }
    // 2. 用户正在等待回复 → 阻止
    if (this._userIsWaiting) {
      return true
    }
    // 3. 🆕 v6.0: 当前模式是 code/analyze → 阻止（编程/分析时不触发社交）
    try {
      const currentMode = this.team.currentMode
      if (currentMode === 'code' || currentMode === 'analyze') {
        return true
      }
    } catch { /* 降级 */ }
    // 4. 🆕 v6.0: 检查是否至少有一个 Agent 配置了 LLM
    //    放宽策略：原要求全员配置（太严苛），现改为至少1个 Agent 能说话即可。
    //    对话中未配置的 Agent 会返回空回复并被自动跳过（见 isSubstantialReply 逻辑）。
    try {
      const anyConfigured = (['lumina', 'yak', 'recha'] as TeamMemberId[]).some(
        (id: TeamMemberId) => getAgentConfig().isConfigured(id)
      )
      if (!anyConfigured) {
        console.log('[SocialEngine] ⛔ 阻止社交：所有 Agent 均未配置 LLM')
        return true
      }
    } catch {
      // 如果引入失败，放行（降级）
    }
    return false
  }

  /** 🆕 v4.0: 用户消息到达 → 打断所有社交活动 */
  onUserMessage(): void {
    this._userIsWaiting = true
    if (this.isProcessing && this.activeConversation) {
      console.log('[SocialEngine] 🛑 用户消息到达，暂停社交对话:', this.activeConversation.topic)
      this.activeConversation.paused = true
    }
    // 清空排队
    if (this.conversationQueue.length > 0) {
      console.log(`[SocialEngine] 🧹 清空 ${this.conversationQueue.length} 个排队对话（用户优先）`)
      this.conversationQueue = []
    }
  }

  /** 🆕 v4.0: 用户交互结束 → 恢复社交 */
  onUserInteractionEnd(): void {
    this._userIsWaiting = false
    console.log('[SocialEngine] ✅ 用户交互结束，社交可以恢复')
  }

  // ═══════════════════════════════════════════════════════
  // 公开 API
  // ═══════════════════════════════════════════════════════

  /** 触发指定对话上下文（外部调用入口） */
  async triggerConversation(ctxPartial: Partial<ConversationContext> & { topic: string; mode: ConversationMode }): Promise<void> {
    // fill missing fields with defaults
    const ctx: ConversationContext = {
      teamState: ctxPartial.teamState || { active: true, mood: 'energetic', conversationMode: ctxPartial.mode, topicFocus: ctxPartial.topic, silenceSince: null, lastHeardFrom: {} },
      history: ctxPartial.history || [],
      pendingDecision: ctxPartial.pendingDecision || null,
      lastSpontaneousTime: ctxPartial.lastSpontaneousTime || 0,
      trackType: ctxPartial.trackType || 'chat',
      topic: ctxPartial.topic,
      mode: ctxPartial.mode,
      paused: ctxPartial.paused,
      participants: ctxPartial.participants,
      track: ctxPartial.track,
      currentRound: ctxPartial.currentRound,
      maxRounds: ctxPartial.maxRounds,
      _emptyReplyCount: ctxPartial._emptyReplyCount,
      _consecutiveTimeouts: ctxPartial._consecutiveTimeouts,
      lastActivityTime: ctxPartial.lastActivityTime,
      trigger: ctxPartial.trigger,
    }
    // 守卫检查
    if (this._shouldBlockSocialEngine()) {return}
    if (this._userIsWaiting) {return}
    // 用户活跃时暂停团队自主聊天
    if (!llmCoordinator.requestPermission('SocialEngine', PRIORITY.SOCIAL)) {
      // 延迟到队列，等用户空闲后再聊
      this.conversationQueue.push(ctx)
      return
    }
    if (this.isProcessing) {
      this.conversationQueue.push(ctx)
      return
    }
    this.isProcessing = true
    this.activeConversation = ctx

    console.log(`[SocialEngine] 🎙️ 社交对话开始: "${ctx.topic}" (${ctx.mode}, ${(ctx.participants || []).length}人, track=${(ctx.track as any)?.type || 'chat'})`)

    globalEventBus.emit(BusEvents.TEAM_DISCUSSION_STARTED, {
      topic: ctx.topic,
      mode: ctx.mode,
      participants: ctx.participants,
    })

    try {
      await this.runConversation(ctx)
    } catch (err: any) {
      console.error('[SocialEngine] 对话异常终止:', err.message)
    } finally {
      globalEventBus.emit(BusEvents.TEAM_DISCUSSION_ENDED, {
        topic: ctx.topic,
        rounds: ctx.currentRound,
      })
      this.activeConversation = null
      this.isProcessing = false
      llmCoordinator.releasePermission('SocialEngine')
      try {
        const parts = (ctx.participants || []) as string[]
        const relStore = getRelationshipStore()
        for (let __i = 0; __i < parts.length; __i++) {
          for (let __j = __i + 1; __j < parts.length; __j++) {
            relStore.recordInteraction(parts[__i], parts[__j], 'chat')
          }
        }
      } catch { /* ignore */ }

      // 处理队列
      if (this.conversationQueue.length > 0 && !this._userIsWaiting) {
        const next = this.conversationQueue.shift()!
        this.triggerConversation(next)
      }
    }
  }

  /** 尝试触发自发社交 */
  trySpontaneousSocial(): TopicTemplate | null {
    // 守卫检查
    if (this._shouldBlockSocialEngine()) {return null}
    const teamData = this.team.getTeamState()
    if (!teamData) {return null}

    // 频率控制
    const now = Date.now()
    if (now - this.lastSpontaneousTime < 30_000) {return null}  // 至少间隔 30s
    if (this.dailySpontaneousCount >= 20) {return null}

    // 检查所有话题
    const eligible = SPONTANEOUS_TOPICS.filter(t => {
      if (t.condition && !t.condition(teamData)) {return false}
      return true
    })

    if (eligible.length === 0) {return null}

    // 加权随机选择
    const totalWeight = eligible.reduce((s, t) => s + t.weight, 0)
    let roll = Math.random() * totalWeight
    for (const t of eligible) {
      roll -= t.weight
      if (roll <= 0) {return t}
    }

    return eligible[eligible.length - 1]
  }

  /** 触发自发社交 */
  async activateSocial(topic: TopicTemplate): Promise<void> {
    // 守卫检查
    if (this._shouldBlockSocialEngine()) {return}
    this.lastSpontaneousTime = Date.now()
    this.dailySpontaneousCount++

    const track = DEFAULT_CHAT_TRACK  // v6.0: 只保留 ChatTrack

    await this.triggerConversation({
      mode: topic.mode,
      topic: topic.topic,
      trigger: `自发社交: ${topic.topic}`,
      participants: topic.participants as TeamMemberId[],
      maxRounds: topic.maxRounds || track.maxRounds,
      currentRound: 0,
      history: [],
      track,
    })
  }

  /** 检查是否有进行中的对话 */
  isConversationActive(): boolean {
    return this.isProcessing
  }

  /** 🆕 v4.0: 获取当前轨道类型 */
  getCurrentTrack(): TrackType | null {
    return this.activeConversation?.track?.type || null
  }

  // ═══════════════════════════════════════════════════════
  // v4.0: 向后兼容 API（供 teamIpc / teamProactiveSystem 调用）
  // ═══════════════════════════════════════════════════════

  /** 早安仪式 */
  async morningRitual(): Promise<void> {
    return this.activateSocial({
      topic: '早间签到',
      mode: 'morning_ritual',
      track: 'chat',
      initiator: 'lumina',
      participants: ['lumina', 'recha', 'yak'],
      maxRounds: 3,
      weight: 10,
    })
  }

  /** 晚安仪式 */
  async eveningRitual(): Promise<void> {
    return this.activateSocial({
      topic: '晚间回顾',
      mode: 'evening_ritual',
      track: 'chat',
      initiator: 'yak',
      participants: ['lumina', 'recha', 'yak'],
      maxRounds: 3,
      weight: 10,
    })
  }

  /** 是否正在讨论中 */
  isTeamDiscussing(): boolean {
    return this.isProcessing
  }

  /** 尝试触发自发对话 */
  async trySpontaneousConversation(): Promise<boolean> {
    const topic = this.trySpontaneousSocial()
    if (!topic) {return false}
    await this.activateSocial(topic)
    return true
  }

  /** 获取活跃对话上下文 */
  getActiveConversation(): ConversationContext | null {
    return this.activeConversation
  }

  /** 屏幕内容讨论触发 */
  async triggerScreenDiscussion(screenDesc: string): Promise<void> {
    if (this._userIsWaiting || this.isProcessing) {return}
    await this.triggerConversation({
      mode: 'screen_watch',
      topic: `屏幕上的内容: ${screenDesc.slice(0, 80)}`,
      trigger: screenDesc,
      participants: ['lumina', 'recha'],
      maxRounds: 3,
      currentRound: 0,
      history: [],
      track: DEFAULT_CHAT_TRACK,
    })
  }

  /** 决策讨论触发 */
  async triggerDecisionDiscussion(proposal: DecisionProposal): Promise<void> {
    if (this._userIsWaiting || this.isProcessing) {return}
    await this.triggerConversation({
      mode: 'decision',
      topic: proposal.question,
      trigger: `用户需要决定: ${proposal.question}`,
      participants: ['lumina', 'recha', 'yak'],
      maxRounds: 3,
      currentRound: 0,
      history: [],
      track: DEFAULT_CHAT_TRACK,
    })
  }

  // ═══════════════════════════════════════════════════════
  // 对话执行核心
  // ═══════════════════════════════════════════════════════

  private async runConversation(ctx: ConversationContext): Promise<void> {
    // 💰 Budget Guardian：预算 ≥95% 时社交引擎整体暂停（非必要 LLM 调用）。
    // 用户主动对话不经过这里，永远不被砍。账单查不到就照常（失败开放）。
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { getBudgetGuardian } = require('./billing/budgetGuardian')
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { getUsageLedger } = require('./billing/usageLedger')
      const guardian = getBudgetGuardian()
      guardian.evaluate(getUsageLedger().today().cost)
      if (!guardian.allowNonEssentialCall().allowed) {
        console.log('[SocialEngine] 💰 预算已达降级线，本轮社交对话暂停')
        return
      }
    } catch { /* 账单不可查就照常 */ }

    const isCodeTrack = ctx.track?.type === 'coding'

    if (isCodeTrack) {
      return this._runCodeTrack(ctx)
    }

    return this._runChatTrack(ctx)
  }

  // ═══════════════════════════════════════════════════════
  // ChatTrack — 社交闲聊轨道
  // ═══════════════════════════════════════════════════════

  private async _runChatTrack(ctx: ConversationContext): Promise<void> {
    const history: AgentMessage[] = []
    let currentSpeaker = this.selectFirstSpeaker(ctx)

    for (let round = 0; round < (ctx.maxRounds ?? 3); round++) {
      // 每轮检查用户打断
      if (this._userIsWaiting || ctx.paused) {
        console.log('[SocialEngine] 🛑 ChatTrack 被用户打断')
        return
      }

      ctx.currentRound = round
      const speaker = currentSpeaker
      if (!speaker) {break}

      const speakerPersona = this.getAgentPersonaSafe(speaker)

      // MoE 化 Prompt
      const prompt = buildMoEPrompt(speaker, speakerPersona, ctx, history)

      try {
        const response = await this.llmCall(speaker, prompt, {
          mode: ctx.mode,
          topic: ctx.topic,
          history,
        })

        // 空回复检测
        if (!isSubstantialReply(response || '')) {
          ctx._emptyReplyCount = (ctx._emptyReplyCount || 0) + 1
          console.log(`[SocialEngine] 🗑️ ${speakerPersona?.name || speaker} 空回复，跳过 (连续${ctx._emptyReplyCount}次)`)
          if (ctx._emptyReplyCount >= 2) {
            // 连续 2 次空回复 → 跳过此 agent
            currentSpeaker = this.selectNextSpeaker(speaker, ctx)
            continue
          }
          // 不算入 history，直接下一轮
          currentSpeaker = this.selectNextSpeaker(speaker, ctx)
          continue
        }

        ctx._emptyReplyCount = 0  // 重置空回复计数

        const msg = {
          id: `msg-${speaker}-${Date.now()}`,
          agentId: speaker,
          from: speaker,
          to: 'team',
          content: response || '',
          type: 'chat' as const,
          emotion: 'warm',
          timestamp: Date.now(),
          processed: false,
          round,
        } as unknown as AgentMessage
        history.push(msg)

        globalEventBus.emit(BusEvents.AGENT_SOCIAL_MESSAGE, msg)
        // 同步发到朋友圈
        try {
          postThought(speaker, speakerPersona?.name || speaker, response?.slice(0, 200) || '', 'warm')
        } catch { /* 朋友圈不可用时降级 */ }
        ctx._consecutiveTimeouts = 0

      } catch (err: any) {
        const errMsg = (err?.message || String(err)).toLowerCase()

        // 模型未加载 → 终止
        if (errMsg.includes('no models loaded') || errMsg.includes('load a model')) {
          console.warn('[SocialEngine] 模型未加载，跳过本轮')
          break
        }

        // 熔断器 → 暂停
        if (errMsg.includes('熔断器已打开') || errMsg.includes('circuit')) {
          console.warn('[SocialEngine] 熔断器保护中，暂停')
          ctx.paused = true
          this.conversationQueue.push(ctx)
          return
        }

        // 超时 → 注入系统消息告知下一个 speaker
        if (errMsg.includes('超时') || errMsg.includes('timeout') || errMsg.includes('abort')) {
          ctx._consecutiveTimeouts = (ctx._consecutiveTimeouts || 0) + 1
          console.warn(`[SocialEngine] ⏰ ${speakerPersona?.name || speaker} 超时 (连续${ctx._consecutiveTimeouts}次)`)

          if (ctx._consecutiveTimeouts >= 2) {
            console.warn('[SocialEngine] 连续 2 次超时，终止本轮')
            break
          }

          // 注入"掉线"消息
          history.push({
            id: `msg-system-${Date.now()}`,
            agentId: 'system',
            from: 'system',
            to: 'team',
            content: `⚠️ ${speakerPersona?.name || speaker} 暂时掉线（LLM 超时），请 ${this.selectNextSpeaker(speaker, ctx)} 先接上`,
            type: 'chat',
            emotion: 'warm',
            timestamp: Date.now(),
            processed: true,
            round,
          } as unknown as AgentMessage)
        }

        // 错误后切换 speaker
        currentSpeaker = this.selectNextSpeaker(speaker, ctx)
        continue
      }

      currentSpeaker = this.selectNextSpeaker(speaker, ctx)
    }
  }

  // ═══════════════════════════════════════════════════════
  // CodeTrack — 编程执行轨道
  // ═══════════════════════════════════════════════════════

  private async _runCodeTrack(ctx: ConversationContext): Promise<void> {
    // CodeTrack 已移除 — 编程走 Lumina 委托流程，不走社交引擎
    console.log('[SocialEngine] ⛔ CodeTrack 已禁用（v6.0），编程任务应通过 Lumina 委托流程处理')
    return
  }

  // ═══════════════════════════════════════════════════════
  // 发言顺序
  // ═══════════════════════════════════════════════════════

  private selectFirstSpeaker(ctx: ConversationContext): string {
    return (ctx.participants?.[0]) || 'lumina'
  }

  private selectNextSpeaker(current: string, ctx: ConversationContext): string {
    const p = ctx.participants
    if (!p) {return 'lumina'}
    const idx = p.indexOf(current as TeamMemberId)
    if (idx < 0 || idx >= p.length - 1) {return p[0]}
    return p[idx + 1]
  }

  // ═══════════════════════════════════════════════════════
  // 辅助
  // ═══════════════════════════════════════════════════════

  private getAgentPersonaSafe(agentId: string): ReturnType<typeof getAgentPersonaSafe> {
    return getAgentPersonaSafe(agentId)
  }
}

// ═══════════════════════════════════════════════════════════
// 全局辅助函数
// ═══════════════════════════════════════════════════════════

function getAgentPersonaSafe(agentId: string): { name: string; systemPrompt: string } | null {
  const persona = TEAM_PERSONAS[agentId]
  if (!persona) {return null}
  return {
    name: persona.name,
    systemPrompt: persona.systemPrompt,
  }
}

// ═══════════════════════════════════════════════════════════
// SocialEngine 单例（垫片 → 委派给 AgentOrchestrator）
// ═══════════════════════════════════════════════════════════

let _socialEngineInstance: AgentSocialEngine | null = null

export function getSocialEngine(
  llmCall?: (personaId: string, prompt: string, context?: Record<string, unknown>) => Promise<string>,
  toolLlmCall?: (personaId: string, prompt: string, context?: Record<string, unknown>) => Promise<string>,
): AgentSocialEngine {
  // 优先从 orchestrator 返回
  try {
    const { getOrchestrator } = require('./core/agentOrchestrator')
    const orch = getOrchestrator()
    if (orch.socialEngine) {return orch.socialEngine}
  } catch {}
  // 本地创建
  if (!_socialEngineInstance) {
    if (!llmCall) {throw new Error('[SocialEngine] 首次调用需要 llmCall')}
    _socialEngineInstance = new AgentSocialEngine(llmCall, toolLlmCall)
    // 同步到 orchestrator
    try {
      const { getOrchestrator } = require('./core/agentOrchestrator')
      getOrchestrator().socialEngine = _socialEngineInstance
    } catch {}
  }
  return _socialEngineInstance
}

export function resetSocialEngine(): void {
  _socialEngineInstance = null
}
