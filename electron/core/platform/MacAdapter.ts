// ============================================================
// electron/core/platform/MacAdapter.ts — macOS 桌面控制实现
//
// 键鼠走 AppleScript(System Events)；长按/拖拽在 cliclick 可用时用之。
// 截屏用 screencapture -x（不发声、不弹窗）。
//
// 权限前提（macOS 沙箱模型）：
//   • 辅助功能(Accessibility) —— 控制鼠标/键盘所必需
//   • 屏幕录制(Screen Recording) —— screencapture 取屏所必需
// 需在「系统设置 → 隐私与安全性」中授权给 Lumina / 终端 / 运行宿主。
// 未授权时命令会失败，错误串会原样返回给上层提示用户。
// ============================================================

import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'
import {
  PlatformAdapter, PlatformCapabilities, ScreenCaptureResult,
  ActiveWindowInfo, InstalledApp, execCmd, wrapCmdResult, readPngSize,
} from './PlatformAdapter'

export class MacAdapter implements PlatformAdapter {
  readonly capabilities: PlatformCapabilities = {
    platform: 'darwin',
    mouse: true,
    keyboard: true,
    screenshot: true,
    windowInfo: true,
    uia: false,
    openApp: true,
    installedApps: false,
    notes: [
      'macOS 需在「系统设置 → 隐私与安全性」中授权：辅助功能（控制鼠标键盘）+ 屏幕录制（截屏）。',
      '长按/拖拽若失败，可安装 brew install cliclick 以提升可靠性。',
      'macOS 无 Windows UIA 元素树，Computer Use 以截屏+坐标为主。',
    ],
  }

  async mouseMove(x: number, y: number): Promise<string> {
    const rx = Math.round(x), ry = Math.round(y)
    const r = await execCmd('osascript', ['-e', `tell application "System Events" to set mousePosition to {${rx},${ry}}`])
    return wrapCmdResult(r, '移动')
  }

  async mouseClick(x: number, y: number, button: 'left' | 'right', dbl: boolean): Promise<string> {
    const rx = Math.round(x), ry = Math.round(y)
    if (button === 'right') {
      // macOS 右键走 ctrl+click 更通用
      const r = await execCmd('osascript', ['-e',
        `tell application "System Events" to click at {${rx},${ry}} using {command down}`])
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
    const r = await execCmd('osascript', ['-e', `tell application "System Events" to set mousePosition to {${rx},${ry}}`])
    return wrapCmdResult(r, '悬停')
  }

  async mouseLongPress(x: number, y: number, holdMs: number): Promise<string> {
    const rx = Math.round(x), ry = Math.round(y)
    const hold = (holdMs / 1000).toFixed(2)
    const r = await execCmd('bash', ['-c',
      `cliclick m:${rx},${ry} md:${rx},${ry} && sleep ${hold} && cliclick mu:${rx},${ry}`])
    return wrapCmdResult(r, '长按')
  }

  async mouseDrag(x1: number, y1: number, x2: number, y2: number): Promise<string> {
    const rx1 = Math.round(x1), ry1 = Math.round(y1), rx2 = Math.round(x2), ry2 = Math.round(y2)
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
    const k = (key || '').toLowerCase()
    if (!k) {return '按键失败:空按键'}
    const r = await execCmd('osascript', ['-e', `tell application "System Events" to key code ${k}`])
    return wrapCmdResult(r, '按键')
  }

  async screenshot(): Promise<ScreenCaptureResult> {
    const tmp = path.join(os.tmpdir(), `lu-mac-sc-${Date.now()}.png`)
    try {
      // -x: 不播放截图音效；-t png: 输出 PNG
      const r = await execCmd('screencapture', ['-x', '-t', 'png', tmp], 10000)
      if (r.startsWith('ERR:')) {throw new Error(r.slice(4))}
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
