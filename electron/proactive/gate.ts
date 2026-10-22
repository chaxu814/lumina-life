// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// proactive/gate.ts — 🚪 主动发言门控（纯函数，可单测）
//
// 所有触发器走到这里先过一道门：该说的才放行，不该说的直接拦下。
// 规则按优先级从上到下短路，前面的规则赢：
//   a. 桌宠没开 / 用户正在说话 → 一律不打扰
//   b'. 夜间勿扰时段 → 一律不主动开口（只抑制 proactive，用户主动对话不经过这里）
//   c. 有没问完的话头 → 最高优先级放行（绕过冷却，把话说完）
//   d. 精力 < 0.2 → 放行但只许做睡觉动作、不许开口（fallbackToSleep）
//   e. 今日配额用完 → 不发
//   f. 距上次主动发言太近 → 不发
//   g~j. 按屏幕场景决定放行概率（打游戏少打扰、发呆多陪伴）
// 随机场景概率用可注入的 rand，测试时钉死。
// ============================================================

export interface GateInput {
  /** 是否有她上次问了、用户还没回答的问题 */
  hasUnfinishedThread: boolean
  /** 当前屏幕场景（game/video/code/doc/social/idle/other/private） */
  scene: string
  /** 当前内驱力（只看 social/energy/comfort） */
  drives: { social: number; energy: number; comfort: number }
  /** 用户空闲分钟数 */
  idleMinutes: number
  /** 今日已主动发言次数 */
  dailyCount: number
  /** 今日主动发言上限 */
  maxDaily: number
  /** 距上次主动发言的毫秒数 */
  msSinceLastProactive: number
  /** 两次主动发言的最小间隔 */
  minIntervalMs: number
  /** 冷却（预留：当前未独立使用，语义同 minIntervalMs） */
  cooldownMs: number
  /** 桌宠是否开启 */
  petEnabled: boolean
  /** 用户正在说话（VAD/全双工检测到） */
  userSpeaking: boolean
  /** 是否处于夜间勿扰时段（由调用方用 isNightTime() 计算后注入；默认 false，不影响既有行为） */
  isNightMode?: boolean
  /** 可注入随机源（默认 Math.random） */
  rand?: () => number
}

export interface GateResult {
  allowed: boolean
  /** 拒绝/放行原因（调试用） */
  reason: string
  /** 放行但只能做睡觉动作、不许说话 */
  fallbackToSleep?: boolean
}

// ============================================================
// 🌙 夜间勿扰（任务二）
//
// 默认 23:00–07:00 为夜间。夜间只抑制「她主动开口」的 proactive 触发，
// 用户主动发起的对话（不经过 decideGate）不受影响；22:00 的晚安问候
// 本身早于 23:00 夜间起点，自然不受影响。
// 判定基于本地时间，纯函数，可单测边界。
// ============================================================

export interface NightModeConfig {
  /** 夜间开始小时（本地 24h 制，含） */
  startHour: number
  /** 夜间结束小时（本地 24h 制，不含） */
  endHour: number
  /** 是否启用夜间勿扰 */
  enabled: boolean
}

export const NIGHT_MODE: NightModeConfig = {
  startHour: 23,
  endHour: 7,
  enabled: true,
}

/** 热更新夜间勿扰配置（缺省字段保留旧值） */
export function setNightMode(partial: Partial<NightModeConfig>): void {
  if (partial.startHour !== undefined) { NIGHT_MODE.startHour = ((partial.startHour % 24) + 24) % 24 }
  if (partial.endHour !== undefined) { NIGHT_MODE.endHour = ((partial.endHour % 24) + 24) % 24 }
  if (partial.enabled !== undefined) { NIGHT_MODE.enabled = !!partial.enabled }
}

/** 夜间勿扰是否开启 */
export function isNightModeEnabled(): boolean {
  return NIGHT_MODE.enabled
}

/**
 * 判断给定时间是否落在夜间勿扰窗口内（纯函数）。
 * 支持跨午夜区间（如 23:00–07:00）：hour >= startHour 或 hour < endHour。
 * @param now 可注入时间（测试用），默认当前本地时间
 */
export function isNightTime(now?: Date): boolean {
  if (!NIGHT_MODE.enabled) {return false}
  const d = now instanceof Date ? now : new Date()
  const h = d.getHours()
  const { startHour, endHour } = NIGHT_MODE
  if (startHour === endHour) {return false} // 配置无效：全天都算夜间/都不算，按不抑制处理
  if (startHour < endHour) {
    // 同向区间（如 1:00–5:00 这种特殊配置）
    return h >= startHour && h < endHour
  }
  // 跨午夜区间（默认 23–7）
  return h >= startHour || h < endHour
}

/** 场景放行概率表（g~j）：0 = 一律不打扰
 * v6.2 体感升级——打游戏/看视频正是她该凑过来的时候，
 * 概率从保守的 0.5 整体上调；隐私场景仍恒为 0，绝不打扰。 */
function scenePassRate(scene: string): number {
  switch (scene) {
    case 'game': return 0.85  // g: 打游戏 85% 放行（观战吐槽是核心体感）
    case 'video': return 0.75 // 看视频 75%（陪看、吐槽、安利）
    case 'private': return 0  // h: 隐私场景（全屏私密等）一律不打扰
    case 'idle':
    case 'other': return 0.9  // i: 发呆/杂用 90% 陪伴（发呆时最需要她）
    case 'code': return 0.55  // 写代码 55%（轻度打扰，专注时不烦）
    case 'doc': return 0.6   // 看文档 60%
    case 'social': return 0.4 // 社交聊天 40%（你在跟别人聊，她少插嘴）
    default: return 0.65      // j: 其余 65%
  }
}

/** 门控决策：按规则优先级短路返回 */
export function decideGate(input: GateInput): GateResult {
  const rand = input.rand ?? Math.random

  // a. 桌宠没开
  if (!input.petEnabled) {return { allowed: false, reason: 'pet_disabled' }}

  // b. 用户正在说话，不打断
  if (input.userSpeaking) {return { allowed: false, reason: 'user_speaking' }}

  // b'. 夜间勿扰：只抑制她主动开口（proactive 全部经过这里）。
  // 用户主动对话不走 decideGate；22:00 晚安在 23:00 之前，天然豁免。
  if (input.isNightMode) {return { allowed: false, reason: 'night_mode' }}

  // c. 有没问完的话头 → 最高优先级，绕过冷却把话说完
  if (input.hasUnfinishedThread) {return { allowed: true, reason: 'unfinished_thread' }}

  // d. 精力太低 → 放行但只做睡觉动作、不说话
  if (input.drives.energy < 0.2) {
    return { allowed: true, reason: 'low_energy_sleep', fallbackToSleep: true }
  }

  // e. 今日配额
  if (input.dailyCount >= input.maxDaily) {return { allowed: false, reason: 'daily_quota' }}

  // f. 最小间隔（冷却时间并入此判断）
  const minGap = Math.max(input.minIntervalMs, input.cooldownMs)
  if (input.msSinceLastProactive < minGap) {return { allowed: false, reason: 'min_interval' }}

  // g~j. 场景概率
  const rate = scenePassRate(input.scene)
  if (rate === 0) {return { allowed: false, reason: 'scene_private' }}
  if (rand() < rate) {return { allowed: true, reason: `scene_${input.scene}` }}
  return { allowed: false, reason: `scene_denied_${input.scene}` }
}
