// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
import { describe, it, expect } from 'vitest'
import { decideGate, type GateInput } from '../electron/proactive/gate'

/** 一个「所有规则都放行」的基线输入 */
function baseInput(overrides: Partial<GateInput> = {}): GateInput {
  return {
    hasUnfinishedThread: false,
    scene: 'idle',
    drives: { social: 0.5, energy: 0.8, comfort: 0.7 },
    idleMinutes: 10,
    dailyCount: 3,
    maxDaily: 20,
    msSinceLastProactive: 600_000,
    minIntervalMs: 60_000,
    cooldownMs: 0,
    petEnabled: true,
    userSpeaking: false,
    rand: () => 0, // 默认必过场景概率
    ...overrides,
  }
}

describe('gate 门控规则', () => {
  it('基线输入全部放行（idle 场景 90%，rand=0 必过）', () => {
    const r = decideGate(baseInput())
    expect(r.allowed).toBe(true)
    expect(r.reason).toBe('scene_idle')
  })

  it('a. 桌宠关闭 → 拒绝', () => {
    expect(decideGate(baseInput({ petEnabled: false })).allowed).toBe(false)
  })

  it('b. 用户正在说话 → 拒绝（不打断）', () => {
    const r = decideGate(baseInput({ userSpeaking: true }))
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('user_speaking')
  })

  it('c. 有未答话头 → 最高优先级放行，绕过冷却', () => {
    const r = decideGate(baseInput({ hasUnfinishedThread: true, msSinceLastProactive: 0, dailyCount: 99 }))
    expect(r.allowed).toBe(true)
    expect(r.reason).toBe('unfinished_thread')
  })

  it('d. 精力<0.2 → 放行但 fallbackToSleep', () => {
    const r = decideGate(baseInput({ drives: { social: 0.5, energy: 0.1, comfort: 0.7 } }))
    expect(r.allowed).toBe(true)
    expect(r.fallbackToSleep).toBe(true)
  })

  it('e. 今日配额用完 → 拒绝', () => {
    expect(decideGate(baseInput({ dailyCount: 20 })).allowed).toBe(false)
  })

  it('f. 距上次发言太近 → 拒绝（minInterval）', () => {
    const r = decideGate(baseInput({ msSinceLastProactive: 1000 }))
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('min_interval')
  })

  it('g. 游戏场景 85% 放行（v6.2 上调，观战吐槽是核心体感）', () => {
    expect(decideGate(baseInput({ scene: 'game', rand: () => 0.84 })).allowed).toBe(true)
    expect(decideGate(baseInput({ scene: 'game', rand: () => 0.86 })).allowed).toBe(false)
    expect(decideGate(baseInput({ scene: 'game', rand: () => 1 })).allowed).toBe(false)
  })

  it('h. private 场景一律不打扰', () => {
    const r = decideGate(baseInput({ scene: 'private', rand: () => 0 }))
    expect(r.allowed).toBe(false)
  })

  it('i. idle/other 场景 90% 放行（v6.2，发呆时最需要陪伴）', () => {
    expect(decideGate(baseInput({ scene: 'other', rand: () => 0.89 })).allowed).toBe(true)
    expect(decideGate(baseInput({ scene: 'other', rand: () => 0.91 })).allowed).toBe(false)
  })

  it('j. code 场景 55%、视频 75%（专注时少打扰）', () => {
    expect(decideGate(baseInput({ scene: 'code', rand: () => 0.54 })).allowed).toBe(true)
    expect(decideGate(baseInput({ scene: 'code', rand: () => 0.56 })).allowed).toBe(false)
    expect(decideGate(baseInput({ scene: 'video', rand: () => 0.74 })).allowed).toBe(true)
    expect(decideGate(baseInput({ scene: 'video', rand: () => 0.76 })).allowed).toBe(false)
  })

  it('k. social 场景 40%（你在跟别人聊，她少插嘴）', () => {
    expect(decideGate(baseInput({ scene: 'social', rand: () => 0.39 })).allowed).toBe(true)
    expect(decideGate(baseInput({ scene: 'social', rand: () => 0.41 })).allowed).toBe(false)
  })
})
