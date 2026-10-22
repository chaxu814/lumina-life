// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// electron/tray/macDock.ts — macOS 托盘/ Dock 差异适配
//
// Electron 的 Tray 在三平台的差异（本次实读代码后确认）：
//
//  1) 菜单栏 vs 托盘区
//     Windows/Linux 在任务栏/系统托盘；macOS 在**顶部菜单栏右侧**。
//     现有 trayMenu.ts 已有 darwin 分支按 tray.getBounds() 定位浮层，行为正确。
//
//  2) ★ 图标必须是 template image
//     macOS 菜单栏会随「浅色/深色外观」自动反色显示，**只有 template image**
//     才会被系统正确处理。普通彩色图在深色模式下会出现「灰底黑图」这类几乎看不见的情况。
//     Windows 托盘不需要这个处理（且设了反而可能让图标失去颜色）。
//     → 本模块在 darwin 上把托盘图标标记为 template。
//
//  3) ★ app.dock：macOS 特有，Dock 图标与「是否显示 Dock」是两件事
//     Electron 默认给一个通用 Electron 图标。对「桌宠 + 托盘」这类应用，
//     常见做法是 app.dock.hide() 让它变成纯菜单栏应用。
//     **但这是一个产品决策，不是技术必然**：
//       · hide 之后 Cmd+Q 失效、App 无法从 Dock 切回、部分系统对话框行为异常；
//       · 不 hide 则 Dock 有图标，用户可正常 Cmd+Q / 右键退出。
//     因此本模块**默认不隐藏**（保守、不破坏 macOS 常规交互），
//     仅当用户显式设置 LUMINA_MAC_HIDE_DOCK=1 时才隐藏。
//     隐藏时同时注册 activate 事件把 Dock 点回来，避免用户彻底找不到 App。
//
// ⚠️ 未经实机验证：template image 的实际渲染效果、Dock 隐藏后的完整交互，
//    都必须在真机确认。见 docs/cross-platform-status.md 的实机验证清单。
// ============================================================
//
// 纯逻辑（shouldHideDock / applyTrayIconConventions）可单测；
// applyMacDock 只做三行设置，调用点在 main.ts createTray() 内。
// ============================================================

import { nativeImage, type App, type NativeImage } from 'electron'

/** Dock 显示模式 */
export type MacDockMode = 'show' | 'hide'

/**
 * 由环境变量解析 Dock 模式（纯函数，可单测）。
 * 缺省 / 取值非法 → 'show'（保守，不破坏 macOS 常规交互）。
 */
export function resolveDockMode(envValue?: string | null): MacDockMode {
  const v = String(envValue ?? '').trim().toLowerCase()
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on' || v === 'hide') {return 'hide'}
  return 'show'
}

/**
 * 托盘图标的平台惯例（纯函数语义，便于单测）：
 * macOS → 标记为 template image（随菜单栏深浅色自动反色）。
 * 其它平台 → 原样返回，不做任何改动（Windows 行为零变化）。
 */
export function applyTrayIconConventions(icon: NativeImage, platform: NodeJS.Platform): NativeImage {
  if (platform !== 'darwin') {return icon}
  try {
    if (icon && typeof icon.setTemplateImage === 'function') {
      icon.setTemplateImage(true)
    }
  } catch {
    // 空图标（createEmpty）没有可标记的位图；忽略，不阻断托盘创建
  }
  return icon
}

/**
 * 应用 macOS Dock 设置。
 * @param mode 'show'（默认，设 Dock 图标）或 'hide'（纯菜单栏应用）
 * @returns 实际生效的模式（便于日志/排障）
 */
export function applyMacDock(
  appRef: Pick<App, 'dock'>,
  icon: NativeImage | null,
  mode: MacDockMode = 'show',
  platform: NodeJS.Platform = process.platform,
): MacDockMode {
  if (platform !== 'darwin') {return 'show'}
  const dock = appRef?.dock
  if (!dock) {return 'show'}

  if (mode === 'hide') {
    try { dock.hide() } catch { /* 未 ready 时忽略 */ }
    return 'hide'
  }

  try {
    if (icon && !icon.isEmpty()) {dock.setIcon(icon)}
  } catch { /* 图标设置失败不影响主流程 */ }
  return 'show'
}

/** 构造托盘图标并套用平台惯例（main.ts createTray 用） */
export function buildTrayIcon(iconPath: string, fallbackPath: string, platform: NodeJS.Platform = process.platform): NativeImage {
  let icon = nativeImage.createFromPath(iconPath)
  if (icon.isEmpty()) {
    icon = nativeImage.createFromPath(fallbackPath).resize({ width: 16, height: 16 })
  }
  return applyTrayIconConventions(icon, platform)
}
