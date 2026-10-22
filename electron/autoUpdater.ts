// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// autoUpdater.ts — Electron 自动更新 (P2.3)
//
// 使用 electron-updater 检查并安装更新
// Steam 式自动更新思路，但用 electron-updater
//
// 配置要求:
//   1. 在 package.json 添加 "build.publish" 配置
//   2. 设置 GH_TOKEN 环境变量（GitHub Releases）
//   3. npm install electron-updater
// ============================================================

import { autoUpdater } from 'electron-updater'
import { BrowserWindow, dialog } from 'electron'

let updateCheckTimer: NodeJS.Timeout | null = null

export interface UpdateStatus {
  checking: boolean
  available: boolean
  version?: string
  downloaded: boolean
  error?: string
  progress?: number
}

let currentStatus: UpdateStatus = {
  checking: false,
  available: false,
  downloaded: false,
}

export function getUpdateStatus(): UpdateStatus {
  return { ...currentStatus }
}

/**
 * 初始化自动更新
 * @param win 主窗口（用于显示对话框）
 * @param checkIntervalHours 检查间隔（小时），默认 4
 */
export function initAutoUpdater(win: BrowserWindow, checkIntervalHours = 4): void {
  // 配置 autoUpdater
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  // 事件监听
  autoUpdater.on('checking-for-update', () => {
    currentStatus = { ...currentStatus, checking: true }
    console.log('[AutoUpdater] 检查更新中...')
  })

  autoUpdater.on('update-available', (info) => {
    currentStatus = {
      checking: false,
      available: true,
      version: info.version,
      downloaded: false,
    }
    console.log(`[AutoUpdater] 发现新版本: ${info.version}`)
    win.webContents.send('update:available', info)
  })

  autoUpdater.on('update-not-available', () => {
    currentStatus = { checking: false, available: false, downloaded: false }
  })

  autoUpdater.on('download-progress', (progress) => {
    currentStatus.progress = progress.percent
    win.webContents.send('update:progress', progress)
  })

  autoUpdater.on('update-downloaded', (info) => {
    currentStatus = {
      checking: false,
      available: true,
      version: info.version,
      downloaded: true,
    }
    win.webContents.send('update:downloaded', info)

    // 询问用户是否立即重启安装
    dialog
      .showMessageBox(win, {
        type: 'info',
        title: '更新已下载',
        message: `Lumina v${info.version} 已下载完毕`,
        detail: '是否立即重启以安装更新？',
        buttons: ['立即重启', '稍后'],
        defaultId: 0,
      })
      .then((result) => {
        if (result.response === 0) {
          autoUpdater.quitAndInstall()
        }
      })
  })

  autoUpdater.on('error', (err) => {
    currentStatus = {
      ...currentStatus,
      checking: false,
      error: err.message,
    }
    console.error('[AutoUpdater] 错误:', err)
  })

  // 首次检查
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.warn('[AutoUpdater] 首次检查失败（可能未发布过版本）:', err.message)
    })
  }, 5000)

  // 定期检查
  updateCheckTimer = setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => {})
  }, checkIntervalHours * 3600000)
}

export function checkForUpdatesNow(): void {
  autoUpdater.checkForUpdates().catch((err) => {
    console.warn('[AutoUpdater] 手动检查失败:', err.message)
  })
}

export function destroyAutoUpdater(): void {
  if (updateCheckTimer) {
    clearInterval(updateCheckTimer)
    updateCheckTimer = null
  }
}
