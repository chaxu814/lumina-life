// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// api/routes/approvals.ts — 审批队列 REST 端点
//
//   GET  /api/approvals              — 列出待审批操作
//   POST /api/approvals/:id/approve  — 批准
//   POST /api/approvals/:id/deny     — 拒绝
//
// 【为什么做】
//   手机远程访问（/m）需要「人不在电脑前也能批准权限」—— 这正是
//   同类桌宠做不到、而 Lumina 常驻架构应该做到的。审批走已有的
//   approvalService（与桌面端弹窗同一真相源），不另建一套。
// ============================================================

import type { IncomingMessage, ServerResponse } from 'http'
import type { ApprovalRequest } from '../../approvalTypes'

/** 手机端只需要的字段子集 */
interface ApprovalView {
  id: string
  toolName: string
  description: string
  riskLevel: string
  threatCategories: string[]
  agentId: string
  sessionId: string
  createdAt: number
  timeoutMs: number
  elapsedMs: number
}

/** approvalService 的最小接口（避免顶层 import 造成循环依赖，用类型约束） */
interface ApprovalServiceLike {
  listPending?: () => ApprovalRequest[]
  approve: (id: string, note?: string) => ApprovalRequest | null
  deny: (id: string, note?: string) => ApprovalRequest | null
  executionLevel: unknown
}

interface ApprovalRequestBody {
  note?: string
}

function writeJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data, null, 2))
}

/** 归一化一条待审批项，只暴露手机端需要的字段 */
function project(r: ApprovalRequest): ApprovalView {
  return {
    id: r.id,
    toolName: r.toolName,
    description: r.description,
    riskLevel: r.riskLevel,
    threatCategories: r.threatCategories || [],
    agentId: r.agentId,
    sessionId: r.sessionId,
    createdAt: r.createdAt,
    timeoutMs: r.timeoutMs,
    elapsedMs: r.elapsedMs,
  }
}

export async function handleApprovalsRoute(
  _req: IncomingMessage,
  res: ServerResponse,
  match: RegExpExecArray,
  body: ApprovalRequestBody | null,
): Promise<void> {
  try {
    const mod = await import('../../approvalService')
    const svc = mod.getApprovalService() as unknown as ApprovalServiceLike

    // /api/approvals/:id/approve | /deny
    const action = match[2] // 'approve' | 'deny' | undefined
    if (action) {
      const id = decodeURIComponent(match[1])
      const note = body?.note || '来自手机端'
      if (action === 'approve') {
        const r = svc.approve(id, note)
        if (!r) {return writeJson(res, 404, { error: `未找到待审批项 "${id}" 或已过期` })}
        return writeJson(res, 200, { ok: true, approved: project(r) })
      }
      const r = svc.deny(id, note)
      if (!r) {return writeJson(res, 404, { error: `未找到待审批项 "${id}" 或已过期` })}
      return writeJson(res, 200, { ok: true, denied: project(r) })
    }

    // GET /api/approvals
    const pending = (svc.listPending?.() || []).map(project)
    return writeJson(res, 200, {
      ok: true,
      count: pending.length,
      executionLevel: svc.executionLevel,
      pending,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return writeJson(res, 500, { error: `审批服务不可用: ${msg}` })
  }
}
