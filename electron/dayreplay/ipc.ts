// ============================================================
// dayreplay/ipc.ts — Day Replay 的 IPC 频道注册
//
// 频道（全部 dayreplay: 前缀）：
//   dayreplay:today                         → { ok, replay: DailyReplay }
//   dayreplay:get        (date?: string)    → { ok, replay } 或 { ok:false, error, code }
//   dayreplay:export     ({date?, format})  → { ok, path, content }（format: 'markdown' | 'text'）
//
// 【preload.ts 需要补的白名单（本功能不改 preload，由集成阶段加）】
//   dayreplayToday:           () => ipcRenderer.invoke('dayreplay:today')
//   dayreplayGet:             (date?: string) => ipcRenderer.invoke('dayreplay:get', date)
//   dayreplayExport:          (opts?: { date?: string; format?: 'markdown' | 'text' }) =>
//                               ipcRenderer.invoke('dayreplay:export', opts)
//
// 【feature flag】
//   dayreplay.enabled（未注册键 = 默认关，实验功能）。关闭时全部频道返回
//   { ok:false, error }，面板显示「未启用」而不是白屏。
//
// 【幂等】registerDayReplayIpc 可重复调用：已注册的频道直接跳过，
// 不会重复 ipcMain.handle（Electron 对重复注册会抛错）。
// ============================================================

import { getDayReplay, DayReplayError } from './dayReplay'
import type { DayReplayService } from './dayReplay'
import { isEnabled } from '../core/featureFlags'

/** 最小 ipcMain 形状（测试注入 fake；生产用 electron.ipcMain） */
export interface IpcBus {
  handle(channel: string, handler: (event: unknown, ...args: any[]) => unknown): void
}

const ALL_CHANNELS = ['dayreplay:today', 'dayreplay:get', 'dayreplay:export']
/** 已在 target 上 handle 过的频道（跨重复调用去重） */
const handledChannels = new Set<string>()

function getDefaultBus(): IpcBus | null {
  try {
    const electron = require('electron')
    return electron?.ipcMain ?? null
  } catch {
    return null // 测试环境没有 electron
  }
}

/** 实验功能默认关；运行时未注册的键按 false 处理。
 *  统一读 featureFlags 体系（与设置面板「实验功能」开关同构，开关写 setFlag 后立即生效）。 */
function dayreplayEnabled(): boolean {
  try {
    return isEnabled('dayreplay.enabled')
  } catch {
    return false
  }
}

function disabledReply() {
  return { ok: false as const, error: 'Day Replay 实验功能未开启（feature flag: dayreplay.enabled）' }
}

export function registerDayReplayIpc(bus?: IpcBus): void {
  const target = bus ?? getDefaultBus()
  if (!target) {return}

  for (const channel of ALL_CHANNELS) {
    // 幂等：重复注册直接跳过（Electron 对同一频道二次 handle 会抛错）
    if (handledChannels.has(channel)) {continue}
    target.handle(channel, (event: unknown, ...args: any[]) => handle(channel, args))
    handledChannels.add(channel)
  }
}

function handle(channel: string, args: any[]): unknown {
  if (!dayreplayEnabled()) {return disabledReply()}
  try {
    const svc: DayReplayService = getDayReplay()
    if (channel === 'dayreplay:today') {
      return { ok: true as const, replay: svc.buildDailyReplay() }
    }
    if (channel === 'dayreplay:get') {
      const date = typeof args[0] === 'string' ? args[0] : undefined
      return { ok: true as const, replay: svc.buildDailyReplay(date) }
    }
    // dayreplay:export
    const opts = (args[0] ?? {}) as { date?: string; format?: string }
    const date = typeof opts.date === 'string' ? opts.date : undefined
    const format = opts.format === 'text' ? 'text' : 'markdown'
    const replay = svc.buildDailyReplay(date)
    const content = format === 'text'
      ? svc.renderReplayText(replay)
      : svc.renderReplayMarkdown(replay)

    const fs = require('fs')
    const path = require('path')
    const os = require('os')
    const dir = path.join(
      process.env.LUMINA_DATA_DIR || path.join(os.homedir(), '.lumina'),
      'dayreplay-exports',
    )
    fs.mkdirSync(dir, { recursive: true })
    const ext = format === 'text' ? 'txt' : 'md'
    const filePath = path.join(dir, `dayreplay-${replay.date}.${ext}`)
    fs.writeFileSync(filePath, content, 'utf8')
    return { ok: true as const, path: filePath, content, items: replay.items.length }
  } catch (err) {
    if (err instanceof DayReplayError) {
      return { ok: false as const, code: err.code, error: err.message }
    }
    return { ok: false as const, error: String((err as Error)?.message || err) }
  }
}
