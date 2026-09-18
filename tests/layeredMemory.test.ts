import { describe, it, expect } from 'vitest'
import {
  tokenize, bm25Scores, buildLayeredRecall,
  type LayeredMemorySource,
} from '../electron/memory/layeredMemory'

describe('BM25 分词（中文友好）', () => {
  it('中文产出 unigram 与 bigram', () => {
    const toks = tokenize('我喜欢海边旅行')
    expect(toks).toContain('海')
    expect(toks).toContain('海边')
    expect(toks).toContain('旅行')
  })
  it('拉丁词小写化', () => {
    const toks = tokenize('Hello World TypeScript')
    expect(toks).toContain('hello')
    expect(toks).toContain('typescript')
  })
})

describe('BM25 打分', () => {
  const docs = [
    '用户说想去海边旅行，喜欢晒太阳',
    '正在重构 TypeScript 类型系统',
    '用户喜欢吃火锅和海边',
  ]
  it('相关文档得分高于无关文档', () => {
    const s = bm25Scores('海边旅行', docs)
    expect(s[0]).toBeGreaterThan(s[1])
    expect(s[2]).toBeGreaterThan(s[1])
  })
  it('无查询时全部为 0', () => {
    expect(bm25Scores('', docs).every(v => v === 0)).toBe(true)
  })
})

describe('五层记忆召回', () => {
  const src: LayeredMemorySource = {
    getRecentConversation: () => [
      { role: 'user', content: '我明天要去海边' },
      { role: 'assistant', content: '好呀，记得带防晒' },
    ],
    getRecentSummaries: () => ['今天聊了旅行计划和海边'],
    getFacts: () => [
      { content: '用户喜欢去海边旅行', category: 'preference', confidence: 0.95 },
      { content: '用户不喜欢吃香菜', category: 'preference', confidence: 0.8 },
      { content: '项目里的数据库用 SQLite', category: 'environment', confidence: 0.7 },
    ],
    getReflections: () => [
      { topic: '旅行', insight: '用户提到海边时情绪明显更好', action: '多聊旅行' },
      { topic: '代码', insight: '用户在意类型安全', action: '强调类型' },
    ],
    getUserProfile: () => ({ name: '小明', preferences: ['海边', '猫'], habits: ['晚睡'] }),
    getPersona: () => ({ traits: ['活泼', '贴心'] }),
  }

  it('五层都能取到内容', () => {
    const r = buildLayeredRecall(src)
    expect(r.stats.perLayer.persona).toBeGreaterThan(0)
    expect(r.stats.perLayer.facts).toBeGreaterThan(0)
    expect(r.stats.perLayer.reflection).toBeGreaterThan(0)
    expect(r.stats.perLayer.recent).toBeGreaterThan(0)
    expect(r.stats.perLayer.working).toBeGreaterThan(0)
  })

  it('查询时海边相关事实排在数据库前面', () => {
    const r = buildLayeredRecall(src, { query: '海边旅行' })
    const facts = r.byLayer.facts
    expect(facts[0].text).toContain('海边')
  })

  it('人格层始终含用户姓名与自我人格', () => {
    const r = buildLayeredRecall(src)
    const personaText = r.byLayer.persona.map(i => i.text).join('|')
    expect(personaText).toContain('小明')
    expect(personaText).toContain('活泼')
  })

  it('prompt 含分层标题且合并后去重', () => {
    const r = buildLayeredRecall(src)
    expect(r.prompt).toContain('我对用户的基本了解')
    expect(r.prompt).toContain('我记得的事实')
    const texts = r.merged.map(i => i.text)
    expect(new Set(texts).size).toBe(texts.length)
  })

  it('空记忆源安全降级为空 prompt，不抛错', () => {
    const r = buildLayeredRecall(null)
    expect(r.prompt).toBe('')
    expect(r.stats.items).toBe(0)
  })

  it('方法全部抛错时仍安全降级', () => {
    const bad: LayeredMemorySource = {
      getFacts: () => { throw new Error('db locked') },
      getReflections: () => { throw new Error('boom') },
      getUserProfile: () => { throw new Error('x') },
    }
    const r = buildLayeredRecall(bad)
    expect(r.stats.items).toBe(0)
  })
})
