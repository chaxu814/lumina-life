// ============================================================
// mailStore.ts — Agent 邮件存储 (v2.6)
//
// 轻量 JSON 文件存储，Agent 可通过 mail_send 工具给用户发邮件
// 用户可在 MailPanel 中阅读、标记已读、删除
// ============================================================

import { app, Notification } from 'electron'
import fs from 'fs'
import path from 'path'
import { join } from 'path'

export interface AgentMail {
  id: string
  subject: string
  body: string
  priority: 'normal' | 'important'
  read: boolean
  createdAt: number
  readAt?: number
}

export interface MailSmtpConfig {
  enabled: boolean
  from?: string
  to?: string
  replyTo?: string
  host?: string
  port?: number
  secure?: boolean
  user?: string
  pass?: string
  allowUnauthTls?: boolean
  logHtml?: boolean
}

let mails: AgentMail[] = []
let storePath: string | null = null
let changeListeners: Array<() => void> = []

let smtpConfig: MailSmtpConfig = {
  enabled: false,
  secure: true,
}

function smtpConfigPath(): string {
  return join(app.getPath('userData'), 'lumina-mail-smtp.json')
}

function loadSmtpConfig(): void {
  try {
    const p = smtpConfigPath()
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf-8'))
      smtpConfig = { ...smtpConfig, ...(raw || {}) }
      console.log('[MailStore][SMTP] 已加载 SMTP 配置')
    }
  } catch (e) {
    console.warn('[MailStore][SMTP] 加载失败:', e)
  }
}

function saveSmtpConfig(): void {
  try {
    fs.writeFileSync(smtpConfigPath(), JSON.stringify(smtpConfig, null, 2), 'utf-8')
  } catch (e) {
    console.warn('[MailStore][SMTP] 保存失败:', e)
  }
}

export function resetSmtpConfig(): MailSmtpConfig {
  smtpConfig = { enabled: false, secure: true }
  saveSmtpConfig()
  return smtpConfig
}

function getStorePath(): string {
  if (storePath) return storePath
  try {
    const userData = app.getPath('userData')
    storePath = path.join(userData, 'lumina-mailbox.json')
  } catch {
    storePath = path.join(process.cwd(), 'lumina-mailbox.json')
  }
  return storePath
}

function load(): void {
  try {
    const filePath = getStorePath()
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf-8')
      mails = JSON.parse(raw)
      console.log(`[MailStore] 已加载 ${mails.length} 封邮件`)
    }
  } catch (err) {
    console.warn('[MailStore] 加载失败:', err)
    mails = []
  }
}

function save(): void {
  try {
    const filePath = getStorePath()
    fs.writeFileSync(filePath, JSON.stringify(mails, null, 2), 'utf-8')
  } catch (err) {
    console.warn('[MailStore] 保存失败:', err)
  }
}

function notify(): void {
  for (const fn of changeListeners) {
    try { fn() } catch {}
  }
}

// ═══════════════════════════════════════════════════════════
// 公共 API
// ═══════════════════════════════════════════════════════════

export function initMailStore(): void {
  load()
  loadSmtpConfig()
}

export function getSmtpConfig(): MailSmtpConfig {
  return smtpConfig
}

export function setSmtpConfig(next: Partial<MailSmtpConfig>): MailSmtpConfig {
  smtpConfig = { ...smtpConfig, ...next }
  saveSmtpConfig()
  return smtpConfig
}

export function onMailChange(fn: () => void): () => void {
  changeListeners.push(fn)
  return () => {
    changeListeners = changeListeners.filter(f => f !== fn)
  }
}

async function trySendSmtpMail(subject: string, body: string, htmlBody?: string): Promise<void> {
  if (!smtpConfig.enabled) return
  const {
    from,
    to,
    host,
    port,
    secure,
    user,
    pass,
    allowUnauthTls = false,
    replyTo,
    logHtml = false,
  } = smtpConfig
  const targetTo = to || from
  if (!host || !port || !targetTo) {
    console.warn('[MailStore][SMTP] 未配置 host/port/to，跳过外发')
    return
  }

  let nodemailer: any
  try {
    nodemailer = require('nodemailer')
  } catch (err) {
    console.warn('[MailStore][SMTP] nodemailer 未安装，跳过外发')
    return
  }

  try {
    const transporter = nodemailer.createTransport({
      host,
      port: Number(port),
      secure: secure === false ? false : true,
      auth: user ? { user, pass } : undefined,
      tls: allowUnauthTls ? { rejectUnauthorized: false } : undefined,
    } as any)

    const info = await transporter.sendMail({
      from,
      to: targetTo,
      replyTo,
      subject,
      text: body,
      html: htmlBody,
    })

    console.log(`[MailStore][SMTP] 外发成功:`, info.messageId)
  } catch (err) {
    console.warn(`[MailStore][SMTP] 外发失败:`, err)
  }
}

export function sendMail(subject: string, body: string, priority: 'normal' | 'important' = 'normal'): AgentMail {
  const mail: AgentMail = {
    id: 'mail-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    subject,
    body,
    priority,
    read: false,
    createdAt: Date.now(),
  }
  mails.unshift(mail) // 最新邮件在前
  save()
  notify()

  const isImportant = priority === 'important'
  const title = isImportant ? `🔴 Lumina 重要通知` : `📬 Lumina 邮件`
  console.log(`[MailStore] ${title}：“${subject}”`)
  const summary = `${subject}\n${body.slice(0, 80)}${body.length > 80 ? '...' : ''}`

  // Windows 系统通知
  if (Notification.isSupported()) {
    try {
      const n = new Notification({ title, body: summary, urgency: isImportant ? 'critical' : 'normal' })
      n.on('click', () => {/* 点击通知时不做特殊处理，用户自行打开 APP 查看 */})
      n.show()
    } catch (e) {
      console.warn('[MailStore] Windows 通知发送失败:', e)
    }
  }

  const htmlFrom = body || ''
  const htmlBody = `<!doctype html><html><body><pre style="font:14px/1.6 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; white-space:pre-wrap;">${htmlFrom.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre></body></html>`

  // v2.7: 可选 SMTP 外发，不阻塞本地存储/通知
  trySendSmtpMail(subject, body, htmlBody).catch((err) => {
    console.warn('[MailStore] sendSmtpMail 调用异常:', err)
  })

  return mail
}

export function getMails(filter?: 'unread' | 'all'): AgentMail[] {
  if (filter === 'unread') return mails.filter(m => !m.read)
  return [...mails]
}

export function markRead(mailId: string): boolean {
  const mail = mails.find(m => m.id === mailId)
  if (!mail) return false
  mail.read = true
  mail.readAt = Date.now()
  save()
  notify()
  return true
}

export function markAllRead(): number {
  let count = 0
  for (const m of mails) {
    if (!m.read) {
      m.read = true
      m.readAt = Date.now()
      count++
    }
  }
  if (count > 0) { save(); notify() }
  return count
}

export function deleteMail(mailId: string): boolean {
  const idx = mails.findIndex(m => m.id === mailId)
  if (idx === -1) return false
  mails.splice(idx, 1)
  save()
  notify()
  return true
}

export function getUnreadCount(): number {
  return mails.filter(m => !m.read).length
}

export function getTotalCount(): number {
  return mails.length
}

export function clearAll(): void {
  mails = []
  save()
  notify()
}
