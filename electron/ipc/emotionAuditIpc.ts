// ============================================================
// ipc/emotionAuditIpc.ts — 情绪收紧审计的 IPC 通道
//
// 频道（全部走 preload 的 contextBridge 暴露）：
//   emotionAudit:list       → 审计记录列表（新 → 旧，含可读摘要）
//   emotionAudit:active     → 当前仍然生效的收紧
//   emotionAudit:explain    → 单条记录的完整原因链（逐行可读）
//   emotionAudit:override   → 用户放行**这一轮**
//   emotionAudit:rules      → 规则元数据（文案 + 阈值 + 代码位置）
//
// 【override 的语义边界 —— UI 必须如实呈现，不能简化】
//   这不是「永久解锁」，也不是「权限授权」。
//   放行的含义是：**本轮**按你说的做；下一轮若情绪仍触发同一条规则，照样收紧。
//   放行后工具仍要过 sandboxRules / permissionTier / rolePolicy。
//   任何 UI 文案把它说成「以后都允许」都是错的。
// ============================================================

import { ipcMain, BrowserWindow } from 'electron'
import { getEmotionAuditLog, GATE_RULES } from '../orchestration/emotionAudit'
import type { GateRuleId } from '../orchestration/emotionAudit'
import {
  getVisibilityTier, setVisibilityTier, onVisibilityChange,
  VISIBILITY_TIERS, VISIBILITY_ORDER, isEventVisible,
} from '../orchestration/visibility'

export function registerEmotionAuditIpc(): void {
  const log = getEmotionAuditLog()

  ipcMain.handle('emotionAudit:list', () => {
    try {
      return { ok: true, records: log.all() }
    } catch (err) {
      return { ok: false, error: String((err as Error)?.message || err) }
    }
  })

  ipcMain.handle('emotionAudit:active', () => {
    try {
      return { ok: true, records: log.active() }
    } catch (err) {
      return { ok: false, error: String((err as Error)?.message || err) }
    }
  })

  ipcMain.handle('emotionAudit:explain', (_e, id: unknown) => {
    try {
      if (typeof id !== 'string' || !id) {return { ok: false, error: '缺少 id' }}
      const s = log.explain(id)
      if (!s) {return { ok: false, error: '记录不存在或已被挤出缓冲' }}
      return { ok: true, summary: s, record: log.get(id) }
    } catch (err) {
      return { ok: false, error: String((err as Error)?.message || err) }
    }
  })

  ipcMain.handle('emotionAudit:override', (_e, id: unknown, reason?: unknown) => {
    try {
      if (typeof id !== 'string' || !id) {return { ok: false, error: '缺少 id' }}
      const r = log.override(id, typeof reason === 'string' ? reason : '')
      if (!r) {return { ok: false, error: '记录不存在' }}
      // 广播：桌宠气泡与审计面板都要跟着变
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) {
          w.webContents.send('emotionAudit:changed', { id: r.id, status: r.status })
        }
      }
      return {
        ok: true,
        record: r,
        // 这两句必须原样传给 UI —— 它们是「放行」这个词的边界定义
        notice: '已放行本轮。下一轮若情绪仍触发同一条规则，仍会收紧。',
        stillGatedNextTurn: true,
        permissionUnchanged: true,
      }
    } catch (err) {
      return { ok: false, error: String((err as Error)?.message || err) }
    }
  })

  ipcMain.handle('emotionAudit:rules', () => {
    try {
      return { ok: true, rules: GATE_RULES as Record<GateRuleId, unknown> }
    } catch (err) {
      return { ok: false, error: String((err as Error)?.message || err) }
    }
  })
}

// ============================================================
// 可见性分档 IPC（与审计同文件注册，因为两者都服务于「可解释性」）
// ============================================================
export function registerVisibilityIpc(): void {
  ipcMain.handle('visibility:get', () => {
    try {
      return {
        ok: true,
        tier: getVisibilityTier(),
        tiers: VISIBILITY_ORDER.map(t => VISIBILITY_TIERS[t]),
      }
    } catch (err) {
      return { ok: false, error: String((err as Error)?.message || err) }
    }
  })

  ipcMain.handle('visibility:set', (_e, tier: unknown) => {
    try {
      // ⚠️ setVisibilityTier 对非法值回落 companion 而不报错，
      // 所以这里要如实回传实际生效值，别把用户传的非法值原样弹回去。
      const applied = setVisibilityTier(tier)
      if (applied !== tier) {
        console.warn(`[Visibility] 未知档位 ${String(tier)}，已回落到 ${applied}`)
      }
      return { ok: true, tier: applied }
    } catch (err) {
      return { ok: false, error: String((err as Error)?.message || err) }
    }
  })

  ipcMain.handle('visibility:canSee', (_e, type: unknown) => {
    try {
      if (typeof type !== 'string') {return { ok: false, error: '缺少事件类型' }}
      return { ok: true, visible: isEventVisible(type, getVisibilityTier()) }
    } catch (err) {
      return { ok: false, error: String((err as Error)?.message || err) }
    }
  })

  onVisibilityChange((tier) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) { w.webContents.send('visibility:changed', { tier }) }
    }
  })
}
