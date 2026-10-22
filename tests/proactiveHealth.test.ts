// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// proactiveHealth.test.ts — 🩺 健康关怀 + 🌙 夜间勿扰 + 🎯 hitArea 反应
//
// 覆盖三项落地增强的纯逻辑：
//   - isNightTime 跨午夜边界、setNightMode 开关/自定义窗口
//   - decideGate 夜间抑制（isNightMode 注入式，不影响既有行为）
//   - HEALTH_DEFAULTS 默认值
//   - generator 健康关怀：专属 system 片段 + 用户上下文 + LLM 兜底
//   - hitArea 反应映射 + 3 秒防抖
// ============================================================
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// mock 掉真实 LLM 与连续情绪（纯逻辑测试，不碰 Electron/网络）
vi.mock('../electron/proactive/resolveProactiveLLM', () => ({
  chatComplete: vi.fn(),
}))
vi.mock('../electron/pet/life/emotionCore', () => ({
  coreToMood: () => '开心 😊',
}))

import {
  decideGate,
  isNightTime,
  setNightMode,
  isNightModeEnabled,
  NIGHT_MODE,
  type GateInput,
} from '../electron/proactive/gate'
import { HEALTH_DEFAULTS } from '../electron/proactiveEngine'
import { generateProactive } from '../electron/proactive/generator'
import { chatComplete } from '../electron/proactive/resolveProactiveLLM'
import {
  resolveHitReaction,
  normalizeHitArea,
  isHitThrottled,
  HIT_DEBOUNCE_MS,
} from '../electron/pet/hitAreaReactions'

const mockedChat = vi.mocked(chatComplete)

/** 所有规则都放行的基线 gate 输入（不注入 isNightMode，默认非夜间） */
function baseInput(overrides: Partial<GateInput> = {}): GateInput {
  return {
    hasUnfinishedThread: false,
    scene: 'idle',
    drives: { social: 0.5, energy: 0.8, comfort: 0.7 },
    idleMinutes: 10,
    dailyCount: 3,
    maxDaily: 20,
    msSinceLastProactive: 600_000,
    minIntervalMs: 60_000,
    cooldownMs: 0,
    petEnabled: true,
    userSpeaking: false,
    rand: () => 0,
    ...overrides,
  }
}

/** 本地时间构造器（避免时区歧义，直接取 getHours） */
function at(hour: number, minute = 0): Date {
  return new Date(2026, 8, 22, hour, minute, 0, 0) // 2026-09-22，指定本地时间
}

beforeEach(() => {
  // 重置夜间模块到默认 23:00–07:00 开启状态
  setNightMode({ startHour: 23, endHour: 7, enabled: true })
  mockedChat.mockReset()
})
afterEach(() => {
  setNightMode({ startHour: 23, endHour: 7, enabled: true })
})

// ────────────────────── 🌙 isNightTime 边界 ──────────────────────
describe('isNightTime 跨午夜边界', () => {
  it('23:00 整点 → 夜间（含起点）', () => {
    expect(isNightTime(at(23, 0))).toBe(true)
  })
  it('06:59 → 夜间（结束点之前）', () => {
    expect(isNightTime(at(6, 59))).toBe(true)
  })
  it('07:00 整点 → 非夜间（不含结束点）', () => {
    expect(isNightTime(at(7, 0))).toBe(false)
  })
  it('12:00 正午 → 非夜间', () => {
    expect(isNightTime(at(12, 0))).toBe(false)
  })
  it('22:59 → 非夜间（22:00 晚安问候天然豁免）', () => {
    expect(isNightTime(at(22, 59))).toBe(false)
  })
  it('03:00 深夜 → 夜间', () => {
    expect(isNightTime(at(3, 0))).toBe(true)
  })
})

describe('setNightMode 开关与自定义窗口', () => {
  it('enabled=false 时一律不算夜间', () => {
    setNightMode({ enabled: false })
    expect(isNightModeEnabled()).toBe(false)
    expect(isNightTime(at(2, 0))).toBe(false)
  })
  it('自定义同向窗口 1:00–5:00 边界正确', () => {
    setNightMode({ startHour: 1, endHour: 5, enabled: true })
    expect(isNightTime(at(0, 30))).toBe(false)
    expect(isNightTime(at(1, 0))).toBe(true)
    expect(isNightTime(at(4, 59))).toBe(true)
    expect(isNightTime(at(5, 0))).toBe(false)
  })
  it('startHour===endHour 配置无效 → 不抑制（返回 false）', () => {
    setNightMode({ startHour: 3, endHour: 3, enabled: true })
    expect(isNightTime(at(3, 0))).toBe(false)
  })
})

// ────────────────────── 🚪 decideGate 夜间抑制 ──────────────────────
describe('decideGate 夜间勿扰', () => {
  it('isNightMode=true → 一律拒绝（night_mode）', () => {
    const r = decideGate(baseInput({ isNightMode: true }))
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('night_mode')
  })
  it('isNightMode 缺省（旧用例不传）→ 行为不变，正常放行', () => {
    const r = decideGate(baseInput())
    expect(r.allowed).toBe(true)
    expect(r.reason).toBe('scene_idle')
  })
  it('夜间优先级高于未答话头（主动全部抑制）', () => {
    const r = decideGate(baseInput({ isNightMode: true, hasUnfinishedThread: true }))
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('night_mode')
  })
})

// ────────────────────── 🩺 HEALTH_DEFAULTS ──────────────────────
describe('HEALTH_DEFAULTS 默认值', () => {
  it('water/eye/posture 全部默认开启', () => {
    expect(HEALTH_DEFAULTS.water.enabled).toBe(true)
    expect(HEALTH_DEFAULTS.eye.enabled).toBe(true)
    expect(HEALTH_DEFAULTS.posture.enabled).toBe(true)
  })
  it('间隔：water 90 / eye 45 / posture 60 分钟', () => {
    expect(HEALTH_DEFAULTS.water.intervalMinutes).toBe(90)
    expect(HEALTH_DEFAULTS.eye.intervalMinutes).toBe(45)
    expect(HEALTH_DEFAULTS.posture.intervalMinutes).toBe(60)
  })
})

// ────────────────────── 🗣 generator 健康关怀 ──────────────────────
describe('generator 健康关怀台词', () => {
  const genCtx = {
    drives: { energy: 0.8, social: 0.6, curiosity: 0.5, comfort: 0.7 },
    valence: 0.2,
    arousal: 0.4,
    currentMoodLabel: '平静 😐',
    memorySnippet: '',
    recentSpeeches: [] as string[],
    followups: [] as string[],
    innerThought: '',
  }

  it('health 事件把专属 system 片段发给 LLM（不像闹钟）', async () => {
    mockedChat.mockResolvedValueOnce(JSON.stringify({ shouldSpeak: true, action: 'say', speech: '喝点水吧~' }))
    await generateProactive(
      { source: 'health', triggerId: 'health-water', payload: { healthType: 'water' } },
      genCtx,
    )
    const arg = mockedChat.mock.calls[0][0]
    expect(arg.system).toContain('健康关怀')
    expect(arg.system).toContain('禁止')
    expect(arg.user).toContain('喝水')
  })

  it('health=eye 用户上下文带护眼提醒', async () => {
    mockedChat.mockResolvedValueOnce(JSON.stringify({ shouldSpeak: true, action: 'say', speech: '看看远处~' }))
    await generateProactive(
      { source: 'health', triggerId: 'health-eye', payload: { healthType: 'eye' } },
      genCtx,
    )
    expect(mockedChat.mock.calls[0][0].user).toContain('护眼')
  })

  it('LLM 拒绝说话 → 健康关怀也尊重沉默', async () => {
    mockedChat.mockResolvedValueOnce(JSON.stringify({ shouldSpeak: false, reason: '现在不方便' }))
    const d = await generateProactive(
      { source: 'health', payload: { healthType: 'posture' } },
      genCtx,
    )
    expect(d.shouldSpeak).toBe(false)
  })

  it('LLM 挂了 → 走健康兜底，台词自然不生硬', async () => {
    mockedChat.mockRejectedValueOnce(new Error('LLM 超时'))
    const d = await generateProactive(
      { source: 'health', payload: { healthType: 'water' } },
      genCtx,
    )
    expect(d.shouldSpeak).toBe(true)
    expect(d.speech || '').not.toContain('该喝水了')
    expect(d.speech || '').not.toContain('到点了')
    expect(d.reason).toBe('fallback:health:water')
  })
})

// ────────────────────── 🎯 hitArea 反应映射与防抖 ──────────────────────
describe('hitArea 反应映射', () => {
  it('Head → happy/TapBody/摸头台词', () => {
    const r = resolveHitReaction('Head')
    expect(r?.face).toBe('happy')
    expect(r?.motion).toBe('TapBody')
    expect(r?.line).toContain('摸头')
  })
  it('Body → surprise/TapBody/干嘛啦', () => {
    const r = resolveHitReaction('Body')
    expect(r?.face).toBe('surprise')
    expect(r?.line).toContain('干嘛')
  })
  it('大小写不敏感：head / BODY 都能识别', () => {
    expect(normalizeHitArea('head')).toBe('Head')
    expect(normalizeHitArea('BODY')).toBe('Body')
  })
  it('未知部位 → null（退回开聊天窗默认行为）', () => {
    expect(resolveHitReaction('Arm')).toBeNull()
    expect(resolveHitReaction('')).toBeNull()
  })
})

describe('hitArea 3 秒防抖', () => {
  it('同一部位 3 秒内重复 → 被抑制', () => {
    const table: Record<string, number> = { Head: 10_000 }
    expect(isHitThrottled('Head', table, 10_000 + 1_000)).toBe(true)
    expect(isHitThrottled('Head', table, 10_000 + HIT_DEBOUNCE_MS - 1)).toBe(true)
  })
  it('超过 3 秒 → 不抑制', () => {
    const table: Record<string, number> = { Head: 10_000 }
    expect(isHitThrottled('Head', table, 10_000 + HIT_DEBOUNCE_MS)).toBe(false)
  })
  it('从未点过的部位 → 不抑制', () => {
    expect(isHitThrottled('Body', {}, 10_000)).toBe(false)
  })
})
