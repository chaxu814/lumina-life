// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// ipc/computerUseIpc.ts — 桌面操控 IPC (v3.10)
// ============================================================

import { ipcMain } from 'electron'
import { getComputerUse } from '../computerUse'
import type { SafetyLevel } from '../computerUse'

export function registerComputerUseIpc(): void {
  const cu = getComputerUse()
  let _active = false  // 🆕 v1.1: 追踪 Computer Use 启动状态

  // ─── 执行任务 ─────────────────────────────────────
  ipcMain.handle('computer-use:execute', async (_event, task: string, safetyLevel?: SafetyLevel) => {
    try {
      const result = await cu.execute(task)
      return { success: result.success, result }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ─── 截图 ─────────────────────────────────────────
  ipcMain.handle('computer-use:screenshot', async () => {
    try {
      const path = await cu.captureScreen()
      return { success: true, path }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ─── 分析截图 ─────────────────────────────────────
  ipcMain.handle('computer-use:analyze', async (_event, screenshotPath: string, task: string) => {
    try {
      const analysis = await cu.analyzeScreen(screenshotPath, task, [])
      return { success: true, analysis }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ─── 执行单个操作 ─────────────────────────────────
  ipcMain.handle('computer-use:action', async (_event, action: { type: string; params: Record<string, string | number> }) => {
    try {
      const ok = await cu.executeAction(action as any)
      return { success: ok }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ─── 🧰 v1.0 工具箱: Computer Use 模式入口 ────────
  ipcMain.handle('computer-use:start', async () => {
    try {
      // 先用截图测试是否可用
      const path = await cu.captureScreen()
      _active = true  // 🆕 v1.1: 标记为活跃
      return {
        success: true,
        message: '🖥️ Computer Use 已就绪，AI 现在可以操作你的桌面了。\n请确保已告知 AI 你的意图。',
      }
    } catch (err: any) {
      return { success: false, error: `Computer Use 初始化失败: ${err.message}` }
    }
  })

  // ─── 🧰 v1.0 工具箱: Computer Use 停止 ────────
  ipcMain.handle('computer-use:stop', async () => {
    _active = false  // 🆕 v1.1: 标记为停止
    return { success: true }
  })

  // ─── 🧰 v1.0 工具箱: Computer Use 状态 ────────
  ipcMain.handle('computer-use:status', async () => {
    return { active: _active, running: _active }  // 🆕 v1.1: 返回真实状态
  })
}
