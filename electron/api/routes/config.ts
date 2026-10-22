// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// api/routes/config.ts — GET/PUT /api/config
// ============================================================

import type { IncomingMessage, ServerResponse } from 'http'

export async function handleConfigRoute(
  req: IncomingMessage,
  res: ServerResponse,
  _match: RegExpExecArray,
  body: any,
): Promise<void> {
  try {
    if (req.method === 'GET') {
      // 返回审批服务和 Agent 配置摘要
      const { getApprovalService } = await import('../../approvalService')
      const { getAgentConfig } = await import('../../agentConfig')

      const approval = getApprovalService()
      const agentCfg = getAgentConfig()

      writeJson(res, 200, {
        ok: true,
        approval: approval.getConfig(),
        agents: agentCfg.getAllStatus(),
        pending_approvals: approval.pendingCount,
      })
      return
    }

    if (req.method === 'PUT') {
      // 更新配置
      const { getApprovalService } = await import('../../approvalService')
      const approval = getApprovalService()

      if (body.approval) {
        approval.updateConfig(body.approval)
      }

      writeJson(res, 200, { ok: true, message: '配置已更新' })
      return
    }

    writeJson(res, 405, { error: '不支持的方法' })
  } catch (err: any) {
    writeJson(res, 500, { error: err.message })
  }
}

function writeJson(res: ServerResponse, status: number, data: any): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data, null, 2))
}
