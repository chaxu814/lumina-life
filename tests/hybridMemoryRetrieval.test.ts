import { describe, it, expect } from 'vitest'
import { BM25, TfidfCosine } from '../electron/hybridMemoryRetrieval'

describe('BM25 词法召回（CJK 友好）', () => {
  it('中文单字/短语可召回，相关文档排前', () => {
    const bm = new BM25()
    bm.addDocument('我最近喜欢在晚上玩原神，开放世界很有趣')
    bm.addDocument('今天的工作是写代码和评审代码')
    bm.addDocument('原神新出了一个角色，想抽')

    const res = bm.search('原神', 3)
    expect(res.length).toBeGreaterThan(0)
    // 命中“原神”的文档（doc0/doc2）应排在未命中的 doc1 之前
    expect(res[0].docIndex).not.toBe(1)
    expect(res[0].score).toBeGreaterThan(0)
  })

  it('英文按词召回且不区分大小写', () => {
    const bm = new BM25()
    bm.addDocument('Deploy the Lumina desktop pet')
    bm.addDocument('Unrelated cooking recipe')
    const res = bm.search('lumina', 2)
    expect(res[0].docIndex).toBe(0)
  })

  it('无命中返回空数组', () => {
    const bm = new BM25()
    bm.addDocument('完全无关的内容')
    expect(bm.search('量子力学', 5)).toEqual([])
  })
})

describe('TfidfCosine 向量召回', () => {
  it('finalize 后可按余弦召回相关文档并排序', () => {
    const tf = new TfidfCosine()
    tf.addDocument('我喜欢玩原神 开放世界 冒险游戏')
    tf.addDocument('今天写代码 评审代码 修 bug')
    tf.addDocument('原神的开放世界冒险很有意思')
    tf.finalize()

    const res = tf.search('原神 开放世界 冒险', 3)
    expect(res.length).toBeGreaterThan(0)
    // doc0 / doc2 与查询语义相近，应排在 doc1 之前
    expect([0, 2]).toContain(res[0].docIndex)
    expect(res[0].score).toBeGreaterThan(0)
    // 余弦分数应在 [0,1]（L2 归一化 + 非负词频）
    for (const r of res) {
      expect(r.score).toBeGreaterThanOrEqual(0)
      expect(r.score).toBeLessThanOrEqual(1.00001)
    }
  })

  it('未 finalize / 空语料安全返回空', () => {
    const tf = new TfidfCosine()
    expect(tf.search('任何查询', 5)).toEqual([])
    tf.finalize()
    expect(tf.search('任何查询', 5)).toEqual([])
  })
})

describe('BM25 与 TF-IDF 互补性（RRF 融合的基础）', () => {
  it('两条路都能召回同一批相关文档，融合时可标记 hybrid', () => {
    const docs = ['原神很好玩', '写代码很累', '继续玩原神']
    const bm = new BM25()
    const tf = new TfidfCosine()
    for (const d of docs) { bm.addDocument(d); tf.addDocument(d) }
    tf.finalize()
    const bmHits = new Set(bm.search('原神', 3).map(r => r.docIndex))
    const tfHits = new Set(tf.search('原神', 3).map(r => r.docIndex))
    // 两路都应召回包含“原神”的文档
    expect(bmHits.has(0)).toBe(true)
    expect(bmHits.has(2)).toBe(true)
    expect(tfHits.has(0)).toBe(true)
    expect(tfHits.has(2)).toBe(true)
    // 交集非空 → 融合后这些文档会被标为 hybrid
    const intersection = [...bmHits].filter(i => tfHits.has(i))
    expect(intersection.length).toBeGreaterThan(0)
  })
})
