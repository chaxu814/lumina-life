// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// ipc/skillRuntimeIpc.ts — 🧪 第三方技能包运行时 IPC (v0.2 创新提案2+5)
//
//   skill-runtime:open-package     弹文件对话框选 .lumina-skill
//   skill-runtime:prepare          解压+静态扫描+验签，返回审批数据（不落地）
//   skill-runtime:confirm         用户确认后安装+沙箱加载+动态注册
//   skill-runtime:list            列出已装技能
//   skill-runtime:uninstall        卸载
// ============================================================

import { ipcMain, dialog, BrowserWindow } from 'electron'
import { app } from 'electron'
import * as path from 'node:path'
import {
  prepareInstallSkill, confirmInstallSkill, uninstallSkill, listInstalledSkills,
} from '../skills/skillManager'

let registered = false

export function registerSkillRuntimeIpc(): void {
  if (registered) {return}
  registered = true

  // 选 .lumina-skill 文件
  ipcMain.handle('skill-runtime:open-package', async () => {
    try {
      const parent = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || undefined
      const dlg = await dialog.showOpenDialog(parent as BrowserWindow, {
        title: '选择 .lumina-skill 技能包',
        filters: [{ name: 'Lumina Skill', extensions: ['lumina-skill', 'zip'] }],
        properties: ['openFile'],
      })
      if (dlg.canceled || !dlg.filePaths[0]) {return { ok: false, canceled: true }}
      return { ok: true, zipPath: dlg.filePaths[0] }
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) }
    }
  })

  // 准备安装：扫描 + 验签，返回审批清单
  ipcMain.handle('skill-runtime:prepare', async (_e, zipPath: string) => {
    try {
      const staged = await prepareInstallSkill(zipPath, app.getPath('userData'))
      return {
        ok: true,
        stagedId: staged.stagedId,
        manifest: staged.manifest,
        scan: staged.scan,
        signatureStatus: staged.signatureStatus,
        signatureReason: staged.signatureReason,
      }
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) }
    }
  })

  // 用户确认后真正安装
  ipcMain.handle('skill-runtime:confirm', async (_e, stagedId: string) => {
    try {
      const res = await confirmInstallSkill(stagedId, app.getPath('userData'))
      if (!res.ok) {return { ok: false, error: res.error }}
      return { ok: true, skill: { name: res.skill!.manifest.name, tools: res.skill!.tools.map((t) => t.name) } }
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) }
    }
  })

  ipcMain.handle('skill-runtime:list', async () => {
    try {
      const skills = await listInstalledSkills(app.getPath('userData'))
      return { ok: true, skills }
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e), skills: [] }
    }
  })

  ipcMain.handle('skill-runtime:uninstall', async (_e, name: string) => {
    try {
      const res = await uninstallSkill(name, app.getPath('userData'))
      return res
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) }
    }
  })

  console.log('[skillRuntime] 🧪 IPC 已注册 (skill-runtime:*)')
}
