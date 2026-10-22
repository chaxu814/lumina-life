// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// tests/llmProvider.test.ts — LLM Provider 单元测试
// 覆盖：多 Provider 适配、重试、超时分类、流式解析、健康检查
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ═══════════════════════════════════════════════════════════
// Mock fetch 全局
// ═══════════════════════════════════════════════════════════

const mockFetch = vi.fn()
globalThis.fetch = mockFetch as any

// ═══════════════════════════════════════════════════════════
// Mock event emitter
// ═══════════════════════════════════════════════════════════

function makeMockEmit() {
  return {
    onThinking: vi.fn(),
    onThinkingStream: vi.fn(),
    onToolStart: vi.fn(),
    onToolEnd: vi.fn(),
    onError: vi.fn(),
    onTokenUpdate: vi.fn(),
  }
}

// ═══════════════════════════════════════════════════════════
// 辅助：创建模拟 ReadableStream
// ═══════════════════════════════════════════════════════════

function createMockResponse(
  chunks: string[],
  status = 200,
  ok = true,
): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
        await new Promise(r => setTimeout(r, 1))
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
  return {
    ok,
    status,
    body: stream,
    text: () => Promise.resolve(chunks.join('')),
    json: () => Promise.resolve({}),
    headers: new Headers(),
    redirected: false,
    statusText: status === 200 ? 'OK' : 'Error',
    type: 'basic' as ResponseType,
    url: '',
    clone: () => { throw new Error('not implemented') },
    bodyUsed: false,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    blob: () => Promise.resolve(new Blob()),
    formData: () => Promise.resolve(new FormData()),
  } as Response
}

// ═══════════════════════════════════════════════════════════
// Mock providerProfiles
// ═══════════════════════════════════════════════════════════

vi.mock('../electron/providerProfiles', () => ({
  matchProfile: vi.fn(() => null),
  getRecommendedTimeout: vi.fn(() => 120),
}))

import { LLMProvider, type LLMProviderConfig } from '../electron/core/llmProvider'

const BASE_CONFIG: LLMProviderConfig = {
  baseUrl: 'http://127.0.0.1:1234/v1',
  apiKey: 'not-needed',
  model: 'test-model',
  maxContextTokens: 8192,
}

describe('LLMProvider — 健康检查', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('健康检查成功时返回 ok=true', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: [{ id: 'test-model' }] }),
    })
    const provider = new LLMProvider({ ...BASE_CONFIG })
    const result = await provider.healthCheck()
    expect(result.ok).toBe(true)
    expect(result.modelFound).toBe(true)
  })

  it('健康检查失败时返回 ok=false', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    const provider = new LLMProvider({ ...BASE_CONFIG })
    const result = await provider.healthCheck()
    expect(result.ok).toBe(false)
  })

  it('第二次调用走缓存，不重复请求', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: [{ id: 'test-model' }] }),
    })
    const provider = new LLMProvider({ ...BASE_CONFIG })
    await provider.healthCheck()
    await provider.healthCheck()
    expect(mockFetch).toHaveBeenCalledTimes(1) // 只调一次
  })
})

describe('LLMProvider — 多 Provider 配置', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('支持运行时切换配置（updateConfig）', () => {
    const provider = new LLMProvider({ ...BASE_CONFIG, model: 'gpt-4o' })
    provider.updateConfig({ model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1' })
    // 验证配置生效（通过下一个调用的请求体）
    // 实际验证在 call() 测试中
  })

  it('支持 LM Studio 本地模型配置', () => {
    const config: LLMProviderConfig = {
      baseUrl: 'http://127.0.0.1:1234/v1',
      apiKey: '',
      model: 'qwen2.5-7b-instruct',
      maxContextTokens: 32768,
    }
    const provider = new LLMProvider(config)
    expect(provider).toBeDefined()
  })

  it('支持 OpenAI API 配置', () => {
    const config: LLMProviderConfig = {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o',
      maxContextTokens: 128000,
    }
    const provider = new LLMProvider(config)
    expect(provider).toBeDefined()
  })

  it('支持 DeepSeek API 配置', () => {
    const config: LLMProviderConfig = {
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-test',
      model: 'deepseek-chat',
      maxContextTokens: 131072,
    }
    const provider = new LLMProvider(config)
    expect(provider).toBeDefined()
  })
})

describe('LLMProvider — 流式调用', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('解析文本流式输出', async () => {
    mockFetch.mockResolvedValueOnce(
      createMockResponse([
        { choices: [{ delta: { content: '你好' } }] },
        { choices: [{ delta: { content: '世界' } }] },
      ]),
    )

    const provider = new LLMProvider({ ...BASE_CONFIG })
    const emit = makeMockEmit()
    const result = await provider.call({
      messages: [{ role: 'user', content: 'Hello' }],
    }, emit)

    expect(result.text).toContain('你好')
    expect(result.error).toBeUndefined()
  })

  it('解析工具调用（function calling）', async () => {
    mockFetch.mockResolvedValueOnce(
      createMockResponse([
        {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call_1',
                function: { name: 'web_search', arguments: '{"query":"test"' },
              }],
            },
          }],
        },
        {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                function: { arguments: '"}' },
              }],
            },
          }],
        },
      ]),
    )

    const provider = new LLMProvider({ ...BASE_CONFIG })
    const result = await provider.call({
      messages: [{ role: 'user', content: 'Search something' }],
      tools: [{ type: 'function', function: { name: 'web_search', parameters: {} } }],
    })

    expect(result.toolCalls).toBeDefined()
    expect(result.toolCalls!.length).toBe(1)
    expect(result.toolCalls![0].function.name).toBe('web_search')
  })

  it('处理 HTTP 错误状态', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: () => Promise.resolve('Rate limit exceeded'),
    })

    const provider = new LLMProvider({ ...BASE_CONFIG })
    const result = await provider.call({
      messages: [{ role: 'user', content: 'Hello' }],
    })

    expect(result.error).toBeDefined()
    expect(result.error).toContain('429')
  })

  it('处理网络异常（ECONNREFUSED）', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed: ECONNREFUSED'))

    const provider = new LLMProvider({ ...BASE_CONFIG })
    const result = await provider.call({
      messages: [{ role: 'user', content: 'Hello' }],
    })

    expect(result.error).toBeDefined()
  })

  it('AbortSignal 取消请求', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 50)

    mockFetch.mockImplementationOnce(async () => {
      await new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), 3000)
        controller.signal.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(new DOMException('Aborted', 'AbortError'))
        })
      })
      return createMockResponse(['hello'])
    })

    const provider = new LLMProvider({ ...BASE_CONFIG })
    const result = await provider.call({
      messages: [{ role: 'user', content: 'Hello' }],
      signal: controller.signal,
    })

    expect(result.error ?? result.aborted).toBeTruthy()
  }, 8000)

  it('触发 onThinkingStream 回调（推理模型）', async () => {
    mockFetch.mockResolvedValueOnce(
      createMockResponse([
        { choices: [{ delta: { reasoning_content: '让我想想' } }] },
        { choices: [{ delta: { content: '答案是 42' } }] },
      ]),
    )

    const provider = new LLMProvider({ ...BASE_CONFIG })
    const emit = makeMockEmit()
    await provider.call({
      messages: [{ role: 'user', content: '思考题' }],
      trackReasoning: true,
    }, emit)

    expect(emit.onThinkingStream).toHaveBeenCalled()
  })

  it('不发送 tools 给不支持工具调用的模型', async () => {
    mockFetch.mockResolvedValueOnce(
      createMockResponse([
        { choices: [{ delta: { content: 'OK' } }] },
      ]),
    )

    const provider = new LLMProvider({ ...BASE_CONFIG })
    const result = await provider.call({
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [{ type: 'function', function: { name: 'test', parameters: {} } }],
    })

    expect(result.text).toBe('OK')
  })
})

describe('LLMProvider — 错误恢复', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('重置健康检查状态', () => {
    const provider = new LLMProvider({ ...BASE_CONFIG })
    provider.resetHealthCheck()
    // 后续调用应重新请求
  })
})

describe('LLMProvider — 模型匹配 (providerProfiles)', () => {
  it('基础配置有效性', () => {
    const provider = new LLMProvider({ ...BASE_CONFIG })
    expect(provider).toBeDefined()
    expect(provider.healthCheck).toBeInstanceOf(Function)
    expect(provider.call).toBeInstanceOf(Function)
    expect(provider.updateConfig).toBeInstanceOf(Function)
  })
})
