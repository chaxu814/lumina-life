// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/billingPriceTable.test.ts — 单价表与费用计算
// ============================================================
import { describe, it, expect, beforeEach } from 'vitest'
import {
  lookupPrice,
  estimateCost,
  listAllPrices,
  setPriceOverrides,
} from '../electron/billing/priceTable'

describe('DeepSeek 内置现价（2026-10）', () => {
  it('v4-flash 输入 ¥1 / 输出 ¥2 每百万 token', () => {
    const e = lookupPrice('deepseek', 'deepseek-v4-flash')
    expect(e).not.toBeNull()
    expect(e!.inputPerM).toBe(1)
    expect(e!.outputPerM).toBe(2)
  })

  it('v4-pro 输入 ¥12 / 输出 ¥24，且带非高峰折扣字段', () => {
    const e = lookupPrice('deepseek', 'deepseek-v4-pro')
    expect(e).not.toBeNull()
    expect(e!.inputPerM).toBe(12)
    expect(e!.outputPerM).toBe(24)
    // 2.5 折 = 0.25 系数；不编造时间段，只表达折扣字段
    expect(e!.offPeakDiscount).toBe(0.25)
  })

  it('模型名别名兜底：deepseek-chat 这类常见写法也能命中', () => {
    // 关键词兜底至少不该返回 null 给 deepseek 系
    expect(lookupPrice('deepseek', 'deepseek-chat')).not.toBeNull()
  })
})

describe('占位条目诚实标注', () => {
  it('硅基流动 / 通义千问 / OpenAI 条目都标 placeholder', () => {
    const all = listAllPrices()
    for (const p of all) {
      if (p.provider !== 'deepseek') {
        expect(p.placeholder).toBe(true)
      }
    }
  })
})

describe('费用计算：输入/输出分开计价', () => {
  it('只算输入：100 万 input token @ ¥1/M = ¥1', () => {
    const e = lookupPrice('deepseek', 'deepseek-v4-flash')!
    const { cost } = estimateCost(e, 1_000_000, 0)
    expect(cost).toBe(1)
  })

  it('只算输出：50 万 output token @ ¥2/M = ¥1', () => {
    const e = lookupPrice('deepseek', 'deepseek-v4-flash')!
    const { cost } = estimateCost(e, 0, 500_000)
    expect(cost).toBe(1)
  })

  it('混合：100 万 input + 100 万 output @ flash = 1+2 = ¥3', () => {
    const e = lookupPrice('deepseek', 'deepseek-v4-flash')!
    const { cost } = estimateCost(e, 1_000_000, 1_000_000)
    expect(cost).toBe(3)
  })

  it('pro 价：50 万 input + 50 万 output = 6 + 12 = ¥18', () => {
    const e = lookupPrice('deepseek', 'deepseek-v4-pro')!
    const { cost } = estimateCost(e, 500_000, 500_000)
    expect(cost).toBe(18)
  })
})

describe('非高峰折扣', () => {
  it('offPeak=true 时 pro 价 ×0.25：50万+50万 = 18×0.25 = 4.5', () => {
    const e = lookupPrice('deepseek', 'deepseek-v4-pro')!
    const { cost, offPeakApplied } = estimateCost(e, 500_000, 500_000, true)
    expect(offPeakApplied).toBe(true)
    expect(cost).toBeCloseTo(4.5, 2)
  })

  it('默认不打折（宁可不少算，不可多送折扣）', () => {
    const e = lookupPrice('deepseek', 'deepseek-v4-pro')!
    const { cost, offPeakApplied } = estimateCost(e, 500_000, 500_000)
    expect(offPeakApplied).toBe(false)
    expect(cost).toBe(18)
  })
})

describe('用户覆盖', () => {
  beforeEach(() => {setPriceOverrides([])})

  it('用户覆盖优先于内置表', () => {
    setPriceOverrides([{
      provider: 'deepseek', model: 'deepseek-v4-flash',
      inputPerM: 99, outputPerM: 99, placeholder: false,
    }])
    const e = lookupPrice('deepseek', 'deepseek-v4-flash')!
    expect(e.inputPerM).toBe(99)
  })

  it('未知 provider/model 查不到时按 0 计费', () => {
    const { cost } = estimateCost(null, 1_000_000, 1_000_000)
    expect(cost).toBe(0)
  })
})
