// ============================================================
// nativeBridge.ts — 原生模型协议桥接层
//
// 主链路（llmProvider / agentRunner）全程只讲「OpenAI Chat Completions」。
// 本层在「出站 / 入站」两个边界做无损翻译，让主链路无需分叉即可原生支持：
//   - openai    : OpenAI 兼容（含 LM Studio / Ollama /v1 / DeepSeek / DashScope / 智谱 / 硅基流动）
//   - anthropic : Anthropic Messages API（Claude，/v1/messages）
//   - gemini    : Google Gemini（generateContent / streamGenerateContent）
//   - azure     : Azure OpenAI（部署路径 + api-key，响应仍是 OpenAI 形状）
//
// 约定：本模块全部是纯函数，不发网络请求、不读环境，便于用真实协议样例单测。
// ============================================================

export type NativeKind = 'openai' | 'anthropic' | 'gemini' | 'azure'

/** 主链路通用的 OpenAI 风格请求体 */
export interface OpenAiBody {
  model: string
  messages: Array<Record<string, any>>
  tools?: any[]
  tool_choice?: any
  max_tokens?: number
  temperature?: number
  stream?: boolean
  stream_options?: { include_usage?: boolean }
  [k: string]: any
}

export interface TransportPlan {
  kind: NativeKind
  url: string
  headers: Record<string, string>
  body: any
}

// ────────────────────────────────────────────────────────────
// 协议识别
// ────────────────────────────────────────────────────────────

/**
 * 决定一个端点用哪种原生协议。
 * @param explicit 显式覆盖（设置页未来可下拉选择），优先级最高
 */
export function resolveNativeKind(baseUrl: string, explicit?: string): NativeKind {
  if (explicit === 'anthropic' || explicit === 'gemini' || explicit === 'azure' || explicit === 'openai') {
    return explicit
  }
  const u = (baseUrl || '').toLowerCase()
  if (u.includes('anthropic') || u.includes('claude') || u.includes('/v1/messages')) {return 'anthropic'}
  if (u.includes('generativelanguage.googleapis') || u.includes('gemini') ||
      u.includes('aistudio.google') || u.includes('vertexai') || u.includes('/v1beta')) {return 'gemini'}
  if (u.includes('openai.azure.com') || u.includes('azure.com/openai') ||
      u.includes('cognitiveservices') || u.includes('services.ai') ||
      u.includes('/openai/deployments') || u.includes('azure')) {return 'azure'}
  return 'openai'
}

function trimTrailing(baseUrl: string, ...suffixes: string[]): string {
  let u = baseUrl.replace(/\/+$/, '')
  for (const s of suffixes) {
    if (u.toLowerCase().endsWith(s.toLowerCase())) {u = u.slice(0, u.length - s.length)}
    u = u.replace(/\/+$/, '')
  }
  return u
}

// ────────────────────────────────────────────────────────────
// 通用辅助
// ────────────────────────────────────────────────────────────

function parseDataUri(uri: string): { mediaType: string; data: string } | null {
  const m = /^data:([\w.+-]+\/[\w.+-]+)?(;base64)?,(.*)$/s.exec(uri || '')
  if (!m) {return null}
  return { mediaType: m[1] || 'image/png', data: m[3] }
}

function textOfContent(content: any): string {
  if (typeof content === 'string') {return content}
  if (Array.isArray(content)) {
    return content
      .filter((p: any) => p && p.type === 'text')
      .map((p: any) => p.text || '')
      .join('\n')
  }
  return ''
}

function asOpenAiTextParts(content: any): any[] {
  if (typeof content === 'string') {return [{ type: 'text', text: content }]}
  if (Array.isArray(content)) {return content}
  return [{ type: 'text', text: String(content ?? '') }]
}

// ────────────────────────────────────────────────────────────
// 出站：Anthropic Messages
// ────────────────────────────────────────────────────────────

function toAnthropic(body: OpenAiBody): Record<string, any> {
  let systemText = ''
  const convo: any[] = []
  for (const m of body.messages || []) {
    if (m.role === 'system') {
      systemText += (systemText ? '\n' : '') + textOfContent(m.content)
      continue
    }
    convo.push(m)
  }

  const messages: any[] = []
  for (const m of convo) {
    const role = m.role === 'assistant' ? 'assistant' : 'user'

    // assistant 带 tool_calls → text + tool_use blocks
    if (role === 'assistant') {
      const blocks: any[] = []
      const text = textOfContent(m.content)
      if (text) {blocks.push({ type: 'text', text })}
      for (const tc of m.tool_calls || []) {
        let input: any = {}
        try { input = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {} } catch { input = {} }
        blocks.push({ type: 'tool_use', id: tc.id || `toolu_${Math.random().toString(36).slice(2, 10)}`, name: tc.function?.name, input })
      }
      if (blocks.length === 0) {blocks.push({ type: 'text', text: '' })}
      messages.push({ role, content: blocks })
      continue
    }

    // user 角色的工具结果（OpenAI role: 'tool'）→ tool_result blocks
    if (m.role === 'tool') {
      const parts = asOpenAiTextParts(m.content)
      const contentText = parts.filter(p => p.type === 'text').map(p => p.text).join('\n') || '(空结果)'
      messages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: contentText }],
      })
      continue
    }

    // 普通 user（可能含图片）
    const blocks: any[] = []
    for (const p of asOpenAiTextParts(m.content)) {
      if (p.type === 'text' && p.text) {
        blocks.push({ type: 'text', text: p.text })
      } else if (p.type === 'image_url') {
        const url: string = p.image_url?.url || ''
        const dataUri = parseDataUri(url)
        if (dataUri) {
          blocks.push({ type: 'image', source: { type: 'base64', media_type: dataUri.mediaType, data: dataUri.data } })
        } else if (url) {
          blocks.push({ type: 'image', source: { type: 'url', url } })
        }
      }
    }
    if (blocks.length === 0) {blocks.push({ type: 'text', text: '' })}
    messages.push({ role, content: blocks })
  }

  const out: Record<string, any> = {
    model: body.model,
    max_tokens: body.max_tokens ?? 4096,
    messages,
  }
  if (systemText) {out.system = systemText}
  if (typeof body.temperature === 'number') {out.temperature = body.temperature}
  if (body.stream) {out.stream = true}
  if (body.tools && body.tools.length) {
    out.tools = body.tools.map((t: any) => {
      const f = t.function || t
      return {
        name: f.name,
        description: f.description || '',
        input_schema: f.parameters || { type: 'object', properties: {} },
      }
    })
    const tc = body.tool_choice
    if (tc === 'auto' || tc === undefined) {out.tool_choice = { type: 'auto' }}
    else if (tc === 'required') {out.tool_choice = { type: 'any' }}
    else if (tc && typeof tc === 'object' && tc.function?.name) {
      out.tool_choice = { type: 'tool', name: tc.function.name }
    }
    // 'none' 不映射（Anthropic 无对应概念，直接省略即默认 auto，如需禁用由调用方不传 tools）
  }
  return out
}

// ────────────────────────────────────────────────────────────
// 出站：Gemini generateContent
// ────────────────────────────────────────────────────────────

function geminiPartsFromContent(content: any): any[] {
  const parts: any[] = []
  for (const p of asOpenAiTextParts(content)) {
    if (p.type === 'text' && p.text) {parts.push({ text: p.text })}
    else if (p.type === 'image_url') {
      const url: string = p.image_url?.url || ''
      const d = parseDataUri(url)
      if (d) {parts.push({ inlineData: { mimeType: d.mediaType, data: d.data } })}
      else if (url) {parts.push({ fileData: { fileUri: url } })}
    }
  }
  return parts
}

function toGemini(body: OpenAiBody, stream: boolean): Record<string, any> {
  const contents: any[] = []
  let systemText = ''
  for (const m of body.messages || []) {
    if (m.role === 'system') { systemText += (systemText ? '\n' : '') + textOfContent(m.content); continue }
    if (m.role === 'assistant') {
      const parts: any[] = geminiPartsFromContent(m.content)
      for (const tc of m.tool_calls || []) {
        let args: any = {}
        try { args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {} } catch { args = {} }
        parts.push({ functionCall: { name: tc.function?.name, args } })
      }
      contents.push({ role: 'model', parts: parts.length ? parts : [{ text: '' }] })
    } else if (m.role === 'tool') {
      let response: any = {}
      try { response = JSON.parse(textOfContent(m.content)) } catch { response = { result: textOfContent(m.content) } }
      contents.push({ role: 'user', parts: [{ functionResponse: { name: m.name || 'tool', response } }] })
    } else {
      const parts = geminiPartsFromContent(m.content)
      contents.push({ role: 'user', parts: parts.length ? parts : [{ text: '' }] })
    }
  }

  const out: Record<string, any> = {
    contents,
    generationConfig: {
      maxOutputTokens: body.max_tokens ?? 4096,
      temperature: typeof body.temperature === 'number' ? body.temperature : 0.7,
    },
  }
  if (systemText) {out.systemInstruction = { parts: [{ text: systemText }] }}
  if (body.tools && body.tools.length) {
    out.tools = [{
      functionDeclarations: body.tools.map((t: any) => {
        const f = t.function || t
        return { name: f.name, description: f.description || '', parameters: f.parameters || { type: 'object', properties: {} } }
      }),
    }]
    const tc = body.tool_choice
    if (tc === 'none') {out.toolConfig = { functionCallingConfig: { mode: 'NONE' } }}
    else if (tc === 'required') {out.toolConfig = { functionCallingConfig: { mode: 'ANY' } }}
    else {out.toolConfig = { functionCallingConfig: { mode: 'AUTO' } }}
  }
  return out
}

// ────────────────────────────────────────────────────────────
// 出站：统一 TransportPlan
// ────────────────────────────────────────────────────────────

export function buildTransportPlan(
  kind: NativeKind,
  baseUrl: string,
  apiKey: string,
  model: string,
  openaiBody: OpenAiBody,
): TransportPlan {
  const stream = !!openaiBody.stream
  const root = (baseUrl || '').replace(/\/+$/, '')

  if (kind === 'anthropic') {
    const base = trimTrailing(root, '/v1')
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    }
    if (apiKey) {headers['x-api-key'] = apiKey}
    if (stream) {headers['accept'] = 'text/event-stream'}
    return {
      kind,
      url: `${base}/v1/messages`,
      headers,
      body: toAnthropic(openaiBody),
    }
  }

  if (kind === 'gemini') {
    const base = trimTrailing(root, '/v1beta')
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    // 优先用 x-goog-api-key 头（避免 key 出现在 URL / 日志）；无 key 时假设走免密网关
    if (apiKey) {headers['x-goog-api-key'] = apiKey}
    const action = stream ? 'streamGenerateContent' : 'generateContent'
    const qs = stream ? '?alt=sse' : ''
    return {
      kind,
      url: `${base}/v1beta/models/${encodeURIComponent(model)}:${action}${qs}`,
      headers,
      body: toGemini(openaiBody, stream),
    }
  }

  if (kind === 'azure') {
    // baseUrl 形如 https://{resource}.openai.azure.com （或带 /openai/deployments 前缀）
    const apiVersion = process.env.LUMINA_AZURE_API_VERSION || '2024-10-21'
    const clean = root.replace(/\/openai\/deployments.*$/i, '').replace(/\/+$/, '')
    const deployment = encodeURIComponent(model)
    const url = `${clean}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'api-key': apiKey,
    }
    if (stream) {headers['accept'] = 'text/event-stream'}
    return { kind, url, headers, body: { ...openaiBody } }
  }

  // openai 兼容
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) {headers['Authorization'] = `Bearer ${apiKey}`}
  return { kind: 'openai', url: `${root}/chat/completions`, headers, body: { ...openaiBody } }
}

// ────────────────────────────────────────────────────────────
// 入站：非流式响应归一为 OpenAI completion
// ────────────────────────────────────────────────────────────

export function parseNativeCompletion(kind: NativeKind, data: any): any {
  if (kind === 'anthropic') {return anthropicCompletion(data)}
  if (kind === 'gemini') {return geminiCompletion(data)}
  return data // openai / azure 原样
}

function anthropicCompletion(data: any): any {
  const blocks: any[] = Array.isArray(data.content) ? data.content : []
  let content = ''
  const toolCalls: any[] = []
  for (const b of blocks) {
    if (b.type === 'text') {content += b.text || ''}
    else if (b.type === 'tool_use') {
      toolCalls.push({
        id: b.id,
        type: 'function',
        function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      })
    }
  }
  const finish = data.stop_reason === 'tool_use' ? 'tool_calls'
    : data.stop_reason === 'max_tokens' ? 'length'
    : data.stop_reason === 'stop_sequence' ? 'stop'
    : 'stop'
  const message: any = { role: 'assistant', content: content || (toolCalls.length ? '' : '') }
  if (toolCalls.length) {message.tool_calls = toolCalls}
  return {
    id: data.id || 'msg_anthropic',
    object: 'chat.completion',
    model: data.model,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: {
      prompt_tokens: data.usage?.input_tokens ?? 0,
      completion_tokens: data.usage?.output_tokens ?? 0,
      total_tokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
    },
  }
}

function geminiCompletion(data: any): any {
  const cand = data.candidates?.[0] || {}
  const parts: any[] = cand.content?.parts || []
  let content = ''
  const toolCalls: any[] = []
  for (const p of parts) {
    if (typeof p.text === 'string') {content += p.text}
    if (p.functionCall) {
      toolCalls.push({
        id: `call_${toolCalls.length}`,
        type: 'function',
        function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args ?? {}) },
      })
    }
  }
  const fr = cand.finishReason
  const finish = fr === 'MAX_TOKENS' ? 'length'
    : fr === 'SAFETY' || fr === 'RECITATION' ? 'content_filter'
    : toolCalls.length ? 'tool_calls' : 'stop'
  const message: any = { role: 'assistant', content: content || '' }
  if (toolCalls.length) {message.tool_calls = toolCalls}
  const um = data.usageMetadata || {}
  return {
    id: 'gemini_' + (Date.now()),
    object: 'chat.completion',
    model: data.modelVersion || '',
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: {
      prompt_tokens: um.promptTokenCount ?? 0,
      completion_tokens: um.candidatesTokenCount ?? 0,
      total_tokens: um.totalTokenCount ?? 0,
    },
  }
}

// ────────────────────────────────────────────────────────────
// 入站：流式 SSE 归一
//
// 用法：createNativeStreamParser(kind) 得到一个有状态 parser；
// 对每个 SSE 「event: xxx / data: {...}」对调用 feed(eventName, dataStr)，
// 返回 0..N 个 OpenAI 风格 chunk（可直接喂给现有 delta 累加逻辑）。
// ────────────────────────────────────────────────────────────

export interface NativeStreamParser {
  feed(eventName: string, dataStr: string): any[]
}

export function createNativeStreamParser(kind: NativeKind): NativeStreamParser {
  if (kind === 'anthropic') {return createAnthropicStreamParser()}
  if (kind === 'gemini') {return createGeminiStreamParser()}
  // openai/azure：主链路直接解析，parser 透传
  return {
    feed(_e: string, dataStr: string) {
      try { return [JSON.parse(dataStr)] } catch { return [] }
    },
  }
}

function chunkBase(model: string): any {
  return { id: 'chatcmpl_native', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {} }] }
}

function createAnthropicStreamParser(): NativeStreamParser {
  const toolBlockIndex = new Map<number, number>() // content_block index -> tool_calls index
  let nextToolIndex = 0
  let model = ''
  let started = false
  return {
    feed(eventName: string, dataStr: string) {
      const out: any[] = []
      let d: any
      try { d = JSON.parse(dataStr) } catch { return [] }
      if (!eventName) {eventName = d.type || ''}
      model = d.model || model

      if (!started && (eventName === 'message_start' || d.type === 'message_start')) {
        started = true
        const c = chunkBase(d.message?.model || model)
        c.choices[0].delta = { role: 'assistant' }
        c.usage = d.message?.usage ? { prompt_tokens: d.message.usage.input_tokens, completion_tokens: 0 } : undefined
        out.push(c)
      }

      if (eventName === 'content_block_start' || d.type === 'content_block_start') {
        const bi = d.index ?? 0
        const cb = d.content_block || {}
        if (cb.type === 'tool_use') {
          const tIdx = nextToolIndex++
          toolBlockIndex.set(bi, tIdx)
          const c = chunkBase(model)
          c.choices[0].delta.tool_calls = [{ index: tIdx, id: cb.id, type: 'function', function: { name: cb.name || '', arguments: '' } }]
          out.push(c)
        }
      }

      if (eventName === 'content_block_delta' || d.type === 'content_block_delta') {
        const bi = d.index ?? 0
        const delta = d.delta || {}
        const c = chunkBase(model)
        if (delta.type === 'text_delta' && delta.text) {
          c.choices[0].delta.content = delta.text
          out.push(c)
        } else if (delta.type === 'input_json_delta') {
          const tIdx = toolBlockIndex.get(bi)
          if (tIdx !== undefined) {
            c.choices[0].delta.tool_calls = [{ index: tIdx, function: { arguments: delta.partial_json || '' } }]
            out.push(c)
          }
        }
      }

      if (eventName === 'message_delta' || d.type === 'message_delta') {
        const c = chunkBase(model)
        const stop = d.delta?.stop_reason
        c.choices[0].finish_reason = stop === 'tool_use' ? 'tool_calls'
          : stop === 'max_tokens' ? 'length' : 'stop'
        if (d.usage) {
          c.usage = { prompt_tokens: undefined, completion_tokens: d.usage.output_tokens, total_tokens: undefined }
        }
        out.push(c)
      }
      return out
    },
  }
}

function createGeminiStreamParser(): NativeStreamParser {
  let model = ''
  return {
    feed(_eventName: string, dataStr: string) {
      const out: any[] = []
      let d: any
      try { d = JSON.parse(dataStr) } catch { return [] }
      model = d.modelVersion || model
      const cand = d.candidates?.[0]
      if (!cand) {return out}
      const parts: any[] = cand.content?.parts || []
      let toolIndex = 0
      for (const p of parts) {
        const c = chunkBase(model)
        if (typeof p.text === 'string' && p.text) {
          c.choices[0].delta.content = p.text
          out.push(c)
        }
        if (p.functionCall) {
          c.choices[0].delta.tool_calls = [{
            index: toolIndex++,
            id: `call_${toolIndex}`,
            type: 'function',
            function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args ?? {}) },
          }]
          out.push(c)
        }
      }
      if (cand.finishReason) {
        const c = chunkBase(model)
        const fr = cand.finishReason
        c.choices[0].finish_reason = fr === 'MAX_TOKENS' ? 'length'
          : fr === 'SAFETY' || fr === 'RECITATION' ? 'content_filter'
          : 'stop'
        const um = d.usageMetadata
        if (um) {c.usage = { prompt_tokens: um.promptTokenCount, completion_tokens: um.candidatesTokenCount, total_tokens: um.totalTokenCount }}
        out.push(c)
      }
      return out
    },
  }
}

// ────────────────────────────────────────────────────────────
// 入站：错误归一（把原生错误体提取成可读 message，供 modelCompat 分类）
// ────────────────────────────────────────────────────────────

export function extractNativeErrorText(kind: NativeKind, rawText: string): string {
  try {
    const j = JSON.parse(rawText)
    if (kind === 'anthropic') {
      return j.error?.message || j.message || rawText
    }
    if (kind === 'gemini') {
      const e = j.error || {}
      return `${e.message || ''} ${(e.details || []).map((x: any) => x.message || '').join(' ')}`.trim() || rawText
    }
    return j.error?.message || j.message || rawText
  } catch {
    return rawText
  }
}
