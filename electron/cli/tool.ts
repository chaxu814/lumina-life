// ============================================================
// cli/tool.ts — CLI 工具执行命令
// ============================================================

export async function handleTool(args: string[]): Promise<{ ok: boolean; data?: any; error?: string }> {
  if (args.length === 0 || args[0] === '--help') {
    return {
      ok: true,
      data: `用法: lumina tool run <工具名> [--key value ...]

示例:
  lumina tool run web_search --q "今天天气"
  lumina tool run shell_exec --command "dir"
  lumina tool run get_current_time
  lumina tool list`,
    }
  }

  const subcmd = args[0].toLowerCase()

  // lumina tool list
  if (subcmd === 'list' || subcmd === 'ls') {
    const { getToolNames } = await import('../tools/registry')
    const names = getToolNames()
    const namesArray = [...names]
    return { ok: true, data: `可用工具 (${namesArray.length}):\n  ${namesArray.sort().join('\n  ')}` }
  }

  // lumina tool run <name> [args...]
  if (subcmd === 'run' && args.length >= 2) {
    const toolName = args[1]
    const toolArgs = parseKeyValueArgs(args.slice(2))

    const { executeTool } = await import('../tools/registry')
    const result = await executeTool(toolName, toolArgs)

    if (result.ok) {
      return { ok: true, data: result.content || '(空结果)' }
    } else {
      return { ok: false, error: result.error || '工具执行失败' }
    }
  }

  // lumina tool <name> [key=value...] (便捷模式)
  const { getToolNames, executeTool } = await import('../tools/registry')
  const names = getToolNames()
  if (names.has(subcmd)) {
    const toolArgs = parseKeyValueArgs(args.slice(1))
    const result = await executeTool(subcmd, toolArgs)
    if (result.ok) {
      return { ok: true, data: result.content || '(空结果)' }
    } else {
      return { ok: false, error: result.error || '工具执行失败' }
    }
  }

  return { ok: false, error: `未知子命令: ${subcmd}。可用: list, run, 或直接使用工具名` }
}

function parseKeyValueArgs(args: string[]): Record<string, any> {
  const result: Record<string, any> = {}
  for (const arg of args) {
    const eqIdx = arg.indexOf('=')
    if (eqIdx > 0) {
      const key = arg.slice(0, eqIdx).replace(/^--/, '')
      result[key] = arg.slice(eqIdx + 1)
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2)
      result[key] = true
    }
  }
  return result
}
