// ============================================================
// moodstats/masterSwitch.ts — 情绪看板「总开关」运行时闭环
//
// 【为什么需要它】
//   采集包裹（wrapTargets）只在 main.ts 启动时挂一次。面板上把
//   moodstats 总开关从 关→开 时，必须立即重新包裹；从 开→关 时，
//   必须立即恢复原方法（恢复主链路透明）。这个模块只做一件事：
//   写 flag 持久化 + 立即执行 撤销/重挂。
//
// 【与 A/B 开关的区别】
//   · 本模块 = 总开关（moodstats.enabled）：控制要不要采集。
//   · A/B 开关（ab.enableExperiment / optOut）= 采集后是否做门控干预，
//     走 abGroup 自身持久化，见 moodstats:ab:* 通道。
// ============================================================

import { isEnabled, setFlag } from '../core/featureFlags'
import { __resetMoodStats } from './register'

/** main.ts 启动时注入：按当前运行时引用（registry 模块 + delegationManager 实例）重建包裹 */
let configureCollection: (() => void) | null = null

export function configureMoodStatsCollection(fn: () => void): void {
  configureCollection = fn
}

/** 读当前总开关状态 */
export function moodStatsMasterEnabled(): boolean {
  try {return isEnabled('moodstats.enabled')} catch {return false}
}

/**
 * 翻转总开关：
 *   on=false → setFlag(false) + __resetMoodStats()（恢复原方法，主链路立刻静默）
 *   on=true  → setFlag(true) + 重新执行 configureCollection()（立即开始采集）
 */
export function applyMoodStatsMaster(on: boolean): void {
  setFlag('moodstats.enabled', on)
  try {__resetMoodStats()} catch { /* 未注册也无妨 */ }
  if (on && configureCollection) {
    configureCollection()
  }
}
