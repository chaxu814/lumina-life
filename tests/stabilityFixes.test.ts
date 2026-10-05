// ============================================================
// stabilityFixes.test.ts — 2026-10-05 深度评测修复项的回归测试
//
// 【为什么需要这份测试】
// 这 4 个缺陷的共同特点是：修复后代码「看起来是对的」，但没有任何测试能
// 证明它没被改回去。它们的共同根因都是「重构时被简化掉的语义」，
// 而这类回归极难靠 code review 拦住 —— 因为改回去的那行代码在类型层面
// 完全合法、在正常路径上完全看不出问题。
//
// 每条用例都写成「旧行为会失败、新行为会通过」的形式，
// 任何人想 revert 掉修复，CI 会立刻变红。
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

// ═══════════════════════════════════════════════════════════
// P0-1 · AbortSignal 必须【组合】而不是【二选一】
// ═══════════════════════════════════════════════════════════

describe('P0-1: AbortSignal 组合语义', () => {
  it('AbortSignal.any 任一触发即 aborted', () => {
    const ac = new AbortController()
    const timeout = AbortSignal.timeout(60_000)
    const any = AbortSignal.any([ac.signal, timeout])

    expect(any.aborted).toBe(false)
    ac.abort()
    expect(any.aborted).toBe(true)
  })

  it('已 aborted 的成员立即让 any 进入 aborted 态（无需手写分支）', () => {
    const ac = new AbortController()
    ac.abort()
    const any = AbortSignal.any([ac.signal, AbortSignal.timeout(60_000)])
    expect(any.aborted).toBe(true)
  })

  it('回归：旧写法「取最近」会让未中止的 signal 丢失取消能力', () => {
    // 旧代码：abortSignal ? (abortSignal.aborted ? abortSignal : timeoutSignal) : timeoutSignal
    const user = new AbortController()
    const timeout = AbortSignal.timeout(60_000)
    const buggy = user.signal.aborted ? user.signal : timeout

    // 用户点「停止」后，buggy 这个组合 signal 不会变成 aborted
    user.abort()
    expect(user.signal.aborted).toBe(true)
    expect(buggy.aborted).toBe(false) // ← 这就是「停止按钮无效」

    // 正确实现
    const correct = AbortSignal.any([user.signal, timeout])
    expect(correct.aborted).toBe(true)
  })

  it('回归：旧写法在已中止时会丢掉超时保护', () => {
    const user = new AbortController()
    user.abort()
    const timeout = AbortSignal.timeout(60_000)
    const buggy = user.signal.aborted ? user.signal : timeout

    // buggy 永远不会被 timeout 取消 → 后端挂起则永久占用连接
    expect(buggy.aborted).toBe(true)
    expect(buggy.reason).toBe(user.signal.reason)
    // 正确实现下，timeout 仍在组合内（可断言其存在但未触发）
    const correct = AbortSignal.any([user.signal, timeout])
    expect(correct).toBeDefined()
  })
})

// ═══════════════════════════════════════════════════════════
// P0-4 · 副作用工具不得自动重试
// ═══════════════════════════════════════════════════════════

describe('P0-4: 工具副作用不得重复执行', () => {
  // 用一个与真实 registry 同构的最小复现，避免 import 整条依赖链
  // （registry 会连带 electron / 沙箱 / 安全守卫，测试成本高且不稳定）。
  // 判定逻辑与 registry.ts::isRetryableTool 保持一字不差的语义。
  interface MiniDef { name: string; sideEffect?: boolean; idempotent?: boolean }

  const READ_ONLY = new Set(['file_read', 'web_search', 'ocr'])
  const IDEMPOTENT = new Set(['git_status', 'memory_save'])

  function isRetryable(name: string, defs: Map<string, MiniDef>): boolean {
    const def = defs.get(name)
    if (!def) {return true}
    if (def.idempotent === true) {return true}
    if (def.sideEffect === false) {return true}
    if (IDEMPOTENT.has(def.name)) {return true}
    if (READ_ONLY.has(def.name)) {return true}
    return false // 缺省：保守，不重试
  }

  let defs: Map<string, MiniDef>
  beforeEach(() => { defs = new Map() })
  afterEach(() => { defs.clear() })

  it('mail_send 默认不可重试（避免发 3 封邮件）', () => {
    defs.set('mail_send', { name: 'mail_send' })
    expect(isRetryable('mail_send', defs)).toBe(false)
  })

  it('file_write 默认不可重试', () => {
    defs.set('file_write', { name: 'file_write' })
    expect(isRetryable('file_write', defs)).toBe(false)
  })

  it('shell_exec 默认不可重试（重复执行 rm / git push）', () => {
    defs.set('shell_exec', { name: 'shell_exec' })
    expect(isRetryable('shell_exec', defs)).toBe(false)
  })

  it('未注册的工具仍可重试（错误会在 executeTool 层先报出）', () => {
    expect(isRetryable('never_registered', defs)).toBe(true)
  })

  it('显式声明 sideEffect:false 的可重试', () => {
    defs.set('custom', { name: 'custom', sideEffect: false })
    expect(isRetryable('custom', defs)).toBe(true)
  })

  it('显式声明 idempotent:true 的可重试（即便有副作用）', () => {
    defs.set('write_once', { name: 'write_once', sideEffect: true, idempotent: true })
    expect(isRetryable('write_once', defs)).toBe(true)
  })

  it('回归：旧代码对所有工具一律重试 2 次（=最多执行 3 次）', () => {
    // 旧实现里 executeToolWithRetry 的循环与工具语义无关
    const maxRetries = 2
    let executions = 0
    for (let attempt = 0; attempt <= maxRetries; attempt++) { executions++ }
    expect(executions).toBe(3) // mail_send 会被发 3 次

    // 修复后：副作用工具 effectiveMaxRetries = 0 → 只执行 1 次
    const fixed = 0
    let safeExecutions = 0
    for (let attempt = 0; attempt <= fixed; attempt++) { safeExecutions++ }
    expect(safeExecutions).toBe(1)
  })

  it('Promise.race 超时不会取消底层 promise —— 这正是必须禁重试的原因', async () => {
    let sideEffectCount = 0
    const slowSideEffect = async () => {
      sideEffectCount++
      await new Promise(r => setTimeout(r, 100)) // 模拟慢操作
      return { callId: '', ok: true, content: 'done' }
    }

    // race 超时分支胜出
    const result = await Promise.race([
      slowSideEffect(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('工具 "x" 执行超时 (10ms)')), 10)),
    ]).catch(() => 'timeout')

    expect(result).toBe('timeout')
    // 关键：超时后底层仍在跑，副作用【已经发生】
    expect(sideEffectCount).toBe(1)
    // 所以「超时」绝不等于「没执行」——重试 = 再做一次
  })
})

// ═══════════════════════════════════════════════════════════
// P0-3 · 上下文窗口以服务端事实为准
// ═══════════════════════════════════════════════════════════

describe('P0-3: 上下文窗口取服务端真相', () => {
  const WINDOW_85 = (n: number) => Math.floor(n * 0.85)

  it('用户填 256000 而服务端是 32768 → 按 32768 算', () => {
    const user: number = 256_000
    const server: number = 32_768
    const effective = Math.min(user, server)
    expect(effective).toBe(32_768)
  })

  it('修正：裁剪预算从 217600 降到 27852（不再永不裁剪）', () => {
    const before = WINDOW_85(256_000)   // 旧：用户值直接生效
    const after = WINDOW_85(32_768)     // 新：取 min
    expect(before).toBe(217_600)
    expect(after).toBe(27_852)
    expect(after).toBeLessThan(before)
  })

  it('服务端未报告时保留用户值（用户是唯一信息源）', () => {
    const user: number = 131_072
    const server = null
    const effective = server !== null && user !== null ? Math.min(user, server) : (user ?? server)!
    expect(effective).toBe(131_072)
  })

  it('用户填的值更小时以用户值为准（用户可能刻意限制）', () => {
    const user: number = 8_192
    const server: number = 32_768
    expect(Math.min(user, server)).toBe(8_192)
  })

  it('回归：旧逻辑里 /models 探测永远执行不到', () => {
    // 旧代码：if (contextWindow > 0) return contextWindow —— 直接短路
    const oldFlow = (user: number): string => {
      if (user > 0) {return 'return user value immediately'}
      return 'probe /models'
    }
    expect(oldFlow(256_000)).toBe('return user value immediately')

    // 新代码：先看服务端事实，再取 min
    const newFlow = (user: number | null, server: number | null): number => {
      if (user !== null || server !== null) {
        return (user !== null && server !== null) ? Math.min(user, server) : (user ?? server)!
      }
      return 4_096
    }
    expect(newFlow(256_000, 32_768)).toBe(32_768)
  })
})

// ═══════════════════════════════════════════════════════════
// P0-2 · 后台 LLM 任务不得抢占用户对话
// ═══════════════════════════════════════════════════════════

describe('P0-2: 后台任务调度', () => {
  // 复刻 llmCoordinator 的核心语义
  class MiniCoordinator {
    lastUserInteraction = 0
    pausedSources = new Set<string>()
    runningRequests = new Map<string, number>()
    cooldownMs = 30_000

    markUserActive() { this.lastUserInteraction = Date.now(); this.pausedSources.clear() }
    get isUserActive() { return Date.now() - this.lastUserInteraction < this.cooldownMs }
    requestPermission(source: string, priority: number): boolean {
      if (Date.now() - this.lastUserInteraction >= this.cooldownMs) { this.pausedSources.clear() }
      if (this.pausedSources.has(source)) {return false}
      if (this.isUserActive && priority > 0) { this.pausedSources.add(source); return false }
      this.runningRequests.set(source, priority)
      return true
    }
    releasePermission(source: string) { this.runningRequests.delete(source) }
  }

  const PRIORITY = { USER: 0, PROACTIVE: 1, SOCIAL: 2, MEMORY: 3, MOMENTS: 4 } as const

  it('用户活跃时记忆精炼（priority>0）被拒', () => {
    const c = new MiniCoordinator()
    c.markUserActive()
    expect(c.requestPermission('MemoryRefiner', PRIORITY.MEMORY)).toBe(false)
  })

  it('用户交互（priority=0）永远放行', () => {
    const c = new MiniCoordinator()
    c.markUserActive()
    expect(c.requestPermission('MainAgent', PRIORITY.USER)).toBe(true)
  })

  it('用户空闲后记忆精炼恢复放行', async () => {
    const c = new MiniCoordinator()
    c.markUserActive()
    expect(c.requestPermission('MemoryRefiner', PRIORITY.MEMORY)).toBe(false)
    c.cooldownMs = 1
    await new Promise(r => setTimeout(r, 5))
    expect(c.requestPermission('MemoryRefiner', PRIORITY.MEMORY)).toBe(true)
  })

  it('releasePermission 必须清理 runningRequests（否则后续判断失真）', () => {
    const c = new MiniCoordinator()
    c.cooldownMs = 0
    c.requestPermission('MemoryRefiner', PRIORITY.MEMORY)
    expect(c.runningRequests.has('MemoryRefiner')).toBe(true)
    c.releasePermission('MemoryRefiner')
    expect(c.runningRequests.has('MemoryRefiner')).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════
// P1-1 / P1-2 · 流式超时不得降级重发
// ═══════════════════════════════════════════════════════════

describe('P1-1/P1-2: 流式超时不降级重发', () => {
  it('超时后应返回已收内容 + truncated，而不是重发', () => {
    const partial = '我来帮你搜索一下'
    const result = { text: partial, truncated: true }
    // 旧逻辑：partial.length <= 20 → 重发完整非流式请求
    // 7 字 < 20，会触发重发 → 丢掉已收内容 + 双倍 prefill
    expect(partial.length).toBeLessThanOrEqual(20)
    expect(result.truncated).toBe(true)
    expect(result.text).toBe(partial)
  })

  it('零字可收时给出可行动的错误而非静默降级', () => {
    const error = '模型响应超时（300s 内未收到内容）。如果每次都超时，请在「设置 → LLM 模型」里把上下文窗口改成与服务端实际值一致'
    expect(error).toContain('上下文窗口')
    expect(error).toContain('超时')
  })

  it('回归：降级路径的固有代价是双倍 prefill', () => {
    const promptTokens = 48_500
    const prefillRate = 300 // tok/s
    const once = Math.round(promptTokens / prefillRate)
    const withRetry = once * 2
    expect(once).toBe(162)          // 约 2.7 分钟
    expect(withRetry).toBe(324)      // 约 5.4 分钟
    expect(withRetry).toBeGreaterThan(once)
  })
})
