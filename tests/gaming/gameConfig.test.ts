// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/gaming/gameConfig.test.ts — 游戏配置解析与路线选择
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest'
import { loadGameConfig, resolveRoute } from '../../electron/gaming/gameConfig'
import type { GameConfig } from '../../electron/gaming/types'

describe('loadGameConfig', () => {
  const saved: Record<string, string | undefined> = {}
  const GAME_KEYS = [
    'LUMINA_GAME_ENABLED', 'LUMINA_GAME_ROUTE', 'LUMINA_GAME_WINDOW_TITLE',
    'LUMINA_MINECRAFT_HOST', 'LUMINA_MINECRAFT_PORT', 'LUMINA_MINECRAFT_USERNAME',
    'LUMINA_MINECRAFT_VERSION',
  ]

  beforeEach(() => {
    for (const k of GAME_KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  })

  it('默认全部关闭，路线 auto', () => {
    const cfg = loadGameConfig()
    expect(cfg.enabled).toBe(false)
    expect(cfg.route).toBe('auto')
    expect(cfg.windowTitle).toBe('Minecraft')
    expect(cfg.bot.enabled).toBe(false)
  })

  it('解析 enabled 布尔值', () => {
    process.env.LUMINA_GAME_ENABLED = 'true'
    expect(loadGameConfig().enabled).toBe(true)
    process.env.LUMINA_GAME_ENABLED = '1'
    expect(loadGameConfig().enabled).toBe(true)
    process.env.LUMINA_GAME_ENABLED = 'false'
    expect(loadGameConfig().enabled).toBe(false)
  })

  it('非法 route 值回退 auto', () => {
    process.env.LUMINA_GAME_ROUTE = 'banana'
    expect(loadGameConfig().route).toBe('auto')
    process.env.LUMINA_GAME_ROUTE = 'BOT'
    expect(loadGameConfig().route).toBe('bot')
  })

  it('端口解析：非法回退 25565', () => {
    process.env.LUMINA_MINECRAFT_PORT = 'notaport'
    expect(loadGameConfig().bot.port).toBe(25565)
    process.env.LUMINA_MINECRAFT_PORT = '99999'
    expect(loadGameConfig().bot.port).toBe(25565)
    process.env.LUMINA_MINECRAFT_PORT = '25566'
    expect(loadGameConfig().bot.port).toBe(25566)
  })

  it('配置 host 才启用 bot', () => {
    process.env.LUMINA_MINECRAFT_HOST = '127.0.0.1'
    const cfg = loadGameConfig()
    expect(cfg.bot.enabled).toBe(true)
    expect(cfg.bot.host).toBe('127.0.0.1')
    expect(cfg.bot.username).toBe('lumina_bot')
    expect(cfg.bot.version).toBe('1.20.4')
  })
})

describe('resolveRoute', () => {
  const base: GameConfig = {
    enabled: true,
    route: 'auto',
    windowTitle: 'Minecraft',
    bot: { host: '127.0.0.1', port: 25565, username: 'b', version: '1.20.4', enabled: true },
  }

  it('visual 路线始终走 visual', () => {
    expect(resolveRoute({ ...base, route: 'visual' }, true)).toBe('visual')
    expect(resolveRoute({ ...base, route: 'visual' }, false)).toBe('visual')
  })

  it('bot 路线：可用走 bot，不可用回退 visual', () => {
    expect(resolveRoute({ ...base, route: 'bot' }, true)).toBe('bot')
    expect(resolveRoute({ ...base, route: 'bot' }, false)).toBe('visual')
  })

  it('auto：bot 可用走 bot', () => {
    expect(resolveRoute(base, true)).toBe('bot')
  })

  it('auto：bot 不可用走 visual', () => {
    expect(resolveRoute(base, false)).toBe('visual')
  })

  it('bot 未配置 host → 即使 route=bot 也 visual', () => {
    const noBot: GameConfig = { ...base, bot: { ...base.bot, host: '', enabled: false } }
    expect(resolveRoute(noBot, true)).toBe('visual')
  })
})
