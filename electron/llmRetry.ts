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
            if (idx >= 0) {state.waitQueue.splice(idx, 1)}
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
      if (next) {next.resolve()}
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
  if (err instanceof TypeError) {return true}
  const msg = String(err)
  // v4.0: AbortError (超时) → 可重试，尤其是在慢速模式下
  if (/AbortError|The operation was aborted/i.test(msg)) {return true}
  // 5xx 服务端错误
  if (/\b5\d{2}\b/.test(msg)) {return true}
  // 429 限流
  if (/\b429\b/.test(msg)) {return true}
  // 连接拒绝 / 超时 / 重置
  if (/ECONNREFUSED|ETIMEDOUT|ECONNRESET|ENOTFOUND|fetch failed/i.test(msg)) {return true}
  // Socket 挂断
  if (/socket hang up|read ECONNRESET/i.test(msg)) {return true}
  // "No models loaded" → 不重试
  if (/No models loaded|no model/i.test(msg)) {return false}
  // 4xx 客户端错误 → 不重试（除 429）
  if (/\b4\d{2}\b/.test(msg)) {return false}
  return true
}

export function extractRetryAfter(err: unknown): number | null {
  const msg = String(err)
  const match = msg.match(/Retry-After[:\s]+(\d+)/i)
  if (match) {return parseInt(match[1], 10) * 1000}
  if (/\b429\b/.test(msg)) {return 5000}
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

        // 🔧 2026-10-10：这里原来调用了 `setupStreamHeartbeat(...)`，
        //   但它是个**空桩**（函数体只定义了从未被调用的 checkAndExtend，
        //   末尾自述「这里提供接口框架」），实际不做任何事 —— 属于「看着有心跳、其实没有」。
        //   已删除该调用与整套空桩实现（见文件顶部说明）。超时按上面的
        //   `setTimeout(() => controller.abort(), currentTimeout)` 正常生效。

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
      if (retryAfter) {rateLimit.pauseAll(retryAfter)}

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
// ⚠️ 关于「流式心跳」的说明（2026-10-10 审计后清理）
//
// 这里原本有一组 v4.0 宣称的「流式心跳 / 空闲超时」实现
// （setupStreamHeartbeat / fetchStreamingWithHeartbeat / fetchWithIdleTimeout），
// 但审计发现：
//   · `setupStreamHeartbeat` 的函数体自述「这里提供接口框架」—— 是个**空桩**，
//     不会延长任何超时；
//   · `fetchStreamingWithHeartbeat` / `fetchWithIdleTimeout` **全项目零调用**
//     （只有本文件内部互相引用）。
// 也就是说「聊天级流式心跳」从未生效，属于「文档宣称 > 实现」。
//
// 实际生效的超时机制在 electron/agentRunner.ts 的 callLLM：
//   AbortSignal.any([用户中止信号, AbortSignal.timeout(总超时)])
//   —— 总超时到点即取消（社交模式 12h / 普通 300–600s），不做空闲重置。
//
// 本文件保留真正被使用的部分：fetchWithRetry（IPC 连接测试用）、
// 错误分类、速率限制与慢速模式状态。
// 若将来要做「按空闲重置」的流式超时，请**新增实现并真正接进 callLLM**，
// 而不是恢复这套空桩 —— 否则又会变成「有代码、没效果」。
// ═══════════════════════════════════════════════════════════

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
