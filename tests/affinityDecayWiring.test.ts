// ============================================================
// affinityDecayWiring.test.ts — 关系衰减是否真的接进了召回排序
//
// 【这个文件钉住的是什么】
// 之前 affinityDecay.ts 是一个「实现了、测了 26 个用例、但一处在用」的模块：
// 设置面板上有一个开��，主进程里有一个默认 true 的默认值，
// 唯独召回排序里**没有人读这个开关**。用户拨开关，什么都不会发生。
// 这类 bug 单测抓不到，因为被测的函数本身是对的 ——
// 所以只能钉「接线」：开关是否在调用点被读到、关掉时打分是否真的不变。
//
// 三条纪律：
//   ① 开关在**调用点**被读（这里用源码断言钉住，和 featureFlags.test.ts 同套路）；
//   ② 开关关闭 → 分数与排序逐字节不变（不是「差不多一样」）；
//   ③ 开关开启 → 关系更深的记忆排名只会上移，且任何条目都不会被删掉或清零。
// ============================================================

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { hybridRecall, type HybridDoc } from '../electron/memory/hybridRecall'
import {
  MAX_DECAY_PENALTY,
  AFFINITY_FLAG_KEY,
  decayRankMultiplier,
  decayWeight,
  decayWeightFromMetadata,
  readAffinityDecayEnabled,
} from '../electron/memory/affinityDecay'

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), ...rel.split('/')), 'utf-8')
}

const NOW = Date.parse('2026-01-01T00:00:00.000Z')
const DAY = 86_400_000
const daysAgo = (d: number) => new Date(NOW - d * DAY).toISOString()

/** 没有 metadata 的语料 —— 用来断言「没有衰减数据 = 什么都没发生」 */
const PLAIN: HybridDoc[] = [
  { id: 1, text: '用户说想去日本看樱花，已经办了签证' },
  { id: 2, text: '用户的工作是后端开发，每天通勤一小时' },
  { id: 3, text: '用户养了一只橘猫叫毛豆，三岁了' },
  { id: 4, text: '用户最近在学 Python，计划转做数据分析' },
  { id: 5, text: '用户喜欢吃辣，尤其是川菜' },
]

/**
 * 两条记忆在 RRF 上完全同分：一条只被 BM25 命中排第 1，
 * 另一条只被余弦命中排第 1 —— 两者的融合分都是 1/(k+1)。
 * 这是「衰减作为并列打破器」能生效的最小场景。
 */
function tiedPair(): HybridDoc[] {
  return [
    // 早期关系里的寒暄：低亲和度 + 很旧
    { id: 'early', text: '樱花', metadata: { affinity_at_write: 0.05, created_at: daysAgo(400) } },
    // 后期关系里的重要事实：高亲和度
    { id: 'late', text: '樱花', metadata: { affinity_at_write: 0.95, created_at: daysAgo(3) } },
    // 干扰项：让两路都能建起来，但把两条的向量拉开
    { id: 'noise', text: '今天天气不错，适合出门散步', metadata: { affinity_at_write: 0.5 } },
  ]
}

/** 未接入衰减时应有的原始 RRF 分：Σ 1/(k+rank)，求和顺序与 rrfFuse 一致 */
function rawRrf(h: { bm25Rank: number; cosineRank: number }, k = 60): number {
  return (h.bm25Rank > 0 ? 1 / (k + h.bm25Rank) : 0) +
         (h.cosineRank > 0 ? 1 / (k + h.cosineRank) : 0)
}

// ═══════════════════════════════════════════════════════════
// ① 接线：开关真的在调用点被读
// ═══════════════════════════════════════════════════════════

describe('接线 · 开关在调用点被读（不是只写了个默认值）', () => {
  it('hybridRecall 在排序路径上调用了 readAffinityDecayEnabled()', () => {
    const src = readSrc('electron/memory/hybridRecall.ts')
    expect(src, '召回排序里必须读开关').toMatch(/readAffinityDecayEnabled\(\)/)
    // 读开关的结果必须真的参与了打分，不能只是调用一下就扔掉
    expect(src).toMatch(/options\.affinityDecay\s*\?\?\s*readAffinityDecayEnabled\(\)/)
  })

  it('affinityDecay.ts 通过统一入口读同一个键（键名与设置面板一致）', () => {
    const src = readSrc('electron/memory/affinityDecay.ts')
    expect(AFFINITY_FLAG_KEY).toBe('affinityDecay')
    expect(src).toMatch(/readFeatureFlag\(\s*AFFINITY_FLAG_KEY\s*,\s*true\s*\)/)
    expect(src, '读不到配置时必须退回产品默认值 true，不能静默改成关')
      .toMatch(/catch\s*\{\s*return true\s*\}/)
  })

  it('readAffinityDecayEnabled() 本身不抛（纯 Node / 无 electron 环境）', () => {
    expect(() => readAffinityDecayEnabled()).not.toThrow()
    expect(typeof readAffinityDecayEnabled()).toBe('boolean')
  })

  it('hybridRecall 的 import 确实来自 affinityDecay（不是另写一份衰减）', () => {
    const src = readSrc('electron/memory/hybridRecall.ts')
    expect(src).toMatch(/from '\.\/affinityDecay'/)
    expect(src).toMatch(/decayRankMultiplier/)
  })

  it('设置面板的开关文案说的是「调整排序」而不是「删除」', () => {
    const src = readSrc('src/panels/settings/TheaterPanel.tsx')
    expect(src, '默认值判据仍是 !== false（featureFlags.test.ts 也守这条）')
      .toMatch(/f\.affinityDecay\s*!==\s*false/)
    const copy = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    expect(copy).toContain('不会删除任何记忆')
    expect(copy, '文案必须点明它作用在召回排序上').toContain('召回')
  })
})

// ═══════════════════════════════════════════════════════════
// ② 开关关闭 → 打分逐字节不变
// ═══════════════════════════════════════════════════════════

describe('开关关闭 · 召回打分逐字节不变', () => {
  it('无衰减数据的语料：开关开与关返回完全相同的结果', () => {
    for (const q of ['樱花 签证', '猫 叫什么名字', '用户 猫 数据', '喜欢吃什么']) {
      const on = hybridRecall(q, PLAIN, { topK: 5, now: NOW, affinityDecay: true })
      const off = hybridRecall(q, PLAIN, { topK: 5, now: NOW, affinityDecay: false })
      expect(off, `查询「${q}」在关闭衰减时不该有任何变化`).toEqual(on)
    }
  })

  it('分数逐位相等（不是 toBeCloseTo，是严格相等）', () => {
    const on = hybridRecall('用户 猫', PLAIN, { topK: 5, now: NOW, affinityDecay: true })
    const off = hybridRecall('用户 猫', PLAIN, { topK: 5, now: NOW, affinityDecay: false })
    off.forEach((h, i) => {
      expect(h.score).toBe(on[i].score)
      expect(h.bestRoute).toBe(on[i].bestRoute)
      expect(h.bm25Rank).toBe(on[i].bm25Rank)
      expect(h.cosineRank).toBe(on[i].cosineRank)
    })
  })

  it('关闭时每条命中的分数逐位等于原始 RRF 公式', () => {
    // 直接对着 RRF 定义核对，而不是「和另一次调用比对」——
    // 后者只能证明确定性，证明不了「和接入之前一样」。
    for (const docs of [PLAIN, tiedPair()]) {
      for (const q of ['樱花', '猫 毛豆', '用户 猫 数据', '喜欢吃什么']) {
        const off = hybridRecall(q, docs, { topK: 6, now: NOW, affinityDecay: false })
        for (const h of off) {
          expect(h.score, `「${q}」/ ${String(h.id)} 的分数被衰减动过`)
            .toBe(rawRrf(h))
        }
      }
    }
  })

  it('开启衰减后分数只可能被下调，且不低于原始分的 (1-8%)', () => {
    const docs = tiedPair()
    const off = hybridRecall('樱花', docs, { topK: 6, now: NOW, affinityDecay: false })
    const on = hybridRecall('樱花', docs, { topK: 6, now: NOW, affinityDecay: true })
    const base = new Map(off.map(h => [h.id, h]))
    for (const h of on) {
      const b = base.get(h.id)!
      expect(b).toBeDefined()
      expect(h.score).toBeLessThanOrEqual(b.score + Number.EPSILON * 8)
      expect(h.score).toBeGreaterThanOrEqual(b.score * (1 - MAX_DECAY_PENALTY))
      // 排名信息保持真实，不被衰减伪造
      expect(h.bm25Rank).toBe(b.bm25Rank)
      expect(h.cosineRank).toBe(b.cosineRank)
      expect(h.bestRoute).toBe(b.bestRoute)
    }
  })
})

// ═══════════════════════════════════════════════════════════
// ③ 开关开启 → 关系更深的记忆上移，且不被删除
// ═══════════════════════════════════════════════════

describe('开关开启 · 衰减改变排序方向', () => {
  it('同分并列时，高亲密度 + 新记忆排到前面', () => {
    const on = hybridRecall('樱花', tiedPair(), { topK: 3, now: NOW, affinityDecay: true })
    const ids = on.map(h => h.id)
    expect(ids.indexOf('late')).toBeGreaterThanOrEqual(0)
    expect(ids.indexOf('late')).toBeLessThan(ids.indexOf('early'))
  })

  it('关闭时结果与「衰减未生效」完全一致（证明这个语料上衰减确实有作用）', () => {
    const docs = tiedPair()
    const off = hybridRecall('樱花', docs, { topK: 3, now: NOW, affinityDecay: false })
    const on = hybridRecall('樱花', docs, { topK: 3, now: NOW, affinityDecay: true })
    expect(off.map(h => h.id)).not.toEqual(on.map(h => h.id))
  })

  it('衰减只能下调分数，不能上调（关系感不得盖过相关性）', () => {
    const docs = tiedPair()
    const on = hybridRecall('樱花', docs, { topK: 3, now: NOW, affinityDecay: true })
    const off = hybridRecall('樱花', docs, { topK: 3, now: NOW, affinityDecay: false })
    const base = new Map(off.map(h => [h.id, h.score]))
    for (const h of on) {
      const b = base.get(h.id)
      if (b === undefined) { continue }
      expect(h.score).toBeLessThanOrEqual(b + Number.EPSILON * 8)
    }
  })

  it('一条记忆都不会被删掉，也不会被清零', () => {
    const on = hybridRecall('樱花', tiedPair(), { topK: 3, now: NOW, affinityDecay: true })
    const off = hybridRecall('樱花', tiedPair(), { topK: 3, now: NOW, affinityDecay: false })
    expect(on.length).toBe(off.length)
    for (const h of on) { expect(h.score).toBeGreaterThan(0) }
  })
})

// ═══════════════════════════════════════════════════════════
// ④ 乘子本身：有界、纯函数
// ═══════════════════════════════════════════════════════════

describe('decayRankMultiplier · 有界且纯', () => {
  it('权重与基准相同时乘子恰好为 1（逐字节不变的来源）', () => {
    const w = decayWeight(0.5, 0)
    expect(decayRankMultiplier(w, w)).toBe(1)
  })

  it('乘子恒落在 [1-上限, 1]', () => {
    const max = decayWeight(1, 0)
    const min = decayWeight(0, 3650)
    expect(decayRankMultiplier(min, max)).toBeGreaterThanOrEqual(1 - MAX_DECAY_PENALTY)
    expect(decayRankMultiplier(min, max)).toBeGreaterThan(0)
    expect(decayRankMultiplier(max, max)).toBe(1)
  })

  it('基准为 0 时退回 1（排序调整不能自己变成故障）', () => {
    expect(decayRankMultiplier(0, 0)).toBe(1)
    expect(decayRankMultiplier(0.5, 0)).toBe(1)
  })

  it('权重越高乘子越大（单调）', () => {
    const max = decayWeight(1, 0)
    const a = decayRankMultiplier(decayWeight(0.8, 0), max)
    const b = decayRankMultiplier(decayWeight(0.3, 0), max)
    expect(a).toBeGreaterThan(b)
  })
})

// ═══════════════════════════════════════════════════════════
// ⑤ metadata 解析：缺字段 = 没意见，绝不误伤
// ═══════════════════════════════════════════════════════════

describe('decayWeightFromMetadata · 缺字段时的语义', () => {
  it('完全没有 metadata → 中性权重（关系中性的记忆，不偏袒任何一方）', () => {
    expect(decayWeightFromMetadata(undefined, NOW)).toBe(decayWeight(0.5, 0))
    expect(decayWeightFromMetadata(null, NOW)).toBe(decayWeight(0.5, 0))
    expect(decayWeightFromMetadata({}, NOW)).toBe(decayWeight(0.5, 0))
  })

  it('缺时间戳不惩罚新鲜度（ageDays=0 → 新鲜度 1）', () => {
    const w = decayWeightFromMetadata({ affinity_at_write: 0.9 }, NOW)
    expect(w).toBeCloseTo(decayWeight(0.9, 0), 12)
  })

  it('认得 camelCase 键名与 epoch 毫秒时间戳', () => {
    const byEpoch = decayWeightFromMetadata({ affinityAtWrite: 0.9, createdAt: NOW }, NOW)
    const byIso = decayWeightFromMetadata({ affinity_at_write: 0.9, created_at: new Date(NOW).toISOString() }, NOW)
    expect(byEpoch).toBeCloseTo(byIso, 12)
  })

  it('越界/脏值被夹到 [0,1]，不会算出 NaN', () => {
    for (const bad of [{ affinity_at_write: 5 }, { affinity_at_write: -3 }, { affinity_at_write: 'abc' }]) {
      const w = decayWeightFromMetadata(bad, NOW)
      expect(Number.isNaN(w)).toBe(false)
      expect(w).toBeGreaterThan(0)
      expect(w).toBeLessThanOrEqual(1)
    }
  })

  it('关系越深权重越高；越旧权重越低', () => {
    const deep = decayWeightFromMetadata({ affinity_at_write: 1, created_at: daysAgo(1) }, NOW)
    const shallow = decayWeightFromMetadata({ affinity_at_write: 0, created_at: daysAgo(1) }, NOW)
    const old = decayWeightFromMetadata({ affinity_at_write: 1, created_at: daysAgo(365) }, NOW)
    expect(deep).toBeGreaterThan(shallow)
    expect(deep).toBeGreaterThan(old)
    // 早年的重要记忆仍然留有空间（不下界 0.35 的设计意图）
    expect(old).toBeGreaterThan(0)
  })
})
