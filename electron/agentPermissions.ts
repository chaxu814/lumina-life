// ============================================================
// agentPermissions.ts — 权限声明 + 工具检查
// ============================================================

// AgentId 白名单
export type AgentId = 'lumina' | 'yak' | 'recha'

// 工具 + agent 权限映射
//
// ⚠️ 角色口径（与 accessControl.ts 的 DEFAULT_PERMISSIONS 必须一致）
//   recha（热茶）= 程序员        → 白名单含 file_write/file_edit/shell_exec
//   yak（Yak）  = 数据分析师兼审查员 → 只读，不给任何写类/执行类工具
// 历史版本这里是反的：审查员能写文件、程序员反而被禁止写文件，
// 结果就是「写代码的人没工具，有工具的人不写代码」。修这个 bug 时两张表要一起看。
const PERMISSIONS: Record<AgentId, string[]> = {
  lumina: [],                       // 全量（空数组 = 无额外限制）
  recha: [
    // 写 + 执行（程序员）
    'file_read', 'file_edit', 'file_write',
    'file_list', 'file_search', 'glob_search', 'grep_search',
    'disk_list', 'shell_exec',
    // 只读检索
    'browser', 'web_fetch', 'web_search',
  ],
  yak: [
    // 只读（审查员/数据分析师）
    'file_read', 'file_list', 'file_search',
    'glob_search', 'grep_search', 'disk_list',
    'browser', 'web_fetch', 'web_search',
  ],
}

// 拒绝使用的工具（安全兜底）
const DENIED: Record<AgentId, Set<string>> = {
  lumina: new Set(),
  recha: new Set(['mail_send', 'mail_read', 'computer_use', 'desktop_screenshot',
                  'mcp_call_tool', 'skill_install', 'cron_schedule', 'cron_cancel']),
  yak:   new Set(['file_write', 'file_edit', 'shell_exec',      // ❌ 只审不改：不写文件、不跑命令
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
