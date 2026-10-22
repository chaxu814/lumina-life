// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// tests/providerAdapter.test.ts — Provider 适配层单元测试
import { describe, it, expect } from 'vitest'
import {
  identifyProvider,
  getProviderCapabilities,
  adaptRequestBody,
  ProviderAdapter,
} from '../electron/core/providerAdapter'

describe('ProviderAdapter — Provider 识别', () => {
  it('识别 OpenAI', () => {
    expect(identifyProvider('https://api.openai.com/v1')).toBe('openai')
    expect(identifyProvider('https://api.openai.com')).toBe('openai')
  })

  it('识别 Anthropic', () => {
    expect(identifyProvider('https://api.anthropic.com')).toBe('anthropic')
  })

  it('识别 DeepSeek', () => {
    expect(identifyProvider('https://api.deepseek.com/v1')).toBe('deepseek')
  })

  it('识别 Ollama', () => {
    expect(identifyProvider('http://localhost:11434')).toBe('ollama')
  })

  it('识别 LM Studio / 本地', () => {
    expect(identifyProvider('http://127.0.0.1:1234/v1')).toBe('lmstudio')
    expect(identifyProvider('http://localhost:1234')).toBe('lmstudio')
  })

  it('识别 DashScope', () => {
    expect(identifyProvider('https://dashscope.aliyuncs.com')).toBe('dashscope')
  })

  it('识别 SiliconFlow', () => {
    expect(identifyProvider('https://api.siliconflow.cn/v1')).toBe('siliconflow')
  })

  it('识别 智谱', () => {
    expect(identifyProvider('https://open.bigmodel.cn/api/paas/v4')).toBe('zhipu')
  })

  it('未知地址返回 unknown', () => {
    expect(identifyProvider('https://custom.api.com')).toBe('unknown')
  })
})

describe('ProviderAdapter — 能力表', () => {
  it('OpenAI 支持 vision 和 function calling', () => {
    const caps = getProviderCapabilities('https://api.openai.com/v1')
    expect(caps.nativeFunctionCalling).toBe(true)
    expect(caps.supportsVision).toBe(true)
    expect(caps.rateLimit.rpm).toBe(500)
  })

  it('Ollama 不支持 function calling', () => {
    const caps = getProviderCapabilities('http://localhost:11434')
    expect(caps.nativeFunctionCalling).toBe(false)
    expect(caps.jsonModeOnly).toBe(true)
    expect(caps.maxTools).toBe(0)
  })

  it('LM Studio 支持 function calling', () => {
    const caps = getProviderCapabilities('http://127.0.0.1:1234/v1')
    expect(caps.nativeFunctionCalling).toBe(true)
    expect(caps.recommendedTimeout).toBe(600) // 本地超时高
  })

  it('DeepSeek 不支持 vision', () => {
    const caps = getProviderCapabilities('https://api.deepseek.com/v1')
    expect(caps.supportsVision).toBe(false)
  })
})

describe('ProviderAdapter — 请求体适配', () => {
  const baseMessages = [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Hello!' },
  ]

  const baseTools = [
    { type: 'function', function: { name: 'web_search', description: 'Search', parameters: { type: 'object', properties: {} } } },
  ]

  it('OpenAI 兼容默认格式', () => {
    const adapted = adaptRequestBody({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o',
      messages: baseMessages,
      tools: baseTools,
    })
    expect(adapted.url).toContain('/chat/completions')
    expect(adapted.body.model).toBe('gpt-4o')
    expect(adapted.body.tools).toBeDefined()
    expect(adapted.body.tools.length).toBe(1)
    expect(adapted.headers['Authorization']).toBe('Bearer sk-test')
  })

  it('Anthropic 使用独立格式', () => {
    const adapted = adaptRequestBody({
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-ant-test',
      model: 'claude-3-opus-20240229',
      messages: baseMessages,
      tools: baseTools,
    })
    expect(adapted.url).toContain('/v1/messages')
    expect(adapted.body.max_tokens).toBeDefined()
    expect(adapted.headers['x-api-key']).toBe('sk-ant-test')
    expect(adapted.headers['anthropic-version']).toBeDefined()
  })

  it('Ollama 使用独立格式且不含 tools', () => {
    const adapted = adaptRequestBody({
      baseUrl: 'http://localhost:11434',
      apiKey: '',
      model: 'llama3',
      messages: baseMessages,
      tools: baseTools, // Ollama 不支持 tools，应忽略
    })
    expect(adapted.url).toContain('/api/chat')
    expect(adapted.body.tools).toBeUndefined()
    expect(adapted.body.options.temperature).toBe(0.7)
  })

  it('DeepSeek 使用 OpenAI 兼容格式', () => {
    const adapted = adaptRequestBody({
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-test',
      model: 'deepseek-chat',
      messages: baseMessages,
    })
    expect(adapted.url).toContain('/chat/completions')
    expect(adapted.body.model).toBe('deepseek-chat')
  })

  it('LM Studio 使用 OpenAI 兼容格式', () => {
    const adapted = adaptRequestBody({
      baseUrl: 'http://127.0.0.1:1234/v1',
      apiKey: '',
      model: 'qwen2.5-7b-instruct',
      messages: baseMessages,
    })
    expect(adapted.url).toContain('/chat/completions')
  })

  it('DashScope 使用 + stream_options', () => {
    const adapted = adaptRequestBody({
      baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
      apiKey: 'sk-test',
      model: 'qwen-max',
      messages: baseMessages,
    })
    expect(adapted.body.stream_options).toBeDefined()
  })
})

describe('ProviderAdapter — 简短 API', () => {
  it('ProviderAdapter.identify 工作', () => {
    expect(ProviderAdapter.identify('https://api.openai.com')).toBe('openai')
  })

  it('ProviderAdapter.getCapabilities 工作', () => {
    const caps = ProviderAdapter.getCapabilities('https://api.openai.com')
    expect(caps.supportsSystemPrompt).toBe(true)
  })

  it('ProviderAdapter.adaptRequest 工作', () => {
    const result = ProviderAdapter.adaptRequest({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hi' }],
    })
    expect(result.url).toContain('/chat/completions')
  })
})
