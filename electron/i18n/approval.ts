// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// i18n/approval.ts — 审批流国际化字典 (v8.0)
//
// 借鉴 QwenPaw tool_guard i18n 设计:
//   支持 en/zh 完整覆盖
//   使用 {placeholder} 语法做模板插值
// ============================================================

export type ApprovalLocale = 'zh' | 'en'

export const APPROVAL_I18N: Record<ApprovalLocale, Record<string, string>> = {
  zh: {
    wait_title: '⏳ 等待审批',
    risk_detected: '⚠️ **检测到风险**',
    tool_blocked: '⛔ **工具已拦截**',
    timeout_title: '⏰ **审批超时**',

    tool: '工具',
    severity: '严重性',
    findings: '发现',
    risk_summary: '风险说明',
    parameters: '参数',
    reason: '原因',

    status_pending: '等待审批中',
    status_approved: '已批准',
    status_denied: '已拒绝',
    status_timeout: '已超时',
    status_cancelled: '已取消',

    reason_denied: '用户拒绝执行',
    reason_timeout: '审批超时（{timeout}秒），自动拒绝',
    reason_cancelled: '队列已满，自动取消',
    approve_hint: '输入 `/approve` 批准执行，或发送任意消息拒绝。',
    blocked_footer: '该工具已被禁止，无法批准执行。',
    denied_list_msg: '该工具在禁止列表中。',
    instruction_no_retry: '用户已拒绝此次工具调用。请不要重试该调用，也不要尝试其他方法来完成这一次调用。',

    level_strict: '严格模式',
    level_smart: '智能模式',
    level_auto: '自动模式',
    level_off: '关闭',

    desc_strict: '所有工具调用都需审批（最高安全性）',
    desc_smart: '低风险自动放行，中风险以上需审批（推荐）',
    desc_auto: '仅高危工具需审批（向下兼容）',
    desc_off: '完全禁用工具审查（仅开发环境）',

    heartbeat_label: '等待审批中...（{elapsed}秒）',
    heartbeat_remaining: '剩余 {remaining}秒 自动拒绝',

    sev_CRITICAL: '严重',
    sev_HIGH: '高',
    sev_MEDIUM: '中',
    sev_LOW: '低',
    sev_INFO: '提示',
    sev_SAFE: '安全',

    word_unknown: '未知',
    na_count: 'N/A',
    word_yes: '是',
    word_no: '否',
    word_cancel: '取消',
    word_confirm: '确认',
  },

  en: {
    wait_title: '⏳ Waiting for approval',
    risk_detected: '⚠️ **Risk detected**',
    tool_blocked: '⛔ **Tool blocked**',
    timeout_title: '⏰ **Approval Timeout**',

    tool: 'Tool',
    severity: 'Severity',
    findings: 'Findings',
    risk_summary: 'Risk summary',
    parameters: 'Parameters',
    reason: 'Reason',

    status_pending: 'Pending approval',
    status_approved: 'Approved',
    status_denied: 'Denied',
    status_timeout: 'Timed out',
    status_cancelled: 'Cancelled',

    reason_denied: 'User denied execution',
    reason_timeout: 'Approval timeout after {timeout}s, auto-denied',
    reason_cancelled: 'Queue full, auto-cancelled',
    approve_hint: 'Type `/approve` to approve, or send any message to deny.',
    blocked_footer: 'This tool is blocked and cannot be approved.',
    denied_list_msg: 'This tool is on the deny list.',
    instruction_no_retry: 'This specific tool call has been denied by the user. Do not retry this call or attempt alternative methods to complete it.',

    level_strict: 'Strict',
    level_smart: 'Smart',
    level_auto: 'Auto',
    level_off: 'Off',

    desc_strict: 'All tool calls require approval (highest security)',
    desc_smart: 'Low-risk auto-allowed, medium+ require approval (recommended)',
    desc_auto: 'Only high-risk tools require approval (backward compatible)',
    desc_off: 'Tool guard completely disabled (dev only)',

    heartbeat_label: 'Waiting for approval... ({elapsed}s)',
    heartbeat_remaining: '{remaining}s remaining before auto-deny',

    sev_CRITICAL: 'Critical',
    sev_HIGH: 'High',
    sev_MEDIUM: 'Medium',
    sev_LOW: 'Low',
    sev_INFO: 'Info',
    sev_SAFE: 'Safe',

    word_unknown: 'unknown',
    na_count: 'N/A',
    word_yes: 'Yes',
    word_no: 'No',
    word_cancel: 'Cancel',
    word_confirm: 'Confirm',
  },
}

/** 获取本地化文本，支持 {placeholder} 插值 */
export function t(locale: ApprovalLocale, key: string, params?: Record<string, string | number>): string {
  const bundle = APPROVAL_I18N[locale] || APPROVAL_I18N.en
  let text = bundle[key] || APPROVAL_I18N.en[key] || key
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
    }
  }
  return text
}
