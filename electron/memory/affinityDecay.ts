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
