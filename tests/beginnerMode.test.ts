// ============================================================
// tests/beginnerMode.test.ts — 新手模式测试
// ============================================================
import { describe, it, expect } from 'vitest'
import {
  recommendPath,
  CHEAP_CLOUD_SUGGESTIONS,
  BEGINNER_DEFAULT_TOGGLES,
  buildBeginnerGreeting,
  FIRST_RUN_EXAMPLES,
  type LocalProbe,
} from '../electron/onboarding/beginnerMode'

const nothing: LocalProbe = {
  lmstudio: { available: false, models: [] },
  ollama: { available: false, models: [] },
  hasCloudKey: false,
}

describe('新手路径推荐', () => {
  it('检测到 LM Studio 就推本地（免费优先）', () => {
    const r = recommendPath({ ...nothing, lmstudio: { available: true, models: ['qwen2.5-7b'] } })
    expect(r.path).toBe('local')
    expect(r.cost).toBe('完全免费（本地）')
    expect(r.steps.join()).toMatch(/LM Studio/)
  })

  it('检测到 Ollama 也推本地并给出拉取命令', () => {
    const r = recommendPath({ ...nothing, ollama: { available: true, models: ['qwen2.5:7b'] } })
    expect(r.path).toBe('local')
    expect(r.steps.join()).toMatch(/ollama pull/)
  })

  it('LM Studio 存在但没加载模型时，不当作可用（不假装能跑）', () => {
    const r = recommendPath({ ...nothing, lmstudio: { available: true, models: [] } })
    expect(r.path).not.toBe('local')
  })

  it('两者都有时优先 LM Studio', () => {
    const r = recommendPath({
      lmstudio: { available: true, models: ['a'] },
      ollama: { available: true, models: ['b'] },
      hasCloudKey: false,
    })
    expect(r.steps.join()).toMatch(/LM Studio/)
  })

  it('已有云端 Key 时直接建议继续用，不折腾本地', () => {
    const r = recommendPath({ ...nothing, hasCloudKey: true, cloudProvider: 'DeepSeek' })
    expect(r.path).toBe('cloud')
    expect(r.title).toMatch(/DeepSeek/)
  })

  it('什么都没有时给两条路，并诚实说明当前不支持开箱即用', () => {
    const r = recommendPath(nothing)
    expect(r.path).toBe('zero-config')
    expect(r.steps.join()).toMatch(/LM Studio/)
    expect(r.steps.join()).toMatch(/API Key/)
    expect(r.limitations.join()).toMatch(/开箱即用/)
  })
})

describe('诚实的限制声明', () => {
  it('本地路径必须说明硬件要求（不能让人白折腾）', () => {
    const r = recommendPath({ ...nothing, lmstudio: { available: true, models: ['x'] } })
    expect(r.limitations.join()).toMatch(/内存|显存/)
  })

  it('云端路径必须提示数据会发出去', () => {
    const r = recommendPath({ ...nothing, hasCloudKey: true })
    expect(r.limitations.join()).toMatch(/发送|云/)
  })

  it('每条路径都至少有一条限制说明', () => {
    const cases = [
      recommendPath(nothing),
      recommendPath({ ...nothing, hasCloudKey: true }),
      recommendPath({ ...nothing, lmstudio: { available: true, models: ['a'] } }),
    ]
    for (const c of cases) {
      expect(c.limitations.length).toBeGreaterThan(0)
      expect(c.steps.length).toBeGreaterThan(0)
    }
  })
})

describe('云端推荐表', () => {
  it('每条都有 provider 与 baseUrl', () => {
    for (const s of CHEAP_CLOUD_SUGGESTIONS) {
      expect(s.provider).toBeTruthy()
      expect(s.baseUrl).toMatch(/^https:\/\//)
    }
  })

  it('包含以便宜著称的 DeepSeek', () => {
    expect(CHEAP_CLOUD_SUGGESTIONS.some(s => s.provider.includes('DeepSeek'))).toBe(true)
  })
})

describe('新手默认开关（保守优先）', () => {
  it('主动说话/全屏注视/后台自主任务默认关 —— 新手不该被吓到', () => {
    expect(BEGINNER_DEFAULT_TOGGLES.proactiveChat).toBe(false)
    expect(BEGINNER_DEFAULT_TOGGLES.screenAwareness).toBe(false)
    expect(BEGINNER_DEFAULT_TOGGLES.backgroundAutonomy).toBe(false)
  })

  it('隐私遮罩默认开', () => {
    expect(BEGINNER_DEFAULT_TOGGLES.screenPrivacyMask).toBe(true)
  })
})

describe('开场白', () => {
  it('讲人话：说清楚需要一个模型、给出两条路', () => {
    const g = buildBeginnerGreeting()
    expect(g).toMatch(/模型/)
    expect(g).toMatch(/LM Studio/)
    expect(g).toMatch(/API Key/)
  })

  it('带上了宠物名字', () => {
    expect(buildBeginnerGreeting('小光')).toMatch(/小光/)
  })

  it('至少给 3 个上手示例', () => {
    expect(FIRST_RUN_EXAMPLES.length).toBeGreaterThanOrEqual(3)
    expect(buildBeginnerGreeting()).toContain(FIRST_RUN_EXAMPLES[0])
  })
})
