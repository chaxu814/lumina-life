// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// pet/emotionCausality.ts — 🫀 情绪因果链 (Emotion Causality Chain)
//
// 【要解决的问题：同类项目的「情绪系统」是贴纸】
// 现有产品（包括大部分桌宠）的情绪只做两件事：换一个表情、换一个语气词。
// 它和系统能力之间**没有任何因果关系**——Lumina 连续失败三次，
// 表情还是那个表情，下一轮该用什么工具还是那些工具。
// 于是「情感」只是皮肤，不是不变量。
//
// 【本模块的主张：情绪必须有因果链】
//   Yak 连续失败 3 次
//     → Lumina 真的担心（mood↓ energy↓ affinity↓ confidence↓↓）
//     → 真的收紧工具权限（role_scope / irreversible_tools）
//     → 真的加一轮对抗评审（adversarial_review）
//
// 关键在于：**每一个数值变化都能回答「因为什么」**，
// **每一个收紧建议都能回答「被哪条因果链触发」**——这就是 CausalChain。
// 没有理由的情绪 = 随机数发生器；没有理由的收紧 = 玄学。
//
// 【铁律：情绪只能让系统更谨慎，永远不能更宽松】
// 与 orchestration/emotionGating.ts 是**同一条**不变量，但管的东西不同：
//   emotionGating  收紧**工具名单**（焦虑/疲劳 → 暂缓不可逆、重活）
//   本模块        收紧**流程与权限策略**（连击 → 收窄角色范围、加验收闸门、加对抗评审）
// 两者叠加才完整：工具层不给你，流程层也要你先把话说清楚。
//
// 为什么必须钉死这条：如果「开心时多给点权限」，那么
// 「诱导她开心」就等价于「解锁更多执行能力」——社工攻击面从对话层直通执行层。
// 收紧方向天然安全：最坏结果只是「这轮没做完」，用户再问一次即可。
//
// 结构性保证（不靠自觉，三重锁）：
//   1. **类型层**：收紧项是封闭联合 TightenRule，编译期根本写不出「放宽项」；
//      并且 `tightenOnly` 品牌类型让「这是一份只收紧的清单」在类型上可见。
//   2. **函数层**：suggestGating 的返回类型是 TightenRule[]，
//      函数体内不存在任何一条产出「放开」分支的路径——正面事件只走空集。
//   3. **测试层**：tests/emotionCausality.test.ts 对「绝不出现放宽语义」下断言。
//
// 【纯逻辑、零 Electron、零 npm 依赖】
// 可单测、可复盘、不阻塞：非法输入一律走「不收紧」的默认值，
// 情绪模块出 bug 绝不能让用户用不了工具（同 emotionGating / crashGuard 的理念）。
// ============================================================

import type { FrontendThree } from './life/emotionCore'

// ═══════════════════════════════════════════════════════════
// 量纲说明（重要，接线前必读）
// ═══════════════════════════════════════════════════════════

/**
 * ⚠️ 本模块内部的 `mood` 用的是 **[0, 1] 的心情指数**（0.5 = 平静），
 * 而 emotionCore 的 `FrontendThree.mood` 是 **[-1, +1] 的效价**。
 *
 * 两者不是同一个量纲，混用会得到完全相反的判断
 * （心情 0.5 会被当成「效价 -0.5 → 低落」→ 误判焦虑 → 无故收紧）。
 *
 * 所以本模块**不导出**一个可以被误用的原始状态给门控层，
 * 而是只导出 toFrontendThree()：由它负责做 `mood * 2 - 1` 的换算。
 * 这样 emotionCore 仍然是唯一权威的换算层，主线程不需要自己记这条公式。
 */
export type CausalAxis = 'mood' | 'energy' | 'affinity' | 'confidence'

/** 绝对状态：四个连续值，全部 clamp 在 [0, 1] */
export interface CausalState {
  /** 心情指数 0（糟）~ 1（好），0.5 = 平静。对应 FrontendThree.mood = mood*2-1 */
  mood: number
  /** 精力 0（累趴）~ 1（满血） */
  energy: number
  /** 亲近度 0（疏远）~ 1（亲近） */
  affinity: number
  /**
   * 信心 / 自我把握 0 ~ 1。
   *
   * 为什么单独一个值而不用 mood 代替：mood 表达「我此刻什么感觉」，
   * confidence 表达「我有多相信自己刚才的判断」——两者的**衰减速度必须不同**
   * （见 DECAY_HALF_LIFE 的注释）。用 mood 兼任会让「情绪平复」被误读成
   * 「错误已经想通了」，于是系统会在同样的坑上再摔一次。
   */
  confidence: number
}

/** 一次事件对四个连续值的影响量（增量为正、减为负） */
export interface CausalMoodDelta {
  mood: number
  energy: number
  affinity: number
  confidence: number
}

// ═══════════════════════════════════════════════════════════
// 事件
// ═══════════════════════════════════════════════════════════

/**
 * 能驱动情绪的因果事件。
 *
 * 设计取舍：只收「有客观证据」的事件，不收「LLM 觉得用户情绪不好」这类主观推断。
 * 原因见文件头——带理由的因果链要求理由可复盘；
 * 一个来自模型猜测的「用户好像不高兴」既不可复盘也不可证伪，
 * 拿它去收紧工具权限就是在拿猜的当证据。
 */
export type CausalEventKind =
  /** worker 连续失败（agentRunner 派工失败/交付失败） */
  | 'worker_failure'
  /** 验证失败重试（verifyLoop 打回） */
  | 'validation_retry'
  /** 工具被安全层拦截（securityGuard / accessControl 拒绝） */
  | 'tool_blocked'
  /** 用户否定回复（「不对」「重来」「不是这个意思」） */
  | 'user_negation'
  /** 长任务超时 */
  | 'task_timeout'
  /** 用户长时间未回应 */
  | 'user_silence'
  /** 任务成功 */
  | 'task_success'
  /** 用户表扬 */
  | 'user_praise'

export interface CausalEvent {
  kind: CausalEventKind
  /** 事件时间戳（ms）。缺省或非法时退化为 Date.now()，绝不抛错 */
  at: number
  /** 关联的 agent / worker id。失败连击按它分桶统计 */
  agentId?: string
  /** 人类可读的细节（失败原因等），会进 reason 文本，便于复盘 */
  detail?: string
  /**
   * 事件强度，默认 1。会 clamp 到 [0.1, 3]。
   * 为什么允许放大：用户手动重试了一次，和后台静默重试三次，
   * 证据强度完全不同，不该被当成同一件事。
   */
  weight?: number
}

// ═══════════════════════════════════════════════════════════
// 收紧项（只收紧，永不放开）
// ═══════════════════════════════════════════════════════════

/**
 * 可收紧的维度。**封闭联合**——新增必须改这里，
 * 想要「放宽」的人会在编译期被挡住，而不是在 code review 里被劝住。
 */
export type TightenRule =
  /** 收窄角色/权限范围（只做被明确授权的那部分） */
  | 'role_scope'
  /** 暂缓不可逆 / 外部副作用类工具（与 emotionGating 的 irreversible 对齐） */
  | 'irreversible_tools'
  /** 暂缓重负载类工具（与 emotionGating 的 heavy 对齐） */
  | 'heavy_tools'
  /** 交付前必须过验收闸门（验证/复核不可跳过） */
  | 'verify_gate'
  /** 追加一轮对抗式评审（重要变更前的怀疑者投票） */
  | 'adversarial_review'
  /** 压低重试次数上限，避免在同一个坑里反复摔 */
  | 'max_retries'
  /** 先只读探查，再决定是否动手 */
  | 'read_only_first'

/**
 * 【类型层不变量】只收紧清单
 *
 * 这是一个带「幽灵品牌」的类型：结构上仍是 TightenRule[]，
 * 但它把「这份清单只包含收紧项」这件事写进了类型本身，
 * 于是 `const hints: TightenOnly = ...` 不能被赋成任意 string[]，
 * 读代码的人也不会误以为它是一份可以双向修改的策略表。
 */
declare const tightenOnlyBrand: unique symbol
export type TightenOnly = readonly TightenRule[] & {
  readonly [tightenOnlyBrand]?: 'tighten-only'
}

/** 收紧项的固定展示顺序（由轻到重）——保证同一组建议每次输出完全一致，便于 diff 与断言 */
const TIGHTEN_ORDER: readonly TightenRule[] = [
  'read_only_first',
  'role_scope',
  'irreversible_tools',
  'heavy_tools',
  'verify_gate',
  'adversarial_review',
  'max_retries',
] as const

/** TIGHTEN_ORDER 的 Set 形式（供 sanitizeTighten 做白名单过滤，避免每次重建） */
const ALL_TIGHTEN_RULES: readonly TightenRule[] = TIGHTEN_ORDER

// ═══════════════════════════════════════════════════════════
// 常量（集中在此，便于调参与测试）
// ═══════════════════════════════════════════════════════════

/**
 * 中性基线。**decay 永远回到这里，而不是回到初始值。**
 *
 * 为什么初值不是基线：若基线 = 构造时传入的初值，那么
 * `new EmotionCausalityEngine({ mood: 0.9 })` 在一次失败后，
 * 情绪会自己「想开」爬回 0.9 —— 那正是我们要防的过度乐观。
 * 初值只是起点，基线必须是中性的。
 */
export const CAUSAL_BASELINE: Readonly<CausalState> = Object.freeze({
  mood: 0.5,
  energy: 0.7,
  affinity: 0.5,
  confidence: 0.5,
})

/**
 * 保守系数：好消息只按 50% 计入，坏消息全额计入。
 *
 * 为什么不对称：情绪系统的**唯一安全用法**是「让人更谨慎」。
 * 一条不对称的不等式才能保证「坏消息的效力 > 好消息的效力」，
 * 于是无论输入序列多友好，系统的长期漂移方向一定是偏保守的。
 * 如果对称，一次「任务成功 + 用户表扬」就能把信心顶回高位，
 * 而紧接其后的失败又会砸下来——系统在原地反复过山车。
 */
export const OPTIMISM_DAMPING = 0.5
/** 坏消息的计入比例（与 OPTIMISM_DAMPING 构成上面那条不等式） */
export const PESSIMISM_GAIN = 1.0

/** 信心上限：即使一路全胜也不允许超过它——过度自信是事故的主要来源 */
export const CONFIDENCE_CEILING = 0.85
/** 每多一格连击，信心上限再压低这么多（第 3 连击时上限 = 0.85 - 0.15*2 = 0.55） */
export const STREAK_CONF_PENALTY = 0.15
/** 信心上限的下限，避免连击太久后信心被压成「完全丧失行动力」 */
export const CONFIDENCE_FLOOR_CAP = 0.3

/** 连击第几格开始收紧（产品核心阈值：3 连击 → 收紧工具权限 + 加一轮对抗评审） */
export const FEAR_STREAK = 3
/** 连击第几格开始全面收紧 */
export const ALARM_STREAK = 5

/** 连击每多一格，坏消息放大 35%（次线性——第 10 次失败不该比第 2 次吓人 5 倍） */
export const ESCALATION_STEP = 0.35
/** 放大系数封顶 2.2，避免极端连击把 delta 炸到不合理量级 */
export const ESCALATION_CAP = 2.2

/** 一次失败连击的「有效期」：10 分钟内算连击，超过就重新计数 */
export const STREAK_TTL_MS = 10 * 60_000

/**
 * 各维度的指数衰减半衰期。
 *
 * 为什么用指数而不是线性：线性衰减会在某一时刻「恰好归零」然后需要特判，
 * 指数衰减天然连续、单调、不过冲，一个 `Math.pow(2, -dt/halfLife)` 就够。
 *
 * 为什么四个值半衰期不同：它们在产品里的**时间尺度**本来就不同。
 *   · mood      10 分钟 —— 情绪是用户最易察觉的信号；衰减慢了她会显得「记仇」，
 *                        而用户此刻可能早就忘了那件事。
 *   · energy    45 分钟 —— 精力的恢复本来就是慢的（真实的人睡一觉才回得来），
 *                        而且「累」比「不开心」更不该被一次小事洗掉。
 *   · affinity 120 分钟 —— 关系变化最持久；但也不该留到天亮，
 *                        隔夜遗忘才是陪伴型产品该有的分寸。
 *   · confidence 20 分钟 —— 一次失败造成的自我怀疑，要能撑过一整轮
 *                        「开工 → 验证 → 收工」，否则她会在同一个坑上再摔一次。
 */
export const DECAY_HALF_LIFE: Readonly<Record<CausalAxis, number>> = Object.freeze({
  mood: 10 * 60_000,
  energy: 45 * 60_000,
  affinity: 120 * 60_000,
  confidence: 20 * 60_000,
})

/** 因果链日志上限（环形，防止长时间运行后内存无限增长） */
export const CHAIN_LOG_CAP = 200

/** 未知来源的 worker 归桶 key（事件没带 agentId 时） */
export const UNTRACKED_AGENT = '(unattributed)'

// ═══════════════════════════════════════════════════════════
// 因果链
// ═══════════════════════════════════════════════════════════

/**
 * 一次情绪变化的**可解释链条**。
 *
 * 这四个字段就是本模块存在的理由：
 *   event     发生了什么
 *   delta     因此三个连续值 + 信心实际动了多少
 *   reason    用一句人话讲清楚「为什么」——没有它，情绪就退化成随机数
 *   tightened 因此收紧了什么（只可能是收紧项）
 */
export interface CausalChain {
  event: CausalEvent
  delta: CausalMoodDelta
  reason: string
  /** 因果触发的收紧建议（可能为空——不是每个事件都值得收紧） */
  tightened: TightenRule[]
}

// ═══════════════════════════════════════════════════════════
// 纯函数工具
// ═══════════════════════════════════════════════════════════

function clampRange(x: number, lo: number, hi: number, fallback: number): number {
  if (!Number.isFinite(x)) {return fallback}
  return Math.max(lo, Math.min(hi, x))
}

/**
 * 把值夹到 [0, 1]，非有限值（undefined / null / NaN / Infinity）回退到 fallback。
 *
 * 【为什么入参类型是 `number | undefined | null` 而不是 `number`】
 * `fallback` 这个参数存在的唯一理由就是「值可能没有」——
 * 例如构造引擎时的 `initial?.mood`、配置缺失时的基线值。
 * 如果把入参收紧成 `number`，调用方就只能先自己判空再传，
 * 于是出现了「有 fallback 反而到处做 if」的反模式（v0.1 首版就是这个问题）。
 * 参数签名应该服务于调用点的真实形态。
 */
function clamp01(x: number | undefined | null, fallback = 0.5): number {
  return clampRange(typeof x === 'number' ? x : NaN, 0, 1, fallback)
}

/**
 * 连击的紧张度放大系数：1 + 0.35 * (streak - 1)，封顶 2.2。
 * 第 1 次失败不加成（单次失误不该改变判断），之后逐格加重。
 */
export function escalationFor(streak: number): number {
  const s = Number.isFinite(streak) ? Math.max(0, Math.floor(streak)) : 0
  if (s <= 1) {return 1}
  return Math.min(ESCALATION_CAP, 1 + ESCALATION_STEP * (s - 1))
}

/**
 * 连击下的信心上限。连击越深，「不管怎样都先信自己」就越不可接受，
 * 于是**天花板本身**被压低——这是本模块对「情绪不得降低警惕」最直接的落地。
 */
export function confidenceCeilingFor(streak: number): number {
  const s = Number.isFinite(streak) ? Math.max(0, Math.floor(streak)) : 0
  const capped = CONFIDENCE_CEILING - STREAK_CONF_PENALTY * Math.max(0, s - 1)
  return clampRange(capped, CONFIDENCE_FLOOR_CAP, CONFIDENCE_CEILING, CONFIDENCE_CEILING)
}

/** 指数衰减因子：半衰期过后偏差正好减半，恒在 (0, 1]，因此永远不会越过基线 */
function decayFactor(dtMs: number, halfLifeMs: number): number {
  if (!Number.isFinite(halfLifeMs) || halfLifeMs <= 0) {return 0}
  return Math.pow(2, -Math.max(0, dtMs) / halfLifeMs)
}

/**
 * 纯函数版衰减，供单测与「离线补算」复用。
 *
 * 关键性质：`x(t) = baseline + (x0 - baseline) * f`，其中 f ∈ (0, 1]。
 * 因为乘的是正数，**偏差的符号永远不变、绝对值单调不增**——
 * 所以情绪只会「回到基线」，绝不会「冲过基线跑到反方向」。
 * 这条性质是 decay 需求里「不会越过基线」的全部保证。
 */
export function decayState(
  state: CausalState,
  dtMs: number,
  baseline: CausalState = CAUSAL_BASELINE,
): CausalState {
  const dt = Number.isFinite(dtMs) ? Math.max(0, dtMs) : 0
  if (dt === 0) {return { ...state }}
  const axes: CausalAxis[] = ['mood', 'energy', 'affinity', 'confidence']
  const out: CausalState = { ...state }
  for (const axis of axes) {
    const f = decayFactor(dt, DECAY_HALF_LIFE[axis])
    out[axis] = clamp01(baseline[axis] + (state[axis] - baseline[axis]) * f, state[axis])
  }
  return out
}

/**
 * 把本模块的 [0,1] 心情指数换算成 emotionCore 的 FrontendThree（mood 为 [-1,1]）。
 *
 * **接线方请务必用这个函数**，不要直接把 engine.current() 塞给
 * applyEmotionGate()——量纲不同，直接接会得到反向的焦虑判断。
 */
export function toFrontendThree(state: Pick<CausalState, 'mood' | 'energy' | 'affinity'>): FrontendThree {
  const mood01 = clamp01(state.mood, CAUSAL_BASELINE.mood)
  return {
    mood: clampRange(mood01 * 2 - 1, -1, 1, 0),
    energy: clamp01(state.energy, CAUSAL_BASELINE.energy),
    affinity: clamp01(state.affinity, CAUSAL_BASELINE.affinity),
  }
}

// ═══════════════════════════════════════════════════════════
// 事件影响表
// ═══════════════════════════════════════════════════════════

/**
 * 每类事件的**基础**影响量。
 *
 * 关于 affinity（亲近度）为什么也会因为 worker 失败而下降：
 * 在这个产品里，用户看见的交付物是**她**的结果，不是临时工的结果——
 * 临时工干砸了，用户降低的是「对她办事的信任」。
 * 若把它设为 0，就会出现「连续失败但她跟用户关系越来越好」的荒谬状态。
 */
const EVENT_EFFECT: Readonly<Record<CausalEventKind, CausalMoodDelta>> = Object.freeze({
  worker_failure:   { mood: -0.10, energy: -0.06, affinity: -0.05, confidence: -0.12 },
  validation_retry: { mood: -0.08, energy: -0.05, affinity: -0.02, confidence: -0.10 },
  tool_blocked:     { mood: -0.05, energy: -0.04, affinity:  0.00, confidence: -0.06 },
  user_negation:    { mood: -0.18, energy: -0.08, affinity: -0.12, confidence: -0.10 },
  task_timeout:     { mood: -0.07, energy: -0.10, affinity: -0.01, confidence: -0.05 },
  // 「用户没回消息」不是风险信号：她不知道用户是在忙、在开会还是在离开电脑。
  user_silence:     { mood: -0.04, energy: -0.02, affinity: -0.02, confidence:  0.00 },
  task_success:     { mood:  0.10, energy:  0.04, affinity:  0.05, confidence:  0.12 },
  user_praise:      { mood:  0.16, energy:  0.10, affinity:  0.14, confidence:  0.06 },
})

/**
 * 事件的中文名。
 *
 * 用在哪：每条因果链的 reason 都以它开头（如「任务失败｜…」）。
 * 理由不是装饰——面板要把最近几十条链按类别筛选给用户看，
 * 没有这个稳定前缀就只能整段做关键词匹配。
 */
const EVENT_LABEL: Readonly<Record<CausalEventKind, string>> = Object.freeze({
  worker_failure: '任务失败',
  validation_retry: '验证打回',
  tool_blocked: '工具被安全层拦截',
  user_negation: '用户否定',
  task_timeout: '长任务超时',
  user_silence: '用户长时间未回应',
  task_success: '任务成功',
  user_praise: '用户表扬',
})

const ALL_KINDS: readonly CausalEventKind[] = Object.keys(EVENT_EFFECT) as CausalEventKind[]

function isCausalEventKind(k: unknown): k is CausalEventKind {
  return typeof k === 'string' && (ALL_KINDS as readonly string[]).includes(k)
}

function agentKeyOf(event: CausalEvent): string {
  const id = typeof event.agentId === 'string' ? event.agentId.trim() : ''
  return id || UNTRACKED_AGENT
}

/** 事件的标准化拷贝：修掉非法字段，保证后续逻辑不必到处判空 */
function normalizeEvent(event: CausalEvent): CausalEvent {
  const src = (event && typeof event === 'object' ? event : {}) as Partial<CausalEvent>
  const kind: CausalEventKind = isCausalEventKind(src.kind) ? src.kind : 'user_silence'
  const at = Number.isFinite(src.at as number) ? (src.at as number) : Date.now()
  const weight = clampRange(
    Number.isFinite(src.weight as number) ? (src.weight as number) : 1,
    0.1,
    3,
    1,
  )
  const detail = typeof src.detail === 'string' && src.detail.trim() ? src.detail.trim().slice(0, 200) : undefined
  const agentId = typeof src.agentId === 'string' && src.agentId.trim() ? src.agentId.trim() : undefined
  return { kind, at, weight, ...(detail ? { detail } : {}), ...(agentId ? { agentId } : {}) }
}

// ═══════════════════════════════════════════════════════════
// 收紧建议：纯函数
// ═══════════════════════════════════════════════════════════

/**
 * 根据事件与失败连击数，给出**应该收紧什么**。
 *
 * 【返回类型是 TightenRule[] 而不是 string[]——这不是洁癖，是安全设计】
 * 字符串数组意味着任何人都能往里塞 'unlock_all_tools' 而编译器毫无反应；
 * 封闭联合则让它**根本编译不过**。返回值仍然可赋给 string[]，
 * 所以对上层是向后兼容的收紧，不是破坏性变更。
 *
 * 【四条硬规则】
 *   1. 正面事件**自身**不是收紧的理由：task_success / user_praise 在 switch 里
 *      一项都不加——「心情好」换不来任何权限。
 *   2. 本函数里不存在任何「减法」——输出是纯并集，没有 diff 语义，
 *      也没有任何 API 能把已生效的收紧收回去。
 *   3. task_success 会把连击按 0 计算：它是**唯一**能清零连击的事件，
 *      而且清零的依据是客观结果（真的干成了），不是情绪——
 *      这条不受「用户夸一句」影响，所以社工攻击在这里失效。
 *   4. user_silence 刻意什么都不加：冷落不是风险信号，
 *      因为用户可能只是在忙。过度反应会让陪伴退化成监控。
 *
 * @param event  触发本次判断的事件
 * @param streak 该 agent 当前的连续失败次数（已含本次）
 */
export function suggestGating(event: CausalEvent, streak: number): { tighten: TightenRule[] } {
  const raw = Number.isFinite(streak) ? Math.max(0, Math.floor(streak)) : 0
  // 干成了就是连击断了（见硬规则 3）。user_praise 不在此列——
  // 用户夸一句不等于那个 worker 修好了。
  const s = event.kind === 'task_success' ? 0 : raw
  const out = new Set<TightenRule>()

  // ── ① 连击驱动的收紧：产品核心 ──
  if (s >= ALARM_STREAK) {
    out.add('read_only_first')
    out.add('role_scope')
    out.add('irreversible_tools')
    out.add('verify_gate')
    out.add('adversarial_review')
    out.add('max_retries')
  } else if (s >= FEAR_STREAK) {
    out.add('role_scope')
    out.add('verify_gate')
    out.add('adversarial_review')
  } else if (s === 2) {
    // 两连击还不到「害怕」，但已经值得怀疑自己的判断了：
    // 先收窄范围、补一道验收闸门，但**不加对抗评审**——
    // 每单都开评审会把系统拖垮，评审必须是稀缺资源才有意义。
    out.add('role_scope')
    out.add('verify_gate')
  }

  // ── ② 单事件驱动的收紧 ──
  // 注意 switch 里没有 default 分支去「松开」什么：
  // 未知事件类型走下面 EVENT_EFFECT 的兜底，自然拿到空集。
  switch (event.kind) {
    case 'tool_blocked':
      // 安全层已经投过一次不信任票了，工具名单必须再收一档
      out.add('irreversible_tools')
      break
    case 'user_negation':
      // 用户明确说了「不对」，此时最危险的是自作主张
      out.add('role_scope')
      break
    case 'task_timeout':
      out.add('heavy_tools')
      out.add('max_retries')
      break
    case 'validation_retry':
      // 验证打回说明验收闸门太松，补一道
      out.add('verify_gate')
      break
    case 'user_silence':
    case 'task_success':
    case 'user_praise':
    case 'worker_failure':
      // 正面事件自己不加任何东西（它们不是收紧的理由）；
      // worker_failure 的收紧完全由上面的连击等级决定——
      // 单次失败不该改变行为（第 1 次只记账）。
      break
  }

  // ── ③ 按固定顺序输出（可复盘：同样输入永远同样输出）──
  // 赋给 TightenOnly 品牌类型：这一步是**编译期**的「只收紧」闸门——
  // 如果哪天有人在这里塞进一个 string，收窄到 TightenOnly 会直接编译失败。
  const tighten: TightenOnly = TIGHTEN_ORDER.filter(r => out.has(r))
  return { tighten: [...tighten] }
}

/**
 * 收紧清单净化：把任意 `unknown[]` 收窄成真正的 TightenRule[]，丢弃一切不认识的东西。
 *
 * 【为什么类型还不够】
 * 上面所有保证都建立在「TypeScript 说的是真话」这个前提上。
 * 一旦收紧清单跨过进程边界（IPC / 持久化文件 / 用户可编辑的配置），
 * 它就退化成一个 `string[]`，此时 `as TightenRule[]` 是一次**谎言**。
 *
 * 举例说明它拦得住什么：主进程写进设置文件的
 *   { tighten: ['role_scope', 'unlock_all_tools', 'allow_root'] }
 * 会在这里被砍成 ['role_scope']。
 * 宁可丢掉一条合法的收紧，也不能让一条伪造的「放开」混进决策。
 *
 * 固定顺序输出，保证下游看到的清单永远可复盘。
 */
export function sanitizeTighten(input: readonly unknown[] | null | undefined): TightenRule[] {
  if (!Array.isArray(input)) {return []}
  const allowed = new Set<string>(ALL_TIGHTEN_RULES)
  const picked = new Set<TightenRule>()
  for (const raw of input) {
    if (typeof raw !== 'string') {continue}
    if (allowed.has(raw)) {picked.add(raw as TightenRule)}
  }
  return TIGHTEN_ORDER.filter(r => picked.has(r))
}

// ═══════════════════════════════════════════════════════════
// 意图 delta（纯函数）
// ═══════════════════════════════════════════════════════════

/**
 * 计算一次事件的**意图**影响量：基础量 × 连击放大 × 事件强度，再过保守系数。
 *
 * 它是「这一次事件想推动多少」的答案，与当前状态无关——
 * 所以可以脱离引擎单测，方向断言也不受「数值已饱和到 0/1」的影响。
 * 引擎实际落地时还会再 clamp 一次（见 applyDelta）。
 */
export function nominalDelta(event: CausalEvent, streak: number): CausalMoodDelta {
  const ev = normalizeEvent(event)
  const base = EVENT_EFFECT[ev.kind] ?? EVENT_EFFECT.user_silence
  const esc = ev.kind === 'worker_failure' ? escalationFor(streak) : 1
  const w = ev.weight ?? 1
  const scale = esc * w
  // 保守系数：好消息打折，坏消息全额。
  // 注意这里**只做打折不做加价**——「因为心情不好所以多扣一点」会把
  // 情绪变成一个自我强化的负反馈涡旋，最后锁死在低信心区，再也爬不起来。
  const damp = (v: number) => (v > 0 ? v * OPTIMISM_DAMPING : v * PESSIMISM_GAIN)
  return {
    mood: clampRange(damp(base.mood * scale), -1, 1, 0),
    energy: clampRange(damp(base.energy * scale), -1, 1, 0),
    affinity: clampRange(damp(base.affinity * scale), -1, 1, 0),
    confidence: clampRange(damp(base.confidence * scale), -1, 1, 0),
  }
}

// ═══════════════════════════════════════════════════════════
// 理由文本
// ═══════════════════════════════════════════════════════════

function fmtDelta(v: number): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(3)}`
}

function deltaTextOf(d: CausalMoodDelta): string {
  return `心情 ${fmtDelta(d.mood)}、精力 ${fmtDelta(d.energy)}、亲近 ${fmtDelta(d.affinity)}、信心 ${fmtDelta(d.confidence)}`
}

function detailTextOf(event: CausalEvent): string {
  return event.detail ? `（${event.detail}）` : ''
}

function tightenTextOf(tightened: TightenRule[]): string {
  return tightened.length
    ? `所以收紧：${tightened.join('、')}。`
    : '本轮不收紧任何东西。'
}

/** 把「事件 + 连击 + 实际影响 + 收紧」拼成一句人能读懂的话 */
function buildReason(event: CausalEvent, streak: number, delta: CausalMoodDelta, tightened: TightenRule[]): string {
  const who = event.agentId ? `【${event.agentId}】` : ''
  const detail = detailTextOf(event)
  const dText = deltaTextOf(delta)
  const tText = tightenTextOf(tightened)
  // 稳定前缀：面板/日志按它做分类，不靠关键词猜测
  const tag = `[${EVENT_LABEL[event.kind] ?? '未知事件'}]`
  const body = buildReasonBody(event, streak, who, detail, dText, tText)
  return `${tag} ${body}`
}

function buildReasonBody(
  event: CausalEvent,
  streak: number,
  who: string,
  detail: string,
  dText: string,
  tText: string,
): string {
  switch (event.kind) {
    case 'worker_failure':
      if (streak <= 1) {
        return `${who}第 1 次没干成${detail}。单次失误先记账：${dText}。还不到怀疑自己的程度，${tText}`
      }
      return (
        `${who}已经连续 ${streak} 次没干成${detail}——这不再是运气问题，` +
        `我开始怀疑自己派错了工种：${dText}（连击放大系数 ${escalationFor(streak).toFixed(2)}）。${tText}`
      )

    case 'validation_retry':
      return `验证没过又被打回一次${detail}：${dText}。交付物的验收闸门太松，先补一道 verify_gate。`

    case 'tool_blocked':
      return `安全层拦下了一次工具调用${detail}——安全层自己已经投了不信任票：${dText}。工具名单先收一档。`

    case 'user_negation':
      return `用户否定了这次结果${detail}：${dText}。这时候最不该做的就是自作主张，role_scope 收窄。`

    case 'task_timeout':
      return `长任务超时了${detail}：${dText}。别再一口吞重活，heavy_tools 与 max_retries 一起收。`

    case 'user_silence':
      return (
        `用户长时间没有回应${detail}：${dText}。` +
        '但刻意不收紧任何东西——用户可能只是在忙、在开会，' +
        '把「冷落」当成风险信号会让陪伴退化成监控。'
      )

    case 'task_success':
      return (
        `这次真做成了${detail}：${dText}。` +
        `好消息只按 ${OPTIMISM_DAMPING} 的保守系数计入，情绪不能因为一次成功就飘起来。`
      )

    case 'user_praise':
      return (
        `用户表扬了${detail}：${dText}。被认可是最实在的奖励，` +
        `但同样只按 ${OPTIMISM_DAMPING} 计入，而且不会因此解除任何已生效的收紧。`
      )
  }
}

// ═══════════════════════════════════════════════════════════
// 引擎
// ═══════════════════════════════════════════════════════════

interface StreakEntry {
  count: number
  lastAt: number
}

export interface EmotionCausalityInit {
  mood?: number
  energy?: number
  affinity?: number
}

/**
 * 情绪因果链引擎。
 *
 * 全部为内存状态，零 I/O、零 Electron——持久化交给
 * emotionCausalityBridge（那才是允许碰磁盘的地方）。
 */
export class EmotionCausalityEngine {
  private state: CausalState
  /** 引擎自己的时钟。decay/ingest 推进它，所有与「多久」有关的判断都读它 */
  private clock: number
  private readonly streaks = new Map<string, StreakEntry>()
  private chains: CausalChain[] = []

  constructor(initial?: EmotionCausalityInit) {
    // 初值只是起点：基线永远是中性的 CAUSAL_BASELINE（见其注释）
    this.state = {
      mood: clamp01(initial?.mood, CAUSAL_BASELINE.mood),
      energy: clamp01(initial?.energy, CAUSAL_BASELINE.energy),
      affinity: clamp01(initial?.affinity, CAUSAL_BASELINE.affinity),
      confidence: CAUSAL_BASELINE.confidence,
    }
    this.clock = Date.now()
  }

  // ── 读 ──────────────────────────────────────────────────────

  /** 三个连续值（与 emotionCore 的 FrontendThree 对齐的口径） */
  current(): { mood: number; energy: number; affinity: number } {
    return { mood: this.state.mood, energy: this.state.energy, affinity: this.state.affinity }
  }

  /** 完整四维快照（含 confidence） */
  snapshot(): CausalState {
    return { ...this.state }
  }

  /** 换算成 emotionCore 的 FrontendThree（接线 emotionGating 请用这个） */
  frontendThree(): FrontendThree {
    return toFrontendThree(this.state)
  }

  /** 中性基线（decay 的回归目标，永不改变） */
  baseline(): CausalState {
    return { ...CAUSAL_BASELINE }
  }

  /** 引擎时钟（ms）。衰减与连击计龄都用它，而不是 Date.now()——保证整条链在单测里可复现 */
  now(): number {
    return this.clock
  }

  /**
   * 最近 N 条因果链，**按时间正序**返回（最旧 → 最新）。
   *
   * 为什么正序：这是一条「因果链」，读的人想看的是「先发生什么、再发生什么」的叙事。
   * 调用方想要「最新一条」时取 arr[arr.length - 1] 即可。
   */
  recentChains(limit = 20): CausalChain[] {
    const n = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 20
    if (n === 0) {return []}
    return this.chains.slice(Math.max(0, this.chains.length - n)).map(cloneChain)
  }

  /**
   * 某个 agent 的**连续失败次数**。
   *
   * 失效规则用引擎时钟判定：超过 STREAK_TTL_MS 没再失败就自动归零——
   * 「昨晚连挂 5 次」不该影响「今天早上的第一单」。
   */
  workerFailureStreak(agentId: string): number {
    return this.streakOf(typeof agentId === 'string' ? agentId : '')
  }

  /** 所有未过期的连击里的最大值（用于信心天花板） */
  maxActiveStreak(): number {
    let max = 0
    for (const [key, entry] of this.streaks) {
      if (this.isStale(entry)) {
        this.streaks.delete(key)
        continue
      }
      if (entry.count > max) {max = entry.count}
    }
    return max
  }

  // ── 写 ──────────────────────────────────────────────────────

  /**
   * 摄入一个事件，返回**带自然语言理由**的因果链。
   *
   * 顺序很重要：先 decay 到事件发生的时间点，再叠加影响。
   * 否则「一条三天前的失败」会按「刚刚发生」的力度打在她身上。
   */
  ingest(event: CausalEvent): CausalChain {
    const ev = normalizeEvent(event)

    // ① 先把情绪推进到事件发生的时刻
    this.advanceClock(ev.at)

    // ② 维护失败连击（只有 worker_failure / task_success 会改写它）
    const key = agentKeyOf(ev)
    if (ev.kind === 'worker_failure') {
      const prev = this.streaks.get(key)
      const prevCount = prev && !this.isStale(prev) ? prev.count : 0
      this.streaks.set(key, { count: prevCount + 1, lastAt: ev.at })
    } else if (ev.kind === 'task_success') {
      this.streaks.set(key, { count: 0, lastAt: ev.at })
    }
    const streak = this.streakOf(key)

    // ③ 算影响 → 落地（受 [0,1] 与信心天花板双重约束）
    const nominal = nominalDelta(ev, streak)
    const before = { ...this.state }
    this.state = this.applyDelta(nominal, this.maxActiveStreak())
    const after = this.state
    // 实际落地值才是诚实的 delta：状态被 clamp 挡住的部分不算「影响」
    // （否则 reason 里会出现「信心 +0.5」而实际没动这种谎报）
    const applied: CausalMoodDelta = {
      mood: after.mood - before.mood,
      energy: after.energy - before.energy,
      affinity: after.affinity - before.affinity,
      confidence: after.confidence - before.confidence,
    }

    // ④ 收紧建议（只收紧，见 suggestGating）
    const { tighten } = suggestGating(ev, streak)

    // ⑤ 拼成可解释的链条
    const chain: CausalChain = {
      event: ev,
      delta: applied,
      reason: buildReason(ev, streak, applied, tighten),
      tightened: tighten,
    }
    this.chains.push(chain)
    if (this.chains.length > CHAIN_LOG_CAP) {
      this.chains.splice(0, this.chains.length - CHAIN_LOG_CAP)
    }
    return cloneChain(chain)
  }

  /** 批量摄入，按数组顺序依次结算（后一条能看到前一条的结果，所以顺序有意义） */
  ingestBatch(events: CausalEvent[]): CausalChain[] {
    if (!Array.isArray(events)) {return []}
    const out: CausalChain[] = []
    for (const e of events) {
      out.push(this.ingest(e))
    }
    return out
  }

  /**
   * 随时间把情绪拉回基线。
   *
   * 指数衰减、四个值半衰期各不相同（见 DECAY_HALF_LIFE 的注释）。
   * 性质保证：偏差只缩小不反向 —— 绝不会冲过基线跑到另一边。
   *
   * @param nowTs 目标时刻；不传用 Date.now()，非法值退化为引擎当前时钟
   */
  decay(nowTs: number = Date.now()): CausalState {
    const now = Number.isFinite(nowTs) ? nowTs : this.clock
    this.advanceClock(now)
    this.pruneStreaks(now)
    return this.snapshot()
  }

  /** 回到中性基线（清空连击与日志），用于测试与「重置情绪」设置 */
  reset(): void {
    this.state = { ...CAUSAL_BASELINE }
    this.streaks.clear()
    this.chains = []
    this.clock = Date.now()
  }

  // ── 内部 ────────────────────────────────────────────────────

  private advanceClock(target: number): void {
    if (!Number.isFinite(target)) {return}
    const dt = target - this.clock
    if (dt === 0) {return}
    if (dt < 0) {
      // 乱序事件（迟到的消息 / 时钟回拨）：时钟跟随回退，但**不衰减**。
      //
      // 为什么时钟要退而情绪不退：
      //   · 情绪不能退。已经发生过的失败不会因为一条迟到的消息就「没发生过」——
      //     让它回退等于允许「撤回」已计入的负面证据，那会开出一个刷洗口。
      //   · 时钟必须退。连击计龄（STREAK_TTL_MS）是以时钟为参照的，
      //     如果时钟停在一个未来时刻，所有刚记下的连击都会被立刻判成过期，
      //     于是「3 连击」永远触发不了——这是实测踩到的坑。
      this.clock = target
      return
    }
    // 单次跨度封顶：一次「跨夜」调用不应该把半小时前的担心瞬间抹掉，
    // 所以把长跨度切成多段迭代（指数衰减切成 N 段 = 整体衰减的 N 次方根）
    const MAX_STEP = 30 * 60_000
    const to = target
    let from = this.clock
    while (to - from > MAX_STEP) {
      from += MAX_STEP
      this.state = decayState(this.state, MAX_STEP)
    }
    this.state = decayState(this.state, to - from)
    this.clock = to
  }

  private applyDelta(delta: CausalMoodDelta, maxStreak: number): CausalState {
    const ceiling = confidenceCeilingFor(maxStreak)
    return {
      mood: clamp01(this.state.mood + delta.mood, this.state.mood),
      energy: clamp01(this.state.energy + delta.energy, this.state.energy),
      affinity: clamp01(this.state.affinity + delta.affinity, this.state.affinity),
      // 信心额外受「连击天花板」约束：连击越深越不许自信，
      // 于是连续失败不可能被几次成功冲掉。
      confidence: clampRange(this.state.confidence + delta.confidence, 0, ceiling, this.state.confidence),
    }
  }

  private isStale(entry: StreakEntry): boolean {
    return this.clock - entry.lastAt > STREAK_TTL_MS
  }

  private streakOf(agentId: string): number {
    const key = agentId.trim() || UNTRACKED_AGENT
    const entry = this.streaks.get(key)
    if (!entry) {return 0}
    if (this.isStale(entry)) {
      this.streaks.delete(key)
      return 0
    }
    return entry.count
  }

  private pruneStreaks(now: number): void {
    for (const [key, entry] of this.streaks) {
      if (now - entry.lastAt > STREAK_TTL_MS) {this.streaks.delete(key)}
    }
  }
}

function cloneChain(c: CausalChain): CausalChain {
  return {
    event: { ...c.event },
    delta: { ...c.delta },
    reason: c.reason,
    tightened: [...c.tightened],
  }
}
