// ============================================================
// memory/trialBench.ts — 记忆审判台（Memory Trial Bench）
//
// 【为什么要有这个模块】
// 反幻觉在 Lumina 里目前是一句 README 口号加两套后台机制：
//   · memoryStore 的 SOURCE_CONFIDENCE：写入期的硬约束（source 决定权威性）
//   · memoryEvidence 的五维证据评分：读取期的排序与生命周期
// 但**用户摸不到**。界面不显示来源徽章，用户不知道自己被记了什么；
// 更糟的是，用户即使发现某条记忆是错的，也没有地方说「这条记错了」——
// 于是模型上周编的结论会一直躺在库里，每轮都被召回、每轮都被加固。
//
// 记忆审判台就是补上这个缺口：把每条记忆的来源 / 证据 / 置信度 / 引用次数
// 摊开给用户看，并且让用户的一次「记错了」**真的回流到记忆权重**，
// 而不是只删一条记录了事。
//
// 【本文件刻意不做的事】
//   1. 不删记忆。删掉就查不到「当初为什么记了这条」，用户哪天重新认可
//      旧说法时（source 足够强）还能升回来；删掉则永远不可逆。
//   2. 不改 source。source 是权威性的唯一来源，只有记忆存储层的写入决策
//      才能改它。用户在界面上点「确认」只加权重，**不越权抬高权威性**。
//   3. 不 import electron / 不开数据库。整个模块是纯逻辑，注入一个最小
//      读接口 + 一个可选的写回调即可，所以能被 vitest 直接锁住数学。
// ============================================================

import {
  DEFAULT_FACT_SOURCE,
  SOURCE_CONFIDENCE,
  UNVERIFIED_CONFIDENCE,
  clampConfidence,
  normalizeFactContent,
  normalizeFactSource,
  type FactEntry,
  type FactSource,
} from './memoryStore'

// 只取类型：证据引擎的构造会做文件 I/O（memoryEvidence 顶层 import 它的
// storagePath 逻辑），这里只需要 ScoredMemory / EvidenceScores 的形状。
// `import type` 编译期即被擦除，审判台因此不产生任何运行期依赖。
import type { EvidenceScores, ScoredMemory } from '../memoryEvidence'

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

/**
 * 用户对一条记忆的裁决。
 * 写成联合类型而不是 interface：这三个字面量本身就是全部取值空间，
 * 包装成对象只会给每个调用点平白加一层 .kind 噪音。
 */
export type TrialVerdict = 'confirmed' | 'disputed' | 'pending'

/** 生命周期直接复用证据引擎的状态机，不另起一套（两套状态并存必然漂移） */
export type TrialLifecycle = ScoredMemory['status']

/** 一次裁决的完整记录 —— 用户做了什么，以及记忆因此变成了什么样 */
export interface TrialRecord {
  memoryKey: string
  verdict: TrialVerdict
  /** ISO 时间戳，注入 now() 以便单测确定化 */
  at: string
  reason?: string
  /** 裁决前的置信度（已按 source cap 收敛） */
  confidenceBefore: number
  /** 裁决后真正生效的置信度 —— 永远 ≤ cap，这是本模块的铁律 */
  confidenceAfter: number
  /** 该来源允许的置信度上限 */
  cap: number
  source: FactSource
  /** 裁决带来的生命周期迁移：disputed→contradicted / confirmed→confirmed / pending→pending */
  lifecycle: TrialLifecycle
  /** 写回调失败时如实记录，不静默吞掉——否则界面会显示「已生效」而库里没变 */
  sinkError?: string
}

/** 提交裁决的结果：永远不抛异常，失败通过 ok=false + error 如实上报 */
export interface TrialOutcome {
  ok: boolean
  record: TrialRecord | null
  error?: string
}

/** 记忆的当前裁决态（审判台内部维护，是置信度计算的唯一输入） */
export interface TrialSubject {
  memoryKey: string
  content: string
  source: FactSource
  /** 已经过 cap 收敛、并且**包含了历史裁决效果**的当前置信度 */
  confidence: number
  cap: number
}

/**
 * 注入的最小读接口。
 * MemoryStore 天然满足（getFacts 的签名是结构兼容的），
 * 但单测只需要一个返回 FactEntry[] 的假实现，不必开 SQLite。
 */
export interface TrialStore {
  getFacts(category?: string, limit?: number): FactEntry[]
}

/** 无状态提交时由调用方补的最小信息（不必先 review 就能算） */
export interface TrialSubjectInput {
  content?: string
  source?: string | null
  confidence?: number | null
}

/** 置信度被改写后交给上层落库的载荷 */
export interface TrialWriteBack {
  memoryKey: string
  verdict: TrialVerdict
  confidence: number
  cap: number
  source: FactSource
  lifecycle: TrialLifecycle
  reason?: string
  at: string
}

export type TrialSink = (write: TrialWriteBack) => void

export interface TrialOptions {
  /** 时间源，注入后单测完全确定化 */
  now?: () => Date
  /**
   * 落库回调。生产环境接 MemoryStore，测试里接一个 spy。
   * 单独抽成回调而不是让本模块直接调 store：写库策略（是否连带改 source、
   * 是否连带 markContradicted）是记忆存储层的决策，不该被审判台锁死。
   */
  sink?: TrialSink
}

/** 一条「可审判的记录」—— 直接就是界面要渲染的东西，不让前端再拼一遍 */
export interface TrialViewModel {
  memoryKey: string
  content: string
  /** 归一化后的来源（未知/缺失一律降级成 model_inferred） */
  source: FactSource
  sourceLabel: string
  /** 当前生效置信度，已按 cap 收敛 */
  confidence: number
  cap: number
  lifecycle: TrialLifecycle
  /** 被引用次数：这条记忆被反复提及了多少次 */
  mentionCount: number
  /** 佐证来源数 */
  sourceCount: number
  evidence: EvidenceScores
  compositeScore: number
  /** 最后确认时间：优先取用户最近一次 confirmed 裁决，否则取事实写入时间 */
  lastConfirmedAt: string
  /** 用户最近一次裁决（没裁决过就是 null） */
  verdict: TrialVerdict | null
  /** 被判「记错了」的累计次数 */
  disputeCount: number
  /** 置信度低于 UNVERIFIED_CONFIDENCE：必须带「未验证」标注 */
  unverified: boolean
  /** 建议排在列表前面：被证伪 / 待核实 / 模型推断 / 未验证 */
  needsAttention: boolean
  /** 是否在 facts 表里找到了对应条目（false = 只有证据链，没有落库事实） */
  hasFactBinding: boolean
}

export interface TrialStats {
  /** 受审记忆总数 */
  total: number
  /** 至少被裁决过一次的记忆条数 */
  judged: number
  /** 当前处于「记错了」状态的记忆条数 */
  disputedMemories: number
  /** 被用户纠正的**次数**（同一条判两次算两次，这才是用户感受得到的纠正量） */
  corrections: number
  confirmations: number
  pendings: number
  /** 裁决总次数 */
  verdictTotal: number
  /** 争议率 = 纠正次数 / 裁决总次数（没有裁决时为 0） */
  disputeRate: number
  averageConfidence: number
  /** 未验证（低于 UNVERIFIED_CONFIDENCE）的记忆条数 */
  unverified: number
  bySource: Record<FactSource, number>
}

// ═══════════════════════════════════════════════════════════
// 置信度回流数学
// ═══════════════════════════════════════════════════════════

/** 首次判「记错了」的折减系数：0.95 → 0.38 */
export const DISPUTE_BASE_FACTOR = 0.4
/** 每多判一次，折减系数加码——两次 disputed 必须比一次更狠 */
export const DISPUTE_FACTOR_STEP = 0.15
/** 系数上限：再多的重复纠正也不能把惩罚指数化到「一次清零」 */
export const DISPUTE_MAX_FACTOR = 0.9
/**
 * 下限保护（2%）。
 * 为什么留一个非零地板而不是直接归零：归零后这条记忆与「从没存在过」无法区分，
 * 用户哪天重新认可旧说法时就没有可以升回去的起点，而且会丢掉「它曾经被信过」
 * 这段历史。留一点残值既能让它沉到召回底部，又保留了可逆性。
 */
export const DISPUTE_FLOOR = 0.02

/** 判「确认」的基准步长：向 cap 靠拢 +0.1 */
export const CONFIRM_STEP = 0.1
/** 重复确认的步长加速系数：用户连点三次，说明他很确定 */
export const CONFIRM_ACCEL = 0.25
/** 加速的次数上限（防止长尾里步长膨胀到一次点击就顶满） */
export const CONFIRM_ACCEL_MAX_STEPS = 3

/** 保留 4 位小数：界面展示干净，且避免 0.380000000000000004 这类浮点噪声进库 */
function round4(v: number): number {
  return Math.round(v * 1e4) / 1e4
}

const VERDICTS: readonly string[] = ['confirmed', 'disputed', 'pending']
const LIFECYCLES: readonly string[] = ['confirmed', 'pending', 'outdated', 'contradicted']

/** 裁决归一化：非法值返回 null，让调用方决定「拒绝」而不是「猜一个」 */
export function normalizeVerdict(raw: unknown): TrialVerdict | null {
  // `== null` 是刻意的：它同时匹配 null 与 undefined，而 `=== null` 漏掉 undefined。
  // 这里要的是「既不是字符串也不是有效值」的统一入口。
  // eslint-disable-next-line eqeqeq
  const s = (typeof raw === 'string' ? raw : raw == null ? '' : String(raw)).trim().toLowerCase()
  return VERDICTS.includes(s) ? (s as TrialVerdict) : null
}

function lifecycleFor(verdict: TrialVerdict): TrialLifecycle {
  if (verdict === 'disputed') {return 'contradicted'}
  if (verdict === 'confirmed') {return 'confirmed'}
  return 'pending'
}

/**
 * 把一次用户裁决映射成新的置信度。
 *
 * 唯一不变量（铁律，tests 里单独锁死）：
 *   **返回值永远 ≤ SOURCE_CONFIDENCE[source].cap**
 * 连当前值本身都会先被收敛到 [0, cap]——所以即使上游传来一个越界的
 * confidence（例如把模型推断的记忆写成 1.0），这个函数也不可能把它放大。
 *
 * @param current 当前置信度。越界/非有限值会被 clampConfidence 收敛
 *   （非有限值退化成 cap，与 memoryStore 的读时归一化保持一致）。
 * @param source  来源。未知/缺失按 DEFAULT_FACT_SOURCE（model_inferred）处理。
 * @param verdict 裁决。非法值只做归一化不改数值。
 * @param times   **此前**同一条记忆已经发生过几次同类裁决（0 = 首次）。
 *   放在纯函数里而不是藏在类里，是为了让「重复裁决会累积」这件事能被单独测。
 */
export function applyVerdictToConfidence(
  current: number,
  source: string | null | undefined,
  verdict: TrialVerdict | string | null | undefined,
  times = 0,
): number {
  const src = normalizeFactSource(source)
  const cap = SOURCE_CONFIDENCE[src].cap
  // 先收敛：这一步是「disputed 永远不超过 cap」这条铁律真正生效的地方
  const base = clampConfidence(current, cap)

  const v = normalizeVerdict(verdict)
  // 非法裁决 / 待核实：都不改数值。待核实的语义是「我还没想好」，
  // 按任何一种方向猜都会污染权重。
  if (v === null || v === 'pending') {return base}

  const n = (Number.isFinite(times) ? Math.floor(times) : 0) + 1
  let next: number
  if (v === 'disputed') {
    // 重复纠正要更狠：折减系数随次数加码，但有上限（0.9），不会一击清零
    const factor = Math.min(DISPUTE_MAX_FACTOR, DISPUTE_BASE_FACTOR + (n - 1) * DISPUTE_FACTOR_STEP)
    next = Math.max(DISPUTE_FLOOR, base * factor)
  } else {
    // 重复确认也要更响：步长随次数轻微放大，但永远被 cap 拦住
    const step = CONFIRM_STEP * (1 + CONFIRM_ACCEL * Math.min(n - 1, CONFIRM_ACCEL_MAX_STEPS))
    next = base + step
  }
  // 收尾再 clamp 一次：round4 可能把 0.9499999 抬成 0.95 = cap，
  // 而「等于 cap」是允许的，「超过 cap」不是。
  return Math.min(round4(Math.max(0, Math.min(next, cap))), cap)
}

// ═══════════════════════════════════════════════════════════
// 输入归一化（对脏数据一律不抛异常）
// ═══════════════════════════════════════════════════════════

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function str(v: unknown): string {
  if (typeof v === 'string') {return v}
  // 同上：null 与 undefined 都归一为空串
  // eslint-disable-next-line eqeqeq
  if (v == null) {return ''}
  if (typeof v === 'number' || typeof v === 'boolean') {return String(v)}
  return ''
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function errText(e: unknown): string {
  if (e instanceof Error) {return e.message}
  const s = str(e)
  return s || '未知错误'
}

const EVIDENCE_KINDS: readonly string[] = ['fact', 'reflection', 'persona', 'lesson', 'preference']

interface NormalizedScored {
  memoryKey: string
  content: string
  kind: ScoredMemory['type']
  status: TrialLifecycle
  scores: EvidenceScores
  compositeScore: number
  mentionCount: number
  sourceCount: number
  updatedAt: number
}

/**
 * 把任意来源的 ScoredMemory 收敛成安全形状。
 * 为什么这么啰嗦：review() 的输入来自 IPC（未来）或证据引擎（现在），
 * 任何一侧的字段缺失都不该让整个审判台白屏——单条脏数据只降级这一条。
 */
function normalizeScored(raw: unknown): NormalizedScored {
  const r: Record<string, unknown> = isRecord(raw) ? raw : {}
  const content = str(r.content).trim()
  const kindRaw = str(r.type).trim()
  const statusRaw = str(r.status).trim()
  const rawScores = isRecord(r.scores) ? r.scores : {}
  return {
    // 没有 id 就用归一化内容兜底：只要内容在，记忆就还能被审判
    memoryKey: str(r.id).trim() || `content:${normalizeFactContent(content).slice(0, 48)}`,
    content,
    kind: (EVIDENCE_KINDS.includes(kindRaw) ? kindRaw : 'fact') as ScoredMemory['type'],
    status: (LIFECYCLES.includes(statusRaw) ? statusRaw : 'pending') as TrialLifecycle,
    scores: {
      confidence: clamp01(num(rawScores.confidence)),
      recency: clamp01(num(rawScores.recency)),
      frequency: clamp01(num(rawScores.frequency)),
      corroboration: clamp01(num(rawScores.corroboration)),
      importance: clamp01(num(rawScores.importance)),
    },
    compositeScore: clamp01(num(r.compositeScore)),
    mentionCount: Math.max(0, Math.floor(num(r.mentionCount))),
    sourceCount: Math.max(0, Math.floor(num(r.sourceCount))),
    updatedAt: num(r.updatedAt, 0),
  }
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(v, 1))
}

// ═══════════════════════════════════════════════════════════
// 审判台
// ═══════════════════════════════════════════════════════════

export class MemoryTrialBench {
  private readonly store: TrialStore | null
  private readonly now: () => Date
  private readonly sink: TrialSink | null
  /** memoryKey → 当前裁决态（置信度已包含历史裁决效果） */
  private readonly subjects = new Map<string, TrialSubject>()
  /** memoryKey → 该记忆的全部裁决记录（内存态，持久化由上层决定） */
  private readonly records = new Map<string, TrialRecord[]>()
  private lastReviewCount = 0

  constructor(store?: TrialStore | null, options?: TrialOptions) {
    this.store = store ?? null
    this.now = options?.now ?? (() => new Date())
    this.sink = options?.sink ?? null
  }

  /**
   * 组装可审判的展示视图模型。
   *
   * 把 ScoredMemory（证据链）+ FactEntry（来源与落库置信度）+ 裁决历史
   * 三处信息合成一条记录，前端就只负责渲染，不再自己拼来源和生命周期。
   *
   * 排序按「风险」而不是按时间：被证伪 / 待核实 / 模型推断 / 未验证的排最前。
   * 为什么不让用户自己筛——审判台的意义就是「最可能出错的那条要被先看到」。
   */
  review(scored: ScoredMemory[]): TrialViewModel[] {
    const list = Array.isArray(scored) ? scored : []
    const { exact, normalized } = this.indexFacts()

    const views: TrialViewModel[] = []
    for (const raw of list) {
      const s = normalizeScored(raw)
      const fact = bindFact(s.content, exact, normalized)
      const subject = this.buildSubject(s, fact)
      this.subjects.set(subject.memoryKey, subject)
      views.push(this.buildView(subject, s, fact))
    }

    this.lastReviewCount = views.length
    views.sort((a, b) => {
      const d = riskScore(b) - riskScore(a)
      if (d !== 0) {return d}
      if (a.confidence !== b.confidence) {return a.confidence - b.confidence}
      return a.lastConfirmedAt < b.lastConfirmedAt ? -1 : a.lastConfirmedAt > b.lastConfirmedAt ? 1 : 0
    })
    return views
  }

  /**
   * 记录一次裁决，并把结果回流到记忆权重。
   *
   * 为什么不返回 void 或直接抛错：IPC 层要能区分「裁决成功并已应用」
   * 和「未知 memoryKey / 非法 verdict」这两种失败，界面才能诚实显示。
   * 所以这里统一返回 TrialOutcome，**任何输入都不抛异常**。
   */
  submit(
    memoryKey: string,
    verdict: TrialVerdict | string,
    reason?: string,
    subject?: TrialSubjectInput,
  ): TrialOutcome {
    const key = str(memoryKey).trim()
    if (!key) {return { ok: false, record: null, error: 'memoryKey 为空，无法定位记忆' }}

    const v = normalizeVerdict(verdict)
    if (v === null) {
      // 绝不把非法裁决猜成 pending：那等于替用户做了一个他没做的决定
      return {
        ok: false,
        record: null,
        error: `非法裁决「${str(verdict).trim() || '(空)'}」：只接受 confirmed / disputed / pending`,
      }
    }

    const base = subject ? this.subjectFromInput(key, subject) : this.subjects.get(key)
    if (!base) {
      return { ok: false, record: null, error: `未知 memoryKey「${key}」：请先加载审判台列表` }
    }

    const list = this.records.get(key) ?? []
    const times = list.filter(r => r.verdict === v).length
    const before = clampConfidence(base.confidence, base.cap)
    const after = applyVerdictToConfidence(before, base.source, v, times)
    const at = this.now().toISOString()
    const why = str(reason).trim()

    const record: TrialRecord = {
      memoryKey: key,
      verdict: v,
      at,
      ...(why ? { reason: why } : {}),
      confidenceBefore: before,
      confidenceAfter: after,
      cap: base.cap,
      source: base.source,
      lifecycle: lifecycleFor(v),
    }

    list.push(record)
    this.records.set(key, list)
    this.subjects.set(key, { ...base, confidence: after })

    if (this.sink) {
      try {
        this.sink({
          memoryKey: key,
          verdict: v,
          confidence: after,
          cap: base.cap,
          source: base.source,
          lifecycle: record.lifecycle,
          ...(why ? { reason: why } : {}),
          at,
        })
      } catch (e) {
        // 裁决本身已经生效（内存里），但没落库——必须让界面知道，
        // 否则就是「显示已纠正、实际没纠正」，正是本项目最痛的那类假成功
        record.sinkError = errText(e)
      }
    }

    return { ok: true, record }
  }

  /** 裁决历史（按时间倒序）。不传 key 返回全部。 */
  history(memoryKey?: string): TrialRecord[] {
    const key = str(memoryKey).trim()
    const all = key
      ? (this.records.get(key) ?? []).slice()
      : Array.from(this.records.values()).flat()
    return all.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  }

  /** 汇总：争议率、被纠正次数等（顶部统计条直接吃这个对象） */
  stats(): TrialStats {
    const all = this.history()
    const corrections = all.filter(r => r.verdict === 'disputed').length
    const confirmations = all.filter(r => r.verdict === 'confirmed').length
    const pendings = all.filter(r => r.verdict === 'pending').length
    const disputedKeys = new Set(all.filter(r => r.verdict === 'disputed').map(r => r.memoryKey))
    const judgedKeys = new Set(all.map(r => r.memoryKey))

    const bySource: Record<FactSource, number> = {
      user_stated: 0,
      user_confirmed: 0,
      model_inferred: 0,
    }
    let sum = 0
    let unverified = 0
    for (const s of this.subjects.values()) {
      bySource[s.source] += 1
      sum += s.confidence
      if (s.confidence < UNVERIFIED_CONFIDENCE) {unverified += 1}
    }

    return {
      total: Math.max(this.lastReviewCount, this.subjects.size),
      judged: judgedKeys.size,
      disputedMemories: disputedKeys.size,
      corrections,
      confirmations,
      pendings,
      verdictTotal: all.length,
      // 争议率按「裁决次数」算而不是「记忆条数」：同一条判两次就是两次纠正，
      // 用户纠正得越勤，这个数字越该涨 —— 按条数算会把它稀释掉。
      disputeRate: all.length > 0 ? round4(corrections / all.length) : 0,
      averageConfidence: this.subjects.size > 0 ? round4(sum / this.subjects.size) : 0,
      unverified,
      bySource,
    }
  }

  // ── 内部 ─────────────────────────────────────────────

  private indexFacts(): { exact: Map<string, FactEntry>; normalized: Map<string, FactEntry> } {
    const exact = new Map<string, FactEntry>()
    const normalized = new Map<string, FactEntry>()
    for (const f of this.readFacts()) {
      const raw = str(f?.content).trim()
      if (!raw) {continue}
      // 精确优先、归一化兜底：归一化会去掉标点和大小写，
      // 直接拿它当主键会把两条本不同的事实合并成一条（那正是我们要防的幻觉）
      if (!exact.has(raw)) {exact.set(raw, f)}
      const n = normalizeFactContent(raw)
      if (n && !normalized.has(n)) {normalized.set(n, f)}
    }
    return { exact, normalized }
  }

  private readFacts(): FactEntry[] {
    if (!this.store) {return []}
    try {
      const list = this.store.getFacts(undefined, 200)
      return Array.isArray(list) ? list : []
    } catch (e) {
      // 读不到事实不该让审判台不可用：没有落库事实时，
      // 仍然可以用证据链把记忆摊开给用户看（hasFactBinding=false）
      // 降级是真实存在的路径，必须留痕；
      // 静默吞掉会让「记忆展示不全」变成无法排查的灵异问题。
      // eslint-disable-next-line no-console
      console.warn('[TrialBench] 读取事实失败，本次仅按证据链展示：', errText(e))
      return []
    }
  }

  private subjectFromInput(key: string, input: TrialSubjectInput): TrialSubject {
    const source = normalizeFactSource(input?.source)
    const cap = SOURCE_CONFIDENCE[source].cap
    const prior = this.subjects.get(key)
    // 无状态提交时若这条已经审过，优先沿用已含裁决效果的置信度，
    // 否则「重新加载列表」会把用户的纠正成果冲掉
    const raw = prior ? prior.confidence : (input?.confidence ?? SOURCE_CONFIDENCE[source].default)
    return {
      memoryKey: key,
      content: str(input?.content).trim(),
      source,
      confidence: clampConfidence(raw, cap),
      cap,
    }
  }

  private buildSubject(s: NormalizedScored, fact: FactEntry | null): TrialSubject {
    const source = normalizeFactSource(fact?.source)
    const cap = SOURCE_CONFIDENCE[source].cap
    const prior = this.subjects.get(s.memoryKey)
    // 关键：置信度优先级是「历史裁决结果 > 落库事实 > 来源缺省值」。
    // 排在第一位是因为：否则用户在界面上点一次「记错了」，
    // 下次打开面板数据一刷新就又变回原来的权重 —— 反馈看起来完全没生效。
    const raw = prior ? prior.confidence : (fact ? fact.confidence : SOURCE_CONFIDENCE[source].default)
    return { memoryKey: s.memoryKey, content: s.content, source, confidence: clampConfidence(raw, cap), cap }
  }

  private buildView(subject: TrialSubject, s: NormalizedScored, fact: FactEntry | null): TrialViewModel {
    const history = this.records.get(subject.memoryKey) ?? []
    let verdict: TrialVerdict | null = null
    let lastConfirmedAt = ''
    let disputeCount = 0
    for (const r of history) {
      if (r.verdict === 'disputed') {disputeCount += 1}
      if (r.verdict === 'confirmed') {lastConfirmedAt = r.at}
    }
    if (history.length > 0) {verdict = history[history.length - 1].verdict}

    if (!lastConfirmedAt) {
      const ts = str(fact?.timestamp).trim()
      if (ts) {lastConfirmedAt = ts}
      else if (s.updatedAt > 0) {lastConfirmedAt = new Date(s.updatedAt).toISOString()}
      else {lastConfirmedAt = ''}
    }

    const unverified = subject.confidence < UNVERIFIED_CONFIDENCE
    return {
      memoryKey: subject.memoryKey,
      content: subject.content,
      source: subject.source,
      sourceLabel: SOURCE_CONFIDENCE[subject.source].label,
      confidence: subject.confidence,
      cap: subject.cap,
      lifecycle: s.status,
      mentionCount: s.mentionCount,
      sourceCount: s.sourceCount,
      evidence: s.scores,
      compositeScore: s.compositeScore,
      lastConfirmedAt,
      verdict,
      disputeCount,
      unverified,
      needsAttention: verdict === 'disputed' || verdict === 'pending' || subject.source === DEFAULT_FACT_SOURCE || unverified,
      hasFactBinding: !!fact,
    }
  }
}

function bindFact(
  content: string,
  exact: Map<string, FactEntry>,
  normalized: Map<string, FactEntry>,
): FactEntry | null {
  const raw = content.trim()
  if (!raw) {return null}
  return exact.get(raw) ?? normalized.get(normalizeFactContent(raw)) ?? null
}

/** 风险分：分数高的排前面（被证伪 > 待核实 > 模型推断 > 未验证） */
function riskScore(v: TrialViewModel): number {
  let r = 0
  if (v.verdict === 'disputed') {r += 100}
  if (v.lifecycle === 'contradicted') {r += 80}
  if (v.verdict === 'pending' || v.lifecycle === 'pending') {r += 40}
  if (v.source === 'model_inferred') {r += 30}
  if (v.unverified) {r += 20}
  return r
}
