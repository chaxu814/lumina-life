// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// ⚠️ @deprecated（2026-09）未接入主链路，仅支持非流式纯文本，无工具调用 / 流式 / 视觉。
//    主链路的统一出站/入站协议翻译已由 core/nativeBridge.ts + llmProvider.ts 承担（支持
//    流式、工具回合、多模态，覆盖 Claude/Gemini/Azure/OpenAI）。本文件仅留作参考与旧测试，
//    新代码勿引用；可连同 tests/unifiedChat.test.ts 一并删除。
// core/unifiedChat.ts — 🔀 统一模型调用层 (v0.1) 【已弃用，见上方说明】
//
// providerAdapter.ts 已负责「请求体 / 鉴权头 / 端点」的供应商归一；
// 本层在其上补齐真正发请求时缺的那一圈：
//   - 一次非流式 chat completion（含 AbortController 超时）；
//   - OpenAI / Anthropic / Ollama 响应归一为 { text, usage, raw }；
//   - HTTP 错误归一为 UnifiedChatError（带 status 与建议 retryAfter）；
//   - 模型列表归一。
// fetch 可注入，纯解析函数可脱离网络单测。
// ============================================================

import {
  identifyProvider,
  adaptRequestBody,
  getRetryAfterFromProvider,
  type ProviderKind,
} from './providerAdapter'

export type { ProviderKind }

export interface UnifiedChatMessage {
  role: string
  content: string
  name?: string
  tool_calls?: any[]
  tool_call_id?: string
}

export interface UnifiedChatInput {
  baseUrl: string
  apiKey: string
  model: string
  messages: UnifiedChatMessage[]
  tools?: any[]
  maxTokens?: number
  temperature?: number
  /** 超时毫秒，默认 60000 */
  timeoutMs?: number
  /** 外部取消信号（可选） */
  signal?: AbortSignal
}

export interface UnifiedUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}

export interface UnifiedChatResponse {
  provider: ProviderKind
  text: string
  usage: UnifiedUsage
  raw: any
}

export class UnifiedChatError extends Error {
  readonly status?: number
  readonly provider: ProviderKind
  readonly retryAfterMs?: number
  readonly code: string
  constructor(message: string, code: string, provider: ProviderKind, status?: number, retryAfterMs?: number) {
    super(message)
    this.name = 'UnifiedChatError'
    this.code = code
    this.provider = provider
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

type FetchLike = (url: string, init?: any) => Promise<{
  ok: boolean
  status: number
  text: () => Promise<string>
  json: () => Promise<any>
}>

export interface UnifiedDeps {
  fetch?: FetchLike
}

/** 纯函数：把各供应商的非流式响应解析为统一文本与用量 */
export function parseProviderResponse(kind: ProviderKind, data: any): { text: string; usage: UnifiedUsage } {
  if (!data || typeof data !== 'object') {
    return { text: '', usage: {} }
  }

  if (kind === 'anthropic') {
    const blocks: any[] = Array.isArray(data.content) ? data.content : []
    const text = blocks.filter(b => b && b.type === 'text').map(b => String(b.text ?? '')).join('').trim()
    const u = data.usage || {}
    const usage: UnifiedUsage = {
      prompt_tokens: u.input_tokens,
      completion_tokens: u.output_tokens,
      total_tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0) || undefined,
    }
    return { text, usage }
  }

  if (kind === 'ollama') {
    const text = String(data?.message?.content ?? '').trim()
    const u = data || {}
    const usage: UnifiedUsage = {
      prompt_tokens: u.prompt_eval_count,
      completion_tokens: u.eval_count,
      total_tokens: (u.prompt_eval_count ?? 0) + (u.eval_count ?? 0) || undefined,
    }
    return { text, usage }
  }

  // OpenAI 兼容（LM Studio / DeepSeek / DashScope / SiliconFlow / 智谱 / OpenAI）
  const msg = data?.choices?.[0]?.message
  const text = String(msg?.content ?? '').trim()
  const u = data?.usage || {}
  return {
    text,
    usage: {
      prompt_tokens: u.prompt_tokens,
      completion_tokens: u.completion_tokens,
      total_tokens: u.total_tokens,
    },
  }
}

function getFetch(deps?: UnifiedDeps): FetchLike {
  const f = deps?.fetch || (globalThis as any).fetch
  if (typeof f !== 'function') {throw new UnifiedChatError('当前环境没有可用的 fetch', 'no-fetch', 'unknown')}
  return f as FetchLike
}

/** 一次非流式对话补全 */
export async function unifiedChatCompletion(input: UnifiedChatInput, deps?: UnifiedDeps): Promise<UnifiedChatResponse> {
  const kind = identifyProvider(input.baseUrl)
  const adapted = adaptRequestBody({
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    model: input.model,
    messages: input.messages,
    tools: input.tools,
    maxTokens: input.maxTokens,
    temperature: input.temperature,
    stream: false,
  })

  const controller = new AbortController()
  const timeoutMs = input.timeoutMs ?? 60000
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onAbort = () => controller.abort()
  input.signal?.addEventListener('abort', onAbort)

  const fetchImpl = getFetch(deps)
  let res: { ok: boolean; status: number; text: () => Promise<string> }
  try {
    res = await fetchImpl(adapted.url, {
      method: adapted.method,
      headers: adapted.headers,
      body: JSON.stringify(adapted.body),
      signal: controller.signal,
    })
  } catch (err: any) {
    clearTimeout(timer)
    if (err?.name === 'AbortError') {throw new UnifiedChatError('请求超时或被取消', 'timeout', kind)}
    throw new UnifiedChatError(`无法连接到模型服务：${err?.message || 'network'}`, 'network', kind)
  } finally {
    input.signal?.removeEventListener('abort', onAbort)
  }

  const rawText = await res.text()
  clearTimeout(timer)
  if (!res.ok) {
    const retryAfter = getRetryAfterFromProvider(kind, res.status)
    throw new UnifiedChatError(
      `模型服务返回 HTTP ${res.status}`,
      'http-error',
      kind,
      res.status,
      Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined,
    )
  }

  let data: any
  try { data = rawText ? JSON.parse(rawText) : {} } catch {
    throw new UnifiedChatError('模型服务返回了无法解析的内容', 'bad-json', kind)
  }
  const parsed = parseProviderResponse(kind, data)
  return { provider: kind, text: parsed.text, usage: parsed.usage, raw: data }
}

export interface UnifiedModelInfo {
  id: string
}

/** 列出可用模型（OpenAI 兼容走 /models；Ollama 走 /api/tags） */
export async function listModels(
  baseUrl: string,
  apiKey: string,
  deps?: UnifiedDeps,
): Promise<UnifiedModelInfo[]> {
  const kind = identifyProvider(baseUrl)
  const root = baseUrl.replace(/\/+$/, '')
  const fetchImpl = getFetch(deps)
  const headers: Record<string, string> = {}
  if (apiKey) {headers['Authorization'] = `Bearer ${apiKey}`}

  if (kind === 'ollama') {
    const res = await fetchImpl(`${root}/api/tags`, { method: 'GET', headers })
    const data = await res.json().catch(() => ({}))
    return Array.isArray(data?.models) ? data.models.map((m: any) => ({ id: String(m.name) })) : []
  }

  const res = await fetchImpl(`${root}/models`, { method: 'GET', headers })
  const data = await res.json().catch(() => ({}))
  return Array.isArray(data?.data)
    ? (data.data as any[]).map((m: any) => ({ id: String(m.id ?? m.name ?? '') })).filter((m: { id: string }) => !!m.id)
    : []
}
