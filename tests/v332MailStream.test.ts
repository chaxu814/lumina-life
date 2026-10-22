// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/v332MailStream.test.ts — v3.32 收口：
//   拓扑工作台通讯流：私信+cc 副本去重、广播按 broadcastId 去重、
//   时间倒序、stream() 全收件箱聚合。
// ============================================================

import { describe, it, expect, vi } from 'vitest'
import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }))

import { dedupStream, MailboxStore, type MailMessage } from '../electron/team/teamMailbox'

const mail = (m: Partial<MailMessage>): MailMessage => ({
  id: 'mail_x',
  from: 'a',
  to: 'b',
  subject: 's',
  body: 'body',
  kind: 'dm',
  ts: 1000,
  ...m,
})

describe('v3.32 dedupStream 通讯流去重', () => {
  it('私信原件与 cc 副本只保留一条，优先原件（kind=dm）', () => {
    const orig = mail({ id: 'mail_1', to: 'recha', kind: 'dm' })
    const cc = mail({ id: 'mail_1_cc_lumina', to: 'lumina', kind: 'notice', cc: ['lumina'] })
    const out = dedupStream([cc, orig])
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('dm')
    expect(out[0].to).toBe('recha')
  })

  it('广播投递到 N 个收件箱，按 broadcastId 去重为一条', () => {
    const msgs = ['yak', 'recha', 'lumina'].map((to, i) =>
      mail({ id: `mail_bc_${i}`, to, kind: 'broadcast', broadcastId: 'bc_42', subject: '全员' }))
    expect(dedupStream(msgs)).toHaveLength(1)
  })

  it('不同私信保留；结果按时间倒序', () => {
    const out = dedupStream([
      mail({ id: 'mail_1', ts: 2000 }),
      mail({ id: 'mail_2', ts: 3000, to: 'c', subject: 'c' }),
      mail({ id: 'mail_1_cc_lumina', ts: 2000, to: 'lumina', kind: 'notice' }),
    ])
    expect(out.map(m => m.id)).toEqual(['mail_2', 'mail_1'])
  })
})

describe('v3.32 MailboxStore.stream() 全收件箱聚合', () => {
  it('私信（含自动 cc）+ 广播聚合后不重复', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-stream-'))
    const store = new MailboxStore(dir)
    // worker→worker 私信，自动 cc lumina
    await store.send({ from: 'tmp_code_1', to: 'recha', subject: '我写完了', body: '请看 diff' })
    // 广播给两人
    await store.broadcast({
      from: 'lumina', subject: '收工', body: '大家辛苦了',
      members: ['yak', 'recha', 'tmp_code_1'],
    })
    const stream = store.stream()
    // 一封私信 + 一条广播（三份投递去重）
    expect(stream).toHaveLength(2)
    expect(stream.map(m => m.kind).sort()).toEqual(['broadcast', 'dm'])
    // 新的在前
    expect(stream[0].kind).toBe('broadcast')
  })
})
