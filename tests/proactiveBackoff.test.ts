import { describe, it, expect } from 'vitest'
import { computeBackoffMs, maybeLevelUp, BackoffState } from '../electron/proactive/backoff'

describe('backoff 退避曲线', () => {
  it('各级别等待时长符合设计表', () => {
    expect(computeBackoffMs(0)).toBe(15_000)
    expect(computeBackoffMs(1)).toBe(30_000)
    expect(computeBackoffMs(2)).toBe(60_000)
    expect(computeBackoffMs(3)).toBe(120_000)
    expect(computeBackoffMs(4)).toBe(300_000)
    expect(computeBackoffMs(5)).toBe(600_000)
    expect(computeBackoffMs(6)).toBe(1_800_000)
  })

  it('level>=7 硬顶 60 分钟', () => {
    expect(computeBackoffMs(7)).toBe(3_600_000)
    expect(computeBackoffMs(99)).toBe(3_600_000)
  })

  it('level<0 按 0 级处理', () => {
    expect(computeBackoffMs(-3)).toBe(15_000)
  })
})

describe('maybeLevelUp 升级规则', () => {
  it('前 3 级必升级', () => {
    expect(maybeLevelUp(0, () => 0)).toBe(1)
    expect(maybeLevelUp(1, () => 0.99)).toBe(2)
    expect(maybeLevelUp(2, () => 0.99)).toBe(3)
  })

  it('3<=level<7 时 9% 概率升级：rand=0 必升，rand=0.5 不升', () => {
    expect(maybeLevelUp(3, () => 0)).toBe(4)
    expect(maybeLevelUp(5, () => 0.08)).toBe(6)
    expect(maybeLevelUp(3, () => 0.5)).toBe(3)
    expect(maybeLevelUp(6, () => 0.5)).toBe(6)
  })

  it('level>=7 封顶不变', () => {
    expect(maybeLevelUp(7, () => 0)).toBe(7)
    expect(maybeLevelUp(10, () => 0)).toBe(7)
  })
})

describe('BackoffState 状态机', () => {
  it('没说过话时 nextDelayMs 返回 0', () => {
    const s = new BackoffState()
    expect(s.nextDelayMs(1_000_000)).toBe(0)
  })

  it('recordAttempt 后按级别等待；时间走过后剩余递减', () => {
    const s = new BackoffState()
    s.recordAttempt(100_000) // level 0→1, 等待 30s
    expect(s.level).toBe(1)
    // 刚说完：还需等 30s
    expect(s.nextDelayMs(100_000)).toBe(30_000)
    // 过了 10s：还需等 20s
    expect(s.nextDelayMs(110_000)).toBe(20_000)
    // 过了 40s：冷却结束
    expect(s.nextDelayMs(140_000)).toBe(0)
  })

  it('连续发言级别递增；用户互动后清零', () => {
    const s = new BackoffState({ now: 0 })
    s.recordAttempt(0)      // 0→1
    s.recordAttempt(60_000) // 1→2
    s.recordAttempt(120_000) // 2→3
    expect(s.level).toBe(3)
    s.resetOnInteraction()
    expect(s.level).toBe(0)
    expect(s.lastAttemptAt).toBe(0)
    expect(s.nextDelayMs(999)).toBe(0)
  })
})
