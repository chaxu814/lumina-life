// ============================================================
// ipc/themeIpc.ts — 主题皮肤系统 IPC
//
// 通道：
//   theme:list        → 列出内置 + 用户主题
//   theme:apply       (name) → 应用主题，广播 vars 到所有窗口
//   theme:import      (filePath) → 导入 .lumina-theme
//   theme:export      (name, filePath) → 导出
//   theme:delete      (name) → 删除用户主题
//   theme:get-current → 当前主题 + resolvedVars
//   theme:save        (themeObj) → 编辑器保存新主题
// ============================================================

import { BrowserWindow, dialog, ipcMain } from 'electron'
import {
  applyTheme,
  deleteTheme,
  exportTheme,
  getCurrentTheme,
  importTheme,
  listThemes,
  saveUserTheme,
  type AppliedTheme,
} from '../theme/themeManager'
import type { LuminaTheme } from '../theme/types'

/**
 * 把 resolvedVars 编成一段在任意渲染进程里执行的 JS：
 * 直接写入 documentElement 的 inline custom property。
 * 桌宠窗口 / 托盘窗口没有 React 引导脚本，靠这段 JS 跟随主题。
 */
export function buildApplyScript(resolvedVars: Record<string, string>, isDark: boolean): string {
  const entries = Object.entries(resolvedVars)
    .map(([k, v]) => `el.style.setProperty(${JSON.stringify(k)}, ${JSON.stringify(v)})`)
    .join(';')
  return `(function(){try{var el=document.documentElement;${entries};el.style.colorScheme=${JSON.stringify(isDark ? 'dark' : 'light')};}catch(e){}})()`
}

/** 把当前主题注入单个窗口（窗口加载完成后主动调用） */
export function pushThemeToWindow(win: BrowserWindow): void {
  try {
    if (win.isDestroyed()) { return }
    const cur = getCurrentTheme()
    const script = buildApplyScript(cur.resolvedVars, cur.theme.isDark)
    win.webContents.executeJavaScript(script).catch(() => { /* ignore */ })
  } catch { /* ignore */ }
}
/** 广播主题到所有窗口（桌宠 / 托盘 / 主窗口） */
export function broadcastTheme(theme: AppliedTheme): void {
  const script = buildApplyScript(theme.resolvedVars, theme.theme.isDark)
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win.isDestroyed()) {
        win.webContents.executeJavaScript(script).catch(() => { /* 窗口未就绪 */ })
        win.webContents.send('theme:changed', {
          name: theme.theme.name,
          isDark: theme.theme.isDark,
          resolvedVars: theme.resolvedVars,
        })
      }
    } catch {
      /* 忽略单个窗口失败 */
    }
  }
}

function sanitize(t: LuminaTheme): LuminaTheme {
  const { filePath: _f, builtIn: _b, ...rest } = t
  return rest
}

export function registerThemeIpc(): void {
  ipcMain.handle('theme:list', () => {
    try {
      return { ok: true, themes: listThemes().map(sanitize) }
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) }
    }
  })

  ipcMain.handle('theme:apply', (_e, name: string) => {
    try {
      const applied = applyTheme(name)
      broadcastTheme(applied)
      return { ok: true, theme: sanitize(applied.theme), resolvedVars: applied.resolvedVars }
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) }
    }
  })

  ipcMain.handle('theme:import', async (_e, filePath?: string) => {
    try {
      let src = filePath
      if (!src) {
        const picked = await dialog.showOpenDialog({
          title: '导入主题',
          properties: ['openFile'],
          filters: [{ name: 'Lumina 主题', extensions: ['lumina-theme', 'json'] }],
        })
        if (picked.canceled || !picked.filePaths[0]) { return { ok: false, canceled: true } }
        src = picked.filePaths[0]
      }
      const theme = importTheme(src)
      return { ok: true, theme: sanitize(theme) }
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) }
    }
  })

  ipcMain.handle('theme:export', async (_e, name: string, filePath?: string) => {
    try {
      let dest = filePath
      if (!dest) {
        const saved = await dialog.showSaveDialog({
          title: '导出主题',
          defaultPath: `${name}.lumina-theme`,
          filters: [{ name: 'Lumina 主题', extensions: ['lumina-theme'] }],
        })
        if (saved.canceled || !saved.filePath) { return { ok: false, canceled: true } }
        dest = saved.filePath
      }
      exportTheme(name, dest)
      return { ok: true, filePath: dest }
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) }
    }
  })

  ipcMain.handle('theme:delete', (_e, name: string) => {
    try {
      deleteTheme(name)
      // 重新广播（删除后当前主题可能已回退）
      broadcastTheme(getCurrentTheme())
      return { ok: true }
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) }
    }
  })

  ipcMain.handle('theme:get-current', () => {
    try {
      const cur = getCurrentTheme()
      return {
        ok: true,
        theme: sanitize(cur.theme),
        resolvedVars: cur.resolvedVars,
      }
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) }
    }
  })

  ipcMain.handle('theme:save', (_e, theme: LuminaTheme) => {
    try {
      const saved = saveUserTheme(theme)
      return { ok: true, theme: sanitize(saved) }
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) }
    }
  })
}
