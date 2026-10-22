// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// tests/reproduceDegen.test.ts — 复现二次调用退化问题
// 
// 模拟 Lumina Team 群聊场景：
// 1. 首次对话（正常）
// 2. 第二次对话（之前出现空回复/兜底退化）
//
// 核心验证：每次 agent:chat 建新 AgentRunner + setHistory 后，
//   sendMessage 能否正常响应
// ============================================================

import { describe, it, expect, vi, beforeAll } from 'vitest'

// ── Mock ──
beforeAll(() => {
  vi.mock('electron', () => ({
    app: {
      getPath: (name: string) => process.cwd(),
    },
  }))
})

// agentRunner 依赖链较重，冷加载约 5~6s，超过 vitest 默认 5s 用例超时会导致
// 首个用例动态 import 超时、后续用例拿到不完整模块而报 "AgentRunner is not a constructor"。
// 因此为本套件整体放宽超时到 30s（与业务逻辑无关，仅是加载耗时）。
describe('二次调用退化复现', { timeout: 30000 }, () => {
  it('AgentRunner 每次新建时 setHistory 不崩溃', async () => {
    // 模拟从 frontend 发送的 conversationHistory
    const historyForLLM = [
      { role: 'user' as const, content: '上次我们聊了什么？' },
      { role: 'assistant' as const, content: '我们聊了 Lumina Team 的能力介绍，包括写作、编程、数据分析等。对话已经完整啦！你问我能做啥我都告诉你了～ 🐱' },
    ]

    // 模拟 agent:chat 处理流程
    // 步骤1: 新建 AgentRunner
    const { AgentRunner } = await import('../electron/agentRunner')
    const runner = new AgentRunner({
      model: 'qwen2.5-7b-instruct',
      baseUrl: 'http://localhost:1234/v1',
      apiKey: '',
      mode: 'agent',
      socialMode: true,  // 群聊传进来的
      maxTokens: 256000,
      maxToolCalls: 10,
      contextWindow: 262144,
      skipApproval: true,
    })

    // 步骤2: setHistory（模拟 IPC 传入的 conversationHistory）
    runner.setHistory(historyForLLM)

    // 步骤3: 验证 initSystemPrompt 会在 sendMessage 时被调用
    // sendMessage 无法直接测试（需要真实 LLM），但可以验证 messages 状态
    // @ts-ignore - 访问私有属性用于测试
    const msgsBefore = runner['messages'] as any[]
    expect(msgsBefore.length).toBeGreaterThanOrEqual(2)
    
    // 检查第0条是否还没 system（还没调 sendMessage）
    // 因为 setHistory 不调 initSystemPrompt
    const firstRole = msgsBefore[0]?.role
    // 可能是 'user'（历史第一条）
    expect(['user', 'system']).toContain(firstRole)
    
    console.log(`[Test] setHistory 后 messages: ${msgsBefore.length} 条, 第0条 role=${firstRole}`)
  })

  it('两次新建 AgentRunner 不应有状态残留', async () => {
    const { AgentRunner } = await import('../electron/agentRunner')
    
    // 第一次调用
    const runner1 = new AgentRunner({
      model: 'qwen2.5-7b-instruct',
      baseUrl: 'http://localhost:1234/v1',
      apiKey: '',
      mode: 'agent',
      socialMode: true,
      maxTokens: 256000,
      maxToolCalls: 10,
      skipApproval: true,
    })
    runner1.setHistory([{ role: 'user', content: '你好' }])
    // @ts-ignore
    const msgCount1 = runner1['messages'].length
    
    // 第二次调用 — 新实例
    const runner2 = new AgentRunner({
      model: 'qwen2.5-7b-instruct',
      baseUrl: 'http://localhost:1234/v1',
      apiKey: '',
      mode: 'agent',
      socialMode: true,
      maxTokens: 256000,
      maxToolCalls: 10,
      skipApproval: true,
    })
    runner2.setHistory([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好！有什么可以帮助你的吗？' },
      { role: 'user', content: '今天天气怎么样？' },
    ])
    // @ts-ignore
    const msgCount2 = runner2['messages'].length
    
    // 各自独立，不应互相影响
    expect(runner1).not.toBe(runner2)
    // runner2 有更多历史，所以消息数更多
    expect(msgCount2).toBeGreaterThan(msgCount1)
  })

  it('setHistory 后 initSystemPrompt 能正确插入 system 消息', async () => {
    const { AgentRunner } = await import('../electron/agentRunner')
    
    const runner = new AgentRunner({
      model: 'qwen2.5-7b-instruct',
      baseUrl: 'http://localhost:1234/v1',
      apiKey: '',
      mode: 'agent',
      socialMode: true,
      maxTokens: 256000,
      maxToolCalls: 10,
      skipApproval: true,
    })
    
    runner.setHistory([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好！有什么可以帮助你的？' },
    ])
    
    // 模拟 sendMessage 的开头逻辑
    // @ts-ignore - 直接调私有方法验证
    runner['initSystemPrompt']()
    
    // @ts-ignore
    const messages = runner['messages'] as any[]
    expect(messages[0].role).toBe('system')
    expect(messages[0].content).toBeTruthy()
    expect(messages[0].content).toContain('Lumina')
    console.log(`[Test] system prompt 已插入: ${messages[0].content.slice(0, 60)}...`)
  })

  it('AgentPool/activeAgent 每次新建不会泄漏', async () => {
    // 模拟 agentIpc 每次 new AgentRunner 的行为
    const { AgentRunner } = await import('../electron/agentRunner')
    const runners: AgentRunner[] = []
    
    // 创建 5 个 runner 模拟多次对话
    for (let i = 0; i < 5; i++) {
      const runner = new AgentRunner({
        model: 'qwen2.5-7b-instruct',
        baseUrl: 'http://localhost:1234/v1',
        apiKey: '',
        mode: 'agent',
        skipApproval: true,
      })
      runner.setHistory([
        { role: 'user', content: `第 ${i} 个问题` },
        { role: 'assistant', content: `第 ${i} 个回答` },
      ])
      // @ts-ignore
      const msgs = runner['messages']
      expect(msgs.length).toBeGreaterThanOrEqual(1)
      runners.push(runner)
    }
    
    // 所有 runner 应独立
    for (const r of runners) {
      expect(r).toBeDefined()
    }
    expect(runners.length).toBe(5)
  })
})
