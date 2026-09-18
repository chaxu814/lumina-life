// tests/layeredMemoryAdapter.test.ts — 五层记忆适配器（用内存假 store，不碰原生 sqlite）
import { describe, it, expect } from 'vitest'
import { createMemoryStoreAdapter, layeredSourceFromStore } from '../electron/memory/layeredMemoryAdapter'
import { buildLayeredRecall } from '../electron/memory/layeredMemory'

function makeFakeStore() {
  // 模拟 SQL 已过滤掉 tool，且按时间倒序返回（适配器会再反转成正序）
  const convRows = [
    { role: 'assistant', content: '我是最后一条助手回复', created_at: '2026-09-18 10:02:00' },
    { role: 'user', content: '我喜欢冰美式', created_at: '2026-09-18 10:01:00' },
  ]
  const store: any = {
    getDb: () => ({
      prepare: () => ({
        // 适配器按倒序取再反转
        all: () => convRows,
      }),
    }),
    getRecentSummaries: (n: number) => [`摘要1：用户在准备考试`, `摘要2：天气转凉`].slice(0, n),
    getFacts: (_cat: unknown, limit: number) => ([
      { content: '用户喜欢喝冰美式咖啡', category: 'preference', confidence: 0.9, source: 'chat', timestamp: '2026-09-18 09:00:00' },
      { content: '用户住在河池', category: 'env', confidence: 0.8, source: 'chat', timestamp: '2026-09-18 08:00:00' },
      { content: '无关事实：用户讨厌香菜', category: 'preference', confidence: 0.6, source: 'chat', timestamp: '2026-09-18 07:00:00' },
    ]).slice(0, limit),
    getReflections: (n: number) => ([
      { topic: '咖啡', insight: '用户早晨需要提神', action: '推荐咖啡店', timestamp: '2026-09-18 09:30:00' },
    ]).slice(0, n),
    getUserProfile: () => ({ name: '阿茶', preferences: ['冰美式'], habits: ['熬夜'] }),
    getPersona: () => ({ traits: ['温柔', '幽默'] }),
  }
  return store
}

describe('layeredMemoryAdapter 五层记忆适配器', () => {
  it('空 store 安全降级为全空源，不抛错', () => {
    const a = createMemoryStoreAdapter(null)
    expect(a.getRecentConversation?.(4)).toEqual([])
    expect(a.getFacts?.(4)).toEqual([])
    expect(a.getUserProfile?.()).toBeNull()
    expect(layeredSourceFromStore(undefined).getReflections?.(3)).toEqual([])
    const recall = buildLayeredRecall(a)
    expect(recall.stats.items).toBe(0)
    expect(recall.prompt).toBe('')
  })

  it('把 MemoryStore 各层映射到五层召回（含跨会话对话反转）', () => {
    const adapter = createMemoryStoreAdapter(makeFakeStore())
    // 工作层：SQL 已过滤 tool，适配器把倒序结果反转成时间正序
    const conv = adapter.getRecentConversation?.(4)!
    expect(conv).toHaveLength(2)
    expect(conv[0].content).toBe('我喜欢冰美式')
    expect(conv[conv.length - 1].content).toBe('我是最后一条助手回复')

    expect(adapter.getRecentSummaries?.(2)).toHaveLength(2)
    expect(adapter.getFacts?.(3)[0].content).toContain('冰美式')
    expect(adapter.getUserProfile?.()?.name).toBe('阿茶')
    expect(adapter.getPersona?.()?.traits).toContain('温柔')
  })

  it('端到端：相关查询优先召回匹配事实，且人格层始终在场', () => {
    const recall = buildLayeredRecall(createMemoryStoreAdapter(makeFakeStore()), {
      query: '我想喝咖啡',
      budget: { persona: 5, facts: 6, reflection: 3, recent: 2, working: 4 },
    })
    expect(recall.byLayer.persona.length).toBeGreaterThan(0)
    // 「咖啡」相关事实应排到前面
    expect(recall.byLayer.facts[0].text).toContain('冰美式')
    // 五层都应能出现在 prompt
    expect(recall.prompt).toContain('我对用户的基本了解')
    expect(recall.prompt).toContain('我记得的事实')
    expect(recall.stats.items).toBeGreaterThan(3)
  })

  it('底层查询抛错时安全降级（不影响主链路）', () => {
    const broken: any = {
      getDb: () => { throw new Error('db closed') },
      getRecentSummaries: () => { throw new Error('x') },
      getFacts: () => { throw new Error('x') },
      getReflections: () => { throw new Error('x') },
      getUserProfile: () => { throw new Error('x') },
      getPersona: () => { throw new Error('x') },
    }
    const a = createMemoryStoreAdapter(broken)
    expect(a.getRecentConversation?.(4)).toEqual([])
    expect(a.getFacts?.(4)).toEqual([])
    expect(a.getUserProfile?.()).toBeNull()
    expect(buildLayeredRecall(a).stats.items).toBe(0)
  })
})
