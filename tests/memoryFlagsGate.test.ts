// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/memoryFlagsGate.test.ts — 「记忆与进化」两个开关真的拦住写入
//
// 背景：这两个开关刚加时只是装饰（没有任何地方读）。
// 本测试钉住：关掉开关后，摘要/事实/反思/画像/技能经验/人格进化 都写不进去。
// ============================================================
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const calls = vi.hoisted(() => ({
  summary: 0, fact: 0, reflection: 0, profile: 0, config: 0, traits: 0, evolution: 0,
}))

vi.mock('../electron/memory/memoryStore', () => ({
  getMemoryStore: () => ({
    addConversationSummary: () => { calls.summary++; return 1 },
    cleanup: () => {},
    addFact: () => { calls.fact++; return 1 },
    getFacts: () => [],
    correctFact: () => ({ newId: 1 }),
    addReflection: () => { calls.reflection++; return 1 },
    saveUserProfile: () => { calls.profile++ },
    saveMemoryConfig: () => { calls.config++ },
    savePersonaTraits: () => { calls.traits++ },
    addPersonaTraits: () => { calls.traits++ },
    addEvolutionLog: () => { calls.evolution++ },
  }),
  normalizeFactSource: (s: string) => s || 'user_stated',
  SOURCE_CONFIDENCE: { user_stated: 1, model_inferred: 0.5, observed: 0.8 },
}))

import { setFlag } from '../electron/core/featureFlags'
import { ConversationSummarizer, GlobalMemoryRefiner } from '../electron/memory/summarizer'
import { memorySave } from '../electron/tools/impl/memory_v2'

function resetCalls() { for (const k of Object.keys(calls) as Array<keyof typeof calls>) {calls[k] = 0} }

describe('记忆与进化 · 对话记忆开关', () => {
  beforeEach(resetCalls)
  afterEach(() => setFlag('memory.conversation', true))

  it('OFF → 摘要 / 事实 / 反思 / 用户画像 都不写', async () => {
    setFlag('memory.conversation', false)
    await new ConversationSummarizer('t').summarize('hello')
    const r = new GlobalMemoryRefiner()
    r.applyFactsExtraction([{ category: 'fact', content: 'x', confidence: 0.9, source: 'user' }])
    r.applyReflections([{ topic: 't', insight: 'i', action: 'a' }])
    r.applyRefinement({ user: { preferences: ['p'] } })

    expect(calls.summary).toBe(0)
    expect(calls.fact).toBe(0)
    expect(calls.reflection).toBe(0)
    expect(calls.profile).toBe(0)
  })

  it('ON → 正常写入', async () => {
    setFlag('memory.conversation', true)
    await new ConversationSummarizer('t').summarize('hello')
    const r = new GlobalMemoryRefiner()
    r.applyFactsExtraction([{ category: 'fact', content: 'x', confidence: 0.9, source: 'user' }])
    r.applyReflections([{ topic: 't', insight: 'i', action: 'a' }])
    r.applyRefinement({ user: { preferences: ['p'] } })

    expect(calls.summary).toBe(1)
    expect(calls.fact).toBe(1)
    expect(calls.reflection).toBe(1)
    expect(calls.profile).toBe(1)
  })
})

describe('记忆与进化 · 本地记忆与技能开关', () => {
  beforeEach(resetCalls)
  afterEach(() => setFlag('memory.localSkills', true))

  it('OFF → 技能经验 / 人格进化 都不写', () => {
    setFlag('memory.localSkills', false)
    const r = new GlobalMemoryRefiner()
    r.applyRefinement({ memory: { lessons: ['l'], toolExperience: ['e'] } })
    r.applyPersonaUpdate({ traits: ['curious'], traitChange: 'grew' })

    expect(calls.config).toBe(0)
    expect(calls.traits).toBe(0)
    expect(calls.evolution).toBe(0)
  })

  it('ON → 正常写入', () => {
    setFlag('memory.localSkills', true)
    const r = new GlobalMemoryRefiner()
    r.applyRefinement({ memory: { lessons: ['l'] } })
    r.applyPersonaUpdate({ traits: ['curious'], traitChange: 'grew' })

    expect(calls.config).toBe(1)
    expect(calls.traits).toBe(1)
    expect(calls.evolution).toBe(1)
  })
})

describe('记忆与进化 · memory_save 工具（真实活路径）', () => {
  beforeEach(resetCalls)
  afterEach(() => { setFlag('memory.conversation', true); setFlag('memory.localSkills', true) })

  it('对话记忆 OFF → fact 被拒绝，且一条都没写', async () => {
    setFlag('memory.conversation', false)
    const r = await memorySave({ category: 'fact', content: '用户住在杭州' })
    expect(r.ok).toBe(false)
    expect(calls.fact).toBe(0)
  })

  it('对话记忆 ON → fact 正常写入', async () => {
    setFlag('memory.conversation', true)
    const r = await memorySave({ category: 'fact', content: '用户住在杭州' })
    expect(r.ok).toBe(true)
    expect(calls.fact).toBe(1)
  })

  it('对话记忆 OFF → reflection 也被拒绝', async () => {
    setFlag('memory.conversation', false)
    const r = await memorySave({ category: 'reflection', content: 'x' })
    expect(r.ok).toBe(false)
    expect(calls.reflection).toBe(0)
  })

  it('本地记忆与技能 OFF → lesson 被拒绝（属"工作过程/技能"）', async () => {
    setFlag('memory.localSkills', false)
    const r = await memorySave({ category: 'lesson', content: 'x' })
    expect(r.ok).toBe(false)
    expect(calls.config).toBe(0)
  })

  it('本地记忆与技能 ON → lesson 正常写入', async () => {
    setFlag('memory.localSkills', true)
    const r = await memorySave({ category: 'lesson', content: 'x' })
    expect(r.ok).toBe(true)
    expect(calls.config).toBe(1)
  })
})
