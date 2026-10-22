// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// handover/handoverIpc.ts — 交班模式 IPC 注册（导出注册函数，不改 preload）
//
// 【preload 期望暴露（集成阶段接线，见文件尾注释）】
//   window.luminaAPI.handoverGenerate(opts) → Promise<HandoverGenerateResult>
//   window.luminaAPI.handoverSave(containerStr, suggestedName?) → Promise<{ok, filePath?}>
//   window.luminaAPI.handoverRevoke(code) → Promise<{ok}>
//   window.luminaAPI.handoverStatus() → Promise<{pendingCount, flagEnabled, activeExchanges}>
//
// 【原生通道名】
//   handover:generate / handover:save / handover:revoke / handover:status
// ============================================================

import { ipcMain, dialog, BrowserWindow } from 'electron'
import * as fs from 'fs'
import { buildHandoverCard, parseTodoListText } from './handoverCard'
import {
  encryptCardWithPassword,
  encryptCardWithMachineKey,
  containerToString,
} from './handoverCrypto'
import {
  createExchange,
  revokeExchange,
  exchangeCount,
  decideQrPayload,
  renderQrDataUrl,
  buildHandoverUrl,
  firstLanIPv4,
} from './handoverExchange'
import { HANDOVER_DEFAULT_TTL_MINUTES, type HandoverCard } from './handoverTypes'
import { isEnabled } from '../core/featureFlags'
import type { FeatureKey } from '../core/featureFlags'

let registered = false

/** feature flag：'handover.enabled' 未登记进 FeatureKey 联合类型（不改 featureFlags.ts），
 *  以断言方式读取；flag 未知时 isEnabled 回退 false（保守默认关）。 */
function flagEnabled(): boolean {
  try {
    return isEnabled('handover.enabled' as FeatureKey)
  } catch {
    return false
  }
}

/** 异步预取 todo 工具的内存待办（其 list 是 async 的，聚合本身保持同步签名） */
async function fetchTodos() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { todo } = require('../tools/impl/todo') as { todo: (a: Record<string, any>) => Promise<{ ok: boolean; content: string }> }
    const r = await todo({ action: 'list' })
    if (r && r.ok) {return parseTodoListText(r.content)}
  } catch { /* todo 不可用 → 空待办 */ }
  return []
}

export interface HandoverGenerateOpts {
  ttlMinutes?: number
  mode?: 'password' | 'machine'
  password?: string
  port?: number
}

export interface HandoverGenerateResult {
  ok: boolean
  disabled?: boolean
  error?: string
  card?: HandoverCard
  /** 文件落盘容器（.lumina-handover 内容） */
  container?: string
  exchangeCode?: string
  qrDataUrl?: string
  lanUrl?: string
  expiresAt?: number
  pendingCount?: number
}

export function registerHandoverIpc(getWindow: () => BrowserWindow | null): void {
  if (registered) {return}
  registered = true

  ipcMain.handle('handover:generate', async (_e, opts: HandoverGenerateOpts = {}): Promise<HandoverGenerateResult> => {
    if (!flagEnabled()) {return { ok: false, disabled: true, error: '交班模式未开启（feature flag: handover.enabled）' }}
    try {
      const mode = opts.mode === 'machine' ? 'machine' : 'password'
      const ttlMinutes = Math.max(1, Math.floor(opts.ttlMinutes || HANDOVER_DEFAULT_TTL_MINUTES))
      if (mode === 'password' && !opts.password) {
        return { ok: false, error: '口令模式下 password 不能为空' }
      }

      const todos = await fetchTodos()
      const card = buildHandoverCard({ todos: () => todos }, { ttlMinutes })

      // 交换条目 + 二维码：口令模式下发密文容器；本机密钥模式明文入内存（仅局域网）
      const port = opts.port || 3456
      let containerStr = ''
      let exchangeCode: string
      if (mode === 'machine') {
        const container = encryptCardWithMachineKey(card)
        containerStr = containerToString(container)
        exchangeCode = createExchange({ kind: 'plain-card', card }, ttlMinutes)
      } else {
        // 文件导出用 scrypt（Node 往返）；局域网下发用 pbkdf2（手机 WebCrypto 可解）
        containerStr = containerToString(encryptCardWithPassword(card, opts.password!, 'scrypt'))
        const lanContainer = encryptCardWithPassword(card, opts.password!, 'pbkdf2-sha256')
        exchangeCode = createExchange({ kind: 'pbkdf2-container', container: lanContainer }, ttlMinutes)
      }

      const payload = decideQrPayload({ card, exchangeCode, port })
      if (payload.kind !== 'url') {
        return { ok: false, error: '内部错误：二维码载荷决策异常' }
      }
      const qrDataUrl = await renderQrDataUrl(payload.url)
      return {
        ok: true,
        card,
        container: containerStr,
        exchangeCode,
        qrDataUrl,
        lanUrl: payload.url,
        expiresAt: card.expiresAt,
        pendingCount: card.pendingApprovals.length,
      }
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) }
    }
  })

  ipcMain.handle('handover:save', async (_e, payload: { container: string; suggestedName?: string }) => {
    if (!flagEnabled()) {return { ok: false, disabled: true }}
    try {
      const win = getWindow()
      const { canceled, filePath } = await dialog.showSaveDialog(win!, {
        defaultPath: payload.suggestedName || `lumina-handover-${new Date().toISOString().slice(0, 10)}.lumina-handover`,
        filters: [{ name: 'Lumina Handover', extensions: ['lumina-handover', 'json'] }],
      })
      if (canceled || !filePath) {return { ok: false, canceled: true }}
      fs.writeFileSync(filePath, payload.container, 'utf-8')
      return { ok: true, filePath }
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) }
    }
  })

  ipcMain.handle('handover:revoke', async (_e, payload: { code: string }) => {
    const deleted = revokeExchange(String(payload.code || ''))
    return { ok: deleted }
  })

  ipcMain.handle('handover:status', async () => {
    let pendingCount = 0
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { getApprovalService } = require('../approvalService')
      pendingCount = (getApprovalService().listPending() || []).length
    } catch { /* 审批服务不可用 */ }
    return {
      pendingCount,
      flagEnabled: flagEnabled(),
      activeExchanges: exchangeCount(),
      lanIp: firstLanIPv4(),
    }
  })
}
