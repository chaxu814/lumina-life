// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// tests/emotionFusion.test.ts — 连续情绪融合层测试（纯逻辑，无 Electron 依赖）
import { describe, it, expect } from 'vitest'
import {
  normalizeMoodLabel,
  fuseEmotionStep,
  driftToBaseline,
  PetEmotionFusion,
  BASELINE,
} from '../electron/pet/emotionFusion'

describe('normalizeMoodLabel', () => {
  it('精确匹配标准标签', () => {
    expect(normalizeMoodLabel('开心 😊')).toBe('开心 😊')
  })
  it('容忍缺失 emoji / 自然语言', () => {
    expect(normalizeMoodLabel('有点疲惫')).toBe('疲惫 😩')
    expect(normalizeMoodLabel('超开心的')).toBe('超开心 🎉') // 具体词优先于「开心」
  })
  it('无法识别返回 null', () => {
    expect(normalizeMoodLabel('')).toBeNull()
    expect(normalizeMoodLabel('莫名其妙')).toBeNull()
  })
})

describe('fuseEmotionStep — 平滑而非瞬切', () => {
  it('从平静一步到「难过」不会直接跳到目标，变化被限幅', () => {
    const next = fuseEmotionStep({ ...BASELINE }, '难过 😢')
    // 目标效价 -0.82，但单步最多移动 maxStepV=0.18
    expect(next.v).toBeGreaterThan(-0.2) // 仍接近平静侧，没有瞬切到 -0.82
    expect(next.v).toBeLessThan(0) // 但确实开始往负向走
  })

  it('连续同向输入最终会抵达目标情绪标签', () => {
    let s = { ...BASELINE }
    let label = s.label
    for (let i = 0; i < 25; i++) {
      s = fuseEmotionStep(s, '兴奋 🤩')
      label = s.label
    }
    expect(s.v).toBeGreaterThan(0.7)
    expect(label).toBe('兴奋 🤩')
  })

  it('未知目标标签时保持状态不变', () => {
    const prev = { v: 0.4, a: 0.5, label: '开心 😊' }
    const next = fuseEmotionStep(prev, '无法理解')
    expect(next).toEqual(prev)
  })

  it('迟滞：在边界附近的轻微波动不频繁切换标签', () => {
    // 构造一个介于「平静/闷闷不乐」边界的状态，反复给非常接近的目标
    let s = { v: -0.1, a: 0.39, label: '平静 😐' }
    const seq = ['闷闷不乐 😕', '平静 😐', '闷闷不乐 😕', '平静 😐']
    const labels: string[] = []
    for (const t of seq) { s = fuseEmotionStep(s, t, { alpha: 0.2 }); labels.push(s.label) }
    // 由于迟滞，至少不应在第一帧就立刻翻到「闷闷不乐」
    expect(labels[0]).toBe('平静 😐')
  })
})

describe('driftToBaseline', () => {
  it('高唤醒情绪在空闲时向平静回归', () => {
    const s = fuseEmotionStep({ ...BASELINE }, '超开心 🎉', { alpha: 1, maxStepV: 2, maxStepA: 2 })
    expect(s.v).toBeGreaterThan(0.8)
    let cur = s
    for (let i = 0; i < 60; i++) {cur = driftToBaseline(cur)}
    expect(cur.v).toBeCloseTo(BASELINE.v, 1)
  })
})

describe('PetEmotionFusion 有状态封装', () => {
  it('next 累积、reset 回到基线', () => {
    const f = new PetEmotionFusion()
    const a = f.next('难过 😢')
    const b = f.next('难过 😢')
    expect(b.v).toBeLessThanOrEqual(a.v) // 持续走低
    f.reset()
    expect(f.get()).toEqual(BASELINE)
  })
  it('idle 在无输入时缓慢回归', () => {
    const f = new PetEmotionFusion()
    f.next('兴奋 🤩')
    const before = f.get().v
    for (let i = 0; i < 40; i++) {f.idle()}
    expect(f.get().v).toBeLessThan(before)
  })
})

describe('PetEmotionFusion.restore 持久化恢复', () => {
  it('restore 后延续上次情绪，而不是回基线', () => {
    const f = new PetEmotionFusion()
    f.restore({ v: 0.8, a: 0.5, label: '幸福 💖' })
    expect(f.get().v).toBeCloseTo(0.8, 2)
    expect(f.get().label).toBe('幸福 💖')
  })
  it('null/非法值安全降级到基线', () => {
    const f = new PetEmotionFusion()
    f.restore(null)
    expect(f.get().label).toBe(BASELINE.label)
    f.restore({ v: 999, a: -999, label: '' })
    expect(f.get().v).toBeLessThanOrEqual(1)
    expect(f.get().a).toBeGreaterThanOrEqual(0)
    expect(f.get().label).toBe(BASELINE.label)
  })
})
