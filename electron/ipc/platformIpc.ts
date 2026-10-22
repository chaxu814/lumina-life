// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// ipc/platformIpc.ts — 平台能力矩阵 IPC（跨平台支持：能力分级、优雅降级）
//
// 暴露 platform:get-features：返回当前平台各功能（chat/pet/memory/persona/
// skills/computerUse/uia/voice/screenVision）的可用状态与降级说明。
// 前端设置页据此对不可用能力做置灰 + 原因提示。本次不改前端 UI。
// ============================================================

import { ipcMain } from 'electron'
import { getPlatformFeatureMatrix } from '../core/platform'

export function registerPlatformIpc(): void {
  ipcMain.handle('platform:get-features', async () => {
    try {
      return { ok: true, matrix: getPlatformFeatureMatrix() }
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  })
}
