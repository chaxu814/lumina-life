// ============================================================
// ipc/memoryFederationIpc.ts — 团队记忆共享 Federation IPC（提案3）
//
//   federation:export             打包本地记忆为可交换 JSON
//   federation:import             导入记忆包（隔离写入 federated/<source>/）
//   federation:list               列出已导入的联邦记忆
//   federation:set-confidence     调整某来源可信度
// ============================================================

import { ipcMain } from 'electron'
import {
  exportMemory,
  importMemory,
  listFederatedMemories,
  setFederatedConfidence,
  type MemoryExport,
  type ImportOptions,
} from '../memory/federation'

export function registerMemoryFederationIpc(): void {
  // ── 导出 ─────────────────────────────────────────
  ipcMain.handle('federation:export', (_e, opts?: { source?: string; memoryRoot?: string }) => {
    try {
      const pkg = exportMemory(opts || {})
      return { ok: true, package: pkg }
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) }
    }
  })

  // ── 导入 ─────────────────────────────────────────
  ipcMain.handle(
    'federation:import',
    (_e, pkg: MemoryExport | string, options?: ImportOptions) => {
      try {
        const res = importMemory(pkg, options || {})
        return res
      } catch (err: any) {
        return { ok: false, imported: 0, skipped: 0, conflicts: [], destRoot: '', error: err?.message || String(err) }
      }
    },
  )

  // ── 列表 ─────────────────────────────────────────
  ipcMain.handle('federation:list', () => {
    try {
      return { ok: true, sources: listFederatedMemories() }
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) }
    }
  })

  // ── 调整可信度 ────────────────────────────────────
  ipcMain.handle('federation:set-confidence', (_e, source: string, confidence: number) => {
    try {
      return setFederatedConfidence(source, confidence)
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) }
    }
  })

  console.log('[federation] 📡 IPC 已注册 (federation:*)')
}
