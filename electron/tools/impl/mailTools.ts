// ============================================================
// impl/mailTools.ts — Agent 邮件工具 (v2.6)
//
// Agent 可通过以下工具与用户邮件系统交互：
//   mail_send      — 发送邮件给用户
//   mail_list      — 列出邮件
//   mail_mark_read — 标记已读
// ============================================================

import type { ToolDef, ToolResult } from '../types'
import { sendMail, getMails, markRead, markAllRead, getUnreadCount } from '../../mailStore'

export const mailSendDef: ToolDef = {
  name: 'mail_send',
  description: `发送一封邮件到用户的 Agent 邮箱。用于提醒用户重要事件、任务完成通知、定时汇报等场景。

参数:
- subject: 邮件标题（简洁明了）
- body: 邮件正文（支持 Markdown 格式）
- priority: 优先级 ("normal" 普通 / "important" 重要，默认 "normal")

使用示例:
- 定时任务完成时通知用户
- 发现重要信息时提醒用户
- 定期总结汇报`,
  params: {
    subject: { type: 'string', description: '邮件标题', required: true },
    body: { type: 'string', description: '邮件正文（支持 Markdown）', required: true },
    priority: { type: 'string', description: '优先级', required: false },
  },
  toolsets: ['agent', 'chat'],
}

export async function mailSendHandler(args: Record<string, any>): Promise<ToolResult> {
  const { subject, body, priority = 'normal' } = args

  if (!subject || !body) {
    return { callId: '', ok: false, content: '', error: 'subject 和 body 参数必填' }
  }

  try {
    const mail = sendMail(subject as string, body as string, priority as any)
    const icon = priority === 'important' ? '🔴' : '📬'
    return {
      callId: '',
      ok: true,
      content: `${icon} 邮件已发送到用户邮箱\n标题: "${mail.subject}"\nID: ${mail.id}`,
      durationMs: 0,
    }
  } catch (err: any) {
    return { callId: '', ok: false, content: '', error: `发送失败: ${err.message}` }
  }
}

export const mailListDef: ToolDef = {
  name: 'mail_list',
  description: `列出 Agent 邮箱中的邮件。

参数:
- filter: "all" 全部 / "unread" 仅未读 (默认 "all")`,
  params: {
    filter: { type: 'string', description: '筛选条件', required: false },
  },
  toolsets: ['agent'],
}

export async function mailListHandler(args: Record<string, any>): Promise<ToolResult> {
  const { filter = 'all' } = args
  const mails = getMails(filter)
  const unread = getUnreadCount()

  if (mails.length === 0) {
    return { callId: '', ok: true, content: '📭 邮箱为空', durationMs: 0 }
  }

  const list = mails.slice(0, 20).map(m =>
    `${m.read ? '📖' : '📬'} [${m.id.slice(-6)}] ${m.priority === 'important' ? '🔴' : ''} "${m.subject}" — ${new Date(m.createdAt).toLocaleString('zh-CN')}`
  ).join('\n')

  return {
    callId: '',
    ok: true,
    content: `📫 Agent 邮箱 (${unread} 未读 / ${mails.length} 总计)\n\n${list}`,
    durationMs: 0,
  }
}

export const mailMarkReadDef: ToolDef = {
  name: 'mail_mark_read',
  description: `标记邮件为已读。Agent 确认用户已经知道某封邮件内容后使用。将所有邮件标记为已读时使用 mail_id="all"。

参数:
- mail_id: 邮件 ID，或 "all" 全部标记`,
  params: {
    mail_id: { type: 'string', description: '邮件 ID 或 "all"', required: true },
  },
  toolsets: ['agent'],
}

export async function mailMarkReadHandler(args: Record<string, any>): Promise<ToolResult> {
  const { mail_id } = args
  if (!mail_id) return { callId: '', ok: false, content: '', error: 'mail_id 必填' }

  if (mail_id === 'all') {
    const count = markAllRead()
    return { callId: '', ok: true, content: `✅ 已标记 ${count} 封邮件为已读` }
  }

  const ok = markRead(mail_id)
  return {
    callId: '',
    ok,
    content: ok ? '✅ 已标记为已读' : `❌ 未找到邮件: ${mail_id}`,
  }
}
