// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// localProbeDiagnosis.test.ts — 本地探测失败原因分类（2026-10-05）
//
// 【这个 bug 的真实经过】
// 用户反馈：「我已经连接上 API 了（LM Studio），为什么还是连接使用不了？」
// 实测：LM Studio 正常、地址正确、配置已保存并「同步到 Team」，
//       但聊天面板持续显示「尚未配置 LLM」。
// 根因：LM Studio 开启了鉴权（/v1/models 返 401），而探测用的 key 不对；
//       401 被压成 found:[]，前端一律渲染成「尚未配置 LLM」。
//       于是用户按提示去反复检查 API 地址 —— 方向完全错了。
//
// 【这些测试锁定的行为】
// 三种完全不同的故障，必须给出三种完全不同的结论。
// 这类 bug 靠 code review 很难拦住，因为旧代码「看起来正常」——
// 它只是把所有错误都 return null。
// ============================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  discoverLocalProvidersDetailed,
  probeCandidateDetailed,
  probeConfiguredLocalProviderDetailed,
  type LocalCandidate,
} from '../electron/core/localProviderDiscovery'

// ── 用 mock fetch 模拟各类服务端响应 ──

function mockFetchOnce(handler: (url: string) => Response | Promise<Response>) {
  const spy = vi.fn(async (input: any) => handler(String(input)))
  ;(globalThis as any).fetch = spy
  return spy
}

function jsonResponse(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const CANDIDATE: LocalCandidate = {
  id: 'configured',
  label: '当前配置的本地服务',
  baseUrl: 'http://192.168.1.2:1234/v1',
  modelsPath: '/models',
  format: 'openai',
  preferKeywords: [],
}

describe('本地探测 · 失败原因分类', () => {
  const origFetch = (globalThis as any).fetch
  afterEach(() => { (globalThis as any).fetch = origFetch })

  // ══ 场景 1：成功（对照组，确保改造没把正常路径弄坏）══
  it('服务正常且已加载模型 → found 非空、summary.ok=true', async () => {
    mockFetchOnce(() => jsonResponse({ data: [{ id: 'qwen2.5-7b-instruct' }] }))
    const r = await discoverLocalProvidersDetailed(1000, '', ['http://192.168.1.2:1234/v1'])
    expect(r.found.length).toBeGreaterThan(0)
    expect(r.found[0].models).toContain('qwen2.5-7b-instruct')
    expect(r.summary.ok).toBe(true)
  })

  // ══ 场景 2：401 鉴权失败（用户遇到的那个）══
  it('401 → kind=auth，且无 key 时首选建议是「关掉鉴权」', async () => {
    mockFetchOnce(() => new Response('Unauthorized', { status: 401 }))
    const r = await discoverLocalProvidersDetailed(1000, '', ['http://192.168.1.2:1234/v1'])
    expect(r.found).toHaveLength(0)
    expect(r.summary.ok).toBe(false)
    expect(r.summary.kind).toBe('auth')
    // 无 key 时必须引导「关掉鉴权」而不是让用户去找 key
    expect(r.summary.advice).toContain('关闭 LM Studio')
  })

  it('401 且已填 key → 建议核对 key，同时仍提供关鉴权选项', async () => {
    mockFetchOnce(() => new Response('Unauthorized', { status: 401 }))
    const r = await discoverLocalProvidersDetailed(1000, 'wrong-key', ['http://192.168.1.2:1234/v1'])
    expect(r.summary.kind).toBe('auth')
    expect(r.summary.advice).toContain('API Key 不被接受')
    // 不应该只给一条路 —— 本地场景关掉鉴权往往更省事
    expect(r.summary.advice).toContain('Require Authentication')
  })

  it('403 与 401 同类处理', async () => {
    mockFetchOnce(() => new Response('Forbidden', { status: 403 }))
    const r = await discoverLocalProvidersDetailed(1000, 'k', ['http://192.168.1.2:1234/v1'])
    expect(r.summary.kind).toBe('auth')
  })

  // ══ 场景 3：服务没启动 ══
  it('连接被拒 → kind=unreachable，而不是「未配置」', async () => {
    mockFetchOnce(() => { throw new Error('ECONNREFUSED') })
    const r = await discoverLocalProvidersDetailed(1000, '', ['http://192.168.1.2:1234/v1'])
    expect(r.summary.kind).toBe('unreachable')
    expect(r.summary.advice).toContain('无法连接')
    expect(r.summary.advice).toContain('服务已启动')
  })

  it('超时 → kind=unreachable 且提示超时', async () => {
    const e: any = new Error('aborted')
    e.name = 'AbortError'
    mockFetchOnce(() => { throw e })
    const r = await discoverLocalProvidersDetailed(1000, '', ['http://192.168.1.2:1234/v1'])
    expect(r.summary.kind).toBe('unreachable')
    expect(r.summary.advice).toContain('超时')
  })

  // ══ 场景 4：服务正常但没加载模型（唯一「真的没配」的情况）══
  it('模型列表为空 → kind=no-model，提示去加载模型', async () => {
    mockFetchOnce(() => jsonResponse({ data: [] }))
    const r = await discoverLocalProvidersDetailed(1000, '', ['http://192.168.1.2:1234/v1'])
    expect(r.summary.kind).toBe('no-model')
    expect(r.summary.advice).toContain('加载')
  })

  // ══ 场景 5：其它 HTTP 错误 ══
  it('500 → kind=http', async () => {
    mockFetchOnce(() => new Response('boom', { status: 500 }))
    const r = await discoverLocalProvidersDetailed(1000, '', ['http://192.168.1.2:1234/v1'])
    expect(r.summary.kind).toBe('http')
    expect(r.summary.advice).toContain('500')
  })

  it('地址填错导致 404 → 提示检查 /v1 后缀', async () => {
    mockFetchOnce(() => new Response('Not Found', { status: 404 }))
    const r = await discoverLocalProvidersDetailed(1000, '', ['http://192.168.1.2:1234/v1'])
    expect(r.summary.advice).toContain('/v1')
  })

  // ══ 关键回归：三种原因必须【区分开】══
  it('回归：401 / 连不上 / 没加载模型 必须给出三种不同结论', async () => {
    // 旧实现下这三种全部返回 found:[] → 界面统一显示「尚未配置 LLM」
    const kinds: string[] = []

    mockFetchOnce(() => new Response('x', { status: 401 }))
    kinds.push((await discoverLocalProvidersDetailed(1000, '', ['http://192.168.1.2:1234/v1'])).summary.kind!)

    mockFetchOnce(() => { throw new Error('ECONNREFUSED') })
    kinds.push((await discoverLocalProvidersDetailed(1000, '', ['http://192.168.1.2:1234/v1'])).summary.kind!)

    mockFetchOnce(() => jsonResponse({ data: [] }))
    kinds.push((await discoverLocalProvidersDetailed(1000, '', ['http://192.168.1.2:1234/v1'])).summary.kind!)

    expect(kinds).toEqual(['auth', 'unreachable', 'no-model'])
    expect(new Set(kinds).size).toBe(3) // 三者不得混淆
  })

  // ══ 候选端点优先级 ══
  it('「当前配置的端点」的失败原因优先于内置候选', async () => {
    // 内置候选（127.0.0.1:1234）返回 200，当前配置的（192.168.1.2）返回 401
    mockFetchOnce((url) => {
      if (url.includes('192.168.1.2')) {return new Response('Unauthorized', { status: 401 })}
      return jsonResponse({ data: [] })
    })
    const r = await discoverLocalProvidersDetailed(1000, '', ['http://192.168.1.2:1234/v1'])
    // 用户真正在用的是 192.168.1.2，结论必须反映它的失败原因
    expect(r.summary.kind).toBe('auth')
  })

  it('探测明细保留每个候选的失败原因，便于日志排查', async () => {
    mockFetchOnce(() => new Response('Unauthorized', { status: 401 }))
    const r = await discoverLocalProvidersDetailed(1000, '', ['http://192.168.1.2:1234/v1'])
    expect(r.failures.length).toBeGreaterThan(0)
    for (const f of r.failures) {
      expect(f.advice).toBeTruthy()
      expect(f.baseUrl).toBeTruthy()
    }
  })

  it('probeCandidateDetailed 成功时不产生 failure', async () => {
    mockFetchOnce(() => jsonResponse({ data: [{ id: 'm1' }] }))
    const r = await probeCandidateDetailed(CANDIDATE, 1000, '')
    expect(r.provider).not.toBeNull()
    expect(r.failure).toBeNull()
  })

  it('probeCandidateDetailed 失败时 provider 为 null 且 failure 非空（不再两者皆空）', async () => {
    mockFetchOnce(() => new Response('x', { status: 401 }))
    const r = await probeCandidateDetailed(CANDIDATE, 1000, '')
    expect(r.provider).toBeNull()
    expect(r.failure).not.toBeNull()
    expect(r.failure!.kind).toBe('auth')
  })

  it('Team Agent 就绪探测只测指定端点与指定 Key，不用其它 Agent 的可用 Key 冒充', async () => {
    const spy = vi.fn(async (input: any) => {
      const url = String(input)
      if (url !== 'http://192.168.1.20:1234/v1/models') {
        return jsonResponse({ data: [{ id: 'wrong-endpoint-model' }] })
      }
      return new Response('Unauthorized', { status: 401 })
    })
    ;(globalThis as any).fetch = spy

    const r = await probeConfiguredLocalProviderDetailed(
      'http://192.168.1.20:1234/v1', 'lmstudio', 'lumina-wrong-key', 1000,
    )
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toBe('http://192.168.1.20:1234/v1/models')
    expect(r.provider).toBeNull()
    expect(r.failure?.kind).toBe('auth')
  })

  it('Team Agent 就绪探测用传入的准确 API Key 验证本地端点', async () => {
    const spy = vi.fn(async (_input: any, init: any) => {
      expect(init.headers.Authorization).toBe('Bearer exact-lumina-key')
      return jsonResponse({ data: [{ id: 'qwen2.5-7b-instruct' }] })
    })
    ;(globalThis as any).fetch = spy

    const r = await probeConfiguredLocalProviderDetailed(
      'http://192.168.1.20:1234/v1', 'lmstudio', 'exact-lumina-key', 1000,
    )
    expect(spy).toHaveBeenCalledTimes(1)
    expect(r.provider?.models).toEqual(['qwen2.5-7b-instruct'])
    expect(r.failure).toBeNull()
  })

  it('指定 Ollama Agent 时只探测 /api/tags，并按 Ollama 格式解析模型', async () => {
    const spy = vi.fn(async (input: any) => {
      expect(String(input)).toBe('http://127.0.0.1:11434/api/tags')
      return jsonResponse({ models: [{ name: 'qwen3:8b' }] })
    })
    ;(globalThis as any).fetch = spy

    const r = await probeConfiguredLocalProviderDetailed(
      'http://127.0.0.1:11434', 'ollama', '', 1000,
    )
    expect(spy).toHaveBeenCalledTimes(1)
    expect(r.provider?.models).toEqual(['qwen3:8b'])
    expect(r.failure).toBeNull()
  })
})
