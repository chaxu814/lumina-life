// ============================================================
// tests/platformMacAdapter.test.ts — macOS 适配器命令构造单测
//
// 不实际执行任何系统命令：mock child_process 包装层 execCmd，
// 仅断言 MacAdapter 各方法拼出的 osascript / screencapture / open 命令与参数。
// 同时验证辅助功能 / 屏幕录制授权提示出现在 capabilities.notes。
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'

// 拦截 PlatformAdapter 模块导出的 execCmd，记录调用、不真正 execFile。
const { execCmdMock, readFileSyncMock, unlinkSyncMock } = vi.hoisted(() => ({
  execCmdMock: vi.fn().mockResolvedValue(''),
  readFileSyncMock: vi.fn(),
  unlinkSyncMock: vi.fn(),
}))
vi.mock('../electron/core/platform/PlatformAdapter', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return { ...actual, execCmd: execCmdMock }
})
// fs 在本测试里只被 screenshot() 用于读临时 PNG / 删临时文件，整体打桩。
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return { ...actual, readFileSync: readFileSyncMock, unlinkSync: unlinkSyncMock }
})

import { MacAdapter } from '../electron/core/platform/MacAdapter'

/** 构造一个含合法 IHDR 的 PNG 头（宽 1920 高 1080），供 screenshot 读取宽高 */
function makePngBuf(w = 1920, h = 1080): Buffer {
  const buf = Buffer.alloc(24)
  buf[0] = 0x89; buf[1] = 0x50; buf[2] = 0x4e; buf[3] = 0x47
  buf[12] = 0x49; buf[13] = 0x48; buf[14] = 0x44; buf[15] = 0x52
  buf.writeUInt32BE(w, 16); buf.writeUInt32BE(h, 20)
  return buf
}

const adapter = new MacAdapter()

beforeEach(() => {
  execCmdMock.mockClear().mockResolvedValue('')
  readFileSyncMock.mockClear().mockReturnValue(makePngBuf())
  unlinkSyncMock.mockClear().mockImplementation(() => undefined)
})

// ── 能力与授权提示 ────────────────────────────────────────
describe('MacAdapter capabilities', () => {
  it('鼠标/键盘/截屏/窗口可用，UIA 关闭', () => {
    const c = adapter.capabilities
    expect(c.platform).toBe('darwin')
    expect(c.mouse).toBe(true)
    expect(c.keyboard).toBe(true)
    expect(c.screenshot).toBe(true)
    expect(c.windowInfo).toBe(true)
    expect(c.uia).toBe(false)
    expect(c.installedApps).toBe(false)
  })

  it('notes 含辅助功能 + 屏幕录制授权指引', () => {
    const joined = adapter.capabilities.notes.join('\n')
    expect(joined).toMatch(/辅助功能|Accessibility/)
    expect(joined).toMatch(/屏幕录制|Screen Recording/)
  })
})

// ── 鼠标：AppleScript 命令构造 ────────────────────────────
describe('MacAdapter 鼠标命令', () => {
  it('mouseMove 用 osascript set mousePosition', async () => {
    await adapter.mouseMove(120.4, 240.6)
    expect(execCmdMock).toHaveBeenCalledWith('osascript', [
      '-e',
      'tell application "System Events" to set mousePosition to {120,241}',
    ])
  })

  it('mouseClick 左键：click at 坐标', async () => {
    await adapter.mouseClick(100, 200, 'left', false)
    const [, args] = execCmdMock.mock.calls[0]
    expect(args[1]).toContain('click at {100,200}')
  })

  it('mouseClick 右键：使用 command down', async () => {
    await adapter.mouseClick(50, 60, 'right', false)
    const [, args] = execCmdMock.mock.calls[0]
    expect(args[1]).toContain('using {command down}')
  })

  it('mouseClick 双击：两次 click at', async () => {
    await adapter.mouseClick(10, 20, 'left', true)
    const [, args] = execCmdMock.mock.calls[0]
    // 脚本串里应出现两次 click at（分号分隔的两段）
    expect(args[1].split(/;\s*/).filter((s: string) => s.includes('click at {10,20}')).length).toBeGreaterThanOrEqual(2)
  })

  it('mouseHover 复用 set mousePosition', async () => {
    await adapter.mouseHover(77, 88, 400)
    expect(execCmdMock).toHaveBeenCalledWith('osascript', [
      '-e',
      'tell application "System Events" to set mousePosition to {77,88}',
    ])
  })

  it('mouseLongPress 走 bash 调 cliclick md/mu', async () => {
    await adapter.mouseLongPress(30, 40, 800)
    const [cmd, args] = execCmdMock.mock.calls[0]
    expect(cmd).toBe('bash')
    const script = args.join(' ')
    expect(script).toContain('cliclick m:30,40')
    expect(script).toContain('md:30,40')
    expect(script).toContain('mu:30,40')
  })

  it('mouseDrag：set mousePosition 起终点 + AXPress', async () => {
    await adapter.mouseDrag(10, 20, 300, 400)
    const [, args] = execCmdMock.mock.calls[0]
    expect(args[1]).toContain('set mousePosition to {10,20}')
    expect(args[1]).toContain('set mousePosition to {300,400}')
    expect(args[1]).toContain('AXPress')
  })

  it('mouseScroll：按次数 repeat 方向键', async () => {
    await adapter.mouseScroll(3)
    const [, args] = execCmdMock.mock.calls[0]
    expect(args[1]).toContain('repeat 3 times')
    expect(args[1]).toContain('control down')
  })
})

// ── 键盘 ─────────────────────────────────────────────────
describe('MacAdapter 键盘命令', () => {
  it('keyboardType 走 osascript keystroke 并转义引号', async () => {
    await adapter.keyboardType('say "hi"')
    const [, args] = execCmdMock.mock.calls[0]
    expect(args[1]).toContain('keystroke "say \\"hi\\""')
  })

  it('keyboardType 空串直接返回，不发命令', async () => {
    execCmdMock.mockClear()
    const r = await adapter.keyboardType('')
    expect(r).toBe('输入完成')
    expect(execCmdMock).not.toHaveBeenCalled()
  })

  it('keyPress 走 osascript key code', async () => {
    await adapter.keyPress('return')
    const [, args] = execCmdMock.mock.calls[0]
    expect(args[1]).toContain('key code return')
  })

  it('keyPress 空键直接失败', async () => {
    execCmdMock.mockClear()
    const r = await adapter.keyPress('')
    expect(r).toContain('按键失败')
    expect(execCmdMock).not.toHaveBeenCalled()
  })
})

// ── 截屏 / 窗口 / 应用 ────────────────────────────────────
describe('MacAdapter 截屏与应用', () => {
  it('screenshot 调 screencapture -x -t png', async () => {
    const res = await adapter.screenshot()
    expect(execCmdMock).toHaveBeenCalledWith('screencapture', ['-x', '-t', 'png', expect.any(String)], 10000)
    expect(res.w).toBe(1920)
    expect(res.h).toBe(1080)
    // 临时文件用完即删
    expect(unlinkSyncMock).toHaveBeenCalled()
  })

  it('getActiveWindow 用两段 osascript 取前台进程名/标题', async () => {
    execCmdMock.mockResolvedValue('Finder|Untitled')
    const w = await adapter.getActiveWindow()
    const [cmd, args] = execCmdMock.mock.calls[0]
    expect(cmd).toBe('osascript')
    expect(args.length).toBeGreaterThanOrEqual(3)
    expect(w?.processName).toBe('Finder')
    expect(w?.title).toBe('Untitled')
  })

  it('openApp 用 open -a', async () => {
    await adapter.openApp('Safari')
    expect(execCmdMock).toHaveBeenCalledWith('open', ['-a', 'Safari'])
  })

  it('getInstalledApps 列 /Applications', async () => {
    execCmdMock.mockResolvedValue('Safari\nMail\n')
    const apps = await adapter.getInstalledApps()
    expect(execCmdMock).toHaveBeenCalledWith('bash', expect.arrayContaining([expect.stringContaining('ls /Applications')]), 8000)
    expect(apps.map(a => a.name)).toEqual(['Safari', 'Mail'])
  })

  it('getUiaTree 优雅降级为空数组', async () => {
    await expect(adapter.getUiaTree()).resolves.toEqual([])
  })
})
