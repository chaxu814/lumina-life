// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// gcSessionRestore.test.ts — 从主进程日志恢复群聊会话
//
// 【背景（2026-10-13 实测）】
//   前端群聊会话存在 localStorage，而 localStorage **按 origin 隔离**：
//   开发模式 `http://localhost:5173`、打包模式 `file://`，两边互不可见
//   （落盘里确实存在两个 origin 的数据）。用户切换运行方式后会发现
//   「历史全没了」。
//
//   `dialog/YYYY-MM-DD.jsonl` 是**主进程的文件**，不受 origin 影响 ——
//   所以新增 `AgentDialogManager.listSessions()` 从它重建会话，
//   前端只在 localStorage 为空时调用（绝不覆盖已有数据）。
// ============================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const TMP = path.join(os.tmpdir(), `lumina-gc-restore-test-${process.pid}`)

vi.mock('electron', () => ({ app: { getPath: () => TMP } }))
vi.mock('../electron/agentProfileManager', () => ({
  getAgentProfileManager: () => ({
    getDialogDir: (agentId: string) => path.join(TMP, agentId, 'dialog'),
  }),
}))

const { AgentDialogManager } = await import('../electron/agentDialogManager')

/** 往 dialog 目录追加一天的 jsonl */
function writeDay(agentId: string, date: string, rows: Array<Record<string, unknown>>) {
  const dir = path.join(TMP, agentId, 'dialog')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${date}.jsonl`),
    rows.map(r => JSON.stringify(r)).join('\n') + '\n',
    'utf-8',
  )
}

const row = (
  sessionId: string,
  role: string,
  content: string,
  ts: number,
  agentId = 'lumina',
) => ({ id: `m${ts}`, role, content, timestamp: ts, agentId, sessionId })

beforeEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
})
afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('listSessions — 从 dialog 日志重建会话', () => {
  it('按 sessionId 聚合跨日期的消息', () => {
    writeDay('lumina', '2026-10-12', [
      row('s1', 'user', '昨天的问题', 1000),
      row('s1', 'assistant', '昨天的回答', 1001),
    ])
    writeDay('lumina', '2026-10-13', [
      row('s1', 'user', '今天接着问', 2000),
      row('s2', 'user', '另一个会话', 2100),
    ])

    const out = new AgentDialogManager().listSessions('lumina')
    const s1 = out.find(s => s.id === 's1')
    expect(s1).toBeDefined()
    expect(s1!.count).toBe(3)              // 跨两天聚合
    expect(s1!.messages).toHaveLength(3)
    expect(s1!.preview).toBe('今天接着问')  // 取最后一条 user 发言
    expect(out.map(s => s.id)).toEqual(['s2', 's1'])   // 按最后活跃倒序
  })

  it('过滤掉没有真实用户发言的会话（纯工具残留）', () => {
    writeDay('lumina', '2026-10-13', [
      row('toolonly', 'assistant', '（工具调用轮）', 1000),
      row('toolonly', 'tool', '{"ok":true}', 1001),
      row('real', 'user', '真实提问', 2000),
    ])
    const out = new AgentDialogManager().listSessions('lumina')
    expect(out.map(s => s.id)).toEqual(['real'])
  })

  it('system 消息不进入恢复结果（它们是每轮重复注入的内部内容）', () => {
    writeDay('lumina', '2026-10-13', [
      row('s1', 'system', '你是 Lumina……', 900),
      row('s1', 'user', '问题', 1000),
      row('s1', 'assistant', '回答', 1001),
    ])
    const out = new AgentDialogManager().listSessions('lumina')
    expect(out[0].count).toBe(2)
    expect(out[0].messages.some(m => m.content.includes('你是 Lumina'))).toBe(false)
  })

  it('每个会话的消息数有上限（单个 session 实测可达 7791 条，不能整包传 IPC）', () => {
    const rows = Array.from({ length: 500 }, (_, i) =>
      row('big', i % 2 === 0 ? 'user' : 'assistant', `第${i}条`, 1000 + i))
    writeDay('lumina', '2026-10-13', rows)

    const out = new AgentDialogManager().listSessions('lumina', 200)
    expect(out[0].count).toBe(500)                 // 总条数如实报告
    expect(out[0].messages).toHaveLength(200)      // 但只带最近 200 条
    expect(out[0].messages[199].content).toBe('第499条')
  })

  it('坏行不影响整体（真实 jsonl 可能被中断写坏）', () => {
    const dir = path.join(TMP, 'lumina', 'dialog')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '2026-10-13.jsonl'),
      `${JSON.stringify(row('s1', 'user', '正常', 1000))}\n{坏行\n`, 'utf-8')
    const out = new AgentDialogManager().listSessions('lumina')
    expect(out).toHaveLength(1)
    expect(out[0].messages[0].content).toBe('正常')
  })

  it('dialog 目录不存在时返回空数组（不抛异常）', () => {
    expect(new AgentDialogManager().listSessions('nobody')).toEqual([])
  })
})
