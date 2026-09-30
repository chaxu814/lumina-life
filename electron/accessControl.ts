// ============================================================
// accessControl.ts — 🔒 Agent 权限与访问控制 (v16.0-fix)
//
// 为每个 Agent 定义细粒度的权限边界：
//   1. 文件系统隔离 — 允许读写的目录
//   2. 工具白名单 — 允许调用的工具（在 disabledTools 基础上再加一层）
//   3. 网络访问 — 允许访问的域名/IP
//   4. 环境变量 — 允许读取的 env
//
// 与现有的 disabledTools（main.ts 里硬编码）不同，
// 此系统支持动态配置、UI 编辑，且按 Agent 独立。
// ============================================================

import type { TeamMemberId } from './agentTeamTypes'
import { isToolAllowedForRole } from './rolePolicy'

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

export interface AgentPermissions {
  /** Agent ID */
  agentId: TeamMemberId
  /** 允许的文件系统路径（空数组 = 禁止所有文件操作） */
  allowedReadPaths: string[]
  allowedWritePaths: string[]
  /** 允许的危险工具（不在白名单的危险工具被拒绝） */
  allowedDangerousTools: string[]
  /** 是否允许网络访问 */
  networkAccess: boolean
  /** 允许的域名白名单（空 = 全部禁止，['*'] = 全部允许） */
  allowedDomains: string[]
  /** 是否允许执行 shell 命令 */
  shellAccess: boolean
  /** 允许执行的命令前缀（空 = 全部禁止，['*'] = 全部允许） */
  allowedCommands: string[]
  /** 权限描述 */
  description: string
}

export type PermissionCheckResult = {
  allowed: boolean
  reason: string
  /** 建议的替代操作（如果有） */
  suggestion?: string
}

export interface AccessViolation {
  timestamp: number
  agentId: TeamMemberId
  action: string
  target: string
  reason: string
  denied: boolean
}

// ═══════════════════════════════════════════════════════════
// 默认权限
// ═══════════════════════════════════════════════════════════

export const DEFAULT_PERMISSIONS: Record<TeamMemberId, AgentPermissions> = {
  lumina: {
    agentId: 'lumina',
    allowedReadPaths: ['*'],       // 可读任何路径
    allowedWritePaths: ['*'],      // 可写任何路径
    allowedDangerousTools: ['*'],  // 可使用所有工具
    networkAccess: true,
    allowedDomains: ['*'],
    shellAccess: true,
    allowedCommands: ['*'],
    description: 'Lumina — 老大，无限制',
  },
  // ⚠️ 角色口径（以 AGENTS.md / electron/rolePolicy.ts 为唯一事实源）
  //   yak（Yak）   = 代码工程师  → 可读可写、可执行命令、可 git 提交
  //   recha（热茶）= 审查员      → 只读，不写文件、不执行命令、不 git 提交
  // 为什么必须严格区分：权限反过来时，写代码的人一行都写不出来（活干不了），
  // 而审查员却能删改任意文件/跑任意命令（越权）。
  yak: {
    agentId: 'yak',
    allowedReadPaths: ['*'],       // 可读任何路径（读代码需要）
    allowedWritePaths: ['*'],      // 可写任何路径（改代码需要）
    allowedDangerousTools: [
      'file_write', 'file_edit', 'shell_exec', 'git_commit',
    ],
    networkAccess: true,
    allowedDomains: ['*'],         // 需要 npm/pip/git 等
    shellAccess: true,
    allowedCommands: ['*'],
    description: 'Yak — 代码工程师，可写文件和执行命令',
  },
  recha: {
    agentId: 'recha',
    allowedReadPaths: ['*'],       // 可读任何路径（读代码审查需要）
    allowedWritePaths: [],          // ❌ 审查员不写文件
    allowedDangerousTools: [],      // ❌ 禁止危险工具
    networkAccess: true,
    allowedDomains: ['*'],
    // ❌ 审查员只给意见，不执行任意命令（否则等于绕过只读边界去改环境）
    shellAccess: false,
    allowedCommands: [],
    description: '热茶 — 审查员，只读不写',
  },
}

// ═══════════════════════════════════════════════════════════
// AccessController
// ═══════════════════════════════════════════════════════════

export class AccessController {
  private permissions: Map<TeamMemberId, AgentPermissions> = new Map()
  private violations: AccessViolation[] = []
  private maxViolations = 200  // 最多保留 200 条记录

  constructor(customPermissions?: Partial<Record<TeamMemberId, Partial<AgentPermissions>>>) {
    // 加载默认权限
    for (const [id, perm] of Object.entries(DEFAULT_PERMISSIONS)) {
      this.permissions.set(id as TeamMemberId, { ...perm })
    }
    // 应用自定义覆盖
    if (customPermissions) {
      for (const [id, patch] of Object.entries(customPermissions)) {
        const existing = this.permissions.get(id as TeamMemberId)
        if (existing) {
          Object.assign(existing, patch)
        }
      }
    }
  }

  // ── 权限检查 ──────────────────────────────────────

  /** 检查文件读取权限 */
  checkReadPath(agentId: TeamMemberId, filePath: string): PermissionCheckResult {
    const perm = this.permissions.get(agentId)
    if (!perm) {return deny(`${agentId} 无权限配置`)}

    if (perm.allowedReadPaths.includes('*')) {return allow()}
    if (perm.allowedReadPaths.some(p => filePath.startsWith(p))) {return allow()}

    return deny(`${agentId} 无权限读取 ${filePath}`, '尝试用 file_search 先找到文件')
  }

  /** 检查文件写入权限 */
  checkWritePath(agentId: TeamMemberId, filePath: string): PermissionCheckResult {
    const perm = this.permissions.get(agentId)
    if (!perm) {return deny(`${agentId} 无权限配置`)}

    if (perm.allowedWritePaths.length === 0) {
      return deny(`${agentId} 不允许写任何文件`, '请联系 Lumina 处理文件操作')
    }
    if (perm.allowedWritePaths.includes('*')) {return allow()}
    if (perm.allowedWritePaths.some(p => filePath.startsWith(p))) {return allow()}

    return deny(`${agentId} 无权写入 ${filePath}`)
  }

  /** 检查工具调用权限 —— 以 rolePolicy 为唯一事实源 */
  checkToolAccess(agentId: TeamMemberId, toolName: string): PermissionCheckResult {
    const perm = this.permissions.get(agentId)
    if (!perm) {return deny(`${agentId} 无权限配置`)}

    // 唯一事实源：electron/rolePolicy.ts
    // yak=代码工程师（可写可执行），recha=审查员（只读），lumina=全量。
    const verdict = isToolAllowedForRole(agentId, toolName)
    if (verdict.allowed) {return allow()}
    return deny(verdict.reason, '这是安全敏感操作，需要 Lumina 处理')
  }

  /** 检查网络访问 */
  checkNetworkAccess(agentId: TeamMemberId, domain: string): PermissionCheckResult {
    const perm = this.permissions.get(agentId)
    if (!perm) {return deny(`${agentId} 无权限配置`)}

    if (!perm.networkAccess) {
      return deny(`${agentId} 不允许网络访问`)
    }
    if (perm.allowedDomains.includes('*')) {return allow()}
    if (perm.allowedDomains.some(d => domain.includes(d) || d.includes(domain))) {return allow()}

    return deny(`${agentId} 无权访问 ${domain}`)
  }

  /** 检查 shell 命令 */
  checkShellCommand(agentId: TeamMemberId, command: string): PermissionCheckResult {
    const perm = this.permissions.get(agentId)
    if (!perm) {return deny(`${agentId} 无权限配置`)}

    if (!perm.shellAccess) {
      return deny(`${agentId} 不允许执行 shell 命令`)
    }
    if (perm.allowedCommands.includes('*')) {return allow()}
    if (perm.allowedCommands.some(c => command.startsWith(c))) {return allow()}

    // 检查危险命令
    const dangerousPatterns = ['rm -rf', 'format', 'dd ', '> /dev/', 'mkfs', 'shutdown', 'reboot']
    for (const pattern of dangerousPatterns) {
      if (command.toLowerCase().includes(pattern)) {
        return deny(`检测到危险命令: ${pattern}`, '此命令已被安全策略禁止')
      }
    }

    return allow() // 未匹配危险模式，放行
  }

  // ── 记录违规 ──────────────────────────────────────

  /** 记录一次访问违规（无论允许还是拒绝） */
  recordViolation(agentId: TeamMemberId, action: string, target: string, reason: string, denied: boolean): void {
    this.violations.unshift({
      timestamp: Date.now(),
      agentId,
      action,
      target,
      reason,
      denied,
    })
    if (this.violations.length > this.maxViolations) {
      this.violations.pop()
    }
  }

  /** 获取违规记录 */
  getViolations(agentId?: TeamMemberId): AccessViolation[] {
    if (agentId) {return this.violations.filter(v => v.agentId === agentId)}
    return [...this.violations]
  }

  /** 获取某个 Agent 的权限配置 */
  getPermissions(agentId: TeamMemberId): AgentPermissions | undefined {
    return this.permissions.get(agentId)
  }

  /** 获取所有 Agent 的权限 */
  getAllPermissions(): AgentPermissions[] {
    return Array.from(this.permissions.values())
  }

  /** 更新权限 */
  updatePermissions(agentId: TeamMemberId, patch: Partial<AgentPermissions>): boolean {
    const existing = this.permissions.get(agentId)
    if (!existing) {return false}
    Object.assign(existing, patch)
    return true
  }

  /** 重置为默认权限 */
  resetPermissions(agentId: TeamMemberId): boolean {
    const defaults = DEFAULT_PERMISSIONS[agentId]
    if (!defaults) {return false}
    this.permissions.set(agentId, { ...defaults })
    return true
  }

  /** 清除违规记录 */
  clearViolations(): void {
    this.violations = []
  }
}

export type { TeamMemberId }

// ═══════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════

function allow(): PermissionCheckResult {
  return { allowed: true, reason: '允许' }
}

function deny(reason: string, suggestion?: string): PermissionCheckResult {
  return { allowed: false, reason, suggestion }
}

// ═══════════════════════════════════════════════════════════
// 全局单例
// ═══════════════════════════════════════════════════════════

let _controller: AccessController | null = null

export function getAccessController(): AccessController {
  if (!_controller) {_controller = new AccessController()}
  return _controller
}

export function initAccessController(customPermissions?: Partial<Record<TeamMemberId, Partial<AgentPermissions>>>): AccessController {
  _controller = new AccessController(customPermissions)
  return _controller
}
