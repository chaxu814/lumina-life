// ============================================================
// electron/core/platform/MacAdapter.ts — macOS 桌面控制实现
//
// 键鼠优先走 cliclick（brew install cliclick，更稳、支持长按/拖拽）；
// cliclick 不可用时退化为 AppleScript(System Events)。
// 截屏用 screencapture -x（不发声、不弹窗）。
//
// 权限前提（macOS 沙箱模型）：
//   • 辅助功能(Accessibility) —— 控制鼠标/键盘所必需
//   • 屏幕录制(Screen Recording) —— screencapture 取屏所必需
// 需在「系统设置 → 隐私与安全性」中授权给 Lumina / 终端 / 运行宿主。
// 未授权时 osascript 会报 -1743（not allowed assistive access），错误串原样返回给上层。
//
// 检测项可在构造时注入（便于单测 mock，不实际调用系统命令）：
//   cliclickAvailable ← commandExists('cliclick')
// ============================================================

import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'
import {
  PlatformAdapter, PlatformCapabilities, ScreenCaptureResult,
  ActiveWindowInfo, InstalledApp, execCmd, wrapCmdResult, readPngSize, commandExists,
} from './PlatformAdapter'

export interface MacAdapterOptions {
  /** 注入 cliclick 是否可用（默认运行时 which cliclick 探测） */
  cliclickAvailable?: boolean
}

/**
 * AppleScript `key code` 需要数字键码，不能直接喂键名。
 * 这里维护一张常用键名 → macOS Virtual KeyCode 映射。
 * 组合键（如 ctrl_c / alt_f4 / shift_tab）在 keyPress 里解析。
 */
const MAC_KEYCODES: Record<string, number> = {
  return: 36, enter: 36, tab: 48, space: 49,
  delete: 51, backspace: 51, escape: 53, esc: 53,
  command: 55, cmd: 55, shift: 56, capslock: 57,
  option: 58, alt: 58, control: 59, ctrl: 59,
  ' ': 49,
  home: 115, pageup: 116, pagedown: 121, forwarddelete: 117,
  end: 119, left: 123, right: 124, down: 125, up: 126,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97,
  f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7,
  c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15, y: 16,
  t: 17, o: 31, u: 32, i: 34, p: 35, n: 45, m: 46, j: 38, k: 40, l: 37,
}

/** ctrl/alt/shift/command 修饰键 → AppleScript using 子句里的名字 */
const MAC_MODIFIERS: Record<string, string> = {
  ctrl: 'control down', control: 'control down',
  alt: 'option down', option: 'option down',
  shift: 'shift down',
  cmd: 'command down', command: 'command down',
}

/** 把 keyPress('ctrl_c' | 'return' | 'shift_tab') 编译成 osascript -e 片段 */
export function buildMacKeyScript(rawKey: string): string {
  const k = (rawKey || '').trim().toLowerCase()
  const parts = k.split('_')
  // 纯键名（无修饰）
  if (parts.length === 1) {
    const code = MAC_KEYCODES[k]
    if (code !== undefined) {return `tell application "System Events" to key code ${code}`}
    // 未知键：退化为 keystroke 单字符（可打印字符）
    if (k.length === 1) {return `tell application "System Events" to keystroke "${k}"`}
    // 实在认不出：原样交给 AppleScript，实机报错会回传
    return `tell application "System Events" to key code "${k}"`
  }
  // 组合键：最后一段是主键，前面全是修饰键
  const main = parts[parts.length - 1]
  const mods: string[] = []
  for (const m of parts.slice(0, -1)) {
    if (MAC_MODIFIERS[m]) {mods.push(MAC_MODIFIERS[m])}
  }
  const mainCode = MAC_KEYCODES[main]
  const using = mods.length ? ` using {${mods.join(', ')}}` : ''
  if (mainCode !== undefined) {return `tell application "System Events" to key code ${mainCode}${using}`}
  return `tell application "System Events" to keystroke "${main}"${using}`
}

export class MacAdapter implements PlatformAdapter {
  readonly capabilities: PlatformCapabilities
  private readonly cliclickAvailable: boolean

  constructor(opts: MacAdapterOptions = {}) {
    this.cliclickAvailable = opts.cliclickAvailable ?? commandExists('cliclick')
    const toolchain = this.cliclickAvailable ? 'cliclick + AppleScript' : 'AppleScript(System Events)'
    this.capabilities = {
      platform: 'darwin',
      mouse: true,
      keyboard: true,
      screenshot: true,
      windowInfo: true,
      uia: false,
      openApp: true,
      installedApps: false,
      notes: [
        'macOS 需在「系统设置 → 隐私与安全性」中授权：辅助功能（控制鼠标键盘）+ 屏幕录制（截屏），授权后重启 App 生效。',
        this.cliclickAvailable
          ? '检测到 cliclick，鼠标移动/点击/长按/拖拽将优先使用它，稳定性最佳。'
          : '未检测到 cliclick：长按/拖拽不可用，可执行 brew install cliclick 后重启 App 以获得完整桌面操控。',
        `当前键鼠实现：${toolchain}。`,
        'macOS 无 Windows UIA 元素树，Computer Use 以截屏+坐标为主。',
      ],
    }
  }

  async mouseMove(x: number, y: number): Promise<string> {
    const rx = Math.round(x), ry = Math.round(y)
    if (this.cliclickAvailable) {
      const r = await execCmd('cliclick', [`m:${rx},${ry}`])
      return wrapCmdResult(r, '移动')
    }
    const r = await execCmd('osascript', ['-e', `tell application "System Events" to set mousePosition to {${rx},${ry}}`])
    return wrapCmdResult(r, '移动')
  }

  async mouseClick(x: number, y: number, button: 'left' | 'right', dbl: boolean): Promise<string> {
    const rx = Math.round(x), ry = Math.round(y)
    if (this.cliclickAvailable) {
      // cliclick: c=左击 rc=右击 dc=双击
      const verb = button === 'right' ? 'rc' : (dbl ? 'dc' : 'c')
      const r = await execCmd('cliclick', [`${verb}:${rx},${ry}`])
      return wrapCmdResult(r, '点击')
    }
    if (button === 'right') {
      // macOS 右键走 ctrl+click 更通用
      const r = await execCmd('osascript', ['-e',
        `tell application "System Events" to click at {${rx},${ry}} using {control down}`])
      return wrapCmdResult(r, '点击')
    }
    const osaCmd = dbl
      ? `tell application "System Events" to click at {${rx},${ry}}; delay 0.1; tell application "System Events" to click at {${rx},${ry}}`
      : `tell application "System Events" to click at {${rx},${ry}}`
    const r = await execCmd('osascript', ['-e', osaCmd])
    return wrapCmdResult(r, '点击')
  }

  async mouseHover(x: number, y: number, _holdMs: number): Promise<string> {
    const rx = Math.round(x), ry = Math.round(y)
    if (this.cliclickAvailable) {
      const r = await execCmd('cliclick', [`m:${rx},${ry}`])
      return wrapCmdResult(r, '悬停')
    }
    const r = await execCmd('osascript', ['-e', `tell application "System Events" to set mousePosition to {${rx},${ry}}`])
    return wrapCmdResult(r, '悬停')
  }

  async mouseLongPress(x: number, y: number, holdMs: number): Promise<string> {
    const rx = Math.round(x), ry = Math.round(y)
    if (!this.cliclickAvailable) {
      // AppleScript(System Events) 无法可靠实现「按住」，明确告知而不是执行注定失败的命令
      return '长按失败:macOS 长按需安装 cliclick 后使用：brew install cliclick（装完重启 App）。'
    }
    const hold = (holdMs / 1000).toFixed(2)
    const r = await execCmd('bash', ['-c',
      `cliclick m:${rx},${ry} md:${rx},${ry} && sleep ${hold} && cliclick mu:${rx},${ry}`])
    return wrapCmdResult(r, '长按')
  }

  async mouseDrag(x1: number, y1: number, x2: number, y2: number): Promise<string> {
    const rx1 = Math.round(x1), ry1 = Math.round(y1), rx2 = Math.round(x2), ry2 = Math.round(y2)
    if (this.cliclickAvailable) {
      const r = await execCmd('bash', ['-c',
        `cliclick m:${rx1},${ry1} md:${rx1},${ry1} m:${rx2},${ry2} mu:${rx2},${ry2}`])
      return wrapCmdResult(r, '拖拽')
    }
    const r = await execCmd('osascript', ['-e',
      `tell application "System Events"\n  set mousePosition to {${rx1},${ry1}}\n  perform action "AXPress" at mousePosition\n  delay 0.05\n  set mousePosition to {${rx2},${ry2}}\n  perform action "AXPress" at mousePosition\nend tell`])
    return wrapCmdResult(r, '拖拽')
  }

  async mouseScroll(amount: number): Promise<string> {
    const n = Math.abs(amount)
    const r = await execCmd('osascript', ['-e',
      `tell application "System Events" to repeat ${n} times\n  key code 124 using {control down}\n  delay 0.02\nend repeat`])
    return wrapCmdResult(r, '滚动')
  }

  async keyboardType(text: string): Promise<string> {
    if (!text) {return '输入完成'}
    const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const r = await execCmd('osascript', ['-e', `tell application "System Events" to keystroke "${escaped}"`])
    return wrapCmdResult(r, '输入')
  }

  async keyPress(key: string): Promise<string> {
    const k = (key || '').trim()
    if (!k) {return '按键失败:空按键'}
    const osaCmd = buildMacKeyScript(k)
    const r = await execCmd('osascript', ['-e', osaCmd])
    // 辅助功能被拒时 osascript 退出码非 0，错误串会带 -1743 / Not authorized
    if (r.startsWith('ERR:') && /-1743|Not authorized|assistive access/i.test(r)) {
      return `按键失败:未授予辅助功能权限，请在「系统设置 → 隐私与安全性 → 辅助功能」中勾选 Lumina 后重启 App`
    }
    return wrapCmdResult(r, '按键')
  }

  async screenshot(): Promise<ScreenCaptureResult> {
    const tmp = path.join(os.tmpdir(), `lu-mac-sc-${Date.now()}.png`)
    try {
      // -x: 不播放截图音效；-t png: 输出 PNG
      const r = await execCmd('screencapture', ['-x', '-t', 'png', tmp], 10000)
      if (r.startsWith('ERR:')) {
        if (/tccERR|not permitted|screen.*record|kCGError/i.test(r)) {
          throw new Error('截屏失败:未授予屏幕录制权限，请在「系统设置 → 隐私与安全性 → 屏幕录制」中勾选 Lumina 后重启 App')
        }
        throw new Error(r.slice(4))
      }
      const buf = fs.readFileSync(tmp)
      const { w, h } = readPngSize(buf)
      return { buffer: buf, w, h }
    } finally {
      try { fs.unlinkSync(tmp) } catch { /* ignore */ }
    }
  }

  async getActiveWindow(): Promise<ActiveWindowInfo | null> {
    const r = await execCmd('osascript', ['-e',
      'tell application "System Events" to set fw to first application process whose frontmost is true',
      '-e', 'tell application "System Events" to return (name of fw) & "|" & (name of window 1 of fw)'], 8000)
    if (r.startsWith('ERR:') || !r.includes('|')) {return null}
    const [processName, title] = r.split('|')
    return { title: (title || '').trim(), processName: (processName || '').trim(), bounds: { x: 0, y: 0, w: 0, h: 0 } }
  }

  async getUiaTree(): Promise<unknown[]> {
    // macOS 无 Windows UIA；AX 树按需另做，此处优雅降级为空。
    return []
  }

  async openApp(appName: string): Promise<string> {
    const r = await execCmd('open', ['-a', appName])
    return r.startsWith('ERR:') ? `打开应用失败:${r.slice(4)}` : '已尝试打开应用'
  }

  async getInstalledApps(): Promise<InstalledApp[]> {
    const r = await execCmd('bash', ['-c', 'ls /Applications | sed "s/\\.app$//"'], 8000)
    if (r.startsWith('ERR:')) {return []}
    return r.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(name => ({ name }))
  }
}
