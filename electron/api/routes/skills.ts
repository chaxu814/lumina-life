// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// api/routes/skills.ts — GET /api/skills
// ============================================================

import type { IncomingMessage, ServerResponse } from 'http'

export async function handleSkillsRoute(
  _req: IncomingMessage,
  res: ServerResponse,
  _match: RegExpExecArray,
  _body: any,
): Promise<void> {
  try {
    const { getSkillPool } = await import('../../skillPool')
    const pool = getSkillPool()
    const skills = pool.listAllSkills() || []
    writeJson(res, 200, { ok: true, skills, count: skills.length })
  } catch (err: any) {
    writeJson(res, 200, { ok: true, skills: [], count: 0, note: `技能系统不可用 (${err.message})` })
  }
}

function writeJson(res: ServerResponse, status: number, data: any): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data, null, 2))
}
