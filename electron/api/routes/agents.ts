// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// api/routes/agents.ts — GET /api/agents[/:id]
// ============================================================

import type { IncomingMessage, ServerResponse } from 'http'

export async function handleAgentsRoute(
  _req: IncomingMessage,
  res: ServerResponse,
  match: RegExpExecArray,
  _body: any,
): Promise<void> {
  try {
    const { getAgentConfig } = await import('../../agentConfig')
    const config = getAgentConfig()

    // GET /api/agents/:id — 单个 Agent
    if (match[1]) {
      const agentId = match[1]
      const allStatus = config.getAllStatus()
      const status = allStatus.find(s => s.id === agentId)
      if (!status) {
        writeJson(res, 404, { error: `Agent "${agentId}" 不存在` })
        return
      }
      writeJson(res, 200, { ok: true, agent: status })
      return
    }

    // GET /api/agents — 全部 Agent
    const statuses = config.getAllStatus()
    writeJson(res, 200, { ok: true, agents: statuses, count: statuses.length })
  } catch (err: any) {
    writeJson(res, 500, { error: err.message })
  }
}

function writeJson(res: ServerResponse, status: number, data: any): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data, null, 2))
}
