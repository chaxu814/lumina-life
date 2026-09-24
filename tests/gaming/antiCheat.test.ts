// ============================================================
// tests/gaming/antiCheat.test.ts — 反作弊游戏黑名单
//
// 覆盖：黑名单匹配、autoPlay 自动拦截、提示文案。
// autoPlay 部分 mock gameActions / security，只注入 getWindowTitle。
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  clipboard: { writeText: vi.fn(), readText: vi.fn(() => '') },
  screen: { getPrimaryDisplay: () => ({ size: { width: 1920, height: 1080 }, scaleFactor: 1 }) },
}))
vi.mock('screenshot-desktop', () => ({ default: vi.fn() }))

const gameMocks = vi.hoisted(() => ({
  getGameState: vi.fn(),
  executeGameAction: vi.fn(),
}))
vi.mock('../../electron/gaming/gameActions', async () => {
  const actual = await vi.importActual<any>('../../electron/gaming/gameActions')
  return { ...actual, getGameState: gameMocks.getGameState, executeGameAction: gameMocks.executeGameAction }
})

const securityMocks = vi.hoisted(() => ({ reviewGameAction: vi.fn() }))
vi.mock('../../electron/gaming/security', async () => {
  const actual = await vi.importActual<any>('../../electron/gaming/security')
  return { ...actual, reviewGameAction: securityMocks.reviewGameAction }
})

import {
  detectAntiCheatGame,
  isAntiCheatGame,
  ANTI_CHEAT_GAMES,
} from '../../electron/gaming/antiCheat'
import { SAFETY_PROMPT_ANTI_CHEAT } from '../../electron/gaming/safetyPrompt'
import { runAutoPlay } from '../../electron/gaming/autoPlay'
import { minecraftProfile } from '../../electron/gaming/profiles'
import type { GameConfig, GameState } from '../../electron/gaming/types'

const enabledCfg: GameConfig = {
  enabled: true,
  route: 'visual',
  windowTitle: 'Minecraft',
  bot: { host: '', port: 25565, username: 'b', version: '1.20.4', enabled: false },
}
const okState: GameState = { detected: true, hotbar: [] }

beforeEach(() => {
  vi.clearAllMocks()
  gameMocks.getGameState.mockResolvedValue({ state: okState, route: 'visual', text: '', profile: minecraftProfile })
  gameMocks.executeGameAction.mockResolvedValue({ ok: true, content: 'done' })
  securityMocks.reviewGameAction.mockReturnValue({ allowed: true })
})

describe('detectAntiCheatGame 黑名单匹配', () => {
  it('命中 CS2 / Valorant / PUBG / Fortnite / Apex', () => {
    expect(detectAntiCheatGame('Counter-Strike 2')).toBeTruthy()
    expect(detectAntiCheatGame('VALORANT')).toBeTruthy()
    expect(detectAntiCheatGame('PUBG: Battlegrounds')).toBeTruthy()
    expect(detectAntiCheatGame('Fortnite')).toBeTruthy()
    expect(detectAntiCheatGame('Apex Legends')).toBeTruthy()
  })

  it('单机游戏 / 空标题不命中', () => {
    expect(detectAntiCheatGame('Minecraft 1.20.4')).toBeNull()
    expect(detectAntiCheatGame('Stardew Valley')).toBeNull()
    expect(detectAntiCheatGame('Civilization VI')).toBeNull()
    expect(detectAntiCheatGame('')).toBeNull()
    expect(detectAntiCheatGame(undefined)).toBeNull()
  })

  it('isAntiCheatGame 布尔别名', () => {
    expect(isAntiCheatGame('valorant')).toBe(true)
    expect(isAntiCheatGame('factorio')).toBe(false)
  })

  it('黑名单非空且每条都有名字和正则', () => {
    expect(ANTI_CHEAT_GAMES.length).toBeGreaterThanOrEqual(8)
    for (const g of ANTI_CHEAT_GAMES) {
      expect(g.name).toBeTruthy()
      expect(g.windowMatch).toBeInstanceOf(RegExp)
    }
  })
})

describe('autoPlay 反作弊自动拦截', () => {
  it('前台窗口命中黑名单 → 第一轮即停止，stopReason=anti_cheat_detected', async () => {
    const decide = vi.fn().mockResolvedValue({ action: 'move_forward' })
    const r = await runAutoPlay({
      profile: minecraftProfile,
      config: enabledCfg,
      maxRounds: 10,
      maxDurationMs: 60000,
      minIntervalMs: 0,
      decide,
      // 前台窗口是 Valorant
      getWindowTitle: async () => 'VALORANT  -  Matchmaking',
      focusTarget: async () => true,
    })
    expect(r.stopReason).toContain('anti_cheat_detected')
    expect(r.roundsPlayed).toBe(1)
    expect(r.actionsExecuted).toBe(0)
    expect(decide).not.toHaveBeenCalled()
  })

  it('前台窗口是单机游戏 → 正常跑不拦截', async () => {
    const decide = vi.fn().mockResolvedValue({ action: 'move_forward' })
    const r = await runAutoPlay({
      profile: minecraftProfile,
      config: enabledCfg,
      maxRounds: 2,
      maxDurationMs: 60000,
      minIntervalMs: 0,
      decide,
      getWindowTitle: async () => 'Minecraft 1.20.4',
      focusTarget: async () => true,
    })
    expect(r.stopReason).not.toContain('anti_cheat')
    expect(r.actionsExecuted).toBe(2)
  })
})

describe('反作弊提示文案', () => {
  it('包含封号风险 / 已停止 / 单机游戏', () => {
    expect(SAFETY_PROMPT_ANTI_CHEAT).toMatch(/反作弊/)
    expect(SAFETY_PROMPT_ANTI_CHEAT).toMatch(/封/)
    expect(SAFETY_PROMPT_ANTI_CHEAT).toMatch(/已自动停止/)
    expect(SAFETY_PROMPT_ANTI_CHEAT).toContain('{gameName}')
  })
})
