// ============================================================
// proactiveNotifier.ts — ProactiveEngine → Renderer 通知桥接 (v3.8.1)
//
// 将 ProactiveEngine 的触发事件桥接到:
//   1. Windows 系统通知 (已有，见 proactiveEngine.deliverProactive)
//   2. Lumina 内置 UI 弹窗 (右上角 ProactiveToast)
//   3. 聊天面板内联消息 (BusEvents)
//
// 使用方式: 在 main.ts 中调用 initProactiveNotifier()
// ============================================================

import { globalEventBus, BusEvents } from './eventBus'
import { ipcMain, BrowserWindow } from 'electron'

let _initialized = false

/**
 * 初始化通知桥接 — 监听 PROACTIVE_MESSAGE 事件并转发到渲染进程
 */
export function initProactiveNotifier(): void {
  if (_initialized) {return}
  _initialized = true

  globalEventBus.on(BusEvents.PROACTIVE_MESSAGE, (payload: {
    triggerId: string
    message: string
    type: string
  }) => {
    // 向所有渲染进程广播
    const windows = BrowserWindow.getAllWindows()
    for (const win of windows) {
      if (!win.isDestroyed()) {
        win.webContents.send('proactive:popup', {
          id: payload.triggerId,
          message: payload.message,
          type: payload.type,
          timestamp: Date.now(),
        })
      }
    }
  })

  console.log('[ProactiveNotifier] ✅ 桥接已初始化 — 主动消息 → 渲染进程')
}

/**
 * 注册 IPC handler — 供渲染进程查询最近的主动消息
 */
export function registerProactiveIPC(): void {
  ipcMain.handle('proactive:getHistory', () => {
    // history 在 proactiveEngine 中维护
    // 这里返回空数组，实际使用时从 engine 获取
    return []
  })

  ipcMain.handle('proactive:getConfig', () => {
    try {
      const { getProactiveEngine } = require('./proactiveEngine')
      const engine = getProactiveEngine()
      return engine?.getConfig() || null
    } catch {
      return null
    }
  })
}
