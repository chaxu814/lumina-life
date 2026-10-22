// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// browser/browserPreload.ts — 内置浏览器窗口（工具栏宿主页）的预加载
//
// 只暴露工具栏页自己需要的最小能力：
//   - 报告 webview 状态（地址/标题/前进后退/加载中/缩放）给主进程缓存
//   - 需要主进程代办的少数几件事：在外部打开 / 清缓存 / 关窗口
//
// 导航、后退、刷新、缩放这些**不经过 preload**：宿主页页面里直接调
// window.__b.* 操作 <webview>，少一次 IPC 往返，也避免"主进程操作了窗口
// 而不是网页本体"这类搞反的错误（早前就是这么坏的）。
// ============================================================

import { contextBridge, ipcRenderer } from 'electron'

export interface BrowserStatePayload {
  url?: string
  title?: string
  canBack?: boolean
  canForward?: boolean
  loading?: boolean
  zoom?: number
}

const api = {
  /** 把 webview 的当前状态上报给主进程（主进程缓存后广播，Agent 也读这份） */
  reportState: (state: BrowserStatePayload) => ipcRenderer.send('browser:state-changed', state),
  /** 主动拉一次当前状态 */
  getState: () => ipcRenderer.invoke('browser:state'),
  /** 主进程把状态推回来（Agent 导航后用户地址栏要跟着变） */
  onState: (cb: (s: any) => void) => {
    const handler = (_e: any, s: any) => cb(s)
    ipcRenderer.on('browser:state', handler)
    return () => { ipcRenderer.removeListener('browser:state', handler) }
  },
  openExternal: (url: string) => ipcRenderer.invoke('browser:open-external', url),
  clearData: () => ipcRenderer.invoke('browser:clear-data'),
  close: () => ipcRenderer.invoke('browser:close'),
}

contextBridge.exposeInMainWorld('browserAPI', api)

export type BrowserAPI = typeof api
