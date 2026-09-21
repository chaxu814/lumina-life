import { describe, it, expect } from 'vitest'
import {
  deriveBehaviorHints,
  type ExpressionContext,
} from '../electron/pet/life/emotionExpressions'
import {
  coldStateFromDays,
  getColdWar,
  COLD_AFTER_DAYS,
} from '../electron/pet/life/coldWar'
import type { CoreEmotion } from '../electron/pet/life/emotionCore'

/** 一个中性情绪基线：焦虑/疲劳都不高 */
function baseEmotion(overrides: Partial<CoreEmotion> = {}): Pick<CoreEmotion, 'anxiety' | 'fatigue' | 'valence' | 'arousal'> {
  return {
    valence: 0.05,
    arousal: 0.4,
    anxiety: 0.2,
    fatigue: 0.3,
    ...overrides,
  }
}

const warmCtx: ExpressionContext = { coldState: 'warm', userSpokeWithin24h: false }

describe('emotionExpressions 情绪外显', () => {
  it('焦虑 > 0.6 → 话术变短 speechShort=true', () => {
    const h = deriveBehaviorHints(baseEmotion({ anxiety: 0.7 }), warmCtx)
    expect(h.speechShort).toBe(true)
  })

  it('焦虑 ≤ 0.6 → 话术正常', () => {
    const h = deriveBehaviorHints(baseEmotion({ anxiety: 0.4 }), warmCtx)
    expect(h.speechShort).toBe(false)
  })

  it('疲劳 > 0.6 → 桌宠变淡 opacity < 1', () => {
    const h = deriveBehaviorHints(baseEmotion({ fatigue: 0.8 }), warmCtx)
    expect(h.petOpacity).toBeLessThan(1)
    expect(h.petOpacity).toBe(0.7)
  })

  it('疲劳正常 → 透明度为 1', () => {
    const h = deriveBehaviorHints(baseEmotion({ fatigue: 0.3 }), warmCtx)
    expect(h.petOpacity).toBe(1)
  })

  it('冷战（cold）且未被哄 → 转身背对、不主动搭话', () => {
    const h = deriveBehaviorHints(baseEmotion(), { coldState: 'cold', userSpokeWithin24h: false })
    expect(h.petAction).toBe('turnaway')
    expect(h.initiativeTendency).toBe(0)
  })

  it('刚被哄好（cooling 状态下 24h 内搭话）→ 精神一振(原谅)', () => {
    const h = deriveBehaviorHints(baseEmotion(), { coldState: 'cooling', userSpokeWithin24h: true })
    expect(h.petAction).toBe('perk')
    expect(h.initiativeTendency).toBeGreaterThan(0.6)
  })

  it('疲劳但未冷战 → 叹气 sigh', () => {
    const h = deriveBehaviorHints(baseEmotion({ fatigue: 0.75 }), warmCtx)
    expect(h.petAction).toBe('sigh')
  })

  it('一切正常 → 待机 idle', () => {
    const h = deriveBehaviorHints(baseEmotion(), warmCtx)
    expect(h.petAction).toBe('idle')
  })
})

describe('coldWar 冷战状态机', () => {
  it('< 1 天 → warm', () => {
    expect(coldStateFromDays(0)).toBe('warm')
    expect(coldStateFromDays(0.5)).toBe('warm')
  })

  it('1~3 天 → cooling', () => {
    expect(coldStateFromDays(1)).toBe('cooling')
    expect(coldStateFromDays(2.5)).toBe('cooling')
    expect(coldStateFromDays(COLD_AFTER_DAYS)).toBe('cooling')
  })

  it('> 3 天 → cold', () => {
    expect(coldStateFromDays(3.1)).toBe('cold')
    expect(coldStateFromDays(10)).toBe('cold')
  })

  it('Tracker：markUserInteraction 后回到 warm / 24h 内标记为刚搭话', () => {
    const c = getColdWar()
    const now = Date.now()
    c.reset(now)
    expect(c.getState(now)).toBe('warm')
    expect(c.userSpokeWithin24h(now)).toBe(true)
    // 模拟过了 5 天没人理
    const fiveDaysLater = now + 5 * 24 * 60 * 60 * 1000
    expect(c.getState(fiveDaysLater)).toBe('cold')
    expect(c.userSpokeWithin24h(fiveDaysLater)).toBe(false)
    // 用户又来搭话 → 原谅
    c.markUserInteraction(fiveDaysLater)
    expect(c.userSpokeWithin24h(fiveDaysLater)).toBe(true)
    expect(c.getState(fiveDaysLater)).toBe('warm')
  })
})
