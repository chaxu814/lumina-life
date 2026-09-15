// tests/unifiedChat.test.ts — 统一模型调用层测试（注入假 fetch）
import { describe, it, expect } from 'vitest'
import {
  parseProviderResponse,
  unifiedChatCompletion,
  listModels,
  UnifiedChatError,
} from '../electron/core/unifiedChat'

function jsonFetch(payload: any, seen?: { url: string; init: any }, ok = true, status = 200) {
  return async (url: string, init: any) => {
    if (seen) { seen.url = url; seen.init = init }
    return {
      ok, status,
      text: async () => JSON.stringify(payload),
      json: async () => payload,
    }
  }
}

const msgs = [{ role: 'user', content: '你好' }]

describe('parseProviderResponse', () => {
  it('OpenAI 兼容', () => {
    const r = parseProviderResponse('openai', {
      choices: [{ message: { content: 'hi' } }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    })
    expect(r.text).toBe('hi')
    expect(r.usage.total_tokens).toBe(3)
  })
  it('Anthropic content blocks + 用量字段归一', () => {
    const r = parseProviderResponse('anthropic', {
      content: [{ type: 'text', text: 'hello' }, { type: 'thinking', text: 'x' }],
      usage: { input_tokens: 4, output_tokens: 6 },
    })
    expect(r.text).toBe('hello')
    expect(r.usage.prompt_tokens).toBe(4)
    expect(r.usage.total_tokens).toBe(10)
  })
  it('Ollama message + eval_count', () => {
    const r = parseProviderResponse('ollama', { message: { content: 'yo' }, prompt_eval_count: 3, eval_count: 5 })
    expect(r.text).toBe('yo')
    expect(r.usage.completion_tokens).toBe(5)
  })
})

describe('unifiedChatCompletion', () => {
  it('OpenAI 兼容全链路：非流式、URL/请求体正确', async () => {
    const seen = { url: '', init: {} as any }
    const r = await unifiedChatCompletion(
      { baseUrl: 'http://127.0.0.1:1234/v1', apiKey: 'k', model: 'm', messages: msgs },
      { fetch: jsonFetch({ choices: [{ message: { content: 'pong' } }], usage: {} }, seen) },
    )
    expect(r.text).toBe('pong')
    expect(seen.url.endsWith('/chat/completions')).toBe(true)
    expect(JSON.parse(seen.init.body).stream).toBe(false)
  })

  it('HTTP 429 归一为带状态码的 UnifiedChatError', async () => {
    const bad = jsonFetch({ error: 'rate' }, undefined, false, 429)
    await expect(
      unifiedChatCompletion({ baseUrl: 'http://127.0.0.1:1234/v1', apiKey: 'k', model: 'm', messages: msgs }, { fetch: bad }),
    ).rejects.toMatchObject({ name: 'UnifiedChatError', code: 'http-error', status: 429 })
  })

  it('外部/超时 abort 归一为 timeout 错误', async () => {
    // 假 fetch 响应 abort 信号：被取消即 reject AbortError
    const abortAware = (_url: string, init: any) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const e = new Error('aborted'); (e as any).name = 'AbortError'; reject(e)
        })
      })
    await expect(
      unifiedChatCompletion(
        { baseUrl: 'http://127.0.0.1:1234/v1', apiKey: 'k', model: 'm', messages: msgs, timeoutMs: 5 },
        { fetch: abortAware as any },
      ),
    ).rejects.toBeInstanceOf(UnifiedChatError)
  })
})

describe('listModels', () => {
  it('OpenAI 兼容 /models 归一为 id 列表', async () => {
    const models = await listModels('http://127.0.0.1:1234/v1', 'k', {
      fetch: jsonFetch({ data: [{ id: 'a' }, { id: 'b' }] }),
    })
    expect(models.map(m => m.id)).toEqual(['a', 'b'])
  })
  it('Ollama /api/tags 映射 name', async () => {
    const models = await listModels('http://127.0.0.1:11434', '', {
      fetch: jsonFetch({ models: [{ name: 'qwen:latest' }] }),
    })
    expect(models[0].id).toBe('qwen:latest')
  })
})
