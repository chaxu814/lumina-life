// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/affinityDecay.test.ts — 关系驱动的记忆衰减（创新功能 3）
//
// 最重要的一条：**永不删除**。
// 下面第一个 describe 整组都在钉这条不变量。
// 陪伴产品里「她忘了你说过的话」是致命的，
// 「她不太提起某件事」只是自然——两者绝不能混淆。
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest'
import {
  affinityDecay, recencyFactor, decayedScore, ageInDays,
  affinityAtWriteOf, parseMeta, encodeMeta,
  AffinityDecayStore, AFFINITY_FLOOR, HALF_LIFE_DAYS,
} from '../electron/memory/affinityDecay'

// ── 内存版 SQLite 替身（零原生依赖，测试可在纯 Node 跑）──
function makeFakeDb() {
  const rows: any[] = []
  let nextId = 1
  return {
    rows,
    exec() { /* no-op */ },
    prepare(sql: string) {
      if (sql.includes('SELECT id, category, content')) {
        return { all: () => rows.map(r => ({ ...r })) }
      }
      if (sql.includes('SELECT id, content, confidence')) {
        return {
          get: (id: number) => {
            const r = rows.find(x => x.id === id)
            return r ? { ...r } : undefined
          },
        }
      }
      if (sql.includes('SELECT metadata FROM facts')) {
        return {
          get: (id: number) => {
            const r = rows.find(x => x.id === id)
            return r ? { metadata: r.metadata } : undefined
          },
        }
      }
      if (sql.startsWith('UPDATE facts SET metadata')) {
        return {
          run: (meta: string, id: number) => {
            const r = rows.find(x => x.id === id)
            if (r) {r.metadata = meta}
            return { changes: r ? 1 : 0 }
          },
        }
      }
      return { run: () => ({}), get: () => undefined, all: () => [] }
    },
    __add(f: any) {
      const id = nextId++
      rows.push({
        id,
        category: f.category ?? 'user',
        content: f.content ?? '',
        confidence: f.confidence ?? 0.9,
        source: f.source ?? 'user_said',
        created_at: f.created_at ?? new Date().toISOString(),
        metadata: f.metadata ?? null,
      })
      return id
    },
  }
}

const DAY = 86_400_000
const now = Date.parse('2026-10-02T00:00:00Z')
const daysAgo = (d: number) => new Date(now - d * DAY).toISOString()

describe('affinityDecay · 纯函数', () => {
  it('亲密度系数落在 0.35~1.0', () => {
    expect(affinityDecay(0)).toBeCloseTo(AFFINITY_FLOOR, 5)
    expect(affinityDecay(1)).toBeCloseTo(1, 5)
    expect(affinityDecay(0.5)).toBeCloseTo(0.675, 5)
  })

  it('亲密度系数永不为 0（新用户不能失去所有记忆）', () => {
    for (const a of [0, 0.01, 0.1, 0.5]) {
      expect(affinityDecay(a)).toBeGreaterThan(0)
    }
  })

  it('非法输入被夹紧，不产生 NaN', () => {
    expect(affinityDecay(NaN)).toBeCloseTo(AFFINITY_FLOOR, 5)
    expect(affinityDecay(-5)).toBeCloseTo(AFFINITY_FLOOR, 5)
    expect(affinityDecay(99)).toBeCloseTo(1, 5)
  })

  it('时间新鲜度：半衰期处减半', () => {
    expect(recencyFactor(0)).toBe(1)
    expect(recencyFactor(HALF_LIFE_DAYS)).toBeCloseTo(0.5, 5)
    expect(recencyFactor(HALF_LIFE_DAYS * 2)).toBeCloseTo(0.25, 5)
  })

  it('未来时间不惩罚（时钟回拨不应导致记忆被埋）', () => {
    expect(recencyFactor(-10)).toBe(1)
  })

  it('非有限值返回 1（安全兜底）', () => {
    expect(recencyFactor(NaN)).toBe(1)
    expect(recencyFactor(Infinity)).toBe(1)
  })

  it('最终权重 = 置信度 × 亲密度系数 × 新鲜度', () => {
    const s = decayedScore(0.8, 0.5, 90)
    expect(s).toBeCloseTo(0.8 * 0.675 * 0.5, 5)
  })

  it('权重恒在 0~1（不会因为多乘几项而爆掉）', () => {
    const s = decayedScore(1, 1, 0)
    expect(s).toBeLessThanOrEqual(1)
    expect(s).toBeGreaterThanOrEqual(0)
  })

  it('天数差解析失败时返回 0（不惩罚脏数据）', () => {
    expect(ageInDays(null)).toBe(0)
    expect(ageInDays('not-a-date')).toBe(0)
    expect(ageInDays('2026-10-01T00:00:00Z', now)).toBeCloseTo(1, 2)
  })
})

describe('affinityDecay · metadata 编解码', () => {
  it('往返一致', () => {
    const m = { affinity_at_write: 0.7, other: 'x' }
    expect(parseMeta(encodeMeta(m))).toEqual(m)
  })

  it('老数据无该字段时给中性 0.5（不偏袒任何一方）', () => {
    expect(affinityAtWriteOf(null)).toBe(0.5)
    expect(affinityAtWriteOf('')).toBe(0.5)
    expect(affinityAtWriteOf('{"a":1}')).toBe(0.5)
    expect(affinityAtWriteOf('broken json')).toBe(0.5)
  })

  it('已有值正确读出', () => {
    expect(affinityAtWriteOf('{"affinity_at_write":0.9}')).toBe(0.9)
  })

  it('非法值被夹紧', () => {
    expect(affinityAtWriteOf('{"affinity_at_write":99}')).toBe(1)
    expect(affinityAtWriteOf('{"affinity_at_write":"abc"}')).toBe(0.5)
  })
})

describe('affinityDecay · 存储层', () => {
  let db: ReturnType<typeof makeFakeDb>
  let store: AffinityDecayStore

  beforeEach(() => {
    db = makeFakeDb()
    store = new AffinityDecayStore(db as any)
    store.init()
  })

  it('衰减只改排序，不删任何一条', () => {
    db.__add({ content: 'A', confidence: 0.9, metadata: JSON.stringify({ affinity_at_write: 0.9 }), created_at: daysAgo(365) })
    db.__add({ content: 'B', confidence: 0.9, metadata: JSON.stringify({ affinity_at_write: 0.1 }), created_at: daysAgo(365) })
    store.rankFacts({ now })
    // 两条都还在
    expect(db.rows).toHaveLength(2)
    expect(store.rankFacts({ now })).toHaveLength(2)
  })

  it('高亲密度时期的记忆排在低亲密度之前', () => {
    db.__add({ content: '早期寒暄', confidence: 0.9, metadata: JSON.stringify({ affinity_at_write: 0.05 }), created_at: daysAgo(200) })
    db.__add({ content: '后期重要', confidence: 0.9, metadata: JSON.stringify({ affinity_at_write: 0.95 }), created_at: daysAgo(200) })
    const r = store.rankFacts({ now })
    expect(r[0].content).toBe('后期重要')
    expect(r[1].content).toBe('早期寒暄')
  })

  it('同样亲密度下，新记忆排在旧记忆之前', () => {
    db.__add({ content: '旧', confidence: 0.9, metadata: JSON.stringify({ affinity_at_write: 0.5 }), created_at: daysAgo(200) })
    db.__add({ content: '新', confidence: 0.9, metadata: JSON.stringify({ affinity_at_write: 0.5 }), created_at: daysAgo(1) })
    const r = store.rankFacts({ now })
    expect(r[0].content).toBe('新')
  })

  it('高置信度仍可压过低置信度（衰减不推翻可信度）', () => {
    db.__add({ content: '高置信但低亲密度', confidence: 0.95, metadata: JSON.stringify({ affinity_at_write: 0.5 }), created_at: daysAgo(30) })
    db.__add({ content: '中置信高亲密度', confidence: 0.6, metadata: JSON.stringify({ affinity_at_write: 1.0 }), created_at: daysAgo(30) })
    const r = store.rankFacts({ now })
    // 0.95*0.675 = 0.641 > 0.6*1.0 = 0.6
    expect(r[0].content).toBe('高置信但低亲密度')
  })

  it('stampAffinity 只写 metadata，不改 content/confidence', () => {
    const id = db.__add({ content: '原话', confidence: 0.88, metadata: null })
    store.stampAffinity(id, 0.77)
    const row = db.rows.find(r => r.id === id)!
    expect(row.content).toBe('原话')          // 用户原话不能被篡改
    expect(row.confidence).toBe(0.88)
    expect(affinityAtWriteOf(row.metadata)).toBe(0.77)
  })

  it('stampAffinity 保留其他 metadata 字段', () => {
    const id = db.__add({ content: 'x', metadata: JSON.stringify({ tag: '重要' }) })
    store.stampAffinity(id, 0.5)
    const meta = parseMeta(db.rows.find(r => r.id === id)!.metadata)
    expect(meta.tag).toBe('重要')
    expect(meta.affinity_at_write).toBe(0.5)
  })

  it('对不存在的 id 调用 stampAffinity 不抛异常', () => {
    expect(() => store.stampAffinity(9999, 0.5)).not.toThrow()
  })

  it('空库返回空数组', () => {
    expect(store.rankFacts({ now })).toEqual([])
    expect(store.stats(now).total).toBe(0)
  })

  it('limit 生效', () => {
    for (let i = 0; i < 10; i++) {db.__add({ content: `f${i}`, confidence: 0.9 - i * 0.01 })}
    expect(store.rankFacts({ limit: 3, now })).toHaveLength(3)
  })

  it('explain 能说清一条记忆为什么被压低', () => {
    const id = db.__add({ content: 'x', confidence: 0.8, metadata: JSON.stringify({ affinity_at_write: 0.1 }), created_at: daysAgo(180) })
    const s = store.explain(id, now)!
    expect(s).toContain('亲密度')
    expect(s).toContain('新鲜度')
    expect(s).toContain('最终权重')
  })

  it('explain 对不存在的 id 返回 null', () => {
    expect(store.explain(9999, now)).toBeNull()
  })

  it('stats 统计受衰减影响的比例', () => {
    db.__add({ content: 'a', confidence: 0.9, metadata: JSON.stringify({ affinity_at_write: 1.0 }), created_at: new Date(now).toISOString() })
    db.__add({ content: 'b', confidence: 0.9, metadata: JSON.stringify({ affinity_at_write: 0.0 }), created_at: daysAgo(365) })
    const st = store.stats(now)
    expect(st.total).toBe(2)
    expect(st.avgAffinityAtWrite).toBeCloseTo(0.5, 2)
    expect(st.decayed).toBe(1)   // 只有 b 被衰减
  })

  it('db 读取抛异常时返回空数组而不是崩溃', () => {
    const broken = {
      exec() {},
      prepare() { throw new Error('db gone') },
    }
    const s2 = new AffinityDecayStore(broken as any)
    expect(s2.rankFacts({ now })).toEqual([])
  })
})
