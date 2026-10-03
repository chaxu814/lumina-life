// ============================================================
// usageStats.ts — 使用数据分析引擎 (v1.0)
//
// 本地记录用户使用数据：
//   1. 模式切换历史（每次切模式的时间 + 触发方式）
//   2. Agent 对话量（每日消息数）
//   3. Proactive 推送统计（触发次数、用户回应率）
//   4. 场景检测分布（各模式占比）
//
// 数据存储在 <userData>/usage-stats.json，不自动上传。
// 前端可通过 IPC 读取统计摘要，展示在"使用统计"面板。
// ============================================================

import { app } from 'electron'
import { stateFilePath } from './core/pathsFallback'
import * as path from 'path'
import * as fs from 'fs'
import { ipcMain } from 'electron'

// ═══════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════

export type LuminaMode = 'work' | 'study' | 'fun' | 'idle'

export interface ModeSwitchRecord {
  timestamp: number
  from: string
  to: string
  trigger: 'manual' | 'auto' | 'recover'
}

export interface ProactiveRecord {
  timestamp: number
  triggerId: string
  message: string
  userReplied: boolean
  dismissed: boolean
}

export interface DailyStats {
  date: string            // "2026-07-16"
  /** 各模式累计时长 (分钟) */
  modeDuration: Record<string, number>
  /** 模式切换次数 */
  modeSwitches: number
  /** 主动推送次数 */
  proactiveCount: number
  /** 用户回复次数 */
  userReplyCount: number
  /** 对话消息数 */
  messageCount: number
  /** 最近活跃时间戳 */
  lastActiveAt: number
}

export interface UsageStatsData {
  /** 按日期索引的每日统计 */
  dailyStats: Record<string, DailyStats>
  /** 模式切换流水 (最多保留 500 条) */
  recentSwitches: ModeSwitchRecord[]
  /** 主动推送流水 (最多保留 200 条) */
  recentProactive: ProactiveRecord[]
  /** 上次保存时间戳 */
  lastSavedAt: number
}

// ═══════════════════════════════════════════════════════════
// UsageStats 引擎
// ═══════════════════════════════════════════════════════════

class UsageStats {
  private data: UsageStatsData
  private filePath: string
  private saveTimer: ReturnType<typeof setInterval> | null = null
  /** 当前模式计时 */
  private currentMode: string = 'work'
  private currentModeSince: number = Date.now()

  constructor() {
    this.filePath = this.getFilePath()
    this.data = this.load()
    this.currentMode = this.getTodayStats().modeDuration 
      ? Object.keys(this.getTodayStats().modeDuration).pop() || 'work'
      : 'work'
  }

  private getFilePath(): string {
    try {
      return path.join(app.getPath('userData'), 'usage-stats.json')
    } catch {
      // ⚠️ 不要退回 process.cwd()：开发态 cwd 就是项目根，会把状态写进 Git 工作区
    return stateFilePath('usage-stats.json')
    }
  }

  private load(): UsageStatsData {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8')
        return JSON.parse(raw)
      }
    } catch (e: any) {
      console.warn('[UsageStats] 加载失败，重置:', e.message)
    }
    return this.defaultData()
  }

  private defaultData(): UsageStatsData {
    return {
      dailyStats: {},
      recentSwitches: [],
      recentProactive: [],
      lastSavedAt: Date.now(),
    }
  }

  private save(): void {
    this.data.lastSavedAt = Date.now()
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8')
    } catch (e: any) {
      console.warn('[UsageStats] 保存失败:', e.message)
    }
  }

  /** 获取今日统计对象（不存在则自动创建） */
  private getTodayStats(): DailyStats {
    const today = new Date()
    const dateKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    if (!this.data.dailyStats[dateKey]) {
      this.data.dailyStats[dateKey] = {
        date: dateKey,
        modeDuration: {},
        modeSwitches: 0,
        proactiveCount: 0,
        userReplyCount: 0,
        messageCount: 0,
        lastActiveAt: Date.now(),
      }
    }
    return this.data.dailyStats[dateKey]
  }

  // ── 公开 API ──

  /** 启动自动保存（每 60s） */
  start(): void {
    if (this.saveTimer) {return}
    // 每 60 秒保存一次，同时结算当前模式时长
    this.saveTimer = setInterval(() => {
      this.flushModeDuration()
      this.save()
    }, 60_000)
    console.log('[UsageStats] 📊 使用数据统计已启动')
  }

  /** 停止 */
  stop(): void {
    if (this.saveTimer) {
      clearInterval(this.saveTimer)
      this.saveTimer = null
    }
    this.flushModeDuration()
    this.save()
  }

  /** 销毁前结算 */
  flushModeDuration(): void {
    const now = Date.now()
    const elapsedMin = (now - this.currentModeSince) / 60000
    if (elapsedMin < 0.1) {return} // 不足 6 秒不计

    const stats = this.getTodayStats()
    stats.modeDuration[this.currentMode] = (stats.modeDuration[this.currentMode] || 0) + elapsedMin
    this.currentModeSince = now
    stats.lastActiveAt = now
  }

  /** 模式切换记录 */
  recordModeSwitch(from: string, to: string, trigger: 'manual' | 'auto' | 'recover'): void {
    // 先结算前一个模式时长
    this.flushModeDuration()

    const record: ModeSwitchRecord = {
      timestamp: Date.now(),
      from,
      to,
      trigger,
    }
    this.data.recentSwitches.unshift(record)
    // 最多 500 条
    if (this.data.recentSwitches.length > 500) {
      this.data.recentSwitches = this.data.recentSwitches.slice(0, 500)
    }

    // 更新今日统计
    const stats = this.getTodayStats()
    stats.modeSwitches++
    stats.lastActiveAt = Date.now()

    // 切换到新模式
    this.currentMode = to
    this.currentModeSince = Date.now()

    console.log(`[UsageStats] 模式切换记录: ${from} → ${to} (${trigger})`)
  }

  /** 主动推送记录 */
  recordProactive(triggerId: string, message: string): void {
    const record: ProactiveRecord = {
      timestamp: Date.now(),
      triggerId,
      message: message.slice(0, 100),
      userReplied: false,
      dismissed: false,
    }
    this.data.recentProactive.unshift(record)
    if (this.data.recentProactive.length > 200) {
      this.data.recentProactive = this.data.recentProactive.slice(0, 200)
    }
    const stats = this.getTodayStats()
    stats.proactiveCount++
  }

  /** 用户回复了某条推送 */
  markProactiveReplied(triggerId: string): void {
    const found = this.data.recentProactive.find(
      r => r.triggerId === triggerId && !r.userReplied
    )
    if (found) {
      found.userReplied = true
      const stats = this.getTodayStats()
      stats.userReplyCount++
    }
  }

  /** 记录对话消息 */
  recordMessage(): void {
    const stats = this.getTodayStats()
    stats.messageCount++
    stats.lastActiveAt = Date.now()
  }

  /** 记录用户活跃 */
  recordActive(): void {
    const stats = this.getTodayStats()
    stats.lastActiveAt = Date.now()
  }

  // ── 查询 API ──

  /** 获取今日统计摘要 */
  getTodaySummary(): DailyStats & { proactiveReplyRate: number; modeDistribution: Array<{ mode: string; minutes: number; percent: number }> } {
    const stats = this.getTodayStats()
    // 结算当前模式
    this.flushModeDuration()
    const totalMinutes = Object.values(stats.modeDuration).reduce((a, b) => a + b, 0) || 1
    const modeDistribution = Object.entries(stats.modeDuration)
      .map(([mode, minutes]) => ({
        mode,
        minutes: Math.round(minutes * 10) / 10,
        percent: Math.round((minutes / totalMinutes) * 100),
      }))
      .sort((a, b) => b.minutes - a.minutes)

    return {
      ...stats,
      proactiveReplyRate: stats.proactiveCount > 0
        ? Math.round((stats.userReplyCount / stats.proactiveCount) * 100)
        : 0,
      modeDistribution,
    }
  }

  /** 获取近 N 天统计 */
  getRecentDays(days: number): Array<DailyStats & { proactiveReplyRate: number; modeDistribution: Array<{ mode: string; minutes: number; percent: number }> }> {
    const result: Array<any> = []
    const now = new Date()
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now)
      d.setDate(d.getDate() - i)
      const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      const stats = this.data.dailyStats[dateKey]
      if (stats) {
        const totalMinutes = Object.values(stats.modeDuration).reduce((a: number, b: number) => a + b, 0) || 1
        result.push({
          ...stats,
          proactiveReplyRate: stats.proactiveCount > 0
            ? Math.round((stats.userReplyCount / stats.proactiveCount) * 100)
            : 0,
          modeDistribution: Object.entries(stats.modeDuration)
            .map(([mode, minutes]: [string, number]) => ({
              mode,
              minutes: Math.round(minutes * 10) / 10,
              percent: Math.round((minutes / totalMinutes) * 100),
            }))
            .sort((a: any, b: any) => b.minutes - a.minutes),
        })
      } else {
        result.push(null)
      }
    }
    return result
  }

  /** 获取最近模式切换流水 */
  getRecentSwitches(limit: number = 20): ModeSwitchRecord[] {
    return this.data.recentSwitches.slice(0, limit)
  }

  /** 获取最近推送流水 */
  getRecentProactive(limit: number = 20): ProactiveRecord[] {
    return this.data.recentProactive.slice(0, limit)
  }

  /** 获取全量原始数据（用于调试） */
  getAllData(): UsageStatsData {
    return this.data
  }

  /** 重置所有数据 */
  resetAll(): void {
    this.data = this.defaultData()
    this.currentMode = 'work'
    this.currentModeSince = Date.now()
    this.save()
  }

  /** 获取当前累计模式时长分布 */
  getAllModeDurationDistribution(): Array<{ mode: string; totalMinutes: number }> {
    const totals: Record<string, number> = {}
    for (const day of Object.values(this.data.dailyStats)) {
      for (const [mode, minutes] of Object.entries(day.modeDuration)) {
        totals[mode] = (totals[mode] || 0) + minutes
      }
    }
    return Object.entries(totals)
      .map(([mode, minutes]) => ({ mode, totalMinutes: Math.round(minutes * 10) / 10 }))
      .sort((a, b) => b.totalMinutes - a.totalMinutes)
  }
}

// ── 单例 ──

let instance: UsageStats | null = null

export function getUsageStats(): UsageStats {
  if (!instance) {
    instance = new UsageStats()
  }
  return instance
}

export function initUsageStats(): UsageStats {
  const stats = getUsageStats()
  stats.start()
  return stats
}

/** 📊 v3.0: 注册使用统计数据 IPC 处理器（匹配 preload 通道名） */
export function registerUsageStatsIpc(): void {
  ipcMain.handle('usage:today', () => {
    try {
      return { ok: true, data: getUsageStats().getTodaySummary() }
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
  })
  ipcMain.handle('usage:recent-days', (_e: any, days: number) => {
    try {
      return { ok: true, data: getUsageStats().getRecentDays(days || 7) }
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
  })
  ipcMain.handle('usage:recent-switches', (_e: any, limit: number) => {
    try {
      return { ok: true, data: getUsageStats().getRecentSwitches(limit || 20) }
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
  })
  ipcMain.handle('usage:recent-proactive', (_e: any, limit: number) => {
    try {
      return { ok: true, data: getUsageStats().getRecentProactive(limit || 20) }
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
  })
  ipcMain.handle('usage:mode-distribution', () => {
    try {
      return { ok: true, data: getUsageStats().getAllModeDurationDistribution() }
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
  })
  ipcMain.handle('usage:all-data', () => {
    try {
      return { ok: true, data: getUsageStats().getAllData() }
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
  })
  ipcMain.handle('usage:reset', () => {
    try {
      getUsageStats().resetAll()
      return { ok: true }
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
  })
  console.log('[UsageStats] 📊 IPC 处理器已注册')
}
