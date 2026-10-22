// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// api/routes/memory.ts — GET /api/memory[/search]
// ============================================================

import type { IncomingMessage, ServerResponse } from 'http'
import * as url from 'url'

export async function handleMemoryRoute(
  req: IncomingMessage,
  res: ServerResponse,
  match: RegExpExecArray,
  _body: any,
): Promise<void> {
  const parsedUrl = url.parse(req.url || '', true)
  const query = (parsedUrl.query?.q as string) || ''
  const limit = parseInt((parsedUrl.query?.limit as string) || '20')

  try {
    const { getMemoryStore } = await import('../../memory/memoryStore')
    const store = getMemoryStore()

    // GET /api/memory/search?q=xxx
    if (match[0].includes('/search')) {
      if (!query) {
        writeJson(res, 400, { error: '请提供搜索关键词 (q=)' })
        return
      }
      const results = store.searchFacts(query, limit)
      writeJson(res, 200, {
        ok: true,
        results: results || [],
        count: results?.length || 0,
        query,
      })
      return
    }

    // GET /api/memory — 列出所有记忆
    const memories = store.getFacts()
    const sliced = memories.slice(0, limit)
    writeJson(res, 200, {
      ok: true,
      memories: sliced,
      count: sliced.length,
      total: memories.length,
    })
  } catch (err: any) {
    writeJson(res, 200, { ok: true, memories: [], count: 0, note: `记忆系统不可用 (${err.message})` })
  }
}

function writeJson(res: ServerResponse, status: number, data: any): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data, null, 2))
}
