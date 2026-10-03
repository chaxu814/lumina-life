// ============================================================
// tests/macDock.test.ts — macOS 托盘 / Dock 差异适配单测
//
// 纯逻辑部分可单测：Dock 模式解析、template image 平台惯例。
// 不创建真实 Tray/Dock（需要 macOS 运行环境）。
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { nativeImageMock } = vi.hoisted(() => ({
  nativeImageMock: {
    createFromPath: vi.fn(),
    createEmpty: vi.fn(),
  },
}))
vi.mock('electron', () => ({
  nativeImage: nativeImageMock,
}))

import {
  resolveDockMode, applyTrayIconConventions, applyMacDock, buildTrayIcon,
} from '../electron/tray/macDock'

/** 造一个可观测的假 NativeImage（resize 按真 API 语义返回自身） */
function fakeImage(empty = false) {
  const img: any = {
    isEmpty: () => empty,
    setTemplateImage: vi.fn(),
    resize: vi.fn(() => img),
  }
  return img
}

describe('resolveDockMode', () => {
  it('★ 缺省/非法值 → show（保守，不隐藏 Dock，保留 Cmd+Q）', () => {
    expect(resolveDockMode(undefined)).toBe('show')
    expect(resolveDockMode(null)).toBe('show')
    expect(resolveDockMode('')).toBe('show')
    expect(resolveDockMode('garbage')).toBe('show')
    expect(resolveDockMode('0')).toBe('show')
  })

  it('显式开启值 → hide', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on', 'hide', ' Hide ']) {
      expect(resolveDockMode(v)).toBe('hide')
    }
  })
})

describe('applyTrayIconConventions', () => {
  it('darwin：标记为 template image（菜单栏随深浅色反色）', () => {
    const img = fakeImage()
    applyTrayIconConventions(img, 'darwin')
    expect(img.setTemplateImage).toHaveBeenCalledWith(true)
  })

  it('★ win32 / linux：不做任何处理（Windows 行为零变化）', () => {
    for (const p of ['win32', 'linux'] as NodeJS.Platform[]) {
      const img = fakeImage()
      applyTrayIconConventions(img, p)
      expect(img.setTemplateImage).not.toHaveBeenCalled()
    }
  })

  it('空图标/异常不抛出', () => {
    const bad = { isEmpty: () => true, setTemplateImage: () => { throw new Error('no bitmap') } } as any
    expect(() => applyTrayIconConventions(bad, 'darwin')).not.toThrow()
  })
})

describe('applyMacDock', () => {
  it('非 darwin：完全不碰 dock', () => {
    const dock = { hide: vi.fn(), setIcon: vi.fn() }
    expect(applyMacDock({ dock } as any, null, 'hide', 'win32')).toBe('show')
    expect(dock.hide).not.toHaveBeenCalled()
    expect(dock.setIcon).not.toHaveBeenCalled()
  })

  it('darwin + hide：调用 dock.hide()', () => {
    const dock = { hide: vi.fn(), setIcon: vi.fn() }
    expect(applyMacDock({ dock } as any, null, 'hide', 'darwin')).toBe('hide')
    expect(dock.hide).toHaveBeenCalled()
  })

  it('darwin + show：设置 Dock 图标，不隐藏', () => {
    const dock = { hide: vi.fn(), setIcon: vi.fn() }
    const img = fakeImage()
    expect(applyMacDock({ dock } as any, img, 'show', 'darwin')).toBe('show')
    expect(dock.setIcon).toHaveBeenCalledWith(img)
    expect(dock.hide).not.toHaveBeenCalled()
  })

  it('dock 不可用时安全返回', () => {
    expect(applyMacDock({} as any, null, 'show', 'darwin')).toBe('show')
  })
})

describe('buildTrayIcon', () => {
  // createFromPath 是模块级 mock，不清理会在用例间泄露调用序列
  beforeEach(() => {
    nativeImageMock.createFromPath.mockReset()
    nativeImageMock.createEmpty.mockReset()
  })

  it('优先用专用小图', () => {
    const good = fakeImage()
    nativeImageMock.createFromPath.mockReturnValue(good)
    const out = buildTrayIcon('icon-16.png', 'icon.png', 'darwin')
    expect(nativeImageMock.createFromPath).toHaveBeenCalledWith('icon-16.png')
    expect(out).toBe(good)
    // darwin 下同样套用 template 惯例
    expect(good.setTemplateImage).toHaveBeenCalledWith(true)
  })

  it('小图为空时回退到大图缩放', () => {
    const empty = fakeImage(true)
    const big = fakeImage()
    nativeImageMock.createFromPath
      .mockReturnValueOnce(empty)
      .mockReturnValueOnce(big)
    const out = buildTrayIcon('icon-16.png', 'icon.png', 'win32')
    expect(nativeImageMock.createFromPath).toHaveBeenNthCalledWith(2, 'icon.png')
    expect(big.resize).toHaveBeenCalledWith({ width: 16, height: 16 })
    expect(out).toBe(big)
  })
})
