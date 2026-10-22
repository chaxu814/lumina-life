// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// luckyModeIpc.ts — Lucky 模式 IPC 处理
//
// 提供前端与 luckyMode.ts 引擎的通信桥接
// 注册在 main.ts 中
// ============================================================

import { ipcMain } from 'electron'
import {
  loadLuckyConfig,
  saveLuckyConfig,
  loadLuckyState,
  saveLuckyState,
  createLuckyState,
  DEFAULT_LUCKY_CONFIG,
  type LuckyModeConfig,
  type LuckyModeState,
} from '../luckyMode'

// ── 运行时上下文（每个 Electron 进程只需要一份） ──

let _config: LuckyModeConfig = (() => {
  try { return loadLuckyConfig() } catch { return { ...DEFAULT_LUCKY_CONFIG } }
})()

let _state: LuckyModeState = (() => {
  try { return loadLuckyState() } catch { return createLuckyState() }
})()

/** 获取当前配置 */
export function getLuckyConfig(): LuckyModeConfig {
  return _config
}

/** 获取当前状态 */
export function getLuckyState(): LuckyModeState {
  return _state
}

/** 更新配置（同时持久化） */
export function setLuckyConfig(config: LuckyModeConfig): void {
  _config = config
  saveLuckyConfig(config)

  // 切换预设时重置状态
  if (config.preset === 'off') {
    _state = createLuckyState()
  } else {
    _state.activePreset = config.preset
    _state.currentIteration = 0
    _state.recentToolCalls = []
    _state.textOnlyCount = 0
    _state.isPaused = false
    _state.pauseReason = null
    _state.sessionStartedAt = Date.now()
  }
  saveLuckyState(_state)
}

/** 更新运行时状态 */
export function setLuckyState(partial: Partial<LuckyModeState>): void {
  _state = { ..._state, ...partial }
  saveLuckyState(_state)
}

// ── IPC 处理器注册 ──

export function registerLuckyModeIpc(): void {
  // 获取完整配置
  ipcMain.handle('lucky-mode:get-config', () => {
    return { ..._config }
  })

  // 保存完整配置
  ipcMain.handle('lucky-mode:save-config', (_event, config: LuckyModeConfig) => {
    setLuckyConfig(config)
    return { success: true }
  })

  // 获取运行时状态
  ipcMain.handle('lucky-mode:get-state', () => {
    return { ..._state, recentToolCalls: _state.recentToolCalls.slice(-20) }
  })

  // 更新预设
  ipcMain.handle('lucky-mode:set-preset', (_event, preset: string) => {
    const config = { ..._config, preset: preset as LuckyModeConfig['preset'] }
    setLuckyConfig(config)
    return { success: true }
  })

  // 重置状态
  ipcMain.handle('lucky-mode:reset-state', () => {
    _state = createLuckyState()
    saveLuckyState(_state)
    return { success: true }
  })

  // 暂停
  ipcMain.handle('lucky-mode:pause', (_event, reason: string) => {
    setLuckyState({
      isPaused: true,
      pauseReason: reason || '用户暂停',
    })
    return { success: true }
  })

  // 继续
  ipcMain.handle('lucky-mode:resume', () => {
    setLuckyState({
      isPaused: false,
      pauseReason: null,
    })
    return { success: true }
  })

  // 递增迭代计数
  ipcMain.handle('lucky-mode:increment-iteration', () => {
    setLuckyState({
      currentIteration: _state.currentIteration + 1,
    })
    return { success: true }
  })
}
