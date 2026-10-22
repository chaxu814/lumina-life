// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// api/routes/tools.ts — POST /api/tools/execute
// ============================================================

import type { IncomingMessage, ServerResponse } from 'http'

export async function handleToolsRoute(
  _req: IncomingMessage,
  res: ServerResponse,
  _match: RegExpExecArray,
  body: any,
): Promise<void> {
  const toolName = body?.tool
  if (!toolName) {
    writeJson(res, 400, { error: '缺少 tool 字段' })
    return
  }

  const toolArgs = body?.args || {}

  try {
    const { executeTool, getToolNames } = await import('../../tools/registry')

    // 检查工具是否存在
    const names = getToolNames()
    if (!names.has(toolName)) {
      writeJson(res, 404, {
        error: `工具 "${toolName}" 不存在`,
        available_tools: [...names].sort(),
      })
      return
    }

    const result = await executeTool(toolName, toolArgs)

    if (result.ok) {
      writeJson(res, 200, { ok: true, content: result.content })
    } else {
      writeJson(res, 500, { ok: false, error: result.error || '工具执行失败' })
    }
  } catch (err: any) {
    writeJson(res, 500, { error: `工具执行异常: ${err.message}` })
  }
}

function writeJson(res: ServerResponse, status: number, data: any): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data, null, 2))
}
