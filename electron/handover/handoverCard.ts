// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// handover/handoverCard.ts — 交班快照卡聚合（纯逻辑，依赖可注入）
//
// 数据源（全部可注入；生产默认适配器懒加载、各自 try/catch，
// 任一数据源缺失只降级为 null / [] / unknown，绝不崩溃、绝不编造）：
//   · 今日摘要：Day Replay（并行功能，结构类型依赖，不 import 其实现）
//   · 待审批队列：electron/approvalService.ts getApprovalService().listPending()
//   · 待办：electron/tools/impl/todo.ts 的内存待办（通过其 list 输出解析，不改其文件）
//   · 三个 Agent 状态：electron/pet/agentStateBridge.ts deriveAgentState() + 委托看板
// ============================================================

import {
  HANDOVER_DEFAULT_TTL_MINUTES,
  HANDOVER_SCHEMA_VERSION,
  type DailyReplayLike,
  type HandoverAgentState,
  type HandoverAgentStateValue,
  type HandoverApprovalItem,
  type HandoverCard,
  type HandoverSummary,
  type HandoverTodoItem,
} from './handoverTypes'

// ── 依赖接口（鸭子类型，测试时注入假实现）─────────────────────

/** approvalService.listPending() 返回项的最小结构 */
export interface PendingApprovalLike {
  id: string
  toolName?: string
  description?: string
  riskLevel?: string
  createdAt: number
}

export interface HandoverDeps {
  /** 今日摘要生成器；返回 null 表示该模块缺失 */
  replay: () => DailyReplayLike | null
  /** 待审批列表 */
  pendingApprovals: () => PendingApprovalLike[]
  /** 待办列表 */
  todos: () => HandoverTodoItem[]
  /** 三个 Agent 的状态 */
  agentStates: () => HandoverAgentState[]
  /** 时钟（测试可冻） */
  now: () => number
}

// ── 生产默认适配器（懒加载，失败静默降级）────────────────────

function defaultReplay(): DailyReplayLike | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../dayreplay')
    const fn = (mod && (mod.buildDailyReplay || mod.getDailyReplay)) as (() => DailyReplayLike) | undefined
    if (typeof fn !== 'function') {return null}
    const r = fn.call(mod) as DailyReplayLike | null | undefined
    if (!r || typeof r !== 'object' || !r.stats || !Array.isArray(r.items)) {return null}
    return r
  } catch {
    return null // Day Replay 模块尚不存在/加载失败 → 摘要缺失，不编造
  }
}

function defaultPendingApprovals(): PendingApprovalLike[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getApprovalService } = require('../approvalService')
    const list = (getApprovalService().listPending() || []) as PendingApprovalLike[]
    return list.map(a => ({
      id: String(a.id),
      toolName: a.toolName,
      description: a.description,
      riskLevel: a.riskLevel,
      createdAt: a.createdAt,
    }))
  } catch {
    return []
  }
}

/**
 * 解析 todo 工具 list action 的输出文本还原待办。
 * 输出格式："  [ ] 1. 买牛奶" / "  [✓] 2. 写日报"
 * （todo 工具是 async 的，聚合保持同步签名 —— 生产由 IPC 层
 * 异步调用 todo({action:'list'}) 后用本函数解析并注入，见 handoverIpc.ts）
 */
export function parseTodoListText(text: string): HandoverTodoItem[] {
  const out: HandoverTodoItem[] = []
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/\s*\[\s*([✓xX ])\s*\]\s*(\d+)[\.\)、]?\s*(.*)/)
    if (!m) {continue}
    out.push({ id: parseInt(m[2], 10), text: m[3].trim(), done: m[1] !== ' ' })
  }
  return out
}

function defaultTodos(): HandoverTodoItem[] {
  // 同步环境拿不到 async 工具的输出 → 空列表（生产由 IPC 层预取注入）
  return []
}

const HANDOVER_AGENT_IDS = ['lumina', 'yak', 'recha']

function defaultAgentStates(): HandoverAgentState[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { deriveAgentState } = require('../pet/agentStateBridge') as {
      deriveAgentState: () => { state: string; actor: string | null; taskTitle: string | null; detail?: string }
    }
    const snap = deriveAgentState()
    const actor = (snap.actor || '').toLowerCase()
    return HANDOVER_AGENT_IDS.map(id => {
      if (actor === id || (id === 'recha' && actor === '热茶') || (id === 'yak' && actor === 'yak')) {
        const state = snap.state as HandoverAgentStateValue
        return {
          id,
          state: (['idle', 'working', 'reviewing', 'waiting'].includes(state) ? state : 'working'),
          detail: snap.taskTitle || snap.detail,
        } as HandoverAgentState
      }
      // 不是自己在忙：空闲快照说明全队 idle；拿不到归属就标 unknown，不编造
      if (snap.state === 'idle' && !actor) {
        return { id, state: 'idle' as HandoverAgentStateValue }
      }
      return { id, state: 'unknown' as HandoverAgentStateValue, detail: '状态未归属到该成员' }
    })
  } catch {
    // agentStateBridge 不可用：全部标 unknown
    return HANDOVER_AGENT_IDS.map(id => ({ id, state: 'unknown' as HandoverAgentStateValue, detail: '状态桥不可用' }))
  }
}

// ── 聚合 ────────────────────────────────────────────────────

function toSummary(r: DailyReplayLike): HandoverSummary {
  const s = r.stats || {}
  return {
    date: r.date,
    costYuan: s.costYuan,
    promptTokens: s.promptTokens,
    completionTokens: s.completionTokens,
    commands: s.commands,
    delegates: s.delegates,
    turns: s.turns,
    items: Array.isArray(r.items) ? r.items.map(it => ({ kind: String(it.kind), title: String(it.title), ts: Number(it.ts) || 0 })) : [],
  }
}

export interface BuildHandoverCardOptions {
  ttlMinutes?: number
}

/**
 * 聚合一张交班快照卡。
 * @param deps 可选覆盖全部数据源（测试注入）
 */
export function buildHandoverCard(
  deps: Partial<HandoverDeps> = {},
  opts: BuildHandoverCardOptions = {},
): HandoverCard {
  const now = (deps.now || (() => Date.now()))()
  const ttlMinutes = Math.max(1, Math.floor(opts.ttlMinutes || HANDOVER_DEFAULT_TTL_MINUTES))

  const replayFn = deps.replay || defaultReplay
  const approvalsFn = deps.pendingApprovals || defaultPendingApprovals
  const todosFn = deps.todos || defaultTodos
  const agentsFn = deps.agentStates || defaultAgentStates

  const replay = replayFn()
  const approvals: PendingApprovalLike[] = approvalsFn() || []
  const todos: HandoverTodoItem[] = todosFn() || []

  const pendingApprovals: HandoverApprovalItem[] = approvals.map(a => ({
    id: String(a.id),
    title: a.description || a.toolName || '未命名操作',
    createdAt: Number(a.createdAt) || now,
    risk: a.riskLevel ? String(a.riskLevel) : undefined,
  }))

  return {
    schemaVersion: HANDOVER_SCHEMA_VERSION,
    generatedAt: now,
    ttlMinutes,
    expiresAt: now + ttlMinutes * 60_000,
    generatedBy: 'lumina',
    summary: replay ? toSummary(replay) : null,
    pendingApprovals,
    todos: todos.map(t => ({ id: Number(t.id) || 0, text: String(t.text || ''), done: !!t.done })),
    agentStates: agentsFn(),
  }
}
