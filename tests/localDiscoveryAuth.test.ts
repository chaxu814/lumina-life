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
    expect(src).toMatch(/discoverLocalProviders\(1200, apiKey, baseUrl \? \[baseUrl\] : \[\]\)/)
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
