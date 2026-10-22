// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// ipc/spriteIpc.ts — 桌宠 UGC 精灵表的 IPC 通道（2026-10-07）
//
// 【为什么需要它】
//   electron/pet/spriteSheet.ts 里已经有一整套 UGC 规格与生成器：
//     · SPRITE_ACTIONS  9 行动作定义（含逐帧描述）
//     · buildAiSpritePrompt()  「把提示词发给会画画的 AI」这条路径
//     · buildQuickStaticPrompt() 单张静态图快速路径
//     · validateSpriteSheet() 导入校验
//   但**渲染进程无法直接 import 它** —— 它经由 modelImporter 拉进了
//   adm-zip / node:fs，属于主进程专用模块。于是这些能力一直只有代码、
//   没有入口。本通道把它们暴露给 UI。
//
// 【通道】
//   sprite:spec        → 规格（8×9 / 9 个动作 / 体积上限）
//   sprite:prompt      → 生成「AI 画精灵表」的完整提示词
//   sprite:quickPrompt → 生成「单张静态图」的快速提示词
// ============================================================

import { ipcMain } from 'electron'
import {
  SPRITE_COLS,
  SPRITE_ROWS,
  SPRITE_ACTIONS,
  SPRITE_DEFAULT_FRAME,
  SPRITE_MAX_DIM,
  SPRITE_MAX_PIXELS,
  SPRITE_MAX_BYTES,
  buildAiSpritePrompt,
  buildQuickStaticPrompt,
} from '../pet/spriteSheet'

export function registerSpriteIpc(): void {
  ipcMain.handle('sprite:spec', () => {
    try {
      return {
        ok: true,
        cols: SPRITE_COLS,
        rows: SPRITE_ROWS,
        defaultFrame: SPRITE_DEFAULT_FRAME,
        maxDim: SPRITE_MAX_DIM,
        maxPixels: SPRITE_MAX_PIXELS,
        maxBytes: SPRITE_MAX_BYTES,
        actions: SPRITE_ACTIONS.map(a => ({
          id: a.id,
          label: a.label,
          row: a.row,
          frames: a.frames,
          mirroredForLeft: Boolean(a.mirroredForLeft),
          description: a.description,
        })),
      }
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('sprite:prompt', (_e, opts?: { subject?: string; style?: string; frameW?: number; frameH?: number }) => {
    try {
      return { ok: true, prompt: buildAiSpritePrompt({
        subject: String(opts?.subject || '').trim() || '一只可爱的猫娘桌宠',
        style: typeof opts?.style === 'string' && opts.style.trim() ? opts.style : undefined,
        frameW: Number.isFinite(opts?.frameW) ? Number(opts?.frameW) : undefined,
        frameH: Number.isFinite(opts?.frameH) ? Number(opts?.frameH) : undefined,
      }) }
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('sprite:quickPrompt', (_e, subject?: string) => {
    try {
      return { ok: true, prompt: buildQuickStaticPrompt(String(subject || '').trim() || '一只可爱的猫娘桌宠') }
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
