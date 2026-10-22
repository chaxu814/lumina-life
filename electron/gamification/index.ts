// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// gamification/index.ts — 游戏化模块入口
// ============================================================

import * as path from 'path'
import * as fs from 'fs'
import { app } from 'electron'
import { xpManager } from './levels'
import { achievementManager } from './achievements'

export { achievementManager, ACHIEVEMENTS } from './achievements'
export type { Achievement, UserStats } from './achievements'

export { xpManager, XP_RULES, levelFromXp, xpProgress, getTitle, LEVEL_TITLES, LEVEL_UNLOCKS } from './levels'

export { personalityConflictManager } from './personalityConflict'
export type { PersonalityConflict } from './personalityConflict'

// ═══════════════════════════════════════════════════════════
// 数据持久化（XP + 成就状态）
// ═══════════════════════════════════════════════════════════

interface GamificationPersistedData {
  totalXp: number
  todayXp: number
  lastResetDate: string
  unlockedAchievements: string[]
  userStats?: {
    totalChats: number
    totalMessages: number
    toolsUsed: string[]
    totalToolCalls: number
    totalAffinity: number
    daysActive: number
    streakDays: number
    memoriesSaved: number
    tasksCompleted: number
    modeSwitches: number
    timeCapsulesBuried: number
  }
}

function getGamificationDataPath(): string {
  try {
    return path.join(app.getPath('userData'), 'lumina-gamification.json')
  } catch {
    return path.join(process.cwd(), 'lumina-gamification.json')
  }
}

export function loadGamificationData(): GamificationPersistedData | null {
  try {
    const filePath = getGamificationDataPath()
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf-8')
      return JSON.parse(raw) as GamificationPersistedData
    }
  } catch (e: any) {
    console.warn('[Gamification] 加载持久化数据失败:', e.message)
  }
  return null
}

export function saveGamificationData(): void {
  try {
    const xpState = xpManager.getState()
    const achievementStats = achievementManager.getStats()
    const data: GamificationPersistedData = {
      totalXp: xpState.totalXp,
      todayXp: xpState.todayXp,
      lastResetDate: xpState.lastResetDate,
      unlockedAchievements: achievementStats.unlockedAchievements,
      userStats: {
        totalChats: achievementStats.totalChats,
        totalMessages: achievementStats.totalMessages,
        toolsUsed: achievementStats.toolsUsed,
        totalToolCalls: achievementStats.totalToolCalls,
        totalAffinity: achievementStats.totalAffinity,
        daysActive: achievementStats.daysActive,
        streakDays: achievementStats.streakDays,
        memoriesSaved: achievementStats.memoriesSaved,
        tasksCompleted: achievementStats.tasksCompleted,
        modeSwitches: achievementStats.modeSwitches,
        timeCapsulesBuried: achievementStats.timeCapsulesBuried,
      },
    }
    const filePath = getGamificationDataPath()
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
  } catch (e: any) {
    console.warn('[Gamification] 保存持久化数据失败:', e.message)
  }
}
