// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/subagentPool.test.ts — 通用子智能体池（InternPool v3.0）单测
//
// 覆盖：
// - 多 owner（lumina/yak/recha）各自独立成池，互不串扰
// - 并行派生：一个池内可同时 busy 多个子智能体
// - 状态流转：hire(idle) → assign(busy) → complete(done)/fail(failed) → fire
// - 用完即走：fire/dismissAll 后从池中移除，不保留跨任务上下文
// - 权限边界：子智能体严格继承 owner 的 rolePolicy（热茶=只读，Yak=可写可跑）
// - 生命周期事件：assign/done/error/fire 都派发标准化事件
// ============================================================
import { describe, it, expect, beforeEach } from 'vitest'
import {
  InternPool,
  getInternPool,
  _resetInternPoolsForTest,
  type SubagentLifecycleEvent,
} from '../electron/orchestration/internPool'

describe('InternPool — 多 owner 独立成池', () => {
  beforeEach(() => _resetInternPoolsForTest())

  it('lumina / yak / recha 各自拿到互不相同的池', () => {
    const yak = getInternPool('yak')
    const recha = getInternPool('recha')
    const lumina = getInternPool('lumina')
    expect(yak).not.toBe(recha)
    expect(yak).not.toBe(lumina)
    expect(recha).not.toBe(lumina)
    expect(yak.owner).toBe('yak')
    expect(recha.owner).toBe('recha')
    expect(lumina.owner).toBe('lumina')
  })

  it('不传 owner 默认 yak（向后兼容旧单例调用）', () => {
    expect(getInternPool().owner).toBe('yak')
    expect(getInternPool()).toBe(getInternPool('yak'))
  })

  it('不同 owner 并行招人互不串扰，ID 带 owner 前缀', () => {
    const yakPool = new InternPool({ owner: 'yak', autoRegister: false, maxSize: 2 })
    const rechaPool = new InternPool({ owner: 'recha', autoRegister: false, maxSize: 2 })
    const y = yakPool.hire()!
    const r = rechaPool.hire()!
    expect(y.owner).toBe('yak')
    expect(r.owner).toBe('recha')
    expect(y.id).toContain('intern_yak_')
    expect(r.id).toContain('intern_recha_')
    // 两个池各招一个，互不影响
    expect(yakPool.size).toBe(1)
    expect(rechaPool.size).toBe(1)
  })
})

describe('InternPool — 并行派生', () => {
  it('一个池内可同时 busy 多个子智能体（并行）', () => {
    const pool = new InternPool({ owner: 'yak', autoRegister: false, maxSize: 3 })
    const a = pool.hire()!
    const b = pool.hire()!
    const c = pool.hire()!
    pool.assign(a.id, '写模块A', 'sub-a')
    pool.assign(b.id, '写模块B', 'sub-b')
    pool.assign(c.id, '写模块C', 'sub-c')
    // 三者同时在跑
    expect(pool.getBusy()).toHaveLength(3)
    expect(pool.idleCount).toBe(0)
  })

  it('池满时 hire 返回 null（不超编）', () => {
    const pool = new InternPool({ owner: 'yak', autoRegister: false, maxSize: 2 })
    expect(pool.hire()).not.toBeNull()
    expect(pool.hire()).not.toBeNull()
    expect(pool.hire()).toBeNull()
  })
})

describe('InternPool — 状态流转 hire→assign→complete/fail→fire', () => {
  it('hire=idle，assign=busy，complete=done 并记录结果', () => {
    const pool = new InternPool({ owner: 'yak', autoRegister: false })
    const intern = pool.hire()!
    expect(intern.status).toBe('idle')

    expect(pool.assign(intern.id, '修 foo.ts', 'sub-1')).toBe(true)
    expect(pool.get(intern.id)!.status).toBe('busy')
    expect(pool.get(intern.id)!.currentTask).toBe('修 foo.ts')

    pool.complete(intern.id, '改完了')
    const done = pool.get(intern.id)!
    expect(done.status).toBe('done')
    expect(done.result).toBe('改完了')
    expect(done.taskCount).toBe(1)
    expect(done.completedAt).toBeTruthy()
  })

  it('assign 一个 busy 中的实习生失败（不能重复领活）', () => {
    const pool = new InternPool({ owner: 'yak', autoRegister: false })
    const intern = pool.hire()!
    pool.assign(intern.id, '活1')
    expect(pool.assign(intern.id, '活2')).toBe(false)
  })

  it('fail 标记 failed 并记录错误', () => {
    const pool = new InternPool({ owner: 'yak', autoRegister: false })
    const intern = pool.hire()!
    pool.assign(intern.id, '跑测试')
    pool.fail(intern.id, '编译失败')
    const f = pool.get(intern.id)!
    expect(f.status).toBe('failed')
    expect(f.error).toBe('编译失败')
  })
})

describe('InternPool — 用完即走', () => {
  it('fire 后从池中移除并注销', () => {
    const pool = new InternPool({ owner: 'yak', autoRegister: false })
    const intern = pool.hire()!
    expect(pool.size).toBe(1)
    expect(pool.fire(intern.id)).toBe(true)
    expect(pool.size).toBe(0)
    expect(pool.get(intern.id)).toBeUndefined()
  })

  it('fire 不存在的 ID 返回 false', () => {
    const pool = new InternPool({ owner: 'yak', autoRegister: false })
    expect(pool.fire('nope')).toBe(false)
  })

  it('dismissAll 一次性裁掉全部（收工）', () => {
    const pool = new InternPool({ owner: 'yak', autoRegister: false, maxSize: 3 })
    pool.hire(); pool.hire()
    expect(pool.size).toBe(2)
    pool.dismissAll()
    expect(pool.size).toBe(0)
  })
})

describe('InternPool — 权限边界（继承 owner 的 rolePolicy）', () => {
  it('Yak 派生的子智能体：可写文件 / 可跑命令（编码闭环）', () => {
    const pool = new InternPool({ owner: 'yak', autoRegister: false })
    expect(pool.canUseTool('file_write')).toBe(true)
    expect(pool.canUseTool('file_edit')).toBe(true)
    expect(pool.canUseTool('shell_exec')).toBe(true)
    expect(pool.canUseTool('file_read')).toBe(true)
  })

  it('热茶派生的子智能体：只读，不能写文件 / 不能跑命令', () => {
    const pool = new InternPool({ owner: 'recha', autoRegister: false })
    expect(pool.canUseTool('file_read')).toBe(true)
    expect(pool.canUseTool('file_write')).toBe(false)
    expect(pool.canUseTool('file_edit')).toBe(false)
    expect(pool.canUseTool('shell_exec')).toBe(false)
    expect(pool.canUseTool('git_commit')).toBe(false)
  })

  it('Lumina 派生的子智能体：全量放行', () => {
    const pool = new InternPool({ owner: 'lumina', autoRegister: false })
    expect(pool.canUseTool('file_write')).toBe(true)
    expect(pool.canUseTool('shell_exec')).toBe(true)
    expect(pool.canUseTool('anything_random_tool')).toBe(true)
  })
})

describe('InternPool — 生命周期事件派发', () => {
  it('assigned/done/error/fired 都派发标准化事件', () => {
    const pool = new InternPool({ owner: 'yak', autoRegister: false })
    const events: SubagentLifecycleEvent[] = []
    pool.onSubagentEvent((ev) => events.push(ev))

    const intern = pool.hire()!
    pool.assign(intern.id, '写代码', 'sub-1')
    pool.complete(intern.id, '好了')
    const intern2 = pool.hire()!
    pool.assign(intern2.id, '审查')
    pool.fail(intern2.id, '挂了')
    pool.fire(intern.id)

    const types = events.map((e) => e.type)
    expect(types).toContain('assigned')
    expect(types).toContain('done')
    expect(types).toContain('error')
    expect(types).toContain('fired')

    const doneEv = events.find((e) => e.type === 'done')!
    expect(doneEv.owner).toBe('yak')
    expect(doneEv.status).toBe('done')
    expect(doneEv.result).toBeTruthy()

    const errEv = events.find((e) => e.type === 'error')!
    expect(errEv.status).toBe('error')
    expect(errEv.error).toBeTruthy()
  })

  it('取消订阅后不再收到事件', () => {
    const pool = new InternPool({ owner: 'recha', autoRegister: false })
    let count = 0
    const off = pool.onSubagentEvent(() => count++)
    const intern = pool.hire()!
    pool.assign(intern.id, '只读分析')
    expect(count).toBeGreaterThanOrEqual(1)
    off()
    const after = count
    pool.complete(intern.id, 'ok')
    expect(count).toBe(after)
  })
})
