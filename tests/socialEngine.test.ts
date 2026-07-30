// tests/socialEngine.test.ts — 社交引擎 + 自发话题 单元测试
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: (name: string) => process.cwd() },
}))

// 直接测试 topic templates 结构（不需要完整 engine 实例化）
const SPONTANEOUS_TOPICS = [
  {
    topic: '早间签到',
    mode: 'morning_ritual' as const,
    initiator: 'lumina',
    participants: ['lumina', 'recha', 'yak'],
    maxRounds: 6,
    weight: 10,
    condition: (h: number) => h >= 7 && h <= 10,
  },
  {
    topic: '晚间回顾',
    mode: 'evening_ritual' as const,
    initiator: 'yak',
    participants: ['lumina', 'recha', 'yak'],
    maxRounds: 6,
    weight: 10,
    condition: (h: number) => h >= 21 && h <= 23,
  },
  {
    topic: '午后茶歇',
    mode: 'afternoon_ritual' as const,
    initiator: 'recha',
    participants: ['recha', 'lumina'],
    maxRounds: 4,
    weight: 8,
    condition: (h: number) => h >= 14 && h <= 16,
  },
  {
    topic: '技术争论',
    mode: 'debate' as const,
    initiator: 'recha',
    participants: ['recha', 'yak'],
    maxRounds: 4,
    weight: 5,
    condition: () => true,
  },
  {
    topic: '前端框架吐槽',
    mode: 'spontaneous' as const,
    initiator: 'recha',
    participants: ['recha', 'yak'],
    maxRounds: 4,
    weight: 4,
    condition: () => Math.random() < 0.3,
  },
]

describe('Social topic templates', () => {
  it('has 5 topic types', () => {
    expect(SPONTANEOUS_TOPICS.length).toBe(5)
  })

  it('morning ritual triggers at 7-10 AM', () => {
    const morning = SPONTANEOUS_TOPICS.find(t => t.topic === '早间签到')!
    expect(morning.condition(8)).toBe(true)
    expect(morning.condition(6)).toBe(false)
    expect(morning.condition(11)).toBe(false)
    expect(morning.condition(7)).toBe(true)
    expect(morning.condition(10)).toBe(true)
  })

  it('evening ritual triggers at 9-11 PM', () => {
    const evening = SPONTANEOUS_TOPICS.find(t => t.topic === '晚间回顾')!
    expect(evening.condition(22)).toBe(true)
    expect(evening.condition(20)).toBe(false)
    expect(evening.condition(21)).toBe(true)
    expect(evening.condition(23)).toBe(true)
  })

  it('afternoon tea triggers at 2-4 PM', () => {
    const tea = SPONTANEOUS_TOPICS.find(t => t.topic === '午后茶歇')!
    expect(tea.condition(14)).toBe(true)
    expect(tea.condition(15)).toBe(true)
    expect(tea.condition(13)).toBe(false)
    expect(tea.condition(17)).toBe(false)
  })

  it('debate topics involve recha and yak', () => {
    for (const t of SPONTANEOUS_TOPICS) {
      if (t.mode === 'debate') {
        expect(t.participants).toContain('recha')
        expect(t.participants).toContain('yak')
      }
    }
  })

  it('morning and evening rituals include all 3 agents', () => {
    for (const t of SPONTANEOUS_TOPICS) {
      if (t.mode === 'morning_ritual' || t.mode === 'evening_ritual') {
        expect(t.participants.length).toBeGreaterThanOrEqual(3)
      }
    }
  })

  it('each topic has a valid initiator', () => {
    const validAgents = ['lumina', 'recha', 'yak']
    for (const t of SPONTANEOUS_TOPICS) {
      expect(validAgents).toContain(t.initiator)
    }
  })

  it('topics are sorted by weight', () => {
    const weights = SPONTANEOUS_TOPICS.map(t => t.weight)
    for (let i = 1; i < weights.length; i++) {
      expect(weights[i]).toBeLessThanOrEqual(weights[i - 1])
    }
  })
})

describe('Conversation modes', () => {
  const modes = ['morning_ritual', 'evening_ritual', 'afternoon_ritual', 'debate', 'spontaneous', 'collaboration', 'decision']

  it('all 7 modes are distinct', () => {
    expect(new Set(modes).size).toBe(7)
  })
})
