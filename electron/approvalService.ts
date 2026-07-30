// ============================================================
// approvalService.ts — 危险操作审批流 (v8.0)
//
// 借鉴 QwenPaw ApprovalService 的三大增强:
//   ① 心跳 Heartbeat — 每 15 秒通知 UI 保持连接
//   ② 执行级别 ToolExecutionLevel — STRICT/SMART/AUTO/OFF
//   ③ 本地化 i18n — en/zh 双语支持
//
// 集成场景:
//   - desktop_act: 鼠标键盘操控 → 审批
//   - shell_exec (HIGH+): 高风险命令 → 审批
//   - file_write (敏感路径): 覆盖系统文件 → 审批
//   - browser (危险操作): 提交表单等 → 审批
// ============================================================

import { EventEmitter } from 'events'
import {
  type ApprovalRequest,
  type ApprovalConfig,
  type HeartbeatEvent,
  type ApprovalRiskLevel,
  ToolExecutionLevel,
  ApprovalDecision,
  DEFAULT_APPROVAL_CONFIG,
  requiresApproval,
} from './approvalTypes'
import { t, type ApprovalLocale } from './i18n/approval'

// ═══════════════════════════════════════════════════════════
// ApprovalService
// ═══════════════════════════════════════════════════════════

export class ApprovalService extends EventEmitter {
  private pending = new Map<string, ApprovalRequest>()
  private completed = new Map<string, ApprovalRequest>()
  private config: ApprovalConfig
  private heartbeatTimers = new Map<string, NodeJS.Timeout>()
  private timeoutTimers = new Map<string, NodeJS.Timeout>()
  private cleanupTimer: ReturnType<typeof setInterval> | null = null
  /** 🆕 v8.1: Promise 等待机制 — agentRunner 可通过此 await 用户决策 */
  private pendingResolvers = new Map<string, {
    resolve: (decision: ApprovalDecision) => void
    reject: (err: Error) => void
    timer: NodeJS.Timeout
  }>()

  constructor(config?: Partial<ApprovalConfig>) {
    super()
    this.config = { ...DEFAULT_APPROVAL_CONFIG, ...config }
    this.startCleanupLoop()
  }

  // ── 配置 ─────────────────────────────────────────------

  getConfig(): ApprovalConfig {
    return { ...this.config }
  }

  updateConfig(partial: Partial<ApprovalConfig>): void {
    const oldLevel = this.config.executionLevel
    this.config = { ...this.config, ...partial }
    console.log(`[approval] 配置已更新: level=${this.config.executionLevel} locale=${this.config.locale}`)

    // 如果执行级别发生变化，清理所有待审批队列
    if (partial.executionLevel && partial.executionLevel !== oldLevel) {
      if (partial.executionLevel === ToolExecutionLevel.OFF) {
        this.cancelAllPending()
      }
    }

    // 如果语言变了，重发心跳（刷新文案）
    if (partial.locale) {
      this.reemitHeartbeats()
    }
  }

  get locale(): ApprovalLocale {
    return this.config.locale
  }

  /** 当前执行级别 */
  get executionLevel(): ToolExecutionLevel {
    return this.config.executionLevel
  }

  /** 工具调用在当前位置下是否需要审批 */
  shouldRequireApproval(riskLevel: ApprovalRiskLevel): boolean {
    return requiresApproval(this.config.executionLevel, riskLevel)
  }

  // ── 创建审批请求 ─────────────────────────────────────

  requestApproval(params: {
    sessionId: string
    agentId: string
    toolName: string
    toolArgs: Record<string, any>
    description: string
    riskLevel: ApprovalRiskLevel
    threatCategories?: string[]
    securityFindings?: string[]
    timeoutMs?: number
  }): ApprovalRequest | null {
    // 级别 OFF → 直接放行
    if (this.config.executionLevel === ToolExecutionLevel.OFF) return null

    // 检查该风险级别是否需要审批
    if (!this.shouldRequireApproval(params.riskLevel)) return null

    if (!this.config.enabled) return null

    // 容量检查
    if (this.pending.size >= this.config.maxPending) {
      const oldest = [...this.pending.values()]
        .sort((a, b) => a.createdAt - b.createdAt)[0]
      if (oldest) {
        this.deny(oldest.id, t(this.locale, 'reason_cancelled'))
      }
    }

    const now = Date.now()
    const timeoutMs = params.timeoutMs || this.config.defaultTimeoutMs

    const request: ApprovalRequest = {
      id: this.generateId(),
      sessionId: params.sessionId,
      agentId: params.agentId,
      toolName: params.toolName,
      toolArgs: params.toolArgs,
      description: params.description,
      riskLevel: params.riskLevel,
      threatCategories: params.threatCategories || [],
      securityFindings: params.securityFindings || [],
      createdAt: now,
      timeoutMs,
      elapsedMs: 0,
      status: 'pending',
    }

    this.pending.set(request.id, request)
    this.emit('approval:requested', request)

    // 启动超时定时器
    const timeoutTimer = setTimeout(() => {
      if (request.status === 'pending') {
        if (this.config.autoDenyOnTimeout) {
          this.deny(
            request.id,
            t(this.locale, 'reason_timeout', { timeout: Math.round(timeoutMs / 1000) }),
            ApprovalDecision.TIMEOUT,
          )
        }
      }
    }, timeoutMs)
    this.timeoutTimers.set(request.id, timeoutTimer)

    // 启动心跳
    this.startHeartbeat(request)

    return request
  }

  // ── Heartbeat ─────────────────────────────────────────

  private startHeartbeat(request: ApprovalRequest): void {
    const interval = setInterval(() => {
      const req = this.pending.get(request.id)
      if (!req || req.status !== 'pending') {
        clearInterval(interval)
        this.heartbeatTimers.delete(request.id)
        return
      }

      const elapsed = Date.now() - req.createdAt
      const remaining = Math.max(0, req.timeoutMs - elapsed)
      req.elapsedMs = elapsed

      const event: HeartbeatEvent = {
        requestId: req.id,
        elapsed,
        remaining,
        riskLevel: req.riskLevel,
        toolName: req.toolName,
        status: 'pending',
      }

      this.emit('approval:heartbeat', event, this.locale)
    }, this.config.heartbeatIntervalMs)

    this.heartbeatTimers.set(request.id, interval)
  }

  /** 语言切换后重新发射心跳（刷新文案） */
  private reemitHeartbeats(): void {
    for (const [id, req] of this.pending) {
      if (req.status !== 'pending') continue
      const elapsed = Date.now() - req.createdAt
      const remaining = Math.max(0, req.timeoutMs - elapsed)
      this.emit('approval:heartbeat', {
        requestId: id,
        elapsed,
        remaining,
        riskLevel: req.riskLevel,
        toolName: req.toolName,
        status: 'pending',
      }, this.locale)
    }
  }

  // ── 审批通过 ─────────────────────────────────────────

  approve(requestId: string, note?: string): ApprovalRequest | null {
    return this.resolve(requestId, ApprovalDecision.APPROVED, note)
  }

  // ── 审批拒绝 ─────────────────────────────────────────

  deny(requestId: string, note?: string, decision?: ApprovalDecision): ApprovalRequest | null {
    return this.resolve(requestId, decision || ApprovalDecision.DENIED, note)
  }

  /** 统一决议方法 */
  private resolve(
    requestId: string,
    decision: ApprovalDecision,
    note?: string,
  ): ApprovalRequest | null {
    const request = this.pending.get(requestId)
    if (!request || request.status !== 'pending') return null

    // 状态变更
    request.status = decision === ApprovalDecision.APPROVED ? 'approved'
      : decision === ApprovalDecision.TIMEOUT ? 'timeout'
      : 'denied'
    request.resolvedAt = Date.now()
    request.approverNote = note

    // 清理定时器
    this.clearTimers(requestId)

    // 如果有正在等待的 Promise, 决议它
    const pendingResolver = this.pendingResolvers.get(requestId)
    if (pendingResolver) {
      clearTimeout(pendingResolver.timer)
      pendingResolver.resolve(decision)
      this.pendingResolvers.delete(requestId)
    }

    this.pending.delete(requestId)
    this.completed.set(requestId, request)
    this.emit('approval:resolved', request, decision)

    return request
  }

  private clearTimers(requestId: string): void {
    const hb = this.heartbeatTimers.get(requestId)
    if (hb) { clearInterval(hb); this.heartbeatTimers.delete(requestId) }
    const to = this.timeoutTimers.get(requestId)
    if (to) { clearTimeout(to); this.timeoutTimers.delete(requestId) }
    // 也清理 pendingPromise 的定时器
    const pendingResolver = this.pendingResolvers.get(requestId)
    if (pendingResolver) {
      clearTimeout(pendingResolver.timer)
      this.pendingResolvers.delete(requestId)
    }
  }

  /** 🆕 v8.1: 等待用户决策 — 返回 Promise, agentRunner 可 await */
  waitForDecision(requestId: string, timeoutMs?: number): Promise<ApprovalDecision> {
    const existing = this.pendingResolvers.get(requestId)
    if (existing) return Promise.resolve(ApprovalDecision.TIMEOUT)

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingResolvers.delete(requestId)
        // 超时自动拒绝
        this.deny(requestId, t(this.locale, 'reason_timeout', { timeout: Math.round((timeoutMs || this.config.defaultTimeoutMs) / 1000) }), ApprovalDecision.TIMEOUT)
        resolve(ApprovalDecision.TIMEOUT)
      }, timeoutMs || this.config.defaultTimeoutMs)

      this.pendingResolvers.set(requestId, { resolve, reject, timer })
    })
  }

  /** 取消所有待审批 */
  cancelAllPending(): void {
    const ids = [...this.pending.keys()]
    for (const id of ids) {
      this.deny(id, t(this.locale, 'reason_cancelled'))
    }
    // 清理所有残留的 Promise
    for (const [id, resolver] of this.pendingResolvers) {
      clearTimeout(resolver.timer)
      resolver.resolve(ApprovalDecision.CANCELLED)
    }
    this.pendingResolvers.clear()
  }

  // ── 查询 ─────────────────────────────────────────────

  getPending(requestId: string): ApprovalRequest | undefined {
    return this.pending.get(requestId)
  }

  getCompleted(requestId: string): ApprovalRequest | undefined {
    return this.completed.get(requestId)
  }

  listPending(): ApprovalRequest[] {
    return [...this.pending.values()]
      .filter(r => r.status === 'pending')
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  listPendingBySession(sessionId: string): ApprovalRequest[] {
    return this.listPending().filter(r => r.sessionId === sessionId)
  }

  listCompleted(): ApprovalRequest[] {
    return [...this.completed.values()]
      .sort((a, b) => (b.resolvedAt || 0) - (a.resolvedAt || 0))
  }

  /** 获取待审批数量 */
  get pendingCount(): number {
    return this.listPending().length
  }

  // ── 清理循环 ─────────────────────────────────────────

  private startCleanupLoop(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanup()
    }, 60_000)
  }

  private cleanup(): void {
    const now = Date.now()
    const maxAge = 3600_000 // 1 小时

    // 清理已完成
    const toRemove: string[] = []
    for (const [id, request] of this.completed) {
      if (request.resolvedAt && now - request.resolvedAt > maxAge) {
        toRemove.push(id)
      }
    }
    for (const id of toRemove) this.completed.delete(id)

    // 容量保护
    if (this.completed.size > 500) {
      const entries = [...this.completed.entries()]
        .sort((a, b) => (a[1].resolvedAt || 0) - (b[1].resolvedAt || 0))
      for (let i = 0; i < entries.length - 500; i++) {
        this.completed.delete(entries[i][0])
      }
    }

    // 清理超时的待审批（兜底）
    for (const [id, req] of this.pending) {
      if (req.status !== 'pending') continue
      if (now - req.createdAt > req.timeoutMs + 60_000) {
        this.deny(id, t(this.locale, 'reason_timeout', { timeout: Math.round(req.timeoutMs / 1000) }), ApprovalDecision.TIMEOUT)
      }
    }
  }

  /** 停止所有定时器 */
  stop(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer)
    for (const [id] of this.heartbeatTimers) this.clearTimers(id)
  }

  // ── 生成人类可读的操作描述 (静态工厂) ──────────────

  static describeToolCall(toolName: string, args: Record<string, any>): string {
    const desc: Record<string, (a: any) => string> = {
      desktop_act: (a) => `操控桌面: ${a.action || '点击'} ${a.description || '未指定位置'}`,
      shell_exec: (a) => `执行命令: ${(a.command || '').slice(0, 80)}`,
      file_write: (a) => `写入文件: ${a.file_path || '?'} (${(a.content || '').length} 字符)`,
      file_edit: (a) => `编辑文件: ${a.file_path || '?'}`,
      file_read: (a) => `读取文件: ${a.file_path || '?'}`,
      browser: (a) => `浏览器操作: ${a.action || '?'} ${a.url || ''}`,
      cron_schedule: (a) => `创建定时任务: ${a.schedule || '?'}`,
      notification: (a) => `发送通知: ${a.title || '?'}`,
    }
    const fn = desc[toolName]
    if (fn) return fn(args)
    return `${toolName}: ${JSON.stringify(args).slice(0, 100)}`
  }

  private generateId(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
    let id = 'apr_'
    for (let i = 0; i < 12; i++) {
      id += chars[Math.floor(Math.random() * chars.length)]
    }
    return id
  }
}

// ═══════════════════════════════════════════════════════════
// 全局单例
// ═══════════════════════════════════════════════════════════

let globalApprovalService: ApprovalService | null = null

export function getApprovalService(): ApprovalService {
  if (!globalApprovalService) {
    globalApprovalService = new ApprovalService()
  }
  return globalApprovalService
}

export function initApprovalService(config?: Partial<ApprovalConfig>): ApprovalService {
  globalApprovalService = new ApprovalService(config)
  return globalApprovalService
}
