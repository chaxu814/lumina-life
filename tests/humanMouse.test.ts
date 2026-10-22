// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// tests/humanMouse.test.ts — 拟人化鼠标移动单测
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  buildHumanPath, easeOutCubic, isInstantMouse,
  humanMoveTo, humanClick, humanHover, humanDrag,
} from '../electron/tools/impl/humanMouse'
import type { PlatformAdapter } from '../electron/core/platform/PlatformAdapter'

function makeMockAdapter(overrides: Partial<PlatformAdapter> = {}): PlatformAdapter {
  return {
    label: 'mock',
    click: async () => 'ok',
    mouseMove: vi.fn(async () => 'moved'),
    mouseClick: vi.fn(async () => 'clicked'),
    mouseHover: vi.fn(async () => 'hovered'),
    mouseDrag: vi.fn(async () => 'dragged'),
    mouseLongPress: vi.fn(async () => 'pressed'),
    mouseScroll: vi.fn(async () => 'scrolled'),
    keyboardType: vi.fn(async () => 'typed'),
    keyPress: vi.fn(async () => 'pressed'),
    screenshot: vi.fn(async () => Buffer.alloc(0)),
    getActiveWindow: vi.fn(async () => null),
    focusWindow: vi.fn(async () => false),
    openApp: vi.fn(async () => 'opened'),
    getCursorPos: vi.fn(async () => ({ x: 100, y: 100 })),
    mouseDown: vi.fn(async () => 'down'),
    mouseUp: vi.fn(async () => 'up'),
    ...overrides,
  } as unknown as PlatformAdapter
}

const fastSleep = async () => {}

describe('buildHumanPath (纯函数)', () => {
  it('easeOutCubic: t=0→0, t=1→1, 中间值递增', () => {
    expect(easeOutCubic(0)).toBe(0)
    expect(easeOutCubic(1)).toBe(1)
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5) // ease-out 前期快
  })

  it('步数在 8-15 范围内自适应', () => {
    const p1 = buildHumanPath(0, 0, 100, 100, { random: () => 0.5 })
    expect(p1.points.length).toBeGreaterThanOrEqual(9) // 起点+8步
    expect(p1.points.length).toBeLessThanOrEqual(16) // 起点+15步
  })

  it('起点和终点精确匹配，终点无抖动', () => {
    const p = buildHumanPath(10, 20, 200, 300, { steps: 10, random: () => 0.9 })
    expect(p.points[0]).toEqual({ x: 10, y: 20 })
    expect(p.points[p.points.length - 1]).toEqual({ x: 200, y: 300 })
  })

  it('中间步在抖动范围内', () => {
    const jitter = 2
    const p = buildHumanPath(0, 0, 100, 100, { steps: 10, jitterPx: jitter, random: () => 0.5 })
    for (let i = 1; i < p.points.length - 1; i++) {
      const t = i / 10
      const e = easeOutCubic(t)
      const expectedX = 0 + (100 - 0) * e
      const expectedY = 0 + (100 - 0) * e
      expect(Math.abs(p.points[i].x - expectedX)).toBeLessThanOrEqual(jitter + 1)
      expect(Math.abs(p.points[i].y - expectedY)).toBeLessThanOrEqual(jitter + 1)
    }
  })

  it('距离极近时步数仍有最小值', () => {
    const p = buildHumanPath(0, 0, 5, 5, { random: () => 0.5 })
    expect(p.points.length).toBeGreaterThanOrEqual(9)
  })

  it('stepDelayMs 和 pauseBeforeClickMs 在范围内', () => {
    const p = buildHumanPath(0, 0, 100, 100, {
      stepDelayRange: [5, 15],
      pauseBeforeClickRange: [60, 140],
      random: () => 0.3,
    })
    expect(p.stepDelayMs).toBeGreaterThanOrEqual(5)
    expect(p.stepDelayMs).toBeLessThanOrEqual(15)
    expect(p.pauseBeforeClickMs).toBeGreaterThanOrEqual(60)
    expect(p.pauseBeforeClickMs).toBeLessThanOrEqual(140)
  })
})

describe('isInstantMouse', () => {
  const original = process.env.LUMINA_CU_INSTANT_MOUSE
  afterEach(() => {
    if (original === undefined) {delete process.env.LUMINA_CU_INSTANT_MOUSE}
    else {process.env.LUMINA_CU_INSTANT_MOUSE = original}
  })

  it('默认 false', () => {
    delete process.env.LUMINA_CU_INSTANT_MOUSE
    expect(isInstantMouse()).toBe(false)
  })

  it('LUMINA_CU_INSTANT_MOUSE=1 时 true', () => {
    process.env.LUMINA_CU_INSTANT_MOUSE = '1'
    expect(isInstantMouse()).toBe(true)
  })
})

describe('humanMoveTo', () => {
  it('正常路径：从 getCursorPos 出发，逐步 mouseMove', async () => {
    const adapter = makeMockAdapter()
    await humanMoveTo(adapter, 500, 500, { sleep: fastSleep, random: () => 0.5, steps: 8 })
    const moves = (adapter.mouseMove as any).mock.calls
    expect(moves.length).toBeGreaterThanOrEqual(8)
    // 第一步是起点 (100,100)
    expect(moves[0][0]).toBe(100)
    expect(moves[0][1]).toBe(100)
    // 最后一步是终点 (500,500)
    expect(moves[moves.length - 1][0]).toBe(500)
    expect(moves[moves.length - 1][1]).toBe(500)
  })

  it('instant 模式：直接 mouseMove 一步到位', async () => {
    process.env.LUMINA_CU_INSTANT_MOUSE = '1'
    const adapter = makeMockAdapter()
    await humanMoveTo(adapter, 500, 500, { sleep: fastSleep })
    expect((adapter.mouseMove as any).mock.calls.length).toBe(1)
    expect((adapter.mouseMove as any).mock.calls[0]).toEqual([500, 500])
    delete process.env.LUMINA_CU_INSTANT_MOUSE
  })

  it('getCursorPos 缺失时用偏移起点', async () => {
    const adapter = makeMockAdapter({ getCursorPos: undefined })
    await humanMoveTo(adapter, 500, 500, { sleep: fastSleep, random: () => 0.5, steps: 8 })
    const moves = (adapter.mouseMove as any).mock.calls
    // 起点应在目标附近偏移 (500-50, 500-40)
    expect(moves[0][0]).toBe(450)
    expect(moves[0][1]).toBe(460)
  })

  it('距离<6px 时直接瞬移不演', async () => {
    const adapter = makeMockAdapter({ getCursorPos: async () => ({ x: 500, y: 500 }) })
    await humanMoveTo(adapter, 503, 502, { sleep: fastSleep })
    expect((adapter.mouseMove as any).mock.calls.length).toBe(1)
  })
})

describe('humanClick', () => {
  it('先移动到目标，停顿后点击', async () => {
    const adapter = makeMockAdapter()
    await humanClick(adapter, 300, 400, 'left', false, { sleep: fastSleep, random: () => 0.5, steps: 8 })
    expect(adapter.mouseClick).toHaveBeenCalledWith(300, 400, 'left', false)
    // mouseMove 被调用了多次（拟人化路径）
    expect((adapter.mouseMove as any).mock.calls.length).toBeGreaterThan(1)
  })

  it('instant 模式直接调 mouseClick', async () => {
    process.env.LUMINA_CU_INSTANT_MOUSE = '1'
    const adapter = makeMockAdapter()
    await humanClick(adapter, 300, 400, 'right', true, { sleep: fastSleep })
    expect(adapter.mouseClick).toHaveBeenCalledWith(300, 400, 'right', true)
    expect((adapter.mouseMove as any).mock.calls.length).toBe(0)
    delete process.env.LUMINA_CU_INSTANT_MOUSE
  })
})

describe('humanHover', () => {
  it('移动到目标后停留 holdMs', async () => {
    const adapter = makeMockAdapter()
    let sleepCalls = 0
    const countSleep = async () => { sleepCalls++ }
    await humanHover(adapter, 200, 300, 500, { sleep: countSleep, random: () => 0.5, steps: 8 })
    // 至少有路径步数 + 1次停留
    expect(sleepCalls).toBeGreaterThanOrEqual(8)
    expect((adapter.mouseMove as any).mock.calls.length).toBeGreaterThan(1)
  })
})

describe('humanDrag', () => {
  it('完整拖拽：移到起点→mouseDown→路径移动→mouseUp', async () => {
    const adapter = makeMockAdapter()
    await humanDrag(adapter, 100, 100, 400, 400, { sleep: fastSleep, random: () => 0.5, steps: 8 })
    expect(adapter.mouseDown).toHaveBeenCalledWith(100, 100, 'left')
    expect(adapter.mouseUp).toHaveBeenCalledWith(400, 400, 'left')
    // mouseMove 被调用多次（到起点 + 拖拽路径）
    expect((adapter.mouseMove as any).mock.calls.length).toBeGreaterThan(2)
    // 不应调用整体 mouseDrag（用分步原语）
    expect(adapter.mouseDrag).not.toHaveBeenCalled()
  })

  it('适配器无 mouseDown/mouseUp 时退回整体 mouseDrag', async () => {
    const adapter = makeMockAdapter({ mouseDown: undefined, mouseUp: undefined })
    await humanDrag(adapter, 100, 100, 400, 400, { sleep: fastSleep })
    expect(adapter.mouseDrag).toHaveBeenCalledWith(100, 100, 400, 400)
  })

  it('instant 模式退回整体 mouseDrag', async () => {
    process.env.LUMINA_CU_INSTANT_MOUSE = '1'
    const adapter = makeMockAdapter()
    await humanDrag(adapter, 100, 100, 400, 400, { sleep: fastSleep })
    expect(adapter.mouseDrag).toHaveBeenCalledWith(100, 100, 400, 400)
    delete process.env.LUMINA_CU_INSTANT_MOUSE
  })
})
