// ============================================================
// tests/runSubagents.test.ts — 缺口2: run_subagents 入口工具
//   - owner 解析（ownerOfPersona / ALS）
//   - 并行执行
//   - 池满优雅降级（hire→null → skipped，不崩）
//   - try/finally：即使 delegate 抛错，也 fire 全部 intern（不残留）
// ============================================================

import { describe, it, expect } from 'vitest'
import {
  executeParallelSubagents,
  taskTypeForOwner,
  type SubagentRunDeps,
  type ParallelSubtask,
} from '../electron/tools/impl/runSubagents'
import { ownerOfPersona, enterAgentContext, getCurrentOwner } from '../electron/tools/agentRunContext'
import type { Intern } from '../electron/orchestration/internPool'

function makeIntern(id: string): Intern {
  return {
    id, name: id, status: 'idle', currentTask: null, currentSubTaskId: null,
    result: null, error: null, createdAt: '', completedAt: null, taskCount: 0,
    owner: 'yak',
  } as Intern
}

/** 记录所有动作的 mock deps */
function makeDeps(opts: {
  poolEmpty?: boolean
  delegateThrows?: boolean
  delegateFail?: boolean
}) {
  const fired: string[] = []
  const completed: string[] = []
  const failed: string[] = []
  let counter = 0

  const deps: SubagentRunDeps = {
    hire: () => {
      if (opts.poolEmpty) {return null}
      counter++
      return makeIntern(`intern_yak_小${counter}`)
    },
    assign: () => true,
    complete: (id) => completed.push(id),
    fail: (id) => failed.push(id),
    fire: (id) => { fired.push(id); return true },
    delegate: async (_owner, internId, _task) => {
      if (opts.delegateThrows) {throw new Error('boom')}
      if (opts.delegateFail) {return { success: false, error: '模拟失败' }}
      return { success: true, content: `${internId} 干完了` }
    },
  }
  return { deps, fired, completed, failed }
}

const subs: ParallelSubtask[] = [
  { title: '写模块A', description: '实现 A' },
  { title: '写模块B', description: '实现 B' },
  { title: '写模块C', description: '实现 C' },
]

describe('owner 解析', () => {
  it('ownerOfPersona: intern_<owner>_<name> → owner', () => {
    expect(ownerOfPersona('intern_yak_小陈')).toBe('yak')
    expect(ownerOfPersona('intern_recha_小李')).toBe('recha')
    expect(ownerOfPersona('intern_lumina_小王')).toBe('lumina')
  })
  it('ownerOfPersona: 裸角色直接归一', () => {
    expect(ownerOfPersona('yak')).toBe('yak')
    expect(ownerOfPersona('recha')).toBe('recha')
    expect(ownerOfPersona('')).toBe('lumina')
    expect(ownerOfPersona(undefined)).toBe('lumina')
  })
  it('ALS: enterAgentContext 后 getCurrentOwner 读到正确 owner', async () => {
    enterAgentContext('intern_recha_小李')
    expect(getCurrentOwner()).toBe('recha')
  })
  it('taskTypeForOwner: 热茶派生→审查类，Yak/Lumina→编码类', () => {
    expect(taskTypeForOwner('recha')).toBe('code_review')
    expect(taskTypeForOwner('yak')).toBe('code_write')
    expect(taskTypeForOwner('lumina')).toBe('code_write')
  })
})

describe('executeParallelSubagents', () => {
  it('并行执行全部成功：complete 全部 intern，最后全部 fire（用完即走）', async () => {
    const { deps, fired, completed, failed } = makeDeps({})
    const r = await executeParallelSubagents('yak', subs, undefined, deps)
    expect(r.ok).toBe(true)
    expect(r.outcomes.filter(o => o.status === 'done').length).toBe(3)
    expect(completed.length).toBe(3)
    expect(failed.length).toBe(0)
    // finally 保证 fire 全部已招 intern
    expect(fired.length).toBe(3)
    expect(r.hiredCount).toBe(3)
  })

  it('池满优雅降级：hire→null 的子任务标 skipped，不崩', async () => {
    // 第一、二个能招到，第三个池满
    let n = 0
    const fired: string[] = []
    const deps: SubagentRunDeps = {
      hire: () => { n++; return n <= 2 ? makeIntern(`intern_yak_小${n}`) : null },
      assign: () => true,
      complete: () => {},
      fail: () => {},
      fire: (id) => { fired.push(id); return true },
      delegate: async () => ({ success: true, content: 'ok' }),
    }
    const r = await executeParallelSubagents('yak', subs, undefined, deps)
    expect(r.outcomes.filter(o => o.status === 'skipped').length).toBe(1)
    expect(r.outcomes.filter(o => o.status === 'done').length).toBe(2)
    expect(fired.length).toBe(2) // 只 fire 实际招到的
  })

  it('delegate 返回失败：fail 记录 intern，但 finally 仍 fire（不残留）', async () => {
    const { deps, fired, completed, failed } = makeDeps({ delegateFail: true })
    const r = await executeParallelSubagents('recha', subs, undefined, deps)
    expect(r.ok).toBe(false)
    expect(completed.length).toBe(0)
    expect(failed.length).toBe(3)
    expect(fired.length).toBe(3) // 失败也必须释放
  })

  it('delegate 抛异常：try/finally 保证 fire 所有已招 intern（不残留）', async () => {
    const { deps, fired, failed } = makeDeps({ delegateThrows: true })
    const r = await executeParallelSubagents('lumina', subs, undefined, deps)
    expect(r.outcomes.every(o => o.status === 'error')).toBe(true)
    expect(failed.length).toBe(3)
    expect(fired.length).toBe(3) // 关键：异常路径也全部 fire
  })

  it('owner 透传给 deps.delegate', async () => {
    const owners: string[] = []
    const deps: SubagentRunDeps = {
      hire: () => makeIntern('intern_yak_x'),
      assign: () => true,
      complete: () => {},
      fail: () => {},
      fire: () => true,
      delegate: async (owner) => { owners.push(owner); return { success: true, content: 'x' } },
    }
    await executeParallelSubagents('recha', subs.slice(0, 1), undefined, deps)
    expect(owners[0]).toBe('recha')
  })
})
