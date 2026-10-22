// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/teamMailbox.test.ts — 团队文件信箱测试 (v3.20)
//
// 覆盖：发信/收件箱、未读计数、已读游标、worker→worker 自动抄送 Lumina、
//       广播投递、跨实例持久化（jsonl 追加 + 游标）。
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }))

import { MailboxStore } from '../electron/team/teamMailbox'

let dir: string
let store: MailboxStore

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-mailbox-'))
  store = new MailboxStore(dir)
})

describe('MailboxStore 基础收发', () => {
  it('lumina 发给 yak 的信出现在 yak 收件箱，且为未读', async () => {
    await store.send({ from: 'lumina', to: 'yak', subject: '任务', body: '帮我查数据' })
    const inbox = await store.inbox('yak')
    expect(inbox).toHaveLength(1)
    expect(inbox[0].subject).toBe('任务')
    expect(inbox[0].kind).toBe('dm')
    expect(store.unreadCount('yak')).toBe(1)
    expect(store.unreadCount('lumina')).toBe(0)
  })

  it('markRead 后未读数归零，unreadOnly=false 仍可看全部', async () => {
    await store.send({ from: 'lumina', to: 'yak', subject: 'a', body: '1' })
    await store.send({ from: 'lumina', to: 'yak', subject: 'b', body: '2' })
    expect(await store.inbox('yak')).toHaveLength(2)
    expect(await store.markRead('yak')).toBe(2)
    expect(await store.inbox('yak')).toHaveLength(0)
    const all = await store.inbox('yak', { unreadOnly: false })
    expect(all).toHaveLength(2)
  })

  it('缺 from/to 抛错', async () => {
    await expect(store.send({ from: '', to: 'yak', subject: 'x', body: 'y' })).rejects.toThrow()
  })
})

describe('自动抄送 Lumina', () => {
  it('worker→worker 私信自动抄送 lumina（notice 副本）', async () => {
    await store.send({ from: 'recha', to: 'yak', subject: '复核请求', body: '看看这个' })
    const luminaInbox = await store.inbox('lumina')
    expect(luminaInbox).toHaveLength(1)
    expect(luminaInbox[0].to).toBe('lumina')
    expect(luminaInbox[0].kind).toBe('notice')
    expect(luminaInbox[0].from).toBe('recha')
    // 原信照常到 yak
    expect((await store.inbox('yak'))[0].to).toBe('yak')
  })

  it('lumina 发出的信不自动抄送自己', async () => {
    await store.send({ from: 'lumina', to: 'yak', subject: 'x', body: 'y' })
    expect(store.unreadCount('lumina')).toBe(0)
  })

  it('worker→lumina 不产生额外抄送', async () => {
    await store.send({ from: 'yak', to: 'lumina', subject: '汇报', body: 'done' })
    const inbox = await store.inbox('lumina')
    expect(inbox).toHaveLength(1)
    expect(inbox[0].kind).toBe('dm')
  })
})

describe('广播', () => {
  it('投递给除发送者外的全部成员，共享 broadcastId', async () => {
    const sent = await store.broadcast({
      from: 'lumina', subject: '集合', body: '开会', members: ['lumina', 'yak', 'recha'],
    })
    expect(sent).toHaveLength(2)
    expect(store.unreadCount('yak')).toBe(1)
    expect(store.unreadCount('recha')).toBe(1)
    expect(store.unreadCount('lumina')).toBe(0)
    const y = (await store.inbox('yak'))[0]
    expect(y.kind).toBe('broadcast')
    expect(y.broadcastId).toBeTruthy()
  })

  it('exclude 名单被排除', async () => {
    await store.broadcast({
      from: 'lumina', subject: 's', body: 'b', members: ['lumina', 'yak', 'recha'], exclude: ['yak'],
    })
    expect(store.unreadCount('yak')).toBe(0)
    expect(store.unreadCount('recha')).toBe(1)
  })
})

describe('counts 快照与持久化', () => {
  it('counts 返回各成员未读数', async () => {
    await store.send({ from: 'lumina', to: 'yak', subject: '1', body: '' })
    await store.send({ from: 'lumina', to: 'recha', subject: '2', body: '' })
    await store.send({ from: 'lumina', to: 'recha', subject: '3', body: '' })
    const c = store.counts(['lumina', 'yak', 'recha'])
    expect(c).toEqual({ lumina: 0, yak: 1, recha: 2 })
  })

  it('新实例读同一目录可看到历史信件（跨重启不丢）', async () => {
    await store.send({ from: 'lumina', to: 'yak', subject: '持久', body: '内容' })
    await store.markRead('yak')
    const reopened = new MailboxStore(dir)
    expect(await reopened.inbox('yak')).toHaveLength(0)
    expect(await reopened.inbox('yak', { unreadOnly: false })).toHaveLength(1)
  })
})
