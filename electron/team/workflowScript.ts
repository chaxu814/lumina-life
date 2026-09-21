// ============================================================
// workflowScript.ts — v3.30 模型现写 Workflow 脚本引擎（P2，对标 cc-haha #9）
//
// cc-haha 让 Team Lead 直接写 Python workflow 脚本编排多步任务。
// Lumina 不在 Electron 主进程 eval 任意 JS（安全红线），改为让模型写
// 声明式 JSON DSL，由确定性调度器执行：
//
//   {
//     "name": "竞品调研",
//     "mode": "pipeline",        // pipeline=按 after 依赖逐层；parallel=尽量并行（上限4）
//     "steps": [
//       { "id": "search", "role": "search", "task": "搜 X 的资料" },
//       { "id": "summary", "role": "research", "task": "汇总：$search.result", "after": ["search"] }
//     ]
//   }
//
// 特性：
//   - $步骤id.result 在上一步完成后替换为其结果
//   - v3.31 when 条件：引用上游结果 contains/equals/truthy（可 not 取反），不满足自动 skipped
//   - v3.31 retry 有界重试：maxAttempts ≤ 5，until 满足即停；异常与结果不达标都计入重试
//   - journal 持久化（userData/team/workflows/<id>.json），崩溃后 resume 跳过已完成步骤
//   - 轻量 schema 校验（无第三方依赖，纯函数可单测）
//   - 调度器与执行器解耦：生产用 hireWorker，测试可注入 fake runner
// ============================================================

import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'
export type WorkflowStatus = 'ready' | 'running' | 'done' | 'failed' | 'paused'
export type CondOp = 'contains' | 'equals' | 'truthy'

/** v3.31 步骤条件：针对上游步骤结果判定（when 引用） */
export interface StepCondition {
  /** 被引用的步骤 id（隐式依赖，无需再写进 after） */
  step: string
  op: CondOp
  /** contains / equals 需要给出期望值 */
  value?: string
  /** 取反：条件为 true 时跳过本步骤 */
  not?: boolean
}

/** v3.31 有界重试 */
export interface StepRetry {
  /** 总尝试次数（含首次），默认 2，clamp 1..5 */
  maxAttempts?: number
  /** 结果满足该判定即停止重试；不写则只在异常时重试 */
  until?: { op: 'contains' | 'equals'; value: string }
  /** 重试间隔（ms），默认 400 */
  delayMs?: number
}

export interface WorkflowStep {
  id: string
  /** 内置工种或 agents/*.md 自定义工种 */
  role?: string
  task: string
  /** 依赖步骤：全部完成后才执行 */
  after?: string[]
  /** v3.31 执行条件：不满足时本步骤（及其下游）标 skipped */
  when?: StepCondition
  /** v3.31 有界重试 */
  retry?: StepRetry
  /** 并行模式下的伙伴提示（调度器实际以 after 为准，此字段仅可读） */
  parallelWith?: string[]
  /** 该步骤超时（ms） */
  timeoutMs?: number
}

export interface WorkflowDef {
  name: string
  mode?: 'pipeline' | 'parallel'
  concurrency?: number
  steps: WorkflowStep[]
}

export interface StepRecord {
  id: string
  status: StepStatus
  result?: string
  error?: string
  workerId?: string
  /** v3.31 实际尝试次数（retry 计数） */
  attempts?: number
  startedAt?: number
  finishedAt?: number
}

export interface WorkflowJournal {
  id: string
  name: string
  mode: 'pipeline' | 'parallel'
  concurrency: number
  status: WorkflowStatus
  def: WorkflowDef
  steps: Record<string, StepRecord>
  createdAt: number
  updatedAt: number
  error?: string
}

// ═══════════════════════════════════════════════════════════
// 校验（纯函数）
// ═══════════════════════════════════════════════════════════

const ID_RE = /^[A-Za-z0-9_\-]+$/

export function validateWorkflow(input: any): { ok: boolean; errors: string[]; def?: WorkflowDef } {
  const errors: string[] = []
  if (!input || typeof input !== 'object') {return { ok: false, errors: ['workflow 必须是 JSON 对象'] }}
  if (!input.name || typeof input.name !== 'string') {errors.push('缺少 name（字符串）')}
  const mode = input.mode || 'pipeline'
  if (mode !== 'pipeline' && mode !== 'parallel') {errors.push('mode 只能是 pipeline 或 parallel')}
  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    return { ok: false, errors: [...errors, 'steps 必须是非空数组'] }
  }
  if (input.steps.length > 20) {errors.push('steps 最多 20 步')}
  const ids = new Set<string>()
  for (const [i, s] of input.steps.entries()) {
    const ctx = `steps[${i}]`
    if (!s || typeof s !== 'object') {errors.push(`${ctx} 不是对象`); continue}
    if (!s.id || typeof s.id !== 'string' || !ID_RE.test(s.id)) {
      errors.push(`${ctx}.id 非法（字母数字下划线横线）`)
    } else if (ids.has(s.id)) {
      errors.push(`${ctx}.id "${s.id}" 重复`)
    } else {ids.add(s.id)}
    if (!s.task || typeof s.task !== 'string') {errors.push(`${ctx}.task 必须是非空字符串`)}
    if (s.after !== undefined) {
      if (!Array.isArray(s.after) || s.after.some((a: any) => typeof a !== 'string')) {
        errors.push(`${ctx}.after 必须是字符串数组`)
      }
    }
    // v3.31 when 条件校验
    if (s.when !== undefined) {
      const w = s.when
      if (!w || typeof w !== 'object') {
        errors.push(`${ctx}.when 必须是对象`)
      } else {
        if (!w.step || typeof w.step !== 'string') {errors.push(`${ctx}.when.step 必须是引用的步骤 id`)}
        if (!['contains', 'equals', 'truthy'].includes(w.op)) {
          errors.push(`${ctx}.when.op 只能是 contains / equals / truthy`)
        }
        if ((w.op === 'contains' || w.op === 'equals') && typeof w.value !== 'string') {
          errors.push(`${ctx}.when.value 必须是字符串（${w.op} 判定需要期望值）`)
        }
      }
    }
    // v3.31 retry 校验
    if (s.retry !== undefined) {
      const r = s.retry
      if (!r || typeof r !== 'object') {
        errors.push(`${ctx}.retry 必须是对象`)
      } else {
        if (r.maxAttempts !== undefined) {
          const n = Number(r.maxAttempts)
          if (!Number.isInteger(n) || n < 1 || n > 5) {
            errors.push(`${ctx}.retry.maxAttempts 必须是 1..5 的整数`)
          }
        }
        if (r.until !== undefined) {
          const u = r.until
          if (!u || typeof u !== 'object' || !['contains', 'equals'].includes(u.op) || typeof u.value !== 'string') {
            errors.push(`${ctx}.retry.until 必须是 { op: 'contains'|'equals', value: string }`)
          }
        }
        if (r.delayMs !== undefined && (typeof r.delayMs !== 'number' || r.delayMs < 0 || r.delayMs > 60000)) {
          errors.push(`${ctx}.retry.delayMs 必须是 0..60000 的数字`)
        }
      }
    }
  }
  // 依赖必须存在、且不能成环（Kahn 拓扑检测）；when.step 是隐式依赖
  const afterMap = new Map<string, string[]>()
  for (const s of input.steps) {
    if (s?.id) {
      const raw = [...(Array.isArray(s.after) ? s.after : []), ...(s.when?.step ? [s.when.step] : [])]
      const deps = [...new Set(raw)].filter((a: string) => {
        if (!ids.has(a)) {errors.push(`步骤 ${s.id} 依赖不存在的步骤 ${a}`); return false}
        return true
      })
      afterMap.set(s.id, deps)
    }
  }
  const indeg = new Map<string, number>()
  ids.forEach(id => indeg.set(id, 0))
  afterMap.forEach((deps, id) => indeg.set(id, deps.length))
  let visited = 0
  const queue = [...indeg.entries()].filter(([, d]) => d === 0).map(([id]) => id)
  while (queue.length) {
    const cur = queue.shift()!
    visited++
    for (const [id, deps] of afterMap) {
      if (deps.includes(cur)) {
        indeg.set(id, (indeg.get(id) || 1) - 1)
        if (indeg.get(id) === 0) {queue.push(id)}
      }
    }
  }
  if (visited !== ids.size) {errors.push('步骤依赖存在环，无法调度')}

  if (errors.length) {return { ok: false, errors }}
  return {
    ok: true,
    errors: [],
    def: {
      name: String(input.name),
      mode,
      concurrency: Math.min(Math.max(Number(input.concurrency) || 4, 1), 8),
      steps: input.steps.map((s: any) => ({
        id: s.id,
        role: s.role ? String(s.role) : undefined,
        task: String(s.task),
        after: s.after ? s.after.map(String) : undefined,
        when: s.when && typeof s.when === 'object' ? {
          step: String(s.when.step),
          op: s.when.op as CondOp,
          value: s.when.value !== undefined ? String(s.when.value) : undefined,
          not: !!s.when.not,
        } : undefined,
        retry: s.retry && typeof s.retry === 'object' ? {
          maxAttempts: s.retry.maxAttempts !== undefined
            ? Math.min(Math.max(Number(s.retry.maxAttempts), 1), 5) : undefined,
          until: s.retry.until && typeof s.retry.until === 'object' ? {
            op: s.retry.until.op as 'contains' | 'equals',
            value: String(s.retry.until.value),
          } : undefined,
          delayMs: s.retry.delayMs !== undefined ? Number(s.retry.delayMs) : undefined,
        } : undefined,
        parallelWith: Array.isArray(s.parallelWith) ? s.parallelWith.map(String) : undefined,
        timeoutMs: s.timeoutMs ? Number(s.timeoutMs) : undefined,
      })),
    },
  }
}

// ═══════════════════════════════════════════════════════════
// 模板替换（纯函数）
// ═══════════════════════════════════════════════════════════

/** 把任务文本里的 $id.result 替换为已完成步骤的结果 */
export function substituteReferences(task: string, steps: Record<string, StepRecord>): string {
  return task.replace(/\$([A-Za-z0-9_\-]+)\.result/g, (m, id) => {
    const rec = steps[id]
    if (rec && rec.status === 'done') {return rec.result || ''}
    return m // 未完成 → 原样保留，交由上层报错
  })
}

// ═══════════════════════════════════════════════════════════
// 调度器（执行器可注入，便于单测）
// ═══════════════════════════════════════════════════════════

export type StepExecutor = (step: WorkflowStep, preparedTask: string) => Promise<{ workerId?: string; result: string }>

export interface RunHooks {
  onStepStart?: (id: string) => void
  onStepDone?: (id: string, rec: StepRecord) => void
  onStepFail?: (id: string, error: string) => void
  onPersist?: () => void
}

/** 有效依赖：after 显式依赖 + when.step 隐式依赖 */
function stepDeps(s: WorkflowStep): string[] {
  const deps = [...(s.after || [])]
  if (s.when?.step) {deps.push(s.when.step)}
  return [...new Set(deps)]
}

/** v3.31 条件判定（纯函数，可单测）：对文本结果做 contains/equals/truthy */
export function evalCondition(text: string, c: StepCondition): boolean {
  const t = text ?? ''
  let hit: boolean
  if (c.op === 'contains') {
    hit = t.includes(c.value ?? '')
  } else if (c.op === 'equals') {
    hit = t.trim() === (c.value ?? '')
  } else {
    // truthy：非空且不是常见否定词
    hit = t.trim().length > 0 && !/^(false|0|null|none|no|n\/a|失败|未找到|空)$/i.test(t.trim())
  }
  return c.not ? !hit : hit
}

/** 找环/缺失外的「可执行」步骤：未开始且依赖（含 when.step）全 done */
function readySteps(def: WorkflowDef, journal: WorkflowJournal): WorkflowStep[] {
  return def.steps.filter(s => {
    const rec = journal.steps[s.id]
    if (rec && rec.status !== 'pending') {return false}
    return stepDeps(s).every(d => journal.steps[d]?.status === 'done')
  })
}

/** 依赖失败/被跳过的步骤标记 skipped */
function markSkipped(def: WorkflowDef, journal: WorkflowJournal) {
  let changed = true
  while (changed) {
    changed = false
    for (const s of def.steps) {
      const rec = journal.steps[s.id]
      if (rec && rec.status !== 'pending') {continue}
      const deadDep = stepDeps(s).some(d => {
        const r = journal.steps[d]
        return r && (r.status === 'failed' || r.status === 'skipped')
      })
      if (deadDep) {
        journal.steps[s.id] = { id: s.id, status: 'skipped' }
        changed = true
      }
    }
  }
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/**
 * v3.31 执行单个步骤（含 when 判定与有界重试）。
 * - when 不满足 → skipped（不调用执行器）
 * - retry：异常或 until 不达标都计入尝试，最多 maxAttempts（≤5）
 */
async function executeStepWithRetry(
  step: WorkflowStep,
  prepared: string,
  execute: StepExecutor,
  rec: StepRecord,
  journal: WorkflowJournal,
): Promise<'done' | 'failed' | 'skipped'> {
  // when 条件：引用上游结果；readySteps 已保证引用步骤 done，条件不满足直接跳过
  if (step.when) {
    const upstream = journal.steps[step.when.step]
    const text = upstream?.status === 'done' ? (upstream.result || '') : ''
    if (!evalCondition(text, step.when)) {
      return 'skipped'
    }
  }

  const maxAttempts = Math.min(Math.max(step.retry?.maxAttempts ?? 1, 1), 5)
  const delay = step.retry?.delayMs ?? 400
  let lastResult = ''
  let lastErr = ''
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    rec.attempts = attempt
    try {
      const out = await execute(step, prepared)
      lastResult = out.result
      const until = step.retry?.until
      const satisfied = !until
        || (until.op === 'contains' ? out.result.includes(until.value) : out.result.trim() === until.value)
      if (satisfied) {
        rec.result = out.result
        rec.workerId = out.workerId
        rec.error = undefined
        return 'done'
      }
      // 结果不达标：还有名额就重试
      lastErr = `retry.until 未满足（${until!.op} "${until!.value}"），第 ${attempt}/${maxAttempts} 次`
      if (attempt < maxAttempts) {await sleep(delay)}
    } catch (e: any) {
      lastErr = e?.message || String(e)
      if (attempt < maxAttempts) {await sleep(delay)}
    }
  }
  // 重试耗尽：保留最后一次结果（若有），标 failed
  if (lastResult) {rec.result = lastResult}
  rec.error = lastErr
  return 'failed'
}

/**
 * 执行/恢复执行一个工作流。
 * - journal 中已 done 的步骤直接跳过（断点续跑）
 * - pipeline：严格按 after 分层，同一层并发
 * - parallel：所有无依赖步骤立即并发，受 concurrency 限制
 */
export async function runJournal(
  journal: WorkflowJournal,
  execute: StepExecutor,
  hooks: RunHooks = {},
): Promise<WorkflowJournal> {
  const def = journal.def
  journal.status = 'running'

  // 初始化缺失步骤（恢复时保留旧记录）
  for (const s of def.steps) {
    if (!journal.steps[s.id]) {journal.steps[s.id] = { id: s.id, status: 'pending' }}
  }

  const persist = () => {
    journal.updatedAt = Date.now()
    hooks.onPersist?.()
  }

  const inflight = new Set<string>()
  while (true) {
    markSkipped(def, journal)
    let ready = readySteps(def, journal).filter(s => !inflight.has(s.id))
    if (def.mode === 'pipeline') {
      // pipeline：一次只跑当前层；若已在跑（同层并发）则不新增
      if (inflight.size === 0) {
        // 同层就是全部 ready
      } else {
        ready = []
      }
    } else {
      ready = ready.slice(0, Math.max(0, journal.concurrency - inflight.size))
    }

    if (ready.length === 0 && inflight.size === 0) {break}

    const batch = def.mode === 'parallel' ? ready : (inflight.size === 0 ? ready : [])
    await Promise.all(batch.map(async step => {
      inflight.add(step.id)
      const rec = journal.steps[step.id]
      rec.status = 'running'
      rec.startedAt = Date.now()
      hooks.onStepStart?.(step.id)
      persist()
      try {
        const prepared = substituteReferences(step.task, journal.steps)
        if (/\$[A-Za-z0-9_\-]+\.result/.test(prepared)) {
          throw new Error(`步骤 ${step.id} 引用了未完成步骤的结果`)
        }
        const outcome = await executeStepWithRetry(step, prepared, execute, rec, journal)
        rec.finishedAt = Date.now()
        if (outcome === 'skipped') {
          rec.status = 'skipped'
        } else if (outcome === 'done') {
          rec.status = 'done'
          hooks.onStepDone?.(step.id, rec)
        } else {
          rec.status = 'failed'
          hooks.onStepFail?.(step.id, rec.error || '')
        }
      } catch (e: any) {
        rec.status = 'failed'
        rec.error = e?.message || String(e)
        rec.finishedAt = Date.now()
        hooks.onStepFail?.(step.id, rec.error || '')
      } finally {
        inflight.delete(step.id)
        persist()
      }
    }))
  }

  const any = (pred: (r: StepRecord) => boolean) =>
    Object.values(journal.steps).some(pred)
  if (any(r => r.status === 'failed')) {
    journal.status = 'failed'
    journal.error = '存在失败步骤（已跳过其下游）'
  } else {
    journal.status = 'done'
  }
  persist()
  return journal
}

// ═══════════════════════════════════════════════════════════
// 持久化存储
// ═══════════════════════════════════════════════════════════

function workflowsDir(): string {
  const base = app?.getPath ? app.getPath('userData') : process.cwd()
  return path.join(base, 'team', 'workflows')
}

function emptyJournal(def: WorkflowDef, id: string): WorkflowJournal {
  const now = Date.now()
  const steps: Record<string, StepRecord> = {}
  for (const s of def.steps) {steps[s.id] = { id: s.id, status: 'pending' }}
  return {
    id, name: def.name, mode: def.mode || 'pipeline', concurrency: def.concurrency || 4,
    status: 'ready', def, steps, createdAt: now, updatedAt: now,
  }
}

export class WorkflowStore {
  constructor(public readonly dir: string = workflowsDir()) {
    fs.mkdirSync(dir, { recursive: true })
  }

  private file(id: string): string {
    return path.join(this.dir, `${id.replace(/[^A-Za-z0-9_\-]/g, '_')}.json`)
  }

  /** 创建（含校验）。不执行。 */
  create(def: WorkflowDef, id?: string): WorkflowJournal {
    const v = validateWorkflow(def)
    if (!v.ok) {throw new Error(`workflow 校验失败：${v.errors.join('；')}`)}
    const jid = id || `wf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
    const journal = emptyJournal(v.def!, jid)
    fs.writeFileSync(this.file(jid), JSON.stringify(journal, null, 2), 'utf-8')
    return journal
  }

  get(id: string): WorkflowJournal | null {
    try {
      const f = this.file(id)
      if (!fs.existsSync(f)) {return null}
      return JSON.parse(fs.readFileSync(f, 'utf-8'))
    } catch {return null}
  }

  list(): WorkflowJournal[] {
    try {
      const out: WorkflowJournal[] = []
      for (const f of fs.readdirSync(this.dir)) {
        if (!f.endsWith('.json')) {continue}
        try {out.push(JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf-8')))} catch { /* 跳过坏文件 */ }
      }
      return out.sort((a, b) => b.updatedAt - a.updatedAt)
    } catch {return []}
  }

  save(j: WorkflowJournal): void {
    j.updatedAt = Date.now()
    const tmp = this.file(j.id) + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(j, null, 2), 'utf-8')
    fs.renameSync(tmp, this.file(j.id))
  }
}

let _store: WorkflowStore | null = null
export function getWorkflowStore(): WorkflowStore {
  if (!_store) {_store = new WorkflowStore()}
  return _store
}
