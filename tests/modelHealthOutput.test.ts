// ============================================================
// 一次真实场景的输出快照测试
//
// 【这份测试的价值】
// 单元测试验证的是「某个函数在给定输入下返回什么」；
// 这份测试验证的是「用户在终端里实际看到的那段字」。
//
// 理由：体检报告的全部价值在于【可读】。如果排版混乱、术语看不懂、
// 建议没有指向具体动作，那功能再对也没有用。
// 所以用真实配置（用户截图里的 LM Studio + 9B 模型 + 256K 窗口）
// 生成一遍完整输出，把关键内容断言下来。
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest'
import { buildModelHealthReport, formatHealthReportText } from '../electron/core/modelHealthReport'
import { __clearServerFactsCache, rememberServerFacts } from '../electron/core/modelServerFacts'
import { getModelCapabilityCache } from '../electron/modelCapabilityCache'

describe('体检报告真实场景输出', () => {
  beforeEach(() => {
    __clearServerFactsCache()
    getModelCapabilityCache().clear()
  })

  it('用户实际遇到的场景：9B 本地模型 + 窗口填了 256K', () => {
    // 复现用户截图里的配置：LM Studio 在局域网，9B Q8 量化模型
    rememberServerFacts('NeoHorse 1 9B Q8', {
      contextWindow: 32_768,
      supportsVision: false,
      supportsTools: false,
      families: ['qwen2'],
      paramSizeText: '9B',
    })

    const report = buildModelHealthReport({
      modelName: 'NeoHorse 1 9B Q8',
      baseUrl: 'http://192.168.1.2:1234/v1',
      userContextWindow: 256_000,
    })
    const text = formatHealthReportText(report)

    // ① 必须点名「你填的值 vs 实际值」这个差距
    expect(text).toContain('256,000')
    expect(text).toContain('32,768')

    // ② 必须给出可以直接照做的建议
    expect(text).toContain('自动检测')

    // ③ 必须解释工具降级不影响功能（否则用户会以为工具坏了）
    expect(text).toContain('XML')

    // ④ 必须提示本地并发限制，并把它和「卡顿」关联起来
    expect(text).toContain('并发')

    // ⑤ 每一条都带依据来源
    expect(text).toContain('服务端报告')

    // ⑥ 排版不能崩：不能出现 undefined / NaN
    expect(text).not.toMatch(/undefined|NaN|\[object/)
  })

  it('服务端未探测时如实说明「结论来自推测」', () => {
    const report = buildModelHealthReport({
      modelName: 'unknown-local-model',
      baseUrl: 'http://localhost:1234/v1',
    })
    const text = formatHealthReportText(report)
    // 不能假装权威
    expect(text).toMatch(/推测|保守|按模型名/)
    expect(text).not.toMatch(/undefined|NaN/)
  })

  it('工具能力正常时不要制造焦虑（不给无意义的 notice）', () => {
    rememberServerFacts('qwen3-8b-instruct', {
      contextWindow: 32_768,
      supportsVision: false,
      supportsTools: true,
      families: ['qwen3'],
      paramSizeText: '8B',
    })
    const report = buildModelHealthReport({
      modelName: 'qwen3-8b-instruct',
      baseUrl: 'http://localhost:1234/v1',
      userContextWindow: 32_768,
    })
    const tools = report.checks.find(c => c.id === 'tools')!
    expect(tools.level).toBe('ok')
    expect(tools.summary).toContain('支持原生函数调用')
  })
})
