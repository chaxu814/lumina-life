// ============================================================
// llmTrace.ts — 团队任务追踪（v3.33，对标 cc-haha task-notification / trace）
//
// cc-haha 前台任务超 120 秒自动转后台、每次模型请求有 trace 可查。
// 本模块先在「团队任务」这一层把账记全：每次临时工/自治任务的开始、结束、
// 耗时、模型分级、成功与否、失败原因，环形缓冲 + 当日汇总，供 UI/工具查询。
//
// 说明：这是任务级 trace（不逐 token 拦截 Provider）；Provider 级的
// prompt/token 明细留待后续在 LLMProvider 加 hook。
// ============================================================

import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'

export interface TraceEntry {
  id: number
  at: number
  /** start=开始 / end=结束 */
  phase: 'start' | 'end'
  /** hire=显式雇佣 / autonomy=自治自领取 / workflow=工作流 / cu_crew=CU 三人组 */
  source: 'hire' | 'autonomy' | 'workflow' | 'cu_crew'
  role: string
  workerId: string
  title: string
  modelTier: 'small' | 'strong' | 'unknown'
  /** 仅 end：耗时 ms */
  durationMs?: number
  ok?: boolean
  error?: string
  /** 是否超过长任务阈值（120s），用于提示自动后台化 */
  longRunning?: boolean
}

const TRACE_CAP = 500
export const LONG_TASK_MS = 120_000

export interface TraceState {
  seq: number
  entries: TraceEntry[]
}

// ═══════════════════════════════════════════════════════════
// 纯函数
// ═══════════════════════════════════════════════════════════

export function startEntryInState(
  state: TraceState,
  e: Omit<TraceEntry, 'id' | 'at' | 'phase'>,
  now = Date.now(),
): { state: TraceState; entry: TraceEntry } {
  const entry: TraceEntry = { ...e, id: ++state.seq, at: now, phase: 'start' }
  const entries = [...state.entries, entry]
  if (entries.length > TRACE_CAP) {entries.splice(0, entries.length - TRACE_CAP)}
  return { state: { seq: state.seq, entries }, entry }
}

export function endEntryInState(
  state: TraceState,
  ref: { workerId: string; role: string; title: string; source: TraceEntry['source'] },
  result: { ok: boolean; durationMs: number; error?: string; modelTier?: TraceEntry['modelTier'] },
  now = Date.now(),
): { state: TraceState; entry: TraceEntry } {
  const entry: TraceEntry = {
    id: ++state.seq,
    at: now,
    phase: 'end',
    source: ref.source,
    role: ref.role,
    workerId: ref.workerId,
    title: ref.title,
    modelTier: result.modelTier || 'unknown',
    durationMs: Math.round(result.durationMs),
    ok: result.ok,
    ...(result.error ? { error: result.error.slice(0, 500) } : {}),
    longRunning: result.durationMs > LONG_TASK_MS,
  }
  const entries = [...state.entries, entry]
  if (entries.length > TRACE_CAP) {entries.splice(0, entries.length - TRACE_CAP)}
  return { state: { seq: state.seq, entries }, entry }
}

export interface TraceSummary {
  total: number
  running: number
  ok: number
  fail: number
  longRunning: number
  avgDurationMs: number
  byRole: Record<string, { total: number; ok: number; fail: number }>
}

/** 从 end 条目汇总（start 条目仅用于 running 判定） */
export function summarizeInState(state: TraceState, since = 0): TraceSummary {
  const starts = state.entries.filter(e => e.phase === 'start' && e.at >= since)
  const ends = state.entries.filter(e => e.phase === 'end' && e.at >= since)
  const finishedWorkers = new Set(ends.map(e => e.workerId + '@' + e.title))
  const running = starts.filter(s => !finishedWorkers.has(s.workerId + '@' + s.title)).length
  const byRole: TraceSummary['byRole'] = {}
  let durSum = 0
  let longRunning = 0
  for (const e of ends) {
    const r = byRole[e.role] || (byRole[e.role] = { total: 0, ok: 0, fail: 0 })
    r.total += 1
    if (e.ok) {r.ok += 1} else {r.fail += 1}
    durSum += e.durationMs || 0
    if (e.longRunning) {longRunning += 1}
  }
  return {
    total: ends.length,
    running,
    ok: ends.filter(e => e.ok).length,
    fail: ends.filter(e => !e.ok).length,
    longRunning,
    avgDurationMs: ends.length ? Math.round(durSum / ends.length) : 0,
    byRole,
  }
}

// ═══════════════════════════════════════════════════════════
// 存储（内存环形 + 可选落盘）
// ═══════════════════════════════════════════════════════════

let _chain: Promise<unknown> = Promise.resolve()
function chain<T>(fn: () => T): Promise<T> {
  const run = _chain.then(() => fn(), () => fn())
  _chain = run.catch(() => undefined)
  return run
}

export class TaskTraceStore {
  private state: TraceState = { seq: 0, entries: [] }
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  constructor(public readonly filepath: string | null = null) {
    if (filepath) {
      try {
        fs.mkdirSync(path.dirname(filepath), { recursive: true })
        if (fs.existsSync(filepath)) {
          const raw = JSON.parse(fs.readFileSync(filepath, 'utf-8'))
          if (raw?.seq && Array.isArray(raw?.entries)) {this.state = { seq: raw.seq, entries: raw.entries }}
        }
      } catch (e) {
        console.warn('[llmTrace] 读取失败:', (e as Error)?.message)
      }
    }
  }

  private scheduleSave(): void {
    if (!this.filepath) {return}
    if (this.saveTimer) {clearTimeout(this.saveTimer)}
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      try {
        const tmp = this.filepath + '.tmp'
        fs.writeFileSync(tmp, JSON.stringify(this.state), 'utf-8')
        fs.renameSync(tmp, this.filepath!)
      } catch { /* ignore */ }
    }, 1000)
  }

  start(e: Omit<TraceEntry, 'id' | 'at' | 'phase'>): TraceEntry {
    const r = startEntryInState(this.state, e)
    this.state = r.state
    this.scheduleSave()
    return r.entry
  }

  end(ref: { workerId: string; role: string; title: string; source: TraceEntry['source'] },
    result: { ok: boolean; durationMs: number; error?: string; modelTier?: TraceEntry['modelTier'] }): TraceEntry {
    const r = endEntryInState(this.state, ref, result)
    this.state = r.state
    this.scheduleSave()
    return r.entry
  }

  list(limit = 100): TraceEntry[] {return this.state.entries.slice(-limit).reverse()}
  summary(since = 0): TraceSummary {return summarizeInState(this.state, since)}
}

let _instance: TaskTraceStore | null = null

function defaultPath(): string {
  const base = app?.getPath ? app.getPath('userData') : process.cwd()
  return path.join(base, 'team', 'task-trace.json')
}

export function getTaskTrace(filepath?: string): TaskTraceStore {
  if (!_instance || filepath) {
    _instance = new TaskTraceStore(filepath || defaultPath())
  }
  return _instance
}
