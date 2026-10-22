// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/v333Team.test.ts — v3.33 团队纵深：
//   绩效画像/易错档案、内驱力自领取、CU 三人组、任务追踪、
//   孤儿任务回收、团队日记、关系调度、agent.md effort/pathScope。
// 只测纯函数/状态变换，不碰文件、定时器与真实 LLM。
// ============================================================

import { describe, it, expect, vi } from 'vitest'
import * as os from 'os'

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }))

import {
  emptyStats, recordOutcomeInState, recordReviewInState, extractMistakeTags,
  successRate, rankRolesForKind, autoShutdownCard, profileHint,
} from '../electron/team/workerStats'
import { willingness, ROLE_INITIATIVE } from '../electron/team/teamAutonomy'
import {
  newCrewState, crewStep, expectsChange, actionKindOf,
} from '../electron/team/cuCrew'
import {
  startEntryInState, endEntryInState, summarizeInState,
} from '../electron/team/llmTrace'
import { reapOrphansInState } from '../electron/team/teamSharedBoard'
import { buildDigest, dayRange } from '../electron/team/teamDailyLog'
import { pickByTrust, needsDoubleReview } from '../electron/team/teamPolicy'
import { parseAgentMarkdown, serializeAgentMarkdown } from '../electron/team/agentMarkdown'

// ── 1. 绩效画像 ──────────────────────────────────────────
describe('v3.33 worker 绩效画像', () => {
  it('成功率拉普拉斯平滑：0 单不是 100%，1 单成功也不是 100%', () => {
    let s = emptyStats()
    s = recordOutcomeInState(s, 'code', { ok: true, durationMs: 1000 })
    const p = s.code
    expect(successRate(p)).toBeCloseTo(2 / 3)
    s = recordOutcomeInState(s, 'code', { ok: false, durationMs: 1000 })
    expect(s.code.success).toBe(1)
    expect(s.code.fail).toBe(1)
    expect(s.code.jobs).toBe(2)
    expect(s.code.totalDurationMs).toBe(2000)
  })

  it('易错标签确定性归类 + 未命中归「其他问题」', () => {
    expect(extractMistakeTags('空指针 undefined 没判空')).toContain('空值/边界')
    expect(extractMistakeTags('SQL 注入，token 泄露')).toContain('安全/权限')
    expect(extractMistakeTags('并发竞态 await 顺序')).toContain('并发/竞态')
    expect(extractMistakeTags('今天天气不错')).toEqual(['其他问题'])
    expect(extractMistakeTags('')).toEqual([])
  })

  it('复核问题写进易错档案；无标签不计 reviewFindings', () => {
    let s = emptyStats()
    s = recordOutcomeInState(s, 'code', { ok: true, durationMs: 100 })
    s = recordReviewInState(s, 'code', ['这里有 SQL 注入风险', '异常没有 try catch'])
    expect(s.code.mistakes['安全/权限']).toBe(1)
    expect(s.code.mistakes['错误处理']).toBe(1)
    expect(s.code.reviewFindings).toBe(1)
  })

  it('派活路由：新工种中性 0.5 不被埋没；老工种高成功率排前', () => {
    let s = emptyStats()
    for (let i = 0; i < 10; i++) {
      s = recordOutcomeInState(s, 'code', { ok: true, durationMs: 1000 })
    }
    for (let i = 0; i < 10; i++) {
      s = recordOutcomeInState(s, 'test', { ok: i < 3, durationMs: 1000 })
    }
    const ranked = rankRolesForKind(s, ['code', 'test', 'general'])
    expect(ranked[0].role).toBe('code')
    const fresh = ranked.find(r => r.role === 'general')!
    expect(fresh.fresh).toBe(true)
    expect(fresh.score).toBe(0.5)
  })

  it('散伙经验卡：确定性生成，无画像返回 null；含累计/易错点', () => {
    expect(autoShutdownCard(emptyStats(), 'code')).toBeNull()
    let s = emptyStats()
    s = recordOutcomeInState(s, 'code', { ok: true, durationMs: 2000, title: '任务A' })
    s = recordReviewInState(s, 'code', ['SQL 注入'])
    const r = autoShutdownCard(s, 'code')!
    expect(r.card.source).toBe('shutdown')
    expect(r.card.body).toContain('累计 1 单')
    expect(r.card.body).toContain('安全/权限')
  })

  it('开工提示 profileHint：有易错点才说话，新工种不啰嗦', () => {
    expect(profileHint(emptyStats(), 'code')).toBe('')
    let s = emptyStats()
    s = recordOutcomeInState(s, 'code', { ok: true, durationMs: 100 })
    s = recordReviewInState(s, 'code', ['SQL 注入'])
    const hint = profileHint(s, 'code')
    expect(hint).toContain('安全/权限')
    expect(hint).toContain('历史易错点')
  })
})

// ── 2. 内驱力自领取（纯函数） ────────────────────────────
describe('v3.33 内驱力 willingness', () => {
  it('刚 idle 时主动性低于责任心基线，闲久了趋近基线', () => {
    // rng 固定返回 0.5（抖动项 0）
    const fresh = willingness('code', 0, () => 0.5)
    const idleLong = willingness('code', 10 * 60 * 1000, () => 0.5)
    expect(fresh).toBeCloseTo(ROLE_INITIATIVE.code * 0.4)
    expect(idleLong).toBeCloseTo(ROLE_INITIATIVE.code)
    expect(idleLong).toBeGreaterThan(fresh)
  })
  it('复核员责任心基线低于工程员；结果夹紧 0~1', () => {
    expect(ROLE_INITIATIVE.review).toBeLessThan(ROLE_INITIATIVE.code)
    const w = willingness('unknown-role', 0, () => 0.99)
    expect(w).toBeGreaterThanOrEqual(0)
    expect(w).toBeLessThanOrEqual(1)
  })
})

// ── 3. CU 三人组 ─────────────────────────────────────────
describe('v3.33 CU 三人组观察员', () => {
  it('安全员拒绝一票否决，立即 abort', () => {
    const r = crewStep(newCrewState(), { actionKind: 'click', denied: true, denyReason: 'gate', ok: false })
    expect(r.verdict).toBe('abort')
    expect(r.state.deniedCount).toBe(1)
  })
  it('第一次失败 reobserve，连续 2 次 abort', () => {
    let s = newCrewState()
    let r = crewStep(s, { actionKind: 'click', ok: false, reason: '超时' })
    expect(r.verdict).toBe('reobserve')
    s = r.state
    r = crewStep(s, { actionKind: 'click', ok: false, reason: '超时' })
    expect(r.verdict).toBe('abort')
    expect(r.state.aborted).toContain('连续 2 次')
  })
  it('变更类动作连续 2 次无变化 abort；滚动/等待不要求变化', () => {
    expect(expectsChange('scroll')).toBe(false)
    expect(expectsChange('hover')).toBe(false)
    expect(expectsChange('wait')).toBe(false)
    expect(expectsChange('click')).toBe(true)
    let s = newCrewState()
    let r = crewStep(s, { actionKind: 'click', ok: true, changed: false })
    expect(r.verdict).toBe('reobserve')
    s = r.state
    // 中间一个成功且有变化的滚动不会清零无变化计数（滚动不裁决），但成功帧可清 fail
    r = crewStep(s, { actionKind: 'click', ok: true, changed: false })
    expect(r.verdict).toBe('abort')
    // 滚动无变化永远放行
    let s2 = newCrewState()
    for (let i = 0; i < 5; i++) {
      s2 = crewStep(s2, { actionKind: 'scroll', ok: true, changed: false }).state
    }
    expect(s2.aborted).toBeUndefined()
  })
  it('动作名映射', () => {
    expect(actionKindOf('left_double_click')).toBe('double_click')
    expect(actionKindOf('type_text')).toBe('type')
    expect(actionKindOf('scroll')).toBe('scroll')
    expect(actionKindOf('press_key')).toBe('keypress')
    expect(actionKindOf('whatever')).toBe('other')
  })
})

// ── 4. 任务级追踪 ────────────────────────────────────────
describe('v3.33 llmTrace', () => {
  it('start/end 配对汇总；未闭合的 start 计为 running；长任务标记', () => {
    let state = { seq: 0, entries: [] }
    let r = startEntryInState(state, { source: 'hire', role: 'code', workerId: 'w1', title: 'A', modelTier: 'strong' })
    state = r.state
    r = endEntryInState(state, { source: 'hire', role: 'code', workerId: 'w1', title: 'A' },
      { ok: true, durationMs: 130_000, modelTier: 'strong' })
    state = r.state
    r = startEntryInState(state, { source: 'autonomy', role: 'data', workerId: 'w2', title: 'B', modelTier: 'small' })
    state = r.state
    const sum = summarizeInState(state)
    expect(sum.total).toBe(1)
    expect(sum.ok).toBe(1)
    expect(sum.running).toBe(1)
    expect(sum.longRunning).toBe(1)
    expect(sum.avgDurationMs).toBe(130_000)
    expect(sum.byRole.code).toEqual({ total: 1, ok: 1, fail: 0 })
  })
})

// ── 5. 崩溃恢复：孤儿任务回收 ────────────────────────────
describe('v3.33 孤儿任务回收', () => {
  it('force=true：claimed/running 全部退回 pending 并清 owner', () => {
    const now = 1_000_000
    const tasks: any[] = [
      { id: 't1', status: 'running', owner: 'w1', heartbeatAt: now, title: 'A' },
      { id: 't2', status: 'claimed', owner: 'w2', heartbeatAt: now, title: 'B' },
      { id: 't3', status: 'done', owner: 'w1', title: 'C' },
      { id: 't4', status: 'pending', owner: null, title: 'D' },
    ]
    const r = reapOrphansInState({ tasks, seq: 4, history: [] }, now, { force: true })
    expect(r.reaped.sort()).toEqual(['t1', 't2'])
    const t1 = r.state.tasks.find(t => t.id === 't1')
    expect(t1.status).toBe('pending')
    expect(t1.owner).toBeNull()
    expect(r.state.tasks.find(t => t.id === 't3').status).toBe('done')
    expect(r.state.history.length).toBe(2)
  })
  it('非 force：心跳新鲜的不动，僵死的回收', () => {
    const now = 1_000_000
    const tasks: any[] = [
      { id: 't1', status: 'running', owner: 'w1', heartbeatAt: now - 30 * 60 * 1000, title: 'A' },
      { id: 't2', status: 'running', owner: 'w2', heartbeatAt: now, title: 'B' },
    ]
    const r = reapOrphansInState({ tasks, seq: 2, history: [] }, now)
    expect(r.reaped).toEqual(['t1'])
    expect(r.state.tasks.find(t => t.id === 't2').status).toBe('running')
  })
})

// ── 6. 团队日记 ──────────────────────────────────────────
describe('v3.33 团队日记', () => {
  it('按本地日界统计：完成/失败/明星工种/自治句', () => {
    const d = new Date(2026, 8, 20, 12, 0, 0)
    const { start, end } = dayRange(d)
    const at = (h: number) => start + h * 3600_000
    const events: any[] = [
      { ts: at(1), taskId: 't1', from: 'created', to: 'pending', by: 'lumina', title: 'A' },
      { ts: at(2), taskId: 't1', from: 'claimed', to: 'running', by: 'w1', title: 'A' },
      { ts: at(3), taskId: 't1', from: 'running', to: 'done', by: 'w1', title: 'A' },
      { ts: at(4), taskId: 't2', from: 'running', to: 'failed', by: 'w2', title: 'B' },
      // 昨天的事件不计入
      { ts: start - 3600_000, taskId: 't0', from: 'running', to: 'done', by: 'w1', title: 'Z' },
    ]
    const traces: any[] = [
      { phase: 'end', at: at(3), role: 'code', ok: true, durationMs: 1000, longRunning: false },
      { phase: 'end', at: at(4), role: 'data', ok: false, durationMs: 1000, longRunning: false },
    ]
    void end
    const digest = buildDigest(
      { events, traces, stats: {}, autonomousClaims: 1 },
      d,
    )
    expect(digest.completed).toBe(1)
    expect(digest.failed).toBe(1)
    expect(digest.autonomy).toBe(1)
    expect(digest.starRole).toEqual({ role: 'code', done: 1 })
    expect(digest.markdown).toContain('自己看到、主动认领')
  })
})

// ── 7. 关系进调度 ────────────────────────────────────────
describe('v3.33 关系调度', () => {
  it('pickByTrust：低于门槛排除，其余按信任降序', () => {
    const pick = pickByTrust([
      { role: 'a', trust: 30 },
      { role: 'b', trust: 80 },
      { role: 'c', trust: 55 },
    ], 40)
    expect(pick?.role).toBe('b')
    expect(pickByTrust([{ role: 'a', trust: 10 }], 40)).toBeNull()
  })
  it('无关系记录时信任中性 50，默认阈值 60 → 需要双签', () => {
    const r = needsDoubleReview({ authorRole: 'brand-new-role' })
    expect(r.needed).toBe(true)
    expect(r.trust).toBe(50)
    const forced = needsDoubleReview({ authorRole: 'code', force: true })
    expect(forced.needed).toBe(true)
    expect(forced.reason).toContain('强制双签')
  })
})

// ── 8. agent.md 新配置粒度 ───────────────────────────────
describe('v3.33 agent.md effort / path_scope', () => {
  it('解析 effort 与 path_scope，非法 effort 回退 medium', () => {
    const md = `---
name: 细致工程员
id: careful-code
role: code
effort: high
path_scope: src/**
---
# 正文
慢慢做。`
    const a = parseAgentMarkdown(md, 'careful-code.md')
    expect(a.effort).toBe('high')
    expect(a.pathScope).toBe('src/**')
    const md2 = md.replace('high', 'ultra')
    expect(parseAgentMarkdown(md2, 'x.md').effort).toBe('medium')
  })
  it('序列化回写 effort，path_scope 仅在有值时输出', () => {
    const a = parseAgentMarkdown('---\nname: x\nid: x\nrole: general\neffort: low\n---\n', 'x.md')
    const out = serializeAgentMarkdown(a)
    expect(out).toContain('effort: low')
    expect(out).not.toContain('path_scope')
  })
})
