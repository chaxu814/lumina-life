// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// tests/delegateFallback.test.ts — P5: delegate_to 优雅降级验证
//
// 【修复背景】
// 旧版 delegate_to 在目标 worker（yak/recha）未配置 LLM 时直接报错
// "未配置 LLM，暂时不可用"，导致整个委托链路不可用（P5）。
//
// 修复后：目标未配置时降级为「Lumina 以该 worker 角色直接执行」；
// 仅当 Lumina 自身也未配置 LLM 时，才给出明确配置提示（不崩溃）。
//
// 本测试钉死两端行为：
//   1) 两者都未配置 → 明确配置提示（ok:false，不抛异常）
//   2) 目标未配置、Lumina 已配置 → 由 Lumina 影子 worker 代执行（ok:true）
//   3) 参数校验（to / taskType 非法）仍直接报错
import { describe, it, expect, vi, beforeEach } from 'vitest'

// 用可变开关控制 DelegationManager 的"配置状态"，避免重复 mock
let luminaConfigured = false

vi.mock('../electron/delegationManager', () => ({
  getDelegationManager: () => ({
    isConfigured: (id: string) => id === 'lumina' && luminaConfigured,
    getRunner: (id: string) =>
      id === 'lumina' && luminaConfigured
        ? { config: { baseUrl: 'http://127.0.0.1:1234/v1', model: 'test-model', personaId: 'lumina' } }
        : undefined,
  }),
}))

// 影子 worker 路径会 require('../../agentRunner')，这里把它替成假实现
vi.mock('../electron/agentRunner', () => ({
  AgentRunner: {
    createWorker: vi.fn(async (_cfg: any, task: string) => `影子产出：${task}`),
  },
}))

import { delegateTo } from '../electron/tools/impl/team'
import { AgentRunner } from '../electron/agentRunner'

describe('delegate_to 优雅降级（P5）', () => {
  beforeEach(() => {
    luminaConfigured = false
    vi.mocked(AgentRunner.createWorker).mockClear()
  })

  it('目标 worker 与 Lumina 都未配置 LLM → 明确配置提示，不崩溃', async () => {
    const res = await delegateTo({ to: 'yak', task: '帮我写个排序函数', taskType: 'code_write' })
    expect(res.ok).toBe(false)
    expect(res.error || res.content).toMatch(/未配置|配置 LLM/i)
    // 不应走到影子 worker
    expect(AgentRunner.createWorker).not.toHaveBeenCalled()
  })

  it('P5 核心：目标未配置、Lumina 已配置 → 由 Lumina 影子 worker 代执行', async () => {
    luminaConfigured = true
    const res = await delegateTo({ to: 'recha', task: '核查这组数据的异常值', taskType: 'risk_assess' })
    expect(res.ok).toBe(true)
    expect(res.content).toContain('影子产出')
    expect(res.content).toMatch(/降级|代执行|热茶/)
    expect(AgentRunner.createWorker).toHaveBeenCalledTimes(1)
    // 影子 worker 拿到的是 recha 角色的系统提示 + 原始任务
    const [cfg, task] = vi.mocked(AgentRunner.createWorker).mock.calls[0]
    expect(task).toBe('核查这组数据的异常值')
    expect(String(cfg.systemPrompt)).toContain('热茶')
  })

  it('to 非法 → 直接报错', async () => {
    const res = await delegateTo({ to: 'bob', task: 'x', taskType: 'code_write' })
    expect(res.ok).toBe(false)
  })

  it('taskType 非法 → 直接报错', async () => {
    const res = await delegateTo({ to: 'yak', task: 'x', taskType: 'nope' })
    expect(res.ok).toBe(false)
    expect(AgentRunner.createWorker).not.toHaveBeenCalled()
  })
})
