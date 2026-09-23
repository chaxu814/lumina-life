// ============================================================
// tests/gaming/gameActions.test.ts — 统一动作分发 + 视觉路线映射
//
// 全部 mock：
//   - cuCore（截屏/VLM/键鼠）—— 不真实截屏
//   - 平台适配器 —— 不真实操作系统
//   - mineflayer —— 不真实连接服务器
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock electron / screenshot-desktop（cuCore 顶层依赖）──────────────
vi.mock('electron', () => ({
  clipboard: { writeText: vi.fn(), readText: vi.fn(() => '') },
  screen: { getPrimaryDisplay: () => ({ size: { width: 1920, height: 1080 }, scaleFactor: 1 }) },
}))
vi.mock('screenshot-desktop', () => ({ default: vi.fn().mockResolvedValue(Buffer.from([137, 80, 78, 71])) }))

// ── Mock cuCore：拦截截屏/VLM/键鼠原语 ──────────────────────────
const cuMocks = vi.hoisted(() => ({
  captureScreen: vi.fn(),
  callVisionModel: vi.fn(),
  cuPressKey: vi.fn().mockResolvedValue('按键OK'),
  cuType: vi.fn().mockResolvedValue('输入OK'),
  executeCuAction: vi.fn().mockResolvedValue({ ok: true, msg: '点击OK' }),
}))
vi.mock('../../electron/tools/impl/cuCore', () => cuMocks)

// ── Mock 平台适配器 ──────────────────────────────────
vi.mock('../../electron/core/platform', () => ({
  getPlatformAdapter: () => ({
    capabilities: { platform: 'win32', mouse: true, keyboard: true },
    getActiveWindow: vi.fn().mockResolvedValue({ title: 'Minecraft 1.20.4' }),
  }),
}))

// ── Mock mineflayer（动态 import）───────────────────────────
const createBotMock = vi.hoisted(() => vi.fn())
vi.mock('mineflayer', () => ({
  createBot: createBotMock,
  default: { createBot: createBotMock },
}))

import { visualAct } from '../../electron/gaming/visualRoute'
import { executeGameAction, getGameState, resetRouteCache } from '../../electron/gaming/gameActions'
import type { GameConfig } from '../../electron/gaming/types'

const enabledCfg: GameConfig = {
  enabled: true,
  route: 'visual',
  windowTitle: 'Minecraft',
  bot: { host: '', port: 25565, username: 'b', version: '1.20.4', enabled: false },
}
const disabledCfg: GameConfig = { ...enabledCfg, enabled: false }

beforeEach(() => {
  vi.clearAllMocks()
  resetRouteCache()
})

// ── 禁用状态 ──────────────────────────────
describe('模块未启用', () => {
  it('executeGameAction 返回未启用提示', async () => {
    const r = await executeGameAction({ action: 'move_forward' }, disabledCfg)
    expect(r.ok).toBe(false)
    expect(r.content).toContain('未启用')
  })
  it('getGameState 返回未启用提示', async () => {
    const r = await getGameState(disabledCfg)
    expect(r.state.detected).toBe(false)
  })
})

// ── 视觉路线动作映射 ──────────────────────────────
describe('visualAct — 动作映射', () => {
  it('移动 → cuPressKey holdKey 走 w/a/s/d', async () => {
    // holdKey 在 Windows 走 child_process（PowerShell），这里直接验证返回结构
    const r = await visualAct({ action: 'move_forward', durationMs: 300 })
    expect(r.route).toBe('visual')
    expect(r.content).toContain('move_forward')
  })

  it('select_slot → cuPressKey 数字键', async () => {
    const r = await visualAct({ action: 'select_slot', slot: 3 })
    expect(r.content).toContain('3')
  })

  it('inventory → cuPressKey e', async () => {
    await visualAct({ action: 'inventory' })
    expect(cuMocks.cuPressKey).toHaveBeenCalledWith('e')
  })

  it('attack → executeCuAction 左键准星', async () => {
    await visualAct({ action: 'attack' })
    expect(cuMocks.executeCuAction).toHaveBeenCalled()
    const arg = cuMocks.executeCuAction.mock.calls[0][0]
    expect(arg.action_type).toBe('click')
    expect(arg.nx).toBe(50)
    expect(arg.ny).toBe(50)
  })

  it('use → executeCuAction 右键准星', async () => {
    await visualAct({ action: 'use' })
    const arg = cuMocks.executeCuAction.mock.calls[0][0]
    expect(arg.action_type).toBe('right_click')
  })

  it('chat → 按 t + 输入 + 回车', async () => {
    await visualAct({ action: 'chat', text: 'hello' })
    expect(cuMocks.cuPressKey).toHaveBeenCalledWith('t')
    expect(cuMocks.cuType).toHaveBeenCalledWith('hello')
    expect(cuMocks.cuPressKey).toHaveBeenCalledWith('enter')
  })

  it('craft 视觉路线不支持，返回提示', async () => {
    const r = await visualAct({ action: 'craft', itemName: 'torch' })
    expect(r.ok).toBe(false)
    expect(r.content).toContain('不支持')
  })

  it('未知动作返回错误', async () => {
    const r = await visualAct({ action: 'nonexistent' as any })
    expect(r.ok).toBe(false)
  })
})

// ── 安全护栏在分发层生效 ──────────────────────────────
describe('executeGameAction — 安全护栏拦截', () => {
  it('危险聊天命令被拦截，不分发', async () => {
    const r = await executeGameAction({ action: 'chat', text: '/op Steve' }, enabledCfg)
    expect(r.ok).toBe(false)
    expect(r.content).toContain('拦截')
    expect(cuMocks.cuPressKey).not.toHaveBeenCalledWith('t')
  })

  it('select_slot 越界被拦截', async () => {
    const r = await executeGameAction({ action: 'select_slot', slot: 99 }, enabledCfg)
    expect(r.ok).toBe(false)
    expect(r.content).toContain('1-9')
  })

  it('合法移动动作放行分发', async () => {
    const r = await executeGameAction({ action: 'jump' }, enabledCfg)
    expect(r.ok).toBe(true)
  })
})

// ── 路线探测（bot 不可用 → visual）─────────────────────────────
describe('路线探测回退', () => {
  it('bot 不可用时走 visual 路线', async () => {
    const r = await getGameState(enabledCfg)
    expect(r.route).toBe('visual')
  })
})
