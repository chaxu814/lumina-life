// ============================================================
// cli/cron.ts — CLI 定时任务管理命令
// ============================================================

export async function handleCron(args: string[]): Promise<{ ok: boolean; data?: any; error?: string }> {
  const subcmd = args[0]?.toLowerCase() || 'list'

  if (subcmd === 'list' || subcmd === 'ls') {
    try {
      const { getCronStats } = await import('../tools/impl/cron')
      const stats = getCronStats()
      if (stats.entryCount === 0) return { ok: true, data: '暂无定时任务。' }
      const lines = stats.entries.map((t: any) =>
        `  ${t.id} ${t.name || '?'} | 调度: ${t.schedule || '?'} | ${t.enabled ? '✅ 启用' : '⏸️ 暂停'} | 操作: ${(t.action || '').slice(0, 50)}`
      )
      return { ok: true, data: `定时任务 (${stats.entryCount}):\n${lines.join('\n')}` }
    } catch (err: any) {
      return { ok: true, data: `定时任务读取不可用 (${err.message})` }
    }
  }

  if (subcmd === 'add' || subcmd === 'create') {
    const parsed = parseKeyValue(args.slice(1))
    const schedule = parsed.schedule || parsed.s
    const action = parsed.action || parsed.a
    const name = parsed.name || parsed.n || 'CLI 任务'

    if (!schedule || !action) {
      return { ok: false, error: '必须提供 --schedule 和 --action' }
    }

    try {
      const { cronSchedule } = await import('../tools/impl/cron')
      const result = await cronSchedule({ name, schedule, action })
      return { ok: true, data: `定时任务已创建: "${name}" (${schedule})` }
    } catch (err: any) {
      return { ok: false, error: `创建失败: ${err.message}` }
    }
  }

  if ((subcmd === 'remove' || subcmd === 'rm' || subcmd === 'delete') && args.length >= 2) {
    const taskId = parseInt(args[1], 10)
    try {
      const { cronCancel } = await import('../tools/impl/cron')
      const result = await cronCancel({ id: taskId })
      return { ok: true, data: `定时任务 ${taskId} 已删除` }
    } catch (err: any) {
      return { ok: false, error: `删除失败: ${err.message}` }
    }
  }

  return { ok: false, error: `用法: lumina cron list | lumina cron add --schedule "0 9 * * *" --action "..."` }
}

function parseKeyValue(args: string[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2)
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        result[key] = args[i + 1]
        i++
      } else {
        result[key] = 'true'
      }
    }
  }
  return result
}
