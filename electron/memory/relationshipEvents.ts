// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// relationshipEvents.ts — 关系事件记忆 (I4)
//
// 区别于「事实 CRUD」式的记忆：
//   facts 表存的是「关于用户的客观事实」（喜欢吃火锅、住在北京）。
//   relationship_events 存的是「你和用户之间发生过的叙事性事件」——
//   你答应过他的事（promise）、你们一起完成的事（shared_achievement）、
//   他上次难过的原因（sad_moment）、吵过的架（argument）、
//   一起庆祝的时刻（celebration）、只有你们懂的梗（inside_joke）。
//
// 这些事件有情绪权重、有「是否已了结」状态、会被主动提起（unresolved 注入召回），
// 也会被梦到（dreamEngine 把最近 3 条喂进 LLM 梦境 prompt）。
//
// 持久化：SQLite (better-sqlite3)，表 relationship_events。
// 兼容性：CREATE TABLE IF NOT EXISTS，老库升级不丢数据。
//
// 测试友好：db 句柄由构造函数注入；本文件对 better-sqlite3 仅做 type-only
// import（运行时被擦除），因此单元测试可在系统 Node 下用内存 fake 跑。
// ============================================================

// type-only import：运行时完全擦除，不会在测试里加载原生 better-sqlite3
import type { Database } from 'better-sqlite3'

// ── 类型 ────────────────────────────────────────────────

export type RelationshipEventKind =
  | 'promise'             // 答应过用户的事（未了结时会主动提起）
  | 'shared_achievement'  // 一起完成的事
  | 'sad_moment'          // 用户难过/低谷的时刻
  | 'argument'            // 不愉快的争执
  | 'celebration'         // 一起庆祝的时刻
  | 'inside_joke'         // 只有你们俩懂的梗

export interface RelationshipEvent {
  id: number
  kind: RelationshipEventKind
  title: string
  detail: string
  timestamp: string        // ISO
  emotional_weight: number // 0-1，情绪浓度
  resolved: boolean        // promise 是否兑现 / argument 是否和解
  referenced_count: number // 被主动提起过几次
}

export interface RelationshipEventInput {
  kind: RelationshipEventKind
  title: string
  detail?: string
  /** 0-1，默认按 kind 给一个合理值 */
  emotional_weight?: number
  /** 是否一开始就已了结（celebration/achievement 默认 true；promise 默认 false） */
  resolved?: boolean
}

export interface RelationshipEventQuery {
  kind?: RelationshipEventKind
  /** 只返回该 ISO 时间之后的事件 */
  since?: string
  limit?: number
}

// ── 表结构 SQL（集中在这里，便于迁移与测试） ─────────────

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS relationship_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK(kind IN (
      'promise','shared_achievement','sad_moment','argument','celebration','inside_joke'
    )),
    title TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    timestamp TEXT NOT NULL,
    emotional_weight REAL NOT NULL DEFAULT 0.5,
    resolved INTEGER NOT NULL DEFAULT 0,
    referenced_count INTEGER NOT NULL DEFAULT 0
  )
`

// 各 kind 的默认情绪权重（未显式给出时用）
const DEFAULT_WEIGHT: Record<RelationshipEventKind, number> = {
  promise: 0.6,
  shared_achievement: 0.7,
  sad_moment: 0.8,
  argument: 0.75,
  celebration: 0.7,
  inside_joke: 0.5,
}

// ── 存储 ────────────────────────────────────────────────

export class RelationshipEventStore {
  private db: Database

  constructor(db: Database) {
    this.db = db
  }

  /** 建表（CREATE IF NOT EXISTS，兼容老库；可安全重复调用） */
  init(): void {
    this.db.exec(CREATE_TABLE_SQL)
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_rel_kind ON relationship_events(kind)`)
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_rel_resolved ON relationship_events(resolved)`)
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_rel_ts ON relationship_events(timestamp)`)
  }

  /**
   * 记录一条关系事件。
   * @returns 新事件的数据库 id
   */
  record(input: RelationshipEventInput): number {
    const ts = new Date().toISOString()
    const weight = clampWeight(input.emotional_weight ?? DEFAULT_WEIGHT[input.kind])
    // promise 默认未了结；其余 kind 默认已了结（除 sad_moment/argument 也保留未了结以便关怀）
    const defaultResolved = input.kind === 'promise' || input.kind === 'sad_moment' || input.kind === 'argument'
      ? 0 : 1
    const resolved = input.resolved === undefined ? defaultResolved : (input.resolved ? 1 : 0)
    const r = this.db.prepare(
      `INSERT INTO relationship_events
         (kind, title, detail, timestamp, emotional_weight, resolved, referenced_count)
       VALUES (?,?,?,?,?,?,0)`
    ).run(input.kind, input.title, input.detail || '', ts, weight, resolved)
    return Number(r.lastInsertRowid)
  }

  /**
   * 查询关系事件。
   * @param opts.kind  按类别过滤
   * @param opts.since 只返回该时间之后的事件
   * @param opts.limit 条数上限（默认 20）
   */
  list(opts: RelationshipEventQuery = {}): RelationshipEvent[] {
    const limit = opts.limit ?? 20
    const where: string[] = []
    const params: any[] = []
    if (opts.kind) {where.push('kind = ?'); params.push(opts.kind)}
    if (opts.since) {where.push('timestamp >= ?'); params.push(opts.since)}
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    params.push(limit)
    const rows = this.db.prepare(
      `SELECT * FROM relationship_events ${whereSql} ORDER BY id DESC LIMIT ?`
    ).all(...params) as any[]
    return rows.map(rowFromSql)
  }

  /** 最近 N 条关系事件（不分类别，时间倒序）—— 供梦境/上下文注入 */
  getRecent(limit = 3): RelationshipEvent[] {
    const rows = this.db.prepare(
      `SELECT * FROM relationship_events ORDER BY id DESC LIMIT ?`
    ).all(limit) as any[]
    return rows.map(rowFromSql)
  }

  /**
   * 未了结的承诺（或未和解的 argument / 未抚慰的 sad_moment）。
   * 召回时主动注入上下文，让 Lumina 能提起「你上周说要去日本，签证办了吗？」
   * 按情绪权重降序：越重的事越优先被想起。
   */
  getUnresolvedPromises(limit = 5): RelationshipEvent[] {
    const rows = this.db.prepare(
      `SELECT * FROM relationship_events
       WHERE resolved = 0
       ORDER BY emotional_weight DESC, id DESC
       LIMIT ?`
    ).all(limit) as any[]
    return rows.map(rowFromSql)
  }

  /** 记录一次「主动提起」（用于统计哪些事件最常被想起） */
  incrementReferenced(id: number): void {
    this.db.prepare(
      `UPDATE relationship_events SET referenced_count = referenced_count + 1 WHERE id = ?`
    ).run(id)
  }

  /** 把一条事件标记为已了结（承诺兑现 / 争执和解 / 悲伤被抚慰） */
  markResolved(id: number): void {
    this.db.prepare(
      `UPDATE relationship_events SET resolved = 1 WHERE id = ?`
    ).run(id)
  }

  /**
   * 生成一段供注入 System Prompt / 梦境 prompt 的「关系事件摘要」文本。
   * 空库返回空串。
   */
  digest(limit = 3): string {
    const events = this.getRecent(limit)
    if (events.length === 0) {return ''}
    const lines = events.map(e => {
      const state = e.resolved ? '' : '（未了结）'
      return `- [${kindLabel(e.kind)}] ${e.title}${state}`
    })
    return '## 我们之间的故事\n' + lines.join('\n')
  }
}

// ── 辅助 ────────────────────────────────────────────────

function rowFromSql(r: any): RelationshipEvent {
  return {
    id: Number(r.id),
    kind: r.kind as RelationshipEventKind,
    title: r.title as string,
    detail: (r.detail as string) || '',
    timestamp: r.timestamp as string,
    emotional_weight: Number(r.emotional_weight),
    resolved: Number(r.resolved) === 1,
    referenced_count: Number(r.referenced_count),
  }
}

function clampWeight(v: number): number {
  if (typeof v !== 'number' || Number.isNaN(v)) {return 0.5}
  return Math.max(0, Math.min(1, v))
}

export function kindLabel(kind: RelationshipEventKind): string {
  switch (kind) {
    case 'promise': return '承诺'
    case 'shared_achievement': return '一起完成'
    case 'sad_moment': return '难过时刻'
    case 'argument': return '争执'
    case 'celebration': return '庆祝'
    case 'inside_joke': return '小默契'
  }
}
