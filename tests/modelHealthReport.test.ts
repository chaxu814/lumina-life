// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// modelHealthReport.test.ts — 模型体检报告的行为测试
//
// 【重点验证的三个场景】
// 1. 用户填的窗口远大于服务端实际值 → 必须给出「已按服务端为准」的提示
//    （这是深度评测命中的最高频问题，也是 P0-3 修复的对外表达）
// 2. 工具能力降级 → 必须说清「功能不丢，但准确率降」
// 3. 本地端点 → 必须提示并发限制并指向正确的排查方向
//
// 注意：这些用例不 mock 服务端，而是直接构造输入，
// 验证的是【报告逻辑】而不是探测逻辑（探测由 modelServerFacts 负责）。
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest'
import { __clearServerFactsCache, rememberServerFacts } from '../electron/core/modelServerFacts'
import { buildModelHealthReport, formatHealthReportText, levelLabel } from '../electron/core/modelHealthReport'
import { getModelCapabilityCache } from '../electron/modelCapabilityCache'

describe('模型体检报告', () => {
  beforeEach(() => {
    __clearServerFactsCache()
    getModelCapabilityCache().clear()
  })

  // ══ 场景 1：用户填的窗口远大于服务端实际值 ══
  it('P0-3 场景：用户填 256000、服务端实际 32768 → 明确告知已按服务端为准', () => {
    rememberServerFacts('qwen2.5-7b-instruct', {
      contextWindow: 32_768,
      supportsVision: false,
      supportsTools: true,
      families: ['qwen2'],
      paramSizeText: '7B',
    })

    const r = buildModelHealthReport({
      modelName: 'qwen2.5-7b-instruct',
      baseUrl: 'http://192.168.1.2:1234/v1',
      userContextWindow: 256_000,
    })

    expect(r.capabilities.contextWindow).toBe(32_768)
    expect(r.userConfiguredContext).toBe(256_000)

    const ctx = r.checks.find(c => c.id === 'context')!
    expect(ctx.level).toBe('notice')
    expect(ctx.summary).toContain('32,768')
    expect(ctx.summary).toContain('256,000')
    // 建议必须指向可操作的修复
    expect(ctx.advice).toContain('0')
  })

  it('用户填的值与服务端接近时以用户为准（尊重用户刻意限制）', () => {
    // resolveCapabilities 的仲裁规则：服务端值与用户值相差不超过 2 倍时，
    // 尊重用户的显式配置（用户可能刻意把窗口调小以提速）。
    // 相差超过 2 倍则认为显式值已过期，按服务端真值走。
    rememberServerFacts('qwen2.5-7b-instruct', {
      contextWindow: 32_768, supportsVision: false, supportsTools: true,
      families: ['qwen2'], paramSizeText: '7B',
    })
    const r = buildModelHealthReport({
      modelName: 'qwen2.5-7b-instruct',
      baseUrl: 'http://localhost:1234/v1',
      userContextWindow: 16_384,   // 与 32768 相差 2 倍以内 → 采用用户值
    })
    expect(r.capabilities.contextWindow).toBe(16_384)
    expect(r.checks.find(c => c.id === 'context')!.level).toBe('ok')
  })

  it('用户填的值偏离服务端超过 2 倍 → 判为过期，按服务端真值', () => {
    // 8192 vs 32768 = 4 倍差距 → 服务端胜出（防止用户拿旧配置卡死对话）
    rememberServerFacts('qwen2.5-7b-instruct', {
      contextWindow: 32_768, supportsVision: false, supportsTools: true,
      families: ['qwen2'], paramSizeText: '7B',
    })
    const r = buildModelHealthReport({
      modelName: 'qwen2.5-7b-instruct',
      baseUrl: 'http://localhost:1234/v1',
      userContextWindow: 8_192,
    })
    expect(r.capabilities.contextWindow).toBe(32_768)
  })

  // ══ 场景 2：工具能力 ══
  it('运行时确认不支持工具 → 告知已切 XML 模式且功能不丢', () => {
    const cache = getModelCapabilityCache()
    cache.markNoToolSupport('some-gguf-model')

    const r = buildModelHealthReport({
      modelName: 'some-gguf-model',
      baseUrl: 'http://localhost:1234/v1',
    })

    const t = r.checks.find(c => c.id === 'tools')!
    expect(t.level).toBe('notice')
    expect(t.summary).toContain('XML')
    // 关键：不能让用户以为工具不能用了
    expect(t.advice).toContain('功能不缺失')
  })

  // ══ 场景 3：本地端点 ══
  it('本地端点提示并发限制并指向正确排查方向', () => {
    const r = buildModelHealthReport({
      modelName: 'local-model',
      baseUrl: 'http://192.168.1.2:1234/v1',
    })
    const local = r.checks.find(c => c.id === 'local')!
    expect(local).toBeDefined()
    expect(local.summary).toContain('并发')
    // 排查方向必须指向上下文窗口，而不是泛泛而谈
    expect(local.advice).toContain('上下文窗口')
    expect(r.isLocal).toBe(true)
  })

  it('云端点不报并发限制', () => {
    const r = buildModelHealthReport({
      modelName: 'gpt-4o',
      baseUrl: 'https://api.openai.com/v1',
    })
    expect(r.isLocal).toBe(false)
    expect(r.checks.find(c => c.id === 'local')).toBeUndefined()
  })

  // ══ 结构与排序 ══
  it('体检项按严重程度排序（严重的在前）', () => {
    const r = buildModelHealthReport({
      modelName: 'qwen2.5-7b-instruct',
      baseUrl: 'http://localhost:1234/v1',
      userContextWindow: 256_000,
    })
    const order = { blocker: 0, warn: 1, notice: 2, ok: 3 }
    for (let i = 1; i < r.checks.length; i++) {
      expect(order[r.checks[i - 1].level]).toBeLessThanOrEqual(order[r.checks[i].level])
    }
  })

  it('每条非 ok 项都带 advice（否则用户看到问题却不知道怎么改）', () => {
    const r = buildModelHealthReport({
      modelName: 'qwen2.5-7b-instruct',
      baseUrl: 'http://192.168.1.2:1234/v1',
      userContextWindow: 256_000,
    })
    for (const c of r.checks) {
      if (c.level !== 'ok') {
        expect(c.advice, `「${c.label}」缺少建议`).toBeTruthy()
        expect(c.advice!.length).toBeGreaterThan(10)
      }
    }
  })

  it('每条体检项都标注来源（让用户判断可信度）', () => {
    const r = buildModelHealthReport({
      modelName: 'qwen2.5-7b-instruct',
      baseUrl: 'http://localhost:1234/v1',
    })
    for (const c of r.checks) {
      expect(c.source, `「${c.label}」缺少来源标注`).toBeTruthy()
    }
  })

  it('headline 与实际检查结果一致', () => {
    const r = buildModelHealthReport({
      modelName: 'qwen2.5-7b-instruct',
      baseUrl: 'http://192.168.1.2:1234/v1',
    })
    expect(r.headline).toContain(r.modelName)
    // 综合等级必须等于所有项里最严重的那一项
    const order = { blocker: 0, warn: 1, notice: 2, ok: 3 }
    const worst = r.checks.reduce((w, c) =>
      order[c.level] < order[w] ? c.level : w, 'ok' as const)
    expect(r.level).toBe(worst)
  })

  // ══ 文本输出（CLI / 复制用）══
  it('formatHealthReportText 包含模型名、端点与全部检查项', () => {
    const r = buildModelHealthReport({
      modelName: 'qwen2.5-7b-instruct',
      baseUrl: 'http://192.168.1.2:1234/v1',
      userContextWindow: 256_000,
    })
    const text = formatHealthReportText(r)
    expect(text).toContain('qwen2.5-7b-instruct')
    expect(text).toContain('192.168.1.2')
    for (const c of r.checks) {
      expect(text).toContain(c.label)
    }
  })

  it('levelLabel 覆盖全部四个等级', () => {
    expect(levelLabel('ok')).toBe('正常')
    expect(levelLabel('notice')).toBe('提示')
    expect(levelLabel('warn')).toBe('注意')
    expect(levelLabel('blocker')).toBe('阻断')
  })
})
