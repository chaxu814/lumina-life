// ============================================================
// ipc/codingModeIpc.ts — Coding Mode IPC (v3.5)
//
// 暴露 codingMode.ts 的 diff 解析/应用/预览给渲染进程
// ============================================================

import { ipcMain } from 'electron'
import { extractDiffBlocks, applyDiffBlock, formatDiffPreview } from '../codingMode'
import * as path from 'path'
import * as fs from 'fs'

export function registerCodingModeIpc(): void {
  // ─── 提取 diff blocks ──────────────────────────────
  ipcMain.handle('coding-mode:extract', async (_event, text: string) => {
    const blocks = extractDiffBlocks(text)
    return blocks.map(b => ({
      filePath: b.filePath,
      hunks: b.hunks,
      raw: b.raw,
      preview: formatDiffPreview(b),
    }))
  })

  // ─── 应用 diff ─────────────────────────────────────
  ipcMain.handle('coding-mode:apply', async (_event, params: {
    block: { filePath: string; raw: string; hunks: string[] }
    baseDir: string
  }) => {
    const result = applyDiffBlock(
      { filePath: params.block.filePath, hunks: params.block.hunks, raw: params.block.raw },
      params.baseDir
    )
    return result
  })

  // ─── 预览 diff ─────────────────────────────────────
  ipcMain.handle('coding-mode:preview', async (_event, params: {
    block: { filePath: string; hunks: string[]; raw: string }
  }) => {
    return formatDiffPreview(
      { filePath: params.block.filePath, hunks: params.block.hunks, raw: params.block.raw }
    )
  })

  // ─── 生成 diff (文件对比) ──────────────────────────
  ipcMain.handle('coding-mode:diff', async (_event, params: {
    originalPath: string
    modifiedPath: string
  }) => {
    try {
      const { execSync } = require('child_process')
      const cmd = process.platform === 'win32'
        ? `fc /N "${params.originalPath}" "${params.modifiedPath}"`
        : `diff -u "${params.originalPath}" "${params.modifiedPath}"`

      const output = execSync(cmd, { encoding: 'utf-8', timeout: 10_000 })
      return { success: true, diff: output }
    } catch (err: any) {
      // diff 返回非0表示有差异
      if (err.stdout) {return { success: true, diff: err.stdout }}
      return { success: false, error: err.message }
    }
  })

  // ─── 实时监听 LLM 输出中的 diff ───────────────────
  ipcMain.handle('coding-mode:listen', async (event) => {
    // 注册一个全局监听器来实时检测 diff
    // 在实际使用中，渲染进程通过 agent:event 流获取 LLM 响应
    // 然后在前端调用 extract，这里提供的是一个占位
    return { success: true, message: 'Coding Mode 监听已就绪' }
  })
}
