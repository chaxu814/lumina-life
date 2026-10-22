// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// ipc/permissionIpc.ts — 三档权限的 IPC 通道
//
// 频道（全部走 preload 的 contextBridge 暴露）：
//   perm:get        → 读取当前档位快照（含 meta 展示字段）
//   perm:setTier    → 切档位。切 FULL 时必须带 acknowledged=true，
//                     否则主进程直接抛错 —— 风险确认框是**后端强制**的，
//                     不是「UI 记得弹一下」
//   perm:setRoot    → 设置工作区根目录
//   perm:changed    → 变更广播（推送渲染层）
// ============================================================

import { ipcMain } from 'electron'
import { getPermissionStore } from '../permission/permissionStore'
import { PermissionTier, parseTier, TIER_META, PERMISSION_TIERS } from '../permission/permissionTier'

export function registerPermissionIpc(): void {
  const store = getPermissionStore()
  store.load()

  ipcMain.handle('perm:get', () => {
    const snap = store.snapshot()
    return {
      ok: true,
      tier: snap.tier,
      workspaceRoot: snap.workspaceRoot,
      effectiveWorkspaceRoot: store.effectiveWorkspaceRoot(),
      fullAcknowledged: snap.fullAcknowledged,
      needsAcknowledgement: snap.needsAcknowledgement,
      meta: TIER_META,
      tiers: PERMISSION_TIERS,
    }
  })

  ipcMain.handle('perm:setTier', (_e, tier: unknown, acknowledged?: boolean) => {
    try {
      const next = parseTier(tier)
      if (next === PermissionTier.FULL && acknowledged !== true) {
        return {
          ok: false,
          error: '启用完全权限前必须先完成风险确认',
          needsAcknowledgement: true,
        }
      }
      const snap = store.setTier(next, acknowledged === true)
      return {
        ok: true,
        tier: snap.tier,
        fullAcknowledged: snap.fullAcknowledged,
        needsAcknowledgement: snap.tier === PermissionTier.FULL && !snap.fullAcknowledged,
      }
    } catch (err) {
      const e = err as Error
      return { ok: false, error: e?.message || '切换失败' }
    }
  })

  ipcMain.handle('perm:setRoot', (_e, root: unknown) => {
    const value = typeof root === 'string' && root.trim() ? root.trim() : null
    const snap = store.setWorkspaceRoot(value)
    return { ok: true, workspaceRoot: snap.workspaceRoot, effectiveWorkspaceRoot: store.effectiveWorkspaceRoot() }
  })

  // 变更广播：任何地方改了档位，渲染层立即跟上
  store.on('changed', (snap: unknown) => {
    const s = snap as { tier: string; fullAcknowledged: boolean }
    const payload = {
      tier: s.tier,
      fullAcknowledged: s.fullAcknowledged,
      needsAcknowledgement: s.tier === PermissionTier.FULL && !s.fullAcknowledged,
    }
    for (const w of allWindows()) {
      if (!w.isDestroyed()) { w.webContents.send('perm:changed', payload) }
    }
  })
}

// 单独抽出来是为了能在测试里替换
function allWindows(): Array<{ isDestroyed(): boolean; webContents: { send(channel: string, ...args: unknown[]): void } }> {
  const { BrowserWindow } = require('electron') as typeof import('electron')
  return BrowserWindow.getAllWindows() as never
}
