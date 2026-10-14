// ============================================================
// pet/petPreload.ts — 桌宠窗口受控 preload（安全加固 P1-4）
//
// 背景：桌宠窗口渲染的是 LLM 生成的内容（气泡、对话、插件脚本）。
// 旧配置 nodeIntegration:true + contextIsolation:false 等于"页面里
// 任何一段 JS 都能直接 require('child_process')"，LLM 输出一旦被
// 注入（插件、消息、网页内容）就是主机失陷。
//
// 本 preload 在 contextIsolation:true 下通过 contextBridge 暴露一个
// 最小、带白名单的桥：
//   - window.petAPI.ipc.on/off/send/invoke —— 仅放行四类前缀频道
//   - window.petAPI.openExternal(url)     —— 受控外链打开（主进程校验协议）
//   - window.electron.ipcRenderer        —— 兼容旧 bundle（pet-voice.js
//     运行时取 (typeof __require ...) || window.electron 的取值路径）
//
// 白名单前缀：pet: / onboarding: / gamification: / edge-tts:
// 越权频道一律忽略（on/send/off）或 reject（invoke），不向页面回传
// ipcRenderer 本体，也不暴露 require/fs/shell 等 Node 能力。
// ============================================================

import { contextBridge, ipcRenderer } from 'electron'

/** 桌宠页面允许使用的 IPC 频道前缀白名单 */
const ALLOWED_CHANNEL_PREFIXES = ['pet:', 'onboarding:', 'gamification:', 'edge-tts:']

function isAllowedChannel(channel: unknown): channel is string {
  return (
    typeof channel === 'string' &&
    ALLOWED_CHANNEL_PREFIXES.some((prefix) => channel.startsWith(prefix))
  )
}

type IpcListener = (event: unknown, ...args: unknown[]) => void
type WrappedListener = (event: unknown, ...args: unknown[]) => void

/**
 * on/off 函数身份映射：ipcRenderer.off 要求与 on 时同一个函数引用，
 * 而 contextBridge 透传进页面的回调无法被 ipcRenderer 直接识别，
 * 因此内部维护"页面回调 → 实际注册回调"的映射，off 时反查摘除。
 */
const listenerRegistry = new Map<string, Map<IpcListener, WrappedListener>>()

function registerListener(channel: string, listener: IpcListener): void {
  let channelMap = listenerRegistry.get(channel)
  if (!channelMap) {
    channelMap = new Map<IpcListener, WrappedListener>()
    listenerRegistry.set(channel, channelMap)
  }
  if (channelMap.has(listener)) {return}
  // 页面既有回调签名都是 (e, data) 且 e 从不使用（命名约定 _e）。
  // 这里回传 undefined 占位：IpcRendererEvent 不可结构化克隆，
  // 不能直接穿过 contextBridge 交给页面。
  const wrapper: WrappedListener = (_event, ...args) => listener(undefined, ...args)
  channelMap.set(listener, wrapper)
  ipcRenderer.on(channel, wrapper)
}

function removeRegisteredListener(channel: string, listener: IpcListener): void {
  const channelMap = listenerRegistry.get(channel)
  const wrapper = channelMap?.get(listener)
  if (wrapper) {
    ipcRenderer.removeListener(channel, wrapper)
    channelMap?.delete(listener)
  }
}

const petIpc = {
  on(channel: string, listener: IpcListener): void {
    if (!isAllowedChannel(channel) || typeof listener !== 'function') {return}
    registerListener(channel, listener)
  },

  off(channel: string, listener: IpcListener): void {
    if (!isAllowedChannel(channel) || typeof listener !== 'function') {return}
    removeRegisteredListener(channel, listener)
  },

  send(channel: string, ...args: unknown[]): void {
    if (!isAllowedChannel(channel)) {return}
    ipcRenderer.send(channel, ...args)
  },

  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    if (!isAllowedChannel(channel)) {
      return Promise.reject(new Error(`[petPreload] blocked channel: ${String(channel)}`))
    }
    return ipcRenderer.invoke(channel, ...args)
  },
}

const petAPI = {
  ipc: petIpc,
  /** 受控外链打开：主进程 'pet:open-external' 处理器只放行 http(s)/mailto */
  openExternal: (url: string): Promise<unknown> =>
    ipcRenderer.invoke('pet:open-external', String(url || '')),
}

// 旧 bundle 兼容层：pet-voice.js（assets/pet-voice.js）运行时取
// `(typeof __require === 'function' ? __require('electron') : window.electron) || {}`
// 的 .ipcRenderer。nodeIntegration 关闭后 require 不存在，全部走这里。
const electronCompat = { ipcRenderer: petIpc }

contextBridge.exposeInMainWorld('petAPI', petAPI)
contextBridge.exposeInMainWorld('electron', electronCompat)

export type PetAPI = typeof petAPI
