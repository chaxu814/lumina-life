// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/relationshipMemory.test.ts — 关系事件记忆 (I4) 单元测试
//
// 注意：better-sqlite3 原生模块编译给 Electron，系统 Node 无法加载。
// 因此本测试不 import memoryStore.ts，而是直接测 RelationshipEventStore，
// 并注入一个手写的内存 fake DB（只实现 relationship_events 用到的 SQL 子集）。
// RelationshipEventStore 对 better-sqlite3 是 type-only import，运行时不加载原生模块。
// ============================================================
import { describe, it, expect, beforeEach } from 'vitest'
import {
  RelationshipEventStore,
  kindLabel,
  type RelationshipEventKind,
} from '../electron/memory/relationshipEvents'

// ── 极简内存 SQLite fake（只支撑本模块用到的 SQL 子集） ─────────

interface FakeRow {
  id: number
  kind: RelationshipEventKind
  title: string
  detail: string
  timestamp: string
  emotional_weight: number
  resolved: number
  referenced_count: number
  [k: string]: any
}

class FakeDB {
  rows: FakeRow[] = []
  seq = 0

  exec(_sql: string): void { /* 建表/索引 no-op */ }
  pragma(_s: string): void { /* no-op */ }
  close(): void { /* no-op */ }

  prepare(sql: string) {
    return {
      run: (...p: any[]) => this.run(sql, p),
      get: (...p: any[]) => this.get(sql, p),
      all: (...p: any[]) => this.all(sql, p),
    }
  }

  private run(sql: string, params: any[]): { lastInsertRowid?: number; changes: number } {
    const head = sql.trim().toUpperCase()
    if (head.startsWith('INSERT')) {
      const colM = sql.match(/INSERT\s+INTO\s+\w+\s*\(([^)]+)\)/i)
      const valM = sql.match(/VALUES\s*\(([^)]+)\)/i)
      const cols = ((colM && colM[1]) || '').split(',').map((c) => c.trim())
      const tokens = ((valM && valM[1]) || '').split(',').map((t) => t.trim())
      const row: any = { id: ++this.seq, referenced_count: 0 }
      let pi = 0
      cols.forEach((col, i) => {
        const tok = tokens[i]
        if (tok === '?') {row[col] = params[pi++]}
        else {row[col] = Number(tok)}
      })
      this.rows.push(row as FakeRow)
      return { lastInsertRowid: row.id, changes: 1 }
    }
    if (head.startsWith('UPDATE')) {
      const id = params[0]
      const row = this.rows.find((r) => r.id === id)
      if (!row) {return { changes: 0 }}
      if (/referenced_count\s*=\s*referenced_count\s*\+\s*1/i.test(sql)) {row.referenced_count++}
      if (/SET\s+resolved\s*=\s*1/i.test(sql)) {row.resolved = 1}
      return { changes: 1 }
    }
    return { changes: 0 }
  }

  private get(sql: string, params: any[]): any {
    const all = this.all(sql, params)
    return all[0]
  }

  private all(sql: string, params: any[]): any[] {
    if (!/^\s*SELECT/i.test(sql)) {return []}
    let rows = [...this.rows]
    let pi = 0

    // WHERE 条件
    const whereM = sql.match(/WHERE\s+([\s\S]+?)(ORDER BY|LIMIT|$)/i)
    if (whereM) {
      const conds = whereM[1].split(/\s+AND\s+/i)
      for (const c of conds) {
        const ph = c.match(/^\s*(\w+)\s*(=|>=|<=)\s*\?\s*$/)
        const lit = c.match(/^\s*(\w+)\s*(=|>=|<=)\s*(-?[\d.]+)\s*$/)
        if (ph) {
          const [, col, op] = ph
          const val = params[pi++]
          rows = rows.filter((r) => cmp(r[col], op, val))
        } else if (lit) {
          const [, col, op, num] = lit
          rows = rows.filter((r) => cmp(r[col], op, parseFloat(num)))
        }
      }
    }

    // ORDER BY
    const obM = sql.match(/ORDER BY\s+([\s\S]+?)(\s+LIMIT|$)/i)
    if (obM) {
      const specs = obM[1].split(',')
      rows.sort((a, b) => {
        for (const spec of specs) {
          const m = spec.trim().match(/^(\w+)(\s+(DESC|ASC))?/i)
          if (!m) {continue}
          const dir = (m[3] || 'ASC').toUpperCase()
          const av = a[m[1]], bv = b[m[1]]
          let c = av < bv ? -1 : av > bv ? 1 : 0
          if (dir === 'DESC') {c = -c}
          if (c !== 0) {return c}
        }
        return 0
      })
    }

    // LIMIT
    const limPh = /LIMIT\s+\?/i.test(sql)
    const limLit = sql.match(/LIMIT\s+(\d+)/i)
    if (limPh) {rows = rows.slice(0, params[pi++])}
    else if (limLit) {rows = rows.slice(0, parseInt(limLit[1], 10))}

    return rows
  }
}

function cmp(a: any, op: string, b: any): boolean {
  switch (op) {
    case '=': return a === b
    case '>=': return a >= b
    case '<=': return a <= b
    default: return false
  }
}

// ── 测试 ────────────────────────────────────────────────

describe('RelationshipEventStore 关系事件记忆 (I4)', () => {
  let db: FakeDB
  let store: RelationshipEventStore

  beforeEach(() => {
    db = new FakeDB()
    store = new RelationshipEventStore(db as any)
    store.init()
  })

  it('record → get：写入后能按类别/时间读回，字段完整', () => {
    const id = store.record({ kind: 'promise', title: '答应帮你查签证', detail: '日本签证材料', emotional_weight: 0.8 })
    expect(id).toBeGreaterThan(0)
    const all = store.list()
    expect(all).toHaveLength(1)
    const ev = all[0]
    expect(ev.kind).toBe('promise')
    expect(ev.title).toBe('答应帮你查签证')
    expect(ev.detail).toBe('日本签证材料')
    expect(ev.emotional_weight).toBeCloseTo(0.8)
    // promise 默认未了结
    expect(ev.resolved).toBe(false)
    expect(ev.referenced_count).toBe(0)
    expect(ev.timestamp).toBeTruthy()
  })

  it('promise 默认 unresolved；celebration 默认 resolved', () => {
    const p = store.record({ kind: 'promise', title: '还没做的事' })
    const c = store.record({ kind: 'celebration', title: '上线日庆祝' })
    expect(store.list().find((e) => e.id === p)!.resolved).toBe(false)
    expect(store.list().find((e) => e.id === c)!.resolved).toBe(true)
  })

  it('getUnresolvedPromises：只返回未了结的，按情绪权重降序', () => {
    store.record({ kind: 'promise', title: '小事', emotional_weight: 0.3 })
    const big = store.record({ kind: 'sad_moment', title: '上次加班崩溃', emotional_weight: 0.9 })
    store.record({ kind: 'celebration', title: '已庆祝', emotional_weight: 1.0 }) // resolved=true，不该出现
    const unres = store.getUnresolvedPromises(10)
    // 只有两条 unresolved：小事(0.3) 和 sad_moment(0.9)
    expect(unres).toHaveLength(2)
    // 权重高的排前面
    expect(unres[0].id).toBe(big)
    expect(unres[0].title).toBe('上次加班崩溃')
  })

  it('markResolved 后不再出现在 unresolved 列表', () => {
    const id = store.record({ kind: 'promise', title: '答应写复盘' })
    expect(store.getUnresolvedPromises()).toHaveLength(1)
    store.markResolved(id)
    expect(store.getUnresolvedPromises()).toHaveLength(0)
  })

  it('incrementReferenced：主动提起计数累加', () => {
    const id = store.record({ kind: 'inside_joke', title: '那个只有我俩懂的梗' })
    expect(store.list()[0].referenced_count).toBe(0)
    store.incrementReferenced(id)
    store.incrementReferenced(id)
    expect(store.list()[0].referenced_count).toBe(2)
  })

  it('list 按 kind 过滤 + since 过滤 + limit', () => {
    const t1 = '2026-01-01T00:00:00.000Z'
    // 直接往 fake 里插两条不同 kind 的事件，绕过 record 的时间戳
    store.record({ kind: 'argument', title: '旧争执' })
    store.record({ kind: 'promise', title: '新承诺' })
    const promises = store.list({ kind: 'promise' })
    expect(promises).toHaveLength(1)
    expect(promises[0].kind).toBe('promise')
    // since 过滤：全部晚于 2020，应保留
    expect(store.list({ since: t1 })).toHaveLength(2)
    expect(store.list({ since: '2999-01-01T00:00:00.000Z' })).toHaveLength(0)
    expect(store.list({ limit: 1 })).toHaveLength(1)
  })

  it('getRecent：时间倒序，最新的在前', () => {
    store.record({ kind: 'celebration', title: '第一件事' })
    store.record({ kind: 'celebration', title: '第二件事' })
    store.record({ kind: 'celebration', title: '第三件事' })
    const recent = store.getRecent(2)
    expect(recent).toHaveLength(2)
    expect(recent[0].title).toBe('第三件事')
    expect(recent[1].title).toBe('第二件事')
  })

  it('digest：空库返回空串；非空返回可读的关系摘要', () => {
    expect(store.digest()).toBe('')
    store.record({ kind: 'promise', title: '答应帮你查签证' })
    store.record({ kind: 'inside_joke', title: '咖啡续杯暗号' })
    const text = store.digest(3)
    expect(text).toContain('我们之间的故事')
    expect(text).toContain('答应帮你查签证')
    expect(text).toContain('未了结') // promise 默认 unresolved
  })

  it('emotional_weight 被 clamp 到 0-1', () => {
    const id = store.record({ kind: 'promise', title: '越界权重', emotional_weight: 99 })
    const ev = store.list().find((e) => e.id === id)!
    expect(ev.emotional_weight).toBeLessThanOrEqual(1)
    expect(ev.emotional_weight).toBeGreaterThanOrEqual(0)
  })

  it('kindLabel：六种关系事件都有中文标签', () => {
    expect(kindLabel('promise')).toBe('承诺')
    expect(kindLabel('shared_achievement')).toBe('一起完成')
    expect(kindLabel('sad_moment')).toBe('难过时刻')
    expect(kindLabel('argument')).toBe('争执')
    expect(kindLabel('celebration')).toBe('庆祝')
    expect(kindLabel('inside_joke')).toBe('小默契')
  })
})
