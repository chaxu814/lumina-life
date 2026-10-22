// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/usageLedger.test.ts — 统一记账账本（聚合 / 估算标注 / 日期口径）
// ============================================================
import { describe, it, expect, beforeEach } from 'vitest'
import {
  UsageLedger,
  MemoryUsageLedgerStore,
  localDateKey,
  dayRange,
} from '../electron/billing/usageLedger'

// 固定时钟
const NOW = new Date(2026, 9, 14, 12, 0, 0).getTime()

function makeLedger() {
  return new UsageLedger(new MemoryUsageLedgerStore(), { now: () => NOW })
}

describe('真实 usage 记账', () => {
  it('命中 deepseek 单价：100万 input + 50万 output @ flash = 1 + 1 = ¥2', () => {
    const ledger = makeLedger()
    const row = ledger.recordCall({
      provider: 'deepseek', model: 'deepseek-v4-flash', purpose: 'chat',
      promptTokens: 1_000_000, completionTokens: 500_000, success: true,
    })
    expect(row.cost).toBe(2)
    expect(row.estimated).toBe(false)
    expect(row.dateKey).toBe(localDateKey(NOW))
  })

  it('失败调用也记账', () => {
    const ledger = makeLedger()
    const row = ledger.recordCall({
      provider: 'deepseek', model: 'deepseek-v4-flash', purpose: 'proactive',
      promptTokens: 1000, completionTokens: 0, success: false,
    })
    expect(row.success).toBe(false)
    expect(ledger.today().calls).toBe(1)
  })
})

describe('usage 缺失 → 估算标注', () => {
  it('usage 完全缺失时按文本估算且标 estimated=true', () => {
    const ledger = makeLedger()
    const row = ledger.recordCall({
      provider: 'deepseek', model: 'deepseek-v4-flash', purpose: 'social',
      inputText: '你好世界，今天天气怎么样？',
      outputText: '我很好，谢谢关心。',
      success: true,
    })
    expect(row.estimated).toBe(true)
    expect(row.promptTokens).toBeGreaterThan(0)
    expect(row.completionTokens).toBeGreaterThan(0)
    // 诚实标注落到 priceNote / estimated 字段，UI 可直接展示
    expect(ledger.today().estimatedCalls).toBe(1)
  })

  it('半边 usage 缺失 → 整体仍标 estimated', () => {
    const ledger = makeLedger()
    const row = ledger.recordCall({
      provider: 'deepseek', model: 'deepseek-v4-flash', purpose: 'chat',
      promptTokens: 500, completionTokens: 0,
      outputText: '一段输出文本用来估算',
      success: true,
    })
    expect(row.estimated).toBe(true)
    expect(row.completionTokens).toBeGreaterThan(0)
  })
})

describe('聚合查询', () => {
  it('今日花费 / token / 按用途聚合', () => {
    const ledger = makeLedger()
    ledger.recordCall({ provider: 'deepseek', model: 'deepseek-v4-flash', purpose: 'chat',
      promptTokens: 1_000_000, completionTokens: 0, success: true })
    ledger.recordCall({ provider: 'deepseek', model: 'deepseek-v4-flash', purpose: 'social',
      promptTokens: 0, completionTokens: 500_000, success: true })

    const today = ledger.today()
    expect(today.cost).toBe(1 + 1) // input ¥1 + output ¥1
    expect(today.totalTokens).toBe(1_500_000)

    const byPurpose = ledger.todayByPurpose()
    expect(byPurpose.chat.cost).toBe(1)
    expect(byPurpose.social.cost).toBe(1)
  })

  it('按 provider 聚合', () => {
    const ledger = makeLedger()
    ledger.recordCall({ provider: 'deepseek', model: 'deepseek-v4-flash', purpose: 'chat',
      promptTokens: 1_000_000, completionTokens: 0, success: true })
    const byProvider = ledger.todayByProvider()
    expect(byProvider.deepseek.cost).toBe(1)
  })

  it('指定日期区间查询', () => {
    const ledger = makeLedger()
    const { start, end } = dayRange('2026-10-14')
    const rows = ledger.queryRange(start, end)
    expect(Array.isArray(rows)).toBe(true)
  })
})

describe('未知 provider 不烧钱', () => {
  it('查不到单价 → cost=0，priceNote 如实说明', () => {
    const ledger = makeLedger()
    const row = ledger.recordCall({
      provider: 'local-lmstudio', model: 'qwen3-4b', purpose: 'chat',
      promptTokens: 100_000, completionTokens: 100_000, success: true,
    })
    expect(row.cost).toBe(0)
    expect(row.priceNote).toContain('未命中')
  })
})
