// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
import { describe, it, expect } from 'vitest'
import { PetPerformanceEngine } from '../electron/pet/life/runtime'

function patchMap(e: ReturnType<PetPerformanceEngine['update']>) {
  return Object.fromEntries(e.map(p => [p.id, p.value]))
}

describe('PetPerformanceEngine 渲染运行时', () => {
  it('每帧产出呼吸，情绪驱动眉/嘴/眼笑', () => {
    const e = new PetPerformanceEngine()
    e.setBlinkEnabled(false)
    e.setMood('幸福 💖', 0)
    const m = patchMap(e.update(100))
    expect(m.ParamBreath).toBeGreaterThanOrEqual(0)
    expect(m.ParamMouthUp).toBeGreaterThan(0.2)
    expect(m.ParamEyeLSmile).toBeGreaterThan(0)
  })

  it('说话期五元音张开，结束后嘴闭合', () => {
    const e = new PetPerformanceEngine()
    e.setBlinkEnabled(false)
    e.speak('啊', 0)
    const during = patchMap(e.update(60))
    expect(during.ParamA).toBeCloseTo(1)
    const after = patchMap(e.update(5000))
    expect(after.ParamA ?? 0).toBe(0)
  })

  it('实时电平（无文本）也能驱动张合', () => {
    const e = new PetPerformanceEngine()
    e.setBlinkEnabled(false)
    e.setAudioLevel(0.9, 0)
    expect(patchMap(e.update(0)).ParamA).toBeGreaterThan(0.2)
  })

  it('表演 DSL：内置手势回传给渲染层，参数化手势落到肩/头', () => {
    const e = new PetPerformanceEngine()
    e.setBlinkEnabled(false)
    const wave = e.perform({ gesture: 'wave', effect: 'heart' }, 0)
    expect(wave.gesture).toBe('wave')
    expect(wave.builtin).toBe(true)
    expect(wave.effect?.name).toBe('heart')
    const shrug = e.perform({ gesture: { name: 'shrug', intensity: 1 } }, 10)
    expect(shrug.gesture).toBe('shrug')
    const m = patchMap(e.update(400)) // 等 200ms 淡入完成
    expect(m.ParamLeftShoulderUp).toBeGreaterThan(0.5)
  })

  it('非法表演指令安全忽略', () => {
    const e = new PetPerformanceEngine()
    expect(e.perform({ gesture: 'destroy' }, 0).gesture).toBeUndefined()
    expect(e.perform('nope', 0).gesture).toBeUndefined()
  })

  it('加载精简 cdi3 后按模型实际参数裁剪（缺 ParamA 则不驱动）', () => {
    const mini = { Parameters: [{ Id: 'ParamAngleX' }, { Id: 'ParamBreath' }, { Id: 'ParamMouthUp' }] }
    const e = new PetPerformanceEngine(mini, 'Mini')
    e.speak('啊', 0)
    const m = patchMap(e.update(60))
    expect(m.ParamA).toBeUndefined()
    expect(m.ParamBreath).toBeGreaterThanOrEqual(0)
  })
})
