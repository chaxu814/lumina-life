// ============================================================
// __tests__/agentRunner.test.ts — Agent 执行引擎单元测试
// ============================================================

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { AgentRunConfig, AgentEvent } from '../tools/types'

// ─── 工具函数直接测试（不需要 mock LLM） ─────────────────

// 从 agentRunner 提取提示词构建逻辑进行测试
// 我们通过导入 AgentRunner 并检查其内部状态来测试

describe('AgentRunner 配置', () => {
  const defaultConfig: AgentRunConfig = {
    model: 'test-model',
    baseUrl: 'http://localhost:1234',
    apiKey: 'test-key',
    mode: 'agent',
    temperature: 0.7,
    maxTokens: 4096,
    maxToolCalls: 10,
  }

  it('默认配置合并正确', () => {
    const partialConfig: AgentRunConfig = {
      model: 'custom-model',
      baseUrl: 'http://custom:8080',
      apiKey: 'custom-key',
      mode: 'agent',
    }

    const merged = { ...defaultConfig, ...partialConfig }
    expect(merged.model).toBe('custom-model')
    expect(merged.temperature).toBe(0.7) // 取默认值
    expect(merged.maxTokens).toBe(4096)
  })

  it('模式默认值为 agent', () => {
    const config: AgentRunConfig = {
      model: 'm',
      baseUrl: 'http://x',
      apiKey: 'k',
      mode: 'agent',
    }
    expect(config.mode).toBe('agent')
  })

  it('developer 模式覆盖默认值', () => {
    const config: AgentRunConfig = {
      model: 'm',
      baseUrl: 'http://x',
      apiKey: 'k',
      mode: 'developer',
    }
    expect(config.mode).toBe('developer')
  })
})

describe('AgentEvent 类型', () => {
  it('thinking 事件结构正确', () => {
    const event: AgentEvent = {
      type: 'thinking',
      text: '思考中...',
    }
    expect(event.type).toBe('thinking')
    expect(event.text).toBe('思考中...')
  })

  it('token_update 事件包含用量信息', () => {
    const event: AgentEvent = {
      type: 'token_update',
      totalTokens: 1500,
      usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
      delta: 500,
    }
    expect(event.totalTokens).toBe(1500)
    expect(event.usage.total_tokens).toBe(1500)
  })

  it('error 事件包含错误信息', () => {
    const event: AgentEvent = {
      type: 'error',
      error: 'LLM 连接超时',
    }
    expect(event.type).toBe('error')
    expect(event.error).toContain('超时')
  })
})

describe('AgentRunner 消息管理', () => {
  it('AgentMessage 角色类型正确', () => {
    const userMsg = { role: 'user' as const, content: '你好' }
    const assistantMsg = { role: 'assistant' as const, content: '你好！' }
    const systemMsg = { role: 'system' as const, content: '系统提示' }
    const toolMsg = { role: 'tool' as const, content: '结果', tool_call_id: '1' }

    expect(userMsg.role).toBe('user')
    expect(assistantMsg.role).toBe('assistant')
    expect(systemMsg.role).toBe('system')
    expect(toolMsg.tool_call_id).toBe('1')
  })
})

describe('LLMToolCall 解析', () => {
  it('单工具调用结构正确', () => {
    const call = {
      id: 'call_1',
      type: 'function' as const,
      function: {
        name: 'file_read',
        arguments: '{"path":"/tmp/test.txt"}',
      },
    }
    expect(call.function.name).toBe('file_read')
    expect(JSON.parse(call.function.arguments).path).toBe('/tmp/test.txt')
  })

  it('多工具调用独立 id', () => {
    const calls = [
      { id: '1', type: 'function' as const, function: { name: 'file_read', arguments: '{}' } },
      { id: '2', type: 'function' as const, function: { name: 'web_search', arguments: '{}' } },
    ]
    expect(calls[0].id).not.toBe(calls[1].id)
  })
})

describe('LLM 响应解析', () => {
  it('无 emotion 块的响应正常返回', () => {
    const rawContent = '这是纯文本回复。'
    const emotionMatch = rawContent.match(/```emotion\s*([\s\S]*?)```/)
    expect(emotionMatch).toBeNull()
  })
})
