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
  needsXmlToolInstructions,
  injectXmlToolInstructions,
} from './modelCompat'
// XML 工具兼容提示的规格来源（惰性 require 封装在内部，避免与 tools/ 形成静态环）
import { loadRuntimeXmlToolSpecs } from '../llm/xmlToolCall'
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
  /**
   * 流式被超时/看门狗中断，text 只是半截。
   * 为什么必须显式标记：半截答案和完整答案在返回值上长得一模一样，
   * 调用方按「成功」处理就会把「我来帮你搜索一下…」当成结论发给用户，
   * 用户无从判断后面是不是还有内容。截断提示由上层（agentRunner）补，
   * 这里只负责如实上报，不做展示层决策。
   */
  truncated?: boolean
}

/** 上层把截断提示追加到正文末尾时使用的统一文案（避免各处各写一份、口径不一致） */
export const STREAM_TRUNCATION_NOTICE = '（因超时中断，内容可能不完整）'

/** 推理兜底前缀：模型只给了 reasoning_content、没给正式回答时的显式说明 */
export const REASONING_FALLBACK_PREFIX =
  '（模型未返回正式回答，以下是它的推理过程草稿，不是最终结论）'

/**
 * 推理模型（DeepSeek-R1 / QwQ 等）把回答放进 reasoning_content 而非 content 时的兜底文本。
 *
 * 为什么加前缀而不是裸顶替：
 *   裸顶替（streamText = reasoningAccum）会让聊天框直接显示「嗯，我需要先分析…第一步…」，
 *   用户分不清这是答案还是过程，而思考面板里同时还有同一份，同一段话出现两次，
 *   最糟的情况是用户把半截推理当成结论。
 *   直接丢弃又会让 streamText 一直为空，触发 reactEngine 的连续空回复错误。
 *   所以保留内容（保住可诊断性），但用一句人话前缀钉死它的性质。
 */
export function buildReasoningFallbackText(reasoning: string): string {
  const body = (reasoning || '').trim()
  if (!body) {return ''}
  return `${REASONING_FALLBACK_PREFIX}\n\n${body}`
}

/**
 * 只取 baseUrl 的 origin（协议 + host + 端口），供报错信息使用。
 *
 * 报错信息会被写日志、可能进 UI，所以必须先把 userinfo（可能含 key）、
 * path、query 全部丢掉；解析失败则返回空串而不是原文 —— 宁可少说，
 * 也不能把凭据带出去。
 */
export function safeOrigin(baseUrl: string | undefined | null): string {
  const raw = String(baseUrl || '').trim()
  if (!raw) {return ''}
  try {
    return new URL(raw).origin
  } catch {
    return ''
  }
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
    if (this.healthChecked) {return { ok: true, modelFound: true, loadedModels: [] }}

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
      if (!m.images || !m.images.length) {return m}
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

    // 🔧 P0-1 修正（2026-10-05）：外部 signal、内部超时、看门狗必须【组合】。
    //
    //   旧写法：const masterSignal = opts.signal || controller.signal
    //   实际后果：只要调用方传了 opts.signal（agentRunner 的包装器、petWindow 等都会传），
    //   masterSignal 就是 opts.signal，controller.abort('timeout') 对 fetch 【毫无作用】。
    //   于是 maxTimeout 和看门狗同时失效 —— 请求既不会超时、也不会被看门狗打断。
    //   症状：本地模型卡住时界面永久转圈，日志里既没有超时也没有看门狗记录。
    //
    //   AbortSignal.any 语义 =「任意一个触发就取消」，且自带去重。
    //   三路必须【全部】入列：外部取消 / 总超时 / 看门狗，漏哪一路哪路就失效。
    const controller = new AbortController()
    const timeoutSignal = AbortSignal.timeout(effectiveTimeout)
    const masterSignal = AbortSignal.any(
      opts.signal ? [opts.signal, timeoutSignal, controller.signal] : [timeoutSignal, controller.signal],
    )

    const maxTimeout = setTimeout(() => controller.abort('timeout'), effectiveTimeout)

    let streamText = ''
    let streamToolCalls: LLMResponse['toolCalls'] | undefined
    let streamSuccess = false
    let streamUsage: LLMResponse['usage'] | undefined

    const toolCallAccum = new Map<number, { id: string; name: string; args: string }>()

    // 流被中断时，tool_calls 的 arguments 只到一半。
    // 关键：中断路径也必须把已累积的 tool_calls 交出去 —— 丢掉它等于把模型
    // 「已经决定要做的事」整个抹掉，调用方只能看到一段前言，后面什么都不会发生。
    const buildAccumulatedToolCalls = (): LLMResponse['toolCalls'] => {
      const tcs: NonNullable<LLMResponse['toolCalls']> = []
      for (const [, tc] of toolCallAccum) {
        if (tc.name) {
          tcs.push({
            id: tc.id || `call_${Date.now()}`,
            type: 'function',
            function: { name: tc.name, arguments: tc.args },
          })
        }
      }
      return tcs.length > 0 ? tcs : undefined
    }

    // per-chunk 看门狗
    let watchdogTimer: NodeJS.Timeout | null = null
    const FIRST_TOKEN_TIMEOUT = 120_000 // 首 token 120s
    const STREAM_IDLE_TIMEOUT = 60_000  // chunk 间空闲 60s
    let firstTokenReceived = false

    const resetWatchdog = () => {
      if (watchdogTimer) {clearTimeout(watchdogTimer)}
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
            if (kind === 'tools') {getModelCapabilityCache().markNoToolSupport(this.config.model)}
            else if (kind === 'vision') {getModelCapabilityCache().update(this.config.model, { supportsVision: false })}
          } catch { /* 缓存不可用忽略 */ }
          const note = describeLimitation(kind, this.config.model)
          if (note) {console.warn(`[LLMProvider] 🔧 ${response.status} ${kind} → 降级：${note}`)}
          const degraded = degradeForKind(requestBody, kind)
          // 🔧 2026-10-04：tools 被删后模型就不知道有哪些工具可用。
          //  补一段 XML 调用说明，否则不支持原生协议的模型会静默退化成纯聊天。
          //  详见 modelCompat.ts 中 degradeForKind 上方的契约说明。
          if (needsXmlToolInstructions(kind)) {
            const specs = loadRuntimeXmlToolSpecs(12)
            const nextMessages = injectXmlToolInstructions(degraded.messages, specs, 12)
            if (nextMessages) {degraded.messages = nextMessages}
            console.log(`[LLMProvider] 🧩 已注入 XML 工具兼容提示（${specs.length} 个工具）`)
          }
          const fallback = await this.callNonStreaming(opts, emit, degraded).catch(() => null)
          if (fallback && !fallback.error) {return fallback}
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
              if (!firstTokenReceived) {firstTokenReceived = true}
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
            if (!toolCallAccum.has(idx)) {toolCallAccum.set(idx, { id: '', name: '', args: '' })}
            const acc = toolCallAccum.get(idx)!
            if (tc.id) {acc.id = tc.id}
            if (tc.function?.name) {acc.name = tc.function.name}
            if (tc.function?.arguments) {acc.args += tc.function.arguments}
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
        if (done) {break}

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) {continue}

          // Anthropic SSE：每个 data 前有一行 `event: xxx`，记录下来供 parser 使用
          if (trimmed.startsWith('event:')) {
            sseEvent = trimmed.slice(6).trim()
            continue
          }

          const dm = /^data:\s?(.*)$/.exec(trimmed)
          if (!dm) {continue}
          const dataStr = dm[1].trim()
          if (!dataStr || dataStr === '[DONE]') {continue}

          resetWatchdog()

          try {
            if (nativeParser) {
              const chunks = nativeParser.feed(sseEvent, dataStr)
              for (const ck of chunks) {processChunk(ck)}
            } else {
              processChunk(JSON.parse(dataStr))
            }
          } catch { /* skip malformed chunk */ }
        }
      }

      // 构建 tool calls
      streamToolCalls = buildAccumulatedToolCalls()
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
          streamText = buildReasoningFallbackText(this.reasoningAccum)
        }
        this.reasoningAccum = ''
      }
    } catch (err: any) {
      clearTimeout(maxTimeout)
      if (watchdogTimer) {clearTimeout(watchdogTimer)}

      if (err.name === 'AbortError' || String(err.message).includes('abort')) {
        if (opts.signal?.aborted) {
          return { error: '用户中止', aborted: true }
        }
        // 🔧 P0-1 配套：现在能区分是谁取消的了。
        //   旧代码只看 masterSignal.aborted，而 masterSignal 就是 opts.signal，
        //   所以「超时」和「用户中止」被当成同一件事，报错文案全是错的。
        const byTimeout = timeoutSignal.aborted
        const byWatchdog = controller.signal.aborted && !byTimeout

        const alive = await checkConnectionAlive(this.config.baseUrl).catch(() => false)
        if (!alive) {
          return { error: '💀 LLM 服务连接断开' }
        }

        emit?.onThinkingStream?.('', false, true)
        this.reasoningStarted = false
        this.reasoningAccum = ''

        const partialText = (streamText || '').trim()
        const partialToolCalls = buildAccumulatedToolCalls()
        const reason = byWatchdog ? '看门狗超时（服务端长时间无数据）' : `请求超时（${Math.round(effectiveTimeout / 1000)}s）`

        // 🔧 P1-1 / P1-2 修正（2026-10-05）：删除「流式超时 → 降级非流式重发」。
        //
        //   旧逻辑：partialText.length <= 20 时，重发一个完整的非流式请求。
        //   为什么这是错的（三条）：
        //     1. 流式慢的【原因】在非流式路径【完全相同】——重发不会变快，
        //        反而把已收到的流式内容丢掉。
        //     2. 非流式最长等 600s 且【零反馈】，用户看到的是「假死」而不是「慢」，
        //        等于把可观测的慢，换成了不可观测的卡。
        //     3. 白白多算一遍完整 prefill。对本地 9B 模型这是双倍时间。
        //   且 20 字阈值是任意的：模型常以「我来帮你搜索一下」（7 字）开头，
        //   触发重发的概率并不低。
        //
        //   正确做法：如实返回已收到的内容 + truncated 标记，交由上层展示提示。
        //   用户宁可看到「可能不完整」的前半段，也不要一个永远转圈的对话框。
        console.warn(
          `[LLMProvider] 🐢 流式中断：${reason}，已收 ${partialText.length} 字 / ${partialToolCalls?.length ?? 0} 个工具调用`,
        )
        if (partialText.length > 0 || partialToolCalls) {
          return {
            text: partialText || undefined,
            toolCalls: partialToolCalls,
            usage: streamUsage,
            truncated: true,
          }
        }

        // 一个字都没收到：这不是「截断」，是彻底失败，必须给出可行动的错误。
        return {
          error: byWatchdog
            ? `模型服务长时间无响应（${reason}）。本地模型在 prefill 阶段可能就已超时——`
              + '建议在「设置 → LLM 模型」里把上下文窗口调成与模型实际 n_ctx 一致（不是越大越好）。'
            : `模型响应超时（${reason}）。可尝试：缩短对话 / 换更快的模型 / 调高超时。`,
        }
      }

      return { error: err.message || String(err) }
    } finally {
      clearTimeout(maxTimeout)
      if (watchdogTimer) {clearTimeout(watchdogTimer)}
    }

    // ── 成功返回 ──
    // 兜底 — 如果 streamText 为空但 reasoningAccum 有内容，
    //   说明模型把回复放在 reasoning_content 而非 content（某些推理模型行为）。
    //   此时用带说明前缀的推理内容兜底，避免静默丢内容，也避免用户把裸思维链当成答案。
    if (!streamText && this.reasoningAccum) {
      streamText = buildReasoningFallbackText(this.reasoningAccum)
    }

    // 🔧 2026-10-04：空内容必须报错，不能静默返回 undefined。
    //
    // 真实踩坑：用户的 LM Studio 跑在 http://192.168.1.2:1234（漏了 /v1），
    // 应用拼出 /chat/completions 打到非 API 路径，LM Studio 返回
    // **HTTP 200 + 空 body** —— 不抛异常、不进 catch，streamText 一直是空串，
    // 最终 `text: undefined`。界面上表现就是「发不出消息」且没有任何报错，
    // 用户只能自己猜。
    //
    // ⚠️ 但「有工具调用」也是 content 为空 —— function calling 场景模型只回
    //   tool_calls、content 本来就是空串。漏掉这个判断会把所有工具调用打成
    //   「空回复错误」（这个回归真发生过，是 tests/llmProvider.test.ts 抓到的）。
    //   所以只有「既没有文本、也没有工具调用」才算真的空。
    //
    // 注意不要泄露 apiKey —— 这里只带 baseUrl 的 origin。
    const hasToolCalls = streamToolCalls && streamToolCalls.length > 0
    if ((!streamText || !streamText.trim()) && !hasToolCalls) {
      const origin = safeOrigin(this.config.baseUrl)
      const hint = !this.config.baseUrl || !this.config.baseUrl.trim()
        ? '未配置 API 地址'
        : !origin
          ? `API 地址格式无法解析（${String(this.config.baseUrl).slice(0, 60)}）`
          : `${origin} 返回了空内容`
      console.warn(`[LLMProvider] ⚠️ 空回复：${hint}（HTTP 200 但没有任何 content）`)
      return {
        error:
          `模型服务返回了空内容（${hint}）。\n`
          + '常见原因：\n'
          + '· API 地址写错 —— 本地 LM Studio / Ollama 必须以 /v1 结尾，'
          + '例如 http://192.168.1.2:1234/v1（端口在中间，别把 /v1 写在端口前面）\n'
          + '· 打到了非 API 路径（返回 200 但不是模型输出）\n'
          + '· 服务端没加载任何模型',
      }
    }

    return {
      text: streamText,
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
      if (!m.images || !m.images.length) {return m}
      const content: any[] = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : [...(m.content || [])]
      for (const img of m.images) {content.push({ type: 'image_url', image_url: { url: img } })}
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
        if (!withAuth) {delete h.Authorization}
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
              if (kind === 'tools') {getModelCapabilityCache().markNoToolSupport(this.config.model)}
              else if (kind === 'vision') {getModelCapabilityCache().update(this.config.model, { supportsVision: false })}
            } catch { /* 缓存不可用忽略 */ }
            const note = describeLimitation(kind, this.config.model)
            if (note) {console.warn(`[LLMProvider] 🔧 非流式 ${res.status} ${kind} → 降级：${note}`)}
            const degraded2 = degradeForKind(requestBody, kind)
            // 与流式路径保持一致：tools 降级时必须补 XML 提示词，否则能力静默归零
            if (needsXmlToolInstructions(kind)) {
              const specs = loadRuntimeXmlToolSpecs(12)
              const nextMessages = injectXmlToolInstructions(degraded2.messages, specs, 12)
              if (nextMessages) {degraded2.messages = nextMessages}
              console.log(`[LLMProvider] 🧩 非流式降级已注入 XML 工具兼容提示（${specs.length} 个工具）`)
            }
            return await this.callNonStreaming(opts, emit, degraded2)
          }
        }
        return { error: `非流式 LLM 返回 ${res.status}: ${errText.slice(0, 300)}` }
      }

      const rawJson = await res.json()
      // 原生协议（anthropic/gemini）响应归一为 OpenAI completion；azure/openai 原样
      const json = parseNativeCompletion(this.kind, rawJson)
      const choice = json.choices?.[0]
      if (!choice) {return { error: '非流式响应无 choices' }}

      return {
        // 🔧 顺序修正：content 优先、reasoning_content 兜底。
        //   原来 reasoning 优先 —— 非流式分支是「流式 400 / 超时」的降级必经路径，
        //   一旦模型两者都返回，用户就会直接看到思维链而不是答案。
        text: (choice.message?.content || choice.message?.reasoning_content || '').trimStart(),
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
