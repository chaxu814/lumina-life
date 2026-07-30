// ============================================================
// cli/config.ts — CLI 配置管理命令
// ============================================================

export async function handleConfig(args: string[]): Promise<{ ok: boolean; data?: any; error?: string }> {
  const subcmd = args[0]?.toLowerCase() || 'show'

  if (subcmd === 'show' || subcmd === 'get') {
    try {
      // 显示 Agent 配置和审批配置
      const { getAgentConfig } = await import('../agentConfig')
      const { getApprovalService } = await import('../approvalService')

      const agentCfg = getAgentConfig()
      const approval = getApprovalService()

      const result = {
        agents: agentCfg.getAllStatus(),
        approval: approval.getConfig(),
      }
      return { ok: true, data: JSON.stringify(result, null, 2) }
    } catch (err: any) {
      return { ok: true, data: `配置读取失败: ${err.message}` }
    }
  }

  if (subcmd === 'set' && args.length >= 2) {
    const kv = args[1]
    const eqIdx = kv.indexOf('=')
    if (eqIdx < 0) return { ok: false, error: '格式错误。使用: config set key=value' }

    const key = kv.slice(0, eqIdx)
    const value = kv.slice(eqIdx + 1)
    try {
      // 尝试写入 .env
      const fs = await import('fs')
      const path = await import('path')
      const envPath = path.join(process.cwd(), '.env')
      let envContent = ''
      try { envContent = fs.readFileSync(envPath, 'utf-8') } catch { /* 文件不存在 */ }

      const lines = envContent.split('\n')
      const keyIdx = lines.findIndex(l => l.startsWith(`${key}=`))
      if (keyIdx >= 0) {
        lines[keyIdx] = `${key}=${value}`
      } else {
        lines.push(`${key}=${value}`)
      }
      fs.writeFileSync(envPath, lines.join('\n'))
      return { ok: true, data: `已设置 ${key}=${value}` }
    } catch (err: any) {
      return { ok: false, error: `写入失败: ${err.message}` }
    }
  }

  return { ok: false, error: `用法: lumina config show | lumina config set key=value` }
}
