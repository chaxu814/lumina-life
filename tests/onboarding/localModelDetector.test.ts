// tests/onboarding/localModelDetector.test.ts — 本地模型探测单测
import { describe, it, expect } from 'vitest'
import {
  detectLMStudio,
  detectOllama,
  recommendLocalModel,
  extractModelsFromOpenAI,
  extractModelsFromOllama,
  pickRecommendedModel,
  type HttpGet,
} from '../../electron/onboarding/localModelDetector'

/** 构造一个按 URL 返回固定 JSON 的假 fetcher */
function fakeFetcher(map: Record<string, unknown>, failWith?: unknown): HttpGet {
  return async (url) => {
    if (failWith) {throw failWith}
    if (!(url in map)) {throw new Error('ECONNREFUSED ' + url)}
    return map[url]
  }
}

describe('extractModelsFromOpenAI', () => {
  it('从 data.data[].id 提取', () => {
    expect(extractModelsFromOpenAI({ data: [{ id: 'qwen3' }, { id: 'llama' }] })).toEqual(['qwen3', 'llama'])
  })
  it('空/非法返回空数组', () => {
    expect(extractModelsFromOpenAI(null)).toEqual([])
    expect(extractModelsFromOpenAI({})).toEqual([])
    expect(extractModelsFromOpenAI({ data: 'x' })).toEqual([])
  })
})

describe('extractModelsFromOllama', () => {
  it('从 models[].name 提取', () => {
    expect(extractModelsFromOllama({ models: [{ name: 'qwen3:14b' }] })).toEqual(['qwen3:14b'])
  })
  it('空返回空', () => {
    expect(extractModelsFromOllama({})).toEqual([])
  })
})

describe('pickRecommendedModel', () => {
  it('优先匹配偏好关键词', () => {
    expect(pickRecommendedModel(['llama3', 'qwen3'], ['qwen'])).toBe('qwen3')
  })
  it('无匹配取第一个', () => {
    expect(pickRecommendedModel(['a', 'b'])).toBe('a')
  })
  it('空列表返回空', () => {
    expect(pickRecommendedModel([])).toBe('')
  })
})

describe('detectLMStudio', () => {
  it('在线且有模型 → available', async () => {
    const f = fakeFetcher({ 'http://127.0.0.1:1234/v1/models': { data: [{ id: 'qwen3' }] } })
    const r = await detectLMStudio(1000, f)
    expect(r.available).toBe(true)
    expect(r.models).toEqual(['qwen3'])
    expect(r.recommended).toBe('qwen3')
  })
  it('在线但无模型 → available 但提示下载', async () => {
    const f = fakeFetcher({ 'http://127.0.0.1:1234/v1/models': { data: [] } })
    const r = await detectLMStudio(1000, f)
    expect(r.available).toBe(true)
    expect(r.models).toEqual([])
    expect(r.error).toMatch(/模型/)
  })
  it('不可达 → available:false', async () => {
    const f = fakeFetcher({}, new Error('ECONNREFUSED'))
    const r = await detectLMStudio(1000, f)
    expect(r.available).toBe(false)
  })
})

describe('detectOllama', () => {
  it('在线且有模型', async () => {
    const f = fakeFetcher({ 'http://127.0.0.1:11434/api/tags': { models: [{ name: 'qwen3:14b' }] } })
    const r = await detectOllama(1000, f)
    expect(r.available).toBe(true)
    expect(r.models).toEqual(['qwen3:14b'])
  })
  it('超时错误被捕获', async () => {
    const err = new Error('aborted') as any
    err.name = 'AbortError'
    const f = fakeFetcher({}, err)
    const r = await detectOllama(1000, f)
    expect(r.available).toBe(false)
    expect(r.error).toMatch(/超时/)
  })
})

describe('recommendLocalModel（优先级：LM Studio > Ollama）', () => {
  it('两者都在 → 选 LM Studio', async () => {
    const f = fakeFetcher({
      'http://127.0.0.1:1234/v1/models': { data: [{ id: 'lm-qwen' }] },
      'http://127.0.0.1:11434/api/tags': { models: [{ name: 'ollama-qwen' }] },
    })
    const r = await recommendLocalModel(1000, f)
    expect(r.provider).toBe('lmstudio')
    expect(r.recommended).toBe('lm-qwen')
  })
  it('只有 Ollama → 选 Ollama', async () => {
    const f = fakeFetcher({
      'http://127.0.0.1:11434/api/tags': { models: [{ name: 'qwen3' }] },
    })
    const r = await recommendLocalModel(1000, f)
    expect(r.provider).toBe('ollama')
  })
  it('都不可用 → provider:null 且给下载引导', async () => {
    const f = fakeFetcher({}, new Error('down'))
    const r = await recommendLocalModel(1000, f)
    expect(r.provider).toBeNull()
    expect(r.downloadGuide && r.downloadGuide.length).toBeGreaterThan(0)
  })
})
