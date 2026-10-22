// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/emotionGating.test.ts — 情绪驱动工具收紧（创新功能 1）
//
// 测试重心刻意放在**安全不变量**上，而不是"能收紧几个工具"：
// 收紧了多少个是策略问题，**绝不能收紧出放开**是安全问题。
// 前者改阈值就行，后者改错了是安全事故。
// ============================================================

import { describe, it, expect } from 'vitest'
import {
  applyEmotionGate,
  renderGateNotice,
  type ToolRiskClass,
  ANXIETY_THRESHOLD,
  FATIGUE_THRESHOLD,
} from '../electron/orchestration/emotionGating'
import { frontendThreeToCore } from '../electron/pet/life/emotionCore'

const BASE = [
  'web_search',      // safe
  'file_read',       // safe
  'shell_exec',      // irreversible
  'file_write',      // irreversible
  'desktop_click',   // irreversible
  'browser',         // heavy
  'deep_research',   // heavy
]

describe('emotionGating · 基础不变量', () => {
  it('没有情绪信息时完全不收紧', () => {
    const r = applyEmotionGate(BASE, null)
    expect(r.gated).toBe(false)
    expect(r.tools).toEqual(BASE)
    expect(r.suppressed).toEqual([])
    expect(r.notice).toBe('')
  })

  it('开关关闭时完全不收紧（用户可控的逃生门）', () => {
    const anxious = { mood: -0.8, energy: 0.2, affinity: 0.5 }
    const r = applyEmotionGate(BASE, anxious, { enabled: false })
    expect(r.gated).toBe(false)
    expect(r.tools).toEqual(BASE)
  })

  it('输入非法时不抛异常、不收紧（情绪模块不能拖垮主流程）', () => {
    const bad = [
      { mood: NaN, energy: 0.5, affinity: 0.5 },
      { mood: undefined as any, energy: 0.5, affinity: 0.5 },
      { mood: 0.5, energy: null as any, affinity: 0.5 },
    ]
    for (const b of bad) {
      const r = applyEmotionGate(BASE, b)
      expect(r.gated).toBe(false)
    }
    // tools 本身不是数组也要安全
    const r2 = applyEmotionGate(null as any, { mood: -0.9, energy: 0.1, affinity: 0.5 })
    expect(r2.tools).toEqual([])
  })

  it('不修改传入的原数组（纯函数）', () => {
    const input = [...BASE]
    applyEmotionGate(input, { mood: -0.9, energy: 0.1, affinity: 0.5 })
    expect(input).toEqual(BASE)
  })
})

describe('emotionGating · 安全不变量：只能收紧，绝不放开', () => {
  it('超开心时不增加任何工具', () => {
    const base = ['file_read', 'web_search']
    const r = applyEmotionGate(base, { mood: 1, energy: 1, affinity: 1 })
    // 关键：结果集合 ⊆ 输入集合
    for (const t of r.tools) {expect(base).toContain(t)}
    expect(r.tools.length).toBeLessThanOrEqual(base.length)
  })

  it('任何情绪状态下都不会凭空多出工具', () => {
    const moods = [-1, -0.5, 0, 0.5, 1]
    const energies = [0, 0.3, 0.6, 1]
    for (const mood of moods) {
      for (const energy of energies) {
        const r = applyEmotionGate(BASE, { mood, energy, affinity: 0.5 })
        const out = new Set(r.tools)
        for (const t of out) {
          expect(BASE, `mood=${mood} energy=${energy} 时凭空多出了 ${t}`).toContain(t)
        }
      }
    }
  })

  it('角色边界之上才收紧：外部传入的白名单不会被扩大', () => {
    // 模拟 rolePolicy 已过滤到只剩只读工具
    const readOnly = ['file_read', 'web_search', 'memory_search']
    const r = applyEmotionGate(readOnly, { mood: 1, energy: 1, affinity: 1 })
    expect(r.tools).toEqual(readOnly)
  })
})

describe('emotionGating · 策略①：焦虑 + 不稳 → 暂缓不可逆操作', () => {
  it('高焦虑且低效价时收紧 irreversible 工具', () => {
    const core = frontendThreeToCore({ mood: -0.8, energy: 0.5, affinity: 0.5 })
    expect(core.anxiety).toBeGreaterThanOrEqual(ANXIETY_THRESHOLD)

    const r = applyEmotionGate(BASE, { mood: -0.8, energy: 0.5, affinity: 0.5 })
    expect(r.gated).toBe(true)
    expect(r.suppressed).toContain('shell_exec')
    expect(r.suppressed).toContain('file_write')
    expect(r.suppressed).toContain('desktop_click')
  })

  it('高焦虑但情绪稳定时不收紧（避免误伤倾诉时刻）', () => {
    // 用户刚倾诉完：焦虑高但 mood 没到负值
    const r = applyEmotionGate(BASE, { mood: 0.1, energy: 0.6, affinity: 0.5 })
    const core = frontendThreeToCore({ mood: 0.1, energy: 0.6, affinity: 0.5 })
    if (core.anxiety >= ANXIETY_THRESHOLD) {
      // 焦虑确实高，但 valence > UNSTABLE_VALENCE → 不该收紧
      expect(r.suppressed).not.toContain('shell_exec')
    } else {
      expect(r.gated).toBe(false)
    }
  })

  it('safe 类工具永远不被策略①收紧', () => {
    const r = applyEmotionGate(BASE, { mood: -0.9, energy: 0.9, affinity: 0.5 })
    expect(r.tools).toContain('web_search')
    expect(r.tools).toContain('file_read')
  })
})

describe('emotionGating · 策略②：疲劳 → 暂缓重活', () => {
  it('高疲劳时收紧 heavy 工具', () => {
    const core = frontendThreeToCore({ mood: 0, energy: 0.1, affinity: 0.5 })
    expect(core.fatigue).toBeGreaterThanOrEqual(FATIGUE_THRESHOLD)

    const r = applyEmotionGate(BASE, { mood: 0, energy: 0.1, affinity: 0.5 })
    expect(r.suppressed).toContain('browser')
    expect(r.suppressed).toContain('deep_research')
  })

  it('高疲劳不会收紧 safe 工具', () => {
    const r = applyEmotionGate(BASE, { mood: -0.1, energy: 0.05, affinity: 0.5 })
    expect(r.tools).toContain('web_search')
    expect(r.tools).toContain('file_read')
  })

  it('焦虑与疲劳很少真正同时出现，各自独立生效', () => {
    // 焦虑 = 负效价 + 高唤醒 → 只触发策略①
    const anxious = applyEmotionGate(BASE, { mood: -0.8, energy: 0.85, affinity: 0.5 })
    expect(anxious.suppressed).toContain('shell_exec')
    expect(anxious.suppressed).not.toContain('browser')   // 高唤醒 ≠ 疲劳

    // 疲劳 = 低唤醒 → 只触发策略②
    const weary = applyEmotionGate(BASE, { mood: 0, energy: 0.05, affinity: 0.5 })
    expect(weary.suppressed).toContain('browser')
    expect(weary.suppressed).not.toContain('shell_exec')  // 中性效价 ≠ 焦虑
  })

  it('低唤醒的低落不触发策略①（那是失落不是焦虑）', () => {
    // 用户难过时应该被安慰，而不是被她当成「焦躁」而回避重活
    const r = applyEmotionGate(BASE, { mood: -0.7, energy: 0.3, affinity: 0.5 })
    expect(r.suppressed).not.toContain('shell_exec')
  })
})

describe('emotionGating · 策略③：好奇高不放开任何东西', () => {
  it('极高唤醒度下不收紧（好奇心不解锁权限）', () => {
    const r = applyEmotionGate(BASE, { mood: 0.9, energy: 1, affinity: 0.9 })
    expect(r.gated).toBe(false)
    expect(r.tools).toEqual(BASE)
  })
})

describe('emotionGating · 自定义分类器', () => {
  it('注入 classify 可改变分类归属', () => {
    const classify = (n: string): ToolRiskClass => (n === 'mystery_tool' ? 'irreversible' : 'safe')
    const r = applyEmotionGate(
      ['mystery_tool', 'other_tool'],
      { mood: -0.9, energy: 0.9, affinity: 0.5 },
      { classify },
    )
    expect(r.suppressed).toContain('mystery_tool')
    expect(r.tools).toContain('other_tool')
  })

  it('未在默认表中的工具按名称启发式分类', () => {
    const r = applyEmotionGate(
      ['my_custom_mouse_helper', 'some_thing'],
      { mood: -0.9, energy: 0.9, affinity: 0.5 },
    )
    expect(r.suppressed).toContain('my_custom_mouse_helper')
    expect(r.tools).toContain('some_thing')
  })
})

describe('emotionGating · notice 文案', () => {
  it('未收紧时 notice 为空串，不污染 prompt', () => {
    const r = applyEmotionGate(BASE, { mood: 0.5, energy: 0.7, affinity: 0.5 })
    expect(r.notice).toBe('')
    expect(renderGateNotice(r)).toBe('')
  })

  it('收紧时说明是状态而非能力缺失', () => {
    const r = applyEmotionGate(BASE, { mood: -0.9, energy: 0.1, affinity: 0.5 })
    const text = renderGateNotice(r)
    expect(text.length).toBeGreaterThan(0)
    // 不得出现"我没有这个能力"这类错误的自我认知
    expect(text).not.toContain('我没有')
    expect(text).not.toContain('无法使用')
    // 必须明确告知"能力没消失"
    expect(text).toContain('并没有消失')
  })
})
