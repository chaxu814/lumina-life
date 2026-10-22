// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// routes/deepResearch.ts — 🔬 深度调研 API 路由 (Phase C)
// ============================================================

import { getDeepResearch } from '../../deepResearch'
import type { ApiConfig } from '../server'

/** POST /api/deep-research — 发起深度调研 */
export async function handleDeepResearchRoute(
  _req: any,
  res: any,
  _match: any,
  body: any,
  _config: ApiConfig,
): Promise<void> {
  const question = body?.question?.trim()
  if (!question) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: '请提供 question 参数' }))
    return
  }

  const maxIterations = Math.min(Math.max(Number(body?.max_iterations) || 5, 2), 15)

  try {
    const dr = getDeepResearch()
    const report = await dr.research(question)

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({
      success: true,
      data: report,
      meta: {
        question,
        maxIterations,
        generatedAt: new Date().toISOString(),
      },
    }, null, 2))
  } catch (err: any) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: `深度调研失败: ${err.message}` }))
  }
}

/** GET /api/deep-research — 检查 Deep Research 状态 */
export async function handleDeepResearchStatusRoute(
  _req: any,
  res: any,
): Promise<void> {
  try {
    const dr = getDeepResearch()
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({
      success: true,
      available: true,
      engine: 'DeepResearch v3.11',
    }))
  } catch {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({
      success: true,
      available: false,
    }))
  }
}
