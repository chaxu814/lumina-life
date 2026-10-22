// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/budgetGuardian.test.ts — 预算守护者三级阈值 / 只收紧不放宽 / 跨天重置
// ============================================================
import { describe, it, expect } from 'vitest'
import {
  BudgetGuardian,
  DEFAULT_BUDGET_CONFIG,
  tokenBudgetToYuan,
} from '../electron/billing/budgetGuardian'
import { lookupPrice } from '../electron/billing/priceTable'

// 固定时钟：2026-10-14 12:00 本地时间
const DAY1_NOON = new Date(2026, 9, 14, 12, 0, 0).getTime()
const DAY2_NOON = new Date(2026, 9, 15, 12, 0, 0).getTime()

function makeGuardian(now: () => number, patch: Partial<typeof DEFAULT_BUDGET_CONFIG> = {}) {
  return new BudgetGuardian({ ...patch }, { now })
}

describe('三级阈值精确边界（预算 ¥1/天）', () => {
  it('79.9% → ok（不到 warn）', () => {
    const g = makeGuardian(() => DAY1_NOON)
    const snap = g.evaluate(0.799)
    expect(snap.level).toBe('ok')
  })

  it('恰好 80% → warn', () => {
    const g = makeGuardian(() => DAY1_NOON)
    const snap = g.evaluate(0.8)
    expect(snap.level).toBe('warn')
    expect(snap.actions.length).toBeGreaterThan(0)
  })

  it('94.9% → warn（不到 degrade）', () => {
    const g = makeGuardian(() => DAY1_NOON)
    const snap = g.evaluate(0.949)
    expect(snap.level).toBe('warn')
  })

  it('恰好 95% → degrade', () => {
    const g = makeGuardian(() => DAY1_NOON)
    const snap = g.evaluate(0.95)
    expect(snap.level).toBe('degrade')
  })

  it('恰好 100% → hard', () => {
    const g = makeGuardian(() => DAY1_NOON)
    const snap = g.evaluate(1.0)
    expect(snap.level).toBe('hard')
  })

  it('120% → hard（超预算不止于 degrade）', () => {
    const g = makeGuardian(() => DAY1_NOON)
    const snap = g.evaluate(1.2)
    expect(snap.level).toBe('hard')
    expect(snap.remainingYuan).toBeLessThan(0)
  })
})

describe('只收紧不放宽', () => {
  it('先触发 degrade，占比回落到 80% 以下时当日仍锁存 degrade', () => {
    const g = makeGuardian(() => DAY1_NOON)
    expect(g.evaluate(0.96).level).toBe('degrade')
    // 假设某笔「退款」让今日累计回落到 0.5 元（50%）——级别不许跟着掉
    const snap = g.evaluate(0.5)
    expect(snap.level).toBe('degrade')
  })

  it('warn 触发后回落，当日不自动降回 ok', () => {
    const g = makeGuardian(() => DAY1_NOON)
    expect(g.evaluate(0.85).level).toBe('warn')
    expect(g.evaluate(0.1).level).toBe('warn')
  })

  it('级别只升不降：warn → degrade → hard 单向', () => {
    const g = makeGuardian(() => DAY1_NOON)
    g.evaluate(0.85)          // warn
    g.evaluate(0.96)          // degrade
    expect(g.evaluate(1.1).level).toBe('hard')
    // 回落
    expect(g.evaluate(0.2).level).toBe('hard')
  })
})

describe('跨天重置', () => {
  it('次日 0 点后锁存级别复位（即使昨天 hard）', () => {
    let now = DAY1_NOON
    const g = makeGuardian(() => now)
    expect(g.evaluate(1.1).level).toBe('hard')
    // 跨天
    now = DAY2_NOON
    const snap = g.evaluate(0.1)
    expect(snap.dateKey).not.toBe('2026-10-14')
    expect(snap.level).toBe('ok')
  })

  it('跨天后重新按新一天累计判定', () => {
    let now = DAY1_NOON
    const g = makeGuardian(() => now)
    g.evaluate(1.0) // hard
    now = DAY2_NOON
    g.evaluate(0.8) // 新一天 80% → warn（不是继承昨天 hard）
    expect(g.evaluate(0.8).level).toBe('warn')
  })
})

describe('必要性分类', () => {
  it('用户主动对话在任何级别都永不被砍', () => {
    const g = makeGuardian(() => DAY1_NOON)
    g.evaluate(2.0) // hard
    expect(g.isEssentialCallAllowed()).toBe(true)
  })

  it('degrade 级：非必要调用（社交/主动）暂停', () => {
    const g = makeGuardian(() => DAY1_NOON)
    g.evaluate(0.96)
    expect(g.isNonEssentialCallAllowed()).toBe(false)
  })

  it('warn 级：非必要调用照常（只是提示）', () => {
    const g = makeGuardian(() => DAY1_NOON)
    g.evaluate(0.85)
    expect(g.isNonEssentialCallAllowed()).toBe(true)
  })

  it('ok 级：全部放行', () => {
    const g = makeGuardian(() => DAY1_NOON)
    g.evaluate(0.1)
    expect(g.isNonEssentialCallAllowed()).toBe(true)
  })
})

describe('本轮放行（一次性，不是永久解锁）', () => {
  it('被拦后 overrideLatest → allowNonEssentialCall 这一次放行且额度消耗', () => {
    const g = makeGuardian(() => DAY1_NOON)
    g.evaluate(0.96) // degrade，非必要被拦
    expect(g.allowNonEssentialCall().allowed).toBe(false)

    const rec = g.overrideLatest('用户说这轮朋友圈必须发')
    expect(rec).not.toBeNull()
    // 本轮放行：第一次消耗额度
    const r1 = g.allowNonEssentialCall()
    expect(r1.allowed).toBe(true)
    expect(r1.released).toBe(true)
    // 额度一次性：第二次又被拦
    const r2 = g.allowNonEssentialCall()
    expect(r2.allowed).toBe(false)
  })

  it('没有 active 收紧记录时 override 返回 null', () => {
    const g = makeGuardian(() => DAY1_NOON)
    expect(g.overrideLatest('x')).toBeNull()
  })
})

describe('审计因果链', () => {
  it('每次收紧都记：累计 → 占比 → 阈值 → 收紧动作', () => {
    const g = makeGuardian(() => DAY1_NOON)
    g.evaluate(0.96)
    const log = g.getAuditLog()
    expect(log.length).toBe(1)
    const r = log[0]
    expect(r.level).toBe('degrade')
    expect(r.ratio).toBe(0.96)
    expect(r.threshold).toBe(0.95)
    expect(r.actions.length).toBeGreaterThan(0)
  })

  it('审计记录只增不改：回落后旧记录仍在', () => {
    const g = makeGuardian(() => DAY1_NOON)
    g.evaluate(0.96)
    g.evaluate(0.1)
    expect(g.getAuditLog().length).toBe(1)
  })
})

describe('自定义 token 预算折算', () => {
  it('按主力模型单价折算成人民币（输入:输出=1:1 折中）', () => {
    const e = lookupPrice('deepseek', 'deepseek-v4-flash')!
    // 200 万 token（input:output=1:1 → 各 100 万）= 1*1 + 2*1 = ¥3
    expect(tokenBudgetToYuan(2_000_000, e)).toBe(3)
  })

  it('查不到单价条目时返回 null（退回元档位）', () => {
    expect(tokenBudgetToYuan(1_000_000, null)).toBeNull()
  })

  it('配置 dailyTokenBudget 后 effectiveBudgetYuan 用折算值', () => {
    const g = new BudgetGuardian({
      dailyTokenBudget: 2_000_000,
      mainModel: { provider: 'deepseek', model: 'deepseek-v4-flash' },
    }, { now: () => DAY1_NOON })
    expect(g.effectiveBudgetYuan()).toBe(3)
    // ¥2.4 / ¥3 = 80% → warn
    expect(g.evaluate(2.4).level).toBe('warn')
  })
})

describe('总开关', () => {
  it('enabled=false 时任何占比都不收紧', () => {
    const g = makeGuardian(() => DAY1_NOON, { enabled: false })
    const snap = g.evaluate(5.0)
    expect(snap.level).toBe('ok')
    expect(g.isNonEssentialCallAllowed()).toBe(true)
  })
})
