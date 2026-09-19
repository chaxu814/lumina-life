// ============================================================
// proactive/orchestrator.ts — 🧭 统一主动编排器（N.E.K.O 对齐 v6.1）
//
// 把两套割裂的主动系统（渲染页 autonomy tick / 主进程触发器）统一成一条管线：
//   触发器(任意来源) ─▶ onTrigger(ProactiveEvent)
//     ├─ gate 门控（配额/冷却/场景/用户说话）
//     ├─ 精力过低 → 只做睡觉动作不说话
//     ├─ innerThoughts 内心独白 → generator 现场生成台词动作
//     ├─ shouldSpeak=false → 记录 reason，沉默
//     └─ 包装成 PetIntent → dispatchIntent（Live2D 表情/口型/TTS）
// 维护：退避状态、未答话头、最近 10 条台词（防重复）、内驱力引用。
// ============================================================

import { globalEventBus, BusEvents } from '../eventBus'
import { getUsageStats } from '../usageStats'
import { loadLifeState } from '../pet/lifeStateStore'
import { getScreenGate } from '../pet/lifeServices'
import { isPetEnabled, getPetLastInteraction } from '../pet/petWindow'
import { dispatchIntent, type PetIntent } from '../pet/intentDispatcher'
import { getMemoryStore } from '../memory/memoryStore'
import { buildLayeredRecall } from '../memory/layeredMemory'
import { createMemoryStoreAdapter } from '../memory/layeredMemoryAdapter'
import { buildPetMemoryContext } from '../pet/petMemoryBridge'
import type { ProactiveEvent, ProactiveDecision } from './types'
import { BackoffState } from './backoff'
import { decideGate, type GateInput } from './gate'
import { UnfinishedThreadStore, isQuestion } from './unfinishedThread'
import { shouldForceSpeak, shouldSleepMode } from './driveHardTrigger'
import { generateInnerThoughts } from './innerThoughts'
import { generateProactive } from './generator'
import { FollowupTopicsStore, synthesizeFollowups } from './followupTopics'  // 📮 阶段四

/** 编排器配置（从 proactiveEngine 透传默认值） */
export interface OrchestratorConfig {
  maxDaily: number
  minIntervalMs: number
  cooldownMs: number
  /** 内驱力硬触发开关 */
  driveHardTriggerEnabled: boolean
  /** 内心独白开关 */
  innerThoughtsEnabled: boolean
  /** followup 旧事开关（阶段四接入） */
  followupTopicsEnabled: boolean
  /** 退避开关 */
  backoffEnabled: boolean
}

/** 五层记忆召回（人格/事实/反思/近期/工作），与 intentDispatcher.petMemorySnippet 同一套门面；失败安全降级为空串 */
function buildMemorySnippet(query?: string): string {
  try {
    const store = getMemoryStore()
    const recall = buildLayeredRecall(createMemoryStoreAdapter(store), {
      query,
      budget: { persona: 4, facts: 6, reflection: 2, recent: 2, working: 3 },
      maxLineLen: 70,
    })
    if (recall.prompt) {return recall.prompt}
    return buildPetMemoryContext(store, { maxFacts: 6, maxSummaries: 2 }).snippet
  } catch { return '' }
}

const DEFAULT_CONFIG: OrchestratorConfig = {
  maxDaily: 20,
  minIntervalMs: 600_000,
  cooldownMs: 0,
  driveHardTriggerEnabled: true,
  innerThoughtsEnabled: true,
  followupTopicsEnabled: true,
  backoffEnabled: true,
}

export class ProactiveOrchestrator {
  private backoff = new BackoffState()
  private threads = new UnfinishedThreadStore()
  /** 最近 10 条台词（防重复） */
  private recentSpeeches: string[] = []
  private dailyCount = 0
  private lastProactiveAt = 0
  private userSpeaking = false
  private driveHardTimer: ReturnType<typeof setInterval> | null = null
  private followupTimer: ReturnType<typeof setInterval> | null = null
  private started = false
  private followups = new FollowupTopicsStore()  // 📮 阶段四
  private config: OrchestratorConfig = { ...DEFAULT_CONFIG }
  /** 阶段四注入：取「该提起的旧事」列表 */
  followupProvider: (() => string[]) | null = null

  /** 热更新配置 */
  configure(partial: Partial<OrchestratorConfig>): void {
    this.config = { ...this.config, ...partial }
  }

  /** 用户正在说话（VAD/全双工）→ 门控不打扰 */
  setUserSpeaking(v: boolean): void {
    this.userSpeaking = !!v
  }

  /** 用户一互动就调：重置退避 + 清未答话头 */
  noteUserInteraction(): void {
    this.backoff.resetOnInteraction()
    this.threads.clear()
  }

  /** 重逢分档：>5h 重逢语气，>1h 中性，<1h 轻微分别感（由调用方填 gapMinutes） */
  private gapTone(gapMinutes?: number): string {
    if (gapMinutes === undefined) {return ''}
    if (gapMinutes > 300) {return '很久没见了，重逢的语气'}
    if (gapMinutes > 60) {return '分别了一阵，普通重逢'}
    return '刚分开一会儿，轻微分别感'
  }

  /**
   * 统一入口：任何触发器构造 ProactiveEvent 后都走这里。
   */
  async onTrigger(event: ProactiveEvent): Promise<ProactiveDecision> {
    const now = Date.now()

    // ── 组装门控输入 ─────────────────────────────
    const life = loadLifeState()
    const drives = life.drives
    const idleMin = Math.max(0, (now - getPetLastInteraction()) / 60000)
    const scene = (event.scene as string) || getScreenGate().scene || 'idle'
    // 现场记忆召回（五层门面），屏幕场景/外部话题作为检索线索
    const memorySnippet = buildMemorySnippet(event.screenSummary || event.externalTopics?.[0])

    const gateInput: GateInput = {
      hasUnfinishedThread: !!this.threads.peek(),
      scene,
      drives: { social: drives.social, energy: drives.energy, comfort: drives.comfort },
      idleMinutes: idleMin,
      dailyCount: this.dailyCount,
      maxDaily: this.config.maxDaily,
      msSinceLastProactive: this.lastProactiveAt ? now - this.lastProactiveAt : Number.POSITIVE_INFINITY,
      minIntervalMs: this.config.backoffEnabled ? this.backoff.nextDelayMs(now) : this.config.minIntervalMs,
      cooldownMs: this.config.cooldownMs,
      petEnabled: isPetEnabled(),
      userSpeaking: this.userSpeaking,
    }
    const gateResult = decideGate(gateInput)
    if (!gateResult.allowed) {
      globalEventBus.emit(BusEvents.PROACTIVE_SILENT, { event: event.source, reason: gateResult.reason })
      return { shouldSpeak: false, reason: `gate:${gateResult.reason}` }
    }

    // ── 精力过低：只做睡觉动作，不说话 ──────────
    if (gateResult.fallbackToSleep || shouldSleepMode(drives)) {
      dispatchIntent({ action: 'sleep', mood: '疲惫 😩' })
      this.markSpoken('')
      globalEventBus.emit(BusEvents.PROACTIVE_DECISION, { event: event.source, action: 'sleep', mood: '疲惫 😩', silent: true })
      return { shouldSpeak: false, action: 'sleep', mood: '疲惫 😩', reason: 'sleep_mode' }
    }

    // ── 内心独白（可关）──────────────────────────
    let innerThought = ''
    if (this.config.innerThoughtsEnabled) {
      try {
        innerThought = await generateInnerThoughts({
          timeOfDay: this.gapTone(event.gapMinutes) || '现在',
          drives,
          mood: life.emotion.label,
          recentEvent: event.screenSummary || (event.externalTopics?.[0] ?? ''),
          memorySnippet,
        })
      } catch { innerThought = '' }
    }

    // ── followup 旧事：开关开就从存储取前 3 条 ──
    const followups = this.config.followupTopicsEnabled
      ? this.followupProvider ? this.followupProvider() : this.followups.getActive(3)
      : []

    // ── 现场生成 ────────────────────────────────
    const decision = await generateProactive(event, {
      drives,
      valence: life.emotion.v,
      arousal: life.emotion.a,
      currentMoodLabel: life.emotion.label,
      memorySnippet,
      recentSpeeches: this.recentSpeeches,
      followups,
      gapMinutes: event.gapMinutes,
      innerThought,
      unfinishedQuestion: this.threads.peek(),
    })

    if (!decision.shouldSpeak) {
      globalEventBus.emit(BusEvents.PROACTIVE_SILENT, { event: event.source, reason: decision.reason })
      return decision
    }

    // ── 包装成 PetIntent 下发 ────────────────────
    const intent: PetIntent = {
      action: decision.action || 'say',
      mood: decision.mood,
      speech: decision.speech,
      performance: decision.performance,
    }
    dispatchIntent(intent)
    this.markSpoken(intent.speech || '')
    getUsageStats().recordProactive(`proactive:${event.source}`, intent.speech || '')
    globalEventBus.emit(BusEvents.PROACTIVE_DECISION, {
      event: event.source, action: intent.action, mood: intent.mood, speech: intent.speech,
    })

    // 问句 → 挂起话头，等用户接
    if (intent.speech && isQuestion(intent.speech)) {
      this.threads.record(intent.speech, now)
    }
    // 这条台词自然接上了某条 followup → 标记已问，不再重复提起
    if (intent.speech && this.config.followupTopicsEnabled) {
      for (const t of followups) {
        if (intent.speech.includes(t)) { this.followups.markAsked(t); break }
      }
    }
    return decision
  }

  /** 记录一次发言：退避升级 + 计数 + 台词去重 */
  private markSpoken(speech: string): void {
    this.dailyCount++
    this.lastProactiveAt = Date.now()
    if (this.config.backoffEnabled) {this.backoff.recordAttempt()}
    if (speech) {
      this.recentSpeeches.push(speech)
      if (this.recentSpeeches.length > 10) {this.recentSpeeches.shift()}
    }
  }

  /** 每日 0 点重置计数（由引擎每日定时器调用） */
  resetDailyCount(): void {
    this.dailyCount = 0
  }

  /**
   * 启动新定时器：内驱力硬触发每 60s 检查一次。
   * 其余 cron/idle/hot_topic 等定时器仍由 proactiveEngine 持有，
   * 触发时构造 ProactiveEvent 调 onTrigger（见 proactiveEngine 改造）。
   */
  start(): void {
    if (this.started) {return}
    this.started = true
    if (this.config.driveHardTriggerEnabled) {
      this.driveHardTimer = setInterval(() => {
        try {
          const life = loadLifeState()
          const idleMin = Math.max(0, (Date.now() - getPetLastInteraction()) / 60000)
          if (shouldForceSpeak(life.drives, idleMin)) {
            void this.onTrigger({ source: 'drive_hard' })
          }
        } catch { /* 不阻塞 */ }
      }, 60_000)
      if (typeof (this.driveHardTimer as any)?.unref === 'function') {(this.driveHardTimer as any).unref()}
    }
    // 📮 阶段四：每日 04:00 合成「该提起的旧事」
    if (this.config.followupTopicsEnabled) {
      const runDaily = () => { void (async () => {
        try {
          const topics = await synthesizeFollowups()
          if (topics.length) {this.followups.replaceWith(topics)}
        } catch { /* 合成失败保留旧列表 */ }
      })() }
      const scheduleNext = () => {
        const now = new Date()
        const next = new Date(now)
        next.setHours(4, 0, 0, 0)
        if (next.getTime() <= now.getTime()) {next.setDate(next.getDate() + 1)}
        const ms = next.getTime() - now.getTime()
        this.followupTimer = setTimeout(() => { runDaily(); scheduleNext() }, ms)
      }
      scheduleNext()
    }
  }

  stop(): void {
    if (this.driveHardTimer) {clearInterval(this.driveHardTimer)}
    this.driveHardTimer = null
    if (this.followupTimer) {clearTimeout(this.followupTimer)}
    this.followupTimer = null
    this.started = false
  }
}

// ── 单例 ─────────────────────────────────────────────────
let _orchestrator: ProactiveOrchestrator | null = null
export function getProactiveOrchestrator(): ProactiveOrchestrator {
  if (!_orchestrator) {_orchestrator = new ProactiveOrchestrator()}
  return _orchestrator
}
