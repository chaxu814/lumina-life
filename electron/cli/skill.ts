// ============================================================
// cli/skill.ts — CLI 技能管理命令
// ============================================================

export async function handleSkill(args: string[]): Promise<{ ok: boolean; data?: any; error?: string }> {
  const subcmd = args[0]?.toLowerCase() || 'list'

  if (subcmd === 'list' || subcmd === 'ls') {
    try {
      const { getSkillPool } = await import('../skillPool')
      const pool = getSkillPool()
      const skills = pool.listAllSkills()
      if (!skills || skills.length === 0) {
        return { ok: true, data: '未安装任何技能。' }
      }
      const lines = skills.map((s: any) =>
        `  ${s.name || '?'} v${s.version || '?'} — ${s.description || '无描述'}`
      )
      return { ok: true, data: `已安装技能 (${skills.length}):\n${lines.join('\n')}` }
    } catch (err: any) {
      return { ok: true, data: `技能读取不可用 (${err.message})` }
    }
  }

  if (subcmd === 'install' && args.length >= 2) {
    const path = args[1]
    try {
      const { getSkillPool } = await import('../skillPool')
      const pool = getSkillPool()
      const result = await pool.installFromZip(path)
      return { ok: true, data: `技能已安装: ${result.skill?.name || path}` }
    } catch (err: any) {
      return { ok: false, error: `安装失败: ${err.message}` }
    }
  }

  return { ok: false, error: `用法: lumina skill list | lumina skill install <path>` }
}
