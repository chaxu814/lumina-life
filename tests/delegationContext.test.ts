// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// tests/delegationContext.test.ts — 委托上下文传递 + 验证闭环 单元测试
//
// 覆盖问题 D：
//   1. Worker system prompt 必须包含任务目标/对话历史/可用工具/项目根目录/执行铁则
//   2. Worker 首轮消息必须包含完整任务（不再截断到 50 字）
//   3. 验证闭环：首次失败 → 回传错误给 Worker 修 → 重试 → 通过；最多 N 轮后停止上报
import { describe, it, expect, vi } from 'vitest'

// ── 纯函数 prompt 构建（零依赖，直接测） ──
import {
  buildWorkerSystemPrompt,
  buildWorkerFirstMessage,
  renderConversationHistory,
  type WorkerPromptContext,
} from '../electron/orchestration/delegationPrompt'

function makeCtx(over: Partial<WorkerPromptContext> = {}): WorkerPromptContext {
  return {
    to: 'yak',
    from: 'lumina',
    taskType: 'code_write',
    task: '修复 src/foo.ts 里 readFile 未 await 的 bug',
    ...over,
  }
}

describe('buildWorkerSystemPrompt — 委托上下文完整性（问题 D）', () => {
  it('包含任务目标', () => {
    const p = buildWorkerSystemPrompt(makeCtx({ taskGoal: '让用户输入框回车不卡死' }))
    expect(p).toContain('让用户输入框回车不卡死')
  })

  it('包含完整对话历史（用户说过什么 / Lumina 回过什么）', () => {
    const p = buildWorkerSystemPrompt(makeCtx({
      conversationHistory: [
        { role: 'user', content: '输入框回车就卡死，帮我看看' },
        { role: 'assistant', content: '我查了下，怀疑是 readFile 没 await' },
      ],
    }))
    expect(p).toContain('输入框回车就卡死')
    expect(p).toContain('我查了下，怀疑是 readFile 没 await')
  })

  it('列出可用工具', () => {
    const p = buildWorkerSystemPrompt(makeCtx({ availableTools: ['file_read', 'file_edit', 'shell_exec'] }))
    expect(p).toContain('file_read')
    expect(p).toContain('file_edit')
    expect(p).toContain('shell_exec')
  })

  it('注入项目根目录与相关文件', () => {
    const p = buildWorkerSystemPrompt(makeCtx({
      projectContext: { cwd: '/repo/lumina', relevantFiles: ['src/foo.ts'] },
    }))
    expect(p).toContain('/repo/lumina')
    expect(p).toContain('src/foo.ts')
  })

  it('包含执行铁则：读→改→验证，最多 3 轮', () => {
    const p = buildWorkerSystemPrompt(makeCtx())
    expect(p).toContain('file_read')
    expect(p).toContain('file_edit')
    expect(p).toContain('shell_exec')
    expect(p).toContain('3 轮')
  })

  it('空历史时不报错，明确告知无额外历史', () => {
    const p = buildWorkerSystemPrompt(makeCtx())
    expect(p).toContain('对话上下文')
    expect(() => buildWorkerSystemPrompt(makeCtx({ conversationHistory: [] }))).not.toThrow()
  })
})

describe('buildWorkerFirstMessage — 完整任务不再截断', () => {
  it('包含完整任务正文（>50 字也不截断）', () => {
    const longTask = '把 ' + 'aaaa '.repeat(60) + ' 全部改成同步读取并加错误处理'
    const msg = buildWorkerFirstMessage(makeCtx({ task: longTask }))
    expect(msg.length).toBeGreaterThan(longTask.length - 10)
    // 不能再是只带前 50 字标题
    expect(msg).toContain('全部改成同步读取')
  })

  it('taskGoal 与 task 不同时复述任务目标', () => {
    const msg = buildWorkerFirstMessage(makeCtx({
      task: '修 foo.ts 的 bug',
      taskGoal: '用户输入框回车卡死',
    }))
    expect(msg).toContain('用户输入框回车卡死')
    expect(msg).toContain('修 foo.ts 的 bug')
  })
})

describe('renderConversationHistory', () => {
  it('无历史返回空串', () => {
    expect(renderConversationHistory(undefined)).toBe('')
    expect(renderConversationHistory([])).toBe('')
  })
  it('超长消息截断', () => {
    const out = renderConversationHistory([{ role: 'user', content: 'x'.repeat(5000) }])
    expect(out.length).toBeLessThan(2000)
  })
})

// ── 验证闭环：autoFixLoop（注入 runVerify，避免真实执行命令） ──
import { autoFixLoop, type VerifyConfig, type VerifyResult } from '../electron/orchestration/verifyLoop'

const baseCfg: VerifyConfig = {
  commands: ['npx tsc --noEmit'],
  maxFixRounds: 3,
  timeoutMs: 5000,
  cwd: '/repo/lumina',
}

function ok(): VerifyResult { return { passed: true, output: 'ok', errors: [], elapsedMs: 10 } }
function bad(errors: string[]): VerifyResult { return { passed: false, output: '', errors, elapsedMs: 10 } }

describe('autoFixLoop — 执行-自检-验证闭环', () => {
  it('首次验证通过 → 不触发修复委托', async () => {
    const runVerify = vi.fn(async () => ok())
    const delegateFn = vi.fn(async () => ({ success: true, content: '' }))
    const r = await autoFixLoop(baseCfg, '原始任务', delegateFn, { runVerify })
    expect(r.success).toBe(true)
    expect(delegateFn).not.toHaveBeenCalled()
  })

  it('首次失败 → 回传错误给 Worker → 第 2 轮通过', async () => {
    const seq = [bad(['foo.ts(1,7): error TS2304']), ok()]
    const runVerify = vi.fn(async () => seq.shift() ?? ok())
    const delegateFn = vi.fn(async () => ({ success: true, content: '已修复' }))
    const r = await autoFixLoop(baseCfg, '原始任务', delegateFn, { runVerify })
    expect(delegateFn).toHaveBeenCalledTimes(1)
    // 修复任务里必须带回原始报错
    expect(delegateFn.mock.calls[0][0]).toContain('foo.ts(1,7)')
    expect(r.success).toBe(true)
  })

  it('连续失败达到上限 → 停止并上报错误（不无限重试）', async () => {
    const runVerify = vi.fn(async () => bad(['永久错误']))
    const delegateFn = vi.fn(async () => ({ success: true, content: '尝试修复' }))
    const r = await autoFixLoop({ ...baseCfg, maxFixRounds: 2 }, '原始任务', delegateFn, { runVerify })
    expect(delegateFn).toHaveBeenCalledTimes(2) // 最多 2 轮
    expect(r.success).toBe(false)
    expect(r.error).toContain('永久错误')
  })
})
