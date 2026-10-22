// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// dayreplay/dayReplay.ts — 一天回放聚合服务
//
// 【设计原则】
//   1. 纯聚合：不主动抓数据，buildDailyReplay() 时从各适配器「拉」当天数据。
//   2. 可注入：测试里塞假账本/假看板，生产默认适配器懒加载真实模块
//      （require 放函数体内，测试环境 import 本文件不会拉起 electron）。
//   3. 诚实：数据源缺一块就缺一块，对应统计保持 0 / 时间线不编造。
//
// 【数据源对应】
//   ledger   → billing/usageLedger.ts（LLM 花费/轮次/token）
//   commands → tools/impl/sandboxAudit.ts（沙箱玻璃房命令审计，内存环形 200 条）
//   projects → orchestration/taskBoard.ts（任务看板，内存态）
//   interns  → orchestration/internPool.ts（临时工池，内存态）
//   events   → 本模块环形缓冲：集成层把事件总线（桌宠/系统/待办）转发进来
// ============================================================

import type {
  DailyReplay,
  TimelineItem,
  TimelineKind,
} from './types'

// ═══════════════════════════════════════════════════════════
// 可识别的日期错误
// ═══════════════════════════════════════════════════════════

export class DayReplayError extends Error {
  code: 'E_DAYREPLAY_BAD_DATE'
  constructor(message: string) {
    super(message)
    this.name = 'DayReplayError'
    this.code = 'E_DAYREPLAY_BAD_DATE'
  }
}

// ═══════════════════════════════════════════════════════════
// 适配器形状（结构化类型，不硬依赖 electron 模块）
// ═══════════════════════════════════════════════════════════

/** 与 UsageRecordRow 对齐的最小形状 */
export interface LlmUsageRowLike {
  ts: number
  provider: string
  model: string
  purpose: string
  agentId?: string
  promptTokens: number
  completionTokens: number
  cost: number
  success: boolean
  estimated?: boolean
}

/** 与 SandboxAuditEntry 对齐的最小形状 */
export interface CommandAuditLike {
  /** ISO 时间戳 */
  at: string
  command: string
  /** passed | degraded | blocked | approved */
  disposition?: string
  source?: string
}

export interface TaskLike {
  title: string
  status: string
  assignTo?: string
  createdAt: string
  startedAt?: string | null
  completedAt?: string | null
  elapsedMs?: number | null
  result?: string | null
  error?: string | null
}

export interface ProjectLike {
  name: string
  createdAt: string
  tasks: TaskLike[]
}

export interface InternLike {
  id: string
  name: string
  owner: string
  status: string
  createdAt: string
  completedAt?: string | null
  taskCount?: number
}

export interface DayReplayAdapters {
  ledger?: { queryRange(startTs: number, endTs: number): LlmUsageRowLike[] }
  commands?: { list(): CommandAuditLike[] }
  projects?: { getAllProjects(): ProjectLike[] }
  interns?: { getAll(): InternLike[] }
  now?: () => number
}

// ═══════════════════════════════════════════════════════════
// 本地时区日期工具
// ═══════════════════════════════════════════════════════════

/** 本地时区日期键：YYYY-MM-DD */
export function localDateKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 解析日期键 → [本地 0 点, 次日 0 点) 的半开区间。
 * 格式非法 / 不是真实日历日 → 抛 DayReplayError（code: E_DAYREPLAY_BAD_DATE）。
 */
export function parseDayRange(dateKey: string): { start: number; endExclusive: number } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    throw new DayReplayError(`非法日期格式: "${dateKey}"，需要 YYYY-MM-DD`)
  }
  const [y, m, d] = dateKey.split('-').map(Number)
  // 校验真实日历日：new Date(2026, 1, 30) 会溢出成 3/2，必须拦住
  const probe = new Date(y, m - 1, d)
  if (probe.getFullYear() !== y || probe.getMonth() !== m - 1 || probe.getDate() !== d) {
    throw new DayReplayError(`不是真实存在的日期: "${dateKey}"`)
  }
  return {
    start: new Date(y, m - 1, d, 0, 0, 0, 0).getTime(),
    endExclusive: new Date(y, m - 1, d + 1, 0, 0, 0, 0).getTime(),
  }
}

function inDay(ts: number, start: number, endExclusive: number): boolean {
  return ts >= start && ts < endExclusive
}

/** ISO 字符串 → epoch ms；非法输入返回 NaN */
function isoTs(iso: string | null | undefined): number {
  if (!iso) {return NaN}
  const t = new Date(iso).getTime()
  return Number.isNaN(t) ? NaN : t
}

// ═══════════════════════════════════════════════════════════
// filesChanged best-effort：从命令文本里挖 git 文件操作
// ═══════════════════════════════════════════════════════════

function collectPathTokens(rest: string, out: Set<string>): void {
  // 命令可能后续接 && / ; / |，先截断
  const head = rest.split(/(?:&&|;|\|)/)[0]
  for (const tok of head.split(/\s+/)) {
    const t = tok.trim().replace(/^["']|["']$/g, '')
    if (!t || t.startsWith('-')) {continue}
    // 只要像文件/路径的 token：含分隔符或带扩展名
    if (/[\\/.]/.test(t)) {out.add(t)}
  }
}

/** best-effort：从一条命令文本里提取 git add/rm/checkout 涉及的文件路径 */
export function extractGitFiles(command: string): string[] {
  const files = new Set<string>()
  for (const line of String(command || '').split(/\r?\n/)) {
    const t = line.trim()
    if (!t) {continue}
    let m = t.match(/(?:^|[\s;&|])git\s+add\s+(.+)/i)
    if (m) {collectPathTokens(m[1], files); continue}
    m = t.match(/(?:^|[\s;&|])git\s+rm\s+(.+)/i)
    if (m) {collectPathTokens(m[1], files); continue}
    m = t.match(/(?:^|[\s;&|])git\s+checkout\s+(.+)/i)
    if (m) {
      // checkout 的文件在 -- 之后；前面是分支名，不能误收
      const dash = m[1].indexOf('--')
      if (dash >= 0) {collectPathTokens(m[1].slice(dash + 2), files)}
    }
  }
  return [...files]
}

// ═══════════════════════════════════════════════════════════
// 服务主体
// ═══════════════════════════════════════════════════════════

/** 集成层通过事件总线转发进来的条目（桌宠 / 系统 / 待办） */
export interface RecordedDayEvent {
  ts?: number
  kind: TimelineKind
  title: string
  detail?: string
  actor?: string
}

export interface DayReplayService {
  buildDailyReplay(date?: string): DailyReplay
  renderReplayMarkdown(replay: DailyReplay): string
  renderReplayText(replay: DailyReplay): string
  /** 接收一条运行时事件（pet/todo/system），进环形缓冲，供回放聚合 */
  recordEvent(e: RecordedDayEvent): void
}

const MAX_RECORDED_EVENTS = 500

const PURPOSE_LABEL: Record<string, string> = {
  chat: '用户对话',
  proactive: '主动搭话',
  social: '社交动态',
  review: '审查',
  decision: '决策',
  ritual: '仪式',
  delegate: '委托子任务',
  other: '其他',
}

const DISPOSITION_LABEL: Record<string, string> = {
  passed: '放行',
  degraded: '降级执行',
  blocked: '已拦截',
  approved: '人工批准',
}

export function actorLabel(a?: string): string {
  switch (a) {
    case 'lumina': return '老大'
    case 'yak': return 'Yak'
    case 'recha': return '热茶'
    default: return a || '主对话'
  }
}

export function createDayReplayService(adapters: DayReplayAdapters = {}): DayReplayService {
  const now = adapters.now ?? (() => Date.now())
  const recorded: TimelineItem[] = []

  function safeList<T>(fn: () => T[], fallback: T[] = []): T[] {
    try {return fn()} catch {return fallback}
  }

  function buildDailyReplay(date?: string): DailyReplay {
    const dateKey = date ?? localDateKey(now())
    const { start, endExclusive } = parseDayRange(dateKey)
    const items: TimelineItem[] = []
    const stats: DailyReplay['stats'] = {
      commands: 0, filesChanged: 0, turns: 0,
      delegates: 0, llmCalls: 0,
      costYuan: 0, promptTokens: 0, completionTokens: 0,
      byAgent: {}, byPurpose: {},
    }
    const allFiles = new Set<string>()

    // ── 1. LLM 账本 ─────────────────────────────────────
    const rows = adapters.ledger
      ? safeList(() => adapters.ledger!.queryRange(start, endExclusive - 1))
      : []
    for (const r of rows) {
      if (!inDay(r.ts, start, endExclusive)) {continue}
      stats.llmCalls++
      if (r.success) {stats.turns++}
      stats.costYuan += Number(r.cost) || 0
      stats.promptTokens += Number(r.promptTokens) || 0
      stats.completionTokens += Number(r.completionTokens) || 0
      const agentKey = r.agentId || '主对话'
      stats.byAgent[agentKey] = (stats.byAgent[agentKey] || 0) + 1
      const purposeKey = r.purpose || 'other'
      stats.byPurpose[purposeKey] = (stats.byPurpose[purposeKey] || 0) + 1
      items.push({
        ts: r.ts,
        kind: 'llm',
        title: `${PURPOSE_LABEL[purposeKey] ?? purposeKey} · ${r.model || '未知模型'}`,
        detail: `${r.success ? '成功' : '失败'} · prompt ${Number(r.promptTokens) || 0} + 输出 ${Number(r.completionTokens) || 0} tokens`,
        actor: r.agentId || 'lumina',
        meta: { provider: r.provider, estimated: !!r.estimated },
      })
    }

    // ── 2. 命令审计 ─────────────────────────────────────
    const cmds = adapters.commands ? safeList(() => adapters.commands!.list()) : []
    for (const c of cmds) {
      const ts = isoTs(c.at)
      if (Number.isNaN(ts) || !inDay(ts, start, endExclusive)) {continue}
      stats.commands++
      const files = extractGitFiles(c.command)
      if (files.length > 0) {
        for (const f of files) {allFiles.add(f)}
        items.push({
          ts,
          kind: 'file',
          title: `git 变更 ${files.length} 个文件`,
          filesChanged: files,
          detail: c.command.slice(0, 120),
        })
      }
      items.push({
        ts,
        kind: 'command',
        title: String(c.command).slice(0, 80),
        detail: c.disposition ? DISPOSITION_LABEL[c.disposition] ?? c.disposition : undefined,
        meta: { source: c.source ?? 'shell_exec' },
      })
    }
    stats.filesChanged = allFiles.size

    // ── 3. 任务看板 ─────────────────────────────────────
    const projects = adapters.projects ? safeList(() => adapters.projects!.getAllProjects()) : []
    for (const p of projects) {
      for (const t of p.tasks ?? []) {
        const createdTs = isoTs(t.createdAt)
        const doneTs = isoTs(t.completedAt)
        const createdIn = !Number.isNaN(createdTs) && inDay(createdTs, start, endExclusive)
        const doneIn = !Number.isNaN(doneTs) && inDay(doneTs, start, endExclusive)
        if (!createdIn && !doneIn) {continue}
        const ts = doneIn ? doneTs : createdTs
        const status = t.status || 'pending'
        let title: string
        if (status === 'done') {title = `完成任务：${t.title}`}
        else if (status === 'failed') {title = `任务失败：${t.title}`}
        else if (status === 'blocked') {title = `任务卡住：${t.title}`}
        else if (status === 'running') {title = `开始干活：${t.title}`}
        else {title = `认领任务：${t.title}`}
        items.push({
          ts,
          kind: 'task',
          title,
          actor: t.assignTo,
          detail: t.elapsedMs ? `耗时 ${Math.round(t.elapsedMs / 1000)}s` : undefined,
          meta: { project: p.name },
        })
      }
    }

    // ── 4. 临时工（委托） ────────────────────────────────
    const interns = adapters.interns ? safeList(() => adapters.interns!.getAll()) : []
    for (const it of interns) {
      const ts = isoTs(it.createdAt)
      if (Number.isNaN(ts) || !inDay(ts, start, endExclusive)) {continue}
      stats.delegates++
      items.push({
        ts,
        kind: 'delegate',
        title: `招来临时工 ${it.name}`,
        actor: it.owner || 'lumina',
        detail: `${actorLabel(it.owner)} 派出的帮手，状态 ${it.status}`,
      })
    }

    // ── 5. 运行时事件缓冲（pet / todo / system） ──────────
    for (const e of recorded) {
      if (inDay(e.ts, start, endExclusive)) {items.push({ ...e })}
    }

    // ── 排序 + 收口 ──────────────────────────────────────
    items.sort((a, b) => a.ts - b.ts)
    stats.costYuan = Math.round(stats.costYuan * 10_000) / 10_000
    return { date: dateKey, items, stats, generatedAt: now() }
  }

  // ── 渲染（摘要 + 紧凑回放明细；空日诚实输出） ─────────

  function hourMin(ts: number): string {
    const d = new Date(ts)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }

  function render(replay: DailyReplay, mode: 'markdown' | 'text'): string {
    const s = replay.stats
    const isMd = mode === 'markdown'
    const h1 = isMd ? `# 这一天 · ${replay.date}` : `这一天 · ${replay.date}`
    const dash = isMd ? `- ` : `· `
    const head = (t: string) => (isMd ? `## ${t}` : `【${t}】`)

    if (replay.items.length === 0 && s.commands === 0 && s.llmCalls === 0) {
      return `${h1}\n\n这一天没有活动记录。`
    }

    const lines: string[] = [h1, '']

    // 概览
    const overview =
      `花费 ¥${s.costYuan.toFixed(4)} ｜ 跑了 ${s.turns} 轮（共 ${s.llmCalls} 次调用）` +
      ` ｜ prompt ${s.promptTokens} + 输出 ${s.completionTokens} tokens`
    lines.push(overview, '')

    // 团队
    lines.push(head('团队'))
    lines.push(`${dash}委托临时工 ${s.delegates} 人`)
    const taskItems = replay.items.filter(i => i.kind === 'task')
    if (taskItems.length > 0) {
      const done = taskItems.filter(i => i.title.startsWith('完成任务')).length
      lines.push(`${dash}任务节点 ${taskItems.length} 个（完成 ${done}）`)
    }
    lines.push('')

    // 干活痕迹
    lines.push(head('干活痕迹'))
    lines.push(`${dash}执行命令 ${s.commands} 条`)
    lines.push(`${dash}变更文件 ${s.filesChanged} 个`)
    lines.push('')

    // 谁在出力
    const agentKeys = Object.keys(s.byAgent)
    if (agentKeys.length > 0) {
      lines.push(head('谁在出力'))
      for (const k of agentKeys.sort((a, b) => s.byAgent[b] - s.byAgent[a])) {
        lines.push(`${dash}${actorLabel(k)}：${s.byAgent[k]} 轮`)
      }
      lines.push('')
    }

    // 紧凑回放明细
    lines.push(isMd ? `---\n回放明细（${replay.items.length} 条）` : `回放明细（${replay.items.length} 条）`)
    for (const i of replay.items) {
      lines.push(`${hourMin(i.ts)}  ${i.title}`)
    }
    return lines.join('\n')
  }

  return {
    buildDailyReplay,
    renderReplayMarkdown: (r: DailyReplay) => render(r, 'markdown'),
    renderReplayText: (r: DailyReplay) => render(r, 'text'),
    recordEvent(e: RecordedDayEvent): void {
      const item: TimelineItem = {
        ts: e.ts ?? now(),
        kind: e.kind,
        title: e.title,
        detail: e.detail,
        actor: e.actor,
      }
      recorded.push(item)
      if (recorded.length > MAX_RECORDED_EVENTS) {recorded.shift()}
    },
  }
}

// ═══════════════════════════════════════════════════════════
// 进程级单例：默认适配器懒加载真实模块
// ═══════════════════════════════════════════════════════════

let singleton: DayReplayService | null = null

/**
 * 取一天回放服务。未初始化时用默认适配器懒加载真实数据源：
 * 任何一个数据源挂掉都静默降级为空，绝不影响主流程。
 */
export function getDayReplay(): DayReplayService {
  if (!singleton) {
    singleton = createDayReplayService({
      ledger: {
        queryRange: (startTs, endTs) => {
          try {
            const ledger = require('../billing/usageLedger').getUsageLedger()
            return ledger.queryRange(startTs, endTs)
          } catch {return []}
        },
      },
      commands: {
        list: () => {
          try {
            const audit = require('../tools/impl/sandboxAudit')
            return audit.getAuditLog(200)
          } catch {return []}
        },
      },
      projects: {
        getAllProjects: () => {
          try {
            return require('../orchestration/taskBoard').getTaskBoard().getAllProjects()
          } catch {return []}
        },
      },
      interns: {
        getAll: () => {
          try {
            const pool = require('../orchestration/internPool')
            const out: InternLike[] = []
            for (const owner of ['lumina', 'yak', 'recha']) {
              try {out.push(...pool.getInternPool(owner).getAll())} catch { /* 该 owner 池未建 */ }
            }
            return out
          } catch {return []}
        },
      },
    })
  }
  return singleton
}

/** 测试钩子：重置单例 */
export function __resetDayReplay(): void {
  singleton = null
}
