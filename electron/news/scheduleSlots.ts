// ============================================================
// scheduleSlots.ts — 新闻推送时段解析（纯函数，零 Electron 依赖）
//
// 为什么要独立成文件：
//   newsDigestScheduler.ts 直接 import { app } from 'electron'，在 vitest
//   (environment: node) 下无法直接单测。把「时段怎么算」抽成纯函数后，
//   调度器的行为才能被覆盖测试，而不必 mock 整个 Electron runtime。
//
// 两种模式：
//   - 'interval'（默认）：每 N 小时一次，anchor 决定起点。
//       interval=3, anchor=0 → [0,3,6,9,12,15,18,21]
//   - 'slots'（兼容旧版）：用户手挑的整点列表（原 8/12/18/22）。
// ============================================================

export type ScheduleMode = 'interval' | 'slots'

/** 间隔模式的静默时段；null = 不静默（保持与旧版一致的行为） */
export interface QuietHours {
  start: number
  end: number
}

export interface ScheduleSpec {
  mode: ScheduleMode
  /** 'slots' 模式下启用的整点 */
  enabledSlots: number[]
  /** 'interval' 模式下的间隔小时数（1-24） */
  intervalHours: number
  /** 'interval' 模式的起始整点（0-23） */
  intervalAnchorHour: number
  /** 静默时段（含 start，不含 end；start===end 视为未设置） */
  quietHours: QuietHours | null
}

export const DEFAULT_INTERVAL_HOURS = 3
export const DEFAULT_ANCHOR_HOUR = 0
export const MIN_INTERVAL_HOURS = 1
export const MAX_INTERVAL_HOURS = 24

/** 默认配置兼容用的时段（保留旧行为，供 'slots' 模式与迁移用） */
export const LEGACY_SLOTS = [8, 12, 18, 22] as const

/** 把任意输入夹到合法小时（0-23）。非法值一律回落到 0。 */
export function normalizeHour(hour: unknown): number {
  const n = Math.trunc(Number(hour))
  if (!Number.isFinite(n)) {return 0}
  // 允许 24 作为 anchor 的等价写法（=次日 0 点）
  return ((n % 24) + 24) % 24
}

/** 把间隔夹到 [1, 24]。0/负数/NaN → 默认值。 */
export function normalizeIntervalHours(hours: unknown): number {
  const n = Math.trunc(Number(hours))
  if (!Number.isFinite(n)) {return DEFAULT_INTERVAL_HOURS}
  if (n < MIN_INTERVAL_HOURS) {return MIN_INTERVAL_HOURS}
  if (n > MAX_INTERVAL_HOURS) {return MAX_INTERVAL_HOURS}
  return n
}

/**
 * 生成间隔模式下的整点列表（升序、去重）。
 *
 * interval=3, anchor=0 → [0,3,6,9,12,15,18,21]
 * interval=2, anchor=1 → [1,3,5,7,9,11,13,15,17,19,21,23]
 * interval=24, anchor=6 → [6]
 */
export function generateIntervalSlots(
  intervalHours: unknown = DEFAULT_INTERVAL_HOURS,
  anchorHour: unknown = DEFAULT_ANCHOR_HOUR,
): number[] {
  const step = normalizeIntervalHours(intervalHours)
  const anchor = normalizeHour(anchorHour)
  const slots = new Set<number>()
  for (let h = 0; h < 24; h += step) {
    slots.add((anchor + h) % 24)
  }
  return [...slots].sort((a, b) => a - b)
}

/**
 * 当前小时是否落在静默时段内。
 * start === end 视为「未设置静默」→ 永不静默。
 * 支持跨午夜（如 23→7）。
 */
export function isHourInQuietRange(hour: number, quiet: QuietHours | null | undefined): boolean {
  if (!quiet) {return false}
  const start = normalizeHour(quiet.start)
  const end = normalizeHour(quiet.end)
  if (start === end) {return false}
  const cur = normalizeHour(hour)
  if (start < end) {return cur >= start && cur < end}
  return cur >= start || cur < end // 跨午夜
}

/**
 * 解析出「当前应该生效」的整点集合。
 *
 * 这是调度器唯一的时段真相来源：
 *   - mode='interval' → 由 intervalHours/anchor 推导
 *   - mode='slots'    → 用用户手挑的 enabledSlots（并清洗越界/去重）
 */
export function resolveActiveSlots(spec: ScheduleSpec): number[] {
  if (spec.mode === 'interval') {
    return generateIntervalSlots(spec.intervalHours, spec.intervalAnchorHour)
  }
  const cleaned = new Set<number>()
  for (const raw of spec.enabledSlots ?? []) {
    const n = Math.trunc(Number(raw))
    if (!Number.isFinite(n) || n < 0 || n > 23) {continue} // 静默丢弃越界项
    cleaned.add(n)
  }
  return [...cleaned].sort((a, b) => a - b)
}

/**
 * 清理用户手填的 enabledSlots：去重 + 丢弃越界 + 升序。
 * 供配置写入时归一化，避免脏数据落盘。
 */
export function sanitizeSlots(slots: unknown): number[] {
  const list = Array.isArray(slots) ? slots : []
  const cleaned = new Set<number>()
  for (const raw of list) {
    const n = Math.trunc(Number(raw))
    if (!Number.isFinite(n) || n < 0 || n > 23) {continue}
    cleaned.add(n)
  }
  return [...cleaned].sort((a, b) => a - b)
}

const SLOT_META: Array<{ max: number; label: string }> = [
  { max: 4, label: '🌙 深夜' },
  { max: 8, label: '🌅 清晨' },
  { max: 11, label: '☀️ 早间' },
  { max: 13, label: '🌤️ 午间' },
  { max: 17, label: '🌆 傍晚' },
  { max: 21, label: '🌙 晚间' },
  { max: 23, label: '🌜 深夜' },
]

/**
 * 时段的可读标签。旧版 8/12/18/22 的文案被完整保留，
 * 新增的整点走通用文案（不会出现 undefined）。
 */
export function describeSlot(hour: number): string {
  const h = normalizeHour(hour)
  const time = `${String(h).padStart(2, '0')}:00`
  // 兼容旧版固定文案
  if (h === 8) {return '☀️ 早间'}
  if (h === 12) {return '🌤️ 午间'}
  if (h === 18) {return '🌆 傍晚'}
  if (h === 22) {return '🌙 晚间'}
  const meta = SLOT_META.find(m => h <= m.max) ?? SLOT_META[SLOT_META.length - 1]
  return `${meta.label} (${time})`
}

/**
 * 冷却时长合法性校验。
 *
 * 背景：冷却是按 slot 记的（lastPushedAt[slot]），而同一 slot 每天只会
 * 回来一次（24h 周期）。所以冷却一旦 > 24h，那个 slot 就永久死掉了。
 * 这里夹到 [0, 24] 是防止用户（或脏数据）把调度器配成永不推送。
 */
export function normalizeCooldownHours(hours: unknown): number {
  const n = Number(hours)
  if (!Number.isFinite(n) || n < 0) {return 0}
  return Math.min(n, 24)
}
