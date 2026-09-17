// ============================================================
// tests/computerUse.test.ts — IPC 桌面操控引擎（外壳）单元测试
//
// v3.20 起执行层统一到 cuCore，这里 mock 掉 cuCore / electron / 截图，
// 重点验证：解析、分析协议、确认策略、executeAction 到内核的正确分派。
// ============================================================

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('screenshot-desktop', () => ({
  default: vi.fn().mockResolvedValue('/tmp/mock-screen.png'),
}))

vi.mock('electron', () => ({
  screen: { getPrimaryDisplay: () => ({ size: { width: 1920, height: 1080 }, scaleFactor: 1 }) },
}))

// vi.mock 工厂会被提升，mock 函数必须用 vi.hoisted 创建以免 TDZ
const m = vi.hoisted(() => ({
  executeCuAction: vi.fn(async () => ({ ok: true, msg: 'ok' })),
  cuOpenApp: vi.fn(async () => '已尝试打开应用'),
  cuSetClipboard: vi.fn(() => '已写入剪贴板'),
  cuPressKey: vi.fn(async () => '按键完成'),
  resetCuAbort: vi.fn(),
  isCuAborted: vi.fn(() => false),
}))

vi.mock('../electron/tools/impl/cuCore', () => ({
  executeCuAction: m.executeCuAction,
  cuOpenApp: m.cuOpenApp,
  cuSetClipboard: m.cuSetClipboard,
  cuPressKey: m.cuPressKey,
  resetCuAbort: m.resetCuAbort,
  isCuAborted: m.isCuAborted,
}))

import { ComputerUse, getComputerUse, initComputerUse } from '../electron/computerUse'
import type { CUConfig, CUAction } from '../electron/computerUse'

function makeCU(config?: Partial<CUConfig>): ComputerUse {
  return new ComputerUse({ llmApiKey: 'test-key', safetyLevel: 'auto', ...config })
}
function privateMethod(obj: any, name: string): any {
  return obj[name].bind(obj)
}

// ── 1. 构造 ──────────────────────────────────────────────
describe('constructor', () => {
  it('creates instance with default config', () => {
    expect(new ComputerUse()).toBeInstanceOf(ComputerUse)
  })
  it('sets default maxSteps to 10', () => {
    expect((new ComputerUse() as any).config.maxSteps).toBe(10)
  })
  it('applies custom config', () => {
    expect((new ComputerUse({ maxSteps: 5, safetyLevel: 'strict' }) as any).config.safetyLevel).toBe('strict')
  })
})

// ── 2. parseAction ───────────────────────────────────────
describe('parseAction', () => {
  let parseAction: (s: string) => CUAction | null
  beforeEach(() => { parseAction = privateMethod(makeCU(), 'parseAction') })

  it('parses click(x, y)', () => {
    expect(parseAction('click(500, 300)')).toEqual({ type: 'click', params: { x: 500, y: 300 } })
  })
  it('parses type("text")', () => {
    expect(parseAction('type("hello world")')).toEqual({ type: 'type', params: { text: 'hello world' } })
  })
  it('parses keypress("enter")', () => {
    expect(parseAction('keypress("enter")')).toEqual({ type: 'keypress', params: { key: 'enter' } })
  })
  it('parses scroll', () => {
    expect(parseAction('scroll("down", 3)')).toEqual({ type: 'scroll', params: { direction: 'down', amount: 3 } })
  })
  it('parses wait', () => {
    expect(parseAction('wait(1500)')).toEqual({ type: 'wait', params: { ms: 1500 } })
  })
  it('parses clipboard/open_app', () => {
    expect(parseAction('clipboard("你好")')?.type).toBe('clipboard')
    expect(parseAction('open_app("Chrome")')?.type).toBe('open_app')
  })
  it('DONE / empty → null', () => {
    expect(parseAction('DONE')).toBeNull()
    expect(parseAction('')).toBeNull()
  })
  it('case-insensitive CLICK', () => {
    expect(parseAction('CLICK(1, 2)')?.type).toBe('click')
  })
})

// ── 3. parseAnalysisResponse ─────────────────────────────
describe('parseAnalysisResponse', () => {
  let fn: (s: string) => any
  beforeEach(() => { fn = privateMethod(makeCU(), 'parseAnalysisResponse') })
  it('parses valid JSON', () => {
    const r = fn(JSON.stringify({ description: '桌面', elements: [], suggestedAction: 'DONE' }))
    expect(r.suggestedAction).toBe('DONE')
  })
  it('extracts JSON from fenced text', () => {
    const r = fn('前缀\n```json\n{"description":"t","elements":[],"suggestedAction":"DONE"}\n```')
    expect(r.description).toBe('t')
  })
  it('falls back when no JSON', () => {
    const r = fn('纯文字')
    expect(r.suggestedAction).toBe('DONE')
  })
})

// ── 4. fallbackAnalysis ──────────────────────────────────
describe('fallbackAnalysis', () => {
  it('returns DONE and mentions task', () => {
    const cu = makeCU({ llmApiKey: undefined })
    const r = privateMethod(cu, 'fallbackAnalysis')('/p.png', '打开浏览器', [])
    expect(r.suggestedAction).toBe('DONE')
    expect(r.description).toContain('打开浏览器')
  })
})

// ── 5. confirmAction（破坏性硬拦截已下沉 cuCore，见 cuSafety 测试）──
describe('confirmAction', () => {
  it('auto allows all (hard-block is the core layer)', async () => {
    const fn = privateMethod(makeCU({ safetyLevel: 'auto' }), 'confirmAction')
    expect(await fn({ type: 'click', params: { x: 1, y: 2 } })).toBe(true)
    expect(await fn({ type: 'type', params: { text: 'sudo rm -rf /' } })).toBe(true)
  })
  it('strict blocks close_window', async () => {
    const fn = privateMethod(makeCU({ safetyLevel: 'strict' }), 'confirmAction')
    expect(await fn({ type: 'close_window', params: {} })).toBe(false)
  })
  it('strict allows normal type / keypress / click', async () => {
    const fn = privateMethod(makeCU({ safetyLevel: 'strict' }), 'confirmAction')
    expect(await fn({ type: 'type', params: { text: 'Hello, 你好' } })).toBe(true)
    expect(await fn({ type: 'keypress', params: { key: 'ctrl_c' } })).toBe(true)
    expect(await fn({ type: 'click', params: { x: 1, y: 2 } })).toBe(true)
  })
})

// ── 6. executeAction → cuCore 分派 ───────────────────────
describe('executeAction dispatch', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('unknown type → false', async () => {
    expect(await makeCU().executeAction({ type: 'fly' as any, params: {} })).toBe(false)
  })

  it('click with NaN / missing coords → false (does not call core)', async () => {
    const cu = makeCU()
    expect(await cu.executeAction({ type: 'click', params: { x: 'abc', y: 'def' } as any })).toBe(false)
    expect(await cu.executeAction({ type: 'click', params: {} })).toBe(false)
    expect(m.executeCuAction).not.toHaveBeenCalled()
  })

  it('pixel click → executeCuAction with x/y', async () => {
    await makeCU().executeAction({ type: 'click', params: { x: 960, y: 540 } })
    const arg = m.executeCuAction.mock.calls.at(-1)![0]
    expect(arg.action_type).toBe('click')
    expect(arg.x).toBe(960); expect(arg.y).toBe(540)
  })

  it('normalized click → passes nx/ny through', async () => {
    await makeCU().executeAction({ type: 'click', params: { nx: 50, ny: 50 } } as any)
    const arg = m.executeCuAction.mock.calls.at(-1)![0]
    expect(arg.nx).toBe(50); expect(arg.ny).toBe(50)
  })

  it('type (incl. Chinese) → executeCuAction type', async () => {
    await makeCU().executeAction({ type: 'type', params: { text: '你好世界' } })
    const arg = m.executeCuAction.mock.calls.at(-1)![0]
    expect(arg.action_type).toBe('type'); expect(arg.text).toBe('你好世界')
  })

  it('keypress / scroll(up negative) → core', async () => {
    await makeCU().executeAction({ type: 'keypress', params: { key: 'enter' } })
    expect(m.executeCuAction.mock.calls.at(-1)![0]).toMatchObject({ action_type: 'keypress', key: 'enter' })
    await makeCU().executeAction({ type: 'scroll', params: { direction: 'up', amount: 3 } })
    expect(m.executeCuAction.mock.calls.at(-1)![0].scroll_amount).toBe(-3)
  })

  it('drag: missing endpoints → false; complete → core', async () => {
    const cu = makeCU()
    expect(await cu.executeAction({ type: 'drag', params: { x: 1, y: 2 } })).toBe(false)
    await cu.executeAction({ type: 'drag', params: { nx: 10, ny: 20, nx2: 80, ny2: 90 } } as any)
    const arg = m.executeCuAction.mock.calls.at(-1)![0]
    expect(arg.action_type).toBe('drag')
    expect([arg.nx, arg.ny, arg.nx2, arg.ny2]).toEqual([10, 20, 80, 90])
  })

  it('wait sleeps', async () => {
    const t0 = Date.now()
    await makeCU().executeAction({ type: 'wait', params: { ms: 40 } })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25)
  })

  it('clipboard / open_app / close_window route to dedicated primitives', async () => {
    const cu = makeCU()
    expect(await cu.executeAction({ type: 'clipboard', params: { text: 't' } })).toBe(true)
    expect(m.cuSetClipboard).toHaveBeenCalledWith('t')
    expect(await cu.executeAction({ type: 'open_app', params: { app: 'Chrome' } })).toBe(true)
    expect(m.cuOpenApp).toHaveBeenCalledWith('Chrome')
    expect(await cu.executeAction({ type: 'close_window', params: {} })).toBe(true)
    expect(m.cuPressKey).toHaveBeenCalledWith('alt_f4')
  })
})

// ── 7. 单例 ──────────────────────────────────────────────
describe('singleton', () => {
  it('get/init return instances', () => {
    expect(getComputerUse()).toBeDefined()
    expect(initComputerUse({ llmApiKey: 'k' })).toBeDefined()
  })
})
