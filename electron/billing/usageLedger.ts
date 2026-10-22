// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// billing/usageLedger.ts — 统一 LLM 记账账本
//
// 【为什么要有它】
//   全应用 LLM 调用分散在 LLMProvider.call（聊天/主动/社交/委托）、
//   agentRunner 主 ReAct 循环、systemIpc（llm:chat）等多个出口。
//   旧的 DiagnosticsStore 只在内存环形缓冲里记 token 数（200 条即丢），
//   不区分用途、不算钱、不落盘。预算守护者要回答的第一个问题就是
//   「今天花了多少钱」——必须有一个持久、可聚合的唯一账本。
//
// 【收口原则】
//   账本本身不主动抓调用；两个 LLM 出口在结束时调 recordCall()。
//   记账失败绝不影响对话（try/catch 全兜住）。
//
// 【usage 诚实标注】
//   - 服务端返回 usage（prompt/completion tokens）→ 真实值，estimated=false
//   - usage 缺失 → 按字符数估算（复用 tokenEstimator 的中英混合启发式），
//     记录里必须标 estimated=true，UI 上显式标注「估算」。
//
// 【持久化】
//   SQLite（better-sqlite3），表 llm_usage_records，复用 lumina-memory.db
//   （与 RelationshipEventStore 同一模式：db 句柄注入、type-only import、
//    CREATE IF NOT EXISTS）。测试里注入内存 fake，不碰原生模块。
// ============================================================

import type { Database } from 'better-sqlite3'
import { lookupPrice, estimateCost, type PriceEntry } from './priceTable'
import { TokenEstimator } from '../tokenEstimator'

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

/** 用途标签：这通调用为什么发生 */
export type LlmPurpose =
  | 'chat'        // 用户主动对话（必需，预算最后才砍它）
  | 'proactive'   // 主动搭话 / 晨间简报
  | 'social'      // 社交引擎（朋友圈/群聊）
  | 'review'       // 审查（adversarial review）
  | 'decision'     // 决策服务
  | 'ritual'       // 仪式
  | 'delegate'     // 委托给子 Agent
  | 'other'

/** 一次 LLM 调用的记账输入（调用出口填） */
export interface UsageRecordInput {
  /** 提供方标识（deepseek / openai / siliconflow / qwen / local） */
  provider: string
  /** 模型名 */
  model: string
  /** 用途标签 */
  purpose: LlmPurpose
  /** 发起方 agentId（Lumina/Yak/热茶…；主对话为空串） */
  agentId?: string
  /** 服务端返回的真实 prompt token；缺失时传 null/0 触发估算 */
  promptTokens?: number | null
  /** 服务端返回的真实 completion token；缺失时传 null/0 触发估算 */
  completionTokens?: number | null
  /** 成功/失败（失败的调用也记账，便于看烧钱失败率） */
  success: boolean
  /**
   * usage 缺失时的估算依据文本（输入/输出文本长度）。
   * 两者至少给一个，否则估算为 0。
   */
  inputText?: string
  outputText?: string
  /** 是否非高峰折扣时段（默认 false） */
  offPeak?: boolean
  /** 时间戳（默认 now） */
  ts?: number
}

/** 一条落库记录 */
export interface UsageRecordRow {
  id: number
  ts: number
  dateKey: string       // 本地时区 YYYY-MM-DD
  provider: string
  model: string
  purpose: LlmPurpose
  agentId: string
  promptTokens: number
  completionTokens: number
  cost: number          // 元
  estimated: boolean    // true = token 数是估算的
  success: boolean
  priceNote: string     // 命中单价条目的备注（占位价会在这里露馅）
}

/** 聚合结果 */
export interface UsageAggregate {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cost: number
  calls: number
  estimatedCalls: number
}

// ═══════════════════════════════════════════════════════════
// 存储接口（测试注入内存 fake；生产注入 better-sqlite3 db）
// ═══════════════════════════════════════════════════════════

export interface UsageLedgerStore {
  init(): void
  insert(row: Omit<UsageRecordRow, 'id'>): number
  query(sinceTs: number, untilTs: number): UsageRecordRow[]
}

// ═══════════════════════════════════════════════════════════
// SQLite 适配器
// ═══════════════════════════════════════════════════════════

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS llm_usage_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    date_key TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    purpose TEXT NOT NULL,
    agent_id TEXT NOT NULL DEFAULT '',
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    cost REAL NOT NULL DEFAULT 0,
    estimated INTEGER NOT NULL DEFAULT 0,
    success INTEGER NOT NULL DEFAULT 1,
    price_note TEXT NOT NULL DEFAULT ''
  )
`

/** better-sqlite3 适配器：db 句柄由构造函数注入（与 RelationshipEventStore 同模式） */
export class SqliteUsageLedgerStore implements UsageLedgerStore {
  private db: Database
  constructor(db: Database) {
    this.db = db
  }
  init(): void {
    this.db.exec(CREATE_TABLE_SQL)
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_date ON llm_usage_records(date_key)`)
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_ts ON llm_usage_records(ts)`)
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_purpose ON llm_usage_records(purpose)`)
  }
  insert(row: Omit<UsageRecordRow, 'id'>): number {
    const r = this.db.prepare(
      `INSERT INTO llm_usage_records
        (ts, date_key, provider, model, purpose, agent_id,
         prompt_tokens, completion_tokens, cost, estimated, success, price_note)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      row.ts, row.dateKey, row.provider, row.model, row.purpose, row.agentId,
      row.promptTokens, row.completionTokens, row.cost, row.estimated ? 1 : 0, row.success ? 1 : 0, row.priceNote,
    )
    return Number(r.lastInsertRowid)
  }
  query(sinceTs: number, untilTs: number): UsageRecordRow[] {
    const rows = this.db.prepare(
      `SELECT * FROM llm_usage_records WHERE ts >= ? AND ts <= ? ORDER BY ts ASC`,
    ).all(sinceTs, untilTs) as any[]
    return rows.map(r => ({
      id: Number(r.id), ts: Number(r.ts), dateKey: r.date_key,
      provider: r.provider, model: r.model, purpose: r.purpose as LlmPurpose,
      agentId: r.agent_id, promptTokens: Number(r.prompt_tokens),
      completionTokens: Number(r.completion_tokens), cost: Number(r.cost),
      estimated: !!r.estimated, success: !!r.success, priceNote: r.price_note || '',
    }))
  }
}

// ═══════════════════════════════════════════════════════════
// 内存 fake（测试 / 原生 SQLite 不可用时的兜底）
// ═══════════════════════════════════════════════════════════

export class MemoryUsageLedgerStore implements UsageLedgerStore {
  rows: UsageRecordRow[] = []
  init(): void { /* noop */ }
  insert(row: Omit<UsageRecordRow, 'id'>): number {
    const id = this.rows.length + 1
    this.rows.push({ ...row, id })
    return id
  }
  query(sinceTs: number, untilTs: number): UsageRecordRow[] {
    return this.rows.filter(r => r.ts >= sinceTs && r.ts <= untilTs)
  }
}

// ═══════════════════════════════════════════════════════════
// 日期键（本地时区）
// ═══════════════════════════════════════════════════════════

/** 本地时区日期键：YYYY-MM-DD（与 usageStats.ts 的 getTodayStats 同一口径） */
export function localDateKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 某一天的起止时间戳（本地时区 0 点 → 次日 0 点） */
export function dayRange(dateKey: string): { start: number; end: number } {
  const [y, m, d] = dateKey.split('-').map(Number)
  const start = new Date(y, m - 1, d, 0, 0, 0, 0).getTime()
  const end = new Date(y, m - 1, d, 23, 59, 59, 999).getTime()
  return { start, end }
}

/**
 * 从 baseUrl 识别 provider 标识（记账用）。
 * 认不出就给 'local'（本地端点不烧钱，按 0 计费）。
 */
export function providerFromBaseUrl(baseUrl: string | undefined): string {
  const u = String(baseUrl || '').toLowerCase()
  if (!u) {return 'unknown'}
  if (u.includes('deepseek')) {return 'deepseek'}
  if (u.includes('siliconflow') || u.includes('sf.') || u.includes('silicon')) {return 'siliconflow'}
  if (u.includes('dashscope') || u.includes('aliyun') || u.includes('qwen')) {return 'qwen'}
  if (u.includes('openai')) {return 'openai'}
  if (u.includes('anthropic')) {return 'anthropic'}
  if (/(localhost|127\.|0\.0\.0\.0|192\.168\.|^https?:\/\/10\.)/.test(u)) {return 'local'}
  return 'custom'
}

// ═══════════════════════════════════════════════════════════
// 账本主体（纯逻辑，存储注入）
// ═══════════════════════════════════════════════════════════

export class UsageLedger {
  private store: UsageLedgerStore
  private estimator = new TokenEstimator()
  private now: () => number

  constructor(store: UsageLedgerStore, deps: { now?: () => number } = {}) {
    this.store = store
    this.now = deps.now ?? (() => Date.now())
    try {this.store.init()} catch { /* 建表失败不阻塞：账本退化为只读空账 */ }
  }

  /**
   * 记一笔。
   *
   * usage 字段齐全 → 真实 token；缺失/为 0 → 按 inputText/outputText 字符数估算，
   * estimated=true 落库。
   */
  recordCall(input: UsageRecordInput): UsageRecordRow {
    const ts = input.ts ?? this.now()
    let promptTokens = Number(input.promptTokens ?? 0) || 0
    let completionTokens = Number(input.completionTokens ?? 0) || 0
    let estimated = false

    if (promptTokens <= 0 && completionTokens <= 0) {
      // usage 缺失：按文本长度估算，并显式标注
      promptTokens = this.estimator.estimate(input.inputText || '')
      completionTokens = this.estimator.estimate(input.outputText || '')
      estimated = true
    } else if (promptTokens <= 0 || completionTokens <= 0) {
      // 半边缺：缺的那半边按文本估，整体仍标 estimated（诚实）
      if (completionTokens <= 0) {completionTokens = this.estimator.estimate(input.outputText || '')}
      if (promptTokens <= 0) {promptTokens = this.estimator.estimate(input.inputText || '')}
      estimated = true
    }

    const entry = lookupPrice(input.provider, input.model)
    const { cost } = estimateCost(entry, promptTokens, completionTokens, !!input.offPeak)

    const row: Omit<UsageRecordRow, 'id'> = {
      ts,
      dateKey: localDateKey(ts),
      provider: input.provider || 'unknown',
      model: input.model || 'unknown',
      purpose: input.purpose || 'other',
      agentId: input.agentId || '',
      promptTokens,
      completionTokens,
      cost,
      estimated,
      success: !!input.success,
      priceNote: entry
        ? (entry.placeholder ? `占位价需核对: ${entry.note || ''}` : (entry.note || '官方价'))
        : '未命中单价表，按 0 计费',
    }
    try {
      this.store.insert(row)
    } catch (e: any) {
      // 记账失败绝不能把对话带崩
      console.warn('[UsageLedger] 记账失败:', e?.message || e)
    }
    return { ...row, id: 0 }
  }

  // ── 查询 ──────────────────────────────────────────────

  /** 指定日期区间的全部记录 */
  queryRange(startTs: number, endTs: number): UsageRecordRow[] {
    try {return this.store.query(startTs, endTs)} catch {return []}
  }

  /** 今日（本地时区 0 点起）记录 */
  todayRecords(): UsageRecordRow[] {
    const today = localDateKey(this.now())
    const { start, end } = dayRange(today)
    return this.queryRange(start, end)
  }

  private aggregate(rows: UsageRecordRow[]): UsageAggregate {
    const a: UsageAggregate = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0, calls: rows.length, estimatedCalls: 0 }
    for (const r of rows) {
      a.promptTokens += r.promptTokens
      a.completionTokens += r.completionTokens
      a.cost += r.cost
      if (r.estimated) {a.estimatedCalls++}
    }
    a.totalTokens = a.promptTokens + a.completionTokens
    a.cost = Math.round(a.cost * 10_000) / 10_000
    return a
  }

  /** 今日花费 / token */
  today(): UsageAggregate {
    return this.aggregate(this.todayRecords())
  }

  /** 按用途聚合今日 */
  todayByPurpose(): Record<string, UsageAggregate> {
    return this.groupBy(this.todayRecords(), r => r.purpose)
  }

  /** 按 agent 聚合今日 */
  todayByAgent(): Record<string, UsageAggregate> {
    return this.groupBy(this.todayRecords(), r => r.agentId || '(主对话)')
  }

  /** 按 provider 聚合今日 */
  todayByProvider(): Record<string, UsageAggregate> {
    return this.groupBy(this.todayRecords(), r => r.provider)
  }

  /** 指定日期区间聚合 */
  rangeSummary(startTs: number, endTs: number): UsageAggregate {
    return this.aggregate(this.queryRange(startTs, endTs))
  }

  private groupBy(rows: UsageRecordRow[], key: (r: UsageRecordRow) => string): Record<string, UsageAggregate> {
    const map: Record<string, UsageRecordRow[]> = {}
    for (const r of rows) {
      const k = key(r)
      ;(map[k] ||= []).push(r)
    }
    const out: Record<string, UsageAggregate> = {}
    for (const [k, list] of Object.entries(map)) {out[k] = this.aggregate(list)}
    return out
  }
}

// ═══════════════════════════════════════════════════════════
// 进程级单例（生产接线后由 initBilling() 装 SQLite 句柄）
// ═══════════════════════════════════════════════════════════

let singleton: UsageLedger | null = null

export function getUsageLedger(): UsageLedger {
  if (!singleton) {
    // 兜底：未 init 时用内存账，绝不抛出（账本缺失 ≠ 对话不能用）
    singleton = new UsageLedger(new MemoryUsageLedgerStore())
  }
  return singleton
}

/** 生产接线：装入真实 SQLite 句柄并 init */
export function initUsageLedger(db: Database): UsageLedger {
  singleton = new UsageLedger(new SqliteUsageLedgerStore(db))
  return singleton
}

/** 测试钩子 */
export function __resetUsageLedger(): void {
  singleton = null
}
