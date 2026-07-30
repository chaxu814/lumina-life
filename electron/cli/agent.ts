// ============================================================
// cli/agent.ts — CLI Agent 管理命令
// ============================================================

export async function handleAgent(args: string[]): Promise<{ ok: boolean; data?: any; error?: string }> {
  const subcmd = args[0]?.toLowerCase() || 'list'

  if (subcmd === 'list' || subcmd === 'ls') {
    const { getAgentConfig } = await import('../agentConfig')
    const config = getAgentConfig()
    const statuses = config.getAllStatus()
    const lines = statuses.map(s =>
      `  ${s.icon || '🤖'} ${s.id.padEnd(12)} ${s.name.padEnd(10)} ${s.configured ? '✅ 已配置' : '❌ 未配置'} 模型: ${s.model || '-'}`
    )
    return {
      ok: true,
      data: `Agent 状态:\n${lines.join('\n')}\n\n共 ${statuses.length} 个 Agent`,
    }
  }

  if (subcmd === 'status' && args.length >= 2) {
    const agentId = args[1]
    const { getAgentConfig } = await import('../agentConfig')
    const config = getAgentConfig()
    const allStatus = config.getAllStatus()
    const status = allStatus.find(s => s.id === agentId)
    if (!status) return { ok: false, error: `Agent "${agentId}" 不存在` }
    return {
      ok: true,
      data: `${status.icon || '🤖'} ${status.name} (${status.id})
  已配置: ${status.configured ? '✅' : '❌'}
  模型: ${status.model || '-'}
  供应商: ${status.provider || '-'}`,
    }
  }

  return { ok: false, error: `用法: lumina agent list | lumina agent status <agentId>` }
}
