// ============================================================
// llmProvider.ts — 独立 LLM 通信模块
//
// 从 agentRunner.ts 提取：处理 HTTP 流式/非流式 LLM 调用、
// 健康检查、超时管理、推理 token 追踪。
// ============================================================

import { matchProfile, getRecommendedTimeout } from '../providerProfiles'
import { checkConnectionAlive } from '../llmRetry'

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
  messages: Array<{ role: string; content: string; name?: string; tool_calls?: any[]; tool_call_id?: string }>
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

  constructor(config: LLMProviderConfig) {
    this.config = config
  }

  /** 更新配置（例如运行时切换模型） */
  updateConfig(partial: Partial<LLMProviderConfig>): void {
    Object.assign(this.config, partial)
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
      const res = await fetch(`${this.config.baseUrl}/models`, {
        signal: AbortSignal.timeout(10_000),
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
      })
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
    const requestBody: Record<string, any> = {
      model: this.config.model,
      messages: opts.messages,
      max_tokens: opts.maxTokens || this.config.maxContextTokens,
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
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`
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
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(requestBody),
        signal: masterSignal,
      })

      if (!response.ok) {
        const errText = await response.text().catch(() => '')
        const errMsg = `LLM 返回 ${response.status}: ${errText.slice(0, 300)}`
        return { error: errMsg }
      }

      if (!response.body) {
        return { error: '响应体为空' }
      }

      // ── 流式读取 ──
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
          if (!trimmed || trimmed === 'data: [DONE]') continue

          if (trimmed.startsWith('data: ')) {
            resetWatchdog()

            try {
              const chunk = JSON.parse(trimmed.slice(6))

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
                  // ❌ 已删除: streamText += reasoningText — 推理内容只通过 onThinkingStream 发思考面板，不混入最终回复文本
                  emit?.onThinkingStream?.(reasoningText, false, false)
                  continue
                }
              }

              const delta = chunk.choices?.[0]?.delta
              if (delta?.content) {
                if (!firstTokenReceived) {
                  firstTokenReceived = true
                }
                streamText += delta.content
              } else if (delta?.reasoning_content && opts.trackReasoning !== false) {
                // 🆕 fix: 推理模型将回复放在 reasoning_content，content 为空
                // trackReasoning=false 时不追加，避免推理泄露到消息气泡
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

              if (chunk.usage) streamUsage = chunk.usage
            } catch { /* skip malformed chunk */ }
          }
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
  ): Promise<LLMResponse> {
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`
    const timeout = 600_000

    const requestBody: Record<string, any> = {
      model: this.config.model,
      messages: opts.messages,
      max_tokens: opts.maxTokens || this.config.maxContextTokens,
      temperature: opts.temperature ?? 0.7,
      stream: false,
    }

    if (opts.tools && opts.tools.length > 0) {
      requestBody.tools = opts.tools
      requestBody.tool_choice = 'auto'
    }

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(timeout),
      })

      if (!res.ok) {
        const errText = await res.text().catch(() => '')
        return { error: `非流式 LLM 返回 ${res.status}: ${errText.slice(0, 300)}` }
      }

      const json = await res.json()
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
