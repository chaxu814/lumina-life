// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
import { describe, it, expect } from 'vitest'
import {
  SubPersona,
  SUB_PERSONA_THRESHOLDS,
  SUB_PERSONA_INSTRUCTION,
  type SubPersonaSnapshot,
} from '../electron/persona/subPersona'

const T0 = 1_000_000_000_000

function snap(over: Partial<SubPersonaSnapshot> = {}): SubPersonaSnapshot {
  return { affinity: 0.5, turnCount: 0, anxiety: 0.2, now: T0, ...over }
}

describe('subPersona 副人格觉醒', () => {
  it('flag 关闭时永远不触发', () => {
    const sp = new SubPersona({ enabled: false })
    const r = sp.evaluate(snap({ affinity: 0.95, turnCount: 500 }))
    expect(r.fired).toBe(false)
    expect(sp.firedTotal).toBe(0)
  })

  it('条件 (a)：亲密度>0.85 且对话>=200 触发，并带第二视角指令', () => {
    const sp = new SubPersona()
    // 先不够格
    expect(sp.evaluate(snap({ affinity: 0.9, turnCount: 100 })).fired).toBe(false)
    // 够格
    const r = sp.evaluate(snap({ affinity: 0.92, turnCount: 240 }))
    expect(r.fired).toBe(true)
    expect(r.reason).toBe('affinity_turns')
    expect(r.secondPersonaInstruction).toBe(SUB_PERSONA_INSTRUCTION)
    expect(sp.firedTotal).toBe(1)
  })

  it('条件 (a)：亲密度够但对话数不足不触发', () => {
    const sp = new SubPersona()
    expect(sp.evaluate(snap({ affinity: 0.99, turnCount: 199 })).fired).toBe(false)
  })

  it('条件 (b)：焦虑连续 3 小时 >0.7 才触发；中途回落重置计时', () => {
    const sp = new SubPersona()
    // 焦虑高位开始计时
    expect(sp.evaluate(snap({ anxiety: 0.8, now: T0 })).fired).toBe(false)
    // 1 小时后仍高位
    expect(sp.evaluate(snap({ anxiety: 0.8, now: T0 + 3600_000 })).fired).toBe(false)
    // 2 小时后回落 → 计时清零
    expect(sp.evaluate(snap({ anxiety: 0.3, now: T0 + 7200_000 })).fired).toBe(false)
    // 重新爬高，再满 3 小时才触发
    expect(sp.evaluate(snap({ anxiety: 0.85, now: T0 + 8000_000 })).fired).toBe(false)
    const r = sp.evaluate(snap({ anxiety: 0.85, now: T0 + 8000_000 + SUB_PERSONA_THRESHOLDS.anxietyStreakMs }))
    expect(r.fired).toBe(true)
    expect(r.reason).toBe('anxiety_streak')
  })

  it('单会话最多触发 1 次：触发后再满足条件也不二次触发，resetSession 后恢复', () => {
    const sp = new SubPersona()
    expect(sp.evaluate(snap({ affinity: 0.95, turnCount: 300 })).fired).toBe(true)
    expect(sp.evaluate(snap({ affinity: 0.95, turnCount: 400, now: T0 + 60_000 })).fired).toBe(false)
    expect(sp.firedTotal).toBe(1)
    // 新会话
    sp.resetSession()
    const r2 = sp.evaluate(snap({ affinity: 0.95, turnCount: 400, now: T0 + 120_000 }))
    expect(r2.fired).toBe(true)
    expect(sp.firedTotal).toBe(2)
  })

  it('explain() 返回「心里另一个声音」的解释文案', () => {
    expect(new SubPersona().explain()).toContain('另一个声音')
  })

  it('serialize/load 能保住触发次数与历史', () => {
    const sp = new SubPersona()
    sp.evaluate(snap({ affinity: 0.95, turnCount: 300 }))
    const dumped = sp.serialize()
    const sp2 = new SubPersona()
    sp2.load(dumped)
    expect(sp2.firedTotal).toBe(1)
    expect(sp2.history()).toHaveLength(1)
    // 恢复后本会话已触发过 → 不再触发
    expect(sp2.evaluate(snap({ affinity: 0.99, turnCount: 9999 })).fired).toBe(false)
  })
})
