// ============================================================
// proactiveGenerator.test.ts — 🔌 接线契约测试
//
// 防的是「写了没生效」：LLM 决策结果能否真正变成一条可下发的主动台词。
// 覆盖四条关键分支：沉默 / 合法台词 / 坏 JSON 兜底 / LLM 抛错兜底，
// 并断言产出的 action 一定是已知动作（不会下发一个页面不认识的动作）。
// ============================================================
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// mock 掉真实 LLM 调用与连续情绪（保持纯逻辑测试，不碰 Electron/网络）
vi.mock('../electron/proactive/resolveProactiveLLM', () => ({
  chatComplete: vi.fn(),
}))
vi.mock('../electron/pet/life/emotionCore', () => ({
  coreToMood: () => '开心 😊',
}))

import { generateProactive } from '../electron/proactive/generator'
import { chatComplete } from '../electron/proactive/resolveProactiveLLM'

const mockedChat = vi.mocked(chatComplete)

const KNOWN_ACTIONS = new Set([
  'wave', 'nod', 'think', 'sleep', 'wake', 'happy', 'sad',
  'dance', 'blink', 'walk', 'say', 'idle',
])

const baseCtx = {
  drives: { energy: 0.8, social: 0.6, curiosity: 0.5, comfort: 0.7 },
  valence: 0.2,
  arousal: 0.4,
  currentMoodLabel: '平静 😐',
  memorySnippet: '',
  recentSpeeches: [],
  followups: [] as string[],
  innerThought: '',
}

const baseEvent = { source: 'autonomy_tick' as const }

beforeEach(() => {
  mockedChat.mockReset()
  // 固定为白天中午：enrichAction 在 23:00-6:00 会优先返回 sleep，
  // 不固定时间会让「开心情绪保底 happy/wave」用例在夜间运行时偶发失败
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 0, 2, 12, 0, 0))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('generator 主动台词接线契约', () => {
  it('1. LLM 说 shouldSpeak:false → 本轮沉默（不强行搭话）', async () => {
    mockedChat.mockResolvedValueOnce(JSON.stringify({ shouldSpeak: false, reason: '没什么好说的' }))
    const d = await generateProactive(baseEvent, baseCtx)
    expect(d.shouldSpeak).toBe(false)
  })

  it('2. LLM 返回合法台词 → 产出 action+mood+speech，action 在已知动作集', async () => {
    mockedChat.mockResolvedValueOnce(JSON.stringify({
      shouldSpeak: true, action: 'wave', speech: '嘿，还在忙吗？',
    }))
    const d = await generateProactive(baseEvent, baseCtx)
    expect(d.shouldSpeak).toBe(true)
    expect(d.speech).toContain('忙吗')
    expect(KNOWN_ACTIONS.has(d.action || '')).toBe(true)
  })

  it('3. LLM 返回坏 JSON（无可用台词）→ 走兜底模板，仍产出非空台词', async () => {
    mockedChat.mockResolvedValueOnce('这不是JSON，是一段胡言乱语')
    const d = await generateProactive(baseEvent, baseCtx)
    expect(d.shouldSpeak).toBe(true)
    expect((d.speech || '').length).toBeGreaterThan(0)
  })

  it('4. LLM 直接抛错 → 走兜底模板（保证她「活着」，不崩溃）', async () => {
    mockedChat.mockRejectedValueOnce(new Error('LLM 超时'))
    const d = await generateProactive(baseEvent, baseCtx)
    expect(d.shouldSpeak).toBe(true)
    expect((d.speech || '').length).toBeGreaterThan(0)
  })

  it('5. LLM 输出带 ```json 包裹时仍能正确解析出台词', async () => {
    mockedChat.mockResolvedValueOnce('```json\n' + JSON.stringify({
      shouldSpeak: true, action: 'say', speech: '看看窗外吧',
    }) + '\n```')
    const d = await generateProactive(baseEvent, baseCtx)
    expect(d.shouldSpeak).toBe(true)
    expect(d.speech).toContain('窗外')
  })

  it('6. 情绪 mood 以连续态为准，不直接采用 LLM 自报情绪', async () => {
    mockedChat.mockResolvedValueOnce(JSON.stringify({
      shouldSpeak: true, action: 'say', mood: '低落 😔', speech: '测试情绪',
    }))
    const d = await generateProactive(baseEvent, baseCtx)
    // 我们 mock 的 coreToMood 恒返回「开心 😊」，验证 LLM 的「低落」没有被直接采用
    expect(d.mood).toBe('开心 😊')
  })

  it('7. LLM 偷懒只给 say → 按情绪补可见动作（开口必动，不只动嘴）', async () => {
    mockedChat.mockResolvedValueOnce(JSON.stringify({
      shouldSpeak: true, action: 'say', speech: '今天好呀',
    }))
    const d = await generateProactive(baseEvent, baseCtx)
    expect(d.shouldSpeak).toBe(true)
    // mock 的 coreToMood 恒返回「开心 😊」，开心保底动作是 happy / wave
    expect(['happy', 'wave']).toContain(d.action)
    expect(d.action).not.toBe('say')
  })
})
