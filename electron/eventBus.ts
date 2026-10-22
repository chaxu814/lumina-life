// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// eventBus.ts — 事件总线（借鉴 ZerolanLiveRobot 的 TypedEventEmitter）
//
// 作用：解耦 Agent、Live2D、UI、TTS、记忆系统之间的通信
// 发起方 emit → 监听方 on → 异步并行执行
// ============================================================

type EventHandler = (...args: any[]) => void | Promise<void>

export interface BusEvent {
  type: string
  payload?: any
  timestamp: number
}

export class EventBus {
  private handlers = new Map<string, Set<EventHandler>>()
  private history: BusEvent[] = []
  private maxHistory = 200

  /** 注册监听器 */
  on(eventType: string, handler: EventHandler): () => void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set())
    }
    this.handlers.get(eventType)!.add(handler)

    // 返回取消注册函数
    return () => this.off(eventType, handler)
  }

  /** 单次监听 */
  once(eventType: string, handler: EventHandler): () => void {
    const wrapper: EventHandler = (...args) => {
      this.off(eventType, wrapper)
      return handler(...args)
    }
    return this.on(eventType, wrapper)
  }

  /** 取消注册 */
  off(eventType: string, handler: EventHandler): void {
    this.handlers.get(eventType)?.delete(handler)
  }

  /** 发送事件（异步并行执行所有监听器） */
  async emit(eventType: string, payload?: any): Promise<void> {
    const event: BusEvent = { type: eventType, payload, timestamp: Date.now() }

    // 记录历史
    this.history.push(event)
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory)
    }

    const handlers = this.handlers.get(eventType)
    if (!handlers?.size) {return}

    // 并行执行，不阻塞
    const promises = Array.from(handlers).map(async (handler) => {
      try {
        await handler(payload)
      } catch (err) {
        console.error(`[EventBus] ${eventType} handler error:`, err)
      }
    })

    await Promise.allSettled(promises)
  }

  /** 同步发送（等待所有处理完成） */
  async emitSync(eventType: string, payload?: any): Promise<void> {
    return this.emit(eventType, payload)
  }

  /** 获取最近事件历史 */
  getHistory(limit = 50): BusEvent[] {
    return this.history.slice(-limit)
  }

  /** 清除所有监听器 */
  clear(): void {
    this.handlers.clear()
  }

  /** 获取监听器数量 */
  listenerCount(eventType: string): number {
    return this.handlers.get(eventType)?.size || 0
  }
}

// ═══════════════════════════════════════════════════════════
// 预定义事件类型常量
// ═══════════════════════════════════════════════════════════

export const BusEvents = {
  // Agent 事件
  AGENT_THINKING: 'agent:thinking',
  AGENT_TOOL_START: 'agent:tool_start',
  AGENT_TOOL_END: 'agent:tool_end',
  AGENT_TEXT: 'agent:text',
  AGENT_DONE: 'agent:done',
  AGENT_ERROR: 'agent:error',
  AGENT_TASK_DONE: 'agent:task_done',
  AGENT_TOKEN_UPDATE: 'agent:token_update',

  // TTS 事件
  TTS_SPEAK_START: 'tts:speak_start',
  TTS_SPEAK_END: 'tts:speak_end',
  TTS_ERROR: 'tts:error',

  // STT 事件
  STT_RESULT: 'stt:result',
  STT_STATUS: 'stt:status',

  // 记忆事件
  MEMORY_SAVED: 'memory:saved',
  MEMORY_SUMMARIZED: 'memory:summarized',

  // 系统事件
  SYSTEM_IDLE: 'system:idle',
  SYSTEM_ACTIVE: 'system:active',
  SYSTEM_SHUTDOWN: 'system:shutdown',

  // 主动对话事件
  PROACTIVE_TRIGGER: 'proactive:trigger',
  PROACTIVE_SEND: 'proactive:send',
  PROACTIVE_MESSAGE: 'proactive:message',
  PROACTIVE_CONFIG: 'proactive:config',
  // 🧭 统一主动管线（v6.1）：决策/沉默调试日志
  PROACTIVE_DECISION: 'proactive:decision',
  PROACTIVE_SILENT: 'proactive:silent',

  // 社交引擎事件
  SOCIAL_TRIGGER: 'social:trigger',

  // ── v5.0 模式事件 ──────────────────────────────────

  /** Agent 模式切换 */
  AGENT_MODE_CHANGED: 'agent:mode_changed',

  // ── v2.6 团队事件 ──────────────────────────────────

  /** Agent 间社交消息 */
  AGENT_SOCIAL_MESSAGE: 'agent:social_message',
  /** 某个 Agent 开始发言 */
  AGENT_SPEAKING: 'agent:speaking',
  /** 某个 Agent 停止发言 */
  AGENT_STOPPED_SPEAKING: 'agent:stopped_speaking',
  /** 团队讨论开始 */
  TEAM_DISCUSSION_STARTED: 'team:discussion_started',
  /** 团队讨论结束 */
  TEAM_DISCUSSION_ENDED: 'team:discussion_ended',
  /** 团队启动 */
  TEAM_STARTED: 'team:started',
  /** 团队停止 */
  TEAM_STOPPED: 'team:stopped',
  /** 团队主动系统启动 */
  TEAM_PROACTIVE_STARTED: 'team:proactive_started',
  /** 用户回来了 */
  TEAM_USER_RETURNED: 'team:user_returned',
  /** 决策完成 */
  TEAM_DECISION_COMPLETE: 'team:decision_complete',
  /** 关系变化 */
  RELATIONSHIP_CHANGED: 'team:relationship_changed',

  // ── v2.8 Agent 对话事件 ──────────────────────────

  /** Agent 间对话完成 */
  AGENT_CONVERSATION_COMPLETE: 'agent:conversation_complete',

  // ── 安全事件 ──────────────────────────────────────

  /** 安全告警 */
  SECURITY_ALERT: 'agent:security_alert',

  // ── 🆕 v3.0 游戏化事件 ──────────────────────────

  /** 成就解锁 */
  ACHIEVEMENT_UNLOCKED: 'gamification:achievement_unlocked',
  /** XP 增加 */
  XP_GAINED: 'gamification:xp_gained',
  /** 升级 */
  LEVEL_UP: 'gamification:level_up',
  /** 🆕 v3.1 每日任务更新 */
  QUEST_UPDATED: 'gamification:quest_updated',

  // ── 🆕 v3.0 时光胶囊事件 ────────────────────────

  /** 时光胶囊到期 */
  TIME_CAPSULE_EXPIRED: 'time_capsule:expired',
  /** 时光胶囊已埋 */
  TIME_CAPSULE_BURIED: 'time_capsule:buried',

  // ── 🆕 v3.0 副人格觉醒事件 ──────────────────────

  /** 人格冲突 */
  PERSONALITY_CONFLICT: 'personality:conflict',

  // ── 🆕 v3.0 梦境系统事件 ─────────────────────────

  /** 新梦境生成 */
  DREAM_NEW: 'dream:new',

  // ── 🆕 v3.0 Agent 真人秀事件 ─────────────────────

  /** 真人秀新事件 */
  REALITY_SHOW_EVENT: 'reality:show:event',

  // ── 🆕 Lucky 模式事件 ────────────────────────────

  /** Lucky 模式配置变更 */
  LUCKY_MODE_CONFIG_CHANGED: 'lucky:config_changed',
  /** Lucky 模式状态更新 */
  LUCKY_MODE_STATE_UPDATED: 'lucky:state_updated',
  /** 场景模式切换（modeManager） */
  MODE_CHANGED: 'mode:changed',
  /** Agent 情绪变化 */
  AGENT_MOOD_CHANGED: 'agent:mood_changed',
} as const

// 全局单例
export const globalEventBus = new EventBus()
