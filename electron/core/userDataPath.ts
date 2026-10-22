// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// core/userDataPath.ts — 规范 userData 目录（纯函数，零副作用）
//
// 【为什么需要它】
// 本项目历史上有多个 userData 目录（Electron / lumina-life / Lumina Life），
// 配置在它们之间漂移，用户感知是「每次打开都要重新配模型」。
// 这个模块给出**唯一、可测试、跨平台一致**的规范路径，供启动模块显式锁定。
//
// 【为什么是纯函数】
// 启动模块（appName.ts）必须最先执行、且不能有任何副作用 —— 把路径计算
// 抽成纯函数，既能让 appName 保持极简，又能被单测直接覆盖。
// ============================================================

import * as os from 'os'
import * as path from 'path'

export const APP_NAME = 'Lumina Life'

/**
 * 计算规范的 userData 目录，与 Electron 各平台的默认规则保持一致：
 *   Windows : %APPDATA%/Lumina Life
 *   macOS   : ~/Library/Application Support/Lumina Life
 *   Linux   : $XDG_CONFIG_HOME/Lumina Life 或 ~/.config/Lumina Life
 *
 * 参数可注入，便于单测（不依赖真实平台/环境）。
 */
export function canonicalUserDataDir(
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  if (platform === 'win32') {
    return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), APP_NAME)
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', APP_NAME)
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), APP_NAME)
}

/** 需要从中并入数据的旧目录名（与 userDataMigration 保持一致的口径） */
export const LEGACY_DIR_NAMES = ['lumina-life', 'Electron'] as const
