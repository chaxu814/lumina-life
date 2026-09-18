// ============================================================
// tests/channels.contract.test.ts — 渠道适配器契约 + 失败安全
//
// 不依赖真实登录/真机：用可注入的 fake 适配器与 mock fetch，
// 校验 ChannelManager 的隔离/回退，以及 Telegram / OpenClaw 的契约。
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { ChannelManager } from '../electron/channels/channelManager'
import type { ChannelAdapter, ChannelConfig, ChannelMessage } from '../electron/channels/types'
import { TelegramAdapter } from '../electron/channels/adapters/telegram'
import { OpenClawAdapter } from '../electron/channels/adapters/openclaw'

function makeFake(partial: Partial<ChannelAdapter> = {}): ChannelAdapter {
  return {
    type: 'custom' as any,
    name: 'fake',
    init: vi.fn(async () => true),
    send: vi.fn(async () => true),
    onMessage: vi.fn(),
    healthCheck: vi.fn(async () => true),
    destroy: vi.fn(async () => {}),
    ...partial,
  }
}

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-channels-'))
  return dir
}

describe('ChannelManager 契约与隔离', () => {
  let dir: string
  let manager: ChannelManager
  beforeEach(() => { dir = tmpDir(); manager = new ChannelManager({ configDir: dir }) })
  afterEach(async () => { await manager.destroy().catch(() => {}); fs.rmSync(dir, { recursive: true, force: true }) })

  it('send 到未注册渠道返回 false（不抛异常）', async () => {
    await expect(manager.send('nope', { targetId: 'a', isGroup: false, text: 'x' })).resolves.toBe(false)
  })

  it('broadcast 用 allSettled：一个渠道 send 抛错/拒绝，不影响其它渠道', async () => {
    const good = makeFake({ name: 'good', send: vi.fn(async () => true) })
    const bad = makeFake({
      name: 'bad',
      send: vi.fn(async () => { throw new Error('boom') }),
    })
    manager.registerAdapter('good', good)
    manager.registerAdapter('bad', bad)
    await expect(manager.broadcast('user1', 'hello')).resolves.toBeUndefined()
    expect(good.send).toHaveBeenCalledTimes(1)
    expect(bad.send).toHaveBeenCalledTimes(1)
  })

  it('updateConfig 启动一个无 token 的 Telegram 渠道后，状态为在线', async () => {
    const m = new ChannelManager({ configDir: dir })
    await m.updateConfig('tg', {
      enabled: true, type: 'telegram', name: 'TG', credentials: {},
    })
    const online = m.getStatus().find(s => s.key === 'tg')
    expect(online?.online).toBe(true)
    await m.destroy()
  })

  it('未配置的 OpenClaw 渠道 init 失败 → 保持离线，不抛异常、不影响其它渠道', async () => {
    const m = new ChannelManager({ configDir: dir })
    await m.updateConfig('oc', {
      enabled: true, type: 'openclaw', name: 'OpenClaw', credentials: {},
    })
    const st = m.getStatus().find(s => s.key === 'oc')
    expect(st?.online).toBe(false)
    await m.destroy()
  })

  it('init() 中某个渠道异常不会阻断其余渠道', async () => {
    const dir2 = tmpDir()
    // 写入两个已启用渠道：一个未知类型（构造失败）、一个 telegram（可起来）
    fs.mkdirSync(path.join(dir2), { recursive: true })
    fs.writeFileSync(path.join(dir2, 'channels.json'), JSON.stringify({
      bad: { enabled: true, type: 'custom', name: 'bad', credentials: {} } as ChannelConfig,
      tg: { enabled: true, type: 'telegram', name: 'TG', credentials: {} } as ChannelConfig,
    }), 'utf8')
    const m = new ChannelManager({ configDir: dir2 })
    await expect(m.init()).resolves.toBeUndefined()
    const status = m.getStatus()
    // 未知类型不在线，telegram 在线（说明坏渠道被隔离）
    expect(status.find(s => s.key === 'tg')?.online).toBe(true)
    expect(status.find(s => s.key === 'bad')?.online).toBe(false)
    await m.destroy()
    fs.rmSync(dir2, { recursive: true, force: true })
  })
})

describe('TelegramAdapter 契约', () => {
  it('无 token：init 成功（不抛）、send 返回 false、healthCheck false', async () => {
    const a = new TelegramAdapter()
    await expect(a.init({ enabled: true, type: 'telegram', name: 'tg', credentials: {} })).resolves.toBe(true)
    await expect(a.send({ targetId: '1', isGroup: false, text: 'hi' })).resolves.toBe(false)
    await expect(a.healthCheck()).resolves.toBe(false)
  })

  it('handleWebhook 正确解析私聊/群聊更新（不触网）', () => {
    const a = new TelegramAdapter()
    const received: ChannelMessage[] = []
    a.onMessage((msg) => received.push(msg))
    // 群消息
    const res = a.handleWebhook({
      update_id: 1,
      message: {
        message_id: 42, date: 1700000000,
        from: { id: 7, first_name: 'Ada', is_bot: false },
        chat: { id: -100, type: 'supergroup', title: 'Group' },
        text: '你好',
      },
    })
    expect(res.status).toBe(200)
    expect(received[0]).toMatchObject({
      channel: 'telegram', id: '42', fromUser: '7', text: '你好',
      groupId: '-100', groupName: 'Group',
    })
    // bot 自身消息被忽略
    a.handleWebhook({ message: { message_id: 1, from: { is_bot: true }, chat: { type: 'private' } } })
    expect(received.length).toBe(1)
    // 空 update 不报错
    expect(a.handleWebhook({}).status).toBe(200)
  })
})

describe('OpenClawAdapter 契约（mock fetch）', () => {
  const oldFetch = globalThis.fetch
  afterEach(() => { (globalThis as any).fetch = oldFetch })

  function mockFetch(handler: (url: string, init?: any) => any) {
    ;(globalThis as any).fetch = vi.fn(async (url: string, init?: any) => handler(url, init))
  }

  it('未配置 baseUrl：init false / send false / health false（不抛）', async () => {
    const a = new OpenClawAdapter()
    await expect(a.init({ enabled: true, type: 'openclaw', name: 'oc', credentials: {} })).resolves.toBe(false)
    await expect(a.send({ targetId: 't', isGroup: false, text: 'x' })).resolves.toBe(false)
    await expect(a.healthCheck()).resolves.toBe(false)
  })

  it('Gateway 可达时 init true，并把任务 POST 到 /a2a/message/send', async () => {
    const calls: Array<{ url: string; method?: string }> = []
    mockFetch(async (url, init) => {
      calls.push({ url, method: init?.method })
      if (url.endsWith('/health')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'ok', version: '0.2' }), json: async () => ({ version: '0.2' }) }
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }), json: async () => ({ ok: true }) }
    })
    const a = new OpenClawAdapter()
    await expect(a.init({ enabled: true, type: 'openclaw', name: 'oc', credentials: { baseUrl: 'http://127.0.0.1:18789' } })).resolves.toBe(true)
    await expect(a.send({ targetId: 'tg', isGroup: false, text: 'do task' })).resolves.toBe(true)
    expect(calls.some(c => c.url.endsWith('/a2a/message/send') && c.method === 'POST')).toBe(true)
  })

  it('Gateway 不可达（fetch reject）时 init false，绝不抛穿', async () => {
    mockFetch(async () => { throw new Error('ECONNREFUSED') })
    const a = new OpenClawAdapter()
    await expect(a.init({ enabled: true, type: 'openclaw', name: 'oc', credentials: { baseUrl: 'http://127.0.0.1:18789' } })).resolves.toBe(false)
  })
})
