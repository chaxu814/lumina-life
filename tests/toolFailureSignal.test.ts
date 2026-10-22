// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/toolFailureSignal.test.ts
//
// 「没做成」必须显式失败 —— executeToolWithRetry 三条失败路径的守卫。
//
// 背景：以前「工具不存在 / 被安全守卫拦截 / 需要用户批准」都返回
// ok:true，agentRunner 又把 ok:true 的 content 原样回灌给模型：
//
//   content: result.ok ? result.content : `工具错误: ${result.error || '未知错误'}`
//
// 于是「被拦截」这件事以**普通成功结果**的形状进了模型上下文，
// 模型分不清「工具真的跑了」和「这事根本没发生」，于是顺着
// 「⛔ 被拦截」这段文本继续编结论 —— 幻觉就是这么来的。
//
// 为什么 ok:false 不会打断 ReAct 循环：
//   agentRunner.runReActLoop 的单工具分支拿到 result 后，无条件
//   push 一条 { role:'tool', tool_call_id } 消息（无论 ok 真假），
//   然后走完本轮逻辑落到循环末尾的 continue —— 代码里没有任何
//   `if (!result.ok) break`。所以改 ok:false 只会改变**回灌给模型的
//   文本形状**，不会让循环断链。这里用源码断言把这条前提钉死，
//   防止以后有人重构 agentRunner 时不小心加了 ok 相关的 break。
// ============================================================

import { describe, it, expect, beforeAll, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// getSecurityGuard 走模块级 import，需要先替换成可控桩
const guardState = { allowed: true, requiresApproval: false, findings: [] as any[] }

vi.mock('../electron/securityGuard', () => ({
  getSecurityGuard: () => ({
    checkToolCall: () => ({
      allowed: guardState.allowed,
      severity: guardState.allowed ? 'SAFE' : 'CRITICAL',
      findings: guardState.findings,
      requiresApproval: guardState.requiresApproval,
      summary: '测试桩',
    }),
  }),
  GuardSeverity: { SAFE: 'SAFE', INFO: 'INFO', LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH', CRITICAL: 'CRITICAL' },
}))

const registryPath = join(__dirname, '..', 'electron', 'tools', 'registry.ts')
// ⚠️ 2026-10-11：toolResultText / notExecutedNote 已抽到 agentRunner.text.ts。
//    合并两文件读取，断言不因文件拆分而失效。
const runnerSrc = readFileSync(join(__dirname, '..', 'electron', 'agentRunner.ts'), 'utf-8')
  + '\n'
  + readFileSync(join(__dirname, '..', 'electron', 'agentRunner.text.ts'), 'utf-8')

// 动态 import，确保 vi.mock 生效
let registry: typeof import('../electron/tools/registry')
beforeAll(async () => {
  registry = await import('../electron/tools/registry')
})

/** 三条失败路径共同的关键字：模型必须一眼看出「这次没执行」 */
const NOT_EXECUTED_KEYWORD = '未执行成功'
const NO_FABRICATION_KEYWORD = '禁止据此作答'

function expectFailureSignal(content: string, error: string | undefined) {
  expect(content).toContain(NOT_EXECUTED_KEYWORD)
  expect(content).toContain(NO_FABRICATION_KEYWORD)
  expect(error).toBeTruthy()
  expect(error).toContain(NOT_EXECUTED_KEYWORD)
  expect(error).toContain(NO_FABRICATION_KEYWORD)
}

describe('executeToolWithRetry：失败必须显式失败', () => {
  it('工具不存在 → ok:false，error 说明是「不存在」', async () => {
    const res = await registry.executeToolWithRetry('__不存在的工具__', {})

    expect(res.ok).toBe(false)
    expect(res.error).toContain('不存在')
    expect(res.content).toContain('__不存在的工具__')
    expectFailureSignal(res.content, res.error)
    // 保留原有字段结构
    expect(res.callId).toBe('')
    expect(res.durationMs).toBe(0)
  })

  it('被安全守卫拦截 → ok:false，error 说明是「被安全策略拦截」', async () => {
    registry.registerTool(
      { name: 'test_dangerous_tool', description: '测试用危险工具', toolsets: ['agent'], dangerous: true },
      async () => ({ callId: '', ok: true, content: '绝不该被调用' }),
    )
    guardState.allowed = false
    guardState.requiresApproval = false
    guardState.findings = [
      { severity: 'CRITICAL', title: '疑似凭据外泄', description: '参数里含密钥' },
    ]

    const res = await registry.executeToolWithRetry('test_dangerous_tool', { cmd: 'cat .env' })

    expect(res.ok).toBe(false)
    expect(res.error).toContain('被安全策略拦截')
    expect(res.content).toContain('疑似凭据外泄')
    expect(res.content).not.toContain('绝不该被调用')  // 工具实现没跑
    expectFailureSignal(res.content, res.error)
    expect(res.durationMs).toBe(0)
  })

  it('需要用户批准 → ok:false，error 说明是「需要用户批准」', async () => {
    guardState.allowed = true
    guardState.requiresApproval = true
    guardState.findings = [{ severity: 'HIGH', title: '删除文件' }]

    const res = await registry.executeToolWithRetry('test_dangerous_tool', { path: 'C:/important.txt' })

    expect(res.ok).toBe(false)
    expect(res.error).toContain('需要用户批准')
    expectFailureSignal(res.content, res.error)
    expect(res.durationMs).toBe(0)
  })

  it('对照：真正执行成功的工具仍返回 ok:true（别把正常路径也改了）', async () => {
    registry.registerTool(
      { name: 'test_ok_tool', description: '测试用普通工具', toolsets: ['agent'] },
      async () => ({ callId: '', ok: true, content: '真实结果', durationMs: 1 }),
    )

    const res = await registry.executeToolWithRetry('test_ok_tool', {})

    expect(res.ok).toBe(true)
    expect(res.content).toBe('真实结果')
    expect(res.error).toBeUndefined()
  })
})

describe('前提守卫：ok:false 不得打断 ReAct 循环', () => {
  it('agentRunner 对 tool 结果无条件 push 一条 tool 消息', () => {
    // 单工具与并行两条分支都必须「先 push，再按 ok 选文本」，
    // 不能出现 ok 为假就跳过 push 的写法。
    // v15 起两条分支统一走 toolResultText()，失败文案由它内部拼（带"未执行成功/禁止据此作答"）。
    expect(runnerSrc).toContain('function toolResultText(')
    expect(runnerSrc).toContain('content: toolResultText(result),')
    expect(runnerSrc).toContain('content: toolResultText(item.result),')
    // toolResultText 必须是"永远返回内容"，不存在 ok 为假就返回空的可能
    const fn = runnerSrc.slice(
      runnerSrc.indexOf('function toolResultText('),
      runnerSrc.indexOf('function toolResultText(') + 400,
    )
    expect(fn).toContain('result.ok')
    expect(fn).toContain('notExecutedNote(')
  })

  it('agentRunner 没有任何「工具失败就 break 循环」的分支', () => {
    const breakers = runnerSrc
      .split('\n')
      .map((line, i) => ({ line: line.trim(), no: i + 1 }))
      .filter(({ line }) => /if\s*\(\s*!\s*(result|item\.result|res)\.ok\s*\)/.test(line))

    expect(breakers.map(b => `L${b.no}: ${b.line}`)).toEqual([])
  })
})
