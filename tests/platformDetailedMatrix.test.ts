// ============================================================
// tests/platformDetailedMatrix.test.ts — 三平台详细能力矩阵单测
//
// 断言 getDetailedCapabilityMatrix() 在 win32/darwin/linux(x11/wayland)
// 四种驱动下都输出完整字段（platform/displayServer/screenshot/mouse/keyboard/
// windowManagement/notes），且 method / requiresPermission 与预期一致。
// 纯逻辑构造，不执行任何系统命令。
// ============================================================

import { describe, it, expect } from 'vitest'
import { getDetailedCapabilityMatrix } from '../electron/core/platform/platformCapabilities'

describe('getDetailedCapabilityMatrix — Windows', () => {
  const m = getDetailedCapabilityMatrix({ platform: 'win32' })

  it('displayServer 为 win32，四子能力全开', () => {
    expect(m.platform).toBe('win32')
    expect(m.displayServer).toBe('win32')
    expect(m.screenshot.supported).toBe(true)
    expect(m.mouse.supported).toBe(true)
    expect(m.keyboard.supported).toBe(true)
    expect(m.windowManagement.supported).toBe(true)
  })

  it('无 requiresPermission（Windows 开箱即用）', () => {
    expect(m.screenshot.requiresPermission).toBeUndefined()
    expect(m.mouse.requiresPermission).toBeUndefined()
  })
})

describe('getDetailedCapabilityMatrix — macOS', () => {
  it('screenshot 标屏幕录制权限，mouse/keyboard 标辅助功能', () => {
    const m = getDetailedCapabilityMatrix({ platform: 'darwin', cliclickAvailable: true })
    expect(m.platform).toBe('darwin')
    expect(m.displayServer).toBe('cocoa')
    expect(m.screenshot.requiresPermission).toMatch(/屏幕录制/)
    expect(m.mouse.requiresPermission).toMatch(/辅助功能/)
    expect(m.keyboard.requiresPermission).toMatch(/辅助功能/)
    expect(m.mouse.method).toMatch(/cliclick/)
  })

  it('无 cliclick 时 method 落到 AppleScript 并给安装提示', () => {
    const m = getDetailedCapabilityMatrix({ platform: 'darwin', cliclickAvailable: false })
    expect(m.mouse.method).toMatch(/AppleScript/)
    expect(m.notes.join(' ')).toMatch(/brew install cliclick/)
  })
})

describe('getDetailedCapabilityMatrix — Linux X11', () => {
  it('xdotool 可用时键鼠全开、method=xdotool', () => {
    const m = getDetailedCapabilityMatrix({ platform: 'linux', displayServer: 'x11', xdotoolAvailable: true })
    expect(m.displayServer).toBe('x11')
    expect(m.mouse.supported).toBe(true)
    expect(m.keyboard.supported).toBe(true)
    expect(m.mouse.method).toMatch(/xdotool/)
    expect(m.windowManagement.supported).toBe(true)
  })

  it('xdotool 缺失时键鼠 false 并给 apt 安装指引', () => {
    const m = getDetailedCapabilityMatrix({ platform: 'linux', displayServer: 'x11', xdotoolAvailable: false })
    expect(m.mouse.supported).toBe(false)
    expect(m.keyboard.supported).toBe(false)
    expect(m.mouse.requiresPermission).toMatch(/xdotool/)
  })
})

describe('getDetailedCapabilityMatrix — Linux Wayland', () => {
  it('键鼠 false、截屏 grim、提示切 X11', () => {
    const m = getDetailedCapabilityMatrix({ platform: 'linux', displayServer: 'wayland', grimAvailable: true })
    expect(m.displayServer).toBe('wayland')
    expect(m.mouse.supported).toBe(false)
    expect(m.keyboard.supported).toBe(false)
    expect(m.screenshot.method).toMatch(/grim/)
    expect(m.windowManagement.supported).toBe(false)
    expect(m.notes.join(' ')).toMatch(/X11|ydotool/)
  })

  it('grim 缺失时截屏 supported=false 并给安装指引', () => {
    const m = getDetailedCapabilityMatrix({ platform: 'linux', displayServer: 'wayland', grimAvailable: false })
    expect(m.screenshot.supported).toBe(false)
    expect(m.screenshot.requiresPermission).toMatch(/grim/)
  })

  it('aquamarine 按 Wayland 处理', () => {
    const m = getDetailedCapabilityMatrix({ platform: 'linux', displayServer: 'aquamarine' })
    expect(m.displayServer).toBe('aquamarine')
    expect(m.mouse.supported).toBe(false)
  })
})

describe('字段完整性', () => {
  it('任意驱动下七字段齐全、notes 为数组', () => {
    for (const d of [
      { platform: 'win32' as const },
      { platform: 'darwin' as const },
      { platform: 'linux' as const, displayServer: 'x11' as const },
      { platform: 'linux' as const, displayServer: 'wayland' as const },
    ]) {
      const m = getDetailedCapabilityMatrix(d)
      expect(m).toHaveProperty('screenshot')
      expect(m).toHaveProperty('mouse')
      expect(m).toHaveProperty('keyboard')
      expect(m).toHaveProperty('windowManagement')
      expect(Array.isArray(m.notes)).toBe(true)
      for (const k of ['screenshot', 'mouse', 'keyboard'] as const) {
        expect(typeof m[k].supported).toBe('boolean')
        expect(typeof m[k].method).toBe('string')
      }
    }
  })
})
