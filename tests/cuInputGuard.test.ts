// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/cuInputGuard.test.ts — v3.30 ForegroundLease 人机互斥纯逻辑
// ============================================================

import { describe, it, expect } from 'vitest'
import {
  InputState, checkLeaseInterrupt, LeaseBookkeeper,
} from '../electron/tools/impl/cuInputGuard'

describe('InputState.apply（钩子 stdout 行）', () => {
  it('C/W 记点击 tick；K 记键盘 tick；M 累计移动计数', () => {
    const s = new InputState()
    s.apply('C 1000')
    s.apply('W 1010')
    s.apply('K 1020 65')
    s.apply('M 1030')
    s.apply('M 1040')
    s.apply('M 1050')
    expect(s.snapshot()).toEqual({ clickTick: 1010, keyTick: 1020, moveCount: 3 })
  })
  it('非法行/坏 tick 被忽略', () => {
    const s = new InputState()
    s.apply('X 5')
    s.apply('M abc')
    expect(s.snapshot()).toEqual({ clickTick: 0, keyTick: 0, moveCount: 0 })
  })
})

describe('checkLeaseInterrupt（建约后真人打断）', () => {
  const lease = { clickTick: 1000, keyTick: 1000, moveCount: 0 }
  it('无任何真人输入 → 不打断', () => {
    expect(checkLeaseInterrupt(lease, lease).interrupted).toBe(false)
  })
  it('鼠标移动不超过阈值（手抖）→ 不打断', () => {
    const v = checkLeaseInterrupt(lease, { clickTick: 1000, keyTick: 1000, moveCount: 8 })
    expect(v.interrupted).toBe(false)
  })
  it('鼠标移动超过阈值（抢鼠标）→ 打断', () => {
    const v = checkLeaseInterrupt(lease, { clickTick: 1000, keyTick: 1000, moveCount: 9 })
    expect(v.interrupted).toBe(true)
    expect(v.reason).toContain('移动鼠标')
  })
  it('一次鼠标点击/滚轮 → 立即打断（无阈值）', () => {
    const v = checkLeaseInterrupt(lease, { clickTick: 1001, keyTick: 1000, moveCount: 0 })
    expect(v.interrupted).toBe(true)
    expect(v.reason).toContain('鼠标')
  })
  it('一次按键 → 立即打断', () => {
    const v = checkLeaseInterrupt(lease, { clickTick: 1000, keyTick: 1001, moveCount: 0 })
    expect(v.interrupted).toBe(true)
    expect(v.reason).toContain('键盘')
  })
})

describe('LeaseBookkeeper（租约生命周期）', () => {
  it('touch 首建基线、重复 touch 不覆盖；markBroken 后需 release 才能重置', () => {
    const b = new LeaseBookkeeper()
    const snap = { clickTick: 1, keyTick: 2, moveCount: 3 }
    b.touch('s1', snap)
    b.touch('s1', { clickTick: 99, keyTick: 99, moveCount: 99 }) // 不覆盖
    expect(b.baseline('s1')).toEqual(snap)
    expect(b.isBroken('s1')).toBe(false)
    b.markBroken('s1')
    expect(b.isBroken('s1')).toBe(true)
    b.release('s1')
    expect(b.isBroken('s1')).toBe(false)
    expect(b.baseline('s1')).toBeUndefined()
  })
})
