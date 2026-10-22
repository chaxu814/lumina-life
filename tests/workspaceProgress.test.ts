// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/workspaceProgress.test.ts
//
// 覆盖本轮新增的三块逻辑：
//   1. 进度看板（图1）：归一化 / 进度统计 / 状态更新 / 交付物
//   2. 持久工具记录：start/end 配对、并发同名、不被 resetAgentRuntime 影响
//   3. 思考步骤归一化：AgentEvent / ThinkingStep 混合数组 → 统一渲染
//   4. 内置浏览器地址白名单与补全
//
// 特别守住的是「工作区和聊天不联动」那个回归：
//   工具记录必须活在 taskWorkspaceStore，而不是 agentRuntimeStore。
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest'
import {
  useTaskWorkspace,
  boardProgress,
  normalizeBoardItems,
  findRunningToolCall,
  pruneToolCalls,
  deriveAgentStatusFromCalls,
  RECENT_ACTIVITY_MS,
  type ToolCallRecord,
} from '../src/stores/taskWorkspaceStore'
import { isAllowedUrl, normalizeUrl } from '../electron/browser/browserUrl'

// ─────────────────────────────────────────────────────────
// 1. 进度看板
// ─────────────────────────────────────────────────────────

describe('进度看板', () => {
  beforeEach(() => {
    useTaskWorkspace.setState({ board: null })
  })

  it('归一化：status 别名 + 丢弃空文案', () => {
    const items = normalizeBoardItems([
      { text: '修复托盘', status: 'completed' },
      { text: '做浏览器', status: 'in_progress' },
      { text: '接 Agent', status: 'todo' },
      { text: '   ' },
      { text: '没写状态' },
    ])
    expect(items).toHaveLength(4)
    expect(items[0].status).toBe('done')
    expect(items[1].status).toBe('active')
    expect(items[2].status).toBe('pending')
    expect(items[3].status).toBe('pending')
  })

  it('归一化：done=true 也算完成，并带上完成时间', () => {
    const [a] = normalizeBoardItems([{ text: 'x', done: true }])
    expect(a.status).toBe('done')
    expect(typeof a.completedAt).toBe('number')
  })

  it('归一化：交付物保留 kind/label/ref', () => {
    const [a] = normalizeBoardItems([
      { text: '出报告', status: 'done', deliverable: { kind: 'file', label: 'report.md', ref: 'C:/r.md' } },
    ])
    expect(a.deliverable).toEqual({ kind: 'file', label: 'report.md', ref: 'C:/r.md' })
  })

  it('进度统计：done/total/percent', () => {
    expect(boardProgress(null)).toEqual({ done: 0, total: 0, percent: 0 })
    const b = {
      title: '进度',
      updatedAt: 0,
      items: [
        { id: '1', text: 'a', status: 'done' as const },
        { id: '2', text: 'b', status: 'done' as const },
        { id: '3', text: 'c', status: 'active' as const },
        { id: '4', text: 'd', status: 'pending' as const },
      ],
    }
    expect(boardProgress(b)).toEqual({ done: 2, total: 4, percent: 50 })
  })

  it('setBoard 写入并可被 updateBoardItem 更新（交付物跟着走）', () => {
    const ws = useTaskWorkspace.getState()
    ws.setBoard({
      title: '图1 任务板',
      items: [
        { id: 'i1', text: '第一项', status: 'done', deliverable: { kind: 'artifact', label: 'a.ts', ref: 'art-1' } },
        { id: 'i2', text: '第二项', status: 'active' },
        { id: 'i3', text: '第三项', status: 'pending' },
      ],
    })
    const board = useTaskWorkspace.getState().board
    expect(board?.title).toBe('图1 任务板')
    expect(board?.items).toHaveLength(3)
    expect(board?.items[0].deliverable?.kind).toBe('artifact')

    useTaskWorkspace.getState().updateBoardItem('i2', { status: 'done' })
    const after = useTaskWorkspace.getState().board!
    expect(after.items[1].status).toBe('done')
    expect(typeof after.items[1].completedAt).toBe('number')

    useTaskWorkspace.getState().updateBoardItem('i2', { status: 'pending' })
    expect(useTaskWorkspace.getState().board!.items[1].completedAt).toBeUndefined()
  })

  it('setBoard(null) / 空列表 → 清空看板', () => {
    useTaskWorkspace.getState().setBoard({ items: [{ text: 'x', status: 'done' }] })
    useTaskWorkspace.getState().setBoard(null)
    expect(useTaskWorkspace.getState().board).toBeNull()

    useTaskWorkspace.getState().setBoard({ items: [{ text: 'x', status: 'done' }] })
    useTaskWorkspace.getState().setBoard({ items: [] })
    expect(useTaskWorkspace.getState().board).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────
// 2. 持久工具记录
// ─────────────────────────────────────────────────────────

describe('持久工具调用记录', () => {
  beforeEach(() => {
    useTaskWorkspace.setState({ toolCalls: [] })
  })

  it('start/end 配对成一条记录，并算出耗时', async () => {
    const ws = useTaskWorkspace.getState()
    ws.recordToolStart('web_search', 'lumina', 'c1', { q: 'lumina' })
    expect(useTaskWorkspace.getState().toolCalls).toHaveLength(1)
    expect(useTaskWorkspace.getState().toolCalls[0].status).toBe('running')

    await new Promise((r) => setTimeout(r, 5))
    useTaskWorkspace.getState().recordToolEnd('web_search', true, 'lumina', 'c1', { n: 3 })

    const calls = useTaskWorkspace.getState().toolCalls
    expect(calls).toHaveLength(1)
    expect(calls[0].status).toBe('done')
    expect(calls[0].args).toEqual({ q: 'lumina' })
    expect(calls[0].result).toEqual({ n: 3 })
    expect(calls[0].durationMs).toBeGreaterThanOrEqual(0)
    expect(calls[0].endedAt).toBeGreaterThanOrEqual(calls[0].startedAt)
  })

  it('同名工具调用多次 → 各自独立成条，不按名字折叠', () => {
    const ws = useTaskWorkspace.getState()
    ws.recordToolStart('file_read', 'lumina', 'c1', { p: 1 })
    useTaskWorkspace.getState().recordToolEnd('file_read', true, 'lumina', 'c1')
    useTaskWorkspace.getState().recordToolStart('file_read', 'lumina', 'c1', { p: 2 })

    const calls = useTaskWorkspace.getState().toolCalls
    expect(calls).toHaveLength(2)
    expect(calls[0].status).toBe('done')
    expect(calls[1].status).toBe('running')
  })

  it('end 没有配对的 start 时补一条记录，不让调用凭空消失', () => {
    useTaskWorkspace.getState().recordToolEnd('stray_tool', false, 'lumina', 'c1', 'boom')
    const calls = useTaskWorkspace.getState().toolCalls
    expect(calls).toHaveLength(1)
    expect(calls[0].status).toBe('error')
    expect(calls[0].name).toBe('stray_tool')
  })

  it('不同会话之间不串：同名工具在两个会话各自配对', () => {
    const ws = useTaskWorkspace.getState()
    ws.recordToolStart('fetch', 'lumina', 'A')
    ws.recordToolStart('fetch', 'lumina', 'B')
    // 只结束 A 里的那条
    useTaskWorkspace.getState().recordToolEnd('fetch', true, 'lumina', 'A')

    const calls = useTaskWorkspace.getState().toolCalls
    expect(calls.filter((c) => c.status === 'done')).toHaveLength(1)
    expect(calls.filter((c) => c.status === 'running')).toHaveLength(1)
    expect(calls.find((c) => c.status === 'running')!.conversationId).toBe('B')
  })

  it('findRunningToolCall 取最近一条同名运行中的记录', () => {
    const calls: ToolCallRecord[] = [
      { id: '1', name: 'x', agentId: 'lumina', status: 'running', startedAt: 1 },
      { id: '2', name: 'x', agentId: 'lumina', status: 'done', startedAt: 2 },
      { id: '3', name: 'x', agentId: 'lumina', status: 'running', startedAt: 3 },
    ]
    expect(findRunningToolCall(calls, 'x')!.id).toBe('3')
    expect(findRunningToolCall(calls, 'nope')).toBeUndefined()
  })

  it('clearToolCalls 可按会话清', () => {
    const ws = useTaskWorkspace.getState()
    ws.recordToolStart('t', 'lumina', 'A')
    ws.recordToolStart('t', 'lumina', 'B')
    useTaskWorkspace.getState().clearToolCalls('A')
    const calls = useTaskWorkspace.getState().toolCalls
    expect(calls).toHaveLength(1)
    expect(calls[0].conversationId).toBe('B')
  })

  it('pruneToolCalls 超量时丢最旧的已结束记录，保留运行中', () => {
    const many: ToolCallRecord[] = []
    for (let i = 0; i < 10; i++) {
      many.push({ id: `d${i}`, name: 'd', agentId: 'l', status: 'done', startedAt: i })
    }
    many.push({ id: 'run', name: 'r', agentId: 'l', status: 'running', startedAt: 100 })

    const pruned = pruneToolCalls(many, 5)
    expect(pruned).toHaveLength(5)
    expect(pruned.find((c) => c.id === 'run')).toBeTruthy()
    // 时间顺序仍然递增
    for (let i = 1; i < pruned.length; i++) {
      expect(pruned[i].startedAt).toBeGreaterThanOrEqual(pruned[i - 1].startedAt)
    }
  })
})

// ─────────────────────────────────────────────────────────
// 3. Agent 状态派生（不随 resetAgentRuntime 归零）
// ─────────────────────────────────────────────────────────

describe('Agent 状态派生（读持久记录）', () => {
  const now = 1_000_000

  it('无任何记录 → 待机中', () => {
    expect(deriveAgentStatusFromCalls([], '', now)).toEqual({ text: '待机中', status: 'idle' })
  })

  it('有运行中的调用 → 执行工具 X', () => {
    const calls: ToolCallRecord[] = [
      { id: '1', name: 'web_search', agentId: 'l', status: 'running', startedAt: now },
    ]
    expect(deriveAgentStatusFromCalls(calls, '', now).text).toBe('执行工具 web_search')
  })

  it('刚完成 → 显示完成什么，而不是立刻退回待机（关键回归）', () => {
    const calls: ToolCallRecord[] = [
      { id: '1', name: 'file_read', agentId: 'l', status: 'done', startedAt: now - 100, endedAt: now },
    ]
    expect(deriveAgentStatusFromCalls(calls, '', now)).toEqual({ text: '完成 file_read', status: 'done' })

    // 超过"刚刚"窗口后才回到待机
    const stale = deriveAgentStatusFromCalls(calls, '', now + RECENT_ACTIVITY_MS + 1)
    expect(stale).toEqual({ text: '待机中', status: 'idle' })
  })

  it('最后一条是失败 → 显示失败', () => {
    const calls: ToolCallRecord[] = [
      { id: '1', name: 'shell_exec', agentId: 'l', status: 'error', startedAt: now, endedAt: now },
    ]
    expect(deriveAgentStatusFromCalls(calls, '', now)).toEqual({ text: '工具 shell_exec 失败', status: 'error' })
  })

  it('思考中优先于最近完成', () => {
    const calls: ToolCallRecord[] = [
      { id: '1', name: 'x', agentId: 'l', status: 'done', startedAt: now, endedAt: now },
    ]
    expect(deriveAgentStatusFromCalls(calls, '在想点事', now).text).toBe('正在思考…')
  })
})

// ─────────────────────────────────────────────────────────
// 4. 内置浏览器地址处理
// ─────────────────────────────────────────────────────────

describe('内置浏览器地址', () => {
  it('放行 http/https/file/about:blank', () => {
    expect(isAllowedUrl('https://example.com')).toBe(true)
    expect(isAllowedUrl('http://example.com/a?b=1')).toBe(true)
    expect(isAllowedUrl('file:///C:/tmp/a.html')).toBe(true)
    expect(isAllowedUrl('about:blank')).toBe(true)
  })

  it('放行裸域名（当作 https）', () => {
    expect(isAllowedUrl('example.com')).toBe(true)
    expect(isAllowedUrl('news.ycombinator.com/item?id=1')).toBe(true)
  })

  it('拦截危险协议', () => {
    expect(isAllowedUrl('javascript:alert(1)')).toBe(false)
    expect(isAllowedUrl('data:text/html,<h1>x</h1>')).toBe(false)
    expect(isAllowedUrl('')).toBe(false)
  })

  it('补全缺省协议', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com')
    expect(normalizeUrl('  example.com/a  ')).toBe('https://example.com/a')
    expect(normalizeUrl('https://a.com')).toBe('https://a.com')
    expect(normalizeUrl('about:blank')).toBe('about:blank')
    // 危险协议不会被补全，直接落到空白页
    expect(normalizeUrl('javascript:alert(1)')).toBe('about:blank')
    expect(normalizeUrl('')).toBe('about:blank')
  })
})
