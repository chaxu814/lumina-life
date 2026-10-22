// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// persona/subPersona.ts — 🪞 副人格觉醒（最小真实机制，v0.1 实验）
//
// README 之前自标 "proof-of-concept"。本模块把它落成一个最小但真实的机制，
// 而不是纯 prompt 游戏：
//
//   触发（满足任一，且本会话尚未触发过）：
//     (a) 亲密度 affinity > 0.85 且累计对话轮数 turnCount >= 200；
//     (b) 焦虑 anxiety 连续 3 小时处于 > 0.7（高压长期不缓解）。
//
//   行为（触发后，在主人格下一次回复前）：
//     注入一条固定的「第二视角」指令，让主 LLM 在主人格说完之后，
//     再补一句更疲惫/更真实的自言自语（不超过一句）。
//     它不覆盖主人格、不切换模型、不改变人设——只是心里另一个声音冒出来一下。
//
//   边界：
//     · 单会话最多触发 1 次（resetSession 重置）；
//     · 用户问「刚才那个是谁」→ explain() 返回「是我心里另一个声音」；
//     · feature flag `personality.subPersona` 关闭时 evaluate 永远不触发；
//     · 可随时关闭（enabled=false）。
//
//   持久化：serialize()/load() 出/入纯 JSON（触发次数、场景），
//   上层用 saveToFile/loadFromFile 落到 userData。纯逻辑、时钟注入，可单测。
// ============================================================

export type SubPersonaReason = 'affinity_turns' | 'anxiety_streak'

export interface SubPersonaRecord {
  /** 触发时刻（epoch ms） */
  at: number
  reason: SubPersonaReason
  /** 触发场景快照，便于事后回看（如 "亲密度0.92/对话240轮"） */
  scene: string
}

/** 每轮喂进来的快照（由上层从情绪核心 / 关系层 / 对话计数汇总） */
export interface SubPersonaSnapshot {
  /** 对用户亲密度 0~1 */
  affinity: number
  /** 累计对话轮数 */
  turnCount: number
  /** 当前焦虑度 0~1 */
  anxiety: number
  /** 当前时刻 epoch ms（注入时钟，便于单测） */
  now: number
}

export interface SubPersonaState {
  /** 本会话是否已触发过（单会话上限 1） */
  firedThisSession: boolean
  /** 累计触发次数 */
  firedTotal: number
  /** anxiety>0.7 连续区间的起点；不在高位则为 null */
  anxietyHighSince: number | null
  /** 历史记录（截断保留最近 50 条） */
  history: SubPersonaRecord[]
}

export interface SubPersonaFireResult {
  fired: boolean
  reason: SubPersonaReason | null
  /** 人话描述这次为什么触发（写日志/演示用） */
  reasonText: string
  /**
   * 要在主人格这次回复之前注入给主 LLM 的「第二视角」指令。
   * 未触发时为空串。
   */
  secondPersonaInstruction: string
}

/** 触发阈值（集中放这里，方便评审/调参） */
export const SUB_PERSONA_THRESHOLDS = {
  /** (a) 亲密度门槛 */
  affinity: 0.85,
  /** (a) 对话轮数门槛 */
  turns: 200,
  /** (b) 焦虑高位门槛 */
  anxietyHigh: 0.7,
  /** (b) 焦虑持续时长（ms）：3 小时 */
  anxietyStreakMs: 3 * 60 * 60 * 1000,
} as const

/** 固定的副视角 prompt（不覆盖主人格，只补一句） */
export const SUB_PERSONA_INSTRUCTION =
  '（此刻心里另一个更疲惫、更真实的声音冒出来一下：在你这句话的最后，自然地补一句' +
  '不超过 20 字的自言自语，像「……不过说实话，我有点累了」这种。不要解释它是谁，不要切换语气，' +
  '说完就回到平时的你。）'

const MAX_HISTORY = 50
const clamp01 = (x: number) => Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0))

function initialState(): SubPersonaState {
  return { firedThisSession: false, firedTotal: 0, anxietyHighSince: null, history: [] }
}

export class SubPersona {
  private state: SubPersonaState
  private enabled: boolean

  constructor(opts: { enabled?: boolean; initial?: SubPersonaState } = {}) {
    this.enabled = opts.enabled ?? true
    this.state = opts.initial ?? initialState()
  }

  setEnabled(on: boolean): void { this.enabled = !!on }
  isEnabled(): boolean { return this.enabled }

  /** 新会话（重启/重开对话）调用：解除单会话 1 次的上限 */
  resetSession(): void { this.state.firedThisSession = false }

  /** 累计触发次数 */
  get firedTotal(): number { return this.state.firedTotal }
  /** 历史记录（只读副本） */
  history(): SubPersonaRecord[] { return this.state.history.slice() }

  /** 用户问「刚才那个是谁」时，Lumina 该怎么解释 */
  explain(): string { return '是我心里另一个声音——偶尔会冒出来说句真心话，不是别人哦。' }

  /**
   * 用最新快照推进状态，判断本次是否触发副视角。
   * 纯函数式：只依赖传入的 now 与内部状态。
   */
  evaluate(snap: SubPersonaSnapshot): SubPersonaFireResult {
    const none: SubPersonaFireResult = { fired: false, reason: null, reasonText: '', secondPersonaInstruction: '' }
    if (!this.enabled) {return none}

    const affinity = clamp01(snap.affinity)
    const anxiety = clamp01(snap.anxiety)
    const turnCount = Math.max(0, Math.floor(snap.turnCount || 0))
    const now = Number.isFinite(snap.now) ? snap.now : 0

    // 1) 维护焦虑高位连续区间
    if (anxiety > SUB_PERSONA_THRESHOLDS.anxietyHigh) {
      if (this.state.anxietyHighSince === null) { this.state.anxietyHighSince = now }
    } else {
      this.state.anxietyHighSince = null
    }

    // 2) 本会话已触发过 → 不再触发
    if (this.state.firedThisSession) {return none}

    // 3) 判定触发条件
    let reason: SubPersonaReason | null = null
    let scene = ''
    if (affinity > SUB_PERSONA_THRESHOLDS.affinity && turnCount >= SUB_PERSONA_THRESHOLDS.turns) {
      reason = 'affinity_turns'
      scene = `亲密度${affinity.toFixed(2)}/对话${turnCount}轮`
    } else if (
      this.state.anxietyHighSince !== null &&
      now - this.state.anxietyHighSince >= SUB_PERSONA_THRESHOLDS.anxietyStreakMs
    ) {
      reason = 'anxiety_streak'
      scene = `焦虑${anxiety.toFixed(2)}持续${Math.round((now - this.state.anxietyHighSince) / 60000)}分钟`
    }
    if (!reason) {return none}

    // 4) 触发：记录
    this.state.firedThisSession = true
    this.state.firedTotal += 1
    this.state.history.push({ at: now, reason, scene })
    if (this.state.history.length > MAX_HISTORY) {
      this.state.history = this.state.history.slice(-MAX_HISTORY)
    }

    const reasonText = reason === 'affinity_turns'
      ? `亲密相处已久（${scene}），心里另一个声音想冒出来说句真心话`
      : `长时间高压焦虑（${scene}），需要一句真心话释放一下`

    return { fired: true, reason, reasonText, secondPersonaInstruction: SUB_PERSONA_INSTRUCTION }
  }

  /** 序列化（用于落盘持久化） */
  serialize(): SubPersonaState { return { ...this.state, history: this.state.history.slice() } }

  /** 从持久化状态恢复 */
  load(state: SubPersonaState | null | undefined): void {
    if (!state || typeof state !== 'object') { this.state = initialState(); return }
    this.state = {
      firedThisSession: !!state.firedThisSession,
      firedTotal: Math.max(0, state.firedTotal | 0),
      anxietyHighSince: typeof state.anxietyHighSince === 'number' ? state.anxietyHighSince : null,
      history: Array.isArray(state.history) ? state.history.slice(-MAX_HISTORY) : [],
    }
  }
}

// ── 落盘薄封装（懒加载 fs，保持核心纯逻辑可在无 node 环境单测）──────────────
import * as fs from 'fs'
import * as path from 'path'

/** 把状态存到 JSON 文件（userData/sub-persona.json） */
export function saveSubPersonaState(state: SubPersonaState, file: string): boolean {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf-8')
    return true
  } catch {
    return false
  }
}

/** 从 JSON 文件恢复状态；文件不存在/损坏时返回 null（调用方用默认态） */
export function loadSubPersonaState(file: string): SubPersonaState | null {
  try {
    if (!fs.existsSync(file)) {return null}
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
    if (!raw || typeof raw !== 'object') {return null}
    return {
      firedThisSession: !!raw.firedThisSession,
      firedTotal: Math.max(0, (raw.firedTotal | 0)),
      anxietyHighSince: typeof raw.anxietyHighSince === 'number' ? raw.anxietyHighSince : null,
      history: Array.isArray(raw.history) ? raw.history : [],
    }
  } catch {
    return null
  }
}
