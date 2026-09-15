import { describe, it, expect } from 'vitest'
import { AnimationMixer, speechPoseFor } from '../electron/pet/life/animationMixer'
import { visemePose } from '../electron/pet/life/faceRig'

describe('animationMixer 分层混合器', () => {
  it('base 呼吸 + emotion 表情共存', () => {
    const m = new AnimationMixer()
    m.setLayer('base', { breath: 0.5 }, { now: 0 })
    m.setLayer('emotion', { mouthUp: 0.8, browLY: 0.2 }, { now: 0 })
    const pose = m.frame(0)
    expect(pose.breath).toBeCloseTo(0.5)
    expect(pose.mouthUp).toBeCloseTo(0.8)
  })

  it('speech 层提供五元音', () => {
    const m = new AnimationMixer()
    m.setLayer('emotion', { mouthUp: 0.5 }, { now: 0 })
    m.setLayer('speech', speechPoseFor('A', 1), { now: 0 })
    const pose = m.frame(0)
    expect(pose.visemeA).toBeCloseTo(1)
    expect(pose.visemeI).toBeCloseTo(0)
  })

  it('action 层 TTL 到期自动消失', () => {
    const m = new AnimationMixer()
    m.setLayer('emotion', { headRoll: 0 }, { now: 0 })
    m.setLayer('action', { headRoll: 10 }, { now: 0, ttlMs: 100, fadeMs: 0 })
    expect(m.frame(0).headRoll).toBeCloseTo(10)
    const after = m.frame(200)
    expect(m.has('action')).toBe(false)          // 到期移除
    expect(after.headRoll ?? 0).toBeLessThan(10) // 朝情绪层(0)平滑回落
  })

  it('action 淡入 envelope：半程权重 0.5', () => {
    const m = new AnimationMixer()
    m.setLayer('emotion', { headRoll: 0 }, { now: 0 })
    m.setLayer('action', { headRoll: 10 }, { now: 0, ttlMs: 1000, fadeMs: 100 })
    const pose = m.frame(50)
    expect(pose.headRoll).toBeCloseTo(5)
  })

  it('变化率限速防止鬼畜（角度每帧≤9）', () => {
    const m = new AnimationMixer({ maxDeltaAngle: 9 })
    m.setLayer('emotion', { headPitch: 30 }, { now: 0 })
    expect(m.frame(0).headPitch).toBeCloseTo(30) // 首帧直接到位
    m.setLayer('emotion', { headPitch: -30 }, { now: 16 })
    const limited = m.frame(16).headPitch ?? 0
    expect(limited).toBeGreaterThan(15) // 从 30 最多降到 21
    expect(limited).toBeLessThan(27)
  })

  it('眨眼乘性闭合双眼', () => {
    const m = new AnimationMixer()
    m.setLayer('emotion', { eyeLOpen: 1, eyeROpen: 1 }, { now: 0 })
    m.setBlink(1)
    const pose = m.frame(0)
    expect(pose.eyeLOpen).toBeCloseTo(0)
    expect(pose.eyeROpen).toBeCloseTo(0)
  })

  it('clearLayer 移除层', () => {
    const m = new AnimationMixer()
    m.setLayer('emotion', { mouthUp: 0.9 }, { now: 0 })
    m.clearLayer('emotion')
    expect(m.frame(0).mouthUp).toBeUndefined()
  })
})
