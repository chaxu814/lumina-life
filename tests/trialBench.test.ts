// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/trialBench.test.ts — 记忆审判台回归测试
//
// 锁住四件事：
//   1. 三种裁决各自让置信度往哪个方向走、走多少
//   2. 【铁律】disputed 之后永远不超过 source cap —— 模型推断的记忆
//      哪怕被用户点 10 次「确认」，也绝不能变成权威事实
//   3. 重复 disputed 会累积更狠，但有下限保护，不会归零
//   4. 脏输入（坏 verdict / 未知 key / 越界置信度）不抛异常且行为明确
//
// ⚠️ 这里**不**开 SQLite。better-sqlite3 的 .node 二进制是给 Electron 编译的，
//    系统 Node 下加载会失败；而且审判台本身是纯逻辑，用一个返回 FactEntry[]
//    的假 store 就够了。mock 里的构造函数直接抛错，就是为了保证「万一哪天
//    有人在单测里真的去开库，测试会立刻炸出来」，而不是悄悄写用户的记忆库。
// ============================================================

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => process.cwd(), getVersion: () => '0.0.0-test' },
  ipcMain: { handle: () => {} },
}))

vi.mock('better-sqlite3', () => ({
  default: class BetterSqliteForbiddenInUnitTest {
    constructor() {
      throw new Error('trialBench 单测不允许打开真实数据库，请注入 mock store')
    }
  },
}))

import {
  MemoryTrialBench,
  applyVerdictToConfidence,
  normalizeVerdict,
  CONFIRM_STEP,
  DISPUTE_BASE_FACTOR,
  DISPUTE_FLOOR,
  type TrialStore,
  type TrialVerdict,
} from '../electron/memory/trialBench'

import {
  SOURCE_CONFIDENCE,
  UNVERIFIED_CONFIDENCE,
  type FactEntry,
  type FactSource,
} from '../electron/memory/memoryStore'

import type { ScoredMemory } from '../electron/memoryEvidence'

// ── 最小 mock store ─────────────────────────────────────

class MockStore implements TrialStore {
  public facts: FactEntry[] = []
  public getFactsCalls = 0

  getFacts(): FactEntry[] {
    this.getFactsCalls += 1
    return this.facts
  }
}

function makeFact(over: Partial<FactEntry> = {}): FactEntry {
  return {
    id: over.id ?? 1,
    category: over.category ?? 'user',
    content: over.content ?? '用户喜欢在深夜写代码',
    confidence: over.confidence ?? 0.95,
    source: over.source ?? 'user_stated',
    timestamp: over.timestamp ?? '2026-10-01 12:00:00',
  }
}

function makeScored(over: Partial<ScoredMemory> = {}): ScoredMemory {
  return {
    id: over.id ?? 'mem_1',
    content: over.content ?? '用户喜欢在深夜写代码',
    type: over.type ?? 'fact',
    scores: over.scores ?? {
      confidence: 0.9, recency: 0.8, frequency: 0.4, corroboration: 0.2, importance: 0.6,
    },
    compositeScore: over.compositeScore ?? 0.62,
    createdAt: over.createdAt ?? 1_757_000_000_000,
    updatedAt: over.updatedAt ?? 1_757_000_000_000,
    mentionCount: over.mentionCount ?? 3,
    sourceCount: over.sourceCount ?? 1,
    status: over.status ?? 'pending',
  }
}

/** 固定时间源：裁决记录里的时间戳必须可复现，否则断言只能写模糊比较 */
let clock = 0
const now = (): Date => new Date(1_800_000_000_000 + clock++ * 1000)

let store: MockStore
let writeBacks: Array<{ memoryKey: string; confidence: number; verdict: TrialVerdict }>

beforeEach(() => {
  store = new MockStore()
  clock = 0
  writeBacks = []
})

function makeBench(): MemoryTrialBench {
  return new MemoryTrialBench(store, {
    now,
    sink: (w) => { writeBacks.push({ memoryKey: w.memoryKey, confidence: w.confidence, verdict: w.verdict }) },
  })
}

// ═══════════════════════════════════════════════════════════

describe('裁决归一化', () => {

  it('接受三个合法裁决，大小写与空白都容错', () => {
    expect(normalizeVerdict('confirmed')).toBe('confirmed')
    expect(normalizeVerdict('  DISPUTED  ')).toBe('disputed')
    expect(normalizeVerdict('pending')).toBe('pending')
  })

  it('非法裁决返回 null，绝不猜成 pending', () => {
    // 猜成 pending 等于替用户做了一个他没做的决定
    expect(normalizeVerdict('banana')).toBeNull()
    expect(normalizeVerdict('')).toBeNull()
    expect(normalizeVerdict(null)).toBeNull()
    expect(normalizeVerdict(undefined)).toBeNull()
    expect(normalizeVerdict(42)).toBeNull()
  })
})

describe('applyVerdictToConfidence — 三种裁决的方向与幅度', () => {

  it('disputed 下调：按基准系数折减', () => {
    const out = applyVerdictToConfidence(0.95, 'user_stated', 'disputed', 0)
    expect(out).toBeCloseTo(0.95 * DISPUTE_BASE_FACTOR, 6)
    expect(out).toBeLessThan(0.95)
  })

  it('confirmed 上调：按基准步长向 cap 靠拢', () => {
    const out = applyVerdictToConfidence(0.5, 'user_stated', 'confirmed', 0)
    expect(out).toBeCloseTo(0.5 + CONFIRM_STEP, 6)
    expect(out).toBeGreaterThan(0.5)
  })

  it('pending 不改数值（待核实不代表任何方向）', () => {
    expect(applyVerdictToConfidence(0.72, 'user_stated', 'pending', 0)).toBeCloseTo(0.72, 6)
    expect(applyVerdictToConfidence(0.72, 'user_stated', 'pending', 9)).toBeCloseTo(0.72, 6)
  })

  it('重复 confirmed 步长递增，但仍被 cap 拦住', () => {
    const first = applyVerdictToConfidence(0.5, 'user_confirmed', 'confirmed', 0)
    const third = applyVerdictToConfidence(first, 'user_confirmed', 'confirmed', 2)
    expect(third - first).toBeGreaterThan(first - 0.5)
    expect(third).toBeLessThanOrEqual(SOURCE_CONFIDENCE.user_confirmed.cap)
  })
})

describe('铁律：disputed 之后永远不超过 source cap', () => {

  it('上游传来越界置信度（模型推断却写成 1.0）时，disputed 压回 cap 以内', () => {
    // 这是最危险的一种脏数据：把模型推断的记忆写成 100% 确定
    const out = applyVerdictToConfidence(1.0, 'model_inferred', 'disputed', 0)
    expect(out).toBeLessThanOrEqual(SOURCE_CONFIDENCE.model_inferred.cap)
  })

  it('模型推断的记忆被反复点「确认」也永远到不了 0.8（cap=0.6）', () => {
    // 权威性只由 source 决定：用户点十次确认也不该把「模型自己猜的」
    // 升格成用户亲口确认的事实。要升格必须改 source，那是存储层的事。
    let v = SOURCE_CONFIDENCE.model_inferred.default
    for (let i = 0; i < 10; i++) {v = applyVerdictToConfidence(v, 'model_inferred', 'confirmed', i)}
    expect(v).toBeLessThanOrEqual(SOURCE_CONFIDENCE.model_inferred.cap)
    expect(v).toBeLessThan(UNVERIFIED_CONFIDENCE)
  })

  it('三个来源各自都不越界（含超大/负数/非有限输入）', () => {
    const sources: FactSource[] = ['user_confirmed', 'user_stated', 'model_inferred']
    const dirty: number[] = [5, -3, 0, 1, 0.999999]
    for (const s of sources) {
      const cap = SOURCE_CONFIDENCE[s].cap
      for (const cur of dirty) {
        for (const verdict of ['confirmed', 'disputed', 'pending'] as const) {
          for (const times of [0, 1, 7]) {
            const out = applyVerdictToConfidence(cur, s, verdict, times)
            expect(out).toBeGreaterThanOrEqual(0)
            expect(out).toBeLessThanOrEqual(cap)
          }
        }
      }
    }
  })

  it('source 缺失时回退到 model_inferred（最保守），因此上限是 0.6', () => {
    for (const missing of [undefined, null, '', 'not-a-source', 'agent_tool']) {
      const out = applyVerdictToConfidence(1.0, missing, 'confirmed', 0)
      expect(out).toBeLessThanOrEqual(SOURCE_CONFIDENCE.model_inferred.cap)
    }
  })

  it('times 越界（负数 / NaN / 小数）不产生异常值', () => {
    for (const t of [-5, Number.NaN, 2.9, 1e9]) {
      const out = applyVerdictToConfidence(0.8, 'user_stated', 'disputed', t)
      expect(Number.isFinite(out)).toBe(true)
      expect(out).toBeGreaterThanOrEqual(DISPUTE_FLOOR)
      expect(out).toBeLessThanOrEqual(SOURCE_CONFIDENCE.user_stated.cap)
    }
  })
})

describe('重复 disputed 的累积与下限保护', () => {

  it('第二次 disputed 比第一次更狠（累积生效）', () => {
    const once = applyVerdictToConfidence(0.95, 'user_stated', 'disputed', 0)
    const twice = applyVerdictToConfidence(once, 'user_stated', 'disputed', 1)
    expect(twice).toBeLessThan(once)
  })

  it('连续十次 disputed 单调不增，且从不低于地板', () => {
    let v = 0.95
    let prev = v
    for (let i = 0; i < 10; i++) {
      v = applyVerdictToConfidence(prev, 'user_stated', 'disputed', i)
      expect(v).toBeLessThanOrEqual(prev)
      expect(v).toBeGreaterThanOrEqual(DISPUTE_FLOOR)
      prev = v
    }
    // 地板不是 0：归零就与「从没存在过」无法区分，用户重新认可时没有升回的起点
    expect(v).toBeGreaterThan(0)
  })

  it('从 0 开始也不会被折成负数', () => {
    const out = applyVerdictToConfidence(0, 'user_confirmed', 'disputed', 5)
    expect(out).toBeGreaterThanOrEqual(0)
  })
})

describe('MemoryTrialBench.review — 视图模型组装', () => {

  it('合成内容 / 来源 / 置信度 / 生命周期 / 引用次数 / 最后确认时间', () => {
    store.facts = [makeFact({ confidence: 0.95, source: 'user_stated' })]
    const bench = makeBench()
    const views = bench.review([makeScored({ status: 'confirmed', mentionCount: 7 })])

    expect(views).toHaveLength(1)
    const v = views[0]
    expect(v.memoryKey).toBe('mem_1')
    expect(v.content).toBe('用户喜欢在深夜写代码')
    expect(v.source).toBe('user_stated')
    expect(v.sourceLabel).toBe(SOURCE_CONFIDENCE.user_stated.label)
    expect(v.confidence).toBeCloseTo(0.95, 6)
    expect(v.cap).toBe(SOURCE_CONFIDENCE.user_stated.cap)
    expect(v.lifecycle).toBe('confirmed')
    expect(v.mentionCount).toBe(7)
    expect(v.lastConfirmedAt).toBe('2026-10-01 12:00:00')
    expect(v.hasFactBinding).toBe(true)
  })

  it('找不到对应 facts 行时不报错，降级为「仅证据链」', () => {
    const bench = makeBench()
    const views = bench.review([makeScored({ content: '一条只在证据链里的记忆' })])
    expect(views[0].hasFactBinding).toBe(false)
    // 没有落库事实时，置信度退回来源缺省值（model_inferred=0.6），不给权威
    expect(views[0].confidence).toBeCloseTo(SOURCE_CONFIDENCE.model_inferred.default, 6)
  })

  it('脏输入（缺字段 / 非数组 / null）逐条降级而不是整体抛错', () => {
    const bench = makeBench()
    expect(bench.review([] as unknown as ScoredMemory[])).toEqual([])
    expect(bench.review(null as unknown as ScoredMemory[])).toEqual([])
    const views = bench.review([
      null as unknown as ScoredMemory,
      { id: 'x' } as unknown as ScoredMemory,
      makeScored({ id: 'ok_1' }),
    ])
    expect(views).toHaveLength(3)
    expect(views.every(v => typeof v.memoryKey === 'string' && v.memoryKey.length > 0)).toBe(true)
    expect(views.find(v => v.memoryKey === 'ok_1')).toBeTruthy()
  })

  it('store 读取抛错时仍然出列表（记忆审判台不能因为库挂了就白屏）', () => {
    const broken: TrialStore = { getFacts: () => { throw new Error('db gone') } }
    const bench = new MemoryTrialBench(broken, { now })
    const views = bench.review([makeScored()])
    expect(views).toHaveLength(1)
    expect(views[0].hasFactBinding).toBe(false)
  })

  it('高风险记忆排在前面（被证伪 > 模型推断 > 高置信已确认）', () => {
    store.facts = [
      makeFact({ id: 1, content: '稳的一条', confidence: 1.0, source: 'user_confirmed' }),
      makeFact({ id: 2, content: '猜的一条', confidence: 0.6, source: 'model_inferred' }),
    ]
    const bench = makeBench()
    const views = bench.review([
      makeScored({ id: 'a', content: '稳的一条', status: 'confirmed' }),
      makeScored({ id: 'b', content: '猜的一条', status: 'pending' }),
    ])
    expect(views[0].memoryKey).toBe('b')
  })
})

describe('MemoryTrialBench.submit — 裁决回流', () => {

  it('disputed 会下调置信度、打 contradicted 标记，并把新权重写回 sink', () => {
    store.facts = [makeFact({ confidence: 0.95, source: 'user_stated' })]
    const bench = makeBench()
    bench.review([makeScored()])

    const out = bench.submit('mem_1', 'disputed', '我早就不写代码了')
    expect(out.ok).toBe(true)
    expect(out.record).toBeTruthy()
    expect(out.record?.lifecycle).toBe('contradicted')
    expect(out.record?.reason).toBe('我早就不写代码了')
    expect(out.record?.confidenceAfter).toBeLessThan(out.record?.confidenceBefore ?? 1)
    // 反馈真的流回了记忆权重，而不只是记了一条日志
    expect(writeBacks).toHaveLength(1)
    expect(writeBacks[0].confidence).toBe(out.record?.confidenceAfter)
  })

  it('confirmed 提升置信度并转 confirmed；pending 数值不动但转 pending', () => {
    store.facts = [makeFact({ confidence: 0.5, source: 'user_stated' })]
    const bench = makeBench()
    bench.review([makeScored({ id: 'c' })])
    bench.review([makeScored({ id: 'p' })])

    const ok = bench.submit('c', 'confirmed')
    expect(ok.record?.confidenceAfter).toBeGreaterThan(ok.record?.confidenceBefore ?? 0)
    expect(ok.record?.lifecycle).toBe('confirmed')

    const pend = bench.submit('p', 'pending')
    expect(pend.record?.confidenceAfter).toBeCloseTo(pend.record?.confidenceBefore ?? -1, 6)
    expect(pend.record?.lifecycle).toBe('pending')
  })

  it('重复 disputed 在同一个 bench 上累积', () => {
    store.facts = [makeFact({ confidence: 0.95, source: 'user_stated' })]
    const bench = makeBench()
    bench.review([makeScored()])
    const first = bench.submit('mem_1', 'disputed')
    const second = bench.submit('mem_1', 'disputed')
    expect(second.record?.confidenceAfter ?? 1).toBeLessThan(first.record?.confidenceAfter ?? 1)
    expect(second.record?.confidenceAfter ?? 0).toBeGreaterThanOrEqual(DISPUTE_FLOOR)
  })

  it('重新 review 不会把用户的纠正成果冲掉', () => {
    // 这是最容易做到「看起来有反馈、其实没反馈」的地方：
    // 用户判错 → 重新加载列表 → 置信度又弹回 0.95。
    store.facts = [makeFact({ confidence: 0.95, source: 'user_stated' })]
    const bench = makeBench()
    bench.review([makeScored()])
    const first = bench.submit('mem_1', 'disputed')
    const after = bench.review([makeScored()])
    expect(after[0].confidence).toBeCloseTo(first.record?.confidenceAfter ?? -1, 6)
    expect(after[0].verdict).toBe('disputed')
  })

  it('sink 抛错时裁决仍生效，但错误被如实记录（不假装成功）', () => {
    const bench = new MemoryTrialBench(store, {
      now,
      sink: () => { throw new Error('db is locked') },
    })
    bench.review([makeScored()])
    const out = bench.submit('mem_1', 'disputed')
    expect(out.ok).toBe(true)
    expect(out.record?.sinkError).toBe('db is locked')
  })

  it('无 store 也能用：submit 可直接带 subject 快照', () => {
    const bench = new MemoryTrialBench(null, { now })
    const out = bench.submit('mem_x', 'disputed', undefined, {
      content: '某条记忆', source: 'user_stated', confidence: 0.9,
    })
    expect(out.ok).toBe(true)
    expect(out.record?.cap).toBe(SOURCE_CONFIDENCE.user_stated.cap)
  })
})

describe('非法输入：明确行为，不抛异常', () => {

  it('未知 memoryKey 被拒绝，且不产生任何记录', () => {
    const bench = makeBench()
    const out = bench.submit('never-seen', 'disputed')
    expect(out.ok).toBe(false)
    expect(out.record).toBeNull()
    expect(out.error).toContain('未知 memoryKey')
    expect(bench.history()).toHaveLength(0)
  })

  it('空 memoryKey 被拒绝', () => {
    const bench = makeBench()
    expect(bench.submit('   ', 'confirmed').ok).toBe(false)
  })

  it('非法 verdict 被拒绝且不改动任何权重', () => {
    store.facts = [makeFact({ confidence: 0.95, source: 'user_stated' })]
    const bench = makeBench()
    bench.review([makeScored()])
    const before = bench.review([makeScored()])[0].confidence
    const out = bench.submit('mem_1', 'definitely-not-a-verdict')
    expect(out.ok).toBe(false)
    expect(out.error).toContain('非法裁决')
    expect(bench.review([makeScored()])[0].confidence).toBeCloseTo(before, 6)
  })

  it('越界置信度作为输入时被收敛，而不是被信任', () => {
    const bench = new MemoryTrialBench(null, { now })
    const high = bench.submit('k1', 'confirmed', undefined, { source: 'model_inferred', confidence: 99 })
    expect(high.record?.confidenceBefore).toBeLessThanOrEqual(SOURCE_CONFIDENCE.model_inferred.cap)
    const low = bench.submit('k2', 'confirmed', undefined, { source: 'user_confirmed', confidence: -99 })
    expect(low.record?.confidenceBefore).toBeGreaterThanOrEqual(0)
  })

  it('source 缺失的 subject 回退到 model_inferred 上限', () => {
    const bench = new MemoryTrialBench(null, { now })
    const out = bench.submit('k3', 'confirmed', undefined, { confidence: 1.0 })
    expect(out.record?.source).toBe('model_inferred')
    expect(out.record?.cap).toBe(SOURCE_CONFIDENCE.model_inferred.cap)
  })
})

describe('history / stats 汇总', () => {

  it('history 支持按 key 过滤，时间倒序', () => {
    store.facts = [
      makeFact({ id: 1, content: 'A', confidence: 0.95, source: 'user_stated' }),
      makeFact({ id: 2, content: 'B', confidence: 0.95, source: 'user_stated' }),
    ]
    const bench = makeBench()
    bench.review([makeScored({ id: 'a', content: 'A' }), makeScored({ id: 'b', content: 'B' })])
    bench.submit('a', 'confirmed')
    bench.submit('a', 'disputed')
    bench.submit('b', 'disputed')

    expect(bench.history()).toHaveLength(3)
    expect(bench.history('a')).toHaveLength(2)
    expect(bench.history('nobody')).toHaveLength(0)
    const all = bench.history()
    expect(all[0].at >= all[all.length - 1].at).toBe(true)
  })

  it('stats 汇总：总数 / 争议数 / 纠正次数 / 争议率', () => {
    store.facts = [
      makeFact({ id: 1, content: 'A', confidence: 0.95, source: 'user_stated' }),
      makeFact({ id: 2, content: 'B', confidence: 0.6, source: 'model_inferred' }),
      makeFact({ id: 3, content: 'C', confidence: 1.0, source: 'user_confirmed' }),
    ]
    const bench = makeBench()
    bench.review([
      makeScored({ id: 'a', content: 'A' }),
      makeScored({ id: 'b', content: 'B' }),
      makeScored({ id: 'c', content: 'C' }),
    ])
    bench.submit('a', 'disputed')
    bench.submit('a', 'disputed')  // 同一条判两次 = 两次纠正
    bench.submit('b', 'pending')
    bench.submit('c', 'confirmed')

    const s = bench.stats()
    expect(s.total).toBe(3)
    expect(s.judged).toBe(3)
    expect(s.corrections).toBe(2)
    expect(s.confirmations).toBe(1)
    expect(s.pendings).toBe(1)
    expect(s.disputedMemories).toBe(1)
    expect(s.verdictTotal).toBe(4)
    expect(s.disputeRate).toBeCloseTo(0.5, 6)
    expect(s.bySource.user_stated).toBe(1)
    expect(s.bySource.model_inferred).toBe(1)
    expect(s.bySource.user_confirmed).toBe(1)
    // A 被判错两次 → 沉到未验证区
    expect(s.unverified).toBeGreaterThanOrEqual(1)
  })

  it('没有任何裁决时 stats 不产生除零', () => {
    const bench = new MemoryTrialBench(null, { now })
    const s = bench.stats()
    expect(s.total).toBe(0)
    expect(s.disputeRate).toBe(0)
    expect(s.averageConfidence).toBe(0)
    expect(s.corrections).toBe(0)
  })
})
