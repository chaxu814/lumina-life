// ============================================================
// ipc/sandboxAuditIpc.ts — 沙箱透明审计 IPC（I5）
//
// 注册：
//   ipcMain.handle('sandbox:audit-log',  () => { log, stats, rules })
//
// ⚠️ 本文件只负责导出 registerSandboxAuditIpc()。
//    集成阶段由 main.ts 统一 import 并调用，本分片不改 main.ts / preload.ts。
//
// preload 需要暴露给渲染进程的方法（集成阶段加）：
//   window.luminaAPI.sandboxGetAuditLog(): Promise<{
//     log: SandboxAuditEntry[]
//     stats: { day, intercepted, degraded, approved, total, buffered }
//     rules: { total, bySeverity, byCategory }
//   }>
// ============================================================

import { ipcMain } from 'electron'
import { getAuditLog, getAuditStats } from '../tools/impl/sandboxAudit'
import { ruleStats } from '../tools/impl/sandboxRules'

export function registerSandboxAuditIpc(): void {
  ipcMain.handle('sandbox:audit-log', async () => {
    return {
      log: getAuditLog(200),
      stats: getAuditStats(),
      rules: ruleStats(),
    }
  })
  console.log('[SandboxAudit] 🔍 审计 IPC 已注册 (sandbox:audit-log)')
}
