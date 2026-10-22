// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
import { describe, it, expect } from 'vitest'
import {
  normalizeMood, teamFiveToCore, frontendThreeToCore, moodToCore, coreToMood, blendCore, MOOD_COORDS,
} from '../electron/pet/life/emotionCore'

describe('emotionCore 统一情绪核心', () => {
  it('normalizeMood 容忍漏 emoji 与口语', () => {
    expect(normalizeMood('开心 😊')).toBe('开心 😊')
    expect(normalizeMood('开心')).toBe('开心 😊')
    expect(normalizeMood('有点累')).toBe('疲惫 😩')
    expect(normalizeMood('激动')).toBe('兴奋 🤩')
    expect(normalizeMood('')).toBe(null)
    expect(normalizeMood(123)).toBe(null)
  })

  it('团队五维：高 joy 低焦虑 → 正效价；高疲劳压低唤醒', () => {
    const happy = teamFiveToCore({ joy: 0.9, fatigue: 0.1, focus: 0.6, anxiety: 0.05, curiosity: 0.7 })
    expect(happy.valence).toBeGreaterThan(0.5)
    expect(happy.arousal).toBeGreaterThan(0.5)
    const tired = teamFiveToCore({ joy: 0.3, fatigue: 0.95, focus: 0.2, anxiety: 0.2, curiosity: 0.2 })
    expect(tired.arousal).toBeLessThan(happy.arousal)
  })

  it('前端三维映射', () => {
    const c = frontendThreeToCore({ mood: 1, energy: 0, affinity: 0.8 })
    expect(c.valence).toBeCloseTo(1)
    expect(c.fatigue).toBeCloseTo(1)
    expect(c.affinity).toBeCloseTo(0.8)
  })

  it('标签→核心→标签 高唤醒高愉悦回到兴奋/超开心区', () => {
    const core = moodToCore('兴奋 🤩')
    const label = coreToMood(core)
    expect(['兴奋 🤩', '超开心 🎉']).toContain(label)
  })

  it('坐标最近邻：明确坐标反查正确', () => {
    expect(coreToMood({ valence: MOOD_COORDS['难过 😢'].v, arousal: MOOD_COORDS['难过 😢'].a })).toBe('难过 😢')
    expect(coreToMood({ valence: MOOD_COORDS['疲惫 😩'].v, arousal: MOOD_COORDS['疲惫 😩'].a })).toBe('疲惫 😩')
  })

  it('迟滞：边界附近保持当前标签', () => {
    // 平静与闷闷不乐之间取一个模糊点，给定 current 应倾向保持
    const label = coreToMood({ valence: -0.2, arousal: 0.39 }, '平静 😐', 0.2)
    expect(label).toBe('平静 😐')
  })

  it('blendCore 中点插值且 valence 允许负', () => {
    const a = moodToCore('难过 😢')
    const b = moodToCore('开心 😊')
    const mid = blendCore(a, b, 0.5)
    expect(mid.valence).toBeGreaterThan(a.valence)
    expect(mid.valence).toBeLessThan(b.valence)
  })
})
