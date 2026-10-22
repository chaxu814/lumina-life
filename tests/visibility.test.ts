// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// tests/visibility.test.ts
//
// 可见性分档的契约测试。
//
// 【为什么这条不变量比看起来重要】
// 「陪伴模式藏掉协作细节」是铁则一；但反方向同样危险：
// 如果为了体验把**权限审批弹窗**也藏了，用户看到的 Lumina 就成了一个
// 能在自己电脑上动手、还能自己批准的黑盒 —— 那是安全倒退。
// 所以下面专门有用例钉住「approval:* 全档位可见」。
import { describe, it, expect, beforeEach } from 'vitest'
import {
  getVisibilityTier, setVisibilityTier, onVisibilityChange, isEventVisible,
  filterByVisibility, VISIBILITY_TIERS, VISIBILITY_ORDER, __resetVisibility,
} from '../electron/orchestration/visibility'

describe('可见性分档', () => {
  beforeEach(() => { __resetVisibility() })

  it('默认是陪伴模式（铁则一原样保留）', () => {
    expect(getVisibilityTier()).toBe('companion')
  })

  it('陪伴模式隐藏的是「谁在干」，不是「她在干什么」', () => {
    // 统一人格 + 桌宠反映真实执行状态，依赖的就是 tool_start/tool_end 透出。
    // 藏掉它会让用户不知道她在做什么，也会让情绪→表情的因果链断在 UI 层。
    expect(isEventVisible('text', 'companion')).toBe(true)
    expect(isEventVisible('tool_start', 'companion')).toBe(true)
    expect(isEventVisible('tool_end', 'companion')).toBe(true)
    // 藏的是分工层
    expect(isEventVisible('agent:message', 'companion')).toBe(false)
    expect(isEventVisible('agent:delegate', 'companion')).toBe(false)
    expect(isEventVisible('route:decision', 'companion')).toBe(false)
  })

  it('⚠️ 权限审批在三档下都必须可见 —— 藏掉它就是安全倒退', () => {
    for (const tier of VISIBILITY_ORDER) {
      expect(isEventVisible('approval:pending', tier), `${tier} 隐藏了审批请求`).toBe(true)
      expect(isEventVisible('approval:resolved', tier), `${tier} 隐藏了审批结果`).toBe(true)
    }
  })

  it('⚠️ 错误事件在三档下都必须可见', () => {
    for (const tier of VISIBILITY_ORDER) {
      expect(isEventVisible('error', tier), `${tier} 隐藏了错误`).toBe(true)
    }
  })

  it('协作模式加一层，审计模式再加一层（单调递增）', () => {
    expect(isEventVisible('agent:delegate', 'collab')).toBe(true)
    expect(isEventVisible('gate:audit', 'collab')).toBe(false)
    expect(isEventVisible('gate:audit', 'audit')).toBe(true)
    expect(isEventVisible('cost:update', 'audit')).toBe(true)
    expect(isEventVisible('latency:update', 'audit')).toBe(true)
  })

  it('档位元数据齐全，且每档都明写「给谁看」', () => {
    for (const t of VISIBILITY_ORDER) {
      const m = VISIBILITY_TIERS[t]
      expect(m.tier).toBe(t)
      expect(m.label).toBeTruthy()
      expect(m.summary).toBeTruthy()
      expect(m.audience).toBeTruthy()
      expect(m.showsEventTypes.length).toBeGreaterThan(0)
    }
  })

  it('非法档位回落到陪伴模式，不抛错', () => {
    expect(setVisibilityTier('nope')).toBe('companion')
    expect(getVisibilityTier()).toBe('companion')
    expect(setVisibilityTier(null)).toBe('companion')
    expect(setVisibilityTier(123)).toBe('companion')
  })

  it('切换会通知订阅者；重复设同值不重复通知', () => {
    const seen: string[] = []
    const off = onVisibilityChange((t) => seen.push(t))

    setVisibilityTier('audit')
    setVisibilityTier('audit')   // 同值，不应重复通知
    setVisibilityTier('collab')

    expect(seen).toEqual(['audit', 'collab'])
    off()
    setVisibilityTier('companion')
    expect(seen).toEqual(['audit', 'collab'])  // 已退订
  })

  it('单个监听器抛错不影响其它监听器', () => {
    const ok: string[] = []
    onVisibilityChange(() => { throw new Error('boom') })
    onVisibilityChange((t) => ok.push(t))
    expect(() => setVisibilityTier('collab')).not.toThrow()
    expect(ok).toEqual(['collab'])
  })

  it('filterByVisibility 返回新数组并报告隐藏数量', () => {
    const events = [
      { type: 'text' }, { type: 'agent:delegate' }, { type: 'tool_start' }, { type: 'gate:audit' },
    ]
    const snapshot = events.slice()

    const r = filterByVisibility(events, 'collab')
    expect(r.visible.map(e => e.type)).toEqual(['text', 'agent:delegate', 'tool_start'])
    expect(r.hiddenCount).toBe(1)
    // 关键：不能原地改入参 —— 上游可能还持着同一批引用
    expect(events).toEqual(snapshot)
    expect(events).toHaveLength(4)
  })

  it('审计模式下所有事件类型都可见（无隐藏）', () => {
    const all = [...new Set([
      ...VISIBILITY_TIERS.companion.showsEventTypes,
      ...VISIBILITY_TIERS.collab.showsEventTypes,
      ...VISIBILITY_TIERS.audit.showsEventTypes,
    ])].map(type => ({ type }))
    const r = filterByVisibility(all, 'audit')
    expect(r.hiddenCount).toBe(0)
    expect(r.visible).toHaveLength(all.length)
  })
})
