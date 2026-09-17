// ============================================================
// tests/modelCompat.test.ts — 本地 / 异构 LLM 模型容错与能力自适应
// ============================================================

import { describe, it, expect } from 'vitest'
import {
  isLocalEndpoint,
  looksLikeVisionModel,
  classifyModelError,
  degradeForKind,
  clampOutputTokens,
  DEFAULT_MAX_OUTPUT_TOKENS,
  MAX_OUTPUT_CAP,
} from '../electron/core/modelCompat'

describe('isLocalEndpoint', () => {
  const local = [
    'http://localhost:1234/v1',
    'http://127.0.0.1:11434/v1',
    'http://0.0.0.0:1234',
    'http://127.0.0.1:1234/v1',
    'http://10.0.0.5:8080/v1',
    'http://172.16.0.9:1234/v1',
    'http://[::1]:1234/v1',
  ]
  it.each(local)('识别为本地: %s', (u) => {
    expect(isLocalEndpoint(u)).toBe(true)
  })

  const remote = [
    'https://api.openai.com/v1',
    'https://api.deepseek.com/v1',
    'https://dashscope.aliyuncs.com/compatible-mode/v1',
    'https://opencode.ai/zen/v1',
    '',
    undefined,
    null,
  ]
  it.each(remote as (string | undefined | null)[])('识别为非本地: %s', (u) => {
    expect(isLocalEndpoint(u)).toBe(false)
  })
})

describe('looksLikeVisionModel', () => {
  const vision = [
    'qwen2.5-vl-7b-instruct',
    'Qwen2-VL-72B',
    'qwen3-vl',
    'llava-v1.6-mistral-7b',
    'minicpm-v-8b',
    'MiniCPM-o-2_6',
    'moondream2',
    'internvl2-8b',
    'glm-4v-9b',
    'glm-4.5v',
    'llama-3.2-11b-vision-instruct',
    'pixtral-12b',
    'molmo-7b',
    'deepseek-vl2',
    'kimi-vl-a3b',
    'gemini-2.0-flash',
    'gpt-4o',
    'gpt-4.1-mini',
    'gpt-5',
    'claude-3-5-sonnet',
    'claude-4-sonnet',
  ]
  it.each(vision)('识别为视觉模型: %s', (m) => {
    expect(looksLikeVisionModel(m)).toBe(true)
  })

  const text = [
    'qwen2.5-coder-14b',
    'Qwen3-14B',
    'qwen3:14b',
    'deepseek-chat',
    'deepseek-r1:14b',
    'llama-3.1-8b-instruct',
    'llama-3.3-70b',
    'mistral-7b-instruct',
    'gemma-2-9b',
    'gpt-oss-20b',
    'QwenPaw Flash 9B',
  ]
  it.each(text)('识别为纯文本模型: %s', (m) => {
    expect(looksLikeVisionModel(m)).toBe(false)
  })
})

describe('classifyModelError', () => {
  it('401/403 → auth', () => {
    expect(classifyModelError(401, 'Unauthorized')).toBe('auth')
    expect(classifyModelError(403, 'forbidden')).toBe('auth')
  })

  it('tools 不支持 → tools', () => {
    const msgs = [
      'Chat completion tools are not supported by this model.',
      'this model is not supported for tools',
      "Unknown argument: tools",
      'Model does not support function calling (tool_choice)',
      'the chat template does not support tools',
    ]
    for (const m of msgs) expect(classifyModelError(400, m)).toBe('tools')
  })

  it('图片不支持 → vision', () => {
    const msgs = [
      'This model does not support image input',
      'image_url is not supported, only text inputs are allowed',
      'multimodal content detected but model is text-only',
    ]
    for (const m of msgs) expect(classifyModelError(400, m)).toBe('vision')
  })

  it('stream_options 不识别 → stream_options', () => {
    expect(classifyModelError(400, "Unknown argument 'stream_options'")).toBe('stream_options')
    expect(classifyModelError(400, 'unsupported parameter include_usage')).toBe('stream_options')
  })

  it('max_tokens 超限 → max_tokens', () => {
    expect(classifyModelError(400, 'max_tokens must be at most 8192')).toBe('max_tokens')
    expect(classifyModelError(400, 'max_new_tokens is too large')).toBe('max_tokens')
  })

  it('上下文超长 → context', () => {
    const msgs = [
      "This model's maximum context length is 8192 tokens but you requested 20000",
      'n_ctx must be at least the number of prompt tokens',
      'max_model_len exceeded',
      'input is too long for the model context window',
    ]
    for (const m of msgs) expect(classifyModelError(400, m)).toBe('context')
  })

  it('无法识别 → unknown', () => {
    expect(classifyModelError(500, 'internal server error')).toBe('unknown')
    expect(classifyModelError(400, 'bad request')).toBe('unknown')
  })
})

describe('degradeForKind', () => {
  const base = () => ({
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'x' } }],
    tool_choice: 'auto',
    stream_options: { include_usage: true },
    max_tokens: 256000,
  })

  it('tools：移除 tools / tool_choice（不改动原对象）', () => {
    const body = base()
    const out = degradeForKind(body, 'tools')
    expect(out.tools).toBeUndefined()
    expect(out.tool_choice).toBeUndefined()
    // 原对象不被修改
    expect(body.tools).toBeDefined()
  })

  it('stream_options：移除流选项', () => {
    const out = degradeForKind(base(), 'stream_options')
    expect(out.stream_options).toBeUndefined()
    expect(out.tools).toBeDefined() // 不动工具
  })

  it('max_tokens：收敛到 4096', () => {
    const out = degradeForKind(base(), 'max_tokens')
    expect(out.max_tokens).toBe(4096)
  })

  it('vision：移除 image_url 保留文本', () => {
    const body = {
      model: 'm',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: [
          { type: 'text', text: '看看这个' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
        ] },
      ],
    }
    const out = degradeForKind(body, 'vision')
    const user = out.messages[1]
    expect(typeof user.content).toBe('string')
    expect(user.content).toContain('看看这个')
    expect(JSON.stringify(out)).not.toContain('image_url')
  })

  it('context/unknown：原样返回', () => {
    const body = base()
    expect(degradeForKind(body, 'context')).toEqual(body)
    expect(degradeForKind(body, 'unknown')).toEqual(body)
  })
})

describe('clampOutputTokens', () => {
  it('缺省给默认输出上限', () => {
    expect(clampOutputTokens(undefined)).toBe(DEFAULT_MAX_OUTPUT_TOKENS)
    expect(clampOutputTokens(null)).toBe(DEFAULT_MAX_OUTPUT_TOKENS)
    expect(clampOutputTokens(0)).toBe(DEFAULT_MAX_OUTPUT_TOKENS)
    expect(clampOutputTokens(NaN)).toBe(DEFAULT_MAX_OUTPUT_TOKENS)
  })

  it('超过硬封顶则截断', () => {
    expect(clampOutputTokens(256000)).toBe(MAX_OUTPUT_CAP)
    expect(clampOutputTokens(999999)).toBe(MAX_OUTPUT_CAP)
  })

  it('正常值原样保留', () => {
    expect(clampOutputTokens(2048)).toBe(2048)
    expect(clampOutputTokens(10000)).toBe(10000)
  })
})
