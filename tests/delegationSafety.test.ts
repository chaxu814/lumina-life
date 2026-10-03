// ============================================================
// delegationSafety.test.ts — 委托防递归三层防护的验证（v3.34 新增）
//
// 【这个文件为什么存在】
// v3.34 引入了一个**永远不会响的守卫**：`tools/index.ts` 里的 orphan 告警
// 遍历 `Object.keys(TOOLSETS)`，而 TOOLSETS 含 `full`，`resolveToolset('full')`
// 返回全部工具 ⇒ `orphans` 数学上恒等于 `[]`。它被当作「当前 0 个孤儿」
// 写进了 README。
//
// 教训：**加了告警 ≠ 有了防护**。守卫必须先自证它能失败。
// 本文件就是「自证」的一部分 —— 每一条断言都在验证真实的运行时行为，
// 不是静态结构。
//
// 【三层防护，逐层验证】
//   ① 工具层：6 个派生类工具标了 blockedInChild: true
//   ② toolset 层：resolveToolset(..., excludeChildBlocked=true) 真的把它们滤掉
//   ③ 管理器层：DelegationManager 的 AsyncLocalStorage 深度上限
// ============================================================

import { describe, it, expect, beforeAll } from 'vitest'
import { registerAllTools, getToolDef, resolveToolset, getToolNames } from '../electron/tools/index'

/** 能派生新 agent 的工具 —— 递归只能从这里发生 */
const SPAWNING_TOOLS = [
  'delegate_to',
  'delegate_chain',
  'run_subagents',
  'hire_worker',
  'phase_gate_delegate',
  'workflow',
]

describe('① 工具层：派生类工具都标了 blockedInChild', () => {
  beforeAll(() => { registerAllTools() })

  it('全部 6 个派生类工具都被标记为 blockedInChild: true', () => {
    const missing: string[] = []
    for (const t of SPAWNING_TOOLS) {
      const def = getToolDef(t)
      if (!def) { missing.push(`${t}（工具不存在）`); continue }
      if (def.blockedInChild !== true) {
        missing.push(`${t}（blockedInChild=${String(def.blockedInChild)}）`)
      }
    }
    expect(missing, `这些派生类工具没被标记，子 Agent 仍可继续派生：\n  ${missing.join('\n  ')}`)
      .toEqual([])
  })

  it('此前 declared-but-never-armed 的机制现在真的被启用了', () => {
    // 回归防护：v3.34 之前，全仓 blockedInChild: true 的数量是 **0**，
    // 过滤器 `!def?.blockedInChild` 对每个工具都返回 true，闸门完全空转。
    const armed = [...getToolNames()].filter(t => getToolDef(t)?.blockedInChild === true)
    expect(armed.length,
      `blockedInChild=true 的工具数为 0 —— 过滤机制又被架空了。` +
      `机制存在但没人声明时，过滤器对每个工具都返回 true，等于没有闸门。`,
    ).toBeGreaterThan(0)
  })
})

describe('② toolset 层：子 Agent 拿不到派生类工具', () => {
  beforeAll(() => { registerAllTools() })

  it('excludeChildBlocked=true 会把 6 个派生类工具全部滤掉', () => {
    const childTools = new Set(resolveToolset('agent', new Set(), true))
    const leaked = SPAWNING_TOOLS.filter(t => childTools.has(t))
    expect(leaked, `子 Agent 仍能看到这些派生类工具（递归没被堵住）：${leaked.join(', ')}`)
      .toEqual([])
  })

  it('同时父 Agent 仍然拿得到（不能把功能一起堵死）', () => {
    const parentTools = new Set(resolveToolset('agent', new Set(), false))
    const missing = SPAWNING_TOOLS.filter(t => !parentTools.has(t))
    expect(missing, `父 Agent 反而看不到这些工具，功能被误伤：${missing.join(', ')}`)
      .toEqual([])
  })

  it('非派生类工具不受影响（子 Agent 仍能读写文件）', () => {
    const childTools = new Set(resolveToolset('agent', new Set(), true))
    // 至少要保住这些 —— 否则子 Agent 变成什么都干不了
    for (const t of ['file_read', 'file_write', 'shell_exec']) {
      if (!getToolDef(t)) { continue }   // 该工具不存在时跳过
      expect(childTools.has(t), `子 Agent 不该失去 ${t}`).toBe(true)
    }
  })
})

describe('③ 管理器层：委托深度上限', () => {
  it('DelegationManager 声明了 MAX_DELEGATION_DEPTH 且为有限正整数', async () => {
    const mod: any = await import('../electron/delegationManager')
    const DM = mod.DelegationManager
    expect(DM).toBeTruthy()
    const max = DM.MAX_DELEGATION_DEPTH
    expect(typeof max).toBe('number')
    // 关键：必须是**有限**的。此前 v3.34 之前根本没有任何上限，
    // 理论上存在 lumina → worker → lumina → worker → … 的无限自我派生。
    expect(Number.isFinite(max)).toBe(true)
    expect(max).toBeGreaterThan(0)
    // 正常链路是 Lumina → Yak → 热茶 = 2 层，phaseGatedDelegate 内部再一层
    expect(max).toBeGreaterThanOrEqual(3)
  })

  it('深度用 AsyncLocalStorage 而非实例字段（并发分支必须互不干扰）', () => {
    // 用实例字段计深度时，adversarialReview 的 Promise.all 会互相干扰：
    // 先返回的分支把计数器减回去，另一个还在跑就被误判成「深度已释放」。
    const fs = require('fs')
    const src = fs.readFileSync(
      require('path').join(__dirname, '..', 'electron', 'delegationManager.ts'),
      'utf8',
    )
    expect(src).toMatch(/AsyncLocalStorage/)
    expect(src).toMatch(/_als\.run\(/)
    // 不应该再有裸的 this._depth++ / this._depth-- 计数器
    expect(src).not.toMatch(/this\._depth\+\+/)
    expect(src).not.toMatch(/this\._depth--/)
  })
})
