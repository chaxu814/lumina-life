// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
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

  it('原文全是 tool_call XML 时返回说明而非空串（避免回复凭空消失）', () => {
    const out = cleanToolNoiseText('  <tool_call>whatever</tool_call>  ')
    // 🔧 行为变更（真实故障修复）：
    //   旧行为返回 ''，导致 agentRunner 判定为「连续空回复」→
    //   恢复流程也失败 → 用户看到「暂时无法生成有效回复」。
    //   根因详见 tests/emptyReplyRegression.test.ts。
    //
    //   新行为：返回一句诚实说明。
    //   ① 不泄漏 raw XML（这个目标没变）
    //   ② 内容不凭空消失（这是新加的不变量）
    expect(out).not.toBe('')
    expect(out).not.toContain('<tool_call>')
    expect(out).toContain('工具调用')
  })

  it('过度清理导致为空时安全兜底保留原文', () => {
    const out = cleanToolNoiseText('这是一句完全正常、不含任何工具描述的回复。')
    expect(out).toContain('完全正常')
  })
})
