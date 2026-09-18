// ============================================================
// paths.ts — 跨平台应用数据目录
//
// 旧版记忆库硬编码在 `%APPDATA%/lumina-memory.db`（直接落在 Roaming 根），
// 在 macOS/Linux 上会退化成 `~/lumina-memory.db`（家目录根），既不规范也难定位。
// 这里统一为：
//   Windows : %APPDATA%/Lumina Life/          （= Electron userData）
//   macOS   : ~/Library/Application Support/Lumina Life/
//   Linux   : $XDG_DATA_HOME/lumina-life 或 ~/.local/share/lumina-life
// 并保留对旧 Windows 散落文件的向后兼容（旧文件存在则继续用，不丢数据）。
//
// 纯函数 + 惰性探测，Electron 不可用时（CLI/headless/单测）也能工作。
// ============================================================

import path from 'path'
import os from 'os'
import fs from 'fs'

export const APP_NAME = 'Lumina Life'
export const APP_ID_LINUX = 'lumina-life'

let cachedDir: string | null = null

/** 应用数据目录（Electron userData 优先；否则按平台标准） */
export function appDataDir(): string {
  if (cachedDir) return cachedDir

  // 1) 显式覆盖（测试 / headless / Docker 可挂载的数据卷）
  if (process.env.LUMINA_DATA_DIR && process.env.LUMINA_DATA_DIR.trim()) {
    cachedDir = process.env.LUMINA_DATA_DIR
    return cachedDir
  }

  // 2) Electron 主进程 userData（与桌宠其它数据同目录）
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron')
    const app = electron?.app
    if (app && typeof app.getPath === 'function') {
      const u: string | undefined = app.getPath('userData')
      if (u) {
        cachedDir = u
        return cachedDir
      }
    }
  } catch {
    // 非 Electron 环境（CLI / 测试），走平台标准
  }

  // 3) 平台标准目录
  const home = os.homedir()
  switch (process.platform) {
    case 'win32':
      cachedDir = path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), APP_NAME)
      break
    case 'darwin':
      cachedDir = path.join(home, 'Library', 'Application Support', APP_NAME)
      break
    default:
      cachedDir = path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), APP_ID_LINUX)
      break
  }
  return cachedDir
}

/** 确保目录存在（失败不抛，交给上层文件操作自然报错） */
export function ensureAppDataDir(dir?: string): string {
  const target = dir || appDataDir()
  try {
    fs.mkdirSync(target, { recursive: true })
  } catch { /* 已存在或无权限，忽略 */ }
  return target
}

/**
 * 记忆库路径：
 *   - 新位置：appDataDir()/lumina-memory.db
 *   - 旧 Windows 散落文件 `%APPDATA%/lumina-memory.db` 若已存在则继续使用，
 *     避免老用户升级后记忆"消失"；新安装一律落到规范目录。
 */
export function getMemoryDbPath(): string {
  const newPath = path.join(appDataDir(), 'lumina-memory.db')
  try {
    if (fs.existsSync(newPath)) return newPath
  } catch { /* ignore */ }

  if (process.platform === 'win32' && process.env.APPDATA) {
    const legacy = path.join(process.env.APPDATA, 'lumina-memory.db')
    try {
      if (fs.existsSync(legacy)) return legacy
    } catch { /* ignore */ }
  }
  return newPath
}

/** 仅供测试：重置缓存目录 */
export function __resetPathCacheForTest(): void {
  cachedDir = null
}
