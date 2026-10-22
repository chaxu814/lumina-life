// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// handover/handoverTypes.ts — 交班模式共享类型
//
// 「交班模式」：本地快照式交班摘要，不做云同步。
// 一张卡片聚合：今日摘要（Day Replay）、待审批队列、待办、三个 Agent 状态，
// 带 TTL 过期判定。卡片本体默认不持久化明文，由 crypto 层加密落盘。
// ============================================================

export const HANDOVER_SCHEMA_VERSION = 1
export const HANDOVER_DEFAULT_TTL_MINUTES = 120

/** 待审批项（来自 approvalService.listPending()，字段子集） */
export interface HandoverApprovalItem {
  id: string
  title: string
  createdAt: number
  risk?: string
}

/** 待办项（来自 todo 工具的内存数据） */
export interface HandoverTodoItem {
  id: number
  text: string
  done: boolean
}

export type HandoverAgentStateValue = 'idle' | 'working' | 'reviewing' | 'waiting' | 'unknown'

export interface HandoverAgentState {
  id: string
  state: HandoverAgentStateValue
  detail?: string
}

/**
 * Day Replay 的结构类型依赖（鸭子类型）。
 * 该模块由并行功能开发，本模块不 import 其实现，运行时懒加载。
 */
export interface DailyReplayLike {
  date: string
  stats: {
    costYuan?: number
    promptTokens?: number
    completionTokens?: number
    commands?: number
    delegates?: number
    turns?: number
    [k: string]: unknown
  }
  items: Array<{ kind: string; title: string; ts: number }>
}

export interface HandoverSummary {
  date: string
  costYuan?: number
  promptTokens?: number
  completionTokens?: number
  commands?: number
  delegates?: number
  turns?: number
  items: Array<{ kind: string; title: string; ts: number }>
}

export interface HandoverCard {
  schemaVersion: typeof HANDOVER_SCHEMA_VERSION
  /** epoch ms，生成时刻 */
  generatedAt: number
  /** 生存时长（分钟） */
  ttlMinutes: number
  /** epoch ms，过期时刻 */
  expiresAt: number
  generatedBy: 'lumina'
  /** Day Replay 缺失时为 null（不编造） */
  summary: HandoverSummary | null
  pendingApprovals: HandoverApprovalItem[]
  todos: HandoverTodoItem[]
  agentStates: HandoverAgentState[]
}

/** TTL 过期判定：now >= expiresAt 即过期（过期卡不可再执行审批动作） */
export function isHandoverExpired(card: Pick<HandoverCard, 'expiresAt'>, now: number = Date.now()): boolean {
  return now >= card.expiresAt
}

/** 过期时刻格式化展示用：「已过期（生成于 …）」 */
export function handoverAgeLabel(card: Pick<HandoverCard, 'generatedAt'>, now: number = Date.now()): string {
  const d = new Date(card.generatedAt)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
