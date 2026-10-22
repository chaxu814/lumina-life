// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// agentPermissions.ts — 权限声明 + 工具检查（薄封装）
//
// ⚠️ 真正的唯一事实源是 electron/rolePolicy.ts。
//    这里只保留旧的导出签名（getDisabledToolsForAgent / enforceToolPermission），
//    内部一律委托 rolePolicy，禁止再维护一份会漂移的工具表。
//
// 角色口径（与 rolePolicy.ts / AGENTS.md 一致）：
//   yak（Yak）   = 代码工程师 -> 可写文件、可执行命令、可 git 提交
//   recha（热茶）= 审查员     -> 只读，不写文件、不执行命令、不 git 提交
//   lumina       = 全量调度   -> 无限制
// ============================================================

import { isToolAllowedForRole, getExplicitDeniedTools } from './rolePolicy'

// AgentId 白名单
export type AgentId = 'lumina' | 'yak' | 'recha'

/**
 * 某角色应被禁用的工具。
 *  - 传入全量工具名时：返回该角色无权使用的补集（供 disabledTools 用）。
 *  - 不传时：返回该角色被显式 denylist 的工具（兼容旧调用 / 展示）。
 */
export function getDisabledToolsForAgent(agentId: AgentId, allToolNames?: string[]): string[] {
  if (!allToolNames || allToolNames.length === 0) {
    return getExplicitDeniedTools(agentId)
  }
  return allToolNames.filter(t => !isToolAllowedForRole(agentId, t).allowed)
}

/** 是否允许某 Agent 调用某工具（与运行时硬闸门同一口径） */
export function enforceToolPermission(agentId: AgentId, toolName: string): boolean {
  const verdict = isToolAllowedForRole(agentId, toolName)
  if (!verdict.allowed) {
    console.warn(`[Permission] ❌ ${agentId} 被禁止使用工具: ${toolName} -> ${verdict.reason}`)
    return false
  }
  return true
}
