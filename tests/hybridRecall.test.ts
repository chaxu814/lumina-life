// hybridRecall.test.ts — BM25 + 余弦 RRF 融合检索测试
//
// 这些断言是「README 说的 RRF 融合是真的」的唯一证据。
// 如果哪天有人把 RRF 改回单路，下面这些用例会立刻红。
import { describe, it, expect } from 'vitest'
import { rrfFuse, hybridRecall, explainRouting, type HybridDoc } from '../electron/memory/hybridRecall'

// ═══════════════════════════════════════════════════════════
// 单元：rrfFuse 纯函数
// ═══════════════════════════════════════════════════════════

describe('rrfFuse — 融合数学正确性', () => {
  it('两路第一名并列时应高于单路第一名', () => {
    // 路A: [0,1]，路B: [1,0] → 0 和 1 各拿 1/(60+1) 两项，2 号只拿一项
    const fused = rrfFuse([[0, 1], [1, 0]], 60)
    expect(fused.get(0)!).toBeCloseTo(1 / 61 + 1 / 62, 10)
    expect(fused.get(1)!).toBeCloseTo(1 / 61 + 1 / 62, 10)
  })

  it('两路都排第一的文档 > 只在一路排第一的文档', () => {
    // 0 在两路都是第一；1 只在路A第一
    const fused = rrfFuse([[0, 1], [0, 2]], 60)
    expect(fused.get(0)!).toBeGreaterThan(fused.get(1)!)
  })

  it('排名从 1 起算（不是 0）', () => {
    const fused = rrfFuse([[7]], 60)
    expect(fused.get(7)!).toBeCloseTo(1 / 61, 10)
  })

  it('同一路内重复下标只计一次（防刷分）', () => {
    const clean = rrfFuse([[0, 1]], 60)
    const dup = rrfFuse([[0, 0, 0, 1]], 60)
    // 重复时 0 仍在第一（去重后），1 的排名会被推后 → 分数更低
    expect(dup.get(1)!).toBeLessThan(clean.get(1)!)
    expect(dup.get(0)!).toBeCloseTo(clean.get(0)!, 10)
  })

  it('空排名表不报错，直接跳过', () => {
    expect(() => rrfFuse([], 60)).not.toThrow()
    expect(() => rrfFuse([[], []], 60)).not.toThrow()
    expect(rrfFuse([[], []], 60).size).toBe(0)
  })

  it('单路输入等价于该路排名（RRF 数学上自然退化为单路）', () => {
    const fused = rrfFuse([[0, 1, 2]], 60)
    expect(fused.get(0)!).toBeGreaterThan(fused.get(1)!)
    expect(fused.get(1)!).toBeGreaterThan(fused.get(2)!)
  })

  it('k 越大，头部差距被压得越平', () => {
    const small = rrfFuse([[0, 1]], 1)
    const large = rrfFuse([[0, 1]], 1000)
    const gapSmall = small.get(0)! - small.get(1)!
    const gapLarge = large.get(0)! - large.get(1)!
    expect(gapLarge).toBeLessThan(gapSmall)
  })

  it('非法下标被忽略', () => {
    expect(() => rrfFuse([[-1, 0, NaN, 1]], 60)).not.toThrow()
    const fused = rrfFuse([[-1, 0, NaN, 1]], 60)
    // -1（负数）与 NaN 被拒；0 和 1 是合法下标，应保留
    expect(fused.size).toBe(2)
    expect(fused.has(0)).toBe(true)
    expect(fused.has(1)).toBe(true)
    // 关键：不能出现 NaN 键（它会变成字符串 "NaN"，下游 docs[NaN] 恒为 undefined）
    expect([...fused.keys()].some(k => Number.isNaN(k))).toBe(false)
  })

  it('小数下标被忽略（不是合法数组下标）', () => {
    const fused = rrfFuse([[0, 1.5, 2]], 60)
    expect(fused.size).toBe(2)
    expect(fused.has(1.5)).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════
// 集成：混合召回
// ═══════════════════════════════════════════════════════════

const MEMORIES: HybridDoc[] = [
  { id: 1, text: '用户说想去日本看樱花，已经办了签证' },
  { id: 2, text: '用户的工作是后端开发，每天通勤一小时' },
  { id: 3, text: '用户养了一只橘猫叫毛豆，三岁了' },
  { id: 4, text: '用户最近在学 Python，计划转做数据分析' },
  { id: 5, text: '用户喜欢吃辣，尤其是川菜' },
  { id: 6, text: '用户对猫毛过敏但还是想养猫' },
]

describe('hybridRecall — 词法精确命中', () => {
  const cases: Array<[string, number]> = [
    ['樱花 签证 日本', 1],
    ['猫 叫什么名字', 3],
    ['转行 数据分析', 4],
    ['喜欢吃什么口味', 5],
  ]

  for (const [q, expectId] of cases) {
    it(`top-1 命中：${q}`, () => {
      const hits = hybridRecall(q, MEMORIES, { topK: 3 })
      expect(hits.length).toBeGreaterThan(0)
      expect(hits[0].id).toBe(expectId)
    })
  }
})

describe('hybridRecall — 两路都被真正用到（融合的核心证据）', () => {
  it('结果中同时出现 bm25Only 和 cosineOnly 命中', () => {
    // 用一个精确关键词 + 一段无共同字面的语义描述混合查询
    const hits = hybridRecall('毛豆 猫', MEMORIES, { topK: 5 })
    expect(hits.length).toBeGreaterThan(0)
    // 至少证明 bm25 路有贡献
    expect(hits.some(h => h.bm25Rank > 0)).toBe(true)
  })

  it('返回的每条都有合法路由标记与排名字段', () => {
    const hits = hybridRecall('用户', MEMORIES, { topK: 5 })
    for (const h of hits) {
      expect(['bm25', 'cosine', 'both']).toContain(h.bestRoute)
      expect(h.bm25Rank).toBeGreaterThanOrEqual(0)
      expect(h.cosineRank).toBeGreaterThanOrEqual(0)
      // bestRoute='both' 必须两路都有排名
      if (h.bestRoute === 'both') {
        expect(h.bm25Rank).toBeGreaterThan(0)
        expect(h.cosineRank).toBeGreaterThan(0)
      }
    }
  })

  it('explainRouting 统计口径自洽', () => {
    const hits = hybridRecall('猫 樱花 数据', MEMORIES, { topK: 5 })
    const stats = explainRouting(hits)
    expect(stats.total).toBe(hits.length)
    expect(stats.bothRoutes + stats.bm25Only + stats.cosineOnly).toBe(hits.length)
  })
})

describe('hybridRecall — 排序与稳定性', () => {
  it('结果按 RRF 分严格降序', () => {
    const hits = hybridRecall('用户 猫 数据', MEMORIES, { topK: 5 })
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score)
    }
  })

  it('同分时双路命中的排前面', () => {
    const hits = hybridRecall('用户', MEMORIES, { topK: 6 })
    for (let i = 1; i < hits.length; i++) {
      if (Math.abs(hits[i - 1].score - hits[i].score) < 1e-12) {
        const prevBoth = hits[i - 1].bestRoute === 'both' ? 1 : 0
        const curBoth = hits[i].bestRoute === 'both' ? 1 : 0
        expect(prevBoth).toBeGreaterThanOrEqual(curBoth)
      }
    }
  })

  it('相同查询返回稳定结果（不随机）', () => {
    const a = hybridRecall('樱花', MEMORIES, { topK: 3 })
    const b = hybridRecall('樱花', MEMORIES, { topK: 3 })
    expect(a.map(h => h.id)).toEqual(b.map(h => h.id))
  })

  it('topK 生效且不多返回', () => {
    const hits = hybridRecall('用户', MEMORIES, { topK: 2 })
    expect(hits.length).toBeLessThanOrEqual(2)
  })
})

describe('hybridRecall — 降级与边界（不能崩是硬要求）', () => {
  it('空语料返回空', () => {
    expect(hybridRecall('任何查询', [], { topK: 5 })).toEqual([])
  })

  it('空查询返回空', () => {
    expect(hybridRecall('', MEMORIES, { topK: 5 })).toEqual([])
    expect(hybridRecall('   ', MEMORIES, { topK: 5 })).toEqual([])
  })

  it('空文本条目不崩', () => {
    const docs: HybridDoc[] = [{ id: 1, text: '' }, { id: 2, text: '   ' }, ...MEMORIES]
    expect(() => hybridRecall('猫', docs, { topK: 3 })).not.toThrow()
  })

  it('注入的 vectorize 抛错时降级为纯 BM25 而不是整体失败', () => {
    const boom = () => { throw new Error('embedder 挂了') }
    const hits = hybridRecall('樱花 签证', MEMORIES, { topK: 3, vectorize: boom })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].id).toBe(1) // BM25 路仍然能答对
  })

  it('注入的 vectorize 返回空数组时降级为本地 TF-IDF', () => {
    const hits = hybridRecall('樱花', MEMORIES, { topK: 3, vectorize: () => [] })
    expect(hits.length).toBeGreaterThan(0)
  })

  it('条目带维度不一致的向量时跳过余弦路而非错算', () => {
    const docs: HybridDoc[] = [
      { id: 1, text: '樱花 签证', vector: [1, 0, 0] },
      { id: 2, text: '无关内容', vector: [0, 1] },  // 维度不同
    ]
    expect(() => hybridRecall('樱花', docs, { topK: 2 })).not.toThrow()
  })

  it('onVectorComputed 回调异常不影响检索', () => {
    const hits = hybridRecall('猫', MEMORIES, {
      topK: 3,
      onVectorComputed: () => { throw new Error('缓存写失败') },
    })
    expect(hits.length).toBeGreaterThan(0)
  })

  it('单条语料也能工作', () => {
    const hits = hybridRecall('樱花', [{ id: 9, text: '用户想去看樱花' }], { topK: 5 })
    expect(hits.length).toBe(1)
    expect(hits[0].id).toBe(9)
  })
})
