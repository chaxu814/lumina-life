// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// tests/reactEngine.test.ts — 核心 ReAct 循环引擎测试
// 之前 agentRunner（154KB）只配了一个 4.1KB 的"形状测试"，核心 ReAct 循环零覆盖。
// 这里对抽出的 ReActEngine 做真正的行为测试：终态回复、工具调用→续跑、错误、
// 中止、轮数上限、XML 工具调用。
import { describe, it, expect, beforeEach, vi } from 'vitest'

// ── 隔离重依赖：工具注册表 / 安全 / 审批 / hook / 诊断 ──
vi.mock('../electron/tools/registry', () => ({
  executeToolWithRetry: vi.fn(),
  executeToolsParallel: vi.fn(),
  groupParallelBatches: vi.fn((calls: unknown[]) => [calls]),
}))
vi.mock('../electron/securityGuard', () => ({
  GuardSeverity: { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 },
  getSecurityGuard: () => ({
    checkToolCall: () => ({ allowed: true, requiresApproval: false, severity: 0, findings: [], summary: '' }),
  }),
}))
vi.mock('../electron/approvalService', () => ({
  getApprovalService: () => ({ requestApproval: () => null }),
}))
vi.mock('../electron/hooks/hookManager', () => ({
  getHookManager: () => ({
    runBeforeToolCall: () => Promise.resolve(),
    runAfterToolCall: () => Promise.resolve(),
  }),
}))
vi.mock('../electron/ipc/diagnosticsIpc', () => ({
  getDiagnosticsStore: () => ({ addToolCall: () => {} }),
}))
vi.mock('../electron/injectionGuard', () => ({
  getInjectionGuard: () => ({ inspect: () => ({ safe: true }) }),
}))

import { ReActEngine, type LLMResponse, type LLMCaller } from '../electron/core/reactEngine'
import { executeToolWithRetry, executeToolsParallel } from '../electron/tools/registry'

function makeConfig(overrides: any = {}) {
  return {
    maxToolCalls: 5,
    sessionId: 'test-session',
    personaId: 'lumina',
    skipApproval: true,
    ...overrides,
  }
}

describe('ReActEngine 核心循环', () => {
  beforeEach(() => {
    vi.mocked(executeToolWithRetry).mockReset()
    vi.mocked(executeToolWithRetry).mockResolvedValue({
      callId: 'c', ok: true, content: '工具结果：海边晴天', error: '', durationMs: 1,
    } as any)
  })

  it('纯文本回复一轮即终态，不调用工具', async () => {
    const callLLM: LLMCaller = vi.fn(async () => ({ text: '你好，我是 Lumina。' }))
    const engine = new ReActEngine(makeConfig(), callLLM)
    const messages = [{ role: 'user', content: '你好' }]
    const res = await engine.run(messages, [], { value: 0 })
    expect(res.text).toContain('你好')
    expect(callLLM).toHaveBeenCalledTimes(1)
    expect(executeToolWithRetry).not.toHaveBeenCalled()
  })

  it('工具调用后自动续跑，拿到结果再给出最终答案', async () => {
    const callLLM: LLMCaller = vi.fn()
      // 第 1 轮：请求工具
      .mockResolvedValueOnce({
        text: '',
        toolCalls: [{ id: 't1', type: 'function', function: { name: 'web_search', arguments: '{"query":"海边天气"}' } }],
      } as LLMResponse)
      // 第 2 轮及之后：基于结果终答（引擎工具后会自动续跑几次，默认重复终答）
      .mockResolvedValueOnce({ text: '海边今天晴天，适合出门。' } as LLMResponse)
      .mockResolvedValue({ text: '海边今天晴天，适合出门。' } as LLMResponse)
    const onToolStart = vi.fn()
    const engine = new ReActEngine(makeConfig(), callLLM, { onToolStart })
    const messages = [{ role: 'user', content: '海边天气怎么样' }]
    const res = await engine.run(messages, [], { value: 0 })
    expect(executeToolWithRetry).toHaveBeenCalledWith('web_search', { query: '海边天气' })
    expect(onToolStart).toHaveBeenCalledWith('web_search', expect.any(Object))
    expect(res.text).toContain('晴天')
    // 工具结果被写回上下文
    expect(messages.some(m => m.role === 'tool' && m.content.includes('海边晴天'))).toBe(true)
  })

  it('LLM 返回非超时错误时给出友好提示且停止', async () => {
    const callLLM: LLMCaller = vi.fn(async () => ({ text: '', error: 'API Key 无效 (401)' }))
    const engine = new ReActEngine(makeConfig(), callLLM)
    const res = await engine.run([{ role: 'user', content: 'hi' }], [], { value: 0 })
    expect(res.text).toContain('抱歉')
    expect(executeToolWithRetry).not.toHaveBeenCalled()
  })

  it('被中止时立即退出，不产生最终答案', async () => {
    const callLLM: LLMCaller = vi.fn(async () => ({ text: '不该出现' }))
    const ac = new AbortController()
    ac.abort()
    const engine = new ReActEngine(makeConfig(), callLLM)
    engine.setAbortController(ac)
    const res = await engine.run([{ role: 'user', content: 'hi' }], [], { value: 0 })
    expect(res.text).toBe('')
    expect(callLLM).not.toHaveBeenCalled()
  })

  it('轮数上限能兜住失控的工具循环（不会无限调用）', async () => {
    const callLLM: LLMCaller = vi.fn(async () => ({
      text: '',
      toolCalls: [{ id: 't', type: 'function', function: { name: 'echo', arguments: '{}' } }],
    }))
    const engine = new ReActEngine(makeConfig({ maxToolCalls: 3 }), callLLM)
    await engine.run([{ role: 'user', content: 'loop' }], [], { value: 0 })
    expect(executeToolWithRetry).toHaveBeenCalledTimes(3)
  })

  it('文本中夹带 XML 工具调用时会被解析执行并剥离', async () => {
    const callLLM: LLMCaller = vi.fn()
      .mockResolvedValueOnce({
        text: '<tool_call><web_search>\nquery="海边天气"\nmax_results="5"\n</web_search></tool_call>',
      } as LLMResponse)
      .mockResolvedValueOnce({ text: '查到了，海边 26 度。' } as LLMResponse)
      .mockResolvedValue({ text: '查到了，海边 26 度。' } as LLMResponse)
    const engine = new ReActEngine(makeConfig(), callLLM)
    const messages = [{ role: 'user', content: '海边天气' }]
    const res = await engine.run(messages, [], { value: 0 })
    expect(executeToolWithRetry).toHaveBeenCalledWith('web_search', expect.objectContaining({ query: '海边天气' }))
    expect(res.text).toContain('26 度')
  })

  it('工具失败时把错误写回上下文，仍能继续到终答', async () => {
    vi.mocked(executeToolWithRetry).mockResolvedValueOnce({
      callId: 't1', ok: false, content: '', error: '网络不可用', durationMs: 1,
    } as any)
    const callLLM: LLMCaller = vi.fn()
      .mockResolvedValueOnce({
        text: '',
        toolCalls: [{ id: 't1', type: 'function', function: { name: 'web_search', arguments: '{}' } }],
      } as LLMResponse)
      .mockResolvedValueOnce({ text: '暂时连不上网，没法查。' } as LLMResponse)
      .mockResolvedValue({ text: '暂时连不上网，没法查。' } as LLMResponse)
    const engine = new ReActEngine(makeConfig(), callLLM)
    const messages = [{ role: 'user', content: '查天气' }]
    const res = await engine.run(messages, [], { value: 0 })
    expect(messages.some(m => m.role === 'tool' && m.content.includes('网络不可用'))).toBe(true)
    expect(res.text).toContain('连不上网')
  })

  it('P2: 同一响应内参数一致的重复工具调用只执行一次（同回合去重）', async () => {
    // 并行分支走 executeToolsParallel（被 mock）；给它一个把 call 原样包成结果的实现
    vi.mocked(executeToolsParallel).mockImplementation(async (calls: any[]) =>
      calls.map((c) => ({ call: c, result: { ok: true, content: '并行结果', error: '' } })),
    )
    const callLLM: LLMCaller = vi.fn()
      .mockResolvedValueOnce({
        text: '',
        toolCalls: [
          { id: 'a', type: 'function', function: { name: 'web_search', arguments: '{"query":"海边天气"}' } },
          { id: 'b', type: 'function', function: { name: 'web_search', arguments: '{"query":"海边天气"}' } },
          { id: 'c', type: 'function', function: { name: 'web_fetch', arguments: '{"url":"https://example.com"}' } },
        ],
      } as LLMResponse)
      .mockResolvedValue({ text: '完成。' } as LLMResponse)
    const engine = new ReActEngine(makeConfig(), callLLM)
    const messages = [{ role: 'user', content: '查天气并抓页面' }]
    await engine.run(messages, [], { value: 0 })
    // groupParallelBatches 被 mock 成 [(全部调用)]，故 executeToolsParallel 调用一次
    expect(vi.mocked(executeToolsParallel).mock.calls.length).toBeGreaterThanOrEqual(1)
    const firstBatch = vi.mocked(executeToolsParallel).mock.calls[0][0] as any[]
    // 两个参数完全一致的 web_search 被去重为一个；web_fetch 不同，保留 → 共 2
    expect(firstBatch.length).toBe(2)
    const searchCount = firstBatch.filter((c) => c.function.name === 'web_search').length
    expect(searchCount).toBe(1)
  })
})
