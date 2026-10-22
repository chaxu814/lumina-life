// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/trayMenu.test.ts — 自定义浮层托盘菜单单元测试
//
// 验收：
//   1. 浮层窗口创建参数正确（frame:false, transparent:true, resizable:false, skipTaskbar:true）
//   2. 菜单项点击（IPC 'trayMenu:menu-click'）触发对应 action
//   3. blur 事件自动关闭浮层
//   4. 位置计算基于 tray.getBounds()，Windows 上方 / macOS 下方
//   5. show 前推送最新状态；quit 动作不自动 hide（退出流程）
// ============================================================
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

// ── hoisted mocks（在 import 前可用） ──────────────────────
const h = vi.hoisted(() => {
  return {
    createdWindows: [] as Array<Record<string, unknown>>,
    ipcOn: [] as Array<{ channel: string; cb: (...args: any[]) => void }>,
    ipcHandle: [] as Array<{ channel: string; cb: (...args: any[]) => void }>,
    trayBounds: { x: 1880, y: 1024, width: 16, height: 16 },
    // 记录 screen.getDisplayNearestPoint 的返回
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
  }
})

vi.mock('electron', () => {
  class FakeWebContents {
    send = vi.fn()
    once = vi.fn()
    isLoadingMainFrame = () => false
  }

  class FakeBrowserWindow {
    opts: Record<string, unknown>
    handlers: Record<string, (...args: any[]) => void> = {}
    onceHandlers: Record<string, (...args: any[]) => void> = {}
    webContents = new FakeWebContents()
    visible = false
    focused = false
    destroyed = false
    pos = { x: 0, y: 0 }
    size = { w: 0, h: 0 }

    constructor(opts: Record<string, unknown>) {
      this.opts = opts
      h.createdWindows.push(opts)
    }
    loadFile() { return Promise.resolve() }
    on(event: string, cb: (...args: any[]) => void) { this.handlers[event] = cb }
    once(event: string, cb: (...args: any[]) => void) { this.onceHandlers[event] = cb }
    setPosition(x: number, y: number) { this.pos = { x, y } }
    setSize(w: number, h: number) { this.size = { w, h } }
    showInactive() { this.visible = true }
    focus() { this.focused = true }
    hide() { this.visible = false }
    isVisible() { return this.visible }
    isFocused() { return this.focused }
    isDestroyed() { return this.destroyed }
    close() { this.destroyed = true; this.visible = false }
  }

  return {
    app: { on: vi.fn() },
    BrowserWindow: FakeBrowserWindow,
    Tray: class {},
    screen: {
      getDisplayNearestPoint: () => ({ workArea: h.workArea }),
    },
    ipcMain: {
      on: (channel: string, cb: (...args: any[]) => void) => { h.ipcOn.push({ channel, cb }) },
      handle: (channel: string, cb: (...args: any[]) => void) => { h.ipcHandle.push({ channel, cb }) },
    },
  }
})

import {
  createTrayMenu,
  showTrayMenu,
  hideTrayMenu,
  isTrayMenuVisible,
  getTrayMenuWindow,
  calcPopupPosition,
  disposeTrayMenu,
} from '../electron/tray/trayMenu'

// ── helpers ─────────────────────────────────────────────────
function makeTray() {
  return { getBounds: () => ({ ...h.trayBounds }) } as any
}

function makeActions() {
  return {
    toggleMainWindow: vi.fn(),
    openSettings: vi.fn(),
    openTaskWorkspace: vi.fn(),
    toggleGame: vi.fn(() => true),
    quit: vi.fn(),
  }
}

function makeOptions(actions = makeActions()) {
  return {
    actions,
    getState: () => ({
      online: true,
      mood: '在线',
      moodColor: '#4ade80',
      statusText: '在线',
      gameEnabled: false,
      windowVisible: true,
    }),
  }
}

beforeEach(() => {
  h.createdWindows.length = 0
  // 注意：ipcOn / ipcHandle 不清空——模块内 ipcRegistered 守卫使 IPC 只注册一次，
  // 闭包引用模块级 options，createTrayMenu 会更新它，重复注册无意义。
  disposeTrayMenu()
})

// ── 1. 浮层窗口创建参数 ─────────────────────────────────────
describe('浮层窗口创建参数', () => {
  it('frame:false / transparent:true / resizable:false / skipTaskbar:true / alwaysOnTop:true', () => {
    createTrayMenu(makeTray(), makeOptions())
    showTrayMenu()

    expect(h.createdWindows.length).toBe(1)
    const opts = h.createdWindows[0] as any
    expect(opts.frame).toBe(false)
    expect(opts.transparent).toBe(true)
    expect(opts.resizable).toBe(false)
    expect(opts.skipTaskbar).toBe(true)
    expect(opts.alwaysOnTop).toBe(true)
    expect(opts.show).toBe(false)
    expect(opts.webPreferences.contextIsolation).toBe(true)
    expect(opts.webPreferences.nodeIntegration).toBe(false)
  })
})

// ── 2. 菜单项点击触发对应 action ───────────────────────────
describe('菜单项 IPC 分发', () => {
  it('toggle-main / open-settings / open-task-workspace / toggle-game 分别触发对应 action', () => {
    const actions = makeActions()
    createTrayMenu(makeTray(), makeOptions(actions))
    showTrayMenu()

    const clickHandler = h.ipcOn.find((x) => x.channel === 'trayMenu:menu-click')
    expect(clickHandler).toBeTruthy()

    for (const [action, spy] of [
      ['toggle-main', actions.toggleMainWindow],
      ['open-settings', actions.openSettings],
      ['open-task-workspace', actions.openTaskWorkspace],
      ['toggle-game', actions.toggleGame],
    ] as Array<[string, ReturnType<typeof vi.fn>]>) {
      clickHandler!.cb({}, action)
      expect(spy).toHaveBeenCalledTimes(1)
    }
  })

  it('普通菜单项点击后自动 hide；quit 不 hide（退出流程）', () => {
    const actions = makeActions()
    createTrayMenu(makeTray(), makeOptions(actions))
    showTrayMenu()
    expect(isTrayMenuVisible()).toBe(true)

    const clickHandler = h.ipcOn.find((x) => x.channel === 'trayMenu:menu-click')!
    clickHandler.cb({}, 'open-settings')
    expect(isTrayMenuVisible()).toBe(false)

    // 重新显示后点 quit
    showTrayMenu()
    expect(isTrayMenuVisible()).toBe(true)
    clickHandler.cb({}, 'quit')
    expect(actions.quit).toHaveBeenCalledTimes(1)
    // quit 后模块不主动 hide（进程即将退出）
    expect(isTrayMenuVisible()).toBe(true)
  })
})

// ── 3. blur 自动关闭 ──────────────────────────────────────
describe('失焦自动关闭', () => {
  it('blur 且窗口未聚焦时隐藏浮层', async () => {
    createTrayMenu(makeTray(), makeOptions())
    showTrayMenu()
    const win = getTrayMenuWindow() as any
    expect(win).toBeTruthy()
    expect(isTrayMenuVisible()).toBe(true)

    // 模拟 blur：窗口当前未聚焦
    win.focused = false
    win.handlers['blur']()

    // blur 内有 120ms 延迟
    await new Promise((r) => setTimeout(r, 200))
    expect(isTrayMenuVisible()).toBe(false)
  })
})

// ── 4. 位置计算 ────────────────────────────────────────────
describe('位置计算 calcPopupPosition', () => {
  it('Windows：浮层在托盘图标上方，右对齐图标右边缘', () => {
    const pos = calcPopupPosition({ x: 1880, y: 1024, width: 16, height: 16 }, 248, 332, 'win32')
    // 右对齐：x = 1880 + 16 - 248 = 1648
    expect(pos.x).toBe(1648)
    // 上方：y = 1024 - 332 - 6 = 686
    expect(pos.y).toBe(686)
    expect(pos.width).toBe(248)
    expect(pos.height).toBe(332)
  })

  it('macOS：浮层在菜单栏图标下方，水平居中', () => {
    const pos = calcPopupPosition({ x: 900, y: 0, width: 16, height: 24 }, 248, 332, 'darwin')
    // 居中：x = 900 + 8 - 124 = 784
    expect(pos.x).toBe(784)
    // 下方：y = 0 + 24 + 6 = 30
    expect(pos.y).toBe(30)
  })

  it('超出 workArea 时被夹取到屏幕内', () => {
    // 托盘在屏幕最左侧，浮层会被夹到 x=0
    const pos = calcPopupPosition({ x: 0, y: 1024, width: 16, height: 16 }, 248, 332, 'win32')
    expect(pos.x).toBeGreaterThanOrEqual(0)
    expect(pos.y).toBeGreaterThanOrEqual(0)
  })
})

// ── 5. 状态推送 ─────────────────────────────────────────────
describe('状态推送', () => {
  it('show 时通过 webContents.send 推送 trayMenu:state', () => {
    const opts = makeOptions()
    createTrayMenu(makeTray(), opts)
    showTrayMenu()
    const win = getTrayMenuWindow() as any
    const sendCall = win.webContents.send.mock.calls.find((c: any[]) => c[0] === 'trayMenu:state')
    expect(sendCall).toBeTruthy()
    expect(sendCall[1].mood).toBe('在线')
  })

  it('get-state IPC 返回 getState() 结果', () => {
    createTrayMenu(makeTray(), makeOptions())
    const handle = h.ipcHandle.find((x) => x.channel === 'trayMenu:get-state')
    expect(handle).toBeTruthy()
    const state = handle!.cb({})
    expect(state.online).toBe(true)
    expect(state.gameEnabled).toBe(false)
  })
})

// ── 6. 静态资源：CSP 不得静默拦掉交互脚本 ─────────────────────
//
// 这条回归测试守的是一个「坏了也看不见」的坑：
//   trayMenu.html 的 CSP 是 `script-src 'self'`（不放行内联脚本）。
//   一旦有人把交互脚本「顺手」改回内联 <script>，页面照样正常渲染出菜单，
//   但点击全部失效、状态永远停在硬编码默认值——没有报错、没有红字，
//   表现为「功能不可用」，极难定位。
//   所以这里直接断言：脚本必须是外部引用，且文件必须真实存在。
describe('托盘菜单静态资源', () => {
  const trayDir = join(__dirname, '..', 'electron', 'tray')
  const html = readFileSync(join(trayDir, 'trayMenu.html'), 'utf-8')

  it('trayMenu.html 引用外部脚本 trayMenu.ui.js，而不是内联 <script>', () => {
    const body = html.slice(html.indexOf('<body'))
    const inlineScripts = body.match(/<script(?![^>]*\bsrc=)[^>]*>/g)
    expect(inlineScripts ?? []).toEqual([])
    expect(html).toMatch(/<script\s+src="trayMenu\.ui\.js"><\/script>/)
  })

  it('外部脚本文件真实存在', () => {
    expect(existsSync(join(trayDir, 'trayMenu.ui.js'))).toBe(true)
  })

  it('外部脚本不与 trayMenu.ts 撞名（否则 Vite 会优先解析到 .js）', () => {
    expect(existsSync(join(trayDir, 'trayMenu.js'))).toBe(false)
  })

  it('CSS 配色走 --tm-* 私有变量，不直接用会被主题覆盖的 --text-primary', () => {
    // 主题系统把 --text-primary 等以 inline style 注入 <html>，优先级高于 :root。
    // 菜单直接消费它们会被浅色主题改成深色字糊在深色卡片上。
    expect(html).toContain('--tm-text:')
    const styleBlock = html.slice(html.indexOf('<style'), html.indexOf('</style>'))
    // 只允许出现在 --tm-* 的定义里（var(--text-primary 作为取值）
    expect(styleBlock).toMatch(/--tm-text:\s*var\(--text-primary/)
    expect(styleBlock).not.toMatch(/color:\s*var\(--text-primary\)/)
  })
})
