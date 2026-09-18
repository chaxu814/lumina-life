// tests/openclawClient.test.ts — OpenClaw 桥接客户端测试（注入假 fetch，无网络）
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { OpenClawClient, type FetchLike } from '../electron/channels/openclaw/openclawClient'

function mockFetch(response: { ok?: boolean; status?: number; body?: any }, spyUrl?: { url: string; init: any }): FetchLike {
  return (async (url: string, init?: any) => {
    if (spyUrl) { spyUrl.url = url; spyUrl.init = init }
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      text: async () => (typeof response.body === 'string' ? response.body : JSON.stringify(response.body ?? {})),
      json: async () => response.body ?? {},
    }
  }) as FetchLike
}

describe('OpenClawClient', () => {
  it('未配置 baseUrl 时安全返回 not-configured，不抛异常', async () => {
    const c = new OpenClawClient({ baseUrl: '' }, mockFetch({}))
    expect(c.isConfigured()).toBe(false)
    const r = await c.ping()
    expect(r.ok).toBe(false)
    expect(r.error).toBe('openclaw-not-configured')
  })

  it('ping 成功并携带 Bearer token', async () => {
    const seen: { url: string; init: any } = { url: '', init: {} }
    const c = new OpenClawClient({ baseUrl: 'http://127.0.0.1:18789/', token: 'tkn' }, mockFetch({ body: { status: 'ok', version: '2.0' } }, seen))
    const r = await c.ping()
    expect(r.ok).toBe(true)
    expect(r.data?.version).toBe('2.0')
    expect(seen.url).toBe('http://127.0.0.1:18789/health') // 末尾斜杠被规范化
    expect(seen.init.headers.Authorization).toBe('Bearer tkn')
  })

  it('HTTP 500 返回带状态码的错误结果', async () => {
    const c = new OpenClawClient({ baseUrl: 'http://x' }, mockFetch({ ok: false, status: 500, body: 'err' }))
    const r = await c.callTool('shell', { cmd: 'ls' })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(500)
  })

  it('网络层 reject 时返回 unreachable（不抛穿）', async () => {
    const bad: FetchLike = (async () => { throw new Error('ECONNREFUSED') }) as FetchLike
    const c = new OpenClawClient({ baseUrl: 'http://x', timeoutMs: 50 }, bad)
    const r = await c.sendTask({ text: '帮我整理下载目录' })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('openclaw-unreachable')
  })

  it('sendTask 请求体携带 message.text 与目标', async () => {
    const seen: { url: string; init: any } = { url: '', init: {} }
    const c = new OpenClawClient({ baseUrl: 'http://x', agentId: 'lumina' }, mockFetch({ body: { text: 'done' } }, seen))
    const r = await c.sendTask({ text: '打开记事本', targetId: 'desktop' })
    expect(r.ok).toBe(true)
    expect(seen.url).toContain('/a2a/message/send')
    const body = JSON.parse(seen.init.body)
    expect(body.message.text).toBe('打开记事本')
    expect(body.agentId).toBe('lumina')
  })

  it('超时（AbortError）返回 openclaw-timeout', async () => {
    const hang: FetchLike = (async (_url: string, init?: any) => {
      return new Promise((_res, rej) => {
        init.signal.addEventListener('abort', () => {
          const e: any = new Error('aborted'); e.name = 'AbortError'; rej(e)
        })
      })
    })
    const c = new OpenClawClient({ baseUrl: 'http://x', timeoutMs: 20 }, hang)
    const r = await c.ping()
    expect(r.ok).toBe(false)
    expect(r.error).toBe('openclaw-timeout')
  })
})

// 渠道适配器：把 OpenClaw 当作「可选执行后端」，任何故障都安全回退
describe('OpenClawAdapter 渠道适配器', () => {
  let originalFetch: any
  beforeEach(() => { originalFetch = globalThis.fetch })
  afterEach(() => { globalThis.fetch = originalFetch })

  it('未配置 baseUrl：init/send/health 都安全返回 false，不抛错', async () => {
    const { OpenClawAdapter } = await import('../electron/channels/adapters/openclaw')
    const a = new OpenClawAdapter()
    expect(await a.init({ credentials: {}, options: {} } as any)).toBe(false)
    expect(await a.send({ text: 'x' } as any)).toBe(false)
    expect(await a.healthCheck()).toBe(false)
    await a.destroy()
  })

  it('网关可达：init=true、health=true、send 委托成功', async () => {
    globalThis.fetch = (async (url: string) => {
      if (url.endsWith('/health')) return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'ok' }), json: async () => ({ status: 'ok' }) }
      if (url.endsWith('/a2a/message/send')) return { ok: true, status: 200, text: async () => JSON.stringify({ text: 'ok' }), json: async () => ({ text: 'ok' }) }
      return { ok: false, status: 404, text: async () => '', json: async () => ({}) }
    }) as any
    const { OpenClawAdapter } = await import('../electron/channels/adapters/openclaw')
    const a = new OpenClawAdapter()
    expect(await a.init({ credentials: { baseUrl: 'http://x' } } as any)).toBe(true)
    expect(await a.healthCheck()).toBe(true)
    expect(await a.send({ text: '执行', targetId: 't' } as any)).toBe(true)
    await a.destroy()
  })

  it('网关不可达：init=false（不影响其它渠道）', async () => {
    globalThis.fetch = (async () => { throw new Error('down') }) as any
    const { OpenClawAdapter } = await import('../electron/channels/adapters/openclaw')
    const a = new OpenClawAdapter()
    expect(await a.init({ credentials: { baseUrl: 'http://x' } } as any)).toBe(false)
  })
})

