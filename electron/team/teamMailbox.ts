// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// teamMailbox.ts — 团队文件信箱 (v3.20, 同类工程实践：inboxes/{name}.json)
//
// 同类项目的 agent 团队不共享内存，成员间靠「文件信箱」异步通信：
//   每个成员一个 inbox 文件 + 文件锁，发送即追加，收件人轮询拉取。
//
// Lumina 落地版（单进程 + 持久化，跨重启不丢消息）：
//   userData/team/mailbox/<member>.jsonl  —— 追加式收件箱，每行一封信
//   userData/team/mailbox/_read.json      —— 各成员已读信 id 集合
//
// 铁则（与灵魂层一致）：
//   - 普通 worker 之间的私信默认自动抄送 Lumina（用户始终只见 Lumina，
//     但 Lumina 对后台协作全可见）；Lumina 不主动把这些消息直接甩给用户。
// ============================================================

import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'

export type MailKind = 'dm' | 'broadcast' | 'notice' | 'system'

export interface MailMessage {
  /** 全局唯一 id */
  id: string
  /** 发件人 id */
  from: string
  /** 收件人 id（广播时为 *） */
  to: string
  subject: string
  body: string
  kind: MailKind
  ts: number
  /** 抄送列表（worker 私信会自动带 lumina） */
  cc?: string[]
  /** 同批广播的分组 id（便于 UI 聚合） */
  broadcastId?: string
}

export interface InboxQuery {
  /** 只看未读，默认 true */
  unreadOnly?: boolean
  /** 最多返回条数，默认 50 */
  limit?: number
}

/** 信箱文件是否允许读写的守卫（进程内串行化） */
const _locks = new Map<string, Promise<unknown>>()

async function withLock<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = _locks.get(key) || Promise.resolve()
  const next = prev.then(() => fn(), () => fn())
  _locks.set(key, next.catch(() => undefined))
  return next
}

function safeName(member: string): string {
  // 防路径穿越
  return String(member).replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '_')
}

/**
 * v3.32 通讯流去重（纯函数，便于单测）：
 * 同一封私信在收件人 + cc 副本收件箱里各有一份，广播在每个收件箱一份。
 * 去重键：广播用 broadcastId，其余用剥离 _cc_<member> 后缀的原 id。
 * 同组内优先保留原件（dm/broadcast），其次 cc 通知（notice）。
 */
export function dedupStream(messages: MailMessage[]): MailMessage[] {
  const groups = new Map<string, MailMessage[]>()
  for (const m of messages) {
    const canonical = m.broadcastId || m.id.replace(/_cc_[^_]+$/, '')
    const arr = groups.get(canonical)
    if (arr) {arr.push(m)} else {groups.set(canonical, [m])}
  }
  const rank = (m: MailMessage): number =>
    m.kind === 'dm' ? 0 : m.kind === 'broadcast' ? 1 : m.kind === 'system' ? 2 : 3
  const out: MailMessage[] = []
  for (const arr of groups.values()) {
    arr.sort((a, b) => rank(a) - rank(b) || a.ts - b.ts)
    out.push(arr[0])
  }
  return out.sort((a, b) => b.ts - a.ts)
}

// ═══════════════════════════════════════════════════════════
// MailboxStore —— 纯存储（目录可注入，便于单测）
// ═══════════════════════════════════════════════════════════

export class MailboxStore {
  constructor(public readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true })
  }

  private inboxPath(member: string): string {
    return path.join(this.dir, `${safeName(member)}.jsonl`)
  }

  private readPath(): string {
    return path.join(this.dir, '_read.json')
  }

  /** 读取某人的全部信件（旧→新） */
  readAll(member: string): MailMessage[] {
    const p = this.inboxPath(member)
    if (!fs.existsSync(p)) {return []}
    const out: MailMessage[] = []
    const lines = fs.readFileSync(p, 'utf-8').split(/\r?\n/)
    for (const line of lines) {
      const s = line.trim()
      if (!s) {continue}
      try {out.push(JSON.parse(s))} catch { /* 坏行跳过 */ }
    }
    return out.sort((a, b) => a.ts - b.ts)
  }

  /** 追加一封信到指定成员的收件箱（同步原子小写入，调用方持锁） */
  private append(member: string, msg: MailMessage): void {
    const p = this.inboxPath(member)
    fs.appendFileSync(p, JSON.stringify(msg) + '\n', 'utf-8')
  }

  private readCursors(): Record<string, Record<string, boolean>> {
    try {
      const p = this.readPath()
      if (!fs.existsSync(p)) {return {}}
      return JSON.parse(fs.readFileSync(p, 'utf-8'))
    } catch {return {}}
  }

  private writeCursors(data: Record<string, Record<string, boolean>>): void {
    const p = this.readPath()
    const tmp = p + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf-8')
    fs.renameSync(tmp, p)
  }

  /** 已读 id 集合 */
  private readSet(member: string): Set<string> {
    const all = this.readCursors()
    return new Set(Object.keys(all[member] || {}))
  }

  /** 发私信；worker 间私信自动抄送 Lumina（除非 from 是 lumina） */
  async send(opts: {
    from: string
    to: string
    subject: string
    body: string
    kind?: MailKind
    cc?: string[]
  }): Promise<MailMessage> {
    const from = opts.from
    const to = opts.to
    if (!from || !to) {throw new Error('信箱消息缺少 from/to')}
    const cc = [...(opts.cc || [])]
    // worker→worker 私信自动抄送 Lumina（守护「用户只见 Lumina」）
    if (to !== 'lumina' && from !== 'lumina' && !cc.includes('lumina')) {
      cc.push('lumina')
    }
    const msg: MailMessage = {
      id: `mail_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      from,
      to,
      subject: opts.subject || '(无主题)',
      body: opts.body || '',
      kind: opts.kind || 'dm',
      ts: Date.now(),
      cc,
    }
    await withLock(this.inboxPath(to), async () => {
      this.append(to, msg)
      for (const c of cc) {
        if (c !== to) {
          const copy: MailMessage = { ...msg, id: `${msg.id}_cc_${c}`, to: c, kind: 'notice' }
          this.append(c, copy)
        }
      }
    })
    return msg
  }

  /** 广播（投递给除发送者外的全部成员，包括 lumina） */
  async broadcast(opts: {
    from: string
    subject: string
    body: string
    members: string[]
    exclude?: string[]
  }): Promise<MailMessage[]> {
    const broadcastId = `bc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    const exclude = new Set([opts.from, ...(opts.exclude || [])])
    const targets = Array.from(new Set(opts.members)).filter(m => m && !exclude.has(m))
    const delivered: MailMessage[] = []
    await withLock(this.dir, async () => {
      for (const to of targets) {
        const msg: MailMessage = {
          id: `mail_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          from: opts.from,
          to,
          subject: opts.subject || '(广播)',
          body: opts.body,
          kind: 'broadcast',
          ts: Date.now(),
          broadcastId,
        }
        this.append(to, msg)
        delivered.push(msg)
      }
    })
    return delivered
  }

  /** 读取收件箱（默认未读） */
  async inbox(member: string, query: InboxQuery = {}): Promise<MailMessage[]> {
    const unreadOnly = query.unreadOnly !== false
    const limit = query.limit ?? 50
    return withLock(this.inboxPath(member), async () => {
      const all = this.readAll(member)
      const read = this.readSet(member)
      const list = unreadOnly ? all.filter(m => !read.has(m.id)) : all
      return list.slice(-limit)
    })
  }

  /** 标记已读（不传 ids 则全部已读） */
  async markRead(member: string, ids?: string[]): Promise<number> {
    return withLock(this.readPath(), async () => {
      const cursors = this.readCursors()
      const set = cursors[member] || {}
      const all = this.readAll(member)
      const targets = ids && ids.length > 0
        ? all.filter(m => ids.includes(m.id))
        : all
      for (const m of targets) {set[m.id] = true}
      cursors[member] = set
      this.writeCursors(cursors)
      return targets.length
    })
  }

  /** 未读数（供 UI / 工具轮询） */
  unreadCount(member: string): number {
    const all = this.readAll(member)
    const read = this.readSet(member)
    return all.filter(m => !read.has(m.id)).length
  }

  /** 各成员未读数快照（UI 用） */
  counts(members: string[]): Record<string, number> {
    const out: Record<string, number> = {}
    for (const m of members) {out[m] = this.unreadCount(m)}
    return out
  }

  /**
   * v3.32 聚合通讯流（拓扑工作台右侧「通讯」面板）：
   * 读全部成员收件箱，去重后按时间倒序返回。
   *  - worker 私信自动抄送 Lumina，同一封在多个收件箱里：按原 id 去重
   *    （cc 副本的 id 形如 原id_cc_<member>，优先保留 kind=dm 原件）
   *  - 广播按 broadcastId 去重（同一批投递到多个人只显示一条）
   */
  stream(limit = 150): MailMessage[] {
    const collected: MailMessage[] = []
    for (const file of fs.readdirSync(this.dir)) {
      if (!file.endsWith('.jsonl')) {continue}
      const lines = fs.readFileSync(path.join(this.dir, file), 'utf-8').split(/\r?\n/)
      for (const line of lines) {
        const s = line.trim()
        if (!s) {continue}
        try {collected.push(JSON.parse(s))} catch { /* 坏行跳过 */ }
      }
    }
    return dedupStream(collected).slice(0, limit)
  }

  /**
   * 轮询等待新消息（worker 可 await）。
   * @param intervalMs 轮询间隔（同类项目为 1s）
   * @param timeoutMs  超时返回空数组
   */
  async poll(member: string, timeoutMs = 30_000, intervalMs = 1000): Promise<MailMessage[]> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const unread = await this.inbox(member, { unreadOnly: true })
      if (unread.length > 0) {return unread}
      await new Promise(r => setTimeout(r, intervalMs))
    }
    return []
  }
}

// ═══════════════════════════════════════════════════════════
// 单例
// ═══════════════════════════════════════════════════════════

let _instance: MailboxStore | null = null

function defaultDir(): string {
  const base = app?.getPath ? app.getPath('userData') : process.cwd()
  return path.join(base, 'team', 'mailbox')
}

export function getTeamMailbox(dir?: string): MailboxStore {
  if (!_instance || dir) {
    _instance = new MailboxStore(dir || defaultDir())
  }
  return _instance
}
