// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/recommendSelect.test.ts — 「为你推荐」快段选品规则
// ============================================================
// 这三条规则是「打开就有内容」的体验底线，之前埋在一个 ipcMain.handle 里，
// 只能靠肉眼看输出。抽成纯函数后在这里钉死：
//   1. 脏数据（无标题/无链接）必须被过滤；
//   2. 话题分类命中要加权，但**不能排他**（否则当天该分类没新闻就整栏空掉）；
//   3. 同来源最多 2 条（避免整屏都是 Hacker News），但数量不够时要放宽补齐。
import { describe, it, expect } from 'vitest'
import { selectRecommendations, type RecommendCandidate } from '../electron/news/recommendSelect'

function item(over: Partial<RecommendCandidate> & { title?: string }): RecommendCandidate {
  return {
    title: 't',
    url: 'https://example.com/a',
    source: 'src',
    category: 'tech',
    hotScore: 100,
    ...over,
  }
}

describe('脏数据过滤', () => {
  it('无标题 / 无链接 / 空对象一律丢弃', () => {
    const all = [
      item({ title: '' }),
      item({ url: '' }),
      item({ title: undefined }),
      { source: 'x', category: 'tech' } as RecommendCandidate,
      item({ title: 'ok' }),
    ]
    const out = selectRecommendations(all, { poolSize: 8 })
    expect(out).toHaveLength(1)
    expect(out[0].title).toBe('ok')
  })

  it('空输入返回空数组（不抛）', () => {
    expect(selectRecommendations([], {})).toEqual([])
    expect(selectRecommendations(undefined as unknown as RecommendCandidate[], {})).toEqual([])
  })
})

describe('话题加权', () => {
  it('命中话题分类的低热度条目，排在未命中的高热度条目之前', () => {
    const all = [
      item({ title: 'finance-hot', category: 'finance', hotScore: 900 }),
      item({ title: 'ai-cool', category: 'ai', hotScore: 10 }),
    ]
    const out = selectRecommendations(all, { categories: ['ai'], poolSize: 8 })
    expect(out[0].title).toBe('ai-cool')
  })

  it('不排他：没有命中分类的条目仍然会出现在结果里', () => {
    const all = [
      item({ title: 'a', category: 'ai', hotScore: 50 }),
      item({ title: 'b', category: 'finance', hotScore: 40 }),
    ]
    const out = selectRecommendations(all, { categories: ['ai'], poolSize: 8 })
    expect(out.map(i => i.title)).toEqual(['a', 'b'])
  })

  it('无话题时纯按热度降序', () => {
    const all = [
      item({ title: 'low', hotScore: 1 }),
      item({ title: 'high', hotScore: 99 }),
      item({ title: 'mid', hotScore: 50 }),
    ]
    const out = selectRecommendations(all, { poolSize: 8 })
    expect(out.map(i => i.title)).toEqual(['high', 'mid', 'low'])
  })
})

describe('来源分散', () => {
  it('两个来源各 3 条、池子 4 条时，每个来源各取 2 条', () => {
    const all = [
      ...Array.from({ length: 3 }, (_, i) => item({ title: `a${i}`, source: 'A', hotScore: 100 - i })),
      ...Array.from({ length: 3 }, (_, i) => item({ title: `b${i}`, source: 'B', hotScore: 90 - i })),
    ]
    const out = selectRecommendations(all, { poolSize: 4 })
    expect(out).toHaveLength(4)
    const bySource = out.reduce<Record<string, number>>((acc, i) => {
      acc[i.source] = (acc[i.source] || 0) + 1
      return acc
    }, {})
    expect(bySource).toEqual({ A: 2, B: 2 })
  })

  it('只有一个来源时放宽限制补齐（宁可同源多几条，也不要整栏空掉）', () => {
    const all = Array.from({ length: 5 }, (_, i) => item({ title: `only${i}`, source: 'A' }))
    const out = selectRecommendations(all, { poolSize: 4 })
    expect(out).toHaveLength(4)
  })

  it('perSourceMax 可调（池子只放得下 2 条时，两个来源各 1 条）', () => {
    const all = [
      ...Array.from({ length: 3 }, (_, i) => item({ title: `a${i}`, source: 'A', hotScore: 100 - i })),
      ...Array.from({ length: 3 }, (_, i) => item({ title: `b${i}`, source: 'B', hotScore: 90 - i })),
    ]
    const out = selectRecommendations(all, { poolSize: 2, perSourceMax: 1 })
    expect(out.map(i => i.source).sort()).toEqual(['A', 'B'])
  })
})

describe('边界与不变性', () => {
  it('poolSize 限制生效', () => {
    const all = Array.from({ length: 20 }, (_, i) => item({ title: `t${i}`, source: `s${i}` }))
    expect(selectRecommendations(all, { poolSize: 3 })).toHaveLength(3)
  })

  it('poolSize 小于实际可用数量时不会补出更多', () => {
    const all = [item({ title: 'x', source: 'A' })]
    expect(selectRecommendations(all, { poolSize: 8 })).toHaveLength(1)
  })

  it('不修改入参数组', () => {
    const all = [item({ title: 'low', hotScore: 1 }), item({ title: 'high', hotScore: 9 })]
    const snapshot = all.map(i => i.title)
    selectRecommendations(all, { poolSize: 8 })
    expect(all.map(i => i.title)).toEqual(snapshot)
  })
})
