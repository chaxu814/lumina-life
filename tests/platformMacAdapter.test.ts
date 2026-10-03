// ============================================================
// tests/platformMacAdapter.test.ts — macOS 适配器命令构造单测
//
// 不实际执行任何系统命令：mock child_process 包装层 execCmd，
// 仅断言 MacAdapter 各方法拼出的 osascript / cliclick / screencapture / open 命令与参数。
// 覆盖两条路径：
//   • cliclickAvailable=true  → 键鼠优先 cliclick，长按/拖拽用 cliclick
//   • cliclickAvailable=false → 退化为 AppleScript(System Events)，长按给安装指引
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

import { MacAdapter, buildMacKeyScript } from '../electron/core/platform/MacAdapter'
import {
  getCapabilityStatus, resetCapabilityStatuses,
} from '../electron/core/platform/platformStatus'

/** 构造一个含合法 IHDR 的 PNG 头（宽 1920 高 1080），供 screenshot 读取宽高 */
function makePngBuf(w = 1920, h = 1080): Buffer {
  const buf = Buffer.alloc(24)
  buf[0] = 0x89; buf[1] = 0x50; buf[2] = 0x4e; buf[3] = 0x47
  buf[12] = 0x49; buf[13] = 0x48; buf[14] = 0x44; buf[15] = 0x52
  buf.writeUInt32BE(w, 16); buf.writeUInt32BE(h, 20)
  return buf
}

// 两个适配器：一个有 cliclick，一个没有，分别断言两条实现路径
const clic = new MacAdapter({ cliclickAvailable: true })
const noCli = new MacAdapter({ cliclickAvailable: false })

beforeEach(() => {
  execCmdMock.mockClear().mockResolvedValue('')
  readFileSyncMock.mockClear().mockReturnValue(makePngBuf())
  unlinkSyncMock.mockClear().mockImplementation(() => undefined)
})

// ── 能力与授权提示 ────────────────────────────────────────
describe('MacAdapter capabilities', () => {
  it('鼠标/键盘/截屏/窗口/已装应用可用，AX 元素树已实现', () => {
    const c = clic.capabilities
    expect(c.platform).toBe('darwin')
    expect(c.mouse).toBe(true)
    expect(c.keyboard).toBe(true)
    expect(c.screenshot).toBe(true)
    expect(c.windowInfo).toBe(true)
    // v0.1：macOS 用 AX（Accessibility）补上 Windows UIA 的等价能力
    expect(c.uia).toBe(true)
    expect(c.installedApps).toBe(true)
  })

  it('notes 含辅助功能 + 屏幕录制授权指引', () => {
    const joined = clic.capabilities.notes.join('\n')
    expect(joined).toMatch(/辅助功能|Accessibility/)
    expect(joined).toMatch(/屏幕录制|Screen Recording/)
  })

  it('无 cliclick 时 notes 给出 brew install cliclick 指引', () => {
    expect(noCli.capabilities.notes.join('\n')).toMatch(/brew install cliclick/)
  })
})

// ── 鼠标：有 cliclick 时优先 cliclick ─────────────────────
describe('MacAdapter 鼠标命令（cliclick 可用）', () => {
  it('mouseMove 走 cliclick m:x,y', async () => {
    await clic.mouseMove(120.4, 240.6)
    expect(execCmdMock).toHaveBeenCalledWith('cliclick', ['m:120,241'])
  })

  it('mouseClick 左键 → cliclick c:x,y；右键 → rc:；双击 → dc:', async () => {
    await clic.mouseClick(100, 200, 'left', false)
    expect(execCmdMock).toHaveBeenLastCalledWith('cliclick', ['c:100,200'])
    await clic.mouseClick(50, 60, 'right', false)
    expect(execCmdMock).toHaveBeenLastCalledWith('cliclick', ['rc:50,60'])
    await clic.mouseClick(10, 20, 'left', true)
    expect(execCmdMock).toHaveBeenLastCalledWith('cliclick', ['dc:10,20'])
  })

  it('mouseHover 复用 cliclick m:x,y', async () => {
    await clic.mouseHover(77, 88, 400)
    expect(execCmdMock).toHaveBeenCalledWith('cliclick', ['m:77,88'])
  })

  it('mouseLongPress 走 bash 调 cliclick md/mu', async () => {
    await clic.mouseLongPress(30, 40, 800)
    const [cmd, args] = execCmdMock.mock.calls[0]
    expect(cmd).toBe('bash')
    const script = args.join(' ')
    expect(script).toContain('cliclick m:30,40')
    expect(script).toContain('md:30,40')
    expect(script).toContain('mu:30,40')
  })

  it('mouseDrag 走 cliclick md/mu 起终点', async () => {
    await clic.mouseDrag(10, 20, 300, 400)
    const [, args] = execCmdMock.mock.calls[0]
    const script = args.join(' ')
    expect(script).toContain('cliclick m:10,20 md:10,20')
    expect(script).toContain('m:300,400 mu:300,400')
  })
})

// ── 鼠标：无 cliclick 退化为 AppleScript ───────────────────
describe('MacAdapter 鼠标命令（无 cliclick，AppleScript 降级）', () => {
  it('mouseMove 用 osascript set mousePosition', async () => {
    await noCli.mouseMove(120.4, 240.6)
    expect(execCmdMock).toHaveBeenCalledWith('osascript', [
      '-e',
      'tell application "System Events" to set mousePosition to {120,241}',
    ])
  })

  it('mouseClick 左键：click at 坐标', async () => {
    await noCli.mouseClick(100, 200, 'left', false)
    const [, args] = execCmdMock.mock.calls[0]
    expect(args[1]).toContain('click at {100,200}')
  })

  it('mouseClick 右键：ctrl+click（control down）', async () => {
    await noCli.mouseClick(50, 60, 'right', false)
    const [, args] = execCmdMock.mock.calls[0]
    expect(args[1]).toContain('using {control down}')
  })

  it('mouseClick 双击：两次 click at', async () => {
    await noCli.mouseClick(10, 20, 'left', true)
    const [, args] = execCmdMock.mock.calls[0]
    expect(args[1].split(/;\s*/).filter((s: string) => s.includes('click at {10,20}')).length).toBeGreaterThanOrEqual(2)
  })

  it('mouseLongPress 无 cliclick 时不发命令，返回安装指引', async () => {
    execCmdMock.mockClear()
    const r = await noCli.mouseLongPress(30, 40, 800)
    expect(r).toMatch(/长按失败/)
    expect(r).toMatch(/brew install cliclick/)
    expect(execCmdMock).not.toHaveBeenCalled()
  })

  it('mouseDrag：set mousePosition 起终点 + AXPress', async () => {
    await noCli.mouseDrag(10, 20, 300, 400)
    const [, args] = execCmdMock.mock.calls[0]
    expect(args[1]).toContain('set mousePosition to {10,20}')
    expect(args[1]).toContain('set mousePosition to {300,400}')
    expect(args[1]).toContain('AXPress')
  })

  it('mouseScroll：按次数 repeat 方向键', async () => {
    await noCli.mouseScroll(3)
    const [, args] = execCmdMock.mock.calls[0]
    expect(args[1]).toContain('repeat 3 times')
    expect(args[1]).toContain('control down')
  })
})

// ── 键盘：键码映射 ────────────────────────────────────────
describe('MacAdapter 键盘命令', () => {
  it('keyboardType 走 osascript keystroke 并转义引号', async () => {
    await clic.keyboardType('say "hi"')
    const [, args] = execCmdMock.mock.calls[0]
    expect(args[1]).toContain('keystroke "say \\"hi\\""')
  })

  it('keyboardType 空串直接返回，不发命令', async () => {
    execCmdMock.mockClear()
    const r = await clic.keyboardType('')
    expect(r).toBe('输入完成')
    expect(execCmdMock).not.toHaveBeenCalled()
  })

  it('keyPress 把键名映射成数字 key code（return→36）', async () => {
    await clic.keyPress('return')
    const [, args] = execCmdMock.mock.calls[0]
    expect(args[1]).toContain('key code 36')
  })

  it('组合键 ctrl_c → key code 8 using control down', () => {
    expect(buildMacKeyScript('ctrl_c')).toBe(
      'tell application "System Events" to key code 8 using {control down}')
  })

  it('组合键 alt_f4 → key code 118 using option down', () => {
    expect(buildMacKeyScript('alt_f4')).toBe(
      'tell application "System Events" to key code 118 using {option down}')
  })

  it('方向键上 → key code 126', () => {
    expect(buildMacKeyScript('up')).toBe('tell application "System Events" to key code 126')
  })

  it('keyPress 空键直接失败', async () => {
    execCmdMock.mockClear()
    const r = await clic.keyPress('')
    expect(r).toContain('按键失败')
    expect(execCmdMock).not.toHaveBeenCalled()
  })

  it('辅助功能被拒（-1743）时返回权限引导', async () => {
    execCmdMock.mockResolvedValue('ERR:EnvError: osascript failed: -1743|')
    const r = await clic.keyPress('return')
    expect(r).toMatch(/辅助功能/)
  })
})

// ── 截屏 / 窗口 / 应用 ────────────────────────────────────
describe('MacAdapter 截屏与应用', () => {
  it('screenshot 调 screencapture -x -t png', async () => {
    const res = await clic.screenshot()
    expect(execCmdMock).toHaveBeenCalledWith('screencapture', ['-x', '-t', 'png', expect.any(String)], 10000)
    expect(res.w).toBe(1920)
    expect(res.h).toBe(1080)
    expect(unlinkSyncMock).toHaveBeenCalled()
  })

  it('屏幕录制被拒时抛权限引导（并含 macOS 13+ 正式权限名）', async () => {
    execCmdMock.mockResolvedValue('ERR:tccERR 123|')
    await expect(clic.screenshot()).rejects.toThrow(/屏幕与系统音频录制|Screen Recording/)
  })

  it('屏幕录制被拒时登记结构化 needs_permission 状态', async () => {
    resetCapabilityStatuses()
    execCmdMock.mockResolvedValue('ERR:tccERR 123|')
    await expect(clic.screenshot()).rejects.toThrow()
    const s = getCapabilityStatus('screenshot')
    expect(s.state).toBe('needs_permission')
    if (s.state === 'needs_permission') {
      expect(s.permission).toBe('screen_recording')
      expect(s.settingsPath).toMatch(/屏幕与系统音频录制|屏幕录制/)
    }
    resetCapabilityStatuses()
  })

  it('getActiveWindow 用两段 osascript 取前台进程名/标题', async () => {
    execCmdMock.mockResolvedValue('Finder|Untitled')
    const w = await clic.getActiveWindow()
    const [cmd, args] = execCmdMock.mock.calls[0]
    expect(cmd).toBe('osascript')
    expect(args.length).toBeGreaterThanOrEqual(3)
    expect(w?.processName).toBe('Finder')
    expect(w?.title).toBe('Untitled')
  })

  it('getActiveWindow 解析 position/size 里的 point 坐标', async () => {
    execCmdMock.mockResolvedValue('Safari|Example|100, 200|800, 600')
    const w = await clic.getActiveWindow()
    expect(w?.bounds).toEqual({ x: 100, y: 200, w: 800, h: 600 })
  })

  it('openApp 用 open -a', async () => {
    await clic.openApp('Safari')
    expect(execCmdMock).toHaveBeenCalledWith('open', ['-a', 'Safari'])
  })

  it('getInstalledApps 列 /Applications', async () => {
    execCmdMock.mockResolvedValue('Safari\nMail\n')
    const apps = await clic.getInstalledApps()
    expect(execCmdMock).toHaveBeenCalledWith('bash', expect.arrayContaining([expect.stringContaining('ls /Applications')]), 8000)
    expect(apps.map(a => a.name)).toEqual(['Safari', 'Mail'])
  })

  it('getUiaTree 走 AX 扫描（不再是无条件空数组）', async () => {
    execCmdMock.mockResolvedValue('')
    await clic.getUiaTree()
    const [cmd, args] = execCmdMock.mock.calls[0]
    expect(cmd).toBe('osascript')
    expect(args[1]).toContain('System Events')
  })
})
