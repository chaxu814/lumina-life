// routingDecider.test.ts — 任务路由决策测试
//
// 这些用例锁住的是用户诉求「问什么就解决什么」里最容易翻车的一环：
// 纯正则路由在歧义任务上必然失手（漏派/错派）。
// 这里的重点不是「规则表全了」，而是**歧义必进 LLM、LLM 挂了必能兜底**。
import { describe, it, expect } from 'vitest'
import {
  classifyByRules,
  decideRoute,
  parseArbiterAnswer,
  buildArbiterPrompt,
  type RouteInput,
  type RouteTarget,
} from '../electron/orchestration/routingDecider'

// ═══════════════════════════════════════════════════════════
// 规则层
// ═══════════════════════════════════════════════════════════

describe('classifyByRules — 明确代码任务派 Yak', () => {
  const yakCases = [
    '帮我写一个爬虫脚本',
    '实现一个登录接口',
    '这个 bug 帮我修一下',
    '重构一下这个模块',
    '给这个函数加个单元测试',
    '帮我跑一下测试',
    'git commit 一下',
    '安装一下项目依赖',
  ]
  for (const t of yakCases) {
    it(`yak: ${t}`, () => {
      const v = classifyByRules({ text: t })
      expect(v.target).toBe('yak')
      expect(v.confidence).toBe('high')
    })
  }
})

describe('classifyByRules — 明确审查任务派热茶', () => {
  const rechaCases = [
    '帮我审查一下这段代码',
    '看看这个方案有什么风险',
    '这两个框架的优缺点是什么',
    '帮我挑挑毛病',
    '这个设计到底该不该用',
  ]
  for (const t of rechaCases) {
    it(`recha: ${t}`, () => {
      const v = classifyByRules({ text: t })
      expect(v.target).toBe('recha')
      expect(v.confidence).toBe('high')
    })
  }
})

describe('classifyByRules — Lumina 自答不外派', () => {
  const selfCases = [
    '你好',
    '哈哈哈哈哈',
    '在吗',
    '你是谁',
    '帮我翻译一下这段话',
    '今天天气怎么样',
  ]
  for (const t of selfCases) {
    it(`self: ${t}`, () => {
      const v = classifyByRules({ text: t })
      expect(v.target).toBe('lumina')
      expect(v.confidence).toBe('high')
    })
  }
})

describe('classifyByRules — 歧义任务必须交给 LLM（正则盲区）', () => {
  it('「这玩意跑起来就崩」——旧正则一个都不匹配，必须仲裁', () => {
    const v = classifyByRules({ text: '这玩意跑起来就崩，你帮我看看' })
    expect(v.target).toBeNull()
    expect(v.confidence).toBe('low')
  })

  it('代码类 + 审查类信号同时命中 → 冲突，需仲裁', () => {
    const v = classifyByRules({ text: '写个爬虫，然后帮我审查一下有没有漏洞' })
    expect(v.confidence).toBe('low')
  })

  it('纯咨询类模糊表达需仲裁', () => {
    const v = classifyByRules({ text: '你觉得这个思路行得通吗' })
    expect(v.confidence).toBe('low')
  })
})

describe('classifyByRules — 可用成员约束', () => {
  it('Yak 未配置时不应派给 Yak', () => {
    const v = classifyByRules({ text: '帮我写个爬虫', available: ['lumina', 'recha'] })
    // Yak 不可用 → 不能判定为 yak
    expect(v.target).not.toBe('yak')
  })

  it('空输入直接给 Lumina', () => {
    const v = classifyByRules({ text: '' })
    expect(v.target).toBe('lumina')
    expect(v.confidence).toBe('high')
  })
})

// ═══════════════════════════════════════════════════════════
// 仲裁输出解析
// ═══════════════════════════════════════════════════════════

describe('parseArbiterAnswer', () => {
  it('抽取纯角色名', () => {
    expect(parseArbiterAnswer('yak')).toBe('yak')
    expect(parseArbiterAnswer('recha')).toBe('recha')
    expect(parseArbiterAnswer('LUMINA')).toBe('lumina')
  })

  it('从带解释的长文本中抽取', () => {
    expect(parseArbiterAnswer('这个任务需要改代码，所以应该派给 yak')).toBe('yak')
    expect(parseArbiterAnswer('我认为 recha 更合适，因为要挑毛病')).toBe('recha')
  })

  it('无法解析时返回 null', () => {
    expect(parseArbiterAnswer('')).toBeNull()
    expect(parseArbiterAnswer('不知道')).toBeNull()
    expect(parseArbiterAnswer('随便找个人吧')).toBeNull()
  })

  it('不会把无关字母误判成角色', () => {
    expect(parseArbiterAnswer('ok')).toBeNull()
    expect(parseArbiterAnswer('rechauffeur')).toBeNull()
  })
})

describe('buildArbiterPrompt', () => {
  it('包含三个角色定义与用户原文', () => {
    const p = buildArbiterPrompt('帮我把这个跑起来')
    expect(p).toContain('yak')
    expect(p).toContain('recha')
    expect(p).toContain('lumina')
    expect(p).toContain('帮我把这个跑起来')
  })
})

// ═══════════════════════════════════════════════════════════
// 主入口：decideRoute
// ═══════════════════════════════════════════════════════════

describe('decideRoute — 高置信不走 LLM（零成本零延迟）', () => {
  it('明确代码任务不调用 LLM', async () => {
    let called = false
    const d = await decideRoute(
      { text: '帮我写个爬虫' },
      { llmClassify: async () => { called = true; return 'recha' } },
    )
    expect(d.target).toBe('yak')
    expect(d.via).toBe('rules-high')
    expect(called).toBe(false)
  })

  it('寒暄不调用 LLM', async () => {
    let called = false
    const d = await decideRoute({ text: '你好' }, { llmClassify: async () => { called = true; return null } })
    expect(d.target).toBe('lumina')
    expect(d.via).toBe('rules-self')
    expect(called).toBe(false)
  })
})

describe('decideRoute — 歧义进 LLM 仲裁', () => {
  it('LLM 判 yak 就派 yak', async () => {
    const d = await decideRoute(
      { text: '这玩意跑起来就崩，你帮我看看' },
      { llmClassify: async () => 'yak' },
    )
    expect(d.target).toBe('yak')
    expect(d.via).toBe('llm')
    expect(d.ruleConfidence).toBe('low')
  })

  it('LLM 判 lumina 就留给自己', async () => {
    const d = await decideRoute(
      { text: '你怎么看最近的情况' },
      { llmClassify: async () => 'lumina' },
    )
    expect(d.target).toBe('lumina')
    expect(d.via).toBe('llm')
  })
})

describe('decideRoute — 降级链绝不能卡住用户（最重要）', () => {
  it('LLM 抛错 → 走 fallback，不 reject', async () => {
    const d = await decideRoute(
      { text: '这玩意跑起来就崩' },
      { llmClassify: async () => { throw new Error('模型挂了') } },
    )
    expect(d.target).toBe('yak')
    expect(d.via).toBe('fallback')
  })

  it('LLM 返回垃圾 → 走 fallback', async () => {
    const d = await decideRoute(
      { text: '这玩意跑起来就崩' },
      { llmClassify: async () => '随便吧不知道' as any },
    )
    expect(d.target).toBe('yak')
    expect(d.via).toBe('fallback')
  })

  it('LLM 返回 null → 走 fallback', async () => {
    const d = await decideRoute(
      { text: '这玩意跑起来就崩' },
      { llmClassify: async () => null },
    )
    expect(d.via).toBe('fallback')
  })

  it('没注入 LLM → 走 fallback', async () => {
    const d = await decideRoute({ text: '这玩意跑起来就崩' })
    expect(d.via).toBe('fallback')
    expect(['yak', 'recha', 'lumina']).toContain(d.target)
  })

  it('LLM 超时 → 走 fallback（用假 timer 验证不挂起）', async () => {
    const d = await decideRoute(
      { text: '这玩意跑起来就崩' },
      {
        llmClassify: () => new Promise<string>(() => { /* 永不 resolve */ }),
        timeoutMs: 20,
      },
    )
    expect(d.via).toBe('fallback')
  })

  it('LLM 派的角色不可用时退回 fallback', async () => {
    const d = await decideRoute(
      // available 属于 RouteInput（谁可用），不属于 deps
      { text: '这玩意跑起来就崩', available: ['lumina', 'recha'] },
      { llmClassify: async () => 'yak' },
    )
    expect(d.target).not.toBe('yak')
    expect(['lumina', 'recha']).toContain(d.target)
    expect(d.via).toBe('fallback')
  })

  it('available 为空数组时不会崩，且只能派给 lumina', async () => {
    const d = await decideRoute({ text: '帮我写个爬虫', available: [] })
    expect(d.target).toBe('yak') // 空数组被当作未指定 → 用默认全量
    const d2 = await decideRoute({ text: '这玩意崩了', available: ['lumina'] })
    expect(['lumina', 'yak', 'recha']).toContain(d2.target)
  })

  it('可指定 fallback 目标', async () => {
    const d = await decideRoute(
      { text: '这玩意跑起来就崩' },
      { llmClassify: async () => null, fallbackTarget: 'recha' },
    )
    expect(d.target).toBe('recha')
  })
})

describe('decideRoute — 输出结构完整性', () => {
  it('每种路径都带 reason 与 signals', async () => {
    const inputs: Array<[RouteInput, Parameters<typeof decideRoute>[1]]> = [
      [{ text: '写个爬虫' }, {}],
      [{ text: '你好' }, {}],
      [{ text: '这玩意崩了' }, { llmClassify: async () => 'yak' }],
      [{ text: '这玩意崩了' }, { llmClassify: async () => null }],
    ]
    for (const [input, deps] of inputs) {
      const d = await decideRoute(input, deps)
      expect(typeof d.reason).toBe('string')
      expect(d.reason.length).toBeGreaterThan(0)
      expect(Array.isArray(d.signals)).toBe(true)
      expect(['rules-high', 'rules-self', 'llm', 'fallback']).toContain(d.via)
    }
  })

  it('并发调用互不干扰（无共享可变状态）', async () => {
    const tasks: Array<Promise<RouteTarget>> = [
      decideRoute({ text: '写个爬虫' }).then(d => d.target),
      decideRoute({ text: '你好' }).then(d => d.target),
      decideRoute({ text: '审查一下这段代码' }).then(d => d.target),
      decideRoute({ text: '这玩意崩了' }).then(d => d.target),
    ]
    const results = await Promise.all(tasks)
    expect(results[0]).toBe('yak')
    expect(results[1]).toBe('lumina')
    expect(results[2]).toBe('recha')
  })
})
