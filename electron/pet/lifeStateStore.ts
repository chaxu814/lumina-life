// ============================================================
// pet/lifeStateStore.ts — 内驱力 / 情绪持久化 (v0.1.1)
//
// 旧版 drives（内驱力）与 emotionFusion（连续情绪）都是模块级内存单例，
// 应用一重启就回出厂基线——于是「越处越懂你」「她记得今天累不累」立不住。
//
// 本模块把「生命状态」持久化到 userData/pet-life-state.json：
//   - 内驱力 energy/social/curiosity/comfort
//   - 连续情绪 valence/arousal/label
//   - 最近互动计数 / 上次更新时间
// 读取时还会按「离线时长」推进内驱力：冷落期间 social/curiosity 自然累积、
// 深夜精力恢复，于是重启后她会「想你」而不是失忆。
//
// 设计：纯 TS、Electron 不可用时（单测）退化为内存，绝不阻塞主链路。
// 写入做防抖，避免每次心跳都同步落盘。
// ============================================================

import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import { DEFAULT_DRIVES, tickDrives, type DriveState } from './life/drives'

export interface PersistedEmotion {
  v: number
  a: number
  label: string
}

export interface LifeState {
  drives: DriveState
  emotion: PersistedEmotion
  /** 累计互动次数（粗略的「相处时长」指标） */
  interactionCount: number
  /** ISO 时间戳 */
  updatedAt: string
}

export const LIFE_STATE_VERSION = 1
const FILE_NAME = 'pet-life-state.json'
/** 离线推进的分钟上限（避免关了一周一次性把状态拉满） */
const MAX_OFFLINE_MIN = 60 * 12 // 12 小时
const SAVE_DEBOUNCE_MS = 2000

function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0.5
}

function isElectronReady(): boolean {
  try {
    return !!app && typeof app.getPath === 'function' && !!app.getPath('userData')
  } catch {
    return false
  }
}

function statePath(): string | null {
  if (!isElectronReady()) {return null}
  return path.join(app.getPath('userData'), FILE_NAME)
}

function defaultState(): LifeState {
  return {
    drives: { ...DEFAULT_DRIVES },
    emotion: { v: 0.05, a: 0.4, label: '平静 😐' },
    interactionCount: 0,
    updatedAt: new Date().toISOString(),
  }
}

/** 单步合并/校验，防止脏数据或老版本字段 */
function normalize(raw: any): LifeState {
  const base = defaultState()
  if (!raw || typeof raw !== 'object') {return base}
  const d = raw.drives || {}
  const e = raw.emotion || {}
  return {
    drives: {
      energy: clamp01(d.energy ?? base.drives.energy),
      social: clamp01(d.social ?? base.drives.social),
      curiosity: clamp01(d.curiosity ?? base.drives.curiosity),
      comfort: clamp01(d.comfort ?? base.drives.comfort),
    },
    emotion: {
      v: Number.isFinite(e.v) ? Math.max(-1, Math.min(1, e.v)) : base.emotion.v,
      a: clamp01(e.a ?? base.emotion.a),
      label: typeof e.label === 'string' && e.label ? e.label : base.emotion.label,
    },
    interactionCount: Number.isFinite(raw.interactionCount) ? Math.max(0, Math.floor(raw.interactionCount)) : 0,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : base.updatedAt,
  }
}

/**
 * 计算「离线期间」的内驱力变化（纯函数，便于单测）：
 * 冷落期间 social/curiosity 上升；若跨过夜间则精力按睡眠恢复。
 */
export function applyOfflineGap(drives: DriveState, gapMin: number, now = new Date()): DriveState {
  const min = Math.max(0, Math.min(MAX_OFFLINE_MIN, gapMin))
  if (min <= 0) {return { ...drives }}
  const hour = now.getHours()
  // 深夜（23:00-06:00）按离线 = 睡眠处理，恢复精力；其余时段按清醒冷落处理
  const sleeping = hour >= 23 || hour < 6
  return tickDrives(drives, { dtMin: min, hourOfDay: hour, sleeping, hadInteraction: false })
}

let loaded = false
let cached: LifeState = defaultState()
let saveTimer: NodeJS.Timeout | null = null

/**
 * 读取上次生命状态（首次调用时从磁盘加载并按离线时长推进）。
 * Electron 不可用时返回内存默认值，不抛错。
 */
export function loadLifeState(): LifeState {
  if (loaded) {return cached}
  loaded = true
  try {
    const p = statePath()
    if (p && fs.existsSync(p)) {
      cached = normalize(JSON.parse(fs.readFileSync(p, 'utf8')))
      const gapMin = (Date.now() - new Date(cached.updatedAt).getTime()) / 60000
      if (Number.isFinite(gapMin) && gapMin > 0) {
        cached.drives = applyOfflineGap(cached.drives, gapMin)
      }
    }
  } catch (e) {
    console.warn('[LifeState] 读取 pet-life-state.json 失败，使用默认值:', e)
    cached = defaultState()
  }
  return cached
}

/** 防抖落盘（高频心跳安全调用） */
export function scheduleLifeStateSave(
  drives: DriveState,
  emotion: PersistedEmotion,
  interactionCount?: number,
): void {
  if (saveTimer) {clearTimeout(saveTimer)}
  cached = {
    drives: { ...drives },
    emotion: { ...emotion },
    interactionCount: interactionCount ?? cached.interactionCount,
    updatedAt: new Date().toISOString(),
  }
  if (!isElectronReady()) {return}
  saveTimer = setTimeout(() => {
    saveLifeStateNow()
  }, SAVE_DEBOUNCE_MS)
}

/** 立即落盘（应用退出 / before-quit 时调用，避免漏掉最后 2 秒） */
export function saveLifeStateNow(): void {
  try {
    const p = statePath()
    if (!p) {return}
    cached.updatedAt = new Date().toISOString()
    fs.writeFileSync(p, JSON.stringify({ version: LIFE_STATE_VERSION, ...cached }, null, 2), 'utf8')
  } catch (e) {
    console.warn('[LifeState] 写入 pet-life-state.json 失败:', e)
  }
}

/** 重置为出厂（设置页「清空相处记忆」可用） */
export function resetLifeState(): LifeState {
  cached = defaultState()
  loaded = true
  saveLifeStateNow()
  return cached
}

/** 测试辅助：重置内部缓存 */
export function __resetLifeStateForTest(): void {
  loaded = false
  cached = defaultState()
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
}
