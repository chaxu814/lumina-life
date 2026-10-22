// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tools/impl/approvalUI.ts — 工具审批 UI 交互 (v3.6)
//
// 借鉴 QwenPaw ToolGuard: Deny → Guard → Approve 三层流
//   当工具调用需要审批时，暂停 Agent 并弹出用户确认
//
// v3.6: 新增 file_search/disk_list 审批规则；
//       file_write/file_edit 跨盘系统路径保护
// ============================================================

import type { ToolDef } from '../types'

export type ApprovalLevel = 'low' | 'medium' | 'high' | 'critical'

export interface ApprovalRequest {
  id: string
  toolName: string
  toolLabel: string
  args: Record<string, unknown>
  level: ApprovalLevel
  reason: string
  threatCategory?: string
  timestamp: number
}

export type ApprovalDecision = 'approve' | 'deny' | 'approve_once' | 'deny_always'

export interface ApprovalResult {
  decision: ApprovalDecision
  reason?: string
  /** 拒绝后给 Agent 的反馈 */
  agentFeedback?: string
}

/** 根据工具和参数自动判断审批级别 */
export function classifyApproval(toolName: string, args: Record<string, unknown>): ApprovalLevel | null {
  // ═══════════════════════════════════════════════════════
  // 只读工具 — 永远不需要审批
  // ═══════════════════════════════════════════════════════
  const READ_ONLY_TOOLS = ['file_read', 'file_list', 'file_search', 'disk_list', 'desktop_scan']
  if (READ_ONLY_TOOLS.includes(toolName)) {
    return null // 只读，无需审批
  }

  // ═══════════════════════════════════════════════════════
  // 高风险命令
  // ═══════════════════════════════════════════════════════
  const highRiskCommands = [
    'rm', 'del', 'rmdir', 'format', 'mkfs',
    'shutdown', 'reboot', 'halt',
    'chmod 777', 'chown',
    'docker rm', 'docker system prune',
    'git push --force', 'git reset --hard',
    'npm publish', 'pip uninstall',
  ]

  if (toolName === 'shell_exec') {
    const cmd = String(args.command || args.cmd || '').toLowerCase()
    for (const risk of highRiskCommands) {
      if (cmd.includes(risk)) {return 'critical'}
    }
    if (cmd.includes('sudo') || cmd.includes('su ')) {return 'high'}
    if (cmd.includes('rm ') || cmd.includes('del ')) {return 'high'}
    if (cmd.includes('curl') || cmd.includes('wget')) {return 'medium'}
    if (cmd.includes('>') && !cmd.includes('echo')) {return 'low'} // 输出重定向
  }

  // ═══════════════════════════════════════════════════════
  // 文件写入/编辑 — 跨盘保护
  // ═══════════════════════════════════════════════════════
  if (toolName === 'file_write' || toolName === 'file_edit') {
    const filePath = String(args.filePath || args.file_path || args.file || args.path || '').toUpperCase()

    // 任何盘符下的系统目录 → CRITICAL
    if (filePath.includes('\\WINDOWS\\') || filePath.includes('\\WINDOWS\\SYSTEM32') ||
        filePath.includes('\\WINDOWS\\SYSWOW64') || filePath.includes('\\PROGRAM FILES\\') && !filePath.includes('\\PROGRAM FILES (X86)\\COMMON')) {
      return 'critical'
    }

    if (filePath.includes('.ENV') && !filePath.includes('.ENV.EXAMPLE')) {return 'high'}
    if (filePath.includes('PACKAGE.JSON') || filePath.includes('TSCONFIG')) {return 'medium'}

    // 任何盘符下的 Program Files 系统目录写保护
    const programFilesPattern = /\\(PROGRAM FILES|PROGRAM FILES \(X86\))\\(WINDOWS|COMMON FILES|INTERNET EXPLORER)/i
    if (programFilesPattern.test(filePath)) {return 'critical'}
  }

  // ═══════════════════════════════════════════════════════
  // 文件删除 (shell_exec 中的 rm/del 已经覆盖，此处兜底)
  // ═══════════════════════════════════════════════════════
  if (toolName === 'file_delete') {
    return 'high' // 任何删除都需要审批
  }

  // 邮件发送
  if (toolName === 'mail_send' || toolName === 'send_email') {
    return 'high'
  }

  // 浏览器操作
  if (toolName === 'browser' && args.action === 'click') {
    const url = String(args.url || '')
    if (url.includes('login') || url.includes('payment')) {return 'medium'}
  }

  // 网络请求
  if (toolName === 'web_fetch') {
    const url = String(args.url || '')
    if (url.includes('127.0.0.1') || url.includes('localhost')) {return 'low'}
    if (!url.startsWith('https://')) {return 'medium'}
  }

  return null // 无需审批
}

/** 生成审批提示文本 */
export function formatApprovalMessage(req: ApprovalRequest): string {
  const emoji = { low: 'ℹ️', medium: '⚠️', high: '🔴', critical: '🚫' }[req.level]
  return [
    `${emoji} **工具审批请求**`,
    `工具: \`${req.toolLabel || req.toolName}\``,
    `级别: ${req.level.toUpperCase()}`,
    `原因: ${req.reason}`,
    req.threatCategory ? `威胁类别: ${req.threatCategory}` : '',
    ``,
    `参数:`,
    ...Object.entries(req.args).slice(0, 5).map(([k, v]) =>
      `  \`${k}\`: ${JSON.stringify(v).slice(0, 200)}`
    ),
  ].filter(Boolean).join('\n')
}

/** 生成拒绝后的 Agent 反馈 */
export function formatDenyFeedback(req: ApprovalRequest, reason?: string): string {
  return [
    `[系统] 工具调用被拒绝: \`${req.toolName}\``,
    `拒绝原因: ${reason || '用户未批准此操作'}`,
    `请尝试替代方案，不要重复相同的工具调用。`,
  ].join('\n')
}
