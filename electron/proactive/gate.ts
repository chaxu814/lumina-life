// ============================================================
// proactive/gate.ts — 🚪 主动发言门控（纯函数，可单测）
//
// 所有触发器走到这里先过一道门：该说的才放行，不该说的直接拦下。
// 规则按优先级从上到下短路，前面的规则赢：
//   a. 桌宠没开 / 用户正在说话 → 一律不打扰
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

/** 场景放行概率表（g~j）：0 = 一律不打扰 */
function scenePassRate(scene: string): number {
  switch (scene) {
    case 'game': return 0.5   // g: 打游戏 50% 放行
    case 'private': return 0  // h: 隐私场景（全屏私密等）一律不打扰
    case 'idle':
    case 'other': return 0.7  // i: 发呆/杂用 70% 陪伴
    default: return 0.5       // j: code/video/doc/social 等 50%
  }
}

/** 门控决策：按规则优先级短路返回 */
export function decideGate(input: GateInput): GateResult {
  const rand = input.rand ?? Math.random

  // a. 桌宠没开
  if (!input.petEnabled) return { allowed: false, reason: 'pet_disabled' }

  // b. 用户正在说话，不打断
  if (input.userSpeaking) return { allowed: false, reason: 'user_speaking' }

  // c. 有没问完的话头 → 最高优先级，绕过冷却把话说完
  if (input.hasUnfinishedThread) return { allowed: true, reason: 'unfinished_thread' }

  // d. 精力太低 → 放行但只做睡觉动作、不说话
  if (input.drives.energy < 0.2) {
    return { allowed: true, reason: 'low_energy_sleep', fallbackToSleep: true }
  }

  // e. 今日配额
  if (input.dailyCount >= input.maxDaily) return { allowed: false, reason: 'daily_quota' }

  // f. 最小间隔（冷却时间并入此判断）
  const minGap = Math.max(input.minIntervalMs, input.cooldownMs)
  if (input.msSinceLastProactive < minGap) return { allowed: false, reason: 'min_interval' }

  // g~j. 场景概率
  const rate = scenePassRate(input.scene)
  if (rate === 0) return { allowed: false, reason: 'scene_private' }
  if (rand() < rate) return { allowed: true, reason: `scene_${input.scene}` }
  return { allowed: false, reason: `scene_denied_${input.scene}` }
}
