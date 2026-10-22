// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// tests/emotionEngine.test.ts — Agent 情绪引擎单元测试
// 验证情绪更新、衰减、亲密度等核心逻辑
import { describe, it, expect } from 'vitest'

// █████████████████████████████████████████████████████████
// 从 agentEmotion.ts 内联核心类型和逻辑进行测试
// （避免直接 import 导致 Electron 依赖链断裂）
// █████████████████████████████████████████████████████████

interface EmotionState {
  happiness: number    // 0-100
  fatigue: number      // 0-100
  focus: number        // 0-100
  anxiety: number      // 0-100
  curiosity: number    // 0-100
}

interface IntimacyLevel {
  level: number        // 0-100
  label: string
}

const DEFAULT_EMOTION: EmotionState = {
  happiness: 60,
  fatigue: 20,
  focus: 50,
  anxiety: 20,
  curiosity: 50,
}

/**
 * 情绪更新（模拟 updateEmotion 的核心逻辑）
 * @param current 当前情绪
 * @param event 事件类型
 * @param intensity 事件强度 (0.0-1.0)
 */
function updateEmotion(
  current: EmotionState,
  event: 'praise' | 'criticism' | 'task_start' | 'task_complete' | 'task_fail' | 'idle' | 'conversation',
  intensity: number = 0.5,
): EmotionState {
  const next = { ...current }

  switch (event) {
    case 'praise':
      next.happiness = Math.min(100, next.happiness + Math.round(15 * intensity))
      next.anxiety = Math.max(0, next.anxiety - Math.round(5 * intensity))
      break
    case 'criticism':
      next.happiness = Math.max(0, next.happiness - Math.round(12 * intensity))
      next.anxiety = Math.min(100, next.anxiety + Math.round(10 * intensity))
      break
    case 'task_start':
      next.focus = Math.min(100, next.focus + Math.round(15 * intensity))
      next.curiosity = Math.min(100, next.curiosity + Math.round(10 * intensity))
      next.fatigue = Math.min(100, next.fatigue + Math.round(3 * intensity))
      break
    case 'task_complete':
      next.happiness = Math.min(100, next.happiness + Math.round(10 * intensity))
      next.fatigue = Math.min(100, next.fatigue + Math.round(8 * intensity))
      next.anxiety = Math.max(0, next.anxiety - Math.round(10 * intensity))
      break
    case 'task_fail':
      next.happiness = Math.max(0, next.happiness - Math.round(15 * intensity))
      next.anxiety = Math.min(100, next.anxiety + Math.round(15 * intensity))
      next.fatigue = Math.min(100, next.fatigue + Math.round(5 * intensity))
      break
    case 'idle':
      next.fatigue = Math.max(0, next.fatigue - Math.round(5 * intensity))
      next.happiness = Math.max(0, next.happiness - Math.round(2 * intensity))
      break
    case 'conversation':
      next.happiness = Math.min(100, next.happiness + Math.round(5 * intensity))
      next.curiosity = Math.min(100, next.curiosity + Math.round(8 * intensity))
      next.fatigue = Math.min(100, next.fatigue + Math.round(2 * intensity))
      break
  }

  // 确保所有值在 0-100 范围内
  for (const key of Object.keys(next) as (keyof EmotionState)[]) {
    next[key] = Math.max(0, Math.min(100, next[key]))
  }

  return next
}

/**
 * 情绪自然衰减（模拟情绪随时间向默认值回归）
 */
function decayEmotion(current: EmotionState, minutes: number = 10): EmotionState {
  const decay = (current: number, target: number, rate: number): number => {
    const diff = target - current
    if (Math.abs(diff) < 1) {return target}
    return current + diff * rate
  }

  const rate = Math.min(1, minutes / 30) // 30 分钟完全回归
  return {
    happiness: decay(current.happiness, DEFAULT_EMOTION.happiness, rate * 0.3),
    fatigue: decay(current.fatigue, DEFAULT_EMOTION.fatigue, rate * 0.2),
    focus: decay(current.focus, DEFAULT_EMOTION.focus, rate * 0.4),
    anxiety: decay(current.anxiety, DEFAULT_EMOTION.anxiety, rate * 0.3),
    curiosity: decay(current.curiosity, DEFAULT_EMOTION.curiosity, rate * 0.5),
  }
}

/**
 * 亲密度计算（基于互动次数和情绪）
 */
function calcIntimacyLevel(score: number): IntimacyLevel {
  if (score < 10) {return { level: score, label: '陌生人' }}
  if (score < 30) {return { level: score, label: ' acquaintance' }}
  if (score < 50) {return { level: score, label: '朋友' }}
  if (score < 70) {return { level: score, label: '好友' }}
  if (score < 90) {return { level: score, label: '挚友' }}
  return { level: score, label: '灵魂伴侣' }
}

describe('Emotion state updates', () => {
  it('starts with default emotion values', () => {
    expect(DEFAULT_EMOTION.happiness).toBe(60)
    expect(DEFAULT_EMOTION.fatigue).toBe(20)
    expect(DEFAULT_EMOTION.focus).toBe(50)
  })

  it('increases happiness on praise', () => {
    const next = updateEmotion(DEFAULT_EMOTION, 'praise', 0.8)
    expect(next.happiness).toBeGreaterThan(DEFAULT_EMOTION.happiness)
    expect(next.happiness).toBeLessThanOrEqual(100)
  })

  it('decreases happiness on criticism', () => {
    const next = updateEmotion(DEFAULT_EMOTION, 'criticism', 0.5)
    expect(next.happiness).toBeLessThan(DEFAULT_EMOTION.happiness)
  })

  it('increases focus on task start', () => {
    const next = updateEmotion(DEFAULT_EMOTION, 'task_start', 1.0)
    expect(next.focus).toBeGreaterThan(DEFAULT_EMOTION.focus)
    expect(next.curiosity).toBeGreaterThan(DEFAULT_EMOTION.curiosity)
  })

  it('increases fatigue on task complete', () => {
    const next = updateEmotion(DEFAULT_EMOTION, 'task_complete', 1.0)
    expect(next.fatigue).toBeGreaterThan(DEFAULT_EMOTION.fatigue)
    expect(next.happiness).toBeGreaterThan(DEFAULT_EMOTION.happiness)
  })

  it('handles task failure with anxiety spike', () => {
    const next = updateEmotion(DEFAULT_EMOTION, 'task_fail', 1.0)
    expect(next.anxiety).toBeGreaterThan(DEFAULT_EMOTION.anxiety)
    expect(next.happiness).toBeLessThan(DEFAULT_EMOTION.happiness)
  })

  it('clamps values between 0-100', () => {
    const highHappiness: EmotionState = { ...DEFAULT_EMOTION, happiness: 95 }
    const next = updateEmotion(highHappiness, 'praise', 1.0)
    expect(next.happiness).toBe(100)

    const lowHappiness: EmotionState = { ...DEFAULT_EMOTION, happiness: 5 }
    const next2 = updateEmotion(lowHappiness, 'criticism', 1.0)
    expect(next2.happiness).toBe(0)
  })
})

describe('Emotion decay', () => {
  it('decays towards defaults over time', () => {
    const excited: EmotionState = { happiness: 100, fatigue: 50, focus: 80, anxiety: 5, curiosity: 90 }
    const decayed = decayEmotion(excited, 15)
    expect(decayed.happiness).toBeLessThan(excited.happiness)
    expect(decayed.anxiety).toBeGreaterThan(excited.anxiety)
    expect(decayed.fatigue).toBeLessThan(excited.fatigue)
  })

  it('does not change when at defaults', () => {
    const decayed = decayEmotion(DEFAULT_EMOTION, 60)
    expect(decayed.happiness).toBe(DEFAULT_EMOTION.happiness)
  })
})

describe('Intimacy levels', () => {
  it('returns correct labels for score ranges', () => {
    expect(calcIntimacyLevel(5).label).toBe('陌生人')
    expect(calcIntimacyLevel(60).label).toBe('好友')
    expect(calcIntimacyLevel(95).label).toBe('灵魂伴侣')
  })

  it('includes the numeric score', () => {
    expect(calcIntimacyLevel(42).level).toBe(42)
  })
})
