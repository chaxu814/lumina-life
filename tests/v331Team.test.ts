// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/v331Team.test.ts — v3.31 收口：Teach 滚轮/打字（kd/ku 双沿）、
// workflow when 条件 + retry 有界重试。
// ============================================================

import { describe, it, expect, vi } from 'vitest'
import * as os from 'os'

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }))

import { eventsToActions } from '../electron/team/teachRecorder'
import {
  validateWorkflow, runJournal, evalCondition,
} from '../electron/team/workflowScript'

const W = 1000
const H = 500
const vk = (n: number) => String(n)
const VK = { ctrl: 0x11, alt: 0x12, shift: 0x10, h: 0x48, i: 0x49, a: 0x41, s: 0x53, one: 0x31, back: 0x08, enter: 0x0D }

// ── 1. Teach 滚轮 ────────────────────────────────────────
describe('v3.31 teach 滚轮录制', () => {
  it('相邻 wheel 合并为一个 scroll，正=向上', () => {
    const acts = eventsToActions([
      { t: 0, k: 'wheel', d: 120, x: 500, y: 250 },
      { t: 100, k: 'wheel', d: 120, x: 500, y: 250 },
      { t: 200, k: 'wheel', d: 120, x: 500, y: 250 },
    ], W, H)
    expect(acts).toEqual([{ action_type: 'scroll', nx: 50, ny: 50, scroll_amount: 3 }])
  })
  it('向下为负；间隔 >260ms 切段；总量夹紧 ±20', () => {
    const acts = eventsToActions([
      { t: 0, k: 'wheel', d: -120, x: 100, y: 100 },
      { t: 100, k: 'wheel', d: -120, x: 100, y: 100 },
      { t: 500, k: 'wheel', d: 120, x: 0, y: 0 },
      ...Array.from({ length: 25 }, (_, i) => ({ t: 900 + i * 10, k: 'wheel' as const, d: 120, x: 200, y: 200 })),
    ], W, H)
    expect(acts[0]).toMatchObject({ action_type: 'scroll', scroll_amount: -2 })
    expect(acts[1]).toMatchObject({ action_type: 'scroll', scroll_amount: 1 })
    expect(acts[2]).toMatchObject({ action_type: 'scroll', scroll_amount: 20 })
    expect(acts).toHaveLength(3)
  })
})

// ── 2. Teach 打字（kd/ku 双沿） ──────────────────────────
describe('v3.31 teach 打字聚合', () => {
  it('aggregateTyping：连续字母聚合成一个 type；坐标无关', () => {
    const acts = eventsToActions([
      { t: 0, k: 'kd', b: vk(VK.h) }, { t: 10, k: 'ku', b: vk(VK.h) },
      { t: 30, k: 'kd', b: vk(VK.i) }, { t: 40, k: 'ku', b: vk(VK.i) },
    ], W, H, { aggregateTyping: true })
    expect(acts).toEqual([{ action_type: 'type', text: 'hi' }])
  })
  it('backspace 删除缓冲末字；shift 符号面（!）入文本', () => {
    const acts = eventsToActions([
      { t: 0, k: 'kd', b: vk(VK.h) }, { t: 10, k: 'ku', b: vk(VK.h) },
      { t: 20, k: 'kd', b: vk(VK.i) }, { t: 30, k: 'ku', b: vk(VK.i) },
      { t: 40, k: 'kd', b: vk(VK.back) }, { t: 50, k: 'ku', b: vk(VK.back) },
      { t: 60, k: 'kd', b: vk(VK.shift) },
      { t: 70, k: 'kd', b: vk(VK.one) }, { t: 80, k: 'ku', b: vk(VK.one) },
      { t: 90, k: 'ku', b: vk(VK.shift) },
    ], W, H, { aggregateTyping: true })
    expect(acts).toEqual([{ action_type: 'type', text: 'h!' }])
  })
  it('默认不聚合：逐键 keypress；修饰键 key-up 后不污染后续字母', () => {
    const acts = eventsToActions([
      { t: 0, k: 'kd', b: vk(VK.ctrl) },
      { t: 10, k: 'kd', b: vk(VK.s) }, { t: 20, k: 'ku', b: vk(VK.s) },
      { t: 30, k: 'ku', b: vk(VK.ctrl) },
      { t: 40, k: 'kd', b: vk(VK.a) }, { t: 50, k: 'ku', b: vk(VK.a) },
    ], W, H)
    expect(acts).toEqual([
      { action_type: 'keypress', key: 'ctrl+s' },
      { action_type: 'keypress', key: 'a' },
    ])
  })
  it('非打印键（enter）切断打字段', () => {
    const acts = eventsToActions([
      { t: 0, k: 'kd', b: vk(VK.h) }, { t: 10, k: 'ku', b: vk(VK.h) },
      { t: 20, k: 'kd', b: vk(VK.enter) }, { t: 30, k: 'ku', b: vk(VK.enter) },
      { t: 40, k: 'kd', b: vk(VK.i) }, { t: 50, k: 'ku', b: vk(VK.i) },
    ], W, H, { aggregateTyping: true })
    expect(acts).toEqual([
      { action_type: 'type', text: 'h' },
      { action_type: 'keypress', key: 'enter' },
      { action_type: 'type', text: 'i' },
    ])
  })
})

// ── 3. workflow when 条件 ────────────────────────────────
function journalOf(def: any) {
  const now = Date.now()
  const steps: Record<string, any> = {}
  for (const s of def.steps) {steps[s.id] = { id: s.id, status: 'pending' }}
  return {
    id: `wf_test_${Math.random().toString(36).slice(2)}`, name: def.name,
    mode: def.mode || 'pipeline', concurrency: def.concurrency || 4,
    status: 'ready' as const, def, steps, createdAt: now, updatedAt: now,
  }
}

describe('v3.31 workflow when 条件', () => {
  it('evalCondition 三种判定 + not 取反', () => {
    expect(evalCondition('任务成功完成', { step: 'a', op: 'contains', value: '成功' })).toBe(true)
    expect(evalCondition('ok', { step: 'a', op: 'equals', value: 'ok' })).toBe(true)
    expect(evalCondition('ok', { step: 'a', op: 'equals', value: 'OK' })).toBe(false)
    expect(evalCondition('false', { step: 'a', op: 'truthy' })).toBe(false)
    expect(evalCondition('有结论', { step: 'a', op: 'truthy' })).toBe(true)
    expect(evalCondition('未找到', { step: 'a', op: 'contains', value: '未找到', not: true })).toBe(false)
  })

  it('when 不满足 → 本步与下游 skipped；when.step 是隐式依赖（无需 after）', async () => {
    const def = validateWorkflow({
      name: 'w',
      steps: [
        { id: 'a', task: '检索' },
        { id: 'b', task: '只在找到证据时做', when: { step: 'a', op: 'contains', value: '成功' } },
        { id: 'c', task: '依赖 b', after: ['b'] },
      ],
    }).def!
    const j = await runJournal(journalOf(def), async step =>
      step.id === 'a' ? { result: '未找到相关内容' } : { result: '不该执行' })
    expect(j.steps.a.status).toBe('done')
    expect(j.steps.b.status).toBe('skipped')
    expect(j.steps.c.status).toBe('skipped')
    expect(j.status).toBe('done')
  })

  it('when 满足 → 正常执行；not 可反向', async () => {
    const def = validateWorkflow({
      name: 'w',
      steps: [
        { id: 'a', task: '检查' },
        { id: 'b', task: '没成功时补救', when: { step: 'a', op: 'contains', value: '成功', not: true } },
      ],
    }).def!
    const j = await runJournal(journalOf(def), async () => ({ result: '未找到' }))
    expect(j.steps.b.status).toBe('done')
  })
})

// ── 4. workflow retry 有界重试 ───────────────────────────
describe('v3.31 workflow retry', () => {
  it('异常重试：第 3 次成功，attempts=3', async () => {
    const def = validateWorkflow({
      name: 'w',
      steps: [{ id: 'a', task: '不稳的接口', retry: { maxAttempts: 3, delayMs: 1 } }],
    }).def!
    let n = 0
    const j = await runJournal(journalOf(def), async () => {
      n++
      if (n < 3) {throw new Error('超时')}
      return { result: 'ok' }
    })
    expect(j.steps.a.status).toBe('done')
    expect(j.steps.a.attempts).toBe(3)
  })

  it('until contains：结果达标才停，记录尝试次数', async () => {
    const def = validateWorkflow({
      name: 'w',
      steps: [{
        id: 'a', task: '轮询状态',
        retry: { maxAttempts: 4, until: { op: 'contains', value: '完成' }, delayMs: 1 },
      }],
    }).def!
    const replies = ['处理中', '处理中', '已完成']
    let n = 0
    const j = await runJournal(journalOf(def), async () => ({ result: replies[n++] || '处理中' }))
    expect(j.steps.a.status).toBe('done')
    expect(j.steps.a.attempts).toBe(3)
    expect(j.steps.a.result).toContain('完成')
  })

  it('重试耗尽仍不达标 → failed', async () => {
    const def = validateWorkflow({
      name: 'w',
      steps: [{
        id: 'a', task: '轮询',
        retry: { maxAttempts: 2, until: { op: 'contains', value: '完成' }, delayMs: 1 },
      }],
    }).def!
    const j = await runJournal(journalOf(def), async () => ({ result: '排队中' }))
    expect(j.steps.a.status).toBe('failed')
    expect(j.steps.a.attempts).toBe(2)
    expect(j.steps.a.error).toContain('until')
  })

  it('校验：maxAttempts 上限 5；when.op / until 非法报错', () => {
    expect(validateWorkflow({
      name: 'w', steps: [{ id: 'a', task: 'x', retry: { maxAttempts: 6 } }],
    }).ok).toBe(false)
    expect(validateWorkflow({
      name: 'w', steps: [{ id: 'a', task: 'x', when: { step: 'a', op: 'bogus' } }],
    }).ok).toBe(false)
    expect(validateWorkflow({
      name: 'w', steps: [{ id: 'a', task: 'x', retry: { until: { op: 'regex', value: 'x' } } }],
    }).ok).toBe(false)
  })
})
