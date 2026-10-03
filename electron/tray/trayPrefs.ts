// ============================================================
// tray/trayPrefs.ts — 托盘菜单运行时开关的持久化
//
// 背景：
//   游戏陪伴总开关原本只改 process.env，重启即丢；托盘上的开关
//   还必须能覆盖 .env 里的默认值。这里把「用户在 UI 上拨过的状态」
//   单独存一份，启动时以它覆盖环境变量。
//
// 文件：<appData>/tray-prefs.json
//   { "gameEnabled": true }
//
// 读写全部 try/catch 包裹：持久化失败绝不能影响主流程。
// ============================================================

import path from 'path'
import { appDataDir } from '../paths'

interface TrayPrefs {
  gameEnabled?: boolean
}

function prefsPath(): string {
  return path.join(appDataDir(), 'tray-prefs.json')
}

function readPrefs(): TrayPrefs {
  try {
     
    const fs = require('fs') as typeof import('fs')
    const raw = fs.readFileSync(prefsPath(), 'utf-8')
    const parsed = JSON.parse(raw)
    return (parsed && typeof parsed === 'object') ? (parsed as TrayPrefs) : {}
  } catch {
    return {}
  }
}

function writePrefs(prefs: TrayPrefs): void {
  try {
     
    const fs = require('fs') as typeof import('fs')
    fs.mkdirSync(appDataDir(), { recursive: true })
    fs.writeFileSync(prefsPath(), JSON.stringify(prefs, null, 2), 'utf-8')
  } catch {
    /* 写失败忽略：下次启动回落到 .env 默认值 */
  }
}

/**
 * 启动时把持久化的游戏开关应用到 process.env。
 *
 * 必须在任何 loadGameConfig() 被调用之前执行（game 模块每次调用都现读
 * process.env，所以这里改完立即生效，不需要重启）。
 */
export function applyGameEnabledOverride(env: NodeJS.ProcessEnv = process.env): boolean {
  const saved = readPrefs().gameEnabled
  if (typeof saved !== 'boolean') { return false }
  env.LUMINA_GAME_ENABLED = saved ? 'true' : 'false'
  return saved
}

/** 记录游戏开关并同步到 env，返回切换后的布尔值。 */
export function persistGameEnabled(next: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  env.LUMINA_GAME_ENABLED = next ? 'true' : 'false'
  const prefs = readPrefs()
  prefs.gameEnabled = next
  writePrefs(prefs)
  return next
}

/** 读取当前生效的游戏开关值（未设置过则回落到 env）。 */
export function getGameEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const saved = readPrefs().gameEnabled
  if (typeof saved === 'boolean') { return saved }
  return env.LUMINA_GAME_ENABLED === '1' || env.LUMINA_GAME_ENABLED === 'true'
}

/** 仅用于测试：清空持久化记录。 */
export function __resetTrayPrefsForTest(): void {
  try {
     
    const fs = require('fs') as typeof import('fs')
    fs.unlinkSync(prefsPath())
  } catch { /* 本来就没有 */ }
}
