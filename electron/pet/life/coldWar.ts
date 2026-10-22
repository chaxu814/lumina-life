// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// pet/life/coldWar.ts — 🧊 冷战 / 原谅状态机 (I2, v0.1)
//
// 连续多天不理她 → 进入「冷战」：桌宠转身背对、不主动搭话；
// 用户某天主动来搭话 → 24h 内「原谅」、精神一振（petAction='perk'）。
//
// 状态机（按距上次用户主动搭话的天数，纯函数可单测）：
//   < 1 天   → warm     正常陪伴
//   1~3 天   → cooling  冷淡、话少
//   > 3 天   → cold     冷战：背对、不主动
//
// 持久化：userData/cold-war.json（只存 lastInteractionAt）。
// 惰性 require('electron')：无 Electron 的单测环境退化为纯内存，不崩。
// 主进程启动 / 每次用户消息（petChat / petVoiceChat）时调用 markUserInteraction()。
// ============================================================

import * as fs from 'fs'
import * as path from 'path'
import type { ColdState } from './emotionExpressions'

export const MS_PER_DAY = 24 * 60 * 60 * 1000
/** 进入「冷淡」的天数阈值 */
export const COOLING_AFTER_DAYS = 1
/** 进入「冷战」的天数阈值（>3 天） */
export const COLD_AFTER_DAYS = 3
/** 原谅窗口：用户搭话后多久内算「回暖」 */
export const RECONCILE_MS = 24 * 60 * 60 * 1000

/**
 * 纯函数：按距上次互动的天数推冷战状态。
 *   days < 1          → warm
 *   1 <= days <= 3    → cooling
 *   days > 3          → cold
 */
export function coldStateFromDays(days: number): ColdState {
  const d = Number.isFinite(days) ? Math.max(0, days) : 0
  if (d < COOLING_AFTER_DAYS) {return 'warm'}
  if (d <= COLD_AFTER_DAYS) {return 'cooling'}
  return 'cold'
}

interface ColdWarFile {
  lastInteractionAt: number
}

class ColdWarTracker {
  private lastInteractionAt: number
  private loaded = false
  private saveTimer: NodeJS.Timeout | null = null
  private storePath: string | null = null

  constructor() {
    // 首次构造按「现在」记一次，避免全新用户一上来就被当成冷落了几天
    this.lastInteractionAt = Date.now()
  }

  private resolvePath(): string | null {
    try {
      // 惰性 require，避免在无 Electron 的测试环境直接崩（同 agentRelationships）
      const electronMod = typeof require === 'function' ? require('electron') : null
      const app = electronMod?.app
      const dir = app?.getPath ? app.getPath('userData') : process.cwd()
      return path.join(dir, 'cold-war.json')
    } catch {
      return null
    }
  }

  private load(): void {
    if (this.loaded) {return}
    this.loaded = true
    this.storePath = this.resolvePath()
    if (!this.storePath) {return}
    try {
      if (!fs.existsSync(this.storePath)) {return}
      const raw = JSON.parse(fs.readFileSync(this.storePath, 'utf-8')) as ColdWarFile
      if (typeof raw.lastInteractionAt === 'number' && Number.isFinite(raw.lastInteractionAt)) {
        this.lastInteractionAt = raw.lastInteractionAt
      }
    } catch {
      /* 坏文件就用构造时的 now，不崩 */
    }
  }

  /** 用户主动搭话（主进程收到用户消息时调用）：刷新时间戳并防抖落盘 */
  markUserInteraction(now = Date.now()): void {
    this.load()
    this.lastInteractionAt = now
    if (!this.storePath) {return}
    if (this.saveTimer) {clearTimeout(this.saveTimer)}
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.saveNow()
    }, 800)
  }

  private saveNow(): void {
    if (!this.storePath) {return}
    try {
      fs.writeFileSync(this.storePath, JSON.stringify({ lastInteractionAt: this.lastInteractionAt }, null, 2), 'utf-8')
    } catch {
      /* 落盘失败只影响本次进程 */
    }
  }

  /** 距上次用户主动搭话的天数（小数） */
  daysSinceInteraction(now = Date.now()): number {
    this.load()
    return Math.max(0, (now - this.lastInteractionAt) / MS_PER_DAY)
  }

  /** 当前冷战状态 */
  getState(now = Date.now()): ColdState {
    return coldStateFromDays(this.daysSinceInteraction(now))
  }

  /** 用户是否在最近 24h 内主动搭话（原谅窗口） */
  userSpokeWithin24h(now = Date.now()): boolean {
    this.load()
    return now - this.lastInteractionAt <= RECONCILE_MS
  }

  /** 测试辅助：重置内存与持久化时间戳 */
  reset(now = Date.now()): void {
    this.loaded = false
    this.lastInteractionAt = now
    if (this.saveTimer) {clearTimeout(this.saveTimer); this.saveTimer = null}
    if (this.storePath) {
      try { fs.unlinkSync(this.storePath) } catch { /* 不存在即可 */ }
    }
  }
}

let _instance: ColdWarTracker | null = null

export function getColdWar(): ColdWarTracker {
  if (!_instance) {_instance = new ColdWarTracker()}
  return _instance
}
