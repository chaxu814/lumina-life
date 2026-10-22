// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// api/routes/cron.ts — CRUD /api/cron[/:id]
// ============================================================

import type { IncomingMessage, ServerResponse } from 'http'

export async function handleCronRoute(
  req: IncomingMessage,
  res: ServerResponse,
  match: RegExpExecArray,
  body: any,
): Promise<void> {
  try {
    const { getCronStats, cronSchedule, cronCancel } = await import('../../tools/impl/cron')

    // DELETE /api/cron/:id
    if (req.method === 'DELETE' && match[1]) {
      const taskId = parseInt(match[1], 10)
      const result = await cronCancel({ id: taskId })
      if (result.ok) {
        writeJson(res, 200, { ok: true, message: `定时任务 ${taskId} 已删除` })
      } else {
        writeJson(res, 500, { ok: false, error: result.error || '删除失败' })
      }
      return
    }

    // POST /api/cron — 创建
    if (req.method === 'POST') {
      const schedule = body?.schedule
      const action = body?.action
      const name = body?.name || 'API 任务'

      if (!schedule || !action) {
        writeJson(res, 400, { error: '必须提供 schedule 和 action' })
        return
      }

      const result = await cronSchedule({ name, schedule, action })
      writeJson(res, 200, { ok: true, result, message: `定时任务已创建` })
      return
    }

    // GET /api/cron — 列出
    const stats = getCronStats()
    writeJson(res, 200, { ok: true, tasks: stats.entries, count: stats.entryCount })
  } catch (err: any) {
    writeJson(res, 500, { error: err.message })
  }
}

function writeJson(res: ServerResponse, status: number, data: any): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data, null, 2))
}
