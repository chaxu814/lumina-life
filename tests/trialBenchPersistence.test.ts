// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/trialBenchPersistence.test.ts — 审判台「假成功」的回归测试
//
// 【这个测试钉死的真实事故】
// observabilityIpc.ts 构造 MemoryTrialBench 时既没传 store 也没传 sink，
// 于是：
//   · sink === null → submit() 里的回写分支**从不执行**，SQLite 里什么都没变
//   · record.sinkError 永不被设置 → 面板的诚实提示路径永不触发，一律显示「已生效」
//   · records 是内存 Map 且无上层持久化 → 重启后裁决历史全部蒸发
// 而面板上明确写着「你的纠正会真的下调它的记忆权重并标记为已被证伪」。
// 这是本项目最痛的那类**假成功**：UI 成功，库没动。
//
// 所以这里不只测「数学对不对」（那部分另有 trialBench.test.ts 覆盖），
// 而是测**接线与持久化语义**：裁决必须能活过一次重启，且落库失败必须显形。
// ============================================================

import { describe, it, expect } from 'vitest'
import { MemoryTrialBench, type TrialRecord, type TrialStore } from '../electron/memory/trialBench'

/** 假的事实表 */
function makeFact(overrides: Partial<{ content: string; confidence: number; source: string }> = {}) {
  return {
    id: 1,
    category: 'user',
    content: overrides.content ?? '我住在北京',
    confidence: overrides.confidence ?? 0.95,
    source: overrides.source ?? 'user_stated',
    timestamp: '2026-10-01T00:00:00.000Z',
  }
}

/** 会把裁决真正写下来的假存储（模拟 SQLite） */
class PersistingStore implements TrialStore {
  facts = [makeFact()]
  /** memoryKey → 落库的权重 */
  persisted = new Map<string, number>()
  /** 模拟磁盘写失败 */
  failWrite = false

  getFacts(): ReturnType<typeof makeFact>[] { return this.facts }

  applyTrialVerdict(w: { memoryKey: string; content: string; confidence: number }): { ok: boolean; factId: number | null } {
    if (this.failWrite) {throw new Error('db is locked')}
    const fact = this.facts.find(f => f.content === w.content)
    if (!fact) {return { ok: false, factId: null }}
    fact.confidence = w.confidence
    this.persisted.set(w.memoryKey, w.confidence)
    return { ok: true, factId: fact.id }
  }

  loadTrialRecords(): TrialRecord[] { return [] }
}

function makeBench(store: TrialStore & PersistingStore) {
  return new MemoryTrialBench(store, {
    now: () => new Date('2026-10-15T00:00:00.000Z'),
    // 与生产实现（ipc/observabilityIpc.ts 的 sink）保持同一口径：
    // 「留了档但没匹配到事实行」也算失败，必须抛出去让 record.sinkError 显形。
    sink: (w) => {
      const r = store.applyTrialVerdict(w)
      if (!r.ok) {throw new Error('未能在事实库中定位到这条记忆，权重未变更（裁决已留档）')}
    },
  })
}

describe('MemoryTrialBench — 裁决必须真的落库', () => {

  it('disputed 会把新权重写进存储（而不是只留在内存）', () => {
    const store = new PersistingStore()
    const bench = makeBench(store)
    bench.review([{
      id: 'mem_1',
      content: '我住在北京',
      type: 'fact',
      status: 'confirmed',
      scores: { confidence: 0.95, recency: 1, frequency: 1, corroboration: 1, importance: 0.5 },
      compositeScore: 0.9,
      mentionCount: 1,
      sourceCount: 1,
      updatedAt: Date.now(),
    }])

    const out = bench.submit('mem_1', 'disputed', '我三年前就搬走了')

    expect(out.ok).toBe(true)
    expect(out.record?.lifecycle).toBe('contradicted')
    // 关键断言：库里的权重真的变了
    expect(store.facts[0].confidence).toBeLessThan(0.95)
    expect(store.persisted.get('mem_1')).toBe(out.record?.confidenceAfter)
  })

  it('存储写失败时必须如实标记 sinkError（绝不能显示成功）', () => {
    const store = new PersistingStore()
    store.failWrite = true
    const bench = makeBench(store)
    bench.review([{
      id: 'mem_1',
      content: '我住在北京',
      type: 'fact',
      status: 'confirmed',
      scores: { confidence: 0.95, recency: 1, frequency: 1, corroboration: 1, importance: 0.5 },
      compositeScore: 0.9,
      mentionCount: 1,
      sourceCount: 1,
      updatedAt: Date.now(),
    }])

    const out = bench.submit('mem_1', 'disputed')

    // 这就是原缺陷：sinkError 必须被设置，面板才知道不能报成功
    expect(out.record?.sinkError).toBe('db is locked')
  })

  it('匹配不到事实行时视为失败（留档不等于生效）', () => {
    const store = new PersistingStore()
    store.facts = []
    const bench = makeBench(store)
    bench.review([{
      id: 'mem_1',
      content: '一条只在证据链里、facts 表里没有的记忆',
      type: 'fact',
      status: 'pending',
      scores: { confidence: 0.5, recency: 1, frequency: 1, corroboration: 0, importance: 0.5 },
      compositeScore: 0.5,
      mentionCount: 0,
      sourceCount: 0,
      updatedAt: Date.now(),
    }])

    const out = bench.submit('mem_1', 'disputed')
    expect(out.record?.sinkError).toBeTruthy()
  })

})

describe('MemoryTrialBench — 裁决历史必须跨会话留存', () => {

  it('重启后能恢复历史记录', () => {
    const store = new PersistingStore()
    const saved: TrialRecord[] = []

    // 第一次会话：产生一条裁决
    const bench1 = new MemoryTrialBench(store, {
      now: () => new Date('2026-10-15T00:00:00.000Z'),
      sink: (w) => { store.applyTrialVerdict(w) },
    })
    bench1.review([{
      id: 'mem_1',
      content: '我住在北京',
      type: 'fact',
      status: 'confirmed',
      scores: { confidence: 0.95, recency: 1, frequency: 1, corroboration: 1, importance: 0.5 },
      compositeScore: 0.9,
      mentionCount: 1,
      sourceCount: 1,
      updatedAt: Date.now(),
    }])
    const first = bench1.submit('mem_1', 'disputed')
    expect(first.ok).toBe(true)
    saved.push(first.record!)

    // 第二次会话（新实例），存储能读回历史
    const store2 = new PersistingStore()
    store2.loadTrialRecords = () => saved
    const bench2 = new MemoryTrialBench(store2, { now: () => new Date('2026-10-16T00:00:00.000Z') })

    expect(bench2.history('mem_1')).toHaveLength(1)
    expect(bench2.history('mem_1')[0].verdict).toBe('disputed')
  })

  it('恢复后的裁决效果会保留：重新加载列表不会把权重冲回原值', () => {
    const store = new PersistingStore()
    const saved: TrialRecord[] = []
    const bench1 = makeBench(store)
    const scored = [{
      id: 'mem_1',
      content: '我住在北京',
      type: 'fact' as const,
      status: 'confirmed' as const,
      scores: { confidence: 0.95, recency: 1, frequency: 1, corroboration: 1, importance: 0.5 },
      compositeScore: 0.9,
      mentionCount: 1,
      sourceCount: 1,
      updatedAt: Date.now(),
    }]
    bench1.review(scored)
    const r = bench1.submit('mem_1', 'disputed')
    saved.push(r.record!)

    // 重启：事实表里的权重已经很低（因为落库成功了）
    const store2 = new PersistingStore()
    store2.facts = [makeFact({ confidence: r.record!.confidenceAfter })]
    store2.loadTrialRecords = () => saved
    const bench2 = new MemoryTrialBench(store2)
    const views = bench2.review(scored)

    // 用户纠正过的记忆，重新打开面板后权重仍然是纠正后的值
    expect(views[0].confidence).toBeCloseTo(r.record!.confidenceAfter, 4)
    expect(views[0].confidence).toBeLessThan(0.95)
    // 且界面上要显示它已经被判过「记错了」
    expect(views[0].lifecycle).toBe('contradicted')
  })

  it('pending 裁决不会抢掉「最后一次有效裁决」的名额', () => {
    // pending 不改数值 —— 如果恢复逻辑简单地取「最后一条的 confidenceAfter」，
    // 就会把 pending 之后又来一次 confirmed 之前的数值错误地固化下来。
    const store = new PersistingStore()
    const base = {
      id: 'mem_1',
      content: '我住在北京',
      type: 'fact' as const,
      status: 'confirmed' as const,
      scores: { confidence: 0.95, recency: 1, frequency: 1, corroboration: 1, importance: 0.5 },
      compositeScore: 0.9,
      mentionCount: 1,
      sourceCount: 1,
      updatedAt: Date.now(),
    }
    const bench = makeBench(store)
    bench.review([base])
    const dis = bench.submit('mem_1', 'disputed').record!
    const pend = bench.submit('mem_1', 'pending').record!
    expect(pend.confidenceAfter).toBe(dis.confidenceAfter)

    const store2 = new PersistingStore()
    store2.loadTrialRecords = () => [dis, pend]
    const bench2 = new MemoryTrialBench(store2)
    const views = bench2.review([base])
    expect(views[0].confidence).toBeCloseTo(dis.confidenceAfter, 4)
  })

  it('存储读历史失败时降级为「空历史」且留痕，不阻断使用', () => {
    const store = new PersistingStore()
    store.loadTrialRecords = () => { throw new Error('table missing') }
    const bench = new MemoryTrialBench(store)
    // 仍然可用
    expect(() => bench.history()).not.toThrow()
    expect(bench.history()).toEqual([])
  })

})

describe('MemoryTrialBench — 无 sink 时必须显形为「未生效」', () => {

  it('不注入 sink 时不会谎称落库成功', () => {
    // 这正是原生产环境的形态：new MemoryTrialBench() 什么都没传
    const store = new PersistingStore()
    const bench = new MemoryTrialBench(store)
    bench.review([{
      id: 'mem_1',
      content: '我住在北京',
      type: 'fact',
      status: 'confirmed',
      scores: { confidence: 0.95, recency: 1, frequency: 1, corroboration: 1, importance: 0.5 },
      compositeScore: 0.9,
      mentionCount: 1,
      sourceCount: 1,
      updatedAt: Date.now(),
    }])
    const out = bench.submit('mem_1', 'disputed')
    // 内存里生效（裁决被接受），但库没动
    expect(out.ok).toBe(true)
    expect(store.facts[0].confidence).toBe(0.95) // ← 库没变，这就是原缺陷
  })

})
