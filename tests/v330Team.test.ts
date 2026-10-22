// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/v330Team.test.ts — v3.30 团队系统纯逻辑
// 覆盖：plan_approval、workflowScript DSL/调度/续跑、teach 转换、
//       agentMarkdown 解析、modelTier 成本分级、cuUia 元素树解析。
// ============================================================

import { describe, it, expect, vi } from 'vitest'
import * as os from 'os'

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }))

import {
  createTaskInState, claimInState, approveInState, rejectInState,
} from '../electron/team/teamSharedBoard'
import {
  validateWorkflow, runJournal, substituteReferences,
} from '../electron/team/workflowScript'
import { eventsToActions } from '../electron/team/teachRecorder'
import { parseAgentMarkdown, serializeAgentMarkdown } from '../electron/team/agentMarkdown'
import { tierForRole, resolveWorkerModel } from '../electron/team/modelTier'
import { parseUiaJson, normalizeElements } from '../electron/tools/impl/cuUia'

function emptyState() {
  return { tasks: [], seq: 0, history: [] }
}

// ── 1. plan_approval ─────────────────────────────────────
describe('plan_approval 人工批准', () => {
  it('requireApproval 任务进 pending_approval 且不能被认领', () => {
    const r = createTaskInState(emptyState(), { title: '危险操作', requireApproval: true }, 1000)
    expect(r.task.status).toBe('pending_approval')
    const claim = claimInState(r.state, 't1', 'tmp_code', 1001)
    expect(claim.error).toContain('批准')
  })
  it('批准后变 pending，可认领；驳回变 failed', () => {
    const created = createTaskInState(emptyState(), { title: 'x', requireApproval: true }, 1)
    const approved = approveInState(created.state, 't1', 'lumina', 2)
    expect(approved.task?.status).toBe('pending')
    expect(approved.state.history.map(e => e.to)).toContain('pending')
    const claim = claimInState(approved.state, 't1', 'tmp_code', 3)
    expect(claim.task?.status).toBe('claimed')

    const c2 = createTaskInState(emptyState(), { title: 'y', requireApproval: true }, 4)
    const rejected = rejectInState(c2.state, 't1', 'lumina', 5)
    expect(rejected.task?.status).toBe('failed')
  })
  it('非 pending_approval 状态不能重复批准', () => {
    const created = createTaskInState(emptyState(), { title: 'x' }, 1)
    expect(approveInState(created.state, 't1', 'lumina').error).toContain('待批准')
  })
})

// ── 2. workflowScript ────────────────────────────────────
describe('workflowScript 校验', () => {
  it('合法 pipeline 通过', () => {
    const v = validateWorkflow({
      name: 'w', mode: 'pipeline',
      steps: [
        { id: 'a', role: 'research', task: '查' },
        { id: 'b', role: 'code', task: '基于 $a.result 写', after: ['a'] },
      ],
    })
    expect(v.ok).toBe(true)
    expect(v.def?.concurrency).toBe(4)
  })
  it('缺依赖/成环/重复 id 报错', () => {
    const missing = validateWorkflow({ name: 'w', steps: [{ id: 'a', task: 'x', after: ['nope'] }] })
    expect(missing.ok).toBe(false)
    expect(missing.errors.join()).toContain('不存在')
    const cycle = validateWorkflow({
      name: 'w',
      steps: [
        { id: 'a', task: 'x', after: ['b'] },
        { id: 'b', task: 'y', after: ['a'] },
      ],
    })
    expect(cycle.ok).toBe(false)
    expect(cycle.errors.join()).toContain('环')
    const dup = validateWorkflow({ name: 'w', steps: [{ id: 'a', task: 'x' }, { id: 'a', task: 'y' }] })
    expect(dup.ok).toBe(false)
    expect(dup.errors.join()).toContain('重复')
  })
})

describe('workflowScript 调度', () => {
  const def = validateWorkflow({
    name: 'w', mode: 'pipeline',
    steps: [
      { id: 'a', task: '先做' },
      { id: 'b', task: '基于 $a.result', after: ['a'] },
      { id: 'c', task: '合并 $a.result $b.result', after: ['b'] },
    ],
  }).def!

  const newJournal = () => {
    const now = Date.now()
    const steps: Record<string, any> = {}
    for (const s of def.steps) {steps[s.id] = { id: s.id, status: 'pending' }}
    return { id: 'wf_test', name: def.name, mode: 'pipeline', concurrency: 4, status: 'ready' as const, def, steps, createdAt: now, updatedAt: now }
  }

  it('pipeline 严格分层、$id.result 替换、全部 done', async () => {
    const order: string[] = []
    const j = await runJournal(newJournal(), async (step, prepared) => {
      order.push(step.id)
      return { result: `R${step.id.toUpperCase()}(${prepared})` }
    })
    expect(order).toEqual(['a', 'b', 'c'])
    expect(j.status).toBe('done')
    expect(j.steps.b.result).toContain('RA')
    expect(j.steps.c.result).toContain('RA').toContain('RB')
  })

  it('某步失败 → 下游 skipped、状态 failed', async () => {
    const j = await runJournal(newJournal(), async (step) => {
      if (step.id === 'b') {throw new Error('boom')}
      return { result: 'ok' }
    })
    expect(j.status).toBe('failed')
    expect(j.steps.b.status).toBe('failed')
    expect(j.steps.c.status).toBe('skipped')
  })

  it('续跑：已 done 的步骤跳过，不重复执行', async () => {
    const j = newJournal()
    j.steps.a = { id: 'a', status: 'done', result: '缓存结果' }
    const order: string[] = []
    await runJournal(j, async (step, prepared) => {
      order.push(step.id)
      return { result: `R${step.id}(${prepared})` }
    })
    expect(order).toEqual(['b', 'c'])
    expect(j.steps.b.result).toContain('缓存结果')
  })

  it('parallel 模式同层并发、受 concurrency 限制', async () => {
    const d = validateWorkflow({
      name: 'p', mode: 'parallel', concurrency: 2,
      steps: [
        { id: 'a', task: '1' }, { id: 'b', task: '2' }, { id: 'c', task: '3' },
        { id: 'd', task: '汇总', after: ['a', 'b', 'c'] },
      ],
    }).def!
    const now = Date.now()
    const steps: Record<string, any> = {}
    for (const s of d.steps) {steps[s.id] = { id: s.id, status: 'pending' }}
    let inflight = 0
    let maxInflight = 0
    await runJournal({
      id: 'wf_p', name: 'p', mode: 'parallel', concurrency: 2, status: 'ready', def: d, steps,
      createdAt: now, updatedAt: now,
    }, async (step) => {
      inflight++
      maxInflight = Math.max(maxInflight, inflight)
      await new Promise(r => setTimeout(r, 20))
      inflight--
      return { result: step.id }
    })
    expect(maxInflight).toBeLessThanOrEqual(2)
    expect(steps.d.status).toBe('done')
  })

  it('substituteReferences 未完成引用原样保留', () => {
    expect(substituteReferences('$a.result', { a: { id: 'a', status: 'pending' } })).toBe('$a.result')
  })
})

// ── 3. Teach 事件转换 ────────────────────────────────────
describe('teach eventsToActions', () => {
  const W = 1000
  const H = 500
  it('原地左键 md/mu → click；右键 → right_click；坐标归一化 0–100', () => {
    const acts = eventsToActions([
      { t: 0, k: 'md', b: 'L', x: 500, y: 250 },
      { t: 100, k: 'mu', b: 'L', x: 502, y: 251 },
    ], W, H)
    expect(acts[0]).toMatchObject({ action_type: 'click', nx: 50, ny: 50 })
    const r = eventsToActions([
      { t: 0, k: 'md', b: 'R', x: 100, y: 100 },
      { t: 100, k: 'mu', b: 'R', x: 100, y: 100 },
    ], W, H)
    expect(r[0].action_type).toBe('right_click')
  })
  it('位移 ≥6px → drag', () => {
    const acts = eventsToActions([
      { t: 0, k: 'md', b: 'L', x: 0, y: 0 },
      { t: 500, k: 'mu', b: 'L', x: 100, y: 200 },
    ], W, H)
    expect(acts[0]).toMatchObject({ action_type: 'drag', nx: 0, ny: 0, nx2: 10, ny2: 40 })
  })
  it('修饰键 + 普通键 → 组合键；F8 不产出；单独修饰键不产出', () => {
    const acts = eventsToActions([
      { t: 0, k: 'key', b: String(0x11) }, // ctrl
      { t: 10, k: 'key', b: String(0x53) }, // S
      { t: 20, k: 'key', b: String(0x77) }, // F8
      { t: 30, k: 'key', b: String(0x12) }, // alt 单独
    ], W, H)
    expect(acts).toEqual([{ action_type: 'keypress', key: 'ctrl+s' }])
  })
})

// ── 4. Agent Markdown ────────────────────────────────────
describe('agentMarkdown 热加载', () => {
  const md = `---
id: data-helper
name: 数据帮手
icon: 📊
model_tier: small
capabilities: [Excel, 清洗]
blocked: []
blind_spots: 不懂法务
description: 数据处理
---
你是一个数据处理助手。
`
  it('解析 frontmatter + 正文', () => {
    const a = parseAgentMarkdown(md, 'test.md')!
    expect(a.id).toBe('data-helper')
    expect(a.modelTier).toBe('small')
    expect(a.capabilities).toEqual(['Excel', '清洗'])
    expect(a.blindSpots).toEqual(['不懂法务'])
    expect(a.prompt).toContain('数据处理助手')
  })
  it('无 id / 无 frontmatter 返回 null；序列化可往返', () => {
    expect(parseAgentMarkdown('hello', 'x')).toBeNull()
    expect(parseAgentMarkdown('---\nname: 没 id\n---\nbody', 'x')).toBeNull()
    const a = parseAgentMarkdown(md, 'x')!
    const again = parseAgentMarkdown(serializeAgentMarkdown(a), 'x')!
    expect(again.id).toBe('data-helper')
    expect(again.modelTier).toBe('small')
    expect(again.prompt).toContain('数据处理助手')
  })
})

// ── 5. modelTier ─────────────────────────────────────────
describe('modelTier 成本分级', () => {
  it('杂活工种 small，关键工种 strong', () => {
    expect(tierForRole('research')).toBe('small')
    expect(tierForRole('general')).toBe('small')
    expect(tierForRole('code')).toBe('strong')
    expect(tierForRole('review')).toBe('strong')
  })
  it('家族映射：gpt-4o→mini；reasoner→chat；glm→flash；qwen→turbo；本地不换', () => {
    expect(resolveWorkerModel('search', 'gpt-4o')).toBe('gpt-4o-mini')
    expect(resolveWorkerModel('search', 'deepseek-reasoner')).toBe('deepseek-chat')
    expect(resolveWorkerModel('search', 'glm-4')).toBe('glm-4-flash')
    expect(resolveWorkerModel('search', 'qwen2.5-72b')).toBe('qwen-turbo')
    expect(resolveWorkerModel('search', 'qwen2.5-7b')).toBeNull()
    expect(resolveWorkerModel('search', 'qwen2.5-7b')).toBeNull()
    expect(resolveWorkerModel('code', 'gpt-4o')).toBeNull()
    expect(resolveWorkerModel('search', 'gpt-4o-mini')).toBeNull()
    expect(resolveWorkerModel('search', 'deepseek-chat')).toBeNull()
    expect(resolveWorkerModel('search', 'http://localhost:11434/llama3')).toBeNull()
  })
  it('LUMINA_SMALL_MODEL 环境变量优先', () => {
    expect(resolveWorkerModel('search', 'gpt-4o', 'my-small')).toBe('my-small')
  })
})

// ── 6. cuUia ─────────────────────────────────────────────
describe('cuUia 元素树', () => {
  const raw = JSON.stringify([
    { n: '确定', a: 'okBtn', t: 'ControlType.Button', r: { x: 100, y: 100, w: 60, h: 30 }, e: true, f: false },
    { n: '不可见', a: '', t: 'ControlType.Text', r: { x: 0, y: 0, w: 1, h: 1 }, e: false, f: false },
    { n: '输入框', a: 'nameBox', t: 'ControlType.Edit', r: { x: 0, y: 0, w: 200, h: 40 }, e: true, f: true },
  ])
  it('parseUiaJson 过滤 <2px、去 ControlType 前缀、容错坏文本', () => {
    const els = parseUiaJson(`噪声前缀\n${raw}\n后缀`)
    expect(els).toHaveLength(2)
    expect(els[0]).toMatchObject({ index: 0, name: '确定', type: 'Button' })
    expect(parseUiaJson('not json')).toEqual([])
  })
  it('normalizeElements 中心归一化为 0–100（与 cuGeometry 一致）', () => {
    const els = parseUiaJson(raw)
    const norm = normalizeElements(els, 1000, 500)
    // 确定按钮中心 (130,115) → (13, 23)
    expect(norm[0].nx).toBeCloseTo(13, 1)
    expect(norm[0].ny).toBeCloseTo(23, 1)
  })
})
