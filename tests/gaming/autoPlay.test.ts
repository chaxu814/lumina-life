// ============================================================
// tests/gaming/autoPlay.test.ts — 自主游玩闭环
//
// 全部 mock getGameState / executeGameAction / reviewGameAction
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  clipboard: { writeText: vi.fn(), readText: vi.fn(() => '') },
  screen: { getPrimaryDisplay: () => ({ size: { width: 1920, height: 1080 }, scaleFactor: 1 }) },
}))
vi.mock('screenshot-desktop', () => ({ default: vi.fn() }))

// Mock gameActions：getGameState / executeGameAction
const gameMocks = vi.hoisted(() => ({
  getGameState: vi.fn(),
  executeGameAction: vi.fn(),
}))
vi.mock('../../electron/gaming/gameActions', async () => {
  const actual = await vi.importActual<any>('../../electron/gaming/gameActions')
  return {
    ...actual,
    getGameState: gameMocks.getGameState,
    executeGameAction: gameMocks.executeGameAction,
  }
})

// Mock security：reviewGameAction
const securityMocks = vi.hoisted(() => ({
  reviewGameAction: vi.fn(),
}))
vi.mock('../../electron/gaming/security', async () => {
  const actual = await vi.importActual<any>('../../electron/gaming/security')
  return {
    ...actual,
    reviewGameAction: securityMocks.reviewGameAction,
  }
})

import { runAutoPlay } from '../../electron/gaming/autoPlay'
import { minecraftProfile } from '../../electron/gaming/profiles'
import type { GameConfig, GameState } from '../../electron/gaming/types'

const enabledCfg: GameConfig = {
  enabled: true,
  route: 'visual',
  windowTitle: 'Minecraft',
  bot: { host: '', port: 25565, username: 'b', version: '1.20.4', enabled: false },
}
const disabledCfg: GameConfig = { ...enabledCfg, enabled: false }

const okState: GameState = { detected: true, hotbar: [] }

beforeEach(() => {
  vi.clearAllMocks()
  gameMocks.getGameState.mockResolvedValue({ state: okState, route: 'visual', text: '', profile: minecraftProfile })
  gameMocks.executeGameAction.mockResolvedValue({ ok: true, content: 'done' })
  securityMocks.reviewGameAction.mockReturnValue({ allowed: true })
})

describe('runAutoPlay', () => {
  it('disabled config 直接返回', async () => {
    const r = await runAutoPlay({ profile: minecraftProfile, config: disabledCfg })
    expect(r.stopped).toBe(true)
    expect(r.roundsPlayed).toBe(0)
    expect(r.stopReason).toContain('未启用')
  })

  it('正常执行到 maxRounds 停止', async () => {
    const decide = vi.fn().mockResolvedValue({ action: 'move_forward' })
    const r = await runAutoPlay({
      profile: minecraftProfile,
      config: enabledCfg,
      maxRounds: 3,
      maxDurationMs: 60000,
      minIntervalMs: 0,
      decide,
    })
    expect(r.roundsPlayed).toBe(3)
    expect(r.actionsExecuted).toBe(3)
    expect(r.stopReason).toContain('最大轮数')
    expect(decide).toHaveBeenCalledTimes(3)
  })

  it('stopSignal 紧急中断', async () => {
    const stopSignal = { stopped: false }
    const decide = vi.fn()
      .mockResolvedValueOnce({ action: 'move_forward' })
      .mockImplementationOnce(async () => {
        stopSignal.stopped = true
        return { action: 'move_forward' }
      })
    const r = await runAutoPlay({
      profile: minecraftProfile,
      config: enabledCfg,
      maxRounds: 10,
      maxDurationMs: 60000,
      minIntervalMs: 0,
      decide,
      stopSignal,
    })
    expect(r.roundsPlayed).toBe(2)
    expect(r.stopReason).toContain('外部停止')
  })

  it('连续 3 轮危险动作被拦后停止', async () => {
    securityMocks.reviewGameAction.mockReturnValue({ allowed: false, reason: '危险' })
    const decide = vi.fn().mockResolvedValue({ action: 'chat', text: '/op x' })
    const r = await runAutoPlay({
      profile: minecraftProfile,
      config: enabledCfg,
      maxRounds: 10,
      maxDurationMs: 60000,
      minIntervalMs: 0,
      decide,
    })
    expect(r.dangerousBlocked).toBeGreaterThanOrEqual(3)
    expect(r.stopReason).toContain('被拦')
    expect(gameMocks.executeGameAction).not.toHaveBeenCalled()
  })

  it('决策返回 null 时停止（grace=0）', async () => {
    const decide = vi.fn().mockResolvedValue(null)
    const r = await runAutoPlay({
      profile: minecraftProfile,
      config: enabledCfg,
      maxRounds: 10,
      minIntervalMs: 0,
      nullDecideGrace: 0,
      decide,
    })
    expect(r.roundsPlayed).toBe(1)
    expect(r.stopReason).toContain('停止')
    expect(r.actionsExecuted).toBe(0)
  })

  it('nullDecideGrace 内容错重试，超 grace 才停止', async () => {
    const decide = vi.fn().mockResolvedValue(null)
    const focusTarget = vi.fn().mockResolvedValue(true)
    const r = await runAutoPlay({
      profile: minecraftProfile,
      config: enabledCfg,
      maxRounds: 10,
      minIntervalMs: 0,
      nullDecideGrace: 2,
      focusTarget,
      decide,
    })
    expect(r.roundsPlayed).toBe(3) // grace 2 次重试 + 第 3 次停止
    expect(r.stopReason).toContain('停止')
    expect(focusTarget.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('超时停止', async () => {
    // 第 1 轮后模拟超时：通过 maxDurationMs=0 让循环立即超时
    const decide = vi.fn().mockResolvedValue({ action: 'move_forward' })
    const r = await runAutoPlay({
      profile: minecraftProfile,
      config: enabledCfg,
      maxRounds: 10,
      maxDurationMs: 1, // 极短，第一轮检查时已超时
      minIntervalMs: 0,
      decide,
    })
    expect(r.stopReason).toContain('时长')
  })
})
