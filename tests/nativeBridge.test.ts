// ============================================================
// tests/nativeBridge.test.ts — 原生模型协议桥接层
// 用真实协议样例验证 OpenAI ↔ Anthropic / Gemini / Azure 的往返转换
// ============================================================

import { describe, it, expect } from 'vitest'
import {
  resolveNativeKind,
  buildTransportPlan,
  parseNativeCompletion,
  createNativeStreamParser,
  extractNativeErrorText,
  type OpenAiBody,
} from '../electron/core/nativeBridge'

const KEY = 'test-key'
const PNG = 'data:image/png;base64,QUJD' // 假 base64

function sampleOpenAiBody(stream = true): OpenAiBody {
  return {
    model: 'm',
    stream,
    max_tokens: 1024,
    temperature: 0.5,
    messages: [
      { role: 'system', content: 'You are Lumina.' },
      { role: 'user', content: [
        { type: 'text', text: 'see this' },
        { type: 'image_url', image_url: { url: PNG } },
      ] },
      { role: 'assistant', content: 'ok', tool_calls: [
        { id: 't1', type: 'function', function: { name: 'weather', arguments: '{"city":"Paris"}' } },
      ] },
      { role: 'tool', tool_call_id: 't1', name: 'weather', content: '{"temp":20}' },
    ],
    tools: [{ type: 'function', function: {
      name: 'weather',
      description: 'get weather',
      parameters: { type: 'object', properties: { city: { type: 'string' } } },
    } }],
    tool_choice: 'auto',
  }
}

describe('resolveNativeKind', () => {
  it('识别官方域名', () => {
    expect(resolveNativeKind('https://api.anthropic.com')).toBe('anthropic')
    expect(resolveNativeKind('https://api.anthropic.com/v1')).toBe('anthropic')
    expect(resolveNativeKind('https://generativelanguage.googleapis.com')).toBe('gemini')
    expect(resolveNativeKind('https://myres.openai.azure.com')).toBe('azure')
    expect(resolveNativeKind('https://x.cognitiveservices.azure.com')).toBe('azure')
  })
  it('OpenAI 兼容端点默认 openai', () => {
    expect(resolveNativeKind('http://127.0.0.1:1234/v1')).toBe('openai')
    expect(resolveNativeKind('https://api.deepseek.com/v1')).toBe('openai')
    expect(resolveNativeKind('https://dashscope.aliyuncs.com/compatible-mode/v1')).toBe('openai')
  })
  it('显式覆盖优先', () => {
    expect(resolveNativeKind('http://127.0.0.1:9999', 'gemini')).toBe('gemini')
  })
})

describe('buildTransportPlan · Anthropic', () => {
  const plan = buildTransportPlan('anthropic', 'https://api.anthropic.com/', KEY, 'claude-x', sampleOpenAiBody())

  it('URL 与鉴权头正确', () => {
    expect(plan.url).toBe('https://api.anthropic.com/v1/messages')
    expect(plan.headers['x-api-key']).toBe(KEY)
    expect(plan.headers['anthropic-version']).toBe('2023-06-01')
  })

  it('抽出 system、保留工具多轮回合', () => {
    const b = plan.body
    expect(b.system).toBe('You are Lumina.')
    expect(b.stream).toBe(true)
    expect(b.messages).toHaveLength(3)

    // user：文本 + base64 图片
    const user0 = b.messages[0]
    expect(user0.role).toBe('user')
    expect(user0.content[0]).toEqual({ type: 'text', text: 'see this' })
    expect(user0.content[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'QUJD' },
    })

    // assistant：text + tool_use
    const asst = b.messages[1]
    expect(asst.role).toBe('assistant')
    expect(asst.content[0]).toEqual({ type: 'text', text: 'ok' })
    expect(asst.content[1]).toEqual({
      type: 'tool_use', id: 't1', name: 'weather', input: { city: 'Paris' },
    })

    // tool result
    const toolRes = b.messages[2]
    expect(toolRes.content[0].type).toBe('tool_result')
    expect(toolRes.content[0].tool_use_id).toBe('t1')
    expect(toolRes.content[0].content).toContain('20')
  })

  it('tools 转 input_schema、tool_choice auto', () => {
    expect(plan.body.tools[0].name).toBe('weather')
    expect(plan.body.tools[0].input_schema.type).toBe('object')
    expect(plan.body.tool_choice).toEqual({ type: 'auto' })
  })

  it('baseUrl 已带 /v1 时不重复拼接', () => {
    const p = buildTransportPlan('anthropic', 'https://api.anthropic.com/v1', KEY, 'c', sampleOpenAiBody())
    expect(p.url).toBe('https://api.anthropic.com/v1/messages')
  })
})

describe('buildTransportPlan · Gemini', () => {
  it('流式 URL + systemInstruction + 工具回合 + 图片', () => {
    const plan = buildTransportPlan('gemini', 'https://generativelanguage.googleapis.com', KEY, 'gemini-2.5-flash', sampleOpenAiBody())
    expect(plan.url).toContain('/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse')
    expect(plan.headers['x-goog-api-key']).toBe(KEY)

    const b = plan.body
    expect(b.systemInstruction.parts[0].text).toBe('You are Lumina.')
    // system 不进 contents
    expect(b.contents).toHaveLength(3)
    expect(b.contents[0].role).toBe('user')
    expect(b.contents[0].parts[0]).toEqual({ text: 'see this' })
    expect(b.contents[0].parts[1]).toEqual({ inlineData: { mimeType: 'image/png', data: 'QUJD' } })

    // assistant → model，functionCall
    const model = b.contents[1]
    expect(model.role).toBe('model')
    expect(model.parts[0]).toEqual({ text: 'ok' })
    expect(model.parts[1].functionCall).toEqual({ name: 'weather', args: { city: 'Paris' } })

    // tool result → user functionResponse
    const fr = b.contents[2]
    expect(fr.role).toBe('user')
    expect(fr.parts[0].functionResponse.name).toBe('weather')
    expect(fr.parts[0].functionResponse.response).toEqual({ temp: 20 })

    // functionDeclarations
    expect(b.tools[0].functionDeclarations[0].name).toBe('weather')
    expect(b.toolConfig.functionCallingConfig.mode).toBe('AUTO')
  })

  it('非流式用 generateContent 且不带 alt=sse', () => {
    const plan = buildTransportPlan('gemini', 'https://generativelanguage.googleapis.com', KEY, 'g', sampleOpenAiBody(false))
    expect(plan.url.endsWith(':generateContent')).toBe(true)
    expect(plan.url).not.toContain('alt=sse')
  })
})

describe('buildTransportPlan · Azure / OpenAI', () => {
  it('Azure 走部署路径 + api-key，body 保持 OpenAI', () => {
    const plan = buildTransportPlan('azure', 'https://res.openai.azure.com/', KEY, 'gpt-4o', sampleOpenAiBody())
    expect(plan.url).toContain('/openai/deployments/gpt-4o/chat/completions?api-version=')
    expect(plan.headers['api-key']).toBe(KEY)
    expect(plan.body.messages).toBeDefined()
  })
  it('OpenAI 兼容走 /chat/completions + Bearer', () => {
    const plan = buildTransportPlan('openai', 'http://127.0.0.1:1234/v1', '', 'm', sampleOpenAiBody())
    expect(plan.url).toBe('http://127.0.0.1:1234/v1/chat/completions')
    expect(plan.headers.Authorization).toBeUndefined()
  })
})

describe('parseNativeCompletion · 非流式归一', () => {
  it('Anthropic 文本 + tool_use', () => {
    const out = parseNativeCompletion('anthropic', {
      id: 'msg_1', model: 'claude-x', stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'Sure' },
        { type: 'tool_use', id: 't1', name: 'weather', input: { city: 'Tokyo' } },
      ],
      usage: { input_tokens: 4, output_tokens: 6 },
    })
    const msg = out.choices[0].message
    expect(msg.content).toBe('Sure')
    expect(msg.tool_calls[0].function.name).toBe('weather')
    expect(JSON.parse(msg.tool_calls[0].function.arguments)).toEqual({ city: 'Tokyo' })
    expect(out.choices[0].finish_reason).toBe('tool_calls')
    expect(out.usage.total_tokens).toBe(10)
  })

  it('Gemini 文本 + functionCall', () => {
    const out = parseNativeCompletion('gemini', {
      candidates: [{ content: { parts: [
        { text: 'ok' },
        { functionCall: { name: 'g', args: { x: 2 } } },
      ] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
    })
    const msg = out.choices[0].message
    expect(msg.content).toBe('ok')
    expect(msg.tool_calls[0].function.name).toBe('g')
    expect(JSON.parse(msg.tool_calls[0].function.arguments)).toEqual({ x: 2 })
    expect(out.usage.total_tokens).toBe(3)
  })

  it('OpenAI 原样返回', () => {
    const raw = { choices: [{ message: { content: 'hi' } }] }
    expect(parseNativeCompletion('openai', raw)).toBe(raw)
  })
})

// 模仿 llmProvider 的 OpenAI chunk 累加逻辑
function accumulateChunks(chunks: any[]) {
  let text = ''
  let finish: string | undefined
  const tools = new Map<number, { id: string; name: string; args: string }>()
  for (const ch of chunks) {
    const delta = ch.choices?.[0]?.delta
    if (delta?.content) {text += delta.content}
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        const i = tc.index ?? 0
        if (!tools.has(i)) {tools.set(i, { id: '', name: '', args: '' })}
        const a = tools.get(i)!
        if (tc.id) {a.id = tc.id}
        if (tc.function?.name) {a.name = tc.function.name}
        if (tc.function?.arguments) {a.args += tc.function.arguments}
      }
    }
    if (ch.choices?.[0]?.finish_reason) {finish = ch.choices[0].finish_reason}
  }
  return { text, tools, finish }
}

describe('createNativeStreamParser · Anthropic SSE', () => {
  it('文本增量 + 工具调用 JSON 分片 + 结束原因', () => {
    const parser = createNativeStreamParser('anthropic')
    const feed = (event: string, obj: any) => parser.feed(event, JSON.stringify(obj))
    const chunks: any[] = []
    const push = (cs: any[]) => chunks.push(...cs)

    push(feed('message_start', { type: 'message_start', message: { model: 'claude-x', usage: { input_tokens: 9, output_tokens: 1 } } }))
    push(feed('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
    push(feed('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } }))
    push(feed('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } }))
    push(feed('content_block_stop', { type: 'content_block_stop', index: 0 }))
    push(feed('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_abc', name: 'weather', input: {} } }))
    push(feed('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"city":"Par' } }))
    push(feed('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'is"}' } }))
    push(feed('content_block_stop', { type: 'content_block_stop', index: 1 }))
    push(feed('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 12 } }))

    const r = accumulateChunks(chunks)
    expect(r.text).toBe('Hello world')
    expect(r.finish).toBe('tool_calls')
    const tool = r.tools.get(0)!
    expect(tool.id).toBe('toolu_abc')
    expect(tool.name).toBe('weather')
    expect(JSON.parse(tool.args)).toEqual({ city: 'Paris' })
  })
})

describe('createNativeStreamParser · Gemini SSE', () => {
  it('文本 + functionCall + finishReason/usage', () => {
    const parser = createNativeStreamParser('gemini')
    const chunks = [
      ...parser.feed('', JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'Hi ' }] } }] })),
      ...parser.feed('', JSON.stringify({ candidates: [{ content: { parts: [{ text: 'there' }] } }] })),
      ...parser.feed('', JSON.stringify({
        candidates: [{ content: { parts: [{ functionCall: { name: 'weather', args: { city: 'Rome' } } }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 4, totalTokenCount: 9 },
      })),
    ]
    const r = accumulateChunks(chunks)
    expect(r.text).toBe('Hi there')
    expect(r.finish).toBe('stop')
    expect(r.tools.get(0)!.name).toBe('weather')
    expect(JSON.parse(r.tools.get(0)!.args)).toEqual({ city: 'Rome' })
  })
})

describe('extractNativeErrorText', () => {
  it('提取各家错误 message', () => {
    expect(extractNativeErrorText('anthropic', JSON.stringify({ error: { type: 'auth', message: 'bad key' } }))).toBe('bad key')
    expect(extractNativeErrorText('gemini', JSON.stringify({ error: { code: 400, message: 'API key not valid' } }))).toContain('API key not valid')
    expect(extractNativeErrorText('openai', JSON.stringify({ error: { message: 'ctx' } }))).toBe('ctx')
  })
})
