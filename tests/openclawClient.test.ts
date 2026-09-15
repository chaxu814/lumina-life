// tests/openclawClient.test.ts — OpenClaw 桥接客户端测试（注入假 fetch，无网络）
import { describe, it, expect, vi } from 'vitest'
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
})
