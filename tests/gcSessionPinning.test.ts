// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/gcSessionPinning.test.ts
//
// 守用户报告的现象：在「团队群聊」里点击「群聊记录」中的历史话题，
// 每次点击该话题都会被往上置顶，且原本的日期会被改成今天。
//
// 根因：持久化 effect 把「只读地加载历史会话」误当成「产生新消息」，
//   无条件把当前会话置顶并把日期写成今天。
// 修复：buildSessionsOnPersist 依据「加载时消息数基线」区分两种操作——
//   仅切换（消息数 === 基线）→ 不动列表；真正新增消息（> 基线）→ 才置顶刷新。
// ============================================================

import { describe, it, expect } from 'vitest'
import { buildSessionsOnPersist, type GCSession } from '../src/chat/chatShared'

const OLD_DATE = '2026/9/15'
const TODAY = '2026/10/2'

function makeSessions(): GCSession[] {
  return [
    { id: 'sessA', date: OLD_DATE, preview: '旧话题A', count: 10, pinned: true },
    { id: 'sessB', date: '2026/9/20', preview: '旧话题B', count: 5 },
  ]
}

describe('团队群聊：切换历史会话不再置顶/改时间', () => {
  it('纯切换（消息数 === 基线）返回 null，顺序与日期保持不变', () => {
    const sessions = makeSessions()
    // 加载 sessB 时基线为 5，当前仍是 5 条 → 只读切换
    const messages = [
      { from: 'user', content: '你好' },
      { from: 'lumina', content: '在的' },
      { from: 'user', content: '再问' },
      { from: 'lumina', content: '好的' },
      { from: 'user', content: '最后' },
    ]
    const result = buildSessionsOnPersist(sessions, 'sessB', messages, 5, TODAY)
    expect(result).toBeNull()
    // 原列表完全不被改动
    expect(sessions[0].id).toBe('sessA')
    expect(sessions[0].date).toBe(OLD_DATE)
    expect(sessions[1].id).toBe('sessB')
    expect(sessions[1].date).toBe('2026/9/20')
  })

  it('真正新增消息（消息数 > 基线）才置顶并刷新日期', () => {
    const sessions = makeSessions()
    const messages = [
      { from: 'user', content: '第一条' },
      { from: 'lumina', content: '回复' },
      { from: 'user', content: '新的一条消息' },
    ]
    // 基线 2，现在 3 条 → 有新消息
    const result = buildSessionsOnPersist(sessions, 'sessB', messages, 2, TODAY)
    expect(result).not.toBeNull()
    expect(result![0].id).toBe('sessB')
    expect(result![0].date).toBe(TODAY)
    expect(result![0].count).toBe(3)
    // 旧 sessB 位置被移除，其余会话（含 pinned）原样保留
    expect(result!.slice(1).map(s => s.id)).toEqual(['sessA'])
    expect(result!.find(s => s.id === 'sessA')?.pinned).toBe(true)
  })

  it('preview 取最后一条用户消息的前 30 个字符', () => {
    const sessions = makeSessions()
    const longText = '这是一条超过三十个字符的很长很长的用户消息内容用来测试截断逻辑哦哦哦哦哦'
    const messages = [
      { from: 'user', content: '早先的问题' },
      { from: 'lumina', content: '回复' },
      { from: 'user', content: longText },
    ]
    const result = buildSessionsOnPersist(sessions, 'sessB', messages, 2, TODAY)
    expect(result![0].preview).toBe(longText.slice(0, 30))
  })

  it('基线缺失（首次加载）时正常更新', () => {
    const sessions = makeSessions()
    const messages = [{ from: 'user', content: '你好' }]
    const result = buildSessionsOnPersist(sessions, 'sessB', messages, undefined, TODAY)
    expect(result).not.toBeNull()
    expect(result![0].id).toBe('sessB')
    expect(result![0].date).toBe(TODAY)
  })

  it('消息数少于基线（异常/回退）也不置顶', () => {
    const sessions = makeSessions()
    const messages = [{ from: 'user', content: 'x' }]
    const result = buildSessionsOnPersist(sessions, 'sessB', messages, 5, TODAY)
    expect(result).toBeNull()
  })
})
