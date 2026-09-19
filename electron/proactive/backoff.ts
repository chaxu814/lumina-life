// ============================================================
// proactive/backoff.ts — ⏳ 主动发言退避（纯函数，零依赖，可单测）
//
// 目的：她不能因为「想说话」就不停地打断用户。每说完一次，
// 下一次主动开口要等更久；被用户互动一次就立刻清零。
// 退避曲线借鉴 N.E.K.O 的「逐渐变乖、被理就活过来」：
//   level 0  15s      level 3  2min     level 6  30min
//   level 1  30s      level 4  5min     level>=7 60min（硬顶）
//   level 2  60s      level 5  10min
// 升级规则：前 3 级必升（刚开口后的自然冷却），
// 3~6 级只有 9% 概率升级（大多数时候维持原节奏），7 级封顶。
// ============================================================

/** 各级别的退避毫秒数（level 0~6），>=7 走硬顶 */
const BACKOFF_TABLE = [
  15_000,   // 0: 15s
  30_000,   // 1: 30s
  60_000,   // 2: 1min
  120_000,  // 3: 2min
  300_000,  // 4: 5min
  600_000,  // 5: 10min
  1_800_000, // 6: 30min
]
const HARD_CAP_MS = 3_600_000 // >=7: 60min 硬顶

/** 某一级别需要等待多久 */
export function computeBackoffMs(level: number): number {
  const lv = Math.max(0, Math.floor(level))
  if (lv >= 7) return HARD_CAP_MS
  return BACKOFF_TABLE[lv]
}

/**
 * 下一次发言后是否升级：
 * - level < 3：必升（前三档是「新鲜期」冷却）
 * - 3 <= level < 7：9% 概率升级（低频抖动，大多数时候稳住）
 * - level >= 7：封顶不变
 * @param rand 可注入的随机源（测试用）
 */
export function maybeLevelUp(level: number, rand: () => number = Math.random): number {
  const lv = Math.max(0, Math.floor(level))
  if (lv < 3) return lv + 1
  if (lv >= 7) return 7
  return rand() < 0.09 ? lv + 1 : lv
}

/** 退避状态机：记录当前级别与上次尝试时间 */
export class BackoffState {
  /** 当前退避级别 0~7 */
  level = 0
  /** 上次主动发言时间戳（0 = 还没说过，无需等待） */
  lastAttemptAt = 0

  constructor(opts?: { now?: number }) {
    if (opts?.now !== undefined) this.lastAttemptAt = opts.now
  }

  /** 用户互动了 → 立刻清零，她又「活过来了」 */
  resetOnInteraction(): void {
    this.level = 0
    this.lastAttemptAt = 0
  }

  /** 记录一次尝试（发言后调用）：按规则升级级别并打时间戳 */
  recordAttempt(now: number = Date.now()): void {
    this.level = maybeLevelUp(this.level)
    this.lastAttemptAt = now
  }

  /** 距离下次允许发言还需等待多少毫秒（已过的时间自动扣除；从未发言返回 0） */
  nextDelayMs(now: number = Date.now()): number {
    if (this.lastAttemptAt === 0) return 0
    const waited = now - this.lastAttemptAt
    return Math.max(0, computeBackoffMs(this.level) - waited)
  }
}
