// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// gamification/levels.ts — 等级 & XP 系统 v1.0
//
// 每次有意义的交互获得 XP → 升级解锁新能力
// XP 来源：对话、使用工具、完成任务、解锁成就
// ============================================================

import { globalEventBus, BusEvents } from '../eventBus'
// 静态导入（打包后动态 require 路径解析不到）
import { getEmotionXpMultiplier } from './emotionBridge'

// ═══════════════════════════════════════════════════════════
// XP 规则
// ═══════════════════════════════════════════════════════════

export const XP_RULES = {
  /** 每条用户消息 */
  PER_MESSAGE: 10,
  /** 每次使用工具 */
  PER_TOOL_CALL: 5,
  /** 每次使用新工具（首次使用 bonus） */
  PER_NEW_TOOL: 25,
  /** 每次解锁成就 */
  PER_ACHIEVEMENT: 50,
  /** 每天首次打开 Lumina */
  DAILY_LOGIN: 20,
  /** 每完成一个定时任务 */
  PER_TASK_COMPLETED: 15,
  /** 每保存一条记忆 */
  PER_MEMORY_SAVED: 8,
  /** 每日 XP 上限（防止刷分） */
  DAILY_XP_CAP: 500,
}

/**
 * 等级计算公式:
 *   Level 1:    0 XP
 *   Level 2:  100 XP
 *   Level 3:  250 XP
 *   Level n:  100 * n^1.5
 *
 * 即 levelThreshold(n) = 100 * n^1.5
 */
export function xpForLevel(level: number): number {
  return Math.floor(100 * Math.pow(level, 1.5))
}

export function levelFromXp(totalXp: number): number {
  let level = 1
  while (xpForLevel(level + 1) <= totalXp) {
    level++
  }
  return level
}

export function xpProgress(totalXp: number): { level: number; currentXp: number; nextLevelXp: number; progress: number } {
  const level = levelFromXp(totalXp)
  const currentThreshold = xpForLevel(level)
  const nextThreshold = xpForLevel(level + 1)
  const currentXp = totalXp - currentThreshold
  const neededXp = nextThreshold - currentThreshold
  return {
    level,
    currentXp,
    nextLevelXp: neededXp,
    progress: neededXp > 0 ? currentXp / neededXp : 1,
  }
}

/**
 * 等级对应的称号
 */
export const LEVEL_TITLES: Record<number, string> = {
  1: '初见',
  2: '熟人',
  3: '朋友',
  4: '好友',
  5: '挚友',
  6: '伙伴',
  7: '知己',
  8: '家人',
  9: '灵魂伴侣',
  10: '命定之人',
  15: '永恒羁绊',
  20: '超越次元',
}

export function getTitle(level: number): string {
  const exact = LEVEL_TITLES[level]
  if (exact) {return exact}
  // 取不超过当前等级的最高称号
  const keys = Object.keys(LEVEL_TITLES).map(Number).sort((a, b) => a - b)
  let title = '冒险者'
  for (const k of keys) {
    if (k <= level) {title = LEVEL_TITLES[k]}
  }
  return title
}

/**
 * 每级解锁的能力描述
 */
export const LEVEL_UNLOCKS: Record<number, string[]> = {
  2: ['Lumina 会记住你的名字'],
  3: ['解锁「主动关心」功能', 'Lumina 会主动问你要不要喝水'],
  5: ['解锁「回忆书对话」', '可以直接问 Lumina "我上周干了什么"'],
  7: ['Lumina 学会讲冷笑话'],
  10: ['解锁「梦境」功能', 'Lumina 每晚生成梦境日记'],
  12: ['解锁「自定义早安语」'],
  15: ['解锁「高级分析」模式'],
  20: ['解锁「特殊互动」彩蛋'],
}

// ═══════════════════════════════════════════════════════════
// XP 管理器
// ═══════════════════════════════════════════════════════════

class XpManager {
  private _totalXp = 0
  private _todayXp = 0
  private _lastResetDate = ''
  private _listeners: Array<(info: { level: number; totalXp: number; title: string }) => void> = []

  get totalXp(): number { return this._totalXp }
  get todayXp(): number { return this._todayXp }
  get level(): number { return levelFromXp(this._totalXp) }
  get title(): string { return getTitle(this.level) }
  get progress() { return xpProgress(this._totalXp) }

  /** 重置每日 XP（跨日时调用） */
  private checkDailyReset(): void {
    const today = new Date().toISOString().slice(0, 10)
    if (this._lastResetDate !== today) {
      this._todayXp = 0
      this._lastResetDate = today
    }
  }

  /** 增加 XP（支持情绪倍率） */
  addXp(amount: number, reason: string, emotionMultiplier?: number): { levelUp: boolean; oldLevel: number; newLevel: number; multiplier: number; baseXp: number } {
    this.checkDailyReset()

    // 情绪倍率：传入 > 0 则用传入值，否则从 bridge 读取
    const multiplier = (emotionMultiplier !== undefined && emotionMultiplier > 0)
      ? emotionMultiplier
      : (() => {
          try {
            return getEmotionXpMultiplier()
          } catch { return 1.0 }
        })()

    const adjustedAmount = Math.round(amount * multiplier)

    // 不超过每日上限（按基础 XP 算，防止高倍率刷分）
    const dailyLeft = XP_RULES.DAILY_XP_CAP - this._todayXp
    const capped = Math.min(adjustedAmount, dailyLeft)
    if (capped <= 0) {return { levelUp: false, oldLevel: this.level, newLevel: this.level, multiplier, baseXp: amount }}

    const oldLevel = this.level
    this._totalXp += capped
    this._todayXp += capped
    const newLevel = this.level

    const levelUp = oldLevel !== newLevel

    // 发送事件（含情绪信息）
    globalEventBus.emit(BusEvents.XP_GAINED, {
      amount: capped,
      baseXp: amount,
      multiplier,
      reason,
      totalXp: this._totalXp,
      level: newLevel,
      levelUp,
    })

    if (levelUp) {
      globalEventBus.emit(BusEvents.LEVEL_UP, {
        oldLevel,
        newLevel,
        title: getTitle(newLevel),
        unlocks: LEVEL_UNLOCKS[newLevel] || [],
      })
    }

    this._listeners.forEach(l => l({
      level: newLevel,
      totalXp: this._totalXp,
      title: getTitle(newLevel),
    }))

    return { levelUp, oldLevel, newLevel, multiplier, baseXp: amount }
  }

  /** 从持久化恢复 */
  setState(totalXp: number, todayXp: number, lastResetDate: string): void {
    this._totalXp = totalXp
    this._todayXp = todayXp
    this._lastResetDate = lastResetDate
  }

  getState(): { totalXp: number; todayXp: number; lastResetDate: string } {
    return {
      totalXp: this._totalXp,
      todayXp: this._todayXp,
      lastResetDate: this._lastResetDate,
    }
  }

  /** 注册等级变化监听 */
  onLevelChange(cb: (info: { level: number; totalXp: number; title: string }) => void): () => void {
    this._listeners.push(cb)
    return () => {
      this._listeners = this._listeners.filter(l => l !== cb)
    }
  }
}

// 全局单例
export const xpManager = new XpManager()
