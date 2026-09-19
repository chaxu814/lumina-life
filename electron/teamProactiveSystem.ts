// ============================================================
// teamProactiveSystem.ts — 团队级主动行为系统 (v2.6)
//
// 把多 Agent 团队的社交生活融入 24/7 主动引擎
//
// 新增触发：
//   8.  team_morning    — 早安仪式（团队互道早安+讨论今日计划）
//   9.  team_evening    — 晚安仪式（团队回顾一天）
//   10. team_screen     — 屏幕内容触发团队讨论
//   11. team_decision   — 用户需要决策时团队一起给意见
//   12. team_idle_chat  — 用户长时间不活跃时团队自己聊天
//
// 与现有 proactiveEngine 的关系：
//   不替换，而是注册额外的触发器和事件监听器
// ============================================================

import { globalEventBus, BusEvents } from './eventBus'
import { getTeamManager } from './agentTeamManager'
import { getSocialEngine } from './agentSocialEngine'
import { getAgentMemory } from './agentIndependentMemory'
import type { DecisionProposal, DecisionOption } from './agentTeamTypes'

// ═══════════════════════════════════════════════════════════
// TeamProactiveSystem
// ═══════════════════════════════════════════════════════════

export class TeamProactiveSystem {
  private morningTimer: ReturnType<typeof setTimeout> | null = null
  private eveningTimer: ReturnType<typeof setTimeout> | null = null
  private idleCheckTimer: ReturnType<typeof setInterval> | null = null
  private screenCheckTimer: ReturnType<typeof setInterval> | null = null
  private memoryConsolidationTimer: ReturnType<typeof setInterval> | null = null
  private decayTimer: ReturnType<typeof setInterval> | null = null

  private lastUserActivity = Date.now()
  private idleConversationTriggered = false
  private running = false

  // ══════════════════════════════════════════════════════
  // 启动
  // ══════════════════════════════════════════════════════

  start(): void {
    if (this.running) {return}
    this.running = true

    const team = getTeamManager()
    const config = team.getConfig()
    const social = getSocialEngine()
    const mem = getAgentMemory()

    console.log('[TeamProactive] 团队主动行为系统启动')

    // ── 早安仪式 ──────────────────────────────────────
    this.scheduleRitual('morning', config.morningRitualTime, async () => {
      console.log('[TeamProactive] ☀️ 早安仪式触发')
      team.getTeamState().mood = 'playful'
      await social?.morningRitual()
    })

    // ── 晚安仪式 ──────────────────────────────────────
    this.scheduleRitual('evening', config.eveningRitualTime, async () => {
      console.log('[TeamProactive] 🌙 晚安仪式触发')
      team.getTeamState().mood = 'quiet'
      await social?.eveningRitual()
    })

    // ── 团队自发社交 ──────────────────────────────────
    this.idleCheckTimer = setInterval(async () => {
      const idle = Date.now() - this.lastUserActivity

      // 用户 5 分钟不活跃 → 团队可能自己聊起来
      if (idle > 5 * 60 * 1000 && !this.idleConversationTriggered && social && !social.isTeamDiscussing()) {
        this.idleConversationTriggered = true
        await social.trySpontaneousConversation()
      }

      // 用户回来 → 重置
      if (idle < 60 * 1000 && this.idleConversationTriggered) {
        this.idleConversationTriggered = false
      }
    }, 60_000) // 每分钟检查

    // ── 屏幕讨论 ──────────────────────────────────────
    this.screenCheckTimer = setInterval(async () => {
      if (config.screenDiscussionEnabled && social && !social.isTeamDiscussing()) {
        // 屏幕信息由 proactiveEngine 的 screen_watch 提供
        // 这里只做触发检查
      }
    }, 120_000)

    // ── 记忆整理 ──────────────────────────────────────
    this.memoryConsolidationTimer = setInterval(() => {
      mem.consolidateAll()
    }, 60 * 60 * 1000)

    // ── 精力衰减 ──────────────────────────────────────
    this.decayTimer = setInterval(() => {
      team.tick()
    }, 60_000)

    globalEventBus.emit(BusEvents.TEAM_PROACTIVE_STARTED, {})
  }

  // ══════════════════════════════════════════════════════
  // 停止
  // ══════════════════════════════════════════════════════

  stop(): void {
    this.running = false
    if (this.morningTimer) {clearTimeout(this.morningTimer)}
    if (this.eveningTimer) {clearTimeout(this.eveningTimer)}
    if (this.idleCheckTimer) {clearInterval(this.idleCheckTimer)}
    if (this.screenCheckTimer) {clearInterval(this.screenCheckTimer)}
    if (this.memoryConsolidationTimer) {clearInterval(this.memoryConsolidationTimer)}
    if (this.decayTimer) {clearInterval(this.decayTimer)}
    console.log('[TeamProactive] 已停止')
  }

  // ══════════════════════════════════════════════════════
  // 用户活动心跳
  // ══════════════════════════════════════════════════════

  userActivity(): void {
    this.lastUserActivity = Date.now()
    getTeamManager().userHeartbeat()

    // 用户回来时，触发轻量打招呼
    const team = getTeamManager()
    const luna = team.getAgentState('luna')
    if (luna && (luna.dailyUserInteractions ?? 0) < 1) {
      luna.dailyUserInteractions = (luna.dailyUserInteractions ?? 0) + 1
      globalEventBus.emit(BusEvents.TEAM_USER_RETURNED, {
        idleSeconds: Math.floor((Date.now() - this.lastUserActivity) / 1000),
      })
    }
  }

  // ══════════════════════════════════════════════════════
  // 屏幕感知 → 团队讨论
  // ══════════════════════════════════════════════════════

  async onScreenChange(description: string): Promise<void> {
    const social = getSocialEngine()
    const team = getTeamManager()
    const config = team.getConfig()

    if (!config.screenDiscussionEnabled) {return}

    // 有趣的屏幕内容触发讨论
    const interestingKeywords = ['代码', 'bug', 'error', 'IDE', 'bilibili', '视频', '游戏', '文档', '设计']
    const isInteresting = interestingKeywords.some(k => description.includes(k))

    if (isInteresting && social && !social.isTeamDiscussing()) {
      await social.triggerScreenDiscussion(description)
    }
  }

  // ══════════════════════════════════════════════════════
  // 决策支持 — 团队一起帮用户做决策
  // ══════════════════════════════════════════════════════

  async triggerTeamDecision(question: string, context: string, options: string[]): Promise<string> {
    const social = getSocialEngine()
    const team = getTeamManager()

    const decisionOptions: DecisionOption[] = options.map((opt, i) => ({
      label: String.fromCharCode(65 + i), // A, B, C...
      description: opt,
      proposer: 'user',
      supporters: [],
      opponents: [],
      confidence: 0,
    }))

    const proposal: DecisionProposal = {
      id: `decision-${Date.now()}`,
      question,
      context,
      options: decisionOptions,
      votes: {},
      result: null,
      reasoning: {},
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    }

    if (!social) {return '社交引擎未初始化，无法发起决策讨论。'}
    await social.triggerDecisionDiscussion(proposal)

    // v4.0: triggerDecisionDiscussion 现在是异步触发，不返回 ctx
    // 获取当前活跃对话来汇总意见
    const activeCtx = social.getActiveConversation()
    if (!activeCtx) {return '决策讨论已触发，等待团队回复...'}
    
    const summary = this.summarizeDecision(activeCtx, team)
    return summary
  }

  private summarizeDecision(ctx: any, team: any): string {
    if (!ctx || ctx.history.length === 0) {return '团队暂无明确意见。'}

    const opinions: string[] = []
    for (const msg of ctx.history) {
      const agent = team.getAgentState(msg.from)
      if (agent) {
        opinions.push(`${agent.persona.icon} ${agent.persona.name}: ${msg.content}`)
      }
    }

    return `📋 团队决策讨论总结 (${opinions.length} 条意见):\n\n${opinions.join('\n\n')}`
  }

  // ══════════════════════════════════════════════════════
  // 获取团队状态摘要（供现有 proactiveEngine 使用）
  // ══════════════════════════════════════════════════════

  getTeamStatusSummary(): string {
    const team = getTeamManager()
    const state = team.getTeamState()
    const agents = team.getAllAgents()

    const agentLines = agents.filter((a): a is NonNullable<typeof a> => a != null)
      .map(a => {
        const rels = team.getAllRelationships()
          .filter(r => r.agentA === a.persona.id || r.agentB === a.persona.id)
        const avgAffinity = rels.length > 0
          ? Math.round(rels.reduce((s, r) => s + r.affinity, 0) / rels.length)
          : 0
        return `${a.persona.icon} ${a.persona.name}: 情绪${a.mood} 精力${a.energy}/100 平均亲密度${avgAffinity}`
      })

    return `团队氛围: ${state.mood}\n当前话题: ${state.currentTopic || '无'}\n是否讨论中: ${state.isDiscussing ? '是' : '否'}\n` +
      agentLines.join('\n')
  }

  // ══════════════════════════════════════════════════════
  // 工具方法
  // ══════════════════════════════════════════════════════

  private scheduleRitual(
    type: 'morning' | 'evening',
    timeStr: string | undefined,
    callback: () => Promise<void>,
  ): void {
    // fix: 防御空值 — TeamConfig 没有 morningRitualTime/eveningRitualTime 字段
    if (!timeStr || typeof timeStr !== 'string') {
      console.warn(`[TeamProactive] 跳过 ${type} 仪式: 未配置时间`)
      return
    }
    const [h, m] = timeStr.split(':').map(Number)
    const now = new Date()
    const target = new Date(now)
    target.setHours(h, m, 0, 0)

    if (target <= now) {
      target.setDate(target.getDate() + 1)
    }

    const delay = target.getTime() - now.getTime()

    const timer = setTimeout(async () => {
      await callback()
      // 明天同一时间再次触发
      this.scheduleRitual(type, timeStr, callback)
    }, delay)

    if (type === 'morning') {this.morningTimer = timer}
    else {this.eveningTimer = timer}
  }

  /** 用户活动通知 — 由主进程 heartbeat 或消息发送时调用 */
  noteUserActivity(): void {
    this.lastUserActivity = Date.now()
    this.idleConversationTriggered = false
  }

  isRunning(): boolean {
    return this.running
  }
}

// ═══════════════════════════════════════════════════════════
// 单例
// ═══════════════════════════════════════════════════════════

let _teamProactive: TeamProactiveSystem | null = null

export function initTeamProactive(): TeamProactiveSystem {
  _teamProactive = new TeamProactiveSystem()
  return _teamProactive
}

export function getTeamProactive(): TeamProactiveSystem {
  if (!_teamProactive) {throw new Error('[TeamProactive] 未初始化')}
  return _teamProactive
}
