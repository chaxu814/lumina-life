// ============================================================
// cli/memory.ts — CLI 记忆查询命令
// ============================================================

export async function handleMemory(args: string[]): Promise<{ ok: boolean; data?: any; error?: string }> {
  const subcmd = args[0]?.toLowerCase() || 'search'

  if (subcmd === 'search' && args.length >= 2) {
    const query = args.slice(1).join(' ')
    try {
      const { getMemoryStore } = await import('../memory/memoryStore')
      const store = getMemoryStore()
      const results = store.searchFacts(query)
      if (!results || results.length === 0) {
        return { ok: true, data: '没有找到相关记忆。' }
      }
      const lines = results.map((r: any, i: number) =>
        `  ${i + 1}. [${r.category || 'general'}] ${r.content?.slice(0, 120) || '(空)'} (置信度: ${r.confidence ?? '-'})`
      )
      return { ok: true, data: `记忆搜索结果:\n${lines.join('\n')}` }
    } catch (err: any) {
      return { ok: true, data: `记忆搜索不可用 (${err.message})` }
    }
  }

  if (subcmd === 'list' || subcmd === 'ls') {
    const limit = parseInt(parseArgValue(args, '--limit', '10'))
    try {
      const { getMemoryStore } = await import('../memory/memoryStore')
      const store = getMemoryStore()
      const memories = store.getFacts()
      const sliced = memories.slice(0, limit)
      if (sliced.length === 0) return { ok: true, data: '暂无记忆。' }
      const lines = sliced.map((m: any, i: number) =>
        `  ${i + 1}. [${m.category || '?'}] ${(m.content || '').slice(0, 100)}`
      )
      return { ok: true, data: `记忆列表 (共 ${memories.length} 条，显示前 ${sliced.length} 条):\n${lines.join('\n')}` }
    } catch (err: any) {
      return { ok: true, data: `记忆读取不可用 (${err.message})` }
    }
  }

  return { ok: false, error: `用法: lumina memory search <query> | lumina memory list [--limit N]` }
}

function parseArgValue(args: string[], key: string, defaultVal: string): string {
  const idx = args.indexOf(key)
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1]
  return defaultVal
}
