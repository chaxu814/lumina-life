// ============================================================
// agentPool.ts — 🏊 Agent 常驻池 (v16.0-fix)
//
// 让 AgentRunner 实例不再每轮对话销毁，而是：
//   1. 池化管理（LRU 淘汰、池大小限制）
//   2. 空闲检测（超时后压缩上下文进入低内存模式）
//   3. 心跳保活（防 GC）
//   4. 主动事件路由（ProactiveEngine → 常驻 Agent）
// ============================================================

import type { AgentRunner } from './agentRunner'
import { getOrchestrator } from './core/agentOrchestrator'
import { globalEventBus, BusEvents } from './eventBus'

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

export interface PooledAgentInfo {
  id: string
  idleMs: number
  turnCount: number
  totalTokens: number
  lastUsed: number
  createdAt: number
  isIdle: boolean
  idleCompressed: boolean
  personaId: string
}

export interface AgentPoolConfig {
  /** 池大小上限（默认 10，0 = 不限制） */
  maxSize: number
  /** 空闲超时（毫秒），超过此时间未使用则压缩上下文（默认 15min） */
  idleTimeoutMs: number
  /** 是否启用心跳保活（默认 true） */
  keepaliveEnabled: boolean
  /** 心跳间隔（毫秒，默认 30s） */
  keepaliveIntervalMs: number
  /** 空闲压缩后是否允许完全驱逐（默认 false，压缩后保留但不占用推理资源） */
  evictOnIdle: boolean
  /** 哪些 agent 启用常驻（默认所有） */
  persistentAgents: string[]
}

export const DEFAULT_POOL_CONFIG: AgentPoolConfig = {
  maxSize: 10,
  idleTimeoutMs: 15 * 60 * 1000,   // 15min
  keepaliveEnabled: true,
  keepaliveIntervalMs: 30 * 1000,   // 30s
  evictOnIdle: false,
  persistentAgents: ['yak', 'recha', 'lumina'],
}

// ═══════════════════════════════════════════════════════════
// AgentPool
// ═══════════════════════════════════════════════════════════

export class AgentPool {
  private config: AgentPoolConfig
  private lastUsed: Map<string, number> = new Map()
  private idleCompressed: Set<string> = new Set()
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null
  private idleCheckTimer: ReturnType<typeof setInterval> | null = null
  private _started = false

  constructor(config?: Partial<AgentPoolConfig>) {
    this.config = { ...DEFAULT_POOL_CONFIG, ...config }
  }

  // ── 生命周期 ───────────────────────────────────────

  /** 启动池管理（心跳 + 空闲检测 + 事件监听） */
  start(): void {
    if (this._started) return
    this._started = true

    // 心跳保活
    if (this.config.keepaliveEnabled) {
      this.keepaliveTimer = setInterval(() => this._heartbeat(), this.config.keepaliveIntervalMs)
    }

    // 空闲检测
    this.idleCheckTimer = setInterval(() => this._checkIdle(), 60_000) // 每分钟检查

    // 监听主动事件
    this._listenProactive()

    console.log(`[AgentPool] 🏊 已启动（max=${this.config.maxSize} idle=${this.config.idleTimeoutMs}ms heartbeat=${this.config.keepaliveIntervalMs}ms）`)
  }

  /** 停止池管理 */
  stop(): void {
    this._started = false
    if (this.keepaliveTimer) { clearInterval(this.keepaliveTimer); this.keepaliveTimer = null }
    if (this.idleCheckTimer) { clearInterval(this.idleCheckTimer); this.idleCheckTimer = null }
    console.log('[AgentPool] 🏊 已停止')
  }

  /** 更新配置 */
  updateConfig(patch: Partial<AgentPoolConfig>): void {
    const oldKeepalive = this.config.keepaliveEnabled
    const oldInterval = this.config.keepaliveIntervalMs
    Object.assign(this.config, patch)

    // 如果心跳配置变了，重启
    if (oldKeepalive !== this.config.keepaliveEnabled || oldInterval !== this.config.keepaliveIntervalMs) {
      if (this.keepaliveTimer) { clearInterval(this.keepaliveTimer); this.keepaliveTimer = null }
      if (this.config.keepaliveEnabled) {
        this.keepaliveTimer = setInterval(() => this._heartbeat(), this.config.keepaliveIntervalMs)
      }
    }
  }

  /** 获取当前配置 */
  getConfig(): AgentPoolConfig {
    return { ...this.config }
  }

  // ── 核心 API ──────────────────────────────────────

  /** 获取 Agent（更新 lastUsed） */
  getRunner(id: string): AgentRunner | undefined {
    const runner = getOrchestrator().getRunner(id)
    if (runner) {
      this.lastUsed.set(id, Date.now())
      this.idleCompressed.delete(id)
    }
    return runner
  }

  /** 注册 Agent（自动加入池管理） */
  registerRunner(id: string, runner: AgentRunner): void {
    getOrchestrator().registerRunner(id, runner)
    this.lastUsed.set(id, Date.now())
    console.log(`[AgentPool] ✅ ${id} 已注册到池`)
  }

  /** 标记 Agent 正在使用（由外部调用者通知） */
  markUsed(id: string): void {
    this.lastUsed.set(id, Date.now())
    this.idleCompressed.delete(id)
  }

  /** 获取池状态 */
  getStatus(): PooledAgentInfo[] {
    const now = Date.now()
    const result: PooledAgentInfo[] = []
    const runners = getOrchestrator().listRunners()

    for (const { id, runner } of runners) {
      const lastUsed = this.lastUsed.get(id) || 0
      const idleMs = now - lastUsed
      result.push({
        id,
        idleMs,
        turnCount: (runner as any).turnCount ?? 0,
        totalTokens: (runner as any).totalTokens ?? 0,
        lastUsed,
        createdAt: lastUsed, // 近似
        isIdle: idleMs > this.config.idleTimeoutMs,
        idleCompressed: this.idleCompressed.has(id),
        personaId: (runner as any).config?.personaId || id,
      })
    }

    return result.sort((a, b) => b.lastUsed - a.lastUsed) // 最近使用在前
  }

  /** 手动压缩指定 Agent */
  async compress(id: string): Promise<boolean> {
    const runner = getOrchestrator().getRunner(id)
    if (!runner) return false

    try {
      if (typeof (runner as any).compactContext === 'function') {
        ;(runner as any).compactContext()
        this.idleCompressed.add(id)
        console.log(`[AgentPool] 🗜️ ${id} 上下文已压缩`)
        return true
      }
    } catch (err) {
      console.warn(`[AgentPool] ⚠️ ${id} 压缩失败:`, err)
    }
    return false
  }

  // ── 内部方法 ──────────────────────────────────────

  /** 心跳保活 — 遍历池中所有 Runner 维持引用 + 检查状态 */
  private _heartbeat(): void {
    if (!this._started) return
    const runners = getOrchestrator().listRunners()
    for (const { id, runner } of runners) {
      // 只保活 persistentAgents 列表中的
      if (!this.config.persistentAgents.includes(id)) continue

      try {
        // 心跳只维持强引用 + 检查 runner 是否可响应
        //   AgentRunner 没有 public healthCheck，通过访问轻量属性保活
        const turnCount = (runner as any).turnCount
        if (typeof turnCount !== 'number') {
          console.warn(`[AgentPool] ⚠️ ${id} 心跳异常：turnCount 不可读`)
        }
      } catch {
        // 静默
      }
    }
  }

  /** 空闲检测 — 超过超时的 Runner 自动压缩 */
  private _checkIdle(): void {
    if (!this._started) return
    const now = Date.now()
    const runners = getOrchestrator().listRunners()

    for (const { id } of runners) {
      // 只处理 persistentAgents 列表中的
      if (!this.config.persistentAgents.includes(id)) continue

      const lastUsed = this.lastUsed.get(id) || 0
      const idleMs = now - lastUsed

      if (idleMs > this.config.idleTimeoutMs && !this.idleCompressed.has(id)) {
        // 空闲超时 → 压缩上下文
        console.log(`[AgentPool] 🕐 ${id} 空闲 ${(idleMs / 1000 / 60).toFixed(0)}min，开始压缩`)
        this.compress(id).catch(() => {})

        // 如果配置了可驱逐，释放 Runner
        if (this.config.evictOnIdle) {
          const runner = getOrchestrator().getRunner(id)
          if (runner) {
            try { (runner as any).destroy?.() } catch {}
          }
          console.log(`[AgentPool] 🗑️ ${id} 已驱逐（空闲超时）`)
          this.idleCompressed.delete(id)
          this.lastUsed.delete(id)
        }
      }
    }
  }

  /** 监听主动事件 → 路由到常驻 Agent */
  private _listenProactive(): void {
    // ProactiveEngine 触发
    globalEventBus.on(BusEvents.PROACTIVE_TRIGGER, async (data: any) => {
      const message = typeof data === 'string' ? data : data?.message || ''
      const targetId = data?.targetId || 'lumina'
      if (!message) return

      const runner = this.getRunner(targetId)
      if (!runner) {
        console.log(`[AgentPool] ⏭️ 主动事件跳过：${targetId} 不在池中`)
        return
      }

      try {
        console.log(`[AgentPool] 🔔 主动事件 → ${targetId}: ${message.slice(0, 60)}`)
        await runner.chat(message, { timeoutMs: 120_000, socialMode: true })
      } catch (err) {
        console.warn(`[AgentPool] ⚠️ 主动事件处理失败 [${targetId}]:`, err)
      }
    })

    // PROACTIVE_SEND 事件（来自主动引擎的具体推送）
    globalEventBus.on(BusEvents.PROACTIVE_SEND, async (payload: any) => {
      const targetId = payload?.targetId || 'lumina'
      const text = payload?.text || payload?.message || ''
      if (!text) return

      const runner = this.getRunner(targetId)
      if (!runner) return

      try {
        await runner.chat(text, { timeoutMs: 60_000, socialMode: true })
      } catch {}
    })
  }
}

// ═══════════════════════════════════════════════════════════
// 全局单例
// ═══════════════════════════════════════════════════════════

let _pool: AgentPool | null = null

export function getAgentPool(): AgentPool {
  if (!_pool) _pool = new AgentPool()
  return _pool
}

export function initAgentPool(config?: Partial<AgentPoolConfig>): AgentPool {
  _pool = new AgentPool(config)
  _pool.start()
  return _pool
}
