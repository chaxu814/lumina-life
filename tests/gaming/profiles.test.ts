// ============================================================
// tests/gaming/profiles.test.ts — Profile 注册表与多游戏规则
// ============================================================

import { describe, it, expect } from 'vitest'
import {
  PROFILES,
  getProfile,
  listProfiles,
  detectActiveProfile,
  minecraftProfile,
  factorioProfile,
} from '../../electron/gaming/profiles'
import { reviewChat, reviewGameAction } from '../../electron/gaming/security'

describe('PROFILES 注册表', () => {
  it('注册了 minecraft、factorio 与 generic', () => {
    expect(PROFILES.minecraft).toBeDefined()
    expect(PROFILES.factorio).toBeDefined()
    expect(PROFILES.generic).toBeDefined()
  })

  it('getProfile 返回正确对象', () => {
    expect(getProfile('minecraft')?.displayName).toBe('Minecraft')
    expect(getProfile('factorio')?.displayName).toBe('Factorio')
    expect(getProfile('generic')?.displayName).toBe('通用休闲游戏')
    expect(getProfile('nope')).toBeUndefined()
  })

  it('listProfiles 返回全部 5 个 profile', () => {
    expect(listProfiles().length).toBe(5)
  })
})

describe('detectActiveProfile', () => {
  it('窗口标题包含 Minecraft → minecraft', () => {
    expect(detectActiveProfile('Minecraft 1.20.4')?.id).toBe('minecraft')
  })

  it('窗口标题包含 Factorio → factorio', () => {
    expect(detectActiveProfile('Factorio 1.1.100')?.id).toBe('factorio')
  })

  it('进程名 javaw → minecraft', () => {
    expect(detectActiveProfile(undefined, 'javaw.exe')?.id).toBe('minecraft')
  })

  it('进程名 factorio → factorio', () => {
    expect(detectActiveProfile(undefined, 'factorio')?.id).toBe('factorio')
  })

  it('都不命中 → undefined', () => {
    expect(detectActiveProfile('Chrome', 'chrome.exe')).toBeUndefined()
  })

  it('窗口标题包含 Stardew Valley → stardew-valley', () => {
    expect(detectActiveProfile('Stardew Valley')?.id).toBe('stardew-valley')
  })

  it('窗口标题包含 Civilization VI / Sid Meier → civilization-vi', () => {
    expect(detectActiveProfile("Sid Meier's Civilization VI")?.id).toBe('civilization-vi')
  })
})

describe('Minecraft Profile 动作映射完整性', () => {
  it('包含核心动作', () => {
    const actions = Object.keys(minecraftProfile.actionMap)
    for (const a of ['move_forward', 'move_back', 'move_left', 'move_right', 'jump',
      'sneak', 'attack', 'use', 'place', 'inventory', 'select_slot', 'chat',
      'craft', 'look_at']) {
      expect(actions).toContain(a)
    }
  })

  it('支持 visual 与 bot 路线', () => {
    expect(minecraftProfile.supportedRoutes).toContain('visual')
    expect(minecraftProfile.supportedRoutes).toContain('bot')
  })
})

describe('Factorio Profile 动作映射完整性', () => {
  it('包含核心动作', () => {
    const actions = Object.keys(factorioProfile.actionMap)
    for (const a of ['move_forward', 'move_back', 'move_left', 'move_right',
      'shoot', 'use', 'rotate', 'inventory', 'select_slot', 'chat', 'map', 'look_at']) {
      expect(actions).toContain(a)
    }
  })

  it('仅支持 visual 路线（无 bot API）', () => {
    expect(factorioProfile.supportedRoutes).toEqual(['visual'])
  })
})

describe('Factorio 安全规则', () => {
  it('/c 执行 Lua 被拦截', () => {
    expect(reviewChat('/c game.player.character.die()', factorioProfile).allowed).toBe(false)
  })

  it('/editor 被拦截', () => {
    expect(reviewChat('/editor', factorioProfile).allowed).toBe(false)
  })

  it('/ban 被拦截', () => {
    expect(reviewChat('/ban hacker', factorioProfile).allowed).toBe(false)
  })

  it('/help 白名单放行', () => {
    expect(reviewChat('/help', factorioProfile).allowed).toBe(true)
  })

  it('/players 放行', () => {
    expect(reviewChat('/players', factorioProfile).allowed).toBe(true)
  })

  it('普通聊天放行', () => {
    expect(reviewChat('hello factorio', factorioProfile).allowed).toBe(true)
  })

  it('shoot 为中风险动作', () => {
    expect(reviewGameAction({ action: 'shoot' }, factorioProfile).needsApproval).toBe(true)
  })

  it('select_slot 1-5 范围', () => {
    expect(reviewGameAction({ action: 'select_slot', slot: 5 }, factorioProfile).allowed).toBe(true)
    expect(reviewGameAction({ action: 'select_slot', slot: 6 }, factorioProfile).allowed).toBe(false)
  })
})
