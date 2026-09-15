import { describe, it, expect } from 'vitest'
import {
  buildPetMemoryContext, recordObservedEpisode, rememberUserFact, type PetMemorySource,
} from '../electron/pet/petMemoryBridge'

function mockSource(): { src: PetMemorySource; added: any[] } {
  const added: any[] = []
  const src: PetMemorySource = {
    getUserProfile: () => ({ name: '小明', preferences: ['鱼', '奶茶'], habits: ['熬夜'] }),
    getFacts: () => [
      { category: 'agent_memory', content: '内部状态不应注入', confidence: 1 },
      { category: 'preference', content: '偏好安静环境', confidence: 0.5 },
      { category: 'user', content: '在做一个桌宠项目', confidence: 0.95 },
      { category: 'event', content: '上周出差了', confidence: 0.8 },
    ],
    getRecentSummaries: () => ['今天一起调了口型同步'],
    getPersona: () => ({ traits: ['活泼', '细心', '偶尔毒舌'] }),
    addFact: (f) => { added.push(f); return 1 },
  }
  return { src, added }
}

describe('petMemoryBridge 记忆桥', () => {
  it('提炼画像/高置信事实/近期摘要/人格，过滤内部记忆', () => {
    const { src } = mockSource()
    const ctx = buildPetMemoryContext(src)
    expect(ctx.userName).toBe('小明')
    expect(ctx.snippet).toContain('用户叫 小明')
    expect(ctx.snippet).toContain('喜欢 鱼')
    expect(ctx.snippet).toContain('在做一个桌宠项目')
    expect(ctx.snippet).toContain('最近：今天一起调了口型同步')
    expect(ctx.snippet).toContain('你的性格：活泼')
    expect(ctx.snippet).not.toContain('内部状态不应注入')
    // 高置信事实排在前
    expect(ctx.lines.findIndex(l => l.includes('桌宠项目'))).toBeLessThan(ctx.lines.findIndex(l => l.includes('安静环境')))
  })

  it('空/缺失存储安全降级', () => {
    expect(buildPetMemoryContext(null).snippet).toBe('')
    expect(buildPetMemoryContext({}).lines).toEqual([])
  })

  it('某个读取方法抛错不影响其它内容', () => {
    const src: PetMemorySource = {
      getUserProfile: () => ({ name: '阿强' }),
      getFacts: () => { throw new Error('db locked') },
      getRecentSummaries: () => ['摘要一条'],
    }
    const ctx = buildPetMemoryContext(src)
    expect(ctx.userName).toBe('阿强')
    expect(ctx.snippet).toContain('摘要一条')
  })

  it('视觉情节写入：category=event, source=observed', () => {
    const { src, added } = mockSource()
    expect(recordObservedEpisode(src, '用户在写代码')).toBe(true)
    expect(added[0].category).toBe('event')
    expect(added[0].source).toBe('observed')
    expect(added[0].content).toContain('用户在写代码')
  })

  it('记住用户事实：高置信 user_said；无 addFact 时返回 false', () => {
    const { src, added } = mockSource()
    expect(rememberUserFact(src, '我喜欢猫')).toBe(true)
    expect(added[0].category).toBe('user')
    expect(added[0].confidence).toBeCloseTo(0.85)
    expect(rememberUserFact({}, 'x')).toBe(false)
  })
})
