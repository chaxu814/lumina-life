// ============================================================
// llmProvider.ts — 独立 LLM 通信模块
//
// 从 agentRunner.ts 提取：处理 HTTP 流式/非流式 LLM 调用、
// 健康检查、超时管理、推理 token 追踪。
// ============================================================

import { matchProfile, getRecommendedTimeout } from '../providerProfiles'
import { checkConnectionAlive } from '../llmRetry'
import {
  classifyModelError,
  degradeForKind,
  describeLimitation,
  clampOutputTokens,
  isLocalEndpoint,
} from './modelCompat'
import {
  resolveNativeKind,
  buildTransportPlan,
  parseNativeCompletion,
  createNativeStreamParser,
  extractNativeErrorText,
  type NativeKind,
} from './nativeBridge'
import { getModelCapabilityCache } from '../modelCapabilityCache'

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

export interface LLMProviderConfig {
  baseUrl: string
  apiKey: string
  model: string
  maxContextTokens: number
  socialMode?: boolean
  personaId?: string
  /** 显式指定原生协议（openai|anthropic|gemini|azure）；缺省按 baseUrl 自动识别 */
  protocol?: string
}

export interface LLMResponse {
  text?: string
  error?: string
  aborted?: boolean
  toolCalls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

export interface LLMEmitCallbacks {
  onThinking?: (text: string) => void
  onThinkingStream?: (text: string, isFirst: boolean, isLast: boolean) => void
  onToolStart?: (tool: string, args: any) => void
  onToolEnd?: (tool: string, result: any) => void
  onError?: (error: string) => void
  onTokenUpdate?: (totalTokens: number, usage: any, delta: number) => void
}

export interface LLMRequestOptions {
  messages: Array<{ role: string; content: string; name?: string; tool_calls?: any[]; tool_call_id?: string; images?: string[] }>
  tools?: any[]
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
  /** 是否启用推理跟踪（思考过程面板） */
  trackReasoning?: boolean
}

// ═══════════════════════════════════════════════════════════
// LLMProvider
// ═══════════════════════════════════════════════════════════

export class LLMProvider {
  private config: LLMProviderConfig
  private healthChecked = false
  private modelPinged = false

  /** 推理跟踪状态 */
  private reasoningStarted = false
  private reasoningAccum = ''

  /** 该端点对应的原生协议（openai / anthropic / gemini / azure） */
  private kind: NativeKind

  constructor(config: LLMProviderConfig) {
    this.config = config
    this.kind = resolveNativeKind(config.baseUrl, config.protocol)
  }

  /** 更新配置（例如运行时切换模型） */
  updateConfig(partial: Partial<LLMProviderConfig>): void {
    Object.assign(this.config, partial)
    this.kind = resolveNativeKind(this.config.baseUrl, this.config.protocol)
  }

  /** 重置健康检查标记（如切换对话后） */
  resetHealthCheck(): void {
    this.healthChecked = false
    this.modelPinged = false
  }

  // ═══════════════════════════════════════════════════════
  // 健康检查
  // ═══════════════════════════════════════════════════════

  async healthCheck(): Promise<{ ok: boolean; modelFound: boolean; loadedModels: string[] }> {
    if (this.healthChecked) return { ok: true, modelFound: true, loadedModels: [] }

    try {
      let res = await fetch(`${this.config.baseUrl}/models`, {
        signal: AbortSignal.timeout(10_000),
        headers: this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {},
      })
      // 本地端点误填 key 导致 401/403 时，免密重试一次（LM Studio/Ollama 本地通常不需要鉴权）
      if (!res.ok && /(localhost|127\.|0\.0\.0\.0|192\.168\.|^https?:\/\/10\.)/i.test(this.config.baseUrl || '') && this.config.apiKey) {
        res = await fetch(`${this.config.baseUrl}/models`, { signal: AbortSignal.timeout(10_000), headers: {} })
      }
      if (res.ok) {
        const modelList = await res.json().catch(() => null)
        const loadedModels: string[] = modelList?.data?.map((m: any) => m.id) || []
        const modelShortName = this.config.model.replace(/[:/\\]/g, '_').split('_').pop() || this.config.model
        const modelFound = loadedModels.some((m: string) =>
          m.includes(modelShortName) || m.includes(this.config.model) || this.config.model.includes(m)
        )
        this.healthChecked = true
        return { ok: true, modelFound, loadedModels }
      }
      return { ok: false, modelFound: false, loadedModels: [] }
    } catch {
      return { ok: false, modelFound: false, loadedModels: [] }
    }
  }

  // ═══════════════════════════════════════════════════════
  // 核心 LLM 调用
  // ═══════════════════════════════════════════════════════

  async call(
    opts: LLMRequestOptions,
    emit?: LLMEmitCallbacks,
  ): Promise<LLMResponse> {
    const isSocialMode = !!this.config.socialMode
    const profile = matchProfile(this.config.baseUrl, this.config.model)
    const isReasoning = profile?.model.category === 'reasoning'

    // 超时计算
    const envTimeout = parseInt(process.env.LUMINA_LLM_TIMEOUT || '0', 10)
    const profileTimeout = profile?.model.recommendedHttpTimeout || 300
    const httpTimeoutSeconds = isSocialMode ? 0 : (envTimeout || profileTimeout)

    // 工具路由
    // fix: 只要调用方显式传入 tools，就尽量发送，让模型自行处理
    //   之前 profile.model.supportsTools=false 会直接禁用 tools，导致模型只能输出 XML
    const modelLacksTools = profile && profile.model.supportsTools === false
    const shouldSendTools = opts.tools && opts.tools.length > 0 && !modelLacksTools

    // 构建请求体
    const messages = opts.messages.map((m) => {
      if (!m.images || !m.images.length) return m
      const content: any[] = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : [...(m.content || [])]
      for (const img of m.images) {
        content.push({ type: 'image_url', image_url: { url: img } })
      }
      const { images, ...rest } = m
      return { ...rest, content }
    })

    const requestBody: Record<string, any> = {
      model: this.config.model,
      messages,
      // 输出上限与上下文窗口解耦：缺省 8192、硬封顶 32768，避免把 256k 上下文当输出上限发给严格服务
      max_tokens: clampOutputTokens(opts.maxTokens),
      temperature: opts.temperature ?? 0.7,
      stream: true,
      stream_options: { include_usage: true },
    }

    if (shouldSendTools) {
      requestBody.tools = opts.tools
      requestBody.tool_choice = 'auto'
    }

    console.log(
      `[LLMProvider] ${isSocialMode ? '⚡社交 ' : ''}` +
      `📡 ${isReasoning ? '推理模型' : '标准模型'} ` +
      `超时:${httpTimeoutSeconds}s 模型:${this.config.model}`,
    )

    // ── 执行请求 ──
    // 原生协议桥接：主链路只讲 OpenAI，由 nativeBridge 翻译成 anthropic/gemini/azure
    const plan = buildTransportPlan(
      this.kind,
      this.config.baseUrl,
      this.config.apiKey || '',
      this.config.model,
      requestBody as any,
    )
    const url = plan.url
    if (this.kind !== 'openai') {
      console.log(`[LLMProvider] 🌉 原生协议 ${this.kind} → ${url.split('?')[0]}`)
    }
    const effectiveTimeout = httpTimeoutSeconds > 0 ? httpTimeoutSeconds * 1000 : 1_800_000 // 默认 30min

    const controller = new AbortController()
    const masterSignal = opts.signal || controller.signal

    const maxTimeout = setTimeout(() => controller.abort('timeout'), effectiveTimeout)

    let streamText = ''
    let streamToolCalls: LLMResponse['toolCalls'] | undefined
    let streamSuccess = false
    let streamUsage: LLMResponse['usage'] | undefined

    const toolCallAccum = new Map<number, { id: string; name: string; args: string }>()

    // per-chunk 看门狗
    let watchdogTimer: NodeJS.Timeout | null = null
    const FIRST_TOKEN_TIMEOUT = 120_000 // 首 token 120s
    const STREAM_IDLE_TIMEOUT = 60_000  // chunk 间空闲 60s
    let firstTokenReceived = false

    const resetWatchdog = () => {
      if (watchdogTimer) clearTimeout(watchdogTimer)
      const timeout = firstTokenReceived ? STREAM_IDLE_TIMEOUT : FIRST_TOKEN_TIMEOUT
      watchdogTimer = setTimeout(() => {
        if (!streamSuccess && !masterSignal.aborted) {
          console.warn(`[LLMProvider] 🐢 看门狗超时 (${firstTokenReceived ? 'chunk idle' : '首 token'} ${timeout}ms)`)
          controller.abort('watchdog_timeout')
        }
      }, timeout)
    }

    try {
      const isLocalishEndpoint = /(localhost|127\.|0\.0\.0\.0|192\.168\.|^https?:\/\/10\.)/i.test(this.config.baseUrl || '')
      const planHeaders: Record<string, string> = { ...plan.headers }
      const noAuthHeaders: Record<string, string> = { ...plan.headers }
      delete noAuthHeaders.Authorization
      const bodyStr = JSON.stringify(plan.body)
      let response = await fetch(url, {
        method: 'POST',
        headers: planHeaders,
        body: bodyStr,
        signal: masterSignal,
      })
      // 本地 OpenAI 兼容端点误填 API Key（如 LM Studio 报 Invalid token 401）→ 去掉 Authorization 自动重试一次
      //   原生协议（anthropic/gemini/azure）的鉴权头各不相同，不做此重试。
      if (response.status === 401 && isLocalishEndpoint && this.kind === 'openai' && this.config.apiKey) {
        console.warn('[LLMProvider] 本地端点返回 401（疑似误填 API Key），去掉鉴权头重试一次')
        try { await response.body?.cancel() } catch { /* ignore */ }
        response = await fetch(url, {
          method: 'POST',
          headers: noAuthHeaders,
          body: bodyStr,
          signal: masterSignal,
        })
      }

      if (!response.ok) {
        const rawErr = await response.text().catch(() => '')
        const errText = extractNativeErrorText(this.kind, rawErr)
        const kind = classifyModelError(response.status, errText)
        // 能力不匹配（tools / vision / stream_options / max_tokens）→ 去字段降级，非流式重试一次
        if (kind !== 'unknown' && kind !== 'context' && kind !== 'auth') {
          try {
            if (kind === 'tools') getModelCapabilityCache().markNoToolSupport(this.config.model)
            else if (kind === 'vision') getModelCapabilityCache().update(this.config.model, { supportsVision: false })
          } catch { /* 缓存不可用忽略 */ }
          const note = describeLimitation(kind, this.config.model)
          if (note) console.warn(`[LLMProvider] 🔧 ${response.status} ${kind} → 降级：${note}`)
          const degraded = degradeForKind(requestBody, kind)
          const fallback = await this.callNonStreaming(opts, emit, degraded).catch(() => null)
          if (fallback && !fallback.error) return fallback
        }
        const errMsg = `LLM 返回 ${response.status}: ${errText.slice(0, 300)}`
        return { error: errMsg }
      }

      if (!response.body) {
        return { error: '响应体为空' }
      }

      // ── 流式读取 ──
      // openai/azure 响应本身就是 OpenAI chunk；anthropic/gemini 经原生 parser 归一成 OpenAI chunk
      const nativeParser = (this.kind === 'openai' || this.kind === 'azure')
        ? null
        : createNativeStreamParser(this.kind)
      let sseEvent = ''

      // 单个 OpenAI 风格 chunk 的处理（流式文本 / 推理 / 工具调用累加 / usage）
      const processChunk = (chunk: any) => {
        // 推理 token
        if (opts.trackReasoning && chunk.choices?.[0]?.delta?.reasoning_content) {
          const reasoningText = chunk.choices[0].delta.reasoning_content
          if (reasoningText) {
            if (!this.reasoningStarted) {
              this.reasoningStarted = true
              this.reasoningAccum = ''
              emit?.onThinkingStream?.('', true, false)
              if (!firstTokenReceived) firstTokenReceived = true
            }
            this.reasoningAccum += reasoningText
            // 推理内容只通过 onThinkingStream 发思考面板，不混入最终回复文本
            emit?.onThinkingStream?.(reasoningText, false, false)
            return
          }
        }

        const delta = chunk.choices?.[0]?.delta
        if (delta?.content) {
          if (!firstTokenReceived) {
            firstTokenReceived = true
          }
          streamText += delta.content
        } else if (delta?.reasoning_content && opts.trackReasoning !== false) {
          // 推理模型将回复放在 reasoning_content，content 为空
          if (!firstTokenReceived) {
            firstTokenReceived = true
          }
          streamText += delta.reasoning_content
        }

        // 工具调用
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0
            if (!toolCallAccum.has(idx)) toolCallAccum.set(idx, { id: '', name: '', args: '' })
            const acc = toolCallAccum.get(idx)!
            if (tc.id) acc.id = tc.id
            if (tc.function?.name) acc.name = tc.function.name
            if (tc.function?.arguments) acc.args += tc.function.arguments
          }
        }

        if (chunk.usage) {
          // 原生流末 chunk 的 usage 可能只给 completion_tokens，做一次合并而非覆盖
          streamUsage = { ...(streamUsage as any), ...chunk.usage } as any
        }
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      resetWatchdog()

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue

          // Anthropic SSE：每个 data 前有一行 `event: xxx`，记录下来供 parser 使用
          if (trimmed.startsWith('event:')) {
            sseEvent = trimmed.slice(6).trim()
            continue
          }

          const dm = /^data:\s?(.*)$/.exec(trimmed)
          if (!dm) continue
          const dataStr = dm[1].trim()
          if (!dataStr || dataStr === '[DONE]') continue

          resetWatchdog()

          try {
            if (nativeParser) {
              const chunks = nativeParser.feed(sseEvent, dataStr)
              for (const ck of chunks) processChunk(ck)
            } else {
              processChunk(JSON.parse(dataStr))
            }
          } catch { /* skip malformed chunk */ }
        }
      }

      // 构建 tool calls
      const tcs: LLMResponse['toolCalls'] = []
      for (const [, tc] of toolCallAccum) {
        if (tc.name) {
          tcs.push({
            id: tc.id || `call_${Date.now()}`,
            type: 'function',
            function: { name: tc.name, arguments: tc.args },
          })
        }
      }
      streamToolCalls = tcs.length > 0 ? tcs : undefined
      streamSuccess = true

      // 推理结束
      if (opts.trackReasoning) {
        emit?.onThinkingStream?.('', false, true)
        this.reasoningStarted = false
        // 必须在清空 reasoningAccum 前做兜底检查！
        //   之前兜底写在 try-catch 之外，但 reasoningAccum 先被清空导致永远不触发。
        //   推理模型（DeepSeek-R1/QwQ 等）将全部内容放在 reasoning_content 而非 content，
        //   若不在此处兜底，streamText 一直为空 → 触发 reactEngine 的连续空回复错误。
        if (!streamText && this.reasoningAccum) {
          streamText = this.reasoningAccum
        }
        this.reasoningAccum = ''
      }
    } catch (err: any) {
      clearTimeout(maxTimeout)
      if (watchdogTimer) clearTimeout(watchdogTimer)

      if (err.name === 'AbortError' || String(err.message).includes('abort')) {
        if (masterSignal.aborted && opts.signal?.aborted) {
          return { error: '用户中止', aborted: true }
        }

        const alive = await checkConnectionAlive(this.config.baseUrl).catch(() => false)
        if (!alive) {
          return { error: '💀 LLM 服务连接断开' }
        }

        // 流式超时但已有部分内容 → 直接返回
        const partialText = (streamText || '').trim()
        if (partialText.length > 20) {
          console.warn(`[LLMProvider] 🐢 流式超时 (${effectiveTimeout}ms) 但已有 ${partialText.length} 字 → 直接返回`)
          emit?.onThinkingStream?.('', false, true)
          this.reasoningStarted = false
          this.reasoningAccum = ''
          return { text: partialText, usage: streamUsage }
        }

        // 内容太少 → 降级非流式
        console.warn(`[LLMProvider] 🐢 流式超时且内容不足 → 降级非流式`)
        emit?.onThinkingStream?.('', false, true)
        this.reasoningStarted = false
        this.reasoningAccum = ''

        return await this.callNonStreaming(opts, emit)
      }

      return { error: err.message || String(err) }
    } finally {
      clearTimeout(maxTimeout)
      if (watchdogTimer) clearTimeout(watchdogTimer)
    }

    // ── 成功返回 ──
    // 兜底 — 如果 streamText 为空但 reasoningAccum 有内容，
    //   说明模型把回复放在 reasoning_content 而非 content（某些推理模型行为）。
    //   此时用 reasoningAccum 作为最终回复文本，避免静默丢内容。
    if (!streamText && this.reasoningAccum) {
      streamText = this.reasoningAccum
    }
    return {
      text: streamText || undefined,
      toolCalls: streamToolCalls,
      usage: streamUsage,
    }
  }

  // ═══════════════════════════════════════════════════════
  // 非流式回退调用
  // ═══════════════════════════════════════════════════════

  private async callNonStreaming(
    opts: LLMRequestOptions,
    emit?: LLMEmitCallbacks,
    bodyOverride?: Record<string, any>,
  ): Promise<LLMResponse> {
    const timeout = 600_000

    // 图片转 image_url（与流式路径保持一致）
    const messages = (opts.messages || []).map((m) => {
      if (!m.images || !m.images.length) return m
      const content: any[] = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : [...(m.content || [])]
      for (const img of m.images) content.push({ type: 'image_url', image_url: { url: img } })
      const { images, ...rest } = m
      return { ...rest, content }
    })

    // bodyOverride 来自流式 400 降级（已移除问题字段，OpenAI 形态）；否则按标准 OpenAI 形态构造
    const requestBody: Record<string, any> = bodyOverride ? { ...bodyOverride, stream: false } : {
      model: this.config.model,
      messages,
      max_tokens: clampOutputTokens(opts.maxTokens),
      temperature: opts.temperature ?? 0.7,
      stream: false,
    }

    if (!bodyOverride && opts.tools && opts.tools.length > 0) {
      requestBody.tools = opts.tools
      requestBody.tool_choice = 'auto'
    }

    // 原生协议桥接
    const plan = buildTransportPlan(
      this.kind, this.config.baseUrl, this.config.apiKey || '', this.config.model, requestBody as any,
    )
    const url = plan.url
    const bodyStr = JSON.stringify(plan.body)

    try {
      const isLocal = isLocalEndpoint(this.config.baseUrl)
      const reqHeaders = (withAuth: boolean): Record<string, string> => {
        const h: Record<string, string> = { ...plan.headers }
        if (!withAuth) delete h.Authorization
        return h
      }
      let res = await fetch(url, { method: 'POST', headers: reqHeaders(true), body: bodyStr, signal: AbortSignal.timeout(timeout) })
      if (res.status === 401 && isLocal && this.kind === 'openai' && this.config.apiKey) {
        console.warn('[LLMProvider] 非流式：本地端点 401，去鉴权重试一次')
        try { await res.body?.cancel() } catch {}
        res = await fetch(url, { method: 'POST', headers: reqHeaders(false), body: bodyStr, signal: AbortSignal.timeout(timeout) })
      }

      if (!res.ok) {
        const rawErr = await res.text().catch(() => '')
        const errText = extractNativeErrorText(this.kind, rawErr)
        // 尚未降级过时，按错误类别自动降级一次（去 tools / stream_options / 图片 / 降 max_tokens）
        if (!bodyOverride) {
          const kind = classifyModelError(res.status, errText)
          if (kind !== 'unknown' && kind !== 'context' && kind !== 'auth') {
            try {
              if (kind === 'tools') getModelCapabilityCache().markNoToolSupport(this.config.model)
              else if (kind === 'vision') getModelCapabilityCache().update(this.config.model, { supportsVision: false })
            } catch { /* 缓存不可用忽略 */ }
            const note = describeLimitation(kind, this.config.model)
            if (note) console.warn(`[LLMProvider] 🔧 非流式 ${res.status} ${kind} → 降级：${note}`)
            return await this.callNonStreaming(opts, emit, degradeForKind(requestBody, kind))
          }
        }
        return { error: `非流式 LLM 返回 ${res.status}: ${errText.slice(0, 300)}` }
      }

      const rawJson = await res.json()
      // 原生协议（anthropic/gemini）响应归一为 OpenAI completion；azure/openai 原样
      const json = parseNativeCompletion(this.kind, rawJson)
      const choice = json.choices?.[0]
      if (!choice) return { error: '非流式响应无 choices' }

      return {
        text: (choice.message?.reasoning_content || choice.message?.content || '').trimStart(),
        toolCalls: choice.message?.tool_calls?.map((tc: any) => ({
          id: tc.id,
          type: 'function' as const,
          function: tc.function,
        })) || undefined,
        usage: json.usage || undefined,
      }
    } catch (err: any) {
      return { error: `非流式调用失败: ${err.message}` }
    }
  }
}
