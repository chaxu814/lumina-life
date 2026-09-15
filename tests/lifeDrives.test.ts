import { describe, it, expect } from 'vitest'
import {
  DEFAULT_DRIVES, tickDrives, applyInteraction, behaviorUrges, dominantUrge,
} from '../electron/pet/life/drives'

describe('drives 内驱力系统', () => {
  it('长时间无互动：社交需求与好奇上升、精力下降', () => {
    const d = tickDrives(DEFAULT_DRIVES, { dtMin: 120, hourOfDay: 14, sleeping: false, hadInteraction: false })
    expect(d.social).toBeGreaterThan(DEFAULT_DRIVES.social)
    expect(d.curiosity).toBeGreaterThan(DEFAULT_DRIVES.curiosity)
    expect(d.energy).toBeLessThan(DEFAULT_DRIVES.energy)
  })

  it('深夜精力消耗更快', () => {
    const day = tickDrives(DEFAULT_DRIVES, { dtMin: 120, hourOfDay: 14 })
    const night = tickDrives(DEFAULT_DRIVES, { dtMin: 120, hourOfDay: 2 })
    expect(night.energy).toBeLessThan(day.energy)
  })

  it('睡眠恢复精力', () => {
    const exhausted = { ...DEFAULT_DRIVES, energy: 0.1 }
    const d = tickDrives(exhausted, { dtMin: 60, sleeping: true })
    expect(d.energy).toBeGreaterThan(0.1)
  })

  it('聊天显著降低社交需求，被凶降低安心感', () => {
    const chatted = applyInteraction({ ...DEFAULT_DRIVES, social: 0.9 }, 'chat')
    expect(chatted.social).toBeLessThan(0.9)
    const scolded = applyInteraction(DEFAULT_DRIVES, 'scold')
    expect(scolded.comfort).toBeLessThan(DEFAULT_DRIVES.comfort)
  })

  it('行为倾向：低精力倾向休息，高社交需求倾向求关注', () => {
    const tired = behaviorUrges({ ...DEFAULT_DRIVES, energy: 0.05 })
    expect(tired.rest).toBeGreaterThan(0.6)
    const lonely = behaviorUrges({ ...DEFAULT_DRIVES, social: 1, comfort: 0.3 })
    expect(lonely.seekAttention).toBeGreaterThan(0.7)
  })

  it('dominantUrge 选出最高分倾向', () => {
    expect(dominantUrge({ seekAttention: 0.9, rest: 0.1, explore: 0.2, play: 0.1, calmCompanion: 0.1 })).toBe('seekAttention')
  })
})
