import { describe, it, expect } from 'vitest'
import { parsePerformance, safePerformance, BUILTIN_GESTURES } from '../electron/pet/life/performanceDsl'

describe('performanceDsl 表演 DSL', () => {
  it('合法完整指令被规范化', () => {
    const r = parsePerformance({
      expression: '开心', gaze: { target: 'user' }, gesture: { name: 'wave', intensity: 0.8 },
      headTilt: 0.3, effect: 'heart', durationMs: 1500, blend: 'add',
    })
    expect(r.ok).toBe(true)
    expect(r.command?.expression).toBe('开心 😊')
    expect(r.command?.gesture?.name).toBe('wave')
    expect(r.command?.gesture?.builtin).toBe(true)
    expect(r.command?.effect?.name).toBe('heart')
    expect(r.command?.durationMs).toBe(1500)
    expect(r.command?.blend).toBe('add')
  })

  it('字符串简写手势/特效可用', () => {
    const r = parsePerformance({ gesture: 'nod', effect: 'sparkle' })
    expect(r.ok).toBe(true)
    expect(r.command?.gesture?.name).toBe('nod')
    expect(r.command?.effect?.amount).toBeCloseTo(0.8)
  })

  it('非法手势/特效/表情被丢弃并记录错误', () => {
    const r = parsePerformance({ gesture: 'explode_server', effect: 'rm_rf', expression: '暴怒' })
    expect(r.command?.gesture).toBeUndefined()
    expect(r.command?.effect).toBeUndefined()
    expect(r.errors.length).toBeGreaterThan(0)
  })

  it('数值钳制：intensity / duration / headTilt / gaze', () => {
    const r = parsePerformance({ gesture: { name: 'shrug', intensity: 5 }, durationMs: 999999, headTilt: 9, gaze: { x: 4 } })
    expect(r.command?.gesture?.intensity).toBe(1)
    expect(r.command?.durationMs).toBe(6000)
    expect(r.command?.headTilt).toBe(1)
    expect(r.command?.gaze?.x).toBe(1)
  })

  it('motion 防路径穿越/非法字符', () => {
    expect(parsePerformance({ motion: 'mtn_01' }).command?.motion).toBe('mtn_01')
    const bad = parsePerformance({ motion: '../escape' })
    expect(bad.command?.motion).toBeUndefined()
    expect(bad.errors.length).toBeGreaterThan(0)
  })

  it('非对象/空指令 → 失败；safePerformance 返回 null', () => {
    expect(parsePerformance('wave').ok).toBe(false)
    expect(parsePerformance({}).ok).toBe(false)
    expect(safePerformance({ gesture: 'nope' })).toBeNull()
  })

  it('内置手势集合包含现有动作', () => {
    for (const g of ['wave', 'nod', 'clap', 'dance']) {expect(BUILTIN_GESTURES).toContain(g)}
  })
})
