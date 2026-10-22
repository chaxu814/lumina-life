// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/historySanitize.test.ts
//
// 守 `sanitizeHistoryForApi()` —— 失败恢复轮的历史整理。
//
// 为什么必须有它：OpenAI 兼容协议要求 `role:'tool'` 消息必须**紧跟**一条
// 带 `tool_calls` 的 assistant 消息，且 tool_call_id 要能对上，否则请求直接 400。
//
// 这个坑是"保留上下文"这个修复自己引入的：
//   恢复轮从 messages 里 slice(-12) 保留最近上下文 → 很容易从半截开始
//   → 切出没有父 assistant 的孤儿 tool 消息 → 恢复请求直接 400。
// 而 400 比"失忆后重编"更糟：用户看到的是彻底失败。
//
// 所以：孤儿 tool 消息降级成 user 角色的历史说明 —— 不丢信息，也不违反协议。
// ============================================================

import { describe, it, expect, vi } from 'vitest'

// agentRunner 的导入链会拉起 delegationManager → asyncTaskManager，
// 顶层就调 app.getPath，所以必须先 mock electron（与 tests/agentRunner.test.ts 同款）。
vi.mock('electron', () => ({
  app: {
    getPath: () => process.cwd(),
  },
  ipcMain: { handle: () => {}, on: () => {} },
  BrowserWindow: class {},
  session: { fromPartition: () => ({}) },
  dialog: {},
  shell: {},
  Notification: class {},
}))

import { sanitizeHistoryForApi } from '../electron/agentRunner'

type M = { role: string; content?: any; tool_calls?: any[]; tool_call_id?: string }

describe('恢复轮历史整理（API 协议合法性）', () => {
  it('合法形态原样保留：assistant(tool_calls) → tool(tool_call_id) 成对的不动', () => {
    const msgs: M[] = [
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '结果A' },
    ]
    expect(sanitizeHistoryForApi(msgs)).toEqual(msgs)
  })

  it('孤儿 tool 消息降级为 user 历史说明（不丢内容、不违反协议）', () => {
    // 典型的 slice 截断现场：第一条就是没有父 assistant 的 tool 消息
    const msgs: M[] = [
      { role: 'tool', tool_call_id: 'call_9', content: '残留的工具结果' },
      { role: 'user', content: '继续' },
    ]
    const out = sanitizeHistoryForApi(msgs)

    expect(out[0].role).toBe('user')
    expect(out[0].tool_call_id).toBeUndefined()
    expect(out[0].tool_calls).toBeUndefined()
    expect(String(out[0].content)).toContain('残留的工具结果')
    expect(String(out[0].content)).toContain('历史工具结果')
  })

  it('父 assistant 存在但 tool_call_id 对不上 → 同样降级', () => {
    const msgs: M[] = [
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_1' }] },
      { role: 'tool', tool_call_id: 'call_999', content: 'id 对不上' },
    ]
    const out = sanitizeHistoryForApi(msgs)
    expect(out[1].role).toBe('user')
    expect(String(out[1].content)).toContain('id 对不上')
  })

  it('父消息不是 assistant → 降级', () => {
    const msgs: M[] = [
      { role: 'user', content: '你好' },
      { role: 'tool', tool_call_id: 'call_1', content: '无父' },
    ]
    expect(sanitizeHistoryForApi(msgs)[1].role).toBe('user')
  })

  it('多个 tool 消息时按顺序逐个判定，只有真正孤儿被降级', () => {
    const msgs: M[] = [
      { role: 'tool', tool_call_id: 'orphan', content: '孤儿1' },
      {
        role: 'assistant', content: '',
        tool_calls: [{ id: 'ok1' }, { id: 'ok2' }],
      },
      { role: 'tool', tool_call_id: 'ok1', content: '正常1' },
      { role: 'tool', tool_call_id: 'ok2', content: '正常2' },
    ]
    const out = sanitizeHistoryForApi(msgs)
    expect(out[0].role).toBe('user')          // 孤儿被降级
    expect(out[2].role).toBe('tool')          // 合法保留
    expect(out[3].role).toBe('tool')          // 合法保留
    expect(String(out[2].content)).toBe('正常1')
  })

  it('后续合法的 tool 消息不会被前面的孤儿影响', () => {
    const msgs: M[] = [
      { role: 'assistant', content: '', tool_calls: [{ id: 'a' }] },
      { role: 'tool', tool_call_id: 'a', content: '合法' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'b' }] },
      { role: 'tool', tool_call_id: 'b', content: '也合法' },
    ]
    const out = sanitizeHistoryForApi(msgs)
    expect(out.every(m => m.role === 'assistant' || m.role === 'tool')).toBe(true)
  })

  it('user / assistant 普通消息完全不受影响', () => {
    const msgs: M[] = [
      { role: 'user', content: '问题' },
      { role: 'assistant', content: '回答' },
    ]
    expect(sanitizeHistoryForApi(msgs)).toEqual(msgs)
  })

  it('空数组与全空内容不崩', () => {
    expect(sanitizeHistoryForApi([])).toEqual([])
    expect(sanitizeHistoryForApi([{ role: 'tool', tool_call_id: 'x' }])[0].role).toBe('user')
  })

  it('不修改入参数组（不改原对象）', () => {
    const orphan: M = { role: 'tool', tool_call_id: 'x', content: '原文' }
    const input = [orphan]
    sanitizeHistoryForApi(input)
    expect(input[0]).toBe(orphan)
    expect(input[0].role).toBe('tool')
  })
})
