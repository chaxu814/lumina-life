// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// trayMenuPreload.ts — 托盘浮层菜单的预加载脚本
//
// 通过 contextBridge 暴露最小 API 给 trayMenu.html：
//   - trayMenuAPI.getState()        拉取最新状态
//   - trayMenuAPI.onState(cb)       订阅主进程推送的状态
//   - trayMenuAPI.menuClick(action) 触发菜单项
//
// contextIsolation: true / nodeIntegration: false / sandbox: true
// ============================================================
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('trayMenuAPI', {
  /** 主动拉取一次状态（invoke） */
  getState: () => ipcRenderer.invoke('trayMenu:get-state'),

  /** 订阅主进程推送的状态更新 */
  onState: (cb: (state: unknown) => void) => {
    ipcRenderer.on('trayMenu:state', (_e, state) => cb(state))
  },

  /** 触发菜单项动作 */
  menuClick: (action: string) => ipcRenderer.send('trayMenu:menu-click', action),
})
