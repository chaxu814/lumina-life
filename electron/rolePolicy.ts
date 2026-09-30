// ============================================================
// rolePolicy.ts — 角色 → 工具权限 唯一事实源 (Single Source of Truth)
//
// 权威角色口径（来自 AGENTS.md，禁止再漂移）：
//   lumina（Lumina）= 老大 / 唯一用户入口 / 全量调度 → 所有工具可用
//   yak（Yak）      = 代码工程师：写代码 / 调试 / 跑测试 / git 提交
//                     → 可写文件、可执行命令、可 git 提交（编码闭环）
//   recha（热茶）   = 审查员：代码审查 / 挑逻辑漏洞 / 错别字 / 风险评估
//                     → 只读：不写文件、不执行命令、不 git 提交
//
// 本模块是纯逻辑、无 Electron 运行时依赖，可直接单测。
// 广告层（agentRunner.getToolsForMode）与执行层（reactEngine 硬闸门）
// 都必须调用这里的判定，禁止再各自硬编码一份工具清单。
// ============================================================

export type RoleId = 'lumina' | 'yak' | 'recha'

export interface RolePolicy {
  /** 允许的真实工具名（空数组 = 不限制，仅 lumina） */
  allow: string[]
  /** 显式拒绝的工具名（优先级最高；即使误入 allow 也一律拒绝） */
  deny: string[]
}

// ═══════════════════════════════════════════════════════════
// 历史别名 → 真实工具名
//
// 旧 agent.json / 旧 profile 里写的是语义别名（write_code / debug ...），
// 真实工具注册表（tools/index.ts）里并没有这些名字。运行时拿到别名，
// 先经这里解析成真实名再判定，否则历史配置会被误判成「未登记工具」。
// ═══════════════════════════════════════════════════════════

const LEGACY_ALIAS: Record<string, string> = {
  // ── 写代码 / 执行类 ──
  write_code: 'file_write',
  edit_code: 'file_edit',
  debug: 'shell_exec',
  run_tests: 'shell_exec',
  shell: 'shell_exec',
  execute_command: 'shell_exec',
  // ── 只读 / 审查类（无副作用）──
  review_code: 'file_read',
  explain_code: 'file_read',
  find_bug: 'file_read',
  risk_assessment: 'file_read',   // 只读分析，无副作用
  read_file: 'file_read',
  write_file: 'file_write',
  edit_file: 'file_edit',
  list_files: 'file_list',
}

// ═══════════════════════════════════════════════════════════
// 角色工具策略
// ═══════════════════════════════════════════════════════════

/**
 * yak（代码工程师）的白名单 —— 保证「写代码闭环」：
 *   读 → 写 → 改 → 跑命令/测试 → git 提交 → 查资料。
 * 宁全勿缺：把编码/调试/检索会用到的真实工具名都放进来。
 * 明确不包含：桌面操控 / 邮件 / MCP / 委托流水线 / 图像生成 /
 *            前台通知等后台 worker 不该碰的工具（未命中即拒）。
 */
const YAK_ALLOW: string[] = [
  // 文件读写闭环
  'file_read', 'file_write', 'file_edit', 'file_list', 'file_search',
  'disk_list',
  // 检索（glob/grep 为语义名，未注册时自动不命中，无害）
  'glob_search', 'grep_search',
  // 执行 / 调试
  'shell_exec',
  // git（工程师可提交）
  'git_status', 'git_log', 'git_diff', 'git_commit',
  // 联网查资料
  'web_search', 'web_fetch', 'browser',
  // 系统 / 时间
  'datetime', 'system_info',
  // 任务 / 定时器（工程师自排活）
  'todo', 'cron_schedule', 'cron_list', 'cron_cancel',
  // 记忆（读写皆可）
  'memory_save', 'memory_get', 'memory_all', 'memory_search', 'memory_summarize',
  // 代码智能
  'ast_search', 'lsp_symbols', 'lsp_references',
  // 团队协作（读通知板 / 共享上下文；不再二次委托）
  'team_context', 'team_memory_search',
  'write_notice', 'read_notices', 'save_context', 'load_context',
]

/**
 * recha（审查员）的白名单 —— 只读：
 *   读代码 / 检索 / 看 git 历史差异 / 联网核对资料，然后给意见。
 * 明确不含：file_write / file_edit / shell_exec / git_commit（见 deny）。
 */
const RECHA_ALLOW: string[] = [
  // 文件只读
  'file_read', 'file_list', 'file_search',
  'disk_list',
  'glob_search', 'grep_search',
  // git 只读（审查历史 / diff，不提交）
  'git_status', 'git_log', 'git_diff',
  // 联网核对资料
  'web_search', 'web_fetch', 'browser',
  // 系统 / 时间
  'datetime', 'system_info',
  // 记忆只读检索
  'memory_search',
]

const ROLE_POLICY: Record<RoleId, RolePolicy> = {
  // lumina：空 allow = 全量放行，deny 也为空
  lumina: { allow: [], deny: [] },
  yak: {
    allow: YAK_ALLOW,
    // 后台 worker 不再二次委托 / 不跑流水线（即使 allow 漏网也拦下）
    deny: ['delegate_to', 'delegate_chain', 'hire_worker', 'adversarial_review'],
  },
  recha: {
    allow: RECHA_ALLOW,
    // 显式拒绝写 / 执行 / 提交（allow 未命中本就拒绝，这里写清原因）
    deny: ['file_write', 'file_edit', 'shell_exec', 'git_commit'],
  },
}

// ═══════════════════════════════════════════════════════════
// 判定函数
// ═══════════════════════════════════════════════════════════

/** 把任意角色字符串归一化为已知 RoleId；未知/缺省 → lumina（全放行） */
export function normalizeRole(role: string | undefined | null): RoleId {
  if (role === 'yak' || role === 'recha') {return role}
  return 'lumina'
}

/** 解析历史别名 → 真实工具名；不是别名则原样返回 */
export function resolveToolName(name: string): string {
  return LEGACY_ALIAS[name] ?? name
}

export interface PermissionVerdict {
  allowed: boolean
  reason: string
  /** 解析后的真实工具名（供日志 / 调试） */
  resolved: string
}

/**
 * 判断某角色是否被允许调用某工具。
 *
 * 顺序：解析别名 → 归一化角色 → deny 优先 → lumina 全放行 →
 *       allow 白名单命中放行，否则拒绝。
 */
export function isToolAllowedForRole(
  role: string | undefined | null,
  toolName: string,
): PermissionVerdict {
  const resolved = resolveToolName(toolName)
  const r = normalizeRole(role)
  const policy = ROLE_POLICY[r]

  // deny 优先级最高
  if (policy.deny.includes(resolved)) {
    return {
      allowed: false,
      resolved,
      reason: `角色 "${r}" 被显式禁止使用工具 "${resolved}"（denylist 优先）。`,
    }
  }

  // 空 allow = 不限制（仅 lumina）
  if (policy.allow.length === 0) {
    return { allowed: true, resolved, reason: `角色 "${r}" 为全量调度者，放行 "${resolved}"。` }
  }

  // 白名单命中
  if (policy.allow.includes(resolved)) {
    return { allowed: true, resolved, reason: `角色 "${r}" 白名单内工具 "${resolved}"，放行。` }
  }

  // 未命中 → 拒绝（受限角色按最小权限，不主动扩权）
  const aliasNote = resolved !== toolName ? `（由别名 "${toolName}" 解析而来）` : ''
  return {
    allowed: false,
    resolved,
    reason: `角色 "${r}" 的工具白名单未包含 "${resolved}"${aliasNote}，无权调用。这是只读/受限角色，禁止越权执行。`,
  }
}

/** 给定全量工具名，返回某角色被允许的子集 */
export function getAllowedToolsForRole(role: string | undefined | null, allToolNames: string[]): string[] {
  return allToolNames.filter(t => isToolAllowedForRole(role, t).allowed)
}

/**
 * 给定全量工具名，返回某角色应被过滤掉（disabled）的工具。
 * 供 worker Runner 的 disabledTools 使用：在已解析的 toolset 基础上，
 * 把该角色无权使用的工具一并剔除。
 */
export function getDisabledToolsForRole(role: string | undefined | null, allToolNames: string[]): string[] {
  return allToolNames.filter(t => !isToolAllowedForRole(role, t).allowed)
}

/** 某角色被显式 denylist 的工具（静态、不依赖注册表，供日志/展示） */
export function getExplicitDeniedTools(role: string | undefined | null): string[] {
  return [...ROLE_POLICY[normalizeRole(role)].deny]
}
