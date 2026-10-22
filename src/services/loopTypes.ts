// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// services/loopTypes.ts — Lumina Loop Engine 数据模型 (Phase 1)
//
// 对标智谱清言「Loop 任务」：把长程目标拆成可执行子任务链，
// 跨 Session 追踪进度，由触发器自动感知外部变化并进入新的循环。
//
// 循环链路：感知 → 拆解 → 执行 → 修正 → 再感知
// ============================================================

/** Loop 生命周期状态机 */
export type LoopStatus =
  | 'configuring' // 刚创建，正在动态拆解任务链
  | 'reviewing'   // 拆解完成，等待用户审阅确认后开始运转
  | 'running'     // 用户确认 / 恢复，正在持续运转
  | 'paused'      // 已暂停
  | 'done'        // 已完成 / 主动停止

/** 单个子任务的执行状态 */
export type SubtaskStatus = 'pending' | 'running' | 'done' | 'failed'

export interface SubTask {
  id: string
  title: string
  description: string
  status: SubtaskStatus
  retryCount: number
  maxRetries: number
  /** 最近一次执行结果摘要 */
  result?: string
  startedAt?: number
  finishedAt?: number
}

/** 触发器类型：cron / api_event / message / interval */
export type LoopTriggerType = 'cron' | 'api_event' | 'message' | 'interval'

export interface LoopTrigger {
  id: string
  type: LoopTriggerType
  /** 触发器配置（语义随类型变化）：
   *  - interval:  { intervalMs: number }
   *  - cron:      { schedule: "分 时 日 月 周" }  如 "0 15 * * 1-5"
   *  - message:   { keywords: string[] }          监听关键词
   *  - api_event: { event: string }               外部事件名（未来 webhook 扩展）
   */
  config: Record<string, any>
  enabled: boolean
}

/** 跨 Session 进度追踪 */
export interface LoopProgress {
  /** 已完成子任务 ID */
  completed: string[]
  /** 当前执行中的子任务 ID */
  current: string | null
  /** 持久化键名（跨 Session 恢复用） */
  persistenceKey: string
  /** 已完成轮次摘要（复盘用） */
  history: string[]
}

/** 单次循环的产出 */
export interface LoopOutput {
  time: number
  subtaskTitle?: string
  content: string
}

/** 运行日志（审计 / 复盘 / 展示用） */
export interface LoopRunLog {
  time: number
  event:
    | 'create' | 'decomposed' | 'confirm' | 'pause' | 'resume' | 'stop'
    | 'trigger' | 'cycle' | 'subtask_done' | 'subtask_failed' | 'error' | 'restore'
  detail?: string
}

/** 一个完整的 Loop 任务 */
export interface LoopTask {
  id: string
  /** 用户定义的 OKR 目标 */
  goal: string
  /** 自动拆解后的执行策略 */
  strategy: string
  /** 子任务链 */
  subtasks: SubTask[]
  /** 触发器 */
  triggers: LoopTrigger[]
  /** 跨 Session 进度追踪 */
  progress: LoopProgress
  status: LoopStatus
  createdAt: number
  lastRunAt?: number
  /** 每轮产出 */
  outputs: LoopOutput[]
  /** 已运行轮次 */
  runCount: number
  /** 运行日志 */
  logs: LoopRunLog[]
  /** 透传给 remark 模型的 agent 上下文（可选） */
  agentId?: string
}

/** 单个子任务的执行结果 */
export interface LoopSubtaskResult {
  ok: boolean
  content?: string
  error?: string
  /** 是否应重试（默认：执行失败时按 retryCount/maxRetries 自动重试） */
  shouldRetry?: boolean
  /** 产出物（URL、文件路径等，由 executor 提取） */
  artifacts?: string[]
}

/** 动态拆解的产物（LLM 返回，须能被引擎结构化为 LoopTask） */
export interface Decomposition {
  strategy: string
  subtasks: Array<{ title: string; description: string }>
  /** 建议的触发器（可空，引擎会补默认 interval） */
  trigger?: {
    type: 'interval' | 'cron' | 'message'
    intervalHours?: number
    cronSchedule?: string
    keywords?: string[]
  }
}