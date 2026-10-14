// ============================================================
// rituals/persistence.ts — 仪式配置与运行记录的 JSON 持久化
//
// 开关走 feature flags（feature-flags.json，由 core/featureFlags.ts 管），
// 这里只存：时间配置（rituals-config.json）+ 运行状态（rituals-state.json）。
// 路径解析与 dreamEngine 同模式：优先 Electron userData，测试环境退化到 data/。
// ============================================================

import * as fs from 'fs'
import * as path from 'path'
import {
  DEFAULT_RITUAL_CONFIG,
  type RitualConfig,
  type RitualState,
} from './types'

/** 持久化接口（测试可注入内存实现） */
export interface RitualPersistence {
  loadConfig(): RitualConfig
  saveConfig(c: RitualConfig): void
  loadState(): RitualState
  saveState(s: RitualState): void
}

function dataDir(): string {
  let dir: string
  try {
    const { app } = require('electron')
    if (app && typeof app.getPath === 'function' && app.getPath('userData')) {
      dir = app.getPath('userData')
    } else {
      throw new Error('no-userdata')
    }
  } catch {
    const baseDir = process.env.QWENPAW_WORKING_DIR || process.env.COPAW_WORKING_DIR || ''
    dir = baseDir ? path.join(baseDir, 'data') : path.join(__dirname, '..', '..', 'data')
  }
  if (!fs.existsSync(dir)) {fs.mkdirSync(dir, { recursive: true })}
  return dir
}

function readJsonSafe<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) {return fallback}
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T
  } catch {
    return fallback
  }
}

function writeJsonSafe(file: string, value: unknown): void {
  try {
    fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf-8')
  } catch (e) {
    console.error('[Rituals] 写入失败:', file, e)
  }
}

/** 文件系统持久化（默认实现） */
export function createFilePersistence(dir?: string): RitualPersistence {
  const base = dir || dataDir()
  const configFile = path.join(base, 'rituals-config.json')
  const stateFile = path.join(base, 'rituals-state.json')

  return {
    loadConfig(): RitualConfig {
      const raw = readJsonSafe<Partial<RitualConfig>>(configFile, {})
      return {
        nightTime: typeof raw.nightTime === 'string' && /^\d{2}:\d{2}$/.test(raw.nightTime) ? raw.nightTime : DEFAULT_RITUAL_CONFIG.nightTime,
        morningTime: typeof raw.morningTime === 'string' && /^\d{2}:\d{2}$/.test(raw.morningTime) ? raw.morningTime : DEFAULT_RITUAL_CONFIG.morningTime,
      }
    },
    saveConfig(c: RitualConfig): void {
      writeJsonSafe(configFile, c)
    },
    loadState(): RitualState {
      return readJsonSafe<RitualState>(stateFile, { history: [] })
    },
    saveState(s: RitualState): void {
      writeJsonSafe(stateFile, s)
    },
  }
}

/** 内存持久化（测试用） */
export function createMemoryPersistence(): RitualPersistence {
  let config: RitualConfig = { ...DEFAULT_RITUAL_CONFIG }
  let state: RitualState = { history: [] }
  return {
    loadConfig: () => ({ ...config }),
    saveConfig: (c) => {config = { ...c }},
    loadState: () => ({ ...state, history: [...(state.history || [])] }),
    saveState: (s) => {state = { ...s, history: [...(s.history || [])] }},
  }
}
