// tests/toolNoise.module.test.ts — 直接测试从 agentRunner 抽取的真实 toolNoise 模块
import { describe, it, expect } from 'vitest'
import { cleanToolNoiseText, TOOL_NOISE_PATTERNS } from '../electron/agent/toolNoise'

describe('toolNoise 模块（抽取自 agentRunner，行为不变）', () => {
  it('导出正则表', () => {
    expect(TOOL_NOISE_PATTERNS.length).toBeGreaterThan(0)
  })

  it('剔除"我将使用 web_search 搜索"这类工具描述，保留正文', () => {
    const out = cleanToolNoiseText('我将使用 web_search 搜索最新的 AI 新闻。结论是行业在快速增长。')
    expect(out).not.toContain('web_search')
    expect(out).toContain('结论是行业在快速增长')
  })

  it('剔除 <tool_call> XML', () => {
    const out = cleanToolNoiseText('<tool_call><function=web_search></tool_call>这是给用户看的正文')
    expect(out).not.toContain('<tool_call>')
    expect(out).toContain('这是给用户看的正文')
  })

  it('原文全是 tool_call XML 时返回空串，避免 raw XML 泄漏', () => {
    const out = cleanToolNoiseText('  <tool_call>whatever</tool_call>  ')
    expect(out).toBe('')
  })

  it('过度清理导致为空时安全兜底保留原文', () => {
    const out = cleanToolNoiseText('这是一句完全正常、不含任何工具描述的回复。')
    expect(out).toContain('完全正常')
  })
})
