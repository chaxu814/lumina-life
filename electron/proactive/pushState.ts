// ============================================================
// pushState.ts — AI 主动推送三维状态模型
// 疲劳度 / 亲密度 / Lumina 精力，含衰减恢复曲线与持久化
// ============================================================

import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'

export interface PushState {
  /** 用户疲劳度 0-1（越高越累，越不该打扰） */
  fatigue: number
  /** 用户与 Lumina 亲密度 0-1（越高越想主动说话） */
  intimacy: number
  /** Lumina 自身精力 0-1（推送消耗精力，随时间恢复） */
  luminaEnergy: number
  /** 最后一次用户活跃时间戳（ms） */
  lastActiveAt: number
  /** 最后一次推送时间戳（ms） */
  lastPushAt: number
  /** 今日已推送次数 */
  todayPushCount: number
  /** 今日日期（YYYY-MM-DD），用于重置计数 */
  todayDate: string
  /** 连续未响应次数（用户没回复推送的次数） */
  consecutiveIgnored: number
  /** 状态最后更新时间 */
  updatedAt: number
}

export interface PushSettings {
  enabled: boolean
  /** 每日推送上限 */
  maxPerDay: number
  /** 两次推送最小间隔（分钟） */
  cooldownMinutes: number
  /** 静默时段开始（HH:mm），如 "23:00" */
  quietHoursStart: string
  /** 静默时段结束（HH:mm），如 "08:00" */
  quietHoursEnd: string
  /** 允许的推送类型 */
  allowedTypes: Array<'greeting' | 'care' | 'share' | 'reminder' | 'chat'>
}

export const DEFAULT_PUSH_SETTINGS: PushSettings = {
  enabled: true,
  maxPerDay: 5,
  cooldownMinutes: 30,
  quietHoursStart: '23:00',
  quietHoursEnd: '08:00',
  allowedTypes: ['greeting', 'care', 'share', 'reminder', 'chat'],
}

const DEFAULT_STATE: PushState = {
  fatigue: 0.3,
  intimacy: 0.5,
  luminaEnergy: 0.8,
  lastActiveAt: Date.now(),
  lastPushAt: 0,
  todayPushCount: 0,
  todayDate: '',
  consecutiveIgnored: 0,
  updatedAt: Date.now(),
}

function stateFilePath(): string {
  const dir = path.join(app.getPath('userData'), 'proactive')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, 'push-state.json')
}

function settingsFilePath(): string {
  const dir = path.join(app.getPath('userData'), 'proactive')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, 'push-settings.json')
}

function todayStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function clamp(v: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, v))
}

/** 加载状态（不存在则返回默认） */
export function loadPushState(): PushState {
  try {
    const p = stateFilePath()
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf-8'))
      return { ...DEFAULT_STATE, ...raw }
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_STATE, todayDate: todayStr() }
}

/** 保存状态 */
export function savePushState(state: PushState): void {
  try {
    fs.writeFileSync(stateFilePath(), JSON.stringify(state, null, 2), 'utf-8')
  } catch { /* ignore */ }
}

/** 加载设置 */
export function loadPushSettings(): PushSettings {
  try {
    const p = settingsFilePath()
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf-8'))
      return { ...DEFAULT_PUSH_SETTINGS, ...raw }
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_PUSH_SETTINGS }
}

/** 保存设置 */
export function savePushSettings(settings: PushSettings): void {
  try {
    fs.writeFileSync(settingsFilePath(), JSON.stringify(settings, null, 2), 'utf-8')
  } catch { /* ignore */ }
}

/**
 * 根据时间流逝更新状态（衰减/恢复）
 * - fatigue：用户不活跃时缓慢恢复（休息），活跃时缓慢累积
 * - intimacy：缓慢自然衰减（不互动会变淡），互动后提升
 * - luminaEnergy：随时间线性恢复（每小时 +0.1），推送后消耗
 */
export function tickState(state: PushState, now = Date.now()): PushState {
  const elapsedH = (now - state.updatedAt) / (1000 * 60 * 60)
  if (elapsedH <= 0) return state

  const idleMin = (now - state.lastActiveAt) / (1000 * 60)

  // 疲劳度：空闲超过30分钟开始恢复，否则缓慢累积
  let fatigue = state.fatigue
  if (idleMin > 30) {
    fatigue = clamp(fatigue - 0.05 * elapsedH)
  } else {
    fatigue = clamp(fatigue + 0.02 * elapsedH)
  }
  // 深夜（23:00-06:00）疲劳度自然升高
  const hour = new Date(now).getHours()
  if (hour >= 23 || hour < 6) {
    fatigue = clamp(fatigue + 0.1 * elapsedH)
  }

  // 亲密度：每天自然衰减 0.02
  const intimacy = clamp(state.intimacy - 0.02 * elapsedH / 24)

  // Lumina 精力：每小时恢复 0.1
  const luminaEnergy = clamp(state.luminaEnergy + 0.1 * elapsedH)

  // 跨天重置推送计数
  const today = todayStr()
  const todayPushCount = state.todayDate === today ? state.todayPushCount : 0

  return {
    ...state,
    fatigue,
    intimacy,
    luminaEnergy,
    todayPushCount,
    todayDate: today,
    updatedAt: now,
  }
}

/** 记录用户活跃（聊天/操作） */
export function recordUserActivity(state: PushState, now = Date.now()): PushState {
  return {
    ...tickState(state, now),
    lastActiveAt: now,
    intimacy: clamp(state.intimacy + 0.01),
    consecutiveIgnored: 0,
  }
}

/** 记录一次推送发生 */
export function recordPush(state: PushState, now = Date.now()): PushState {
  return {
    ...tickState(state, now),
    lastPushAt: now,
    todayPushCount: state.todayPushCount + 1,
    luminaEnergy: clamp(state.luminaEnergy - 0.15),
  }
}

/** 记录用户未响应推送 */
export function recordIgnored(state: PushState): PushState {
  return {
    ...state,
    consecutiveIgnored: state.consecutiveIgnored + 1,
  }
}

/** 记录用户响应了推送 */
export function recordResponded(state: PushState): PushState {
  return {
    ...state,
    consecutiveIgnored: 0,
    intimacy: clamp(state.intimacy + 0.02),
  }
}
