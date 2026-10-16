// ============================================================
// memory/affinityDecay.ts — 关系驱动的记忆衰减（创新功能 3）
//
// 【要解决的问题】
// 现在记忆的召回排序只看两样东西：confidence（这条信息可不可信）
// 和 id（这条信息新不新）。时间只是一个隐含的次级因子。
//
// 这带来一个很不对劲的体验：
//   用户刚开始用 Lumina 时随口说的��句寒暄，
//   半年后仍然和「他说他妈妈住院了」以同样的权重参与召回。
// 记忆库变成了一锅粥——重要的和不重要的被时间冲刷成同一种东西。
//
// 而在陪伴产品里，**关系本身就是权重**：
//   刚认识时说的「嗯」「哦」「随便」 → 不重要
//   相处一年后说的「我妈住院了」   → 很重要
// 同样一句话，发生在关系的不同阶段，意义完全不同。
//
// 【核心设计：衰减因子，而不是删除】
// 本模块**绝不删任何记忆**。
//
// 为什么：陪伴产品里「她忘了你说过的话」是致命的体验灾难，
// 而「她不太提起某件事」是可以接受的，甚至更自然。
// 所以做法是：写入时记下当时的亲密度，读取时按
// 「记忆产生时的关系」对当前亲密度做加权，让
//   · 早期关系里产生的重要记忆 → 随关系加深而**逐渐变重**
//   · 早期关系里产生的寒暄     → 随时间自然**逐渐变轻**
// 数据一条不丢，只是排序会变。
//
// 【衰减公式】
//   decay = 0.35 + 0.65 × affinity_at_write
//   final = confidence × decay × recency
//
//   ① affinity_at_write：这条记忆产生时的亲密度（0~1）
//      · 亲密度 0 的关系里说的话 → 系数 0.35（被显著压低）
//      · 亲密度 1 的关系里说的话 → 系数 1.0（完整保留）
//   ② recency：时间新鲜度，半衰期 90 天
//      recency = 0.5 ^ (ageDays / 90)
//      90 天前的记忆权重减半，180 天前四分之一——
//      但只是权重，不是删除。
//
//   为什么亲密度系数下界是 0.35 而不是 0：
//   完全归零意味着「早期关系说的话永远不能被想起」，
//   那和删除没有区别，而且对新用户尤其不公平
//   （他们还没机会建立高亲密度，却先失去了所有记忆）。
//   0.35 保留了「能想起，但排在后面」的空间。
//
// 【为什么不改数据库表结构】
// ① 迁移风险：老用户库里没有 affinity_at_write 列，迁移失败会丢数据
// ② 零侵入：可以随时关闭而不影响任何既有读写
// ③ 可测：纯函数，衰减逻辑能脱离 SQLite 单测
// affinity_at_write 存在 metadata JSON 里（facts 表已有 content_key/hit_count
// 的演进痕迹，说明该表正在被温和扩展），不新增列。
//
// 【零依赖、可单测】
// 不引入 npm 包；db 句柄由构造函数注入，type-only import better-sqlite3
// （与 relationshipEvents.ts 完全相同的写法，保证测试能在纯 Node 下跑）。
// ============================================================

import type { Database } from 'better-sqlite3'
import { readFeatureFlag } from '../core/appConfig'

// ═══════════════════════════════════════════════════════════
// 特性开关（本模块此前最大的问题：实现了、测了，开关却没人读）
// ═══════════════════════════════════════════════════════════

/** 与 memoryIpc.ts 的 CONFIG_DEFAULTS.features / 设置面板共用同一个键名 */
export const AFFINITY_FLAG_KEY = 'affinityDecay'

/**
 * 读用户开关。**默认 true**，与 CONFIG_DEFAULTS 保持一致
 * （键缺失 = 开；只有用户显式关过才是 false）。
 *
 * 静态 import appConfig 而不是 require：打包后相对路径会被压平，
 * 运行时 require 才是项目里踩过的坑（见 appConfig.ts 头注释）。
 * appConfig → pathsFallback 内部对 electron 是**延迟 require + try/catch**，
 * 所以纯 Node（vitest）下加载本模块不会炸。
 *
 * 【为什么包 try/catch：默认 true，不是 false】
 * 配置读不出来属于「可降级」状态。若这里失败就返回 false，
 * 等于「配置坏了一点点 → 用户的记忆排序被静默换掉」，
 * 比「读不到就用产品默认值」糟糕得多。
 */
export function readAffinityDecayEnabled(): boolean {
  try {
    return readFeatureFlag(AFFINITY_FLAG_KEY, true)
  } catch {
    return true
  }
}


// ═══════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════

/** 亲密度系数下界（理由见文件头） */
export const AFFINITY_FLOOR = 0.35
/** 亲密度系数幅度：0.35 ~ 1.00 */
export const AFFINITY_SPAN = 0.65
/** 时间半衰期（天）：90 天权重减半 */
export const HALF_LIFE_DAYS = 90

// ═══════════════════════════════════════════════════════════
// 纯函数核心
// ═══════════════════════════════════════════════════════════

const clamp01 = (x: number) => Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0))

/**
 * 亲密度衰减系数。
 * @param affinityAtWrite 这条记忆产生时的亲密度（0~1）
 * @returns 0.35 ~ 1.0
 */
export function affinityDecay(affinityAtWrite: number): number {
  return AFFINITY_FLOOR + AFFINITY_SPAN * clamp01(affinityAtWrite)
}

/**
 * 时间新鲜度。半衰期 HALF_LIFE_DAYS。
 * @param ageDays 距今天数（负数 = 未来，按 0 处理）
 */
export function recencyFactor(ageDays: number): number {
  if (!Number.isFinite(ageDays) || ageDays <= 0) {return 1}
  return Math.pow(0.5, ageDays / HALF_LIFE_DAYS)
}

/**
 * 最终召回权重。
 *
 * @param confidence     原始置信度 0~1
 * @param affinityAtWrite 产生时的亲密度 0~1
 * @param ageDays        距今天数
 */
export function decayedScore(
  confidence: number,
  affinityAtWrite: number,
  ageDays: number,
): number {
  return clamp01(confidence) * affinityDecay(affinityAtWrite) * recencyFactor(ageDays)
}

/** 两个 ISO 时间字符串之间的天数差；解析失败时返回 0（不惩罚） */
export function ageInDays(iso: string | null | undefined, now: number = Date.now()): number {
  if (!iso) {return 0}
  const t = Date.parse(iso)
  if (Number.isNaN(t)) {return 0}
  return (now - t) / 86_400_000
}

// ═══════════════════════════════════════════════════════════
// 排序调整（纯函数，供 hybridRecall 等召回打分点注入）
// ═══════════════════════════════════════════════════════════

/**
 * 【为什么这里要有一套「乘子」而不是直接把 decayedScore 当分数】
 * 召回层的分数（RRF 的 1/(k+rank)、余弦相似度）和本模块的 confidence×衰减
 * 完全不是一个量纲，直接相乘/相加没有任何解释力。
 * 所以这里只输出一个**有界乘子**，由调用方乘到自己的分数上。
 *
 * 【上界为什么锁在 1】
 * 衰减是**关系感的修正**，不是相关性。允许乘子 >1 就等于让「记得久」
 * 去盖过「跟这次提问相关」，那会把检索彻底变成时间排序。
 * 锁在 ≤1 意味着：它最多只能把一条记忆**往下挪**，
 * 永远不可能把一条不相关的记忆抬上来，也永远不可能把谁删掉或清零。
 */
export const MAX_DECAY_PENALTY = 0.08

/**
 * 一条记忆的相对衰减权重（0, 1]。
 * = 产生时的亲密度系数 × 时间新鲜度。
 *
 * 未标记亲和度的记忆走 affinityAtWriteOf 的中性 0.5，
 * 即「关系中性期的记忆」—— 不偏袒任何一方（与本文件既有约定一致）。
 */
export function decayWeight(affinityAtWrite: number, ageDays: number): number {
  const w = affinityDecay(affinityAtWrite) * recencyFactor(ageDays)
  return w > 0 ? Math.min(1, w) : 0
}

/**
 * 把权重换算成对召回分数的乘子 ∈ [1-MAX_DECAY_PENALTY, 1]。
 *
 * @param weight    本条记忆的 decayWeight
 * @param maxWeight 同一批候选里的最大权重（用作归一化基准）
 *
 * 【为什么要除以 maxWeight】
 * 不归一化的话，一条「从未标记过」的普通记忆会被乘 0.675，
 * 于是**开关一开，所有分数都被压低**——排序虽不变，但分数整体漂移，
 * 任何依赖分数绝对值的地方（UI 百分比、去重阈值）都会跟着动。
 * 归一化之后：候选集权重全部相同 → 全部乘子恰好为 1 → 分数逐字节不变；
 * 只有真的存在「谁更值得被想起」的差异时才会产生调整。
 *
 * 【maxWeight 为 0 的退路】
 * 理论上算不出（权重恒 >0），但仍写死返回 1：
 * 排序调整绝不能自己变成一次故障。
 */
export function decayRankMultiplier(
  weight: number,
  maxWeight: number,
  maxPenalty: number = MAX_DECAY_PENALTY,
): number {
  if (!(maxWeight > 0)) {return 1}
  const ratio = Math.max(0, Math.min(1, weight / maxWeight))
  const m = 1 - maxPenalty * (1 - ratio)
  return Math.max(1 - maxPenalty, Math.min(1, m))
}

/** 从 HybridDoc.metadata 里找亲和度的键名（写入侧尚未统一，这里列全已知的） */
const AFFINITY_KEYS = ['affinity_at_write', 'affinityAtWrite', 'affinity'] as const
/** 从 metadata 里找产生时间/更新时间的键名 */
const TIME_KEYS = ['created_at', 'createdAt', 'ts', 'timestamp', 'updated_at'] as const

function numOf(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) {return v}
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v)
    if (Number.isFinite(n)) {return n}
  }
  return null
}

/**
 * 从召回条目的 metadata 直接算出 decayWeight，让调用方零解析成本接入。
 *
 * 缺字段时的语义（很重要，别当成 bug）：
 *   · 没有亲和度 → 按中性 0.5 处理（既不奖励也不惩罚）
 *   · 没有时间戳 → ageDays = 0（新鲜度 1，不惩罚）
 *   · 两者都缺 → 权重与同批候选一致 → 归一化后乘子恒为 1 → 排序与分数不变
 * 也就是说：**没有衰减数据 = 什么都不发生**，绝不会因为「没数据」而误伤召回。
 */
export function decayWeightFromMetadata(meta: unknown, now: number = Date.now()): number {
  if (!meta || typeof meta !== 'object') {return decayWeight(0.5, 0)}
  const m = meta as Record<string, unknown>

  let aff = 0.5
  for (const key of AFFINITY_KEYS) {
    const v = numOf(m[key])
    if (v !== null) {aff = Math.max(0, Math.min(1, v)); break}
  }

  let age = 0
  for (const key of TIME_KEYS) {
    const raw = m[key]
    if (raw === undefined || raw === null) {continue}
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      age = ageInDays(new Date(raw).toISOString(), now)
      break
    }
    if (typeof raw === 'string' && raw) {
      age = ageInDays(raw, now)
      break
    }
  }
  return decayWeight(aff, age)
}


// ═══════════════════════════════════════════════════════════
// metadata 编解码（affinity_at_write 存在 metadata JSON 里）
// ═══════════════════════════════════════════════════════════

export interface MemoryMeta {
  /** 产生时的亲密度；老数据没有这个字段 → 视为 0.5（中性，不偏袒任何一方） */
  affinity_at_write?: number
  [k: string]: unknown
}

export function parseMeta(raw: unknown): MemoryMeta {
  if (raw && typeof raw === 'object') {return raw as MemoryMeta}
  if (typeof raw !== 'string' || !raw) {return {}}
  try {
    const o = JSON.parse(raw)
    return o && typeof o === 'object' ? (o as MemoryMeta) : {}
  } catch {
    return {}
  }
}

export function encodeMeta(meta: MemoryMeta): string {
  return JSON.stringify(meta)
}

/** 读出产生时的亲密度，缺失时给中性 0.5 */
export function affinityAtWriteOf(raw: unknown): number {
  const m = parseMeta(raw)
  const v = m.affinity_at_write
  return typeof v === 'number' && Number.isFinite(v) ? clamp01(v) : 0.5
}

// ═══════════════════════════════════════════════════════════
// 存储
// ═══════════════════════════════════════════════════════════

export interface DecayedFact {
  id: number
  category: string
  content: string
  confidence: number
  source: string
  createdAt: string
  /** 产生时的亲密度 */
  affinityAtWrite: number
  /** 时间新鲜度因子 */
  recency: number
  /** 亲密度衰减系数 */
  affinityDecay: number
  /** 最终召回权重（排序用） */
  score: number
}

export interface RankOptions {
  /** 当前亲密度（用于「早期记忆随关系加深而变重」的可选增强） */
  currentAffinity?: number
  limit?: number
  now?: number
}

export class AffinityDecayStore {
  private db: Database

  constructor(db: Database) {this.db = db}

  init(): void {
    try {
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_facts_created ON facts(created_at)`)
    } catch { /* 老库可能没 facts 表；不影响主流程 */ }
  }

  /**
   * 标记一条事实「产生时的亲密度」。
   * 只写 metadata，不动 confidence/content——
   * 用户的原话不应该因为关系变化而被篡改。
   */
  stampAffinity(factId: number, affinity: number): void {
    try {
      const row = this.db.prepare('SELECT metadata FROM facts WHERE id=?').get(factId) as any
      const meta = parseMeta(row?.metadata)
      meta.affinity_at_write = clamp01(affinity)
      this.db.prepare('UPDATE facts SET metadata=? WHERE id=?').run(encodeMeta(meta), factId)
    } catch (e) {
      console.warn('[affinityDecay] stampAffinity 失败（不影响主流程）:', (e as Error)?.message)
    }
  }

  /**
   * 按衰减权重排序取回事实。
   *
   * 关键点：**排序在应用层做，不改 SQL**。
   * 因为衰减公式依赖亲密度（应用层状态），
   * 塞进 SQL 意味着每次查询都要传参，复杂度上升但收益为零——
   * 单机 SQLite 的 facts 表通常只有几百上千行，内存排序完全够用。
   */
  rankFacts(opts: RankOptions = {}): DecayedFact[] {
    const now = opts.now ?? Date.now()
    const limit = opts.limit ?? 20
    let rows: any[]
    try {
      rows = this.db.prepare(
        'SELECT id, category, content, confidence, source, created_at, metadata FROM facts'
      ).all() as any[]
    } catch (e) {
      console.warn('[affinityDecay] 读取 facts 失败（返回空）:', (e as Error)?.message)
      return []
    }

    const out: DecayedFact[] = rows.map(r => {
      const conf = typeof r.confidence === 'number' ? clamp01(r.confidence) : 0.5
      const aff = affinityAtWriteOf(r.metadata)
      const age = ageInDays(r.created_at, now)
      const rec = recencyFactor(age)
      const ad = affinityDecay(aff)
      return {
        id: Number(r.id),
        category: String(r.category),
        content: String(r.content),
        confidence: conf,
        source: String(r.source ?? 'user_said'),
        createdAt: String(r.created_at ?? ''),
        affinityAtWrite: aff,
        recency: rec,
        affinityDecay: ad,
        score: conf * ad * rec,
      }
    })

    out.sort((a, b) => b.score - a.score || b.id - a.id)
    return out.slice(0, limit)
  }

  /**
   * 对比：不做衰减时会取到什么，做了衰减后取到什么。
   * 用于调试与「为什么这条没被想起」的自查。
   */
  explain(factId: number, now: number = Date.now()): string | null {
    try {
      const r = this.db.prepare(
        'SELECT id, content, confidence, created_at, metadata FROM facts WHERE id=?'
      ).get(factId) as any
      if (!r) {return null}
      const conf = typeof r.confidence === 'number' ? r.confidence : 0.5
      const aff = affinityAtWriteOf(r.metadata)
      const age = ageInDays(r.created_at, now)
      return [
        `置信度 ${(conf * 100).toFixed(0)}%`,
        `产生时亲密度 ${(aff * 100).toFixed(0)}% → 系数 ${affinityDecay(aff).toFixed(2)}`,
        `距今 ${age.toFixed(0)} 天 → 新鲜度 ${recencyFactor(age).toFixed(2)}`,
        `最终权重 ${(decayedScore(conf, aff, age)).toFixed(3)}`,
      ].join(' · ')
    } catch {
      return null
    }
  }

  /** 统计当前库里受衰减影响的比例（设置页展示用） */
  stats(now: number = Date.now()): {
    total: number
    avgAffinityAtWrite: number
    avgScore: number
    decayed: number
  } {
    const all = this.rankFacts({ limit: 10_000, now })
    if (all.length === 0) {
      return { total: 0, avgAffinityAtWrite: 0, avgScore: 0, decayed: 0 }
    }
    const sumAff = all.reduce((s, f) => s + f.affinityAtWrite, 0)
    const sumScore = all.reduce((s, f) => s + f.score, 0)
    const decayed = all.filter(f => f.score < f.confidence * 0.999).length
    return {
      total: all.length,
      avgAffinityAtWrite: sumAff / all.length,
      avgScore: sumScore / all.length,
      decayed,
    }
  }
}
