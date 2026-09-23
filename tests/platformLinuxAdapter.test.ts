// ============================================================
// tests/platformLinuxAdapter.test.ts — Linux 适配器能力分级与命令构造单测
//
// 覆盖三种状态：
//   ① X11 + xdotool 可用      → 鼠标/键盘/截屏/窗口信息全能力
//   ② X11 无 xdotool          → 鼠标/键盘禁用 + 安装提示
//   ③ Wayland                 → 鼠标/键盘禁用 + 切 X11 提示；截屏走 grim
// 另验证截屏降级链（X11: gnome-screenshot→scrot→import；Wayland: grim），
// 以及禁用态下所有鼠标/键盘方法在适配层短路（不 execFile 任何命令）。
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { execCmdMock, readFileSyncMock, unlinkSyncMock } = vi.hoisted(() => ({
  execCmdMock: vi.fn().mockResolvedValue(''),
  readFileSyncMock: vi.fn(),
  unlinkSyncMock: vi.fn(),
}))
vi.mock('../electron/core/platform/PlatformAdapter', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return { ...actual, execCmd: execCmdMock }
})
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return { ...actual, readFileSync: readFileSyncMock, unlinkSync: unlinkSyncMock }
})

import { LinuxAdapter } from '../electron/core/platform/LinuxAdapter'

function makePngBuf(w = 1920, h = 1080): Buffer {
  const buf = Buffer.alloc(24)
  buf[0] = 0x89; buf[1] = 0x50; buf[2] = 0x4e; buf[3] = 0x47
  buf[12] = 0x49; buf[13] = 0x48; buf[14] = 0x44; buf[15] = 0x52
  buf.writeUInt32BE(w, 16); buf.writeUInt32BE(h, 20)
  return buf
}

beforeEach(() => {
  execCmdMock.mockClear().mockResolvedValue('')
  readFileSyncMock.mockClear().mockReturnValue(makePngBuf())
  unlinkSyncMock.mockClear().mockImplementation(() => undefined)
})

// ── ① X11 + xdotool 全能力 ────────────────────────────────
describe('LinuxAdapter X11 + xdotool（全能力）', () => {
  const a = new LinuxAdapter({ sessionType: 'x11', xdotoolAvailable: true })

  it('鼠标/键盘/截屏/窗口可用，UIA 关闭', () => {
    const c = a.capabilities
    expect(c.platform).toBe('linux')
    expect(c.mouse).toBe(true)
    expect(c.keyboard).toBe(true)
    expect(c.screenshot).toBe(true)
    expect(c.windowInfo).toBe(true)
    expect(c.uia).toBe(false)
  })

  it('mouseMove → xdotool mousemove', async () => {
    await a.mouseMove(120.4, 240.6)
    expect(execCmdMock).toHaveBeenCalledWith('xdotool', ['mousemove', '120', '241'])
  })

  it('mouseClick 左键单击 → xdotool click 1；右键 → 3；双击 → repeat 2', async () => {
    await a.mouseClick(1, 2, 'left', false)
    expect(execCmdMock).toHaveBeenLastCalledWith('xdotool',
      ['mousemove', '1', '2', 'click', '--repeat', '1', '--delay', '100', '1'])
    await a.mouseClick(3, 4, 'right', false)
    expect(execCmdMock).toHaveBeenLastCalledWith('xdotool',
      ['mousemove', '3', '4', 'click', '--repeat', '1', '--delay', '100', '3'])
    await a.mouseClick(5, 6, 'left', true)
    expect(execCmdMock).toHaveBeenLastCalledWith('xdotool',
      ['mousemove', '5', '6', 'click', '--repeat', '2', '--delay', '100', '1'])
  })

  it('mouseScroll 向上=按钮5 向下=按钮4', async () => {
    await a.mouseScroll(3)
    expect(execCmdMock).toHaveBeenLastCalledWith('xdotool', ['click', '--repeat', '3', '--delay', '50', '5'])
    await a.mouseScroll(-2)
    expect(execCmdMock).toHaveBeenLastCalledWith('xdotool', ['click', '--repeat', '2', '--delay', '50', '4'])
  })

  it('keyboardType → xdotool type --delay 50', async () => {
    await a.keyboardType('hello')
    expect(execCmdMock).toHaveBeenCalledWith('xdotool', ['type', '--delay', '50', 'hello'])
  })

  it('keyPress → xdotool key', async () => {
    await a.keyPress('Return')
    expect(execCmdMock).toHaveBeenCalledWith('xdotool', ['key', 'return'])
  })

  it('openApp → xdg-open', async () => {
    await a.openApp('firefox')
    expect(execCmdMock).toHaveBeenCalledWith('xdg-open', ['firefox'])
  })
})

// ── ② X11 无 xdotool ─────────────────────────────────────
describe('LinuxAdapter X11 无 xdotool（键鼠禁用）', () => {
  const a = new LinuxAdapter({ sessionType: 'x11', xdotoolAvailable: false })

  it('鼠标/键盘禁用，提示安装 xdotool', () => {
    const c = a.capabilities
    expect(c.mouse).toBe(false)
    expect(c.keyboard).toBe(false)
    expect(c.screenshot).toBe(true)
    expect(c.notes.join(' ')).toMatch(/xdotool/)
  })

  it('所有鼠标/键盘方法短路，不调用任何系统命令', async () => {
    execCmdMock.mockClear()
    const results = await Promise.all([
      a.mouseMove(1, 2),
      a.mouseClick(1, 2, 'left', false),
      a.mouseHover(1, 2, 400),
      a.mouseLongPress(1, 2, 800),
      a.mouseDrag(1, 2, 3, 4),
      a.mouseScroll(3),
      a.keyboardType('hi'),
      a.keyPress('Return'),
    ])
    for (const r of results) {
      expect(r).toMatch(/失败/)
    }
    expect(execCmdMock).not.toHaveBeenCalled()
  })
})

// ── ③ Wayland ────────────────────────────────────────────
describe('LinuxAdapter Wayland（键鼠禁用，截屏走 grim）', () => {
  const a = new LinuxAdapter({ sessionType: 'wayland', xdotoolAvailable: true })

  it('鼠标/键盘禁用，截屏仍可用，提示切 X11', () => {
    const c = a.capabilities
    expect(c.mouse).toBe(false)
    expect(c.keyboard).toBe(false)
    expect(c.screenshot).toBe(true)
    expect(c.notes.join(' ')).toMatch(/Wayland/)
  })

  it('Wayland 截屏只尝试 grim', async () => {
    execCmdMock.mockImplementation((bin: string) => Promise.resolve(bin === 'grim' ? '' : 'ERR:nope|'))
    const res = await a.screenshot()
    const bins = execCmdMock.mock.calls.map(c => c[0])
    expect(bins).toEqual(['grim'])
    expect(res.w).toBe(1920)
    expect(res.h).toBe(1080)
  })

  it('Wayland 鼠标动作短路并提示切 X11', async () => {
    execCmdMock.mockClear()
    const msg = await a.mouseClick(10, 10, 'left', false)
    expect(msg).toContain('点击失败')
    expect(msg).toMatch(/Wayland|X11/)
    expect(execCmdMock).not.toHaveBeenCalled()
  })
})

// ── X11 截屏降级链 ───────────────────────────────────────
describe('LinuxAdapter X11 截屏降级链', () => {
  it('gnome-screenshot 失败 → 回退 scrot 成功', async () => {
    execCmdMock.mockImplementation((bin: string) =>
      bin === 'gnome-screenshot' ? Promise.resolve('ERR:not installed|') : Promise.resolve(''))
    const a = new LinuxAdapter({ sessionType: 'x11', xdotoolAvailable: true })
    const res = await a.screenshot()
    const bins = execCmdMock.mock.calls.map(c => c[0])
    expect(bins[0]).toBe('gnome-screenshot')
    expect(bins[1]).toBe('scrot')
    expect(res.w).toBe(1920)
  })

  it('全部截图工具失败时按 gnome→scrot→import 顺序尝试并抛错', async () => {
    execCmdMock.mockResolvedValue('ERR:missing|')
    const a = new LinuxAdapter({ sessionType: 'x11', xdotoolAvailable: true })
    await expect(a.screenshot()).rejects.toThrow(/截图工具/)
    const bins = execCmdMock.mock.calls.map(c => c[0])
    expect(bins).toEqual(['gnome-screenshot', 'scrot', 'import'])
  })
})
