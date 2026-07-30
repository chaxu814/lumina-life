// ============================================================
// messageQueue.ts — 统一消息队列 (v2.7)
//
// 借鉴 QwenPaw UnifiedQueueManager:
//   三级队列键 (channel, session, priority)
//   → 同 session 同优先级严格串行
//   → 不同 session / 不同优先级并行
//   → 动态消费者创建 + 空闲自动清理
//
// 解决问题:
//   Lumina 旧桥接系统同步处理消息，多平台同时聊天会阻塞
//   现在 Discord/微信/Telegram/飞书各走各的队列，互不干扰
// ============================================================

import { EventEmitter } from 'events'

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

export type QueueKey = string  // `${channel}::${sessionId}::${priority}`

export type Priority = 0 | 1 | 2  // 0=high, 1=normal, 2=low

export interface QueueItem {
  id: string
  channel: string
  sessionId: string
  priority: Priority
  payload: any
  timestamp: number
  retryCount: number
  maxRetries: number
}

export interface QueueState {
  queue: QueueItem[]
  consumerActive: boolean
  createdAt: number
  lastActivity: number
  processedCount: number
  channel: string
  sessionId: string
  priority: Priority
}

export type MessageHandler = (item: QueueItem) => Promise<void>

export interface QueueConfig {
  /** 最大队列深度 */
  maxQueueSize: number
  /** 空闲超时 (ms) */
  idleTimeout: number
  /** 清理间隔 (ms) */
  cleanupInterval: number
  /** 最大重试次数 */
  maxRetries: number
  /** 重试延迟基数 (ms) */
  retryBaseDelay: number
}

// ═══════════════════════════════════════════════════════════
// UnifiedMessageQueue
// ═══════════════════════════════════════════════════════════

export class UnifiedMessageQueue extends EventEmitter {
  private queues = new Map<QueueKey, QueueState>()
  private handler: MessageHandler
  private config: QueueConfig
  private cleanupTimer: ReturnType<typeof setInterval> | null = null
  private isRunning = false

  constructor(handler: MessageHandler, config?: Partial<QueueConfig>) {
    super()
    this.handler = handler
    this.config = {
      maxQueueSize: config?.maxQueueSize ?? 1000,
      idleTimeout: config?.idleTimeout ?? 600_000,  // 10 分钟
      cleanupInterval: config?.cleanupInterval ?? 60_000,  // 1 分钟
      maxRetries: config?.maxRetries ?? 3,
      retryBaseDelay: config?.retryBaseDelay ?? 1000,
    }
  }

  // ── 构造 QueueKey ─────────────────────────────────────

  static makeKey(channel: string, sessionId: string, priority: Priority): QueueKey {
    return `${channel}::${sessionId}::${priority}`
  }

  static parseKey(key: QueueKey): { channel: string; sessionId: string; priority: Priority } {
    const [channel, sessionId, priorityStr] = key.split('::')
    return { channel, sessionId, priority: Number(priorityStr) as Priority }
  }

  // ── 生命周期 ─────────────────────────────────────────

  start(): void {
    this.isRunning = true
    this.cleanupTimer = setInterval(() => this.cleanupIdleQueues(), this.config.cleanupInterval)
    console.log('[MessageQueue] 消息队列已启动')
  }

  stop(): void {
    this.isRunning = false
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
    // 清空所有队列
    this.queues.clear()
    console.log('[MessageQueue] 消息队列已停止')
  }

  // ── 入队 ─────────────────────────────────────────────

  enqueue(channel: string, sessionId: string, priority: Priority, payload: any): string {
    const key = UnifiedMessageQueue.makeKey(channel, sessionId, priority)
    let state = this.queues.get(key)

    if (!state) {
      state = {
        queue: [],
        consumerActive: false,
        createdAt: Date.now(),
        lastActivity: Date.now(),
        processedCount: 0,
        channel,
        sessionId,
        priority,
      }
      this.queues.set(key, state)
    }

    // 容量检查
    if (state.queue.length >= this.config.maxQueueSize) {
      const dropped = state.queue.shift()
      this.emit('queue:dropped', { key, item: dropped })
    }

    const id = `${key}::${Date.now()}::${Math.random().toString(36).slice(2, 8)}`
    const item: QueueItem = {
      id,
      channel,
      sessionId,
      priority,
      payload,
      timestamp: Date.now(),
      retryCount: 0,
      maxRetries: this.config.maxRetries,
    }

    state.queue.push(item)
    state.lastActivity = Date.now()
    this.emit('queue:enqueued', { key, item })

    // 触发消费
    if (!state.consumerActive) {
      this.consumeQueue(key, state).catch(err => {
        this.emit('queue:error', { key, error: err })
      })
    }

    return id
  }

  // ── 批量入队 ─────────────────────────────────────────

  enqueueBatch(
    channel: string,
    sessionId: string,
    priority: Priority,
    payloads: any[],
  ): string[] {
    return payloads.map(p => this.enqueue(channel, sessionId, priority, p))
  }

  // ── 消费队列 ─────────────────────────────────────────

  private async consumeQueue(key: QueueKey, state: QueueState): Promise<void> {
    state.consumerActive = true

    try {
      while (this.isRunning && state.queue.length > 0) {
        const item = state.queue.shift()!
        state.lastActivity = Date.now()

        try {
          await this.handler(item)
          state.processedCount++
          this.emit('queue:processed', { key, item })
        } catch (err) {
          // 重试逻辑
          if (item.retryCount < item.maxRetries) {
            item.retryCount++
            const delay = this.config.retryBaseDelay * Math.pow(2, item.retryCount - 1)
            await new Promise(resolve => setTimeout(resolve, delay))
            state.queue.unshift(item)  // 重新入队
          } else {
            this.emit('queue:failed', { key, item, error: err })
          }
        }
      }
    } finally {
      state.consumerActive = false
      // 如果在消费过程中有新消息入队，重新触发
      if (state.queue.length > 0) {
        this.consumeQueue(key, state).catch(err => {
          this.emit('queue:error', { key, error: err })
        })
      }
    }
  }

  // ── 空闲清理 ─────────────────────────────────────────

  private cleanupIdleQueues(): void {
    const now = Date.now()
    const toRemove: QueueKey[] = []

    for (const [key, state] of this.queues) {
      // 只清理空闲且无待处理消息的队列
      if (!state.consumerActive && state.queue.length === 0) {
        if (now - state.lastActivity > this.config.idleTimeout) {
          toRemove.push(key)
        }
      }
    }

    for (const key of toRemove) {
      this.queues.delete(key)
      this.emit('queue:cleaned', { key })
    }

    if (toRemove.length > 0) {
      console.log(`[MessageQueue] 清理了 ${toRemove.length} 个空闲队列`)
    }
  }

  // ── 查询 ─────────────────────────────────────────────

  getStats(): {
    totalQueues: number
    totalPending: number
    totalProcessed: number
    queues: Array<{ key: string; channel: string; sessionId: string; priority: Priority; pending: number; processed: number }>
  } {
    let totalPending = 0
    let totalProcessed = 0
    const queueList: any[] = []

    for (const [key, state] of this.queues) {
      totalPending += state.queue.length
      totalProcessed += state.processedCount
      queueList.push({
        key,
        channel: state.channel,
        sessionId: state.sessionId,
        priority: state.priority,
        pending: state.queue.length,
        processed: state.processedCount,
      })
    }

    return {
      totalQueues: this.queues.size,
      totalPending,
      totalProcessed,
      queues: queueList,
    }
  }

  getPendingCount(channel: string, sessionId: string): number {
    let count = 0
    for (const [key, state] of this.queues) {
      const parsed = UnifiedMessageQueue.parseKey(key)
      if (parsed.channel === channel && parsed.sessionId === sessionId) {
        count += state.queue.length
      }
    }
    return count
  }

  clearChannel(channel: string, sessionId: string): void {
    const toRemove: QueueKey[] = []
    for (const [key, state] of this.queues) {
      const parsed = UnifiedMessageQueue.parseKey(key)
      if (parsed.channel === channel && parsed.sessionId === sessionId) {
        state.queue.length = 0
        if (!state.consumerActive) toRemove.push(key)
      }
    }
    for (const key of toRemove) this.queues.delete(key)
  }
}

// ═══════════════════════════════════════════════════════════
// 全局单例
// ═══════════════════════════════════════════════════════════

let globalMessageQueue: UnifiedMessageQueue | null = null

export function getMessageQueue(): UnifiedMessageQueue {
  if (!globalMessageQueue) {
    throw new Error('[MessageQueue] 消息队列尚未初始化，请先调用 initMessageQueue()')
  }
  return globalMessageQueue
}

export function initMessageQueue(handler: MessageHandler, config?: Partial<QueueConfig>): UnifiedMessageQueue {
  if (globalMessageQueue) {
    globalMessageQueue.stop()
  }
  globalMessageQueue = new UnifiedMessageQueue(handler, config)
  globalMessageQueue.start()
  return globalMessageQueue
}

export function destroyMessageQueue(): void {
  if (globalMessageQueue) {
    globalMessageQueue.stop()
    globalMessageQueue = null
  }
}
