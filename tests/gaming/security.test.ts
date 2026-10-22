// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/gaming/security.test.ts — 游戏安全护栏
// ============================================================

import { describe, it, expect } from 'vitest'
import { reviewChat, reviewGameAction, reviewBotConnection } from '../../electron/gaming/security'

describe('reviewChat — 危险命令拦截', () => {
  it('普通聊天放行', () => {
    expect(reviewChat('你好').allowed).toBe(true)
    expect(reviewChat('hello world').allowed).toBe(true)
  })

  it('空内容拒绝', () => {
    expect(reviewChat('').allowed).toBe(false)
    expect(reviewChat(undefined).allowed).toBe(false)
  })

  it('拦截管理员命令 /op /deop', () => {
    expect(reviewChat('/op Steve').allowed).toBe(false)
    expect(reviewChat('/deop Steve').allowed).toBe(false)
  })

  it('拦截服务器控制命令 /stop /restart', () => {
    expect(reviewChat('/stop').allowed).toBe(false)
    expect(reviewChat('/restart').allowed).toBe(false)
  })

  it('拦截批量击杀 /kill @e', () => {
    expect(reviewChat('/kill @e').allowed).toBe(false)
    expect(reviewChat('/kill @a').allowed).toBe(false)
  })

  it('拦截白名单/封禁命令', () => {
    expect(reviewChat('/ban hacker').allowed).toBe(false)
    expect(reviewChat('/whitelist add x').allowed).toBe(false)
  })

  it('拦截大范围改方块 /fill /setblock', () => {
    expect(reviewChat('/fill 0 0 0 100 100 100 air').allowed).toBe(false)
  })

  it('安全命令白名单放行', () => {
    expect(reviewChat('/help').allowed).toBe(true)
    expect(reviewChat('/list').allowed).toBe(true)
  })

  it('其它斜杠命令标记需审批（不阻断）', () => {
    const r = reviewChat('/give Steve diamond 10')
    expect(r.allowed).toBe(true)
    expect(r.needsApproval).toBe(true)
  })
})

describe('reviewGameAction — 参数校验', () => {
  it('缺少 action 拒绝', () => {
    expect(reviewGameAction({ action: '' } as any).allowed).toBe(false)
  })

  it('select_slot 范围校验', () => {
    expect(reviewGameAction({ action: 'select_slot', slot: 1 }).allowed).toBe(true)
    expect(reviewGameAction({ action: 'select_slot', slot: 9 }).allowed).toBe(true)
    expect(reviewGameAction({ action: 'select_slot', slot: 0 }).allowed).toBe(false)
    expect(reviewGameAction({ action: 'select_slot', slot: 10 }).allowed).toBe(false)
  })

  it('look_at 角度范围校验', () => {
    expect(reviewGameAction({ action: 'look_at', yaw: 0, pitch: 0 }).allowed).toBe(true)
    expect(reviewGameAction({ action: 'look_at', yaw: 200 }).allowed).toBe(false)
    expect(reviewGameAction({ action: 'look_at', pitch: -100 }).allowed).toBe(false)
  })

  it('中风险动作标记需审批', () => {
    expect(reviewGameAction({ action: 'attack' }).needsApproval).toBe(true)
    expect(reviewGameAction({ action: 'place' }).needsApproval).toBe(true)
    expect(reviewGameAction({ action: 'craft' }).needsApproval).toBe(true)
  })

  it('移动/跳跃等低风险动作放行', () => {
    expect(reviewGameAction({ action: 'move_forward' }).allowed).toBe(true)
    expect(reviewGameAction({ action: 'jump' }).allowed).toBe(true)
    expect(reviewGameAction({ action: 'sneak' }).allowed).toBe(true)
  })

  it('chat 动作委托给 reviewChat', () => {
    expect(reviewGameAction({ action: 'chat', text: '/op x' }).allowed).toBe(false)
    expect(reviewGameAction({ action: 'chat', text: 'hi' }).allowed).toBe(true)
  })
})

describe('reviewBotConnection', () => {
  it('空 host 拒绝', () => {
    expect(reviewBotConnection('', 'bot').allowed).toBe(false)
  })

  it('本地服务器放行', () => {
    expect(reviewBotConnection('127.0.0.1', 'lumina_bot').allowed).toBe(true)
  })

  it('拦截认证服务器域名', () => {
    expect(reviewBotConnection('auth.xboxlive.com', 'bot').allowed).toBe(false)
  })

  it('空 username 拒绝', () => {
    expect(reviewBotConnection('127.0.0.1', '').allowed).toBe(false)
  })
})
