// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/groupChatSessionFlow.test.ts
//
// 【要防的故障】2026-10-07 用户反馈：
//   「点 + 新建群聊时，希望落到那个任务类型卡片页，比较舒服」
//
//   根因：侧边栏 + 按钮派发 `gc:new-session`，而 GroupChatView 的 onNew
//   只重置了消息，**没有重置 showRoleSelector** —— 于是「刚聊完点 + 新建」
//   会停在空白聊天页，而不是角色卡片落地页。
//
//   同时发现该文件对 `gc:new-session` / `gc:load-session` 有**两套监听器**，
//   靠「注册顺序 + React 批处理里后者覆盖前者」才碰巧正确 —— 顺序依赖隐患。
//   已收敛为单套（下方那套是超集）。
// ============================================================

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const root = path.resolve(__dirname, '..')
const src = fs.readFileSync(path.join(root, 'src', 'panels', 'GroupChatView.tsx'), 'utf-8')

/** 取某个函数/handler 的函数体片段（用于断言其内部行为） */
function sliceFrom(anchor: string, len = 900): string {
  const i = src.indexOf(anchor)
  expect(i, `找不到锚点：${anchor}`).toBeGreaterThan(-1)
  return src.slice(i, i + len)
}

describe('新建群聊 — 必须落到任务类型选择页', () => {
  it('onNew 会打开角色选择页（setShowRoleSelector(true)）', () => {
    const body = sliceFrom('const onNew = (e: Event) =>')
    expect(body, 'onNew 没有重置 showRoleSelector —— 新建后会停在空白聊天页')
      .toContain('setShowRoleSelector(true)')
  })

  it('onNew 会清掉上一个任务类型（setSelectedRole(null)）', () => {
    const body = sliceFrom('const onNew = (e: Event) =>')
    expect(body).toContain('setSelectedRole(null)')
  })

  it('onNew 仍会给新会话写入欢迎消息', () => {
    const body = sliceFrom('const onNew = (e: Event) =>')
    expect(body).toContain('新的团队群聊')
  })
})

describe('加载历史会话 — 按内容决定落哪一屏', () => {
  it('onLoad 依据消息条数决定是否显示角色选择页', () => {
    const body = sliceFrom('const onLoad = (e: Event) =>', 1200)
    expect(body).toContain('setShowRoleSelector(msgs.length <= 1)')
  })

  it('空会话分支也会打开角色选择页', () => {
    const body = sliceFrom('const onLoad = (e: Event) =>', 1800)
    expect(body).toContain('setShowRoleSelector(true)')
  })
})

describe('会话事件监听器 — 不能有顺序依赖的重复实现', () => {
  it('gc:new-session 只在一处 setMessages（收敛后不再有第二个 handler 写消息）', () => {
    // 旧的重复 handler 会写 setMessages([])；它必须已消失
    expect(src, '重复的 setMessages([]) handler 仍在，存在顺序依赖隐患')
      .not.toContain('setMessages([])')
  })

  it('仍然监听两个会话事件（功能没被误删）', () => {
    expect(src).toContain("addEventListener('gc:new-session'")
    expect(src).toContain("addEventListener('gc:load-session'")
  })

  it('重置回复状态的那件事仍被保留', () => {
    // 收敛后的精简 handler 只负责 resetReplying
    expect(src).toContain('resetReplying')
    expect(src).toContain('setReplyingAgent(null)')
  })
})

describe('角色卡片页 — 选中卡片后进入聊天', () => {
  it('点卡片会关闭选择页并记录任务类型', () => {
    const i = src.indexOf('TASK_TYPE_CARDS.map')
    const body = src.slice(i, i + 400)
    expect(body).toContain('setSelectedRole(card.id)')
    expect(body).toContain('setShowRoleSelector(false)')
  })
})
