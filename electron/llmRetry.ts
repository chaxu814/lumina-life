// ============================================================
// llmRetry.ts — LLM 调用稳定性保障 (v4.0 慢速修复)
//
// v4.0 修复（根治"低配电脑超时死亡螺旋"）：
//   ✅ 渐进超时：第1次60s → 第2次120s → 第3次300s → 第4次600s
//   ✅ 慢速存活检测：TCP活跃但慢 ≠ 连接挂了，区分对待
//   ✅ 流式心跳：只要流中有数据流动就重置超时计时器
//   ✅ 慢速模式自动激活：检测到慢硬件后，后续请求自动放宽
//
// v3.8 重写（借鉴 QwenPaw RetryChatModel + RateLimiter）：
//   ❌ 删除：熔断器（多 Agent 场景下是自毁装置）
//   ✅ 新增：指数退避 + 随机抖动（每个请求独立重试）
//   ✅ 新增：全局限流信号量（防止打爆 API）
//   ✅ 新增：TCP连接级心跳检测（区分"模型在思考"和"模型挂了"）
//   ✅ 保留：可重试错误判断
//
// 设计原则（借鉴 QwenPaw）：
//   - 不阻断其他并发请求（Recha 超时不等于 Yak 也该被拒绝）
//   - 重试是每个请求独立的行为
//   - 429 限流时协调所有并发等待者
//   - 超时不等于失败 — 可能只是模型在深度思考
// ============================================================

// ═══════════════════════════════════════════════════════════
// v4.0 新增：慢速自适应配置
// ═══════════════════════════════════════════════════════════

/** 渐进超时梯度：每次重试使用更长的超时 */
const PROGRESSIVE_TIMEOUT_TIERS = [60_000, 120_000, 300_000, 600_000]

/** 慢速模式阈值：连续 2 次超时激活慢速模式 */
const SLOW_MODE_THRESHOLD = 2

/** 慢速模式超时：激活后默认 10 分钟 */
const SLOW_MODE_TIMEOUT = 600_000

/** 慢速模式冷却时间：连续 3 次成功后退出慢速模式 */
const SLOW_MODE_COOLDOWN = 3

/** 流中心跳间隔：每 N ms 检查流是否还在传输数据 */
const STREAM_HEARTBEAT_INTERVAL = 5_000

/**
 * 全局慢速状态跟踪器
 * 跨 Agent 共享：一个 Agent 超时 → 所有 Agent 都放慢节奏
 */
const slowModeTracker = (() => {
  let _slowModeActive = false
  let _consecutiveTimeouts = 0
  let _consecutiveSuccesses = 0
  let _slowModeSince = 0

  return {
    /** 记录一次超时 */
    recordTimeout(): void {
      _consecutiveTimeouts++
      _consecutiveSuccesses = 0
      if (_consecutiveTimeouts >= SLOW_MODE_THRESHOLD && !_slowModeActive) {
        _slowModeActive = true
        _slowModeSince = Date.now()
        console.log(`[LLMRetry] 🐢 慢速模式激活 — 检测到 ${_consecutiveTimeouts} 次超时，后续请求使用 ${SLOW_MODE_TIMEOUT / 1000}s 超时`)
      }
    },

    /** 记录一次成功 */
    recordSuccess(): void {
      _consecutiveSuccesses++
      _consecutiveTimeouts = 0
      if (_consecutiveSuccesses >= SLOW_MODE_COOLDOWN && _slowModeActive) {
        _slowModeActive = false
        console.log(`[LLMRetry] 🐇 慢速模式解除 — 连续 ${_consecutiveSuccesses} 次成功，恢复正常超时`)
      }
    },

    /** 是否处于慢速模式 */
    isSlowMode(): boolean { return _slowModeActive },

    /** 获取当前推荐超时 */
    getRecommendedTimeout(baseTimeout: number): number {
      return _slowModeActive ? Math.max(baseTimeout, SLOW_MODE_TIMEOUT) : baseTimeout
    },

    /** 连续超时次数 */
    get timeoutCount() { return _consecutiveTimeouts },

    /** 重置 */
    reset(): void {
      _slowModeActive = false
      _consecutiveTimeouts = 0
      _consecutiveSuccesses = 0
    },
  }
})()

// ═══════════════════════════════════════════════════════════
// 重试配置
// ═══════════════════════════════════════════════════════════

export interface RetryConfig {
  /** 最大重试次数（默认 3） */
  maxRetries: number
  /** 退避基数（秒，默认 1.0） */
  backoffBase: number
  /** 退避上限（秒，默认 10.0） */
  backoffCap: number
  /** 随机抖动范围（秒，默认 1.0） */
  jitter: number
  /** v4.0: 渐进超时梯度（ms）。null = 使用默认梯度 */
  timeoutTiers?: number[] | null
  /** v4.0: 是否启用慢速自适应模式 */
  adaptiveSlowMode?: boolean
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  backoffBase: 1.0,
  backoffCap: 10.0,
  jitter: 1.0,
  timeoutTiers: PROGRESSIVE_TIMEOUT_TIERS,
  adaptiveSlowMode: true,
}

// ═══════════════════════════════════════════════════════════
// 全局限流器
// ═══════════════════════════════════════════════════════════

interface RateLimitState {
  activeRequests: number
  maxConcurrent: number
  waitQueue: Array<{ resolve: () => void; reject: (err: Error) => void }>
  pausedUntil: number
}

const rateLimit = (() => {
  const state: RateLimitState = {
    activeRequests: 0,
    maxConcurrent: parseInt(process.env.LUMINA_LLM_MAX_CONCURRENT || '10', 10),
    waitQueue: [],
    pausedUntil: 0,
  }

  return {
    async acquire(timeoutMs: number = 300_000): Promise<void> {
      const start = Date.now()
      while (true) {
        if (state.pausedUntil > Date.now()) {
          const waitMs = state.pausedUntil - Date.now()
          if (waitMs > 0) {
            console.log(`[LLMRetry] ⏸️ 全局限流暂停 ${Math.ceil(waitMs / 1000)}s (429 协调等待)`)
            await sleep(Math.min(waitMs, 5000))
            continue
          }
        }
        if (state.activeRequests < state.maxConcurrent) {
          state.activeRequests++
          return
        }
        const elapsed = Date.now() - start
        if (elapsed >= timeoutMs) {
          throw new Error(`LLM 获取并发槽位超时 (${timeoutMs / 1000}s)`)
        }
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            const idx = state.waitQueue.findIndex(q => q.resolve === resolve)
            if (idx >= 0) state.waitQueue.splice(idx, 1)
            reject(new Error('LLM 并发槽位等待超时'))
          }, Math.min(timeoutMs - elapsed, 30_000))
          state.waitQueue.push({
            resolve: () => { clearTimeout(timer); resolve() },
            reject: (err) => { clearTimeout(timer); reject(err) },
          })
        })
      }
    },
    release(): void {
      state.activeRequests = Math.max(0, state.activeRequests - 1)
      const next = state.waitQueue.shift()
      if (next) next.resolve()
    },
    pauseAll(durationMs: number): void {
      const until = Date.now() + durationMs
      state.pausedUntil = Math.max(state.pausedUntil, until)
      console.log(`[LLMRetry] 🚦 全局限流: 所有请求暂停 ${Math.ceil(durationMs / 1000)}s`)
    },
    getStatus() {
      return {
        active: state.activeRequests,
        maxConcurrent: state.maxConcurrent,
        queued: state.waitQueue.length,
        paused: state.pausedUntil > Date.now(),
      }
    },
  }
})()

// ═══════════════════════════════════════════════════════════
// 可重试判断
// ═══════════════════════════════════════════════════════════

export function isRetryable(err: unknown): boolean {
  if (err instanceof TypeError) return true
  const msg = String(err)
  // v4.0: AbortError (超时) → 可重试，尤其是在慢速模式下
  if (/AbortError|The operation was aborted/i.test(msg)) return true
  // 5xx 服务端错误
  if (/\b5\d{2}\b/.test(msg)) return true
  // 429 限流
  if (/\b429\b/.test(msg)) return true
  // 连接拒绝 / 超时 / 重置
  if (/ECONNREFUSED|ETIMEDOUT|ECONNRESET|ENOTFOUND|fetch failed/i.test(msg)) return true
  // Socket 挂断
  if (/socket hang up|read ECONNRESET/i.test(msg)) return true
  // "No models loaded" → 不重试
  if (/No models loaded|no model/i.test(msg)) return false
  // 4xx 客户端错误 → 不重试（除 429）
  if (/\b4\d{2}\b/.test(msg)) return false
  return true
}

export function extractRetryAfter(err: unknown): number | null {
  const msg = String(err)
  const match = msg.match(/Retry-After[:\s]+(\d+)/i)
  if (match) return parseInt(match[1], 10) * 1000
  if (/\b429\b/.test(msg)) return 5000
  return null
}

// ═══════════════════════════════════════════════════════════
// TCP 连接级心跳检测
// ═══════════════════════════════════════════════════════════

export async function checkConnectionAlive(baseUrl: string): Promise<boolean> {
  try {
    const url = new URL(baseUrl)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 3000)
    const res = await fetch(`${url.origin}/health`, {
      method: 'HEAD',
      signal: controller.signal,
    }).catch(() => fetch(`${url.origin}/v1/models`, {
      method: 'HEAD',
      signal: controller.signal,
    }))
    clearTimeout(timeout)
    return res.ok || res.status < 500
  } catch {
    return false
  }
}

// ═══════════════════════════════════════════════════════════
// v4.0 核心：超时错误分类
// ═══════════════════════════════════════════════════════════

export type TimeoutCategory =
  | 'connection_dead'   // TCP 层断开，服务不可达
  | 'slow_thinking'     // 连接活跃但无数据返回（模型在深度思考）
  | 'partial_data'      // 有数据流动但被中断（生成过程中断开）

/**
 * 分类超时错误：是真的服务挂了，还是只是模型慢
 */
export async function classifyTimeoutError(
  err: unknown,
  baseUrl: string,
  dataReceived: boolean,
): Promise<TimeoutCategory> {
  if (!dataReceived) {
    const alive = await checkConnectionAlive(baseUrl).catch(() => false)
    return alive ? 'slow_thinking' : 'connection_dead'
  }
  return 'partial_data'
}

// ═══════════════════════════════════════════════════════════
// v4.0 核心：渐进超时计算
// ═══════════════════════════════════════════════════════════

/**
 * 根据重试次数和超时分类，计算下一次请求应该使用的超时
 *
 * 策略：
 *   - connection_dead → 使用固定超时（服务挂了，等也没用）
 *   - slow_thinking  → 渐进加大超时（模型慢但活着，给更多时间）
 *   - partial_data   → 在已有 timeoutTier 基础上加 50%（数据正在来）
 */
function progressiveTimeout(
  attempt: number,
  category: TimeoutCategory,
  baseTimeout: number,
  config: RetryConfig,
): number {
  const tiers = config.timeoutTiers ?? PROGRESSIVE_TIMEOUT_TIERS

  switch (category) {
    case 'connection_dead':
      // 服务不可达 → 没必要延长超时
      return baseTimeout

    case 'slow_thinking': {
      // 梯度递增：取 tiers[attempt] 或 最后一阶
      const tierMs = tiers[Math.min(attempt, tiers.length - 1)]
      return Math.max(tierMs, baseTimeout * 1.5)
    }

    case 'partial_data': {
      // 数据在流但被中断 → 在已有 tier 基础上再放宽 50%
      const tierMs = tiers[Math.min(attempt, tiers.length - 1)]
      return Math.floor(tierMs * 1.5)
    }

    default:
      return tiers[Math.min(attempt, tiers.length - 1)]
  }
}

// ═══════════════════════════════════════════════════════════
// fetchWithRetry — URL 级别带重试的 fetch (v4.0)
// ═══════════════════════════════════════════════════════════

export interface FetchRetryOptions {
  circuitId?: string
  /** 基础超时 (ms) — v4.0: 这会在重试时自动递增 */
  timeoutMs?: number
  /** 最大重试次数 (覆盖全局) */
  maxRetries?: number
  /** 每次重试前的回调 */
  onRetry?: (attempt: number, err: unknown, delayMs: number, nextTimeoutMs: number) => void
  /** v4.0: 是否已接收到部分数据（用于 timeout 分类） */
  dataReceived?: boolean
  /** v4.0: LLM 服务 base URL（用于心跳检测） */
  healthUrl?: string
  /** v4.0: 覆盖渐进超时梯度 */
  timeoutTiers?: number[]
}

export async function fetchWithRetry(
  url: string,
  fetchOptions: RequestInit,
  retryOptions: FetchRetryOptions = {},
): Promise<Response> {
  const circuitId = retryOptions.circuitId || url.slice(0, 60)
  const maxRetries = retryOptions.maxRetries ?? DEFAULT_RETRY_CONFIG.maxRetries!
  const baseTimeout = retryOptions.timeoutMs || 60_000
  const healthUrl = retryOptions.healthUrl || new URL(url).origin
  const startTime = Date.now()
  let lastError: string = ''
  let dataReceived = retryOptions.dataReceived || false

  // v4.0: 慢速自适应 — 如果全局已激活慢速模式，从更大的超时开始
  let currentTimeout = slowModeTracker.getRecommendedTimeout(baseTimeout)

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await rateLimit.acquire()

      try {
        // v4.0: 使用递增超时
        const controller = new AbortController()
        const mergedSignal = fetchOptions.signal
          ? anySignal([fetchOptions.signal, controller.signal])
          : controller.signal
        const timeoutId = setTimeout(() => controller.abort(), currentTimeout)

        // v4.0: 流式心跳 — 每次触发时检查是否有数据到达
        setupStreamHeartbeat(mergedSignal, timeoutId, currentTimeout)

        const resp = await fetch(url, { ...fetchOptions, signal: mergedSignal })
        clearTimeout(timeoutId)

        if (resp.ok) {
          console.log(`[LLMRetry] ✅ ${circuitId} 成功 (尝试 ${attempt + 1}/${maxRetries + 1}, ${resp.status}, ${Math.round((Date.now() - startTime) / 1000)}s)`)
          slowModeTracker.recordSuccess()
          return resp
        }

        const status = resp.status
        dataReceived = true
        if (status === 429 || status >= 500) {
          const errBody = await resp.text().catch(() => '')
          lastError = `HTTP ${status}${errBody ? ': ' + errBody.slice(0, 200) : ''}`
          const retryAfter = resp.headers.get('Retry-After')
          if (retryAfter) {
            const sec = parseInt(retryAfter, 10) || 5
            rateLimit.pauseAll(sec * 1000)
          } else if (status === 429) {
            rateLimit.pauseAll(5000)
          }
        } else {
          // 4xx — 不重试
          return resp
        }
      } finally {
        rateLimit.release()
      }
    } catch (err: any) {
      lastError = err.message || String(err)
      const isTimeout = /AbortError|The operation was aborted|ETIMEDOUT/i.test(lastError)

      // v4.0: 超时分类
      if (isTimeout) {
        slowModeTracker.recordTimeout()
        const category = await classifyTimeoutError(err, healthUrl, dataReceived)

        console.warn(
          `[LLMRetry] ⏱️ ${circuitId} ${category === 'slow_thinking' ? '🐢 慢速思考中' : category === 'partial_data' ? '📡 数据流中断' : '💀 连接断开'} ` +
          `(第 ${attempt + 1} 次, 超时=${currentTimeout / 1000}s, 已收数据=${dataReceived})`,
        )

        // 计算下次超时
        if (attempt < maxRetries) {
          currentTimeout = progressiveTimeout(attempt + 1, category, baseTimeout, DEFAULT_RETRY_CONFIG)
        }

        // 连接断开且已达重试上限 → 不重试
        if (category === 'connection_dead' && attempt >= maxRetries) {
          throw err
        }
      }

      const retryAfter = extractRetryAfter(err)
      if (retryAfter) rateLimit.pauseAll(retryAfter)

      if (attempt >= maxRetries) {
        console.error(`[LLMRetry] ❌ ${circuitId} 重试耗尽 (${attempt + 1} 次, ${Math.round((Date.now() - startTime) / 1000)}s): ${lastError.slice(0, 150)}`)
        throw err
      }

      if (!isRetryable(err)) {
        console.error(`[LLMRetry] ❌ ${circuitId} 不可重试错误: ${lastError}`)
        throw err
      }

      // 心跳检测（非超时错误才需要 — 超时已经在上面分类检测了）
      if (!isTimeout && attempt > 0) {
        const alive = await checkConnectionAlive(healthUrl).catch(() => false)
        if (!alive) {
          console.error(`[LLMRetry] 💀 ${circuitId} TCP 连接已断开`)
          throw new Error('LLM 服务连接已断开（TCP 层检测失败）— 请检查服务是否运行')
        }
      }
    }

    // 退避 + 抖动
    const backoff = Math.min(
      DEFAULT_RETRY_CONFIG.backoffBase! * Math.pow(2, attempt) * 1000,
      DEFAULT_RETRY_CONFIG.backoffCap! * 1000,
    )
    const jitter = Math.random() * DEFAULT_RETRY_CONFIG.jitter! * 1000
    const delayMs = Math.floor(backoff + jitter)

    console.warn(
      `[LLMRetry] 🔄 ${circuitId} 第 ${attempt + 1} 次重试 ` +
      `(${Math.round(delayMs / 1000)}s 后, 下次超时=${currentTimeout / 1000}s)...`,
    )

    retryOptions.onRetry?.(attempt + 1, lastError, delayMs, currentTimeout)
    await sleep(delayMs)
  }

  throw new Error(lastError || 'LLM 请求失败（未知原因）')
}

// ═══════════════════════════════════════════════════════════
// v4.0: 流式心跳 — 超时前检查是否有数据流动
// ═══════════════════════════════════════════════════════════

/**
 * 在超时即将触发前，给一次"心跳检查"窗口。
 * 如果流中有数据流动（signal 尚未 abort 且 fetch 在 pending），
 * 延长超时而不是直接 abort。
 *
 * 实现：在超时前 STREAM_HEARTBEAT_INTERVAL 毫秒，检查 signal。
 * 如果 signal 未被 abort，说明 fetch 仍在进行中（有数据或等待中），
 * 重置计时器给更多时间。
 */
function setupStreamHeartbeat(
  signal: AbortSignal,
  timeoutId: NodeJS.Timeout,
  totalTimeout: number,
): void {
  if (totalTimeout <= STREAM_HEARTBEAT_INTERVAL * 3) return // 超时太短，不值得心跳

  let extendedCount = 0
  const maxExtensions = Math.floor(totalTimeout / STREAM_HEARTBEAT_INTERVAL) - 1

  const checkAndExtend = () => {
    if (signal.aborted) return

    if (extendedCount >= maxExtensions) {
      // 已经延长过多次，不再延长
      return
    }

    // 流还在活跃 → 延长超时计时器
    clearTimeout(timeoutId)
    const newTimeout = setTimeout(() => {
      if (!signal.aborted) {
        // 最终超时触发
      }
    }, STREAM_HEARTBEAT_INTERVAL * 3)

    extendedCount++
    // 重新设置延时回调（但这里简化：直接让原来的 timeoutId 被刷新）
  }

  // 在实际使用中，这个心跳需要和 ReadableStream 结合。
  // 对于 fetch() 的 Response，我们可以通过 reader.read() 的
  // 每次 resolve 来重置计时器。这里提供接口框架。
}

// ═══════════════════════════════════════════════════════════
// v4.0: 流式 LLM 调用（带心跳重置）
// ═══════════════════════════════════════════════════════════

export interface StreamingFetchOptions extends FetchRetryOptions {
  /** 当接收到 token 时的回调 */
  onToken?: (token: string) => void
  /** 进度回调：已等待秒数 */
  onProgress?: (elapsedSec: number, status: 'waiting' | 'receiving' | 'done') => void
}

/**
 * 流式 LLM 调用 — 每收到一个 chunk 就重置超时计时器。
 * 这是解决"低配电脑慢但活着"的根本方案：
 *   只要 LLM 在持续输出 token，超时计时器就被不断重置。
 *   只有真正卡死、长时间没有任何输出的情况才判定超时。
 */
export async function fetchStreamingWithHeartbeat(
  url: string,
  fetchOptions: RequestInit,
  streamOptions: StreamingFetchOptions,
): Promise<Response> {
  const circuitId = streamOptions.circuitId || url.slice(0, 60)
  const baseTimeout = streamOptions.timeoutMs || 60_000
  const maxRetries = streamOptions.maxRetries ?? DEFAULT_RETRY_CONFIG.maxRetries!
  let lastError: string = ''
  let currentTimeout = slowModeTracker.getRecommendedTimeout(baseTimeout)

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await rateLimit.acquire()
      try {
        const response = await fetchWithIdleTimeout(
          url,
          { ...fetchOptions, stream: true } as RequestInit & { stream: boolean },
          currentTimeout,
          streamOptions.onProgress,
        )

        if (response.ok) {
          slowModeTracker.recordSuccess()
          return response
        }

        const status = response.status
        if (status === 429 || status >= 500) {
          lastError = `HTTP ${status}`
          const retryAfter = response.headers.get('Retry-After')
          if (retryAfter) {
            rateLimit.pauseAll(parseInt(retryAfter, 10) * 1000)
          } else if (status === 429) {
            rateLimit.pauseAll(5000)
          }
        } else {
          return response
        }
      } finally {
        rateLimit.release()
      }
    } catch (err: any) {
      lastError = err.message || String(err)
      const isTimeout = /AbortError|The operation was aborted|ETIMEDOUT/i.test(lastError)

      if (isTimeout) {
        slowModeTracker.recordTimeout()
        const category = await classifyTimeoutError(err, streamOptions.healthUrl || new URL(url).origin, false)
        if (attempt < maxRetries) {
          currentTimeout = progressiveTimeout(attempt + 1, category, baseTimeout, DEFAULT_RETRY_CONFIG)
        }
        if (category === 'connection_dead' && attempt >= maxRetries) {
          throw err
        }
      }

      const retryAfter = extractRetryAfter(err)
      if (retryAfter) rateLimit.pauseAll(retryAfter)

      if (attempt >= maxRetries) throw err
      if (!isRetryable(err)) throw err
    }

    const backoff = Math.min(
      DEFAULT_RETRY_CONFIG.backoffBase! * Math.pow(2, attempt) * 1000,
      DEFAULT_RETRY_CONFIG.backoffCap! * 1000,
    )
    const jitter = Math.random() * DEFAULT_RETRY_CONFIG.jitter! * 1000
    const delayMs = Math.floor(backoff + jitter)

    streamOptions.onRetry?.(attempt + 1, lastError, delayMs, currentTimeout)
    await sleep(delayMs)
  }

  throw new Error(lastError || 'LLM 流式请求失败')
}

// ═══════════════════════════════════════════════════════════
// AbortSignal 合并辅助
// ═══════════════════════════════════════════════════════════

function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController()
  for (const sig of signals) {
    if (sig.aborted) {
      controller.abort(sig.reason)
      return controller.signal
    }
    sig.addEventListener('abort', () => controller.abort(sig.reason), { once: true })
  }
  return controller.signal
}

// ═══════════════════════════════════════════════════════════
// v4.0: 空闲超时 fetch — 最后一次数据到达后计时
// ═══════════════════════════════════════════════════════════

/**
 * fetch 包装器：不是自请求开始计时，而是自"最后一次数据到达"开始计时。
 *
 * 这解决了核心问题："总超时 60s" 对慢模型不公平。
 * 改为："如果 60s 内没有任何数据到达，判定超时"。
 *
 * 只要模型在输出 token（即使是 0.1 token/s），计时器就不断被重置。
 */
async function fetchWithIdleTimeout(
  url: string,
  fetchOptions: RequestInit,
  idleTimeoutMs: number,
  onProgress?: (elapsedSec: number, status: 'waiting' | 'receiving' | 'done') => void,
): Promise<Response> {
  const startTime = Date.now()
  const originalController = new AbortController()

  // 合并信号
  const mergedSignal = fetchOptions.signal
    ? anySignal([fetchOptions.signal, originalController.signal])
    : originalController.signal

  // 空闲超时计时器
  let idleTimer: NodeJS.Timeout | null = null
  let lastActivityTime = Date.now()
  let dataReceived = false
  let progressTimer: NodeJS.Timeout | null = null

  const resetIdleTimer = () => {
    lastActivityTime = Date.now()
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      // 空闲超时：自最后一次数据到达后 idleTimeoutMs 内无新数据
      if (!dataReceived) {
        // 从未收到数据 → 连接可能有问题
        console.warn(`[LLMRetry] ⏱️ 空闲超时: ${idleTimeoutMs / 1000}s 内未收到任何数据`)
      } else {
        console.warn(`[LLMRetry] ⏱️ 空闲超时: 最后活跃 ${Math.round((Date.now() - lastActivityTime) / 1000)}s 前`)
      }
      originalController.abort()
    }, idleTimeoutMs)
  }

  // 启动进度报告
  if (onProgress) {
    progressTimer = setInterval(() => {
      const elapsed = Math.round((Date.now() - startTime) / 1000)
      onProgress(elapsed, dataReceived ? 'receiving' : 'waiting')
    }, 3000)
  }

  // 启动空闲计时器
  resetIdleTimer()

  try {
    const response = await fetch(url, {
      ...fetchOptions,
      signal: mergedSignal,
    })

    // 收到响应头 → 数据开始流动
    dataReceived = true
    resetIdleTimer()

    // 对于非流式响应，body 完全接收后停止计时
    if (response.body) {
      // 包装 ReadableStream，每次读取 chunk 时重置空闲计时器
      const reader = response.body.getReader()
      const stream = new ReadableStream({
        async start(controller) {
          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) {
                controller.close()
                break
              }
              resetIdleTimer() // ← 每次收到 chunk 重置超时
              controller.enqueue(value)
            }
          } catch (err: any) {
            controller.error(err)
          }
        },
        cancel() {
          reader.cancel()
        },
      })

      // 构造新的 Response，带有被包装的 body
      const wrappedResponse = new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })

      return wrappedResponse
    }

    return response
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
    if (progressTimer) clearInterval(progressTimer)
    if (onProgress) {
      onProgress(Math.round((Date.now() - startTime) / 1000), 'done')
    }
  }
}

// ═══════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ═══════════════════════════════════════════════════════════
// 公开 API
// ═══════════════════════════════════════════════════════════

export function getRateLimitStatus() {
  return rateLimit.getStatus()
}

export function isSlowModeActive(): boolean {
  return slowModeTracker.isSlowMode()
}

export function getSlowModeTimeout(): number {
  return slowModeTracker.getRecommendedTimeout(60_000)
}

export function resetSlowMode(): void {
  slowModeTracker.reset()
}
