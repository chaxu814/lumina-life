// ============================================================
// permission/permissionTier.ts — 三档权限（后端强制）
//
// 【为什么要有这个】
// 项目原本只有两个正交的开关，而且**都是无效的**：
//   · 渲染进程的 `securityConfig.sandboxMode`（安全面板里的「沙箱防护」）
//     —— grep 全仓，`electron/` 里**零引用**。UI 上写着「🛡️ 沙箱防护已开启」，
//     把它关掉，工具执行行为一点都不变。典型的「看起来有安全其实没有」。
//   · `approvalService` 的 `ToolExecutionLevel`（STRICT/SMART/AUTO/OFF）
//     —— 这个是真的，但它是「审批激进度」，不是用户能理解的能力边界。
//     「SMART」这个词对普通用户没有任何意义。
//
// 所以这里做的是**能力边界**，不是审批激进度：
//   仅可查看   —— 只能读。不能写文件、不能执行命令、不能动鼠标。
//   工作区内修改 —— 能在【一个指定根目录】内读写；命令/鼠标/网络写操作仍需审批。
//   完全权限   —— 不再逐步审批，但 **BLOCK 级硬拦截依然生效**（见下方说明）。
//
// 【完全权限为什么不「真的完全」】
// sandboxRules 里有一批 `Severity.BLOCK` 规则：rm -rf /、fork 炸弹、删系统目录、
// 格式化磁盘。这些不是「危险但用户可能想要」的操作，它们是**误操作就会不可逆
// 丢数据**的操作。Claude Code 的 --dangerously-skip-permissions 也保留了
// 一层 hard deny。我们这层不提供关闭开关 —— 一个 Agent 助手不应该有
// 「一键把 C:\ 格式化掉」的路径。
//
// **这是一处刻意的、可以被讨论的取舍。** 如果你认为它该可关，改 `HARD_BLOCK_ALWAYS`
// 这一个常量即可，全局行为随之改变，不要散落到各处。
// ============================================================

import * as path from 'path'
import * as os from 'os'

// ═══════════════════════════════════════════════════════════
// 档位定义
// ═══════════════════════════════════════════════════════════

export enum PermissionTier {
  /** 仅可查看：只读工具 */
  READ_ONLY = 'read_only',
  /** 工作区内修改：根目录内可写，越界需审批 */
  WORKSPACE_WRITE = 'workspace_write',
  /** 完全权限：免审批（但硬拦截仍在） */
  FULL = 'full',
}

export const PERMISSION_TIERS: PermissionTier[] = [
  PermissionTier.READ_ONLY,
  PermissionTier.WORKSPACE_WRITE,
  PermissionTier.FULL,
]

export const TIER_META: Record<PermissionTier, { label: string; short: string; desc: string; color: string }> = {
  [PermissionTier.READ_ONLY]: {
    label: '仅可查看',
    short: '👁 仅查看',
    desc: '只读不改。她可以看文件、读网页、回答问题，但不会写入或执行任何东西。',
    color: '#64748b',
  },
  [PermissionTier.WORKSPACE_WRITE]: {
    label: '工作区内修改',
    short: '📁 工作区内修改',
    desc: '可以在工作目录内创建和修改文件；执行命令、操控鼠标、访问工作区外仍需你点头。',
    color: '#2563eb',
  },
  [PermissionTier.FULL]: {
    label: '完全权限',
    short: '⚡ 完全权限',
    desc: '不再逐步确认，直接执行更多操作，包括敏感操作、文件修改与外部命令。仅建议在信任当前任务时使用。',
    color: '#dc2626',
  },
}

/** 档位的安全强度，越大越严 */
export function tierScore(tier: PermissionTier): number {
  switch (tier) {
    case PermissionTier.READ_ONLY: return 0
    case PermissionTier.WORKSPACE_WRITE: return 1
    case PermissionTier.FULL: return 2
  }
}

export function parseTier(value: unknown): PermissionTier {
  if (typeof value !== 'string') {return PermissionTier.WORKSPACE_WRITE}
  const v = value.trim().toLowerCase()
  if (v === 'read_only' || v === 'readonly' || v === 'view') {return PermissionTier.READ_ONLY}
  if (v === 'full' || v === 'bypass' || v === 'danger') {return PermissionTier.FULL}
  return PermissionTier.WORKSPACE_WRITE
}

// ═══════════════════════════════════════════════════════════
// 工具能力分类
// ═══════════════════════════════════════════════════════════

/**
 * 工具的副作用等级。
 *   read   —— 纯读，无副作用
 *   write  —— 写文件 / 改状态
 *   exec   —— 执行命令 / 跑代码
 *   gui    —— 操控鼠标键盘 / 点界面
 *   net    —— 对外发送（发消息、发邮件、提交表单）
 *   secret —— 触碰凭证类文件
 */
export type ToolEffect = 'read' | 'write' | 'exec' | 'gui' | 'net' | 'secret'

/**
 * 工具 → 副作用等级。
 *
 * ⚠️ 维护约定：**新增工具时必须在这里登记**，否则 `classifyTool` 会返回
 * `'write'`（保守默认，宁可多问一次也不放过）。这个「默认从严」是刻意的。
 * 工具名与 electron/tools/impl/ 下的实现保持一致。
 */
const TOOL_EFFECTS: Record<string, ToolEffect> = {
  // ── 读 ──
  file_read: 'read', file_list: 'read', file_search: 'read', file_search_smart: 'read',
  weather: 'read', web_fetch: 'read', web_search: 'read', web_search_multi: 'read',
  memory_get: 'read', memory_all: 'read', memory_search: 'read', memory_summarize: 'read',
  calendar_list: 'read', calendar_free: 'read',
  desktop_tidy_scan: 'read', desktop_tidy_plan: 'read',
  skill_search: 'read',
  code_review_smart: 'read', lsp_definition: 'read', lsp_references: 'read',
  git_status: 'read', git_log: 'read', git_diff: 'read', git_branch: 'read',
  news_digest: 'read', cron_list: 'read', sandbox_get_audit_log: 'read',
  browser_snapshot: 'read', screenshot: 'read', ocr: 'read', desktop_screenshot: 'read',

  // ── 写 ──
  file_write: 'write', file_edit: 'write', file_move: 'write', file_delete: 'write',
  memory_save: 'write', memory_delete: 'write',
  calendar_add: 'write', calendar_remove: 'write',
  desktop_tidy: 'write',
  skill_install: 'write',
  cron_schedule: 'write', cron_cancel: 'write',
  notification: 'write',
  lsp_format: 'write', lsp_rename: 'write',

  // ── 执行 ──
  shell_exec: 'exec', code_exec: 'exec', lsp_diagnostics_fix: 'exec',
  game_action: 'exec', mcp_call: 'exec',

  // ── GUI ──
  desktop_act: 'gui', computer_use: 'gui', browser_click_smart: 'gui',
  browser_type: 'gui', browser_press: 'gui', desktop_type: 'gui', desktop_key: 'gui',

  // ── 外发 ──
  mail_send: 'net', smtp_send: 'net', imap_send: 'net',
  channel_send: 'net', social_post: 'net', http_post: 'net',
  form_submit: 'net', browser_evaluate: 'net',

  // ── 凭证 ──
  read_env: 'secret', get_api_key: 'secret', credential_read: 'secret',
}

export function classifyTool(toolName: string): ToolEffect {
  return TOOL_EFFECTS[toolName] ?? 'write' // 未知工具按「写」处理，宁可多问
}

/** 这个工具有哪些参数可能携带文件路径（用于工作区校验） */
const PATH_ARG_KEYS = ['path', 'file', 'filePath', 'file_path', 'target', 'dest', 'destination', 'source', 'src', 'dir', 'directory']

export function extractPaths(args: Record<string, unknown>): string[] {
  const out: string[] = []
  for (const key of PATH_ARG_KEYS) {
    const v = args?.[key]
    if (typeof v === 'string' && v.trim()) { out.push(v) }
  }
  return out
}

// ═══════════════════════════════════════════════════════════
// 决策结果
// ═══════════════════════════════════════════════════════════

export type PermissionDecision =
  /** 直接放行 */
  | { action: 'allow'; reason: string }
  /** 需要用户逐次确认（走 approvalService） */
  | { action: 'ask'; reason: string; risk: 'medium' | 'high' | 'critical'; category: string }
  /** 硬拦截，不可放行 */
  | { action: 'deny'; reason: string; category: string }

export interface PermissionContext {
  tier: PermissionTier
  /** 「工作区」根目录。null = 未配置 → 工作区档退化为「所有写操作都需审批」 */
  workspaceRoot: string | null
  /** 工具参数 —— 工作区边界判定靠它。漏传会让边界检查完全失效。 */
  args?: Record<string, unknown>
  /** 命令文本（exec 类工具用） */
  command?: string
  /** 工具名（进审计日志） */
  toolName: string
  /** 谁在调用：lumina / yak / recha / 子代理 */
  agentId?: string
}

// ═══════════════════════════════════════════════════════════
// 路径判定
// ═══════════════════════════════════════════════════════════

/** Windows 路径大小写不敏感；统一小写比较 */
function norm(p: string): string {
  const s = path.resolve(p)
  return process.platform === 'win32' ? s.toLowerCase() : s
}

/** 目标是否在 root 之内（含 root 本身） */
export function isInside(root: string, target: string): boolean {
  const r = norm(root)
  const t = norm(target)
  if (r === t) {return true}
  const withSep = r.endsWith(path.sep) ? r : r + path.sep
  return t.startsWith(withSep)
}

/** 未配置工作区时的默认根：用户主目录下的 Lumina 工作区 */
export function defaultWorkspaceRoot(): string {
  return path.join(os.homedir(), 'LuminaWorkspace')
}

// ═══════════════════════════════════════════════════════════
// 核心判定
// ═══════════════════════════════════════════════════════════

/**
 * 某档位下，这次工具调用能不能做。
 *
 * 纯函数：不读文件、不发 IPC、可单测。这是整个权限体系的**唯一裁决点**，
 * reactEngine 在 `securityGuard` 之后、`rolePolicy` 之前调用它。
 */
export function decide(ctx: PermissionContext): PermissionDecision {
  const { tier, toolName, command } = ctx
  const effect = classifyTool(toolName)
  const agent = ctx.agentId ? `（${ctx.agentId}）` : ''

  // ── 完全权限：只放行，但仍走一次 BLOCK 级硬拦截 ──
  if (tier === PermissionTier.FULL) {
    // 🔒 凭证类工具在任何档位下都不放行。
    // 「完全权限」解决的是「不想逐步确认」，不是「允许把 API Key 读出来」。
    // LLM 读到明文 Key 就会把它写进日志 / 记忆 / 外发请求 —— 那是最难挽回的一类泄露，
    // 而且没有任何一个正常任务需要它。所以这里没有开关可关。
    if (effect === 'secret') {
      return { action: 'deny', reason: `完全权限${agent}：仍不允许读取凭证`, category: 'CREDIT_LEAK' }
    }
    if (command) {
      // 递归删根目录（/ 或盘符根）：任何档位都不放行
      if (/(rm|rmdir|del)\s+(-[a-zA-Z]*\s+)*-?[a-zA-Z]*\s*\/(\s|$)/i.test(command)
        || /:\(\)\s*\{\s*:\|:&\s*\};:/i.test(command)) {
        return { action: 'deny', reason: `递归删除根目录${agent}，任何权限档位都不放行`, category: 'PRIVILEGE_ESCALATION' }
      }
    }
    return { action: 'allow', reason: `完全权限${agent}：跳过逐次确认（硬拦截仍生效）` }
  }

  // ── 仅可查看 ──
  if (tier === PermissionTier.READ_ONLY) {
    if (effect === 'read') {
      return { action: 'allow', reason: `仅可查看${agent}：只读操作放行` }
    }
    if (effect === 'secret') {
      return { action: 'deny', reason: `仅可查看${agent}：不允许读取凭证`, category: 'CREDIT_LEAK' }
    }
    const verb: Record<string, string> = { write: '写入', exec: '执行命令', gui: '操控鼠标键盘', net: '对外发送' }
    return {
      action: 'deny',
      reason: `当前是「仅可查看」${agent}：不允许${verb[effect] ?? effect}。要执行请在发送栏把权限切到「工作区内修改」或「完全权限」。`,
      category: 'PRIVILEGE_ESCALATION',
    }
  }

  // ── 工作区内修改 ──
  // 只有这一档需要真正的路径判定
  if (effect === 'read') {
    return { action: 'allow', reason: `工作区内修改${agent}：只读操作放行` }
  }

  if (effect === 'secret') {
    return { action: 'deny', reason: `工作区内修改${agent}：不允许读取凭证`, category: 'CREDIT_LEAK' }
  }

  if (effect === 'write') {
    const root = ctx.workspaceRoot
    if (!root) {
      return { action: 'ask', reason: `未设置工作区${agent}，写操作需确认`, risk: 'medium', category: 'PATH_TRAVERSAL' }
    }
    const paths = extractPaths(ctx.args ?? {})
    if (paths.length === 0) {
      // 工具没暴露路径参数（少数情况）——按工作区内处理，但记一笔
      return { action: 'allow', reason: `工作区内修改${agent}：${toolName} 无路径参数，按工作区内放行` }
    }
    const outside = paths.filter(p => !isInside(root, p))
    if (outside.length > 0) {
      return {
        action: 'ask',
        reason: `目标在工作区外（${outside[0]}）${agent}，需你确认`,
        risk: 'high',
        category: 'PATH_TRAVERSAL',
      }
    }
    return { action: 'allow', reason: `工作区内修改${agent}：目标在 ${root} 内，放行` }
  }

  // exec / gui / net —— 这一档一律要确认
  const risk: 'medium' | 'high' = effect === 'net' ? 'medium' : 'high'
  const verb: Record<string, string> = { exec: '执行命令', gui: '操控鼠标键盘', net: '对外发送' }
  const category = effect === 'net' ? 'DATA_EXFIL' : 'CODE_EXECUTION'
  return {
    action: 'ask',
    reason: `工作区内修改${agent}：${verb[effect] ?? effect}不在工作区范畴内，需你确认`,
    risk,
    category,
  }
}
