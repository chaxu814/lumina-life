// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/gaming/gameCompanionExtension.test.ts
//
// 验证发行版未内置 mineflayer（已移至 devDependencies）时，游戏工具
// 返回友好的「可选扩展」状态，而不是报错或未捕获异常。
//
// 手法：把 mineflayer 的动态 import mock 为失败（模拟未安装）。
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock electron / screenshot-desktop ──────────────
vi.mock('electron', () => ({
  clipboard: { writeText: vi.fn(), readText: vi.fn(() => '') },
  screen: { getPrimaryDisplay: () => ({ size: { width: 1920, height: 1080 }, scaleFactor: 1 }) },
}))
vi.mock('screenshot-desktop', () => ({ default: vi.fn().mockResolvedValue(Buffer.from([137, 80, 78, 71])) }))

// ── Mock cuCore ──────────────────────────────────
vi.mock('../../electron/tools/impl/cuCore', () => ({
  captureScreen: vi.fn(),
  callVisionModel: vi.fn(),
  cuPressKey: vi.fn().mockResolvedValue('按键OK'),
  cuType: vi.fn().mockResolvedValue('输入OK'),
  executeCuAction: vi.fn().mockResolvedValue({ ok: true, msg: '点击OK' }),
}))

// ── Mock 平台适配器 ──────────────────────────────────
vi.mock('../../electron/core/platform', () => ({
  getPlatformAdapter: () => ({
    capabilities: { platform: 'win32', mouse: true, keyboard: true },
    getActiveWindow: vi.fn().mockResolvedValue({ title: 'Minecraft 1.20.4' }),
  }),
}))

// ── mineflayer 模拟「未安装」：动态 import 直接抛错 ─────────────
vi.mock('mineflayer', () => {
  throw new Error("Cannot find module 'mineflayer'")
})

import { executeGameAction, getGameState, resetRouteCache } from '../../electron/gaming/gameActions'
import { gameAuto } from '../../electron/gaming'
import type { GameConfig } from '../../electron/gaming/types'

const enabledCfg: GameConfig = {
  enabled: true,
  route: 'auto',
  windowTitle: 'Minecraft',
  bot: { host: 'localhost', port: 25565, username: 'b', version: '1.20.4', enabled: true },
}

beforeEach(() => {
  vi.clearAllMocks()
  resetRouteCache()
})

describe('发行版缺少 mineflayer（游戏陪伴扩展）', () => {
  it('getGameState 返回友好的可选扩展提示', async () => {
    const r = await getGameState(enabledCfg)
    expect(r.route).toBe('visual')
    expect(r.state.detected).toBe(false)
    expect(r.text).toContain('可选扩展')
    expect(r.text).toContain('mineflayer')
  })

  it('executeGameAction 返回友好的扩展提示，不执行动作', async () => {
    const r = await executeGameAction({ action: 'move_forward', durationMs: 300 }, enabledCfg)
    expect(r.ok).toBe(false)
    expect(r.error).toBe('game_companion_extension')
    expect(r.content).toContain('可选扩展')
  })

  it('game_auto 直接返回扩展提示，不空转', async () => {
    const r = await gameAuto({ max_rounds: 3 })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('game_companion_extension')
    expect(r.content).toContain('可选扩展')
  })
})
