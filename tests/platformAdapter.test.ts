// ============================================================
// tests/platformAdapter.test.ts — 跨平台桌面控制适配层单元测试
//
// 验收：
//   • createAdapter('win32'/'darwin'/'linux') 返回正确类型
//   • 各平台 capabilities 默认标志正确
//   • Linux Wayland 检测（注入 sessionType='wayland'）→ 鼠标/键盘禁用
//   • Linux 无 xdotool → 鼠标/键盘禁用并提示安装
// 所有平台命令均被 mock / 或在禁用态短路，不实际执行系统命令。
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'

// WindowsAdapter 顶部 import 了 electron.clipboard 与 screenshot-desktop，
// 在 node 测试环境打桩，避免加载真实 Electron / 原生截图库。
vi.mock('electron', () => ({
  clipboard: { writeText: vi.fn(), readText: vi.fn(() => '') },
}))
vi.mock('screenshot-desktop', () => ({
  default: vi.fn().mockResolvedValue(Buffer.from([])),
}))

import {
  createAdapter, getPlatformAdapter, resetPlatformAdapter,
  WindowsAdapter, MacAdapter, LinuxAdapter,
} from '../electron/core/platform'
import type { PlatformCapabilities } from '../electron/core/platform'

beforeEach(() => { resetPlatformAdapter() })

// ── 工厂按平台返回正确类型 ──────────────────────────────
describe('createAdapter 平台分派', () => {
  it('win32 → WindowsAdapter，全能力', () => {
    const a = createAdapter('win32')
    expect(a).toBeInstanceOf(WindowsAdapter)
    expect(a.capabilities.platform).toBe('win32')
  })

  it('darwin → MacAdapter，UIA 关闭', () => {
    const a = createAdapter('darwin')
    expect(a).toBeInstanceOf(MacAdapter)
    expect(a.capabilities.uia).toBe(false)
    expect(a.capabilities.mouse).toBe(true)
    expect(a.capabilities.keyboard).toBe(true)
    expect(a.capabilities.screenshot).toBe(true)
  })

  it('linux → LinuxAdapter（X11 + xdotool 可用时全能力）', () => {
    const a = createAdapter('linux', { sessionType: 'x11', xdotoolAvailable: true })
    expect(a).toBeInstanceOf(LinuxAdapter)
    const c = a.capabilities
    expect(c.mouse).toBe(true)
    expect(c.keyboard).toBe(true)
    expect(c.uia).toBe(false)
  })

  it('未知平台 → 退化为无能力模式，不抛错', () => {
    const a = createAdapter('freebsd')
    expect(a.capabilities.platform).toBe('freebsd')
    expect(a.capabilities.mouse).toBe(false)
    expect(a.capabilities.keyboard).toBe(false)
  })
})

// ── Windows 默认能力 ───────────────────────────────────
describe('WindowsAdapter capabilities', () => {
  it('鼠标/键盘/截屏/窗口/UIA/openApp 全开', () => {
    const c: PlatformCapabilities = createAdapter('win32').capabilities
    expect(c).toMatchObject({
      mouse: true, keyboard: true, screenshot: true,
      windowInfo: true, uia: true, openApp: true,
    })
    expect(c.notes.length).toBe(0)
  })

  it('getUiaTree 为空占位（真正扫描在 cuUia）', async () => {
    await expect(createAdapter('win32').getUiaTree()).resolves.toEqual([])
  })
})

// ── macOS 默认能力与授权提示 ─────────────────────────────
describe('MacAdapter capabilities', () => {
  it('含辅助功能/屏幕录制授权提示', () => {
    const c = createAdapter('darwin').capabilities
    expect(c.notes.join('；')).toMatch(/辅助功能|Accessibility|屏幕录制/)
    expect(c.installedApps).toBe(false)
  })
})

// ── Linux Wayland 检测 ─────────────────────────────────
describe('LinuxAdapter Wayland 降级', () => {
  it('Wayland：全局键鼠注入禁用，提示切换 X11', () => {
    const a = createAdapter('linux', { sessionType: 'wayland', xdotoolAvailable: true })
    const c = a.capabilities
    expect(c.mouse).toBe(false)
    expect(c.keyboard).toBe(false)
    expect(c.screenshot).toBe(true)
    expect(c.notes.join('；')).toMatch(/Wayland/)
  })

  it('Wayland 下鼠标动作在适配层即短路（不调用系统命令）', async () => {
    const a = createAdapter('linux', { sessionType: 'wayland', xdotoolAvailable: true })
    // requireMouse 命中即返回原因，不会 execFile xdotool
    const msg = await a.mouseClick(100, 100, 'left', false)
    expect(msg).toContain('点击失败')
    expect(msg).toMatch(/Wayland/)
  })
})

// ── Linux 无 xdotool ────────────────────────────────────
describe('LinuxAdapter 缺依赖降级', () => {
  it('X11 但无 xdotool：键鼠禁用并提示安装', () => {
    const a = createAdapter('linux', { sessionType: 'x11', xdotoolAvailable: false })
    const c = a.capabilities
    expect(c.mouse).toBe(false)
    expect(c.keyboard).toBe(false)
    expect(c.notes.join('；')).toMatch(/xdotool/)
  })

  it('无 xdotool 时键盘输入短路', async () => {
    const a = createAdapter('linux', { sessionType: 'x11', xdotoolAvailable: false })
    const msg = await a.keyboardType('hello')
    expect(msg).toContain('输入失败')
  })
})

// ── 单例工厂 ───────────────────────────────────────────
describe('getPlatformAdapter 单例', () => {
  it('两次取到同一实例，reset 后重建', () => {
    const a1 = getPlatformAdapter()
    const a2 = getPlatformAdapter()
    expect(a1).toBe(a2)
    resetPlatformAdapter()
    const a3 = getPlatformAdapter()
    expect(a3).not.toBe(a1)
  })
})
