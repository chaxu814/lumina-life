// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// ipc/artifactIpc.ts — 任务工作区产物文件操作 IPC
//
// 仅在用户主动点击时触发，不自动写入：
//   artifact:save            — 弹出保存对话框，写入文本内容
//   artifact:open-in-folder  — 在文件管理器中定位（shell.showItemInFolder）
//   artifact:open-external   — 用系统默认程序打开（shell.openPath）
//   artifact:read-file       — 安全读取产物文件（白名单目录 + 防路径穿越）
//
// 跨平台：统一使用 electron shell/path API，不写死 Windows 命令。
// ============================================================

import { ipcMain, dialog, shell, BrowserWindow, app } from 'electron'
import fs from 'fs'
import path from 'path'

let registered = false

/** 读取文件时允许的白名单目录（resolve 后 startsWith 校验，防 ../ 穿越） */
function getWhitelistDirs(): string[] {
  const dirs: string[] = []
  try {
    const userData = app.getPath('userData')
    dirs.push(path.resolve(userData, 'artifacts'))
    dirs.push(path.resolve(userData, 'workspace'))
    dirs.push(path.resolve(userData))
  } catch { /* 非 Electron 环境 */ }
  // 开发环境：项目目录
  try {
    const projectDir = path.resolve(process.cwd())
    dirs.push(projectDir)
    // 常见父目录兜底
    dirs.push(path.resolve(projectDir, 'artifacts'))
    dirs.push(path.resolve(projectDir, 'userData'))
  } catch { /* ignore */ }
  return dirs
}

/** 校验路径是否在白名单目录内且无穿越，返回安全绝对路径或 null */
function resolveSafePath(filePath: string): string | null {
  if (!filePath || typeof filePath !== 'string') {return null}
  // 拒绝空路径与显式 .. 片段
  if (filePath.includes('\0')) {return null}
  const resolved = path.resolve(filePath)
  const whitelist = getWhitelistDirs()
  for (const dir of whitelist) {
    // 统一用 sep 结尾判断，避免 /foo/bar2 误命中 /foo/bar
    const dirWithSep = dir.endsWith(path.sep) ? dir : dir + path.sep
    if (resolved === dir || resolved.startsWith(dirWithSep)) {
      return resolved
    }
  }
  return null
}

export function registerArtifactIpc(getWindow: () => BrowserWindow | null): void {
  if (registered) { return }
  registered = true

  // 保存文本内容到用户选择的路径
  ipcMain.handle('artifact:save', async (_event, payload: {
    filename: string
    content: string
    suggestedPath?: string
  }) => {
    try {
      const win = getWindow()
      const { canceled, filePath } = await dialog.showSaveDialog(win!, {
        defaultPath: payload.filename || 'artifact.txt',
        filters: [{ name: 'All Files', extensions: ['*'] }],
      })
      if (canceled || !filePath) {
        return { ok: false, canceled: true }
      }
      fs.writeFileSync(filePath, payload.content, 'utf-8')
      return { ok: true, filePath }
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  })

  // 在文件管理器中定位文件（跨平台）
  ipcMain.handle('artifact:open-in-folder', async (_event, filePath: string) => {
    try {
      if (!filePath || !fs.existsSync(filePath)) {
        return { ok: false, error: '文件不存在' }
      }
      shell.showItemInFolder(filePath)
      return { ok: true }
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  })

  // 用系统默认程序打开（跨平台）
  ipcMain.handle('artifact:open-external', async (_event, filePath: string) => {
    try {
      if (!filePath || !fs.existsSync(filePath)) {
        return { ok: false, error: '文件不存在' }
      }
      const err = await shell.openPath(filePath)
      if (err) { return { ok: false, error: err } }
      return { ok: true }
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  })

  // 安全读取产物文件：
  // 1. 路径必须在白名单目录内（userData/artifacts、userData/workspace、项目目录）
  // 2. 拒绝路径穿越（../）
  // 3. 只读取文件，不执行
  // 4. 返回 { ok, dataUrl, size, mtime } 或 { ok:false, error }
  ipcMain.handle('artifact:read-file', async (_event, filePath: string) => {
    try {
      const safe = resolveSafePath(filePath)
      if (!safe) {
        return { ok: false, error: '路径不在允许目录内' }
      }
      if (!fs.existsSync(safe)) {
        return { ok: false, error: '文件不存在' }
      }
      const stat = fs.statSync(safe)
      if (!stat.isFile()) {
        return { ok: false, error: '不是文件' }
      }
      // 25MB 上限保护
      if (stat.size > 25 * 1024 * 1024) {
        return { ok: false, error: '文件超过 25MB 上限' }
      }
      const buf = fs.readFileSync(safe)
      const base64 = buf.toString('base64')
      // 根据扩展名推断 mime，构造 dataUrl
      const ext = (path.extname(safe) || '').slice(1).toLowerCase()
      const mimeMap: Record<string, string> = {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
        gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
        bmp: 'image/bmp', ico: 'image/x-icon',
        pdf: 'application/pdf',
      }
      const mime = mimeMap[ext] || 'application/octet-stream'
      const dataUrl = `data:${mime};base64,${base64}`
      return {
        ok: true,
        dataUrl,
        size: stat.size,
        mtime: stat.mtimeMs,
      }
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  })
}
