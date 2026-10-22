// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// tests/bargeIn.test.ts — 可打断语音控制器测试（注入时钟与假播放器）
import { describe, it, expect, vi } from 'vitest'
import { BargeInController } from '../electron/whisper/bargeIn'

function makeController(opts?: { threshold?: number; confirmFrames?: number; cooldownMs?: number }) {
  let t = 1000
  const stop = vi.fn()
  const onInterrupt = vi.fn()
  const c = new BargeInController({ now: () => t, threshold: 0.12, confirmFrames: 3, cooldownMs: 700, ...opts }, onInterrupt)
  const advance = (ms: number) => { t += ms }
  return { c, stop, onInterrupt, advance }
}

describe('BargeInController', () => {
  it('未在说话时，任何电平都不触发', () => {
    const { c } = makeController()
    expect(c.observe(0.9)).toBe(false)
    expect(c.getState()).toBe('idle')
  })

  it('不足连续帧数不触发，且一帧回落即清零', () => {
    const { c } = makeController()
    c.beginSpeech({ stop: () => {} })
    expect(c.observe(0.5)).toBe(false)
    expect(c.observe(0.5)).toBe(false)
    expect(c.observe(0.01)).toBe(false) // 打断连续计数
    expect(c.observe(0.5)).toBe(false) // 重新计第 1 帧，仍不够
    expect(c.getState()).toBe('speaking')
  })

  it('连续达标后触发一次：停止播报并回调', () => {
    const { c, stop, onInterrupt } = makeController()
    c.beginSpeech({ stop })
    expect(c.observe(0.4)).toBe(false)
    expect(c.observe(0.4)).toBe(false)
    expect(c.observe(0.4)).toBe(true)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(onInterrupt).toHaveBeenCalledTimes(1)
    expect(c.getState()).toBe('interrupted')
    expect(c.getInterruptCount()).toBe(1)
  })

  it('冷却期内不会重复打断', () => {
    const { c, advance } = makeController({ cooldownMs: 700 })
    c.beginSpeech({ stop: () => {} })
    c.observe(0.5); c.observe(0.5); c.observe(0.5) // 触发
    // 立刻重新开始说话并再次喊话，仍在冷却内
    c.beginSpeech({ stop: () => {} })
    advance(100)
    c.observe(0.9); c.observe(0.9); c.observe(0.9)
    expect(c.getInterruptCount()).toBe(1)
    // 越过冷却后可以再次触发
    advance(700)
    c.beginSpeech({ stop: () => {} })
    c.observe(0.9); c.observe(0.9); c.observe(0.9)
    expect(c.getInterruptCount()).toBe(2)
  })

  it('endSpeech 自然结束复位为 idle', () => {
    const { c } = makeController()
    c.beginSpeech({ stop: () => {} })
    c.observe(0.0)
    c.endSpeech()
    expect(c.getState()).toBe('idle')
    expect(c.isSpeaking()).toBe(false)
  })
})
