// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/rituals.test.ts — 仪式感闭环（睡前复盘 + 晨间简报）
//
// 覆盖：
//   1. 口播 LLM 成功（source:llm）
//   2. LLM 失败 → 模板兜底（source:template，数字来自真实 replay）
//   3. TTS 成功 → 走播报，气泡不被调
//   4. TTS 失败 → 降级气泡且文本不丢、detail 不吞
//   5. 晨间缺天气 / 缺日历 / 全缺 三种降级
//   6. 预算暂停 → 跳过且记录原因，不调 LLM / TTS
//   7. 定时触发：该触发时触发、不该触发时不触发；开关关闭不调度；热改时间生效
// ============================================================

import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  runNightReview,
  generateNightUtterance,
  runMorningBriefing,
  RitualScheduler,
  emptyReplay,
} from '../electron/rituals'
import type { DailyReplayLike, RitualDeps } from '../electron/rituals'

// ── 固定时钟：2026-10-14（周三）────────────────────────────

const NOW = new Date(2026, 9, 14, 20, 0, 0).getTime() // 20:00 本地

function makeReplay(overrides: Partial<DailyReplayLike> = {}): DailyReplayLike {
  return {
    date: '2026-10-14',
    items: [
      { ts: NOW - 3600_000, kind: 'command', title: '整理项目结构' },
      { ts: NOW - 1800_000, kind: 'build', title: '跑通测试套件' },
      { ts: NOW - 600_000, kind: 'error', title: 'tsc 类型报错一处' },
    ],
    stats: {
      commands: 12,
      filesChanged: 5,
      turns: 24,
      delegates: 2,
      llmCalls: 8,
      costYuan: 0.42,
      promptTokens: 3200,
      completionTokens: 1100,
      byAgent: { main: 20 },
      byPurpose: { dev: 24 },
    },
    ...overrides,
  }
}

function baseDeps(extra: Partial<RitualDeps> = {}): RitualDeps {
  return {
    buildDailyReplay: () => makeReplay(),
    now: () => NOW,
    ...extra,
  }
}

// ═══════════════════════════════════════════════════════════
// 睡前复盘：LLM 路径
// ═══════════════════════════════════════════════════════════

describe('睡前复盘：口播生成', () => {
  it('LLM 成功 → source:llm，文本来自 LLM', async () => {
    const deps = baseDeps({
      llmGenerate: vi.fn(async () => ({ text: '今天辛苦啦，把电脑合上，好好睡一觉。', source: 'llm' })),
    })
    const u = await generateNightUtterance(deps)
    expect(u.source).toBe('llm')
    expect(u.text).toContain('好好睡一觉')
    expect(u.kind).toBe('night')
  })

  it('LLM 抛错 → source:template，数字来自真实 replay', async () => {
    const deps = baseDeps({
      llmGenerate: vi.fn(async () => {throw new Error('model down')}),
    })
    const u = await generateNightUtterance(deps)
    expect(u.source).toBe('template')
    // 真实统计数字必须出现在模板里
    expect(u.text).toContain('12')
    expect(u.text).toContain('0.42')
    expect(u.text).toContain('tsc 类型报错一处') // 小遗憾
  })

  it('未注册 llmGenerate → 直接模板兜底，不抛错', async () => {
    const deps = baseDeps()
    const u = await generateNightUtterance(deps)
    expect(u.source).toBe('template')
    expect(u.text.length).toBeGreaterThan(20)
  })

  it('Day Replay 模块未就绪（buildDailyReplay 抛错）→ 无数据模板，不崩', async () => {
    const deps = baseDeps({
      buildDailyReplay: () => {throw new Error('dayreplay not ready')},
    })
    const u = await generateNightUtterance(deps)
    expect(u.source).toBe('template')
    expect(u.notes).toContain('Day Replay 暂无数据')
  })
})

// ═══════════════════════════════════════════════════════════
// 呈现链：TTS → 气泡降级
// ═══════════════════════════════════════════════════════════

describe('呈现链', () => {
  it('TTS 成功 → delivered=tts，气泡不被调用', async () => {
    const showBubble = vi.fn()
    const deps = baseDeps({
      llmGenerate: async () => ({ text: '晚安，好梦。', source: 'llm' }),
      ttsSpeak: async () => ({ ok: true }),
      showBubble,
    })
    const rec = await runNightReview(deps)
    expect(rec.source).toBe('llm')
    expect(rec.delivered).toBe('tts')
    expect(showBubble).not.toHaveBeenCalled()
  })

  it('TTS 失败（ok:false,detail）→ 降级气泡，文本不丢、detail 不吞', async () => {
    const showBubble = vi.fn()
    const deps = baseDeps({
      llmGenerate: async () => ({ text: '晚安，好梦。', source: 'llm' }),
      ttsSpeak: async () => ({ ok: false, detail: 'Python Node 未运行' }),
      showBubble,
    })
    const rec = await runNightReview(deps)
    expect(rec.delivered).toBe('bubble')
    expect(showBubble).toHaveBeenCalledTimes(1)
    expect(showBubble.mock.calls[0][0]).toBe('晚安，好梦。')
    expect(rec.text).toBe('晚安，好梦。')
  })

  it('TTS 抛异常 → 同样降级气泡', async () => {
    const showBubble = vi.fn()
    const deps = baseDeps({
      llmGenerate: async () => ({ text: '晚安。', source: 'llm' }),
      ttsSpeak: async () => {throw new Error('connection refused')},
      showBubble,
    })
    const rec = await runNightReview(deps)
    expect(rec.delivered).toBe('bubble')
    expect(showBubble).toHaveBeenCalled()
  })

  it('TTS 与气泡都没有 → delivered=none，不崩', async () => {
    const deps = baseDeps({
      llmGenerate: async () => ({ text: '晚安。', source: 'llm' }),
    })
    const rec = await runNightReview(deps)
    expect(rec.delivered).toBe('none')
  })
})

// ═══════════════════════════════════════════════════════════
// 预算联动
// ═══════════════════════════════════════════════════════════

describe('预算守卫联动', () => {
  it('budgetAllows=false → 跳过并记录原因，不调用 LLM 和 TTS', async () => {
    const llmGenerate = vi.fn(async () => ({ text: '不该被调用', source: 'llm' }))
    const ttsSpeak = vi.fn(async () => ({ ok: true }))
    const deps = baseDeps({
      llmGenerate,
      ttsSpeak,
      budgetAllows: () => false,
    })
    const rec = await runNightReview(deps)
    expect(rec.source).toBe('skipped')
    expect(rec.reason).toContain('预算')
    expect(llmGenerate).not.toHaveBeenCalled()
    expect(ttsSpeak).not.toHaveBeenCalled()
  })

  it('手动触发（manual=true）→ 视为用户主动发起，不查预算守卫', async () => {
    const llmGenerate = vi.fn(async () => ({ text: '手动试一次', source: 'llm' }))
    const deps = baseDeps({
      llmGenerate,
      ttsSpeak: async () => ({ ok: true }),
      budgetAllows: () => false,
    })
    const rec = await runNightReview(deps, { manual: true })
    expect(rec.source).toBe('llm')
    expect(rec.manual).toBe(true)
    expect(llmGenerate).toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════
// 晨间简报：素材降级
// ═══════════════════════════════════════════════════════════

describe('晨间简报：素材降级', () => {
  const fullSources = {
    weather: async () => '河池 22°C 多云',
    calendar: async () => '10:00 站会',
    todo: async () => '写周报',
    tasks: async () => '「调试 rituals」',
  }

  it('全部素材齐全 → LLM 组织口播', async () => {
    const deps = baseDeps({
      llmGenerate: async () => ({ text: '早上好，今天多云微凉，记得带件薄外套。', source: 'llm' }),
    })
    const rec = await runMorningBriefing(deps, { sources: fullSources })
    expect(rec.source).toBe('llm')
  })

  it('缺天气（抛错）→ 日历/待办照常，notes 带过天气', async () => {
    const deps = baseDeps()
    const rec = await runMorningBriefing(deps, {
      sources: {
        weather: async () => {throw new Error('open-meteo timeout')},
        calendar: async () => '10:00 站会',
        todo: async () => '写周报',
        tasks: async () => '「调试 rituals」',
      },
    })
    expect(rec.source).toBe('template')
    expect(rec.text).toContain('站会')
    // 不许编造天气
    expect(rec.text).not.toContain('多云')
  })

  it('缺日历 → 天气/待办照常', async () => {
    const deps = baseDeps()
    const rec = await runMorningBriefing(deps, {
      sources: {
        weather: async () => '河池 22°C 多云',
        calendar: async () => {throw new Error('calendar file missing')},
        todo: async () => '写周报',
        tasks: async () => '「调试 rituals」',
      },
    })
    expect(rec.text).toContain('22°C')
    expect(rec.text).toContain('写周报')
  })

  it('全部缺失 → 纯问候模板，不编造任何素材', async () => {
    const deps = baseDeps()
    const rec = await runMorningBriefing(deps, { sources: {} })
    expect(rec.source).toBe('template')
    expect(rec.text).toContain('没拉到数据')
    expect(rec.text).not.toContain('°C')
    expect(rec.text).not.toContain('站会')
  })

  it('晨间预算暂停 → 跳过记录', async () => {
    const llmGenerate = vi.fn(async () => ({ text: '不该被调用', source: 'llm' }))
    const deps = baseDeps({ llmGenerate, budgetAllows: () => false })
    const rec = await runMorningBriefing(deps, { sources: fullSources })
    expect(rec.source).toBe('skipped')
    expect(rec.reason).toContain('预算')
    expect(llmGenerate).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════
// 调度器：时间匹配 / 开关 / 热改时间
// ═══════════════════════════════════════════════════════════

describe('调度器 RitualScheduler', () => {
  const fire = vi.fn()
  let nightTime = '23:00'
  let morningTime = '08:00'
  let nightOn = true
  let morningOn = true

  function makeScheduler(): RitualScheduler {
    return new RitualScheduler({
      isNightEnabled: () => nightOn,
      isMorningEnabled: () => morningOn,
      nightTime: () => nightTime,
      morningTime: () => morningTime,
      fire,
    })
  }

  afterEach(() => {
    fire.mockClear()
    nightTime = '23:00'
    morningTime = '08:00'
    nightOn = true
    morningOn = true
  })

  it('命中 23:00 → 触发睡前复盘；23:05 → 不触发', () => {
    const s = makeScheduler()
    const fired = s.tick(new Date(2026, 9, 14, 23, 0, 0).getTime())
    expect(fired).toEqual(['night'])
    expect(fire).toHaveBeenCalledWith('night')

    s.resetDedup()
    const notFired = s.tick(new Date(2026, 9, 14, 23, 5, 0).getTime())
    expect(notFired).toEqual([])
  })

  it('命中 08:00 → 触发晨间简报', () => {
    const s = makeScheduler()
    const fired = s.tick(new Date(2026, 9, 15, 8, 0, 0).getTime())
    expect(fired).toEqual(['morning'])
  })

  it('同一分钟重复 tick → 只触发一次（防重）', () => {
    const s = makeScheduler()
    const t = new Date(2026, 9, 14, 23, 0, 0).getTime()
    expect(s.tick(t)).toEqual(['night'])
    expect(s.tick(t + 10_000)).toEqual([]) // 同一分钟内
    expect(fire).toHaveBeenCalledTimes(1)
  })

  it('开关关闭 → 到点也不调度', () => {
    nightOn = false
    const s = makeScheduler()
    const fired = s.tick(new Date(2026, 9, 14, 23, 0, 0).getTime())
    expect(fired).toEqual([])
    expect(fire).not.toHaveBeenCalled()
  })

  it('热改时间：改成 22:30 后，22:30 触发、旧的 23:00 不再触发', () => {
    nightTime = '22:30'
    const s = makeScheduler()
    const hit = s.tick(new Date(2026, 9, 14, 22, 30, 0).getTime())
    expect(hit).toEqual(['night'])

    s.resetDedup()
    const oldSlot = s.tick(new Date(2026, 9, 14, 23, 0, 0).getTime())
    expect(oldSlot).toEqual([])
  })
})
