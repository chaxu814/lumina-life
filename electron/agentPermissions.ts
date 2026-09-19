// ============================================================
// agentPermissions.ts — 权限声明 + 工具检查
// ============================================================

// AgentId 白名单
export type AgentId = 'lumina' | 'yak' | 'recha'

// 工具 + agent 权限映射
const PERMISSIONS: Record<AgentId, string[]> = {
  lumina: [],                       // 全量（空数组 = 无额外限制）
  yak: [
    'file_read', 'file_edit', 'file_write',
    'file_list', 'file_search', 'glob_search', 'grep_search',
    'disk_list', 'shell_exec',
  ],
  recha: [
    'file_read', 'file_list', 'file_search',
    'glob_search', 'grep_search', 'disk_list',
    'browser', 'web_fetch', 'web_search',
  ],
}

// 拒绝使用的工具（安全兜底）
const DENIED: Record<AgentId, Set<string>> = {
  lumina: new Set(),
  yak:   new Set(['mail_send', 'mail_read', 'computer_use', 'desktop_screenshot',
                  'mcp_call_tool', 'skill_install', 'cron_schedule', 'cron_cancel']),
  recha: new Set(['file_write', 'file_edit', 'shell_exec',
                  'mail_send', 'mail_read', 'computer_use',
                  'desktop_screenshot', 'cron_schedule', 'cron_cancel']),
}

export function getDisabledToolsForAgent(agentId: AgentId): string[] {
  const allowed = PERMISSIONS[agentId]
  const denied = DENIED[agentId]
  if (allowed.length === 0) {return Array.from(denied)}

  // 用小集合判断，远小于全量工具
  const set = new Set(allowed)
  return Array.from(denied).filter(t => !set.has(t))
}

export function enforceToolPermission(agentId: AgentId, toolName: string): boolean {
  if (DENIED[agentId].has(toolName)) {
    console.warn(`[Permission] ❌ ${agentId} 被禁止使用工具: ${toolName}`)
    return false
  }
  return true
}
