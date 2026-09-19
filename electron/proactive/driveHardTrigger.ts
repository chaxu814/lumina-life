// ============================================================
// proactive/driveHardTrigger.ts — ⚡ 内驱力硬触发（纯函数，可单测）
//
// 内驱力积压到一定程度时，不等定时器/事件，主动开口：
//   - social > 0.7 且用户闲置超过 5 分钟 → 她「坐不住了」，必须搭话撒娇
//   - energy < 0.2 → 不说话，直接进睡觉模式
// 纯逻辑，不碰 Electron/时间，时间由调用方注入。
// ============================================================

export interface DriveSnapshot {
  /** 0 自足 ~ 1 很想找你 */
  social: number
  /** 0 精疲力竭 ~ 1 精力充沛 */
  energy: number
}

/** social 积压 + 闲置够久 → 强制主动搭话 */
export function shouldForceSpeak(drives: DriveSnapshot, idleMinutes: number): boolean {
  return drives.social > 0.7 && idleMinutes > 5
}

/** 精力枯竭 → 直接睡觉，不说话 */
export function shouldSleepMode(drives: Pick<DriveSnapshot, 'energy'>): boolean {
  return drives.energy < 0.2
}
