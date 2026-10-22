// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// api/routes/health.ts — GET /api/health
// ============================================================

import type { IncomingMessage, ServerResponse } from 'http'

export async function handleHealthRoute(
  _req: IncomingMessage,
  res: ServerResponse,
  _match: RegExpExecArray,
  _body: any,
): Promise<void> {
  const status: Record<string, any> = {
    ok: true,
    name: 'Lumina Life',
    version: '1.0.0',
    node: process.versions.node,
    electron: process.versions.electron,
    platform: process.platform,
    arch: process.arch,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  }

  // 尝试获取额外的运行状态
  try {
    const { getApprovalService } = await import('../../approvalService')
    const approval = getApprovalService()
    status.approval = {
      level: approval.executionLevel,
      pending: approval.pendingCount,
      locale: approval.locale,
    }
  } catch {
    status.approval = { available: false }
  }

  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(status, null, 2))
}
