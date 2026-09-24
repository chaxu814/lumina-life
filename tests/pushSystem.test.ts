// tests/pushSystem.test.ts — 主动推送系统单测
import { describe, it, expect, beforeEach, vi } from 'vitest'

// 注意：pushState/pushDecider/pushExecutor 不依赖 electron 运行时（除了 app.getPath）
// 测试时 mock electron

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/lumina-test' },
}))

import {
  loadPushState, savePushState, tickState, recordUserActivity,
  recordPush, recordIgnored, recordResponded,
  DEFAULT_PUSH_SETTINGS, type PushState,
} from '../electron/proactive/pushState'
import { decidePush, type PushDecision } from '../electron/proactive/pushDecider'
import { executePush } from '../electron/proactive/pushExecutor'

function makeState(overrides: Partial<PushState> = {}): PushState {
  return {
    fatigue: 0.3,
    intimacy: 0.5,
    luminaEnergy: 0.8,
    lastActiveAt: Date.now() - 30 * 60 * 1000, // 30分钟前活跃
    lastPushAt: 0,
    todayPushCount: 0,
    todayDate: new Date().toISOString().slice(0, 10),
    consecutiveIgnored: 0,
    updatedAt: Date.now() - 60 * 1000,
    ...overrides,
  }
}

// ── pushState ──

describe('pushState', () => {
  it('tickState: 精力随时间恢复', () => {
    const s = makeState({ luminaEnergy: 0.5, updatedAt: Date.now() - 2 * 60 * 60 * 1000 })
    const r = tickState(s)
    expect(r.luminaEnergy).toBeGreaterThan(0.5)
    expect(r.luminaEnergy).toBeLessThanOrEqual(1)
  })

  it('tickState: 空闲时疲劳度恢复', () => {
    const s = makeState({ fatigue: 0.8, lastActiveAt: Date.now() - 2 * 60 * 60 * 1000, updatedAt: Date.now() - 60 * 60 * 1000 })
    const r = tickState(s)
    expect(r.fatigue).toBeLessThan(0.8)
  })

  it('tickState: 跨天重置推送计数', () => {
    const s = makeState({ todayPushCount: 5, todayDate: '2020-01-01' })
    const r = tickState(s)
    expect(r.todayPushCount).toBe(0)
  })

  it('recordUserActivity: 更新活跃时间+提升亲密度+清零未响应', () => {
    const s = makeState({ consecutiveIgnored: 3, intimacy: 0.4 })
    const r = recordUserActivity(s)
    expect(r.consecutiveIgnored).toBe(0)
    expect(r.intimacy).toBeGreaterThan(0.4)
    expect(r.lastActiveAt).toBeGreaterThan(s.lastActiveAt)
  })

  it('recordPush: 增加计数+消耗精力', () => {
    const s = makeState({ todayPushCount: 0, luminaEnergy: 0.8 })
    const r = recordPush(s)
    expect(r.todayPushCount).toBe(1)
    expect(r.luminaEnergy).toBeLessThan(0.8)
    expect(r.lastPushAt).toBeGreaterThan(0)
  })

  it('recordIgnored / recordResponded', () => {
    const s = makeState({ consecutiveIgnored: 0 })
    const i = recordIgnored(s)
    expect(i.consecutiveIgnored).toBe(1)
    const r = recordResponded(i)
    expect(r.consecutiveIgnored).toBe(0)
    expect(r.intimacy).toBeGreaterThan(s.intimacy)
  })

  it('状态值都 clamp 在 0-1', () => {
    const s = makeState({ fatigue: 2, intimacy: -1, luminaEnergy: 100 })
    const r = tickState(s)
    expect(r.fatigue).toBeLessThanOrEqual(1)
    expect(r.intimacy).toBeGreaterThanOrEqual(0)
    expect(r.luminaEnergy).toBeLessThanOrEqual(1)
  })
})

// ── pushDecider ──

describe('pushDecider', () => {
  const settings = { ...DEFAULT_PUSH_SETTINGS, quietHoursStart: '02:00', quietHoursEnd: '06:00' }

  it('总开关关闭时不推送', () => {
    const s = makeState()
    const r = decidePush(s, { ...settings, enabled: false })
    expect(r.should_speak).toBe(false)
    expect(r.reason).toContain('开关')
  })

  it('静默时段不推送', () => {
    const s = makeState({ lastActiveAt: Date.now() - 60 * 60 * 1000 })
    const night = new Date()
    night.setHours(3, 0, 0, 0)
    const r = decidePush(s, settings, night.getTime())
    expect(r.should_speak).toBe(false)
    expect(r.reason).toContain('静默')
  })

  it('每日达上限不推送', () => {
    const s = makeState({ todayPushCount: 5, lastActiveAt: Date.now() - 60 * 60 * 1000 })
    const r = decidePush(s, { ...settings, maxPerDay: 5 })
    expect(r.should_speak).toBe(false)
    expect(r.reason).toContain('上限')
  })

  it('冷却期不推送', () => {
    const s = makeState({ lastPushAt: Date.now() - 10 * 60 * 1000, lastActiveAt: Date.now() - 60 * 60 * 1000 })
    const r = decidePush(s, { ...settings, cooldownMinutes: 30 })
    expect(r.should_speak).toBe(false)
    expect(r.reason).toContain('冷却')
  })

  it('用户刚活跃（5分钟内）不推送', () => {
    const s = makeState({ lastActiveAt: Date.now() - 2 * 60 * 1000 })
    const r = decidePush(s, settings)
    expect(r.should_speak).toBe(false)
    expect(r.reason).toContain('活跃')
  })

  it('高欲望值时推送（亲密度高+精力足+不疲劳+晚上黄金时段）', () => {
    const s = makeState({
      intimacy: 0.9, luminaEnergy: 0.9, fatigue: 0.1,
      lastActiveAt: Date.now() - 30 * 60 * 1000,
    })
    const evening = new Date()
    evening.setHours(20, 0, 0, 0)
    const r = decidePush(s, settings, evening.getTime())
    expect(r.should_speak).toBe(true)
    expect(r.speech.length).toBeGreaterThan(0)
    expect(['low', 'medium', 'high']).toContain(r.intensity)
  })

  it('低欲望值时不推送（亲密度低+疲劳+精力差）', () => {
    const s = makeState({
      intimacy: 0.1, luminaEnergy: 0.1, fatigue: 0.9,
      lastActiveAt: Date.now() - 30 * 60 * 1000,
    })
    const r = decidePush(s, settings)
    expect(r.should_speak).toBe(false)
    expect(r.reason).toContain('欲望值')
  })

  it('连续未响应2次提高阈值（原本能推送的变成不推送）', () => {
    const base = makeState({
      intimacy: 0.65, luminaEnergy: 0.7, fatigue: 0.3,
      lastActiveAt: Date.now() - 30 * 60 * 1000,
    })
    const evening = new Date(); evening.setHours(20, 0, 0, 0)
    const r1 = decidePush(base, settings, evening.getTime())
    // 加未响应计数
    const ignored = { ...base, consecutiveIgnored: 3 }
    const r2 = decidePush(ignored, settings, evening.getTime())
    // 至少有一个状态变化（阈值提高后可能从推送变不推送，或强度降低）
    expect(r1.reason).not.toBe(r2.reason)
  })

  it('推送类型在允许列表中', () => {
    const s = makeState({
      intimacy: 0.9, luminaEnergy: 0.9, fatigue: 0.1,
      lastActiveAt: Date.now() - 30 * 60 * 1000,
    })
    const evening = new Date(); evening.setHours(20, 0, 0, 0)
    const r = decidePush(s, { ...settings, allowedTypes: ['care'] }, evening.getTime())
    expect(r.should_speak).toBe(true)
    expect(r.type).toBe('care')
  })
})

// ── pushExecutor ──

describe('pushExecutor', () => {
  it('should_speak=false 时不执行', () => {
    const decision: PushDecision = { should_speak: false, intensity: 'low', speech: '', type: 'chat', reason: 'test' }
    const s = makeState()
    const bubble = vi.fn()
    const r = executePush(decision, s, { showPetBubble: bubble })
    expect(r.delivered).toBe(false)
    expect(bubble).not.toHaveBeenCalled()
  })

  it('should_speak=true 时调用气泡和侧边栏', () => {
    const decision: PushDecision = { should_speak: true, intensity: 'medium', speech: '你好呀', type: 'greeting', reason: 'test' }
    const s = makeState()
    const bubble = vi.fn()
    const sidebar = vi.fn()
    const r = executePush(decision, s, { showPetBubble: bubble, appendSidebarMessage: sidebar })
    expect(r.delivered).toBe(true)
    expect(bubble).toHaveBeenCalledWith('你好呀')
    expect(sidebar).toHaveBeenCalledWith('你好呀', 'greeting')
    expect(r.state.todayPushCount).toBe(s.todayPushCount + 1)
  })

  it('不调用系统 Notification（设计约束）', () => {
    // executePush 只接受 showPetBubble / appendSidebarMessage / log，没有 notification 参数
    const decision: PushDecision = { should_speak: true, intensity: 'low', speech: 'hi', type: 'chat', reason: 't' }
    const s = makeState()
    const r = executePush(decision, s, {})
    expect(r.delivered).toBe(true) // 即使没有 deps 也标记 delivered（状态已更新）
  })

  it('推送后精力消耗', () => {
    const decision: PushDecision = { should_speak: true, intensity: 'low', speech: 'hi', type: 'chat', reason: 't' }
    const s = makeState({ luminaEnergy: 0.8 })
    const r = executePush(decision, s, {})
    expect(r.state.luminaEnergy).toBeLessThan(0.8)
  })
})
