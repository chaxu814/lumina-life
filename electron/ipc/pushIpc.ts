// ============================================================
// pushIpc.ts — 主动推送 IPC 处理器
// ============================================================

import { ipcMain } from 'electron'
import { getPushScheduler } from '../proactive/pushScheduler'
import { loadPushSettings, savePushSettings, type PushSettings } from '../proactive/pushState'

export function registerPushIpc(): void {
  ipcMain.handle('proactive:get-state', () => {
    const scheduler = getPushScheduler()
    return scheduler.getState()
  })

  ipcMain.handle('proactive:get-settings', () => {
    return loadPushSettings()
  })

  ipcMain.handle('proactive:update-settings', (_e, settings: Partial<PushSettings>) => {
    const current = loadPushSettings()
    const merged = { ...current, ...settings }
    savePushSettings(merged)
    const scheduler = getPushScheduler()
    scheduler.updateSettings(settings)
    return merged
  })

  ipcMain.handle('proactive:push-now', () => {
    const scheduler = getPushScheduler()
    return scheduler.triggerNow()
  })

  ipcMain.handle('proactive:toggle', (_e, enabled: boolean) => {
    const scheduler = getPushScheduler()
    scheduler.updateSettings({ enabled })
    if (enabled) {scheduler.start()}
    else {scheduler.stop()}
    return { enabled }
  })

  ipcMain.handle('proactive:user-activity', () => {
    const scheduler = getPushScheduler()
    scheduler.notifyUserActivity()
    return { ok: true }
  })
}
