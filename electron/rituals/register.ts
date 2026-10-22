// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// rituals/register.ts — registerRituals() 统一注册入口
//
// 集成阶段（main.ts）只需调一次：registerRituals()
// 它会：
//   1. 装载生产依赖（LLM / TTS / 气泡 / 桌宠动作 / 预算守卫，全懒加载）
//   2. 启动 30s 轮询调度器（命中配置时间即触发，开关/时间热生效）
//   3. 注册 IPC：rituals:runNight / rituals:runMorning /
//      rituals:getStatus / rituals:setConfig
//
// 不改任何现有共享文件——所有接线集中在这里。
// ============================================================

import { isEnabled, setFlag, type FeatureKey } from '../core/featureFlags'
import { createFilePersistence, type RitualPersistence } from './persistence'
import { RitualScheduler } from './scheduler'
import { runNightReview } from './nightReview'
import { runMorningBriefing } from './morningBrief'
import { productionDeps, productionMorningSources } from './productionAdapter'
import type { RitualConfig, RitualDeps, RitualRunRecord, RitualState, RitualStatus } from './types'

/** 本功能占用的 feature flag 键（未在 featureFlags.ts 注册，默认 falsy=关） */
export const RITUAL_FLAG_NIGHT = 'rituals.nightReview' as FeatureKey
export const RITUAL_FLAG_MORNING = 'rituals.morningBriefing' as FeatureKey

export interface RegisterOptions {
  /** 覆盖生产依赖（测试/集成注入） */
  deps?: RitualDeps
  /** 覆盖持久化（测试注入内存实现） */
  persistence?: RitualPersistence
  /** 覆盖晨间素材源（测试注入） */
  morningSources?: ReturnType<typeof productionMorningSources>
  /** 轮询间隔（默认 30s；测试传 0 则不启动定时器） */
  tickIntervalMs?: number
}

export interface RitualsHandle {
  runNight: (manual?: boolean) => Promise<RitualRunRecord>
  runMorning: (manual?: boolean) => Promise<RitualRunRecord>
  getStatus: () => RitualStatus
  setConfig: (patch: Partial<RitualConfig> & { nightEnabled?: boolean; morningEnabled?: boolean }) => void
  /** 停掉轮询定时器（测试/退出用） */
  stop: () => void
}

function appendHistory(state: RitualState, rec: RitualRunRecord): void {
  state.history = [rec, ...(state.history || [])].slice(0, 30)
  if (rec.kind === 'night') {state.night = rec} else {state.morning = rec}
}

export function registerRituals(opts: RegisterOptions = {}): RitualsHandle {
  const deps = opts.deps || productionDeps()
  const persistence = opts.persistence || createFilePersistence()
  const morningSources = opts.morningSources || productionMorningSources()

  const runNight = async (manual = false): Promise<RitualRunRecord> => {
    const rec = await runNightReview(deps, { manual })
    const state = persistence.loadState()
    appendHistory(state as any, rec)
    persistence.saveState(state)
    return rec
  }

  const runMorning = async (manual = false): Promise<RitualRunRecord> => {
    const rec = await runMorningBriefing(deps, { manual, sources: morningSources })
    const state = persistence.loadState()
    appendHistory(state as any, rec)
    persistence.saveState(state)
    return rec
  }

  const getStatus = (): RitualStatus => {
    const config = persistence.loadConfig()
    const state = persistence.loadState()
    return {
      config,
      nightEnabled: isEnabled(RITUAL_FLAG_NIGHT),
      morningEnabled: isEnabled(RITUAL_FLAG_MORNING),
      night: state.night,
      morning: state.morning,
      history: state.history || [],
    }
  }

  const setConfig = (patch: Partial<RitualConfig> & { nightEnabled?: boolean; morningEnabled?: boolean }): void => {
    const config = persistence.loadConfig()
    if (typeof patch.nightTime === 'string') {config.nightTime = patch.nightTime}
    if (typeof patch.morningTime === 'string') {config.morningTime = patch.morningTime}
    persistence.saveConfig(config)
    if (typeof patch.nightEnabled === 'boolean') {setFlag(RITUAL_FLAG_NIGHT, patch.nightEnabled)}
    if (typeof patch.morningEnabled === 'boolean') {setFlag(RITUAL_FLAG_MORNING, patch.morningEnabled)}
  }

  // ── 调度器：每次 tick 现场读开关/时间（热生效） ──────────
  const scheduler = new RitualScheduler({
    isNightEnabled: () => isEnabled(RITUAL_FLAG_NIGHT),
    isMorningEnabled: () => isEnabled(RITUAL_FLAG_MORNING),
    nightTime: () => persistence.loadConfig().nightTime,
    morningTime: () => persistence.loadConfig().morningTime,
    fire: (kind) => {
      void (kind === 'night' ? runNight(false) : runMorning(false)).catch((e) => {
        console.error('[Rituals] 定时触发失败:', e)
      })
    },
  })

  let timer: ReturnType<typeof setInterval> | null = null
  const interval = opts.tickIntervalMs ?? 30_000
  if (interval > 0) {
    timer = setInterval(() => {
      try {scheduler.tick(Date.now())} catch (e) {console.error('[Rituals] tick 异常:', e)}
    }, interval)
    if (typeof timer.unref === 'function') {timer.unref()}
  }

  // ── IPC 通道（懒加载 electron；非 Electron 环境静默跳过） ──
  try {
    const { ipcMain } = require('electron')
    if (ipcMain) {
      ipcMain.handle('rituals:runNight', () => runNight(true))
      ipcMain.handle('rituals:runMorning', () => runMorning(true))
      ipcMain.handle('rituals:getStatus', () => getStatus())
      ipcMain.handle('rituals:setConfig', (_e: unknown, patch: Parameters<RitualsHandle['setConfig']>[0]) => setConfig(patch))
    }
  } catch {
    /* 测试环境无 electron：IPC 不注册，函数句柄仍可用 */
  }

  return {
    runNight,
    runMorning,
    getStatus,
    setConfig,
    stop: () => {if (timer) {clearInterval(timer); timer = null}},
  }
}
