// ============================================================
// tests/ensureUserFirst.test.ts
//
// 【这是行为级验证】直接构造历史，验证「第一条非 system 必须是 user」
//   这条协议要求是如何被满足的 —— 而且**不再靠伪造用户消息**。
//
//   真实故障（2026-10-11/12）：
//     · 旧版插入字面量「（继续）」→ 模型问「"（继续）"这个指示是什么意思？」
//     · 改成「【系统占位·不是用户发言】…」→ 模型回
//       「明白了，收到。不会把这条系统消息当作新的指令。」（把用户的问题整个吞了）
//   只要往 user 位置塞伪造内容，就有概率被模型"回应"。
// ============================================================

import { describe, it, expect } from 'vitest'
import { ensureUserFirst } from '../electron/agentRunner.text'

type M = { role: string; content?: string }

describe('★ 不再伪造用户消息（本轮核心修复）', () => {
  it('历史里有 user 时：绝不插入任何伪造的 user 消息', () => {
    const input: M[] = [
      { role: 'system', content: 'sys' },
      { role: 'assistant', content: '孤立的上一轮回答' },
      { role: 'user', content: '用户的真实问题' },
    ]
    const r = ensureUserFirst(input)
    const userMsgs = r.messages.filter(m => m.role === 'user')
    expect(userMsgs).toHaveLength(1)
    expect(userMsgs[0].content).toBe('用户的真实问题')
    // 关键：不能出现任何"伪造"的用户内容
    const joined = r.messages.map(m => String(m.content || '')).join('\n')
    expect(joined).not.toContain('（继续）')
    expect(joined).not.toContain('系统占位')
    expect(joined).not.toContain('不要把它当成')
  })

  it('改为丢弃开头的孤立消息，让真实的 user 成为第一条非 system', () => {
    const input: M[] = [
      { role: 'system', content: 'sys' },
      { role: 'assistant', content: '孤立回答' },
      { role: 'tool', content: '孤立工具结果' },
      { role: 'user', content: '真实问题' },
    ]
    const r = ensureUserFirst(input)
    expect(r.droppedLeading).toBe(2)
    expect(r.insertedPlaceholder).toBe(false)
    expect(r.messages[0].role).toBe('system')
    expect(r.messages[1].role).toBe('user')
    expect(r.messages[1].content).toBe('真实问题')
  })

  it('结果一定满足「第一条非 system 是 user」', () => {
    const cases: M[][] = [
      [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }],
      [{ role: 'system', content: 's' }, { role: 'assistant', content: 'a' }, { role: 'user', content: 'u' }],
      [{ role: 'system', content: 's' }, { role: 'tool', content: 't' }, { role: 'user', content: 'u' }],
      [{ role: 'system', content: 's' }, { role: 'assistant', content: 'a' }],
      [],
      [{ role: 'user', content: 'u' }],
    ]
    for (const c of cases) {
      const r = ensureUserFirst(c)
      const idx = r.messages.findIndex(m => m.role !== 'system')
      expect(idx, JSON.stringify(c)).toBeGreaterThanOrEqual(0)
      expect(r.messages[idx].role, JSON.stringify(c)).toBe('user')
    }
  })
})

describe('正常历史不受影响', () => {
  it('已是 user 开头 → 原样返回、不丢消息', () => {
    const input: M[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'Q1' },
      { role: 'assistant', content: 'A1' },
      { role: 'user', content: 'Q2' },
    ]
    const r = ensureUserFirst(input)
    expect(r.droppedLeading).toBe(0)
    expect(r.insertedPlaceholder).toBe(false)
    expect(r.messages).toEqual(input)
  })

  it('多轮历史一条不丢', () => {
    const input: M[] = [
      { role: 'system', content: 's' },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'q3' },
    ]
    expect(ensureUserFirst(input).messages).toHaveLength(6)
  })
})

describe('极端兜底：整段历史没有任何 user', () => {
  it('才插入最短的中性占位（你好），并如实标记', () => {
    const r = ensureUserFirst([{ role: 'system', content: 's' }, { role: 'assistant', content: 'a' }])
    expect(r.insertedPlaceholder).toBe(true)
    expect(r.messages[1].role).toBe('user')
    expect(r.messages[1].content).toBe('你好')
  })

  it('空历史也能兜住', () => {
    const r = ensureUserFirst([])
    expect(r.insertedPlaceholder).toBe(true)
    expect(r.messages.some(m => m.role === 'user')).toBe(true)
  })
})

describe('纯函数：不修改入参', () => {
  it('原数组保持不变', () => {
    const input: M[] = [
      { role: 'system', content: 's' },
      { role: 'assistant', content: 'a' },
      { role: 'user', content: 'u' },
    ]
    const snapshot = JSON.parse(JSON.stringify(input))
    ensureUserFirst(input)
    expect(input).toEqual(snapshot)
  })

  it('null / undefined 不抛错', () => {
    expect(() => ensureUserFirst(null as never)).not.toThrow()
    expect(ensureUserFirst(undefined as never).messages.length).toBeGreaterThan(0)
  })
})
