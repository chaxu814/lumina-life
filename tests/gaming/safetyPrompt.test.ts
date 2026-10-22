// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/gaming/safetyPrompt.test.ts — 温馨安全提示
// ============================================================

import { describe, it, expect } from 'vitest'
import {
  loadSafetyPromptState,
  acknowledgeSafetyPrompt,
  SAFETY_PROMPT_GAME_CAPABILITY,
  SAFETY_PROMPT_AUTO_PLAY,
} from '../../electron/gaming/safetyPrompt'

/** 内存 Storage 实现（测试用） */
function memoryStorage(): Storage {
  const m = new Map<string, string>()
  return {
    get length() { return m.size },
    clear: () => m.clear(),
    getItem: (k: string) => m.get(k) ?? null,
    key: (i: number) => Array.from(m.keys())[i] ?? null,
    removeItem: (k: string) => m.delete(k),
    setItem: (k: string, v: string) => void m.set(k, v),
  }
}

describe('loadSafetyPromptState', () => {
  it('默认未确认', () => {
    const s = loadSafetyPromptState(memoryStorage())
    expect(s.gameCapabilityAcknowledged).toBe(false)
    expect(s.autoPlayAcknowledged).toBe(false)
  })
})

describe('acknowledgeSafetyPrompt', () => {
  it('确认 game 后持久化', () => {
    const st = memoryStorage()
    acknowledgeSafetyPrompt('game', st)
    const s = loadSafetyPromptState(st)
    expect(s.gameCapabilityAcknowledged).toBe(true)
    expect(s.autoPlayAcknowledged).toBe(false)
    expect(s.acknowledgedAt).toBeDefined()
  })

  it('确认 autoplay 后与 game 独立', () => {
    const st = memoryStorage()
    acknowledgeSafetyPrompt('autoplay', st)
    const s = loadSafetyPromptState(st)
    expect(s.autoPlayAcknowledged).toBe(true)
    expect(s.gameCapabilityAcknowledged).toBe(false)
  })

  it('两次确认互不覆盖', () => {
    const st = memoryStorage()
    acknowledgeSafetyPrompt('game', st)
    acknowledgeSafetyPrompt('autoplay', st)
    const s = loadSafetyPromptState(st)
    expect(s.gameCapabilityAcknowledged).toBe(true)
    expect(s.autoPlayAcknowledged).toBe(true)
  })
})

describe('提示文案包含关键安全信息', () => {
  it('game capability 文案包含反作弊/多人/人在旁边', () => {
    expect(SAFETY_PROMPT_GAME_CAPABILITY).toMatch(/反作弊|BattlEye|EAC|VAC/)
    expect(SAFETY_PROMPT_GAME_CAPABILITY).toMatch(/多人/)
    expect(SAFETY_PROMPT_GAME_CAPABILITY).toMatch(/人在旁边|照看/)
  })

  it('autoplay 文案包含人在旁边/反作弊/随时停', () => {
    expect(SAFETY_PROMPT_AUTO_PLAY).toMatch(/人在旁边|照看/)
    expect(SAFETY_PROMPT_AUTO_PLAY).toMatch(/反作弊/)
    expect(SAFETY_PROMPT_AUTO_PLAY).toMatch(/停/)
  })
})
