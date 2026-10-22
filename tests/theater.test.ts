// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/theater.test.ts — 团队可见性剧场（创新功能 2）
//
// 重心在三处：
//   1. 不可变性——状态机不能就地改，否则回放会失真
//   2. 情绪投影——7 档判定顺序不能乱（疲惫≠低落，焦躁≠失落）
//   3. **不编造**——没有台词就没有台词，不能凭空生成
// ============================================================

import { describe, it, expect } from 'vitest'
import {
  openPlay, addBeat, addBeats, summarizePlay, renderScript, pickHighlight,
  projectEmotion, actorName,
  type TheaterState, type TheaterEvent,
} from '../electron/orchestration/theater'
import { moodToThree } from '../electron/orchestration/theaterBridge'

const NEUTRAL = { mood: 0, energy: 0.4, affinity: 0.5 }
const HAPPY = { mood: 0.9, energy: 0.9, affinity: 0.8 }
const SAD = { mood: -0.7, energy: 0.3, affinity: 0.5 }
const TIRED = { mood: -0.3, energy: 0.05, affinity: 0.5 }
const JITTERY = { mood: -0.6, energy: 0.95, affinity: 0.5 }

describe('theater · 状态机不可变性', () => {
  it('addBeat 不修改原 state', () => {
    const s = openPlay('测试任务', 'p1', 1000)
    const r = addBeat(s, { kind: 'delegate', role: 'lumina', text: '你去看看' }, 2000)
    expect(s.beats).toHaveLength(0)      // 原 state 未变
    expect(s.seq).toBe(0)
    expect(r.state.beats).toHaveLength(1)
  })

  it('seq 严格自增', () => {
    let s = openPlay('t', 'p1')
    for (let i = 0; i < 5; i++) {
      s = addBeat(s, { kind: 'speech', role: 'yak', text: `第${i}句` }).state
    }
    expect(s.seq).toBe(5)
    expect(s.beats.map(b => b.seq)).toEqual([1, 2, 3, 4, 5])
  })

  it('addBeats 批量累积', () => {
    const s = openPlay('t', 'p1')
    const out = addBeats(s, [
      { kind: 'delegate', role: 'lumina', text: 'a' },
      { kind: 'worker_start', role: 'yak', text: 'b' },
      { kind: 'worker_done', role: 'yak', text: 'c' },
    ])
    expect(out.beats).toHaveLength(3)
    expect(out.beats.map(b => b.role)).toEqual(['lumina', 'yak', 'yak'])
  })

  it('scene_close 标记 closed', () => {
    let s = openPlay('t', 'p1')
    s = addBeat(s, { kind: 'scene_close', role: 'lumina', text: '搞定了' }).state
    expect(s.closed).toBe(true)
  })

  it('超过 200 幕时环形截断，不无限增长', () => {
    let s = openPlay('t', 'p1')
    for (let i = 0; i < 250; i++) {
      s = addBeat(s, { kind: 'speech', role: 'yak', text: `n${i}` }).state
    }
    expect(s.beats.length).toBe(200)
    // 保留的是最近的
    expect(s.beats[s.beats.length - 1].text).toBe('n249')
  })
})

describe('theater · 情绪投影', () => {
  it('无情绪信息时按平静处理（不猜）', () => {
    expect(projectEmotion(null).beat).toBe('calm')
    expect(projectEmotion(undefined).beat).toBe('calm')
    expect(projectEmotion({ mood: NaN, energy: 0.5, affinity: 0.5 }).beat).toBe('calm')
  })

  it('疲惫优先于低落（累 ≠ 难过）', () => {
    // mood 与 TIRED 同为 -0.3，但 energy 极低
    const tired = projectEmotion(TIRED)
    expect(tired.beat).toBe('weary')
  })

  it('高唤醒 + 低效价 → 焦虑（焦躁 ≠ 失落）', () => {
    expect(projectEmotion(JITTERY).beat).toBe('anxious')
  })

  it('平静低唤醒的低落 → 不爽而非焦虑', () => {
    expect(projectEmotion(SAD).beat).toBe('upset')
  })

  it('高唤醒 + 高效价 → 有把握', () => {
    expect(projectEmotion(HAPPY).beat).toBe('confident')
  })

  it('valence 数值被透传，供 UI 画颜色', () => {
    const r = projectEmotion(SAD)
    expect(r.valence).toBeLessThan(0)
    expect(projectEmotion(HAPPY).valence).toBeGreaterThan(0)
  })
})

describe('theater · 诚实性（不编造内容）', () => {
  it('没有台词的幕不会被补全', () => {
    let s = openPlay('t', 'p1')
    s = addBeat(s, { kind: 'worker_start', role: 'yak', text: '' }).state
    expect(s.beats[0].text).toBe('')          // 空就是空
    expect(renderScript(s)).toContain('：')     // 剧本里就是空的
  })

  it('未传情绪则 valence 为 0，不臆造情绪', () => {
    let s = openPlay('t', 'p1')
    s = addBeat(s, { kind: 'delegate', role: 'lumina', text: '你去' }).state
    expect(s.beats[0].emotion).toBe('calm')
    expect(s.beats[0].valence).toBe(0)
  })

  it('空剧目渲染为空串', () => {
    const s = openPlay('空的', 'p1')
    expect(renderScript(s)).toBe('')
    expect(pickHighlight(s)).toBeNull()
  })
})

describe('theater · 摘要与剧本', () => {
  function sample(): TheaterState {
    return addBeats(openPlay('修个 bug', 'p1', 1000), [
      { kind: 'delegate', role: 'lumina', text: 'Yak 帮我看看这个崩溃', emotion: NEUTRAL },
      { kind: 'worker_start', role: 'yak', text: '开始读代码', emotion: { mood: 0.4, energy: 0.7, affinity: 0.5 } },
      { kind: 'incident', role: 'yak', text: '测试挂了 3 个', emotion: JITTERY },
      { kind: 'revision', role: 'yak', text: '改完了，再跑一次', emotion: TIRED },
      { kind: 'scene_close', role: 'lumina', text: '搞定了', emotion: HAPPY },
    ], 2000)
  }

  it('统计各角色登场幕数', () => {
    const s = summarizePlay(sample())
    expect(s.beatCount).toBe(5)
    expect(s.appearances.yak).toBe(3)
    expect(s.appearances.lumina).toBe(2)
  })

  it('统计事故数', () => {
    expect(summarizePlay(sample()).incidents).toBe(1)
  })

  it('情绪弧光：结尾比开场更正面则为正', () => {
    expect(summarizePlay(sample()).emotionalArc).toBeGreaterThan(0)
  })

  it('记录最后一句', () => {
    expect(summarizePlay(sample()).lastLine).toBe('搞定了')
  })

  it('剧本包含角色、情绪与台词', () => {
    const script = renderScript(sample())
    expect(script).toContain('修个 bug')
    expect(script).toContain('Yak 💻')
    expect(script).toContain('焦虑')   // JITTERY 那幕
    expect(script).toContain('搞定了')
  })

  it('highlight 挑最戏剧性的一幕，且只在真有戏剧性时返回', () => {
    const dramatic = pickHighlight(sample())
    expect(dramatic).not.toBeNull()
    expect(dramatic).toContain('测试挂了')   // 负效价最强的那幕

    // 全程平静的戏不该硬造花絮
    const calm = addBeats(openPlay('日常', 'p2'), [
      { kind: 'delegate', role: 'lumina', text: '早', emotion: NEUTRAL },
      { kind: 'speech', role: 'yak', text: '早', emotion: NEUTRAL },
    ])
    expect(pickHighlight(calm)).toBeNull()
  })
})

describe('theater · 角色显示名', () => {
  it('三个内置角色有固定显示名', () => {
    expect(actorName('lumina')).toContain('Lumina')
    expect(actorName('yak')).toContain('Yak')
    expect(actorName('recha')).toContain('热茶')
  })
})

describe('theater · mood 字符串桥接', () => {
  it('已知 mood 映射到权威情绪坐标', () => {
    const r = moodToThree('happy')
    expect(r).not.toBeNull()
    expect(r!.mood).toBeGreaterThan(0)
  })

  it('未知 mood 返回 null（不猜）', () => {
    expect(moodToThree('confused_xyz')).toBeNull()
    expect(moodToThree('')).toBeNull()
    expect(moodToThree(null)).toBeNull()
  })

  it('mood 为中性时情绪接近平静', () => {
    const r = moodToThree('neutral')
    expect(r).not.toBeNull()
    expect(Math.abs(r!.mood)).toBeLessThan(0.2)
  })
})
