// ============================================================
// moodstats/stats.ts — 分桶聚合与诚实报告（纯逻辑，重点测试）
//
// 【为什么分桶】
// 「情绪和成功率有没有关系」是个连续问题，但桌面应用日常数据量小，
// 连续趋势图只会画出噪声。把 mood 切成 5 档、energy 切成 3 档，
// 每个格子回答一个具体问题：「低落 + 低能的时候，工具执行成功率多少？」
//
// 【诚实样本门槛 —— 本文件最重要的纪律】
//   MIN_SAMPLE = 30。每个分桶样本不足时：
//     · 不给成功率的点估计（successRate = null），UI 显示「数据不足」；
//     · 不画趋势线（趋势点 n<MIN_SAMPLE 时同样降权）；
//     · 报告里每桶都带样本量，让用户自己判断够不够。
//   依据：30 是「粗略估计比例」的经验下限——样本低于此，
//   成功率从 60% 跳到 90% 可能只是两三次失败的波动，
//   报出来就是在喂用户假关联。
//
// 【A/B 对照输出原则】
//   只给两组的 n / 成功率 / 失败率 / 平均重试 / 平均耗时，
//   不做显著性检验（样本根本撑不住 p 值），不写「门控有效/无效」的结论。
// ============================================================

import type { MoodSnapshot, GroupTag } from './types'

// ═══════════════════════════════════════════════════════════
// 分桶定义
// ═══════════════════════════════════════════════════════════

/**
 * mood 五档边界（mood ∈ [-1, 1]）。
 * 边界归属：左闭右开，最后一档闭右端。
 */
export const MOOD_BUCKETS: Array<{ label: string; lo: number; hi: number }> = [
  { label: '低落', lo: -1, hi: -0.6 },
  { label: '偏低', lo: -0.6, hi: -0.2 },
  { label: '平静', lo: -0.2, hi: 0.2 },
  { label: '愉悦', lo: 0.2, hi: 0.6 },
  { label: '高涨', lo: 0.6, hi: 1.0001 },
]

/** energy 三档（energy ∈ [0, 1]） */
export const ENERGY_BUCKETS: Array<{ label: string; lo: number; hi: number }> = [
  { label: '低能', lo: 0, hi: 0.34 },
  { label: '中等', lo: 0.34, hi: 0.67 },
  { label: '高能', lo: 0.67, hi: 1.0001 },
]

/**
 * 每桶最小样本量。
 *
 * 依据：二项比例在 n<30 时置信区间宽到没有解释力
 * （例如 n=10、8 次成功，95% CI 大约是 44%~97%），
 * 报一个「80% 成功率」纯属噪声包装。30 是经验下限而非统计学结论——
 * 这里宁可漏掉弱信号，也不制造假结论。
 */
export const MIN_SAMPLE = 30

/** 情绪缺失时的分桶标签 */
export const UNKNOWN_BUCKET = '未知'

// ═══════════════════════════════════════════════════════════
// 分桶索引（导出供测试）
// ═══════════════════════════════════════════════════════════

export function bucketizeMood(mood: number | null | undefined): string {
  if (typeof mood !== 'number' || Number.isNaN(mood)) {return UNKNOWN_BUCKET}
  const v = Math.max(-1, Math.min(1, mood))
  for (const b of MOOD_BUCKETS) {
    if (v >= b.lo && v < b.hi) {return b.label}
  }
  return MOOD_BUCKETS[MOOD_BUCKETS.length - 1].label
}

export function bucketizeEnergy(energy: number | null | undefined): string {
  if (typeof energy !== 'number' || Number.isNaN(energy)) {return UNKNOWN_BUCKET}
  const v = Math.max(0, Math.min(1, energy))
  for (const b of ENERGY_BUCKETS) {
    if (v >= b.lo && v < b.hi) {return b.label}
  }
  return ENERGY_BUCKETS[ENERGY_BUCKETS.length - 1].label
}

// ═══════════════════════════════════════════════════════════
// 聚合结果类型
// ═══════════════════════════════════════════════════════════

export interface BucketRow {
  moodBucket: string
  energyBucket: string
  n: number
  /** 成功率；n=0 或 n<MIN_SAMPLE 时为 null（诚实降权） */
  successRate: number | null
  avgRetries: number | null
  avgDurationMs: number | null
  /** 样本是否够下结论 */
  trustworthy: boolean
}

export interface TrendPoint {
  date: string
  n: number
  successRate: number | null
}

export interface GroupComparison {
  group: GroupTag
  n: number
  ok: number
  fail: number
  successRate: number | null
  avgRetries: number | null
  avgDurationMs: number | null
  trustworthy: boolean
}

// ═══════════════════════════════════════════════════════════
// 聚合
// ═══════════════════════════════════════════════════════════

function avg(xs: number[]): number | null {
  if (xs.length === 0) {return null}
  return Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100
}

export function summarize(snaps: MoodSnapshot[]): Omit<BucketRow, 'moodBucket' | 'energyBucket'> & { ok: number; fail: number } {
  const n = snaps.length
  const ok = snaps.filter(s => s.ok).length
  return {
    n,
    ok,
    fail: n - ok,
    successRate: n >= MIN_SAMPLE ? Math.round((ok / n) * 1000) / 10 : null,
    avgRetries: avg(snaps.map(s => s.retries)),
    avgDurationMs: avg(snaps.map(s => s.durationMs)),
    trustworthy: n >= MIN_SAMPLE,
  }
}

/**
 * mood × energy 全量分桶。只输出 n>0 的格子（空格子不画），
 * 但 n>0 且 n<MIN_SAMPLE 的格子必须带「数据不足」语义
 * （successRate=null + trustworthy=false）。
 */
export function aggregateBuckets(snaps: MoodSnapshot[]): BucketRow[] {
  const cells = new Map<string, MoodSnapshot[]>()
  for (const s of snaps) {
    const key = `${bucketizeMood(s.mood)}|${bucketizeEnergy(s.energy)}`
    const arr = cells.get(key) ?? []
    arr.push(s)
    cells.set(key, arr)
  }
  const rows: BucketRow[] = []
  for (const [key, arr] of cells) {
    const [moodBucket, energyBucket] = key.split('|')
    const sum = summarize(arr)
    rows.push({
      moodBucket,
      energyBucket,
      n: sum.n,
      successRate: sum.successRate,
      avgRetries: sum.avgRetries,
      avgDurationMs: sum.avgDurationMs,
      trustworthy: sum.trustworthy,
    })
  }
  // 排序：先按 mood 档位顺序，再按 energy；未知桶排最后
  const moodOrder = [...MOOD_BUCKETS.map(b => b.label), UNKNOWN_BUCKET]
  const energyOrder = [...ENERGY_BUCKETS.map(b => b.label), UNKNOWN_BUCKET]
  rows.sort((a, b) => {
    const d = moodOrder.indexOf(a.moodBucket) - moodOrder.indexOf(b.moodBucket)
    if (d !== 0) {return d}
    return energyOrder.indexOf(a.energyBucket) - energyOrder.indexOf(b.energyBucket)
  })
  return rows
}

/** 按天趋势。每个点自带样本量；n<MIN_SAMPLE 时 successRate=null（诚实降权） */
export function trendByDay(snaps: MoodSnapshot[]): TrendPoint[] {
  const days = new Map<string, MoodSnapshot[]>()
  for (const s of snaps) {
    const d = new Date(s.ts)
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const arr = days.get(day) ?? []
    arr.push(s)
    days.set(day, arr)
  }
  return [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, arr]) => {
    const ok = arr.filter(s => s.ok).length
    return {
      date,
      n: arr.length,
      successRate: arr.length >= MIN_SAMPLE ? Math.round((ok / arr.length) * 1000) / 10 : null,
    }
  })
}

/** A/B 两组对照 —— 只给数字，不给结论 */
export function compareGroups(snaps: MoodSnapshot[]): GroupComparison[] {
  const groups = new Map<GroupTag, MoodSnapshot[]>()
  for (const s of snaps) {
    const arr = groups.get(s.group) ?? []
    arr.push(s)
    groups.set(s.group, arr)
  }
  const order: GroupTag[] = ['treatment', 'control', 'off']
  return order.filter(g => groups.has(g)).map(g => {
    const arr = groups.get(g)!
    const sum = summarize(arr)
    return {
      group: g,
      n: sum.n,
      ok: sum.ok,
      fail: sum.fail,
      successRate: sum.successRate,
      avgRetries: sum.avgRetries,
      avgDurationMs: sum.avgDurationMs,
      trustworthy: sum.trustworthy,
    }
  })
}

/** 给 UI 的一句话诚实说明（同一套措辞，避免各处各写） */
export function honestyNote(n: number): string {
  if (n === 0) {return '还没有数据'}
  if (n < MIN_SAMPLE) {return `数据不足（${n}/${MIN_SAMPLE}），不构成结论`}
  return `样本量 ${n}`
}

/** 整份报告（导出 / IPC 用的聚合根） */
export interface StatsReport {
  generatedAt: number
  totalSnapshots: number
  buckets: BucketRow[]
  trend: TrendPoint[]
  groups: GroupComparison[]
  honesty: { minSample: number; note: string }
}

export function buildReport(snaps: MoodSnapshot[]): StatsReport {
  return {
    generatedAt: Date.now(),
    totalSnapshots: snaps.length,
    buckets: aggregateBuckets(snaps),
    trend: trendByDay(snaps),
    groups: compareGroups(snaps),
    honesty: {
      minSample: MIN_SAMPLE,
      note: `每桶样本 < ${MIN_SAMPLE} 时不输出成功率结论（避免小样本噪声被当成规律）`,
    },
  }
}
