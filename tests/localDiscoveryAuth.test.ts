// 复现 2026-10-04 的黄框问题：LM Studio 开启鉴权后，
// 本地模型探测不带 Authorization 头 → /v1/models 返回 401
// → 判定「本地没加载模型」→ localModelReady=false → llmReady=false
// → 界面弹出「尚未配置 LLM · 模拟回复模式」黄框，而服务其实完全正常。
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import {
  discoverLocalProviders,
  probeCandidate,
  extractModels,
  pickRecommendedModel,
  LOCAL_CANDIDATES,
} from '../electron/core/localProviderDiscovery'

describe('本地探测：必须带鉴权', () => {
  it('fetchWithTimeout 接受 apiKey 并写入 Authorization 头', () => {
    const src = fs.readFileSync('electron/core/localProviderDiscovery.ts', 'utf-8')
    expect(src).toMatch(/headers\['Authorization'\] = `Bearer \$\{apiKey\}`/)
    // 旧的裸 fetch（无 headers）不得再出现
    expect(src).not.toMatch(/fetch\(url, \{ signal: ctrl\.signal, method: 'GET' \}\)/)
  })

  it('假占位值 apiKey:"local" 不再返回（会当 Bearer 发出去必然 401）', () => {
    const src = fs.readFileSync('electron/core/localProviderDiscovery.ts', 'utf-8')
    expect(src).not.toMatch(/apiKey:\s*'local',/)
  })

  it('发现函数接受 configuredApiKey 与 extraBases', () => {
    const src = fs.readFileSync('electron/core/localProviderDiscovery.ts', 'utf-8')
    expect(src).toMatch(/configuredApiKey\?: string/)
    expect(src).toMatch(/extraBases: string\[\] = \[\]/)
  })

  it('IPC 调用方确实把当前 key 和端点传进去了', () => {
    const src = fs.readFileSync('electron/core/providerManager.ts', 'utf-8')
    // 🔧 2026-10-05：调用点改为 discoverLocalProvidersDetailed。
    //   原因：旧版把 401 / 连不上 / 没加载模型一律压成 found:[]，
    //   前端只能统一显示「尚未配置 LLM」——用户无法判断到底该改地址还是改 key。
    //   Detailed 版本额外返回 failures + summary，把原因如实报上来。
    expect(src).toMatch(/discoverLocalProvidersDetailed\(/)
    // 超时从 1200ms 提到 3000ms：局域网首包超过 1.2s 很常见，
    // 1.2s 会把「服务正常但慢」误判成「连不上」。
    expect(src).toMatch(/discoverLocalProvidersDetailed\(3000,/)
    // 端点与 key 仍必须来自激活供应商（不能丢）
    expect(src).toMatch(/extraBases\.push\(baseUrl\)/)
    expect(src).toMatch(/extraKeys\.push\(apiKey\)/)
  })

  it('探测还应把 Agent 独立配置纳入候选（配置漂移时的兜底）', () => {
    const src = fs.readFileSync('electron/core/providerManager.ts', 'utf-8')
    // 实测故障：用户配好了 lmstudio 并「同步到 Team」，但激活供应商仍是旧的
    // deepseek（且 key 为空）→ 探测拿空 key → 401 → 误报「尚未配置 LLM」。
    // 修法：把 agent-llm-configs.json 里的端点/key 也拿来试。
    expect(src).toMatch(/getAgentConfig\(\)/)
    expect(src).toMatch(/\['lumina',\s*'recha',\s*'yak'\]/)
    expect(src).toMatch(/extraBases\.push\(c\.endpoint\)/)
    // 逐个 key 试，第一个能用的写回激活供应商
    expect(src).toMatch(/r\.summary\.kind !== 'auth'/)
    expect(src).toMatch(/setProviderConfig/)
  })
})

describe('额外候选端点（局域网 LM Studio）', () => {
  it('端点已含 /v1 时不再拼 /v1，否则会变成 /v1/v1/models', () => {
    // 实测：GET http://127.0.0.1:1234/v1/v1/models -> "Unexpected endpoint or method"
    const src = fs.readFileSync('electron/core/localProviderDiscovery.ts', 'utf-8')
    expect(src).toMatch(/modelsPath: \/\\\/v1\$\/i\.test\(base\) \? '\/models' : '\/v1\/models'/)
  })

  it('baseUrl 去重与末尾斜杠清理', async () => {
    // 传 127.0.0.1:1234/v1（已在候选表里）不应产生重复项
    const res = await discoverLocalProviders(300, undefined, ['http://127.0.0.1:1234/v1', 'http://127.0.0.1:1234/v1/'])
    const bases = res.map(r => r.baseUrl)
    expect(new Set(bases).size).toBe(bases.length)
  })

  it('网络不可达时返回空数组而不是抛错（不能让启动阻塞）', async () => {
    const res = await discoverLocalProviders(200, undefined, [])
    expect(Array.isArray(res)).toBe(true)
  })
})

describe('既有纯逻辑未被破坏', () => {
  it('extractModels 同时支持 openai 与 ollama 两种格式', () => {
    expect(extractModels('openai', { data: [{ id: 'a' }, { id: 'b' }] })).toEqual(['a', 'b'])
    expect(extractModels('ollama', { models: [{ name: 'qwen2.5:7b' }] })).toEqual(['qwen2.5:7b'])
    expect(extractModels('openai', null)).toEqual([])
  })

  it('pickRecommendedModel 优先中文友好关键词', () => {
    expect(pickRecommendedModel(['llama3', 'qwen2.5:7b'], ['qwen'])).toBe('qwen2.5:7b')
    expect(pickRecommendedModel(['a', 'b'], ['zzz'])).toBe('a')
    expect(pickRecommendedModel([], ['qwen'])).toBe('')
  })

  it('候选表仍包含 ollama 与 lm-studio', () => {
    const ids = LOCAL_CANDIDATES.map(c => c.id)
    expect(ids).toContain('ollama')
    expect(ids).toContain('lm-studio')
  })

  it('probeCandidate 对不可达地址返回 null', async () => {
    const r = await probeCandidate(
      { id: 'x', label: 'x', baseUrl: 'http://127.0.0.1:1', modelsPath: '/v1/models', format: 'openai', preferKeywords: [] },
      200,
    )
    expect(r).toBeNull()
  })
})
