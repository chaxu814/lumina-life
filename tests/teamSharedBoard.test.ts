// ============================================================
// tests/teamSharedBoard.test.ts — 共享任务板测试 (v3.20)
//
// 覆盖：纯状态变换（自领取首认领者胜/依赖门禁/幂等/状态守卫）、
//       持久化存储的完整生命周期、claimNext 优先级与僵死回收、
//       原子写跨实例可见。
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }))

import {
  SharedBoardStore,
  createTaskInState, claimInState,
} from '../electron/team/teamSharedBoard'

function emptyState() {
  return { tasks: [], seq: 0 }
}

describe('纯状态变换 createTaskInState', () => {
  it('任务 id 递增、初始 pending 且无 owner', () => {
    const r1 = createTaskInState(emptyState(), { title: 'a' }, 1000)
    expect(r1.task.id).toBe('t1')
    expect(r1.task.status).toBe('pending')
    expect(r1.task.owner).toBeNull()
    const r2 = createTaskInState(r1.state, { title: 'b' }, 1001)
    expect(r2.task.id).toBe('t2')
    expect(r2.state.tasks).toHaveLength(2)
  })
})

describe('纯状态变换 claimInState', () => {
  it('首个认领者获胜，第二个人失败', () => {
    const created = createTaskInState(emptyState(), { title: 'a' }, 1000)
    const r1 = claimInState(created.state, 't1', 'yak', 1001)
    expect(r1.error).toBeUndefined()
    expect(r1.task!.owner).toBe('yak')
    const r2 = claimInState(r1.state, 't1', 'recha', 1002)
    expect(r2.error).toContain('yak')
  })

  it('自己重复认领幂等成功', () => {
    const c = createTaskInState(emptyState(), { title: 'a' })
    const r1 = claimInState(c.state, 't1', 'yak')
    const r2 = claimInState(r1.state, 't1', 'yak')
    expect(r2.task).toBeDefined()
    expect(r2.error).toBeUndefined()
  })

  it('已完成任务不可再认领', () => {
    const c = createTaskInState(emptyState(), { title: 'a' })
    const claimed = claimInState(c.state, 't1', 'yak')
    const t = { ...claimed.task!, status: 'done' as const }
    const doneState = { ...claimed.state, tasks: [t] }
    expect(claimInState(doneState, 't1', 'recha').error).toContain('已完成')
  })

  it('前置依赖未完成（含依赖不存在）时不可认领', () => {
    let s = emptyState()
    let r = createTaskInState(s, { title: '父任务' }, 1000)
    s = r.state
    r = createTaskInState(s, { title: '子任务', blockedBy: ['t1'] }, 1001)
    s = r.state
    expect(claimInState(s, 't2', 'yak').error).toContain('依赖')
    // 父任务完成后可认领
    const claimed = claimInState(s, 't1', 'yak')
    const done = { ...claimed.state, tasks: claimed.state.tasks.map(x => x.id === 't1' ? { ...x, status: 'done' as const } : x) }
    expect(claimInState(done, 't2', 'recha').error).toBeUndefined()
  })

  it('依赖任务不存在时视为未完成', () => {
    const c = createTaskInState(emptyState(), { title: 'a', blockedBy: ['t99'] })
    expect(claimInState(c.state, 't1', 'yak').error).toContain('依赖')
  })
})

describe('SharedBoardStore 持久化生命周期', () => {
  let filepath: string
  let board: SharedBoardStore

  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-board-'))
    filepath = path.join(dir, 'shared-board.json')
    board = new SharedBoardStore(filepath)
  })

  it('创建 → 认领 → 开始 → 完成', async () => {
    const t = await board.createTask({ title: '调研 X', kind: 'research', createdBy: 'lumina' })
    expect(t.id).toBe('t1')
    const claimed = await board.claim('t1', 'tmp_research_1')
    expect(claimed.owner).toBe('tmp_research_1')
    await board.start('t1', 'tmp_research_1')
    const done = await board.complete('t1', 'tmp_research_1', '结论：...')
    expect(done.status).toBe('done')
    expect(done.result).toBe('结论：...')
    expect(board.snapshot().counts.done).toBe(1)
  })

  it('重复认领抛错', async () => {
    await board.createTask({ title: 'a' })
    await board.claim('t1', 'yak')
    await expect(board.claim('t1', 'recha')).rejects.toThrow(/yak/)
  })

  it('非 owner 不能改任务', async () => {
    await board.createTask({ title: 'a' })
    await board.claim('t1', 'yak')
    await expect(board.start('t1', 'recha')).rejects.toThrow(/无权/)
  })

  it('claimNext 按优先级/创建时间挑选，并尊重 kinds 过滤', async () => {
    await board.createTask({ title: '低优先', kind: 'code', priority: 0 })
    await board.createTask({ title: '高优先', kind: 'research', priority: 5 })
    await board.createTask({ title: '普通', kind: 'research', priority: 0 })
    const t1 = await board.claimNext('tmp1')
    expect(t1?.title).toBe('高优先')
    const t2 = await board.claimNext('tmp2', { kinds: ['code'] })
    expect(t2?.title).toBe('低优先')
    const t3 = await board.claimNext('tmp3')
    expect(t3?.title).toBe('普通')
    expect(await board.claimNext('tmp4')).toBeNull()
  })

  it('依赖未完成的任务不被 claimNext 选中', async () => {
    const parent = await board.createTask({ title: '父' })
    await board.createTask({ title: '子', blockedBy: [parent.id] })
    const picked = await board.claimNext('tmp1')
    expect(picked?.title).toBe('父')
    expect(await board.claimNext('tmp2')).toBeNull()
  })

  it('block/fail/release 泳道正确', async () => {
    await board.createTask({ title: 'a' })
    await board.claim('t1', 'yak')
    await board.block('t1', 'yak', '缺资料')
    expect(board.snapshot().counts.blocked).toBe(1)
    await board.release('t1', 'yak')
    expect(board.snapshot().counts.pending).toBe(1)
    await board.claim('t1', 'recha')
    await board.fail('t1', 'recha', '崩了')
    expect(board.snapshot().counts.failed).toBe(1)
  })

  it('心跳超时的任务被 claimNext 回收', async () => {
    await board.createTask({ title: 'a' })
    await board.claim('t1', 'dead-worker')
    // 手动把心跳改成 11 分钟前
    const raw = JSON.parse(fs.readFileSync(filepath, 'utf-8'))
    raw.tasks[0].heartbeatAt = Date.now() - 11 * 60 * 1000
    fs.writeFileSync(filepath, JSON.stringify(raw), 'utf-8')
    const fresh = new SharedBoardStore(filepath)
    const picked = await fresh.claimNext('new-worker')
    expect(picked?.title).toBe('a')
    expect(picked?.owner).toBe('new-worker')
  })

  it('重启后任务板仍在', async () => {
    await board.createTask({ title: '持久化' })
    const reopened = new SharedBoardStore(filepath)
    expect(reopened.list()).toHaveLength(1)
    expect(reopened.list()[0].title).toBe('持久化')
  })
})
