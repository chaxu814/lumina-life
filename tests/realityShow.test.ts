import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  generateShowEvent, generateShowEventAsync, registerRealityShowLLM,
  startRealityShow, stopRealityShow, getShowHistory,
} from '../electron/realityShow/realityShowEngine'

describe('realityShow 真人秀引擎', () => {
  beforeEach(() => {
    stopRealityShow()
    registerRealityShowLLM(null)
  })

  it('模板事件字段完整且标记 source=template', () => {
    const e = generateShowEvent()
    expect(e.id).toBeTruthy()
    expect(e.type).toBeTruthy()
    expect(e.title).toContain('')
    expect(e.content.length).toBeGreaterThan(0)
    expect(e.source).toBe('template')
  })

  it('注册 LLM 后，内心独白可由模型生成（多抽几次必中 thought）', async () => {
    registerRealityShowLLM(async () => '我在想，主人今天好像有点累，要不要提醒他喝水呢。')
    let llmCount = 0
    for (let i = 0; i < 60; i++) {
      const e = await generateShowEventAsync()
      if (e.source === 'llm') {
        llmCount++
        expect(e.type).toBe('agent:thought')
        expect(e.content).toContain('喝水')
      }
    }
    expect(llmCount).toBeGreaterThan(0)
  })

  it('LLM 抛错时安全回退模板，不抛出', async () => {
    registerRealityShowLLM(async () => { throw new Error('boom') })
    let threw = false
    for (let i = 0; i < 10; i++) {
      try { await generateShowEventAsync() } catch { threw = true }
    }
    expect(threw).toBe(false)
  })

  it('start/stop 后能取到历史', async () => {
    startRealityShow(60_000) // 不会在测试期间触发
    stopRealityShow()
    expect(Array.isArray(getShowHistory())).toBe(true)
  })
})
