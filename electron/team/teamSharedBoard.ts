// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// teamSharedBoard.ts — 团队共享任务板 (v3.30, 同类工程实践：shared task board)
//
// 同类项目的多 agent 协作不依赖「中心调度员派活」：任务挂在共享板上，
// 每个 worker 自己拉取（claim）可做的任务、自己登记 blockedBy 依赖，
// 完成/失败写回，避免重复劳动。
//
// Lumina 落地版（持久化、原子写、跨重启不丢）：
//   userData/team/shared-board.json
//
// v3.30 新增：
//   - plan_approval：requireApproval 的任务先进 pending_approval，人批准后才可认领
//   - 状态变更历史（history）：拓扑回放/审计用，环形截断 400 条
// ============================================================

import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'

export type BoardTaskStatus =
  | 'pending' | 'pending_approval' | 'claimed' | 'running'
  | 'done' | 'failed' | 'blocked'
export type BoardTaskKind = 'research' | 'search' | 'data' | 'code' | 'review' | 'test' | 'other'

export interface BoardTask {
  id: string
  title: string
  detail: string
  kind: BoardTaskKind
  status: BoardTaskStatus
  /** 认领人（worker id）；未认领为 null */
  owner: string | null
  createdBy: string
  /** 依赖的任务 id；全部 done 后才可认领 */
  blockedBy: string[]
  result: string | null
  error: string | null
  /** 数字越大越优先（默认 0） */
  priority: number
  /** 关联的工作目录（如 git worktree 隔离路径） */
  workdir?: string
  /** v3.30 需人工批准才可被认领（plan_approval） */
  requireApproval?: boolean
  createdAt: number
  claimedAt: number | null
  updatedAt: number
  completedAt: number | null
  /** 最近心跳（防止 worker 崩了任务永久占用） */
  heartbeatAt: number | null
}

export interface BoardEvent {
  ts: number
  taskId: string
  title: string
  from: BoardTaskStatus | 'created'
  to: BoardTaskStatus
  by: string
}

export interface CreateTaskInput {
  title: string
  detail?: string
  kind?: BoardTaskKind
  createdBy?: string
  blockedBy?: string[]
  priority?: number
  workdir?: string
  /** v3.30 人工批准（plan_approval） */
  requireApproval?: boolean
}

interface BoardState {
  tasks: BoardTask[]
  seq: number
  history: BoardEvent[]
}

const STALE_MS = 10 * 60 * 1000 // 心跳超时 10 分钟，视为僵死可重新认领
const HISTORY_CAP = 400

// ═══════════════════════════════════════════════════════════
// 纯状态变换（可单测，不碰文件）
// ═══════════════════════════════════════════════════════════

export function createTaskInState(state: BoardState, input: CreateTaskInput, now = Date.now()): { state: BoardState; task: BoardTask } {
  const id = `t${++state.seq}`
  const task: BoardTask = {
    id,
    title: input.title,
    detail: input.detail || '',
    kind: input.kind || 'other',
    status: input.requireApproval ? 'pending_approval' : 'pending',
    owner: null,
    createdBy: input.createdBy || 'lumina',
    blockedBy: [...(input.blockedBy || [])],
    result: null,
    error: null,
    priority: input.priority ?? 0,
    workdir: input.workdir,
    requireApproval: !!input.requireApproval,
    createdAt: now,
    claimedAt: null,
    updatedAt: now,
    completedAt: null,
    heartbeatAt: null,
  }
  const history = appendHistory(state.history, {
    ts: now, taskId: id, title: task.title,
    from: 'created', to: task.status, by: task.createdBy,
  })
  return { state: { ...state, tasks: [...state.tasks, task], history }, task }
}

function appendHistory(history: BoardEvent[] | undefined, ev: BoardEvent): BoardEvent[] {
  const next = [...(history || []), ev]
  return next.length > HISTORY_CAP ? next.slice(next.length - HISTORY_CAP) : next
}

function isBlocked(state: BoardState, t: BoardTask): boolean {
  return t.blockedBy.some(depId => {
    const dep = state.tasks.find(x => x.id === depId)
    return !dep || dep.status !== 'done'
  })
}

/** 认领：仅 pending、无未完成依赖、owner 为空时成功（first-claim-wins） */
export function claimInState(
  state: BoardState,
  taskId: string,
  member: string,
  now = Date.now(),
): { state: BoardState; task?: BoardTask; error?: string } {
  const t = state.tasks.find(x => x.id === taskId)
  if (!t) {return { state, error: `任务 ${taskId} 不存在` }}
  if (t.owner === member && (t.status === 'claimed' || t.status === 'running')) {
    return { state, task: t } // 幂等：自己已认领
  }
  if (t.status === 'pending_approval') {return { state, error: `任务 ${taskId} 尚未获人工批准（plan_approval）` }}
  if (t.status === 'done') {return { state, error: `任务 ${taskId} 已完成` }}
  if (t.status === 'failed') {return { state, error: `任务 ${taskId} 已失败，请先处理失败` }}
  if (t.owner) {return { state, error: `任务 ${taskId} 已被 ${t.owner} 认领` }}
  if (isBlocked(state, t)) {return { state, error: `任务 ${taskId} 的前置依赖未完成` }}
  const updated: BoardTask = { ...t, status: 'claimed', owner: member, claimedAt: now, updatedAt: now, heartbeatAt: now }
  const history = appendHistory(state.history, {
    ts: now, taskId: t.id, title: t.title, from: t.status, to: 'claimed', by: member,
  })
  return {
    state: { ...state, tasks: state.tasks.map(x => x.id === taskId ? updated : x), history },
    task: updated,
  }
}

/** v3.30 批准任务（pending_approval → pending）；纯函数 */
export function approveInState(
  state: BoardState,
  taskId: string,
  by: string,
  now = Date.now(),
): { state: BoardState; task?: BoardTask; error?: string } {
  const t = state.tasks.find(x => x.id === taskId)
  if (!t) {return { state, error: `任务 ${taskId} 不存在` }}
  if (t.status !== 'pending_approval') {return { state, error: `任务 ${taskId} 不在待批准状态` }}
  const updated: BoardTask = { ...t, status: 'pending', updatedAt: now, requireApproval: false }
  const history = appendHistory(state.history, {
    ts: now, taskId: t.id, title: t.title, from: 'pending_approval', to: 'pending', by,
  })
  return {
    state: { ...state, tasks: state.tasks.map(x => x.id === taskId ? updated : x), history },
    task: updated,
  }
}

/** v3.30 驳回任务（pending_approval → failed，记录原因） */
export function rejectInState(
  state: BoardState,
  taskId: string,
  by: string,
  reason: string,
  now = Date.now(),
): { state: BoardState; task?: BoardTask; error?: string } {
  const t = state.tasks.find(x => x.id === taskId)
  if (!t) {return { state, error: `任务 ${taskId} 不存在` }}
  if (t.status !== 'pending_approval') {return { state, error: `任务 ${taskId} 不在待批准状态` }}
  const updated: BoardTask = { ...t, status: 'failed', error: `已驳回：${reason}`, updatedAt: now }
  const history = appendHistory(state.history, {
    ts: now, taskId: t.id, title: t.title, from: 'pending_approval', to: 'failed', by,
  })
  return {
    state: { ...state, tasks: state.tasks.map(x => x.id === taskId ? updated : x), history },
    task: updated,
  }
}

/**
 * v3.33 回收孤儿任务（崩溃恢复）。
 * - force=true：所有 claimed/running 一律退回 pending（重启后没有活着的 worker）
 * - force=false：仅回收心跳超过 staleMs 的（claimNext 内部也会做一次）
 * 返回被回收的任务 id 列表。
 */
export function reapOrphansInState(
  state: BoardState,
  now = Date.now(),
  opts: { force?: boolean; staleMs?: number } = {},
): { state: BoardState; reaped: string[] } {
  const staleMs = opts.staleMs ?? STALE_MS
  const reaped: string[] = []
  const tasks = state.tasks.map(t => {
    if (t.status !== 'claimed' && t.status !== 'running') {return t}
    const stale = !t.heartbeatAt || now - t.heartbeatAt > staleMs
    if (opts.force || stale) {
      reaped.push(t.id)
      const history = appendHistory(state.history, {
        ts: now, taskId: t.id, title: t.title, from: t.status, to: 'pending', by: 'lumina',
      })
      state.history = history
      return {
        ...t, status: 'pending' as BoardTaskStatus, owner: null,
        claimedAt: null, heartbeatAt: null, updatedAt: now,
      }
    }
    return t
  })
  return { state: { ...state, tasks }, reaped }
}

// ═══════════════════════════════════════════════════════════
// 持久化存储
// ═══════════════════════════════════════════════════════════

let _chain: Promise<unknown> = Promise.resolve()
function chain<T>(fn: () => Promise<T> | T): Promise<T> {
  const run = _chain.then(() => fn(), () => fn())
  _chain = run.catch(() => undefined)
  return run
}

export class SharedBoardStore {
  private state: BoardState
  constructor(public readonly filepath: string) {
    fs.mkdirSync(path.dirname(filepath), { recursive: true })
    this.state = this.load()
  }

  private load(): BoardState {
    try {
      if (fs.existsSync(this.filepath)) {
        const raw = JSON.parse(fs.readFileSync(this.filepath, 'utf-8')) as BoardState
        return {
          tasks: raw.tasks || [],
          seq: raw.seq || 0,
          history: raw.history || [],
        }
      }
    } catch (e) {
      console.warn('[teamSharedBoard] 读取失败，重置空板:', (e as Error)?.message)
    }
    return { tasks: [], seq: 0, history: [] }
  }

  private persist(): void {
    const tmp = this.filepath + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf-8')
    fs.renameSync(tmp, this.filepath)
  }

  /** 创建任务 */
  async createTask(input: CreateTaskInput): Promise<BoardTask> {
    return chain(() => {
      const r = createTaskInState(this.state, input)
      this.state = r.state
      this.persist()
      return r.task
    })
  }

  /** 批量创建（返回创建后的任务列表） */
  async createTasks(inputs: CreateTaskInput[]): Promise<BoardTask[]> {
    return chain(() => {
      const created: BoardTask[] = []
      for (const input of inputs) {
        const r = createTaskInState(this.state, input)
        this.state = r.state
        created.push(r.task)
      }
      this.persist()
      return created
    })
  }

  /** v3.30 人工批准（pending_approval → pending） */
  async approve(taskId: string, by = 'lumina'): Promise<BoardTask> {
    return chain(() => {
      const r = approveInState(this.state, taskId, by)
      if (r.error) {throw new Error(r.error)}
      this.state = r.state
      this.persist()
      return r.task!
    })
  }

  /** v3.30 人工驳回 */
  async reject(taskId: string, by: string, reason: string): Promise<BoardTask> {
    return chain(() => {
      const r = rejectInState(this.state, taskId, by, reason)
      if (r.error) {throw new Error(r.error)}
      this.state = r.state
      this.persist()
      return r.task!
    })
  }

  /** 认领任务（worker 自主领取） */
  async claim(taskId: string, member: string): Promise<BoardTask> {
    return chain(() => {
      const r = claimInState(this.state, taskId, member)
      if (r.error) {throw new Error(r.error)}
      this.state = r.state
      this.persist()
      return r.task!
    })
  }

  /**
   * 认领一个当前可做的任务（worker 自领取的核心）：
   * 按优先级、创建时间挑一个 pending 且依赖完成的任务原子认领。
   */
  async claimNext(member: string, opts: { kinds?: BoardTaskKind[] } = {}): Promise<BoardTask | null> {
    return chain(() => {
      const now = Date.now()
      // 僵死任务回收：owner 心跳超时 → 退回 pending
      for (const t of this.state.tasks) {
        if ((t.status === 'claimed' || t.status === 'running')
          && t.heartbeatAt && now - t.heartbeatAt > STALE_MS) {
          t.status = 'pending'; t.owner = null; t.claimedAt = null; t.heartbeatAt = null; t.updatedAt = now
        }
      }
      const candidates = this.state.tasks
        .filter(t => t.status === 'pending' && !t.owner && !isBlocked(this.state, t))
        .filter(t => !opts.kinds || opts.kinds.includes(t.kind))
        .sort((a, b) => (b.priority - a.priority) || a.createdAt - b.createdAt)
      const pick = candidates[0]
      if (!pick) {return null}
      const r = claimInState(this.state, pick.id, member, now)
      if (r.error) {return null}
      this.state = r.state
      this.persist()
      return r.task!
    })
  }

  /** 开始执行（claimed → running）+ 心跳 */
  async start(taskId: string, member: string): Promise<BoardTask> {
    return chain(() => this._mutate(taskId, member, t => {
      t.status = 'running'; t.heartbeatAt = Date.now()
    }))
  }

  /** 心跳（长时间任务定期续租） */
  async heartbeat(taskId: string, member: string): Promise<void> {
    return chain(() => {
      const t = this.state.tasks.find(x => x.id === taskId)
      if (!t || t.owner !== member) {throw new Error('任务不存在或不属于该成员')}
      t.heartbeatAt = Date.now(); t.updatedAt = Date.now()
      this.persist()
    })
  }

  /** 完成 */
  async complete(taskId: string, member: string, result: string): Promise<BoardTask> {
    return chain(() => this._mutate(taskId, member, t => {
      t.status = 'done'; t.result = result; t.completedAt = Date.now(); t.updatedAt = Date.now()
    }))
  }

  /** 失败 */
  async fail(taskId: string, member: string, error: string): Promise<BoardTask> {
    return chain(() => this._mutate(taskId, member, t => {
      t.status = 'failed'; t.error = error; t.updatedAt = Date.now()
    }))
  }

  /** 标记被阻塞（依赖未就绪/外部问题） */
  async block(taskId: string, member: string, reason: string): Promise<BoardTask> {
    return chain(() => this._mutate(taskId, member, t => {
      t.status = 'blocked'; t.error = reason; t.updatedAt = Date.now()
    }))
  }

  /** 释放认领（退回任务池） */
  async release(taskId: string, member: string): Promise<BoardTask> {
    return chain(() => this._mutate(taskId, member, t => {
      t.status = 'pending'; t.owner = null; t.claimedAt = null; t.heartbeatAt = null; t.updatedAt = Date.now()
    }))
  }

  private _mutate(taskId: string, member: string, fn: (t: BoardTask) => void): BoardTask {
    const t = this.state.tasks.find(x => x.id === taskId)
    if (!t) {throw new Error(`任务 ${taskId} 不存在`)}
    if (t.owner && t.owner !== member) {throw new Error(`任务 ${taskId} 属于 ${t.owner}，${member} 无权修改`)}
    const from = t.status
    fn(t)
    if (t.status !== from) {
      this.state.history = appendHistory(this.state.history, {
        ts: Date.now(), taskId: t.id, title: t.title, from, to: t.status, by: member,
      })
    }
    this.persist()
    return t
  }

  /** 查询 */
  list(filter: { status?: BoardTaskStatus; owner?: string; kind?: BoardTaskKind } = {}): BoardTask[] {
    return this.state.tasks
      .filter(t => !filter.status || t.status === filter.status)
      .filter(t => !filter.owner || t.owner === filter.owner)
      .filter(t => !filter.kind || t.kind === filter.kind)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  /** 可立即领取的任务（依赖全部完成；待批准任务不在其中） */
  ready(): BoardTask[] {
    return this.state.tasks
      .filter(t => t.status === 'pending' && !t.owner && !isBlocked(this.state, t))
      .sort((a, b) => (b.priority - a.priority) || a.createdAt - b.createdAt)
  }

  /** v3.30 状态变更历史（拓扑回放用） */
  getHistory(since = 0): BoardEvent[] {
    return since ? this.state.history.filter(e => e.ts > since) : this.state.history
  }

  /** 泳道快照（UI 用） */
  snapshot(): {
    lanes: Record<BoardTaskStatus, BoardTask[]>
    counts: Record<BoardTaskStatus, number>
    total: number
  } {
    const lanes: Record<BoardTaskStatus, BoardTask[]> = {
      pending: [], pending_approval: [], claimed: [], running: [],
      blocked: [], done: [], failed: [],
    }
    for (const t of this.state.tasks) {lanes[t.status].push(t)}
    return {
      lanes,
      counts: {
        pending: lanes.pending.length,
        pending_approval: lanes.pending_approval.length,
        claimed: lanes.claimed.length,
        running: lanes.running.length,
        blocked: lanes.blocked.length,
        done: lanes.done.length,
        failed: lanes.failed.length,
      },
      total: this.state.tasks.length,
    }
  }

  /** v3.33 崩溃恢复：重启后回收孤儿任务（force=true 回收全部 claimed/running） */
  async reapOrphans(force = false, staleMs = STALE_MS): Promise<string[]> {
    return chain(() => {
      const r = reapOrphansInState(this.state, Date.now(), { force, staleMs })
      this.state = r.state
      if (r.reaped.length) {this.persist()}
      return r.reaped
    })
  }

  /** 清理已完成超过 keepMs 的任务（默认 7 天） */
  async prune(keepMs = 7 * 24 * 3600 * 1000): Promise<number> {
    return chain(() => {
      const cutoff = Date.now() - keepMs
      const before = this.state.tasks.length
      this.state.tasks = this.state.tasks.filter(t =>
        !(t.status === 'done' && t.completedAt && t.completedAt < cutoff))
      const removed = before - this.state.tasks.length
      if (removed > 0) {this.persist()}
      return removed
    })
  }
}

// ═══════════════════════════════════════════════════════════
// 单例
// ═══════════════════════════════════════════════════════════

let _instance: SharedBoardStore | null = null

function defaultPath(): string {
  const base = app?.getPath ? app.getPath('userData') : process.cwd()
  return path.join(base, 'team', 'shared-board.json')
}

export function getSharedBoard(filepath?: string): SharedBoardStore {
  if (!_instance || filepath) {
    _instance = new SharedBoardStore(filepath || defaultPath())
  }
  return _instance
}
