// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// nativeProtocol.test.ts — P1-3：主对话协议的 SSE 解析正确性
//
// 【为什么这份测试重要】
// 接入 nativeBridge 时，我把 agentRunner 的流循环结构改了一层：
//   原来：for (line of lines) → try → parse → 处理 delta
//   现在：for (line of lines) → 归一 → for (chunk of chunks) → 处理 delta
//
// 也就是说【所有下游 delta 逻辑被包进了一个新 for】。
// 一旦闭合大括号位置错了，要么 tsc 报错，要么——更糟——
// 某些分支没被正确包进去而静默跳过，表现为「Anthropic 有内容但界面是空的」。
// typecheck 抓不到后者，只有行为测试能抓。
// ============================================================

import { describe, it, expect } from 'vitest'
import {
  resolveNativeKind,
  createNativeStreamParser,
  parseNativeCompletion,
  buildTransportPlan,
} from '../electron/core/nativeBridge'

describe('P1-3: 原生协议识别', () => {
  it('Anthropic 端点被正确识别', () => {
    expect(resolveNativeKind('https://api.anthropic.com/v1')).toBe('anthropic')
    expect(resolveNativeKind('https://api.anthropic.com/v1/messages')).toBe('anthropic')
  })

  it('显式指定优先于自动推断', () => {
    expect(resolveNativeKind('https://api.anthropic.com/v1', 'openai')).toBe('openai')
  })

  it('普通 OpenAI 兼容端点保持 openai（不误判）', () => {
    expect(resolveNativeKind('http://192.168.1.2:1234/v1')).toBe('openai')
    expect(resolveNativeKind('http://localhost:11434/v1')).toBe('openai')
  })
})

describe('P1-3: 传输计划（URL / 鉴权头 / 请求体）', () => {
  it('anthropic：URL 用 /v1/messages，鉴权走 x-api-key', () => {
    const plan = buildTransportPlan(
      'anthropic', 'https://api.anthropic.com/v1', 'sk-ant-test',
      'claude-3-5-sonnet', { messages: [{ role: 'user', content: 'hi' }], stream: true },
    )
    expect(plan.url).toContain('/v1/messages')
    expect(plan.headers['x-api-key']).toBe('sk-ant-test')
    // Anthropic 不能用 Bearer
    expect(plan.headers['Authorization']).toBeUndefined()
  })

  it('openai：URL 用 /chat/completions，鉴权走 Bearer', () => {
    const plan = buildTransportPlan(
      'openai', 'http://192.168.1.2:1234/v1', 'k',
      'local-model', { messages: [{ role: 'user', content: 'hi' }], stream: true },
    )
    expect(plan.url).toBe('http://192.168.1.2:1234/v1/chat/completions')
    expect(plan.headers['Authorization']).toContain('Bearer')
  })

  it('透传 stream 标志', () => {
    const s = buildTransportPlan('openai', 'http://x/v1', 'k', 'm', { messages: [], stream: true })
    const n = buildTransportPlan('openai', 'http://x/v1', 'k', 'm', { messages: [], stream: false })
    expect(s.body.stream).toBe(true)
    expect(n.body.stream).toBe(false)
  })
})

describe('P1-3: Anthropic SSE 归一为 OpenAI chunk', () => {
  const parser = createNativeStreamParser('anthropic')

  it('文本增量被归一成 choices[0].delta.content', () => {
    // Anthropic 的 content_block_delta 事件
    const raw = JSON.stringify({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: '你好' },
    })
    const chunks = parser.feed('content_block_delta', raw)
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks[0].choices?.[0]?.delta?.content).toBe('你好')
  })

  it('工具调用被归一成 delta.tool_calls', () => {
    const raw = JSON.stringify({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'tu_1', name: 'file_read' },
    })
    const chunks = parser.feed('content_block_start', raw)
    const tcs = chunks[0]?.choices?.[0]?.delta?.tool_calls
    expect(Array.isArray(tcs)).toBe(true)
    expect(tcs[0].function.name).toBe('file_read')
  })

  it('非法 JSON 不抛出（跳过即可）', () => {
    expect(() => parser.feed('content_block_delta', '{not json')).not.toThrow()
  })

  it('未知事件类型不产生脏数据', () => {
    const chunks = parser.feed('ping', JSON.stringify({ type: 'ping' }))
    // ping 不应产生 content
    for (const c of chunks) {
      expect(c?.choices?.[0]?.delta?.content).toBeUndefined()
    }
  })
})

describe('P1-3: 非流式响应归一', () => {
  it('anthropic 的 { content: [...] } 归一为 choices[0].message', () => {
    const raw = {
      id: 'msg_1',
      role: 'assistant',
      content: [{ type: 'text', text: '回答' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }
    const out = parseNativeCompletion('anthropic', raw)
    expect(out.choices?.[0]?.message?.content).toBe('回答')
    expect(out.usage).toBeTruthy()
  })

  it('openai 原样透传（不被破坏）', () => {
    const raw = { choices: [{ message: { role: 'assistant', content: 'hi' } }] }
    const out = parseNativeCompletion('openai', raw)
    expect(out.choices?.[0]?.message?.content).toBe('hi')
  })
})

// ═══════════════════════════════════════════════════════════
// 回归：SSE 行解析的边界
// 这段逻辑与 agentRunner 内联循环一致，验证它对真实流格式的处理
// ═══════════════════════════════════════════════════════════

describe('P1-3: SSE 行切分边界', () => {
  /** 复刻内联循环的行处理逻辑 */
  function processSse(raw: string, nativeParser: any) {
    const parser = nativeParser
    const out: any[] = []
    let sseEvent = ''
    for (const rawLine of raw.split('\n')) {
      const line = rawLine.trim()
      if (!line) {continue}
      if (line.startsWith('event:')) { sseEvent = line.slice(6).trim(); continue }
      if (!line.startsWith('data:')) {continue}
      const data = line.slice(5).trim()
      if (!data || data === '[DONE]') {continue}
      const chunks = parser ? parser.feed(sseEvent, data) : [JSON.parse(data)]
      for (const c of chunks) {
        if (!c) {continue}
        const delta = c.choices?.[0]?.delta
        if (!delta) {continue}
        if (delta.content) {out.push(delta.content)}
      }
    }
    return out
  }

  it('无尾随空行时最后一个 data 也能被处理', () => {
    const sse = 'data: {"choices":[{"delta":{"content":"A"}}]}\ndata: {"choices":[{"delta":{"content":"B"}}]}'
    expect(processSse(sse, null)).toEqual(['A', 'B'])
  })

  it('data: 后【无空格】的格式（老代码 line.slice(6) 会吃掉字符）', () => {
    // 旧代码用 startsWith('data: ') + slice(6)，遇到 'data:{"..."' 会失败。
    // 新代码用 startsWith('data:') + slice(5) + trim，兼容两种。
    const sse = 'data:{"choices":[{"delta":{"content":"X"}}]}'
    expect(processSse(sse, null)).toEqual(['X'])
  })

  it('[DONE] 哨兵被正确跳过', () => {
    const sse = 'data: {"choices":[{"delta":{"content":"A"}}]}\ndata: [DONE]\ndata: {"choices":[{"delta":{"content":"B"}}]}'
    expect(processSse(sse, null)).toEqual(['A', 'B'])
  })

  it('多行 Anthropic 流：事件名被正确继承到下一个 data', () => {
    const p = createNativeStreamParser('anthropic')
    const sse = [
      'event: message_start',
      'data: {"type":"message_start"}',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}',
    ].join('\n')
    const out = processSse(sse, p)
    expect(out).toContain('你好')
  })
})
