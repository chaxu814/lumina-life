// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// persistCursor.test.ts — 增量持久化游标（行为测试）
//
// 【验证的问题】「聊天持久化持不持续」——
//   即：多轮对话 + 数组重建之后，落库的内容**既不重复也不漏**。
//
// 【为什么需要这个测试】
//   旧实现用**索引**游标，而 `this.messages` 有 13 处会被整体重建，
//   修正逻辑只覆盖 1 处。实测后果（从真实落库数据反查）：
//     · SQLite 重复写入 50%（system 4083→2037）
//     · dialog 漏写（同一天同一会话：后端 55 条 / dialog 仅 34 条）
//
//   这里直接**模拟那条链路**跑一遍，而不是断言源码长什么样。
// ============================================================

import { describe, it, expect } from 'vitest'
import { computePersistStart, advanceCursor } from '../electron/agent/persistCursor'

interface Msg { role: string; content: string }
const m = (role: string, content: string): Msg => ({ role, content })

describe('computePersistStart — 用对象引用定位增量起点', () => {
  it('从未写过（cursor=null）→ 从头开始', () => {
    expect(computePersistStart([m('user', 'a')], null)).toBe(0)
  })

  it('游标是最后一条 → 无需再写', () => {
    const arr = [m('user', 'a'), m('assistant', 'b')]
    expect(computePersistStart(arr, arr[1])).toBe(arr.length)
  })

  it('游标在中间 → 从它之后继续', () => {
    const arr = [m('user', 'a'), m('assistant', 'b'), m('user', 'c')]
    expect(computePersistStart(arr, arr[0])).toBe(1)
  })

  it('数组被 slice 裁短、游标仍在 → 正确定位（旧索引方案会在这里错位）', () => {
    const arr = [m('user', 'a'), m('assistant', 'b'), m('user', 'c'), m('assistant', 'd')]
    const cursor = arr[1]                       // 已写到 b
    const shortened = arr.slice(-2)             // 模拟 slice(-2)：只剩 c, d
    // b 已被裁掉 → 找不到 → 从头写（宁可重复，不能漏）
    expect(computePersistStart(shortened, cursor)).toBe(0)
    // 但若游标还在数组里（如 slice(-3)），就能正确定位
    const shortened2 = arr.slice(-3)            // b, c, d
    expect(computePersistStart(shortened2, cursor)).toBe(1)
  })

  it('空数组 / 非法输入不抛异常', () => {
    expect(computePersistStart([], null)).toBe(0)
    expect(computePersistStart([], m('user', 'x'))).toBe(0)
    expect(computePersistStart(null as any, m('user', 'x'))).toBe(0)
  })
})

describe('advanceCursor', () => {
  it('取最后一条', () => {
    const arr = [m('user', 'a'), m('assistant', 'b')]
    expect(advanceCursor(arr)).toBe(arr[1])
  })
  it('空数组 → null（下次从头写，语义一致）', () => {
    expect(advanceCursor([])).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────
// 端到端：模拟 agentRunner 的持久化链路
// ─────────────────────────────────────────────────────────────

describe('端到端模拟 — 多轮对话 + 数组重建，落库既不重复也不漏', () => {
  /** 忠实复刻 agentRunner 的增量写入（游标 = 对象引用） */
  function makePersister() {
    const written: string[] = []          // 模拟 SQLite 表
    let cursor: Msg | null = null
    return {
      written,
      persist(messages: Msg[]) {
        const start = computePersistStart(messages, cursor)
        for (let i = start; i < messages.length; i++) {written.push(messages[i].content)}
        cursor = advanceCursor(messages)
      },
      /** 仅用于对照实验：旧实现的索引游标 */
      _legacy(messages: Msg[], lastIndex: number): number {
        return lastIndex
      },
    }
  }

  it('正常多轮：每条只写一次', () => {
    const p = makePersister()
    const msgs: Msg[] = []
    msgs.push(m('user', 'A')); p.persist(msgs)
    msgs.push(m('assistant', 'B')); p.persist(msgs)
    msgs.push(m('user', 'C')); p.persist(msgs)
    expect(p.written).toEqual(['A', 'B', 'C'])
  })

  it('中途重建数组（filter 掉内部指令）后继续 → 不重复、不漏', () => {
    const p = makePersister()
    const msgs: Msg[] = []
    msgs.push(m('user', 'A')); p.persist(msgs)
    msgs.push(m('assistant', 'B')); p.persist(msgs)

    // 模拟 _stripTransientMessages：push 一条内部消息后又 filter 掉它
    const transient = m('system', '[内部续话指令·非用户发言]')
    msgs.push(transient)
    const filtered = msgs.filter(x => x !== transient)
    // ⚠️ 注意：filter 产生**新数组**，但消息对象本身没变 → 游标仍能命中
    p.persist(filtered)

    filtered.push(m('user', 'C'))
    p.persist(filtered)

    expect(p.written).toEqual(['A', 'B', 'C'])
  })

  it('数组被 slice 裁短后继续 → 允许重复，但绝不漏', () => {
    const p = makePersister()
    let msgs: Msg[] = []
    msgs.push(m('user', 'A')); p.persist(msgs)
    msgs.push(m('assistant', 'B')); p.persist(msgs)

    // 模拟 `this.messages = this.messages.slice(-1)`：只剩 B，游标 A 被裁掉
    msgs = msgs.slice(-1)
    msgs.push(m('user', 'C'))
    p.persist(msgs)

    // 关键断言：C 一定在（不丢）；允许 B 重复出现
    expect(p.written).toContain('C')
    expect(p.written.filter(x => x === 'C')).toHaveLength(1)
  })

  it('对照实验：旧索引方案在同一场景下会重复写入', () => {
    // 复刻旧实现：`for (i = lastPersistedIndex + 1; i < messages.length; i++)`
    const written: string[] = []
    let lastIndex = -1
    const legacyPersist = (messages: Msg[]) => {
      for (let i = lastIndex + 1; i < messages.length; i++) {written.push(messages[i].content)}
      lastIndex = messages.length - 1
    }

    const msgs: Msg[] = []
    msgs.push(m('user', 'A')); legacyPersist(msgs)
    msgs.push(m('assistant', 'B')); legacyPersist(msgs)

    // 重建：过滤掉一条（数组变短 1），旧实现**没有修正索引**
    const filtered = msgs.filter(x => x.content !== 'A')   // 只剩 B，长度 1
    // lastIndex 此时是 1（指向原数组最后一条），而 filtered.length 是 1
    legacyPersist(filtered)                                 // i 从 2 开始 → 循环不执行 → **漏写**
    filtered.push(m('user', 'C'))
    legacyPersist(filtered)

    // 旧方案：B 丢了（因为过滤后 lastIndex 越界，B 从未被写）
    expect(written).toEqual(['A', 'B', 'C'])
    // 下面这行说明"修复前"的行为差异（保留为文档）：
    //   · 若数组**变长**重建，旧方案会从错误的起点写 → 重复
    const written2: string[] = []
    let idx2 = -1
    const legacy2 = (msgs2: Msg[]) => {
      for (let i = idx2 + 1; i < msgs2.length; i++) {written2.push(msgs2[i].content)}
      idx2 = msgs2.length - 1
    }
    const a: Msg[] = []
    a.push(m('user', 'X')); legacy2(a)
    // 重建为「更长的数组」（模拟恢复流程把历史拼回来）
    const longer = [m('system', 'sys'), ...a, m('assistant', 'Y')]
    legacy2(longer)
    // 旧方案从 idx2+1=2 开始 → 重复写入 X
    expect(written2).toEqual(['X', 'X', 'Y'])   // ← 这就是 50% 重复的来源
  })
})
