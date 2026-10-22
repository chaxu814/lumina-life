// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// electron/core/platform/MacAdapter.ts — macOS 桌面控制实现
//
// 键鼠优先走 cliclick（brew install cliclick，更稳、支持长按/拖拽/按下抬起）；
// cliclick 不可用时退化为 AppleScript(System Events)。
// 截屏用 screencapture -x（不发声、不弹窗）。
// 元素树走 AX（Accessibility）—— macOS 对应 Windows UIA 的等价技术。
//
// ★ 坐标系（最容易出错处，务必先读 macCoordinate.ts）
//   screencapture 产出的是**背衬像素**（Retina 上 2×），
//   而 cliclick / System Events 的 click at / set mousePosition 用的是**逻辑点**。
//   两者差一个 scaleFactor。适配器在每次 screenshot() 后用实际 PNG 尺寸反推比例，
//   所有注入前统一经 toInjectablePoint() 换算并夹取到有效桌面内。
//   比例是「实测」而非硬编码 2×：若某机/某版本 screencapture 实际输出 1×，
//   实测比例自然为 1，无需改代码。
//
// ★ 权限（macOS 沙箱模型，失败不静默）
//   • 辅助功能(Accessibility) —— 键鼠注入 / AX 元素树 / 前台窗口信息
//   • 屏幕录制(Screen Recording) —— screencapture 取屏
//   需在「系统设置 → 隐私与安全性」中授权给 Lumina Life，之后**完全退出并重启**。
//   未授权时：登记结构化状态（reportCapabilityStatus，needs_permission），
//   并把「去哪儿开权限」写进返回的中文串——不抛裸异常、不静默失败。
//
// ⚠️ 全部 macOS 行为**未经实机验证**（开发机为 Windows）。
//    单测只覆盖命令构造、坐标换算与降级判定，不验证真实系统行为。
//
// 检测项可在构造时注入（便于单测 mock，不实际调用系统命令）：
//   cliclickAvailable ← commandExists('cliclick')
//   displays          ← electron.screen.getAllDisplays()（point/DIP）
//   forceScale        ← 锁定缩放比（1 = 非 Retina）
// ============================================================

import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'
import {
  PlatformAdapter, PlatformCapabilities, ScreenCaptureResult,
  ActiveWindowInfo, InstalledApp, execCmd, readPngSize, commandExists,
} from './PlatformAdapter'
import {
  computeCaptureGeometry, toInjectablePoint, pointToPixel,
  type CaptureGeometry, type DisplayInfo,
} from './macCoordinate'
import { classifyMacFailure, failureMessage } from './macPermissions'
import { reportCapabilityStatus, ready, needsPermission, unsupported } from './platformStatus'
import { buildAxScanScript, parseAxOutput, AX_DEFAULT_CAP, type AxElement } from './macAccessibility'

export interface MacAdapterOptions {
  /** 注入 cliclick 是否可用（默认运行时 which cliclick 探测） */
  cliclickAvailable?: boolean
  /** 注入显示器信息（单位 point，与 electron.screen.getAllDisplays() 同构） */
  displays?: DisplayInfo[]
  /** 锁定缩放比；给了就不再用截图像素反推（1 = 非 Retina） */
  forceScale?: number
}

/** 运行时读取 electron.screen 的显示器信息（非 Electron 环境返回空数组） */
function readDisplays(): DisplayInfo[] {
  try {
     
    const { screen } = require('electron')
    if (!screen || typeof screen.getAllDisplays !== 'function') {return []}
    return (screen.getAllDisplays() as any[]).map(d => ({
      bounds: {
        x: Number(d.bounds?.x) || 0,
        y: Number(d.bounds?.y) || 0,
        width: Number(d.bounds?.width) || 0,
        height: Number(d.bounds?.height) || 0,
      },
      scaleFactor: Number(d.scaleFactor) || 1,
    }))
  } catch { return [] }
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
  private readonly forceScale?: number
  /**
   * 截图坐标系 ↔ 注入坐标系（point）的换算关系。
   * 每次 screenshot() 后用实际 PNG 像素尺寸刷新；注入原语统一走 toInjectablePoint。
   */
  private geometry: CaptureGeometry
  private displays: DisplayInfo[]

  constructor(opts: MacAdapterOptions = {}) {
    this.cliclickAvailable = opts.cliclickAvailable ?? commandExists('cliclick')
    this.forceScale = opts.forceScale
    this.displays = opts.displays ?? readDisplays()
    this.geometry = computeCaptureGeometry(this.displays, 0, 0, this.forceScale)

    const toolchain = this.cliclickAvailable ? 'cliclick + AppleScript' : 'AppleScript(System Events)'
    this.capabilities = {
      platform: 'darwin',
      mouse: true,
      keyboard: true,
      screenshot: true,
      windowInfo: true,
      // AX（Accessibility）元素树：已实现，但依赖辅助功能授权；未授权时降级为空树
      // 并登记 needs_permission，而不是静默返回空。
      uia: true,
      openApp: true,
      installedApps: true,
      notes: [
        'macOS 需在「系统设置 → 隐私与安全性」中授权：辅助功能（控制键鼠 / 读元素树）+ 屏幕录制（截屏），授权后完全退出并重启 App 生效。',
        this.cliclickAvailable
          ? '检测到 cliclick，鼠标移动/点击/长按/拖拽将优先使用它，稳定性最佳。'
          : '未检测到 cliclick：长按/按下-抬起拖拽不可用，可执行 brew install cliclick 后重启 App 以获得完整桌面操控。',
        `当前键鼠实现：${toolchain}。`,
        '元素树走 macOS AX（Accessibility）而非 Windows UIA：能力接近，但取不到 AXValue，输入框赋值走「点击+全选+输入」回退。',
        '混合缩放多显示器（Retina 主屏 + 1x 副屏）下坐标换算取单一比例，可能有偏移；属已知限制。',
      ],
    }
    // 初始状态：实现层均可用；是否已授权由首次实际调用探测后回写。
    reportCapabilityStatus('mouse', ready(toolchain))
    reportCapabilityStatus('keyboard', ready('AppleScript key code / keystroke'))
    reportCapabilityStatus('screenshot', ready('screencapture -x -t png'))
    reportCapabilityStatus('uia', ready('AX via AppleScript System Events'))
  }

  // ── 坐标换算与失败上报（内部工具） ─────────────────────

  /** 截图像素坐标 → 可注入的 point 坐标（所有键鼠原语的统一入口） */
  private toInject(px: number, py: number): { x: number; y: number } {
    return toInjectablePoint(px, py, this.geometry)
  }

  /**
   * 统一处理键鼠类命令失败：分类 → 登记结构化状态 → 拼中文失败串。
   * 绝不一概返回「失败」而不说原因。
   */
  private handleInputResult(raw: string, verb: string, capKey: 'mouse' | 'keyboard'): string {
    if (!raw.startsWith('ERR:')) {return `${verb}完成`}
    const d = classifyMacFailure(raw, 'input')
    if (d.kind === 'accessibility') {
      reportCapabilityStatus(capKey, needsPermission('accessibility', verb))
    } else if (d.kind === 'not_found') {
      reportCapabilityStatus(capKey, unsupported('未安装 cliclick，部分鼠标手势不可用', d.raw))
    }
    return failureMessage(d, verb)
  }

  // ── 鼠标 ─────────────────────────────────────────────

  async mouseMove(x: number, y: number): Promise<string> {
    const { x: rx, y: ry } = this.toInject(x, y)
    if (this.cliclickAvailable) {
      const r = await execCmd('cliclick', [`m:${rx},${ry}`])
      return this.handleInputResult(r, '移动', 'mouse')
    }
    const r = await execCmd('osascript', ['-e', `tell application "System Events" to set mousePosition to {${rx},${ry}}`])
    return this.handleInputResult(r, '移动', 'mouse')
  }

  /** 当前光标位置（point）。拟人化缓动移动需要它作为路径起点。 */
  async getCursorPos(): Promise<{ x: number; y: number } | null> {
    const r = await execCmd('osascript', ['-e', 'tell application "System Events" to get position of mousePosition'], 5000)
    if (r.startsWith('ERR:')) {return null}
    const m = r.match(/(-?\d+)\s*,\s*(-?\d+)/)
    if (!m) {return null}
    const x = Number(m[1]), y = Number(m[2])
    if (!Number.isFinite(x) || !Number.isFinite(y)) {return null}
    return { x, y }
  }

  async mouseClick(x: number, y: number, button: 'left' | 'right', dbl: boolean): Promise<string> {
    const { x: rx, y: ry } = this.toInject(x, y)
    if (this.cliclickAvailable) {
      // cliclick: c=左击 rc=右击 dc=双击
      const verb = button === 'right' ? 'rc' : (dbl ? 'dc' : 'c')
      const r = await execCmd('cliclick', [`${verb}:${rx},${ry}`])
      return this.handleInputResult(r, '点击', 'mouse')
    }
    if (button === 'right') {
      // macOS 右键走 ctrl+click 更通用
      const r = await execCmd('osascript', ['-e',
        `tell application "System Events" to click at {${rx},${ry}} using {control down}`])
      return this.handleInputResult(r, '点击', 'mouse')
    }
    const osaCmd = dbl
      ? `tell application "System Events" to click at {${rx},${ry}}; delay 0.1; tell application "System Events" to click at {${rx},${ry}}`
      : `tell application "System Events" to click at {${rx},${ry}}`
    const r = await execCmd('osascript', ['-e', osaCmd])
    return this.handleInputResult(r, '点击', 'mouse')
  }

  async mouseHover(x: number, y: number, _holdMs: number): Promise<string> {
    const { x: rx, y: ry } = this.toInject(x, y)
    if (this.cliclickAvailable) {
      const r = await execCmd('cliclick', [`m:${rx},${ry}`])
      return this.handleInputResult(r, '悬停', 'mouse')
    }
    const r = await execCmd('osascript', ['-e', `tell application "System Events" to set mousePosition to {${rx},${ry}}`])
    return this.handleInputResult(r, '悬停', 'mouse')
  }

  async mouseDown(x: number, y: number, button: 'left' | 'right' = 'left'): Promise<string> {
    const { x: rx, y: ry } = this.toInject(x, y)
    if (!this.cliclickAvailable) {
      reportCapabilityStatus('mouse', unsupported('按下/抬起需安装 cliclick（brew install cliclick）后重启 App'))
      return '按下失败:macOS 鼠标按下需安装 cliclick：brew install cliclick（装完重启 App）。'
    }
    // cliclick: md=左键按下 rd=右键按下
    const verb = button === 'right' ? 'rd' : 'md'
    const r = await execCmd('cliclick', [`${verb}:${rx},${ry}`])
    return this.handleInputResult(r, '按下', 'mouse')
  }

  async mouseUp(x: number, y: number, button: 'left' | 'right' = 'left'): Promise<string> {
    const { x: rx, y: ry } = this.toInject(x, y)
    if (!this.cliclickAvailable) {
      reportCapabilityStatus('mouse', unsupported('按下/抬起需安装 cliclick（brew install cliclick）后重启 App'))
      return '抬起失败:macOS 鼠标抬起需安装 cliclick：brew install cliclick（装完重启 App）。'
    }
    // cliclick: mu=左键抬起 ru=右键抬起
    const verb = button === 'right' ? 'ru' : 'mu'
    const r = await execCmd('cliclick', [`${verb}:${rx},${ry}`])
    return this.handleInputResult(r, '抬起', 'mouse')
  }

  async mouseLongPress(x: number, y: number, holdMs: number): Promise<string> {
    const { x: rx, y: ry } = this.toInject(x, y)
    if (!this.cliclickAvailable) {
      // AppleScript(System Events) 无法可靠实现「按住」，明确告知而不是执行注定失败的命令
      reportCapabilityStatus('mouse', unsupported('长按需安装 cliclick（brew install cliclick）后重启 App'))
      return '长按失败:macOS 长按需安装 cliclick 后使用：brew install cliclick（装完重启 App）。'
    }
    const hold = (holdMs / 1000).toFixed(2)
    const r = await execCmd('bash', ['-c',
      `cliclick m:${rx},${ry} md:${rx},${ry} && sleep ${hold} && cliclick mu:${rx},${ry}`])
    return this.handleInputResult(r, '长按', 'mouse')
  }

  async mouseDrag(x1: number, y1: number, x2: number, y2: number): Promise<string> {
    const p1 = this.toInject(x1, y1)
    const p2 = this.toInject(x2, y2)
    const rx1 = p1.x, ry1 = p1.y, rx2 = p2.x, ry2 = p2.y
    if (this.cliclickAvailable) {
      const r = await execCmd('bash', ['-c',
        `cliclick m:${rx1},${ry1} md:${rx1},${ry1} m:${rx2},${ry2} mu:${rx2},${ry2}`])
      return this.handleInputResult(r, '拖拽', 'mouse')
    }
    const r = await execCmd('osascript', ['-e',
      `tell application "System Events"
  set mousePosition to {${rx1},${ry1}}
  perform action "AXPress" at mousePosition
  delay 0.05
  set mousePosition to {${rx2},${ry2}}
  perform action "AXPress" at mousePosition
end tell`])
    return this.handleInputResult(r, '拖拽', 'mouse')
  }

  async mouseScroll(amount: number): Promise<string> {
    const n = Math.abs(amount)
    // macOS 无「按像素滚动」的通用注入（cliclick 也只有 kp:/ku: 模拟滚轮键）。
    // 这里用 ctrl+↓ 逐格翻页近似向下滚动。已知限制：大页滚动会被截断到一页。
    const r = await execCmd('osascript', ['-e',
      `tell application "System Events" to repeat ${n} times
  key code 125 using {control down}
  delay 0.02
end repeat`])
    return this.handleInputResult(r, '滚动', 'mouse')
  }

  // ── 键盘 ─────────────────────────────────────────────

  async keyboardType(text: string): Promise<string> {
    if (!text) {return '输入完成'}
    const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const r = await execCmd('osascript', ['-e', `tell application "System Events" to keystroke "${escaped}"`])
    return this.handleInputResult(r, '输入', 'keyboard')
  }

  async keyPress(key: string): Promise<string> {
    const k = (key || '').trim()
    if (!k) {return '按键失败:空按键'}
    const osaCmd = buildMacKeyScript(k)
    const r = await execCmd('osascript', ['-e', osaCmd])
    return this.handleInputResult(r, '按键', 'keyboard')
  }

  // ── 截屏 ─────────────────────────────────────────────

  async screenshot(): Promise<ScreenCaptureResult> {
    const tmp = path.join(os.tmpdir(), `lu-mac-sc-${Date.now()}.png`)
    try {
      // -x: 不播放截图音效；-t png: 输出 PNG
      const r = await execCmd('screencapture', ['-x', '-t', 'png', tmp], 10000)
      if (r.startsWith('ERR:')) {
        // 权限不足**登记结构化状态**（needs_permission），让上层能提示「去哪儿开权限」，
        // 再把中文原因抛给调用方。抛的是人话，不是原始英文串。
        const d = classifyMacFailure(r, 'screenshot')
        if (d.kind === 'screen_recording') {
          reportCapabilityStatus('screenshot', needsPermission('screen_recording', '截屏'))
        } else if (d.kind === 'not_found') {
          reportCapabilityStatus('screenshot', unsupported('找不到 screencapture 命令', d.raw))
        }
        throw new Error(failureMessage(d, '截屏'))
      }
      const buf = fs.readFileSync(tmp)
      const { w, h } = readPngSize(buf)
      // ★ 关键：用实际 PNG 尺寸反推缩放比并刷新几何。
      //   截图像素（Retina 2×）与注入坐标（point）差一个 scale 倍，不刷新必然点偏。
      this.geometry = computeCaptureGeometry(this.displays, w, h, this.forceScale)
      reportCapabilityStatus('screenshot', ready(`screencapture -x（缩放 ${this.geometry.scaleX.toFixed(2)}×）`))
      return { buffer: buf, w, h }
    } finally {
      try { fs.unlinkSync(tmp) } catch { /* ignore */ }
    }
  }

  // ── 窗口 / 应用 ───────────────────────────────────────

  async getActiveWindow(): Promise<ActiveWindowInfo | null> {
    const r = await execCmd('osascript', ['-e',
      'tell application "System Events" to set fw to first application process whose frontmost is true',
      '-e',
      'tell application "System Events" to return (name of fw) & "|" & (name of window 1 of fw) & "|" & ((position of window 1 of fw) as text) & "|" & ((size of window 1 of fw) as text)',
    ], 8000)
    if (r.startsWith('ERR:') || !r.includes('|')) {
      // 探测失败多半是辅助功能未授权：登记状态，而不是静默返回 null
      if (r.startsWith('ERR:')) {
        const d = classifyMacFailure(r, 'ax')
        if (d.kind === 'accessibility') {
          reportCapabilityStatus('window_info', needsPermission('accessibility', '读取前台窗口信息'))
        }
      }
      return null
    }
    const parts = r.split('|')
    const processName = (parts[0] || '').trim()
    const title = (parts[1] || '').trim()
    // 位置/尺寸返回形如 "{100, 200}" / "{800, 600}"，取其中数字（单位 point）
    const posNums = (parts[2] || '').match(/-?\d+/g)?.map(Number) || []
    const sizeNums = (parts[3] || '').match(/-?\d+/g)?.map(Number) || []
    const bounds = {
      x: posNums[0] ?? 0,
      y: posNums[1] ?? 0,
      w: sizeNums[0] ?? 0,
      h: sizeNums[1] ?? 0,
    }
    reportCapabilityStatus('window_info', ready('AppleScript System Events'))
    return { title, processName, bounds }
  }

  /**
   * 按标题子串找到窗口并激活它（对应 Windows 的 focusWindow）。
   *
   * 与 Windows 版的差异（有意为之）：Windows 版额外「点击窗口中心」以确保文档级焦点；
   * macOS 上 set frontmost=true 已能可靠交付键盘焦点，而点击会误触发按钮/链接，
   * 且未授权时必然失败——因此这里只做 AXRaise + 置前，不点击。
   * 若实机发现某些 App 仍拿不到焦点，需在 App 级补 AXPress。已知限制。
   */
  async focusWindow(titleSubstring: string): Promise<boolean> {
    if (!titleSubstring) {return false}
    const needle = titleSubstring.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const r = await execCmd('osascript', ['-e', `
      tell application "System Events"
        set targetProc to first application process whose frontmost is true
        repeat with w in (every window of targetProc)
          try
            if (name of w as text) contains "${needle}" then
              perform action "AXRaise" of w
              set frontmost of targetProc to true
              return "OK"
            end if
          end try
        end repeat
      end tell
      return "MISS"
    `], 8000)
    return r.trim() === 'OK'
  }

  // ── 可访问性元素树（UIA 的 macOS 等价物） ──────────────

  /**
   * 扫描前台窗口的 AX 元素树（对外主要入口；cuUia.ts 在 darwin 上调用它）。
   * 返回 AxElement[]，坐标单位为 **point**。
   */
  async scanAxElements(cap: number = AX_DEFAULT_CAP): Promise<AxElement[]> {
    const r = await execCmd('osascript', ['-e', buildAxScanScript(3, cap)], 20000)
    if (r.startsWith('ERR:')) {
      const d = classifyMacFailure(r, 'ax')
      if (d.kind === 'accessibility') {
        reportCapabilityStatus('uia', needsPermission('accessibility', '读取可访问性元素树'))
      }
      return []
    }
    const parsed = parseAxOutput(r, cap)
    if (parsed.scriptError) {
      const d = classifyMacFailure(parsed.scriptError, 'ax')
      if (d.kind === 'accessibility') {
        reportCapabilityStatus('uia', needsPermission('accessibility', '读取可访问性元素树'))
      }
      return []
    }
    if (parsed.empty) {
      // 空树有两种可能：前台无可访问窗口，或没授权。
      // 这里**不**直接判定 needs_permission（会把「真的没有元素」误报成「没授权」），
      // 而是登记一个可辨识的说明，让上层能区分「空」与「未授权」。
      reportCapabilityStatus('uia', ready('AX 扫描完成但未取到元素（未授权，或前台窗口为自绘界面/非 AX 应用）'))
      return []
    }
    reportCapabilityStatus('uia', ready(`AX 扫描到 ${parsed.elements.length} 个元素`))
    return parsed.elements
  }

  /** PlatformAdapter 契约占位：真正的结构化树在 scanAxElements()。 */
  async getUiaTree(): Promise<unknown[]> {
    return this.scanAxElements()
  }

  async openApp(appName: string): Promise<string> {
    const r = await execCmd('open', ['-a', appName])
    if (r.startsWith('ERR:')) {
      const d = classifyMacFailure(r, 'app')
      if (d.kind === 'not_found') {
        reportCapabilityStatus('open_app', unsupported(`未找到应用「${appName}」`, d.raw))
      }
      return failureMessage(d, '打开应用')
    }
    reportCapabilityStatus('open_app', ready('open -a'))
    return '已尝试打开应用'
  }

  async getInstalledApps(): Promise<InstalledApp[]> {
    const r = await execCmd('bash', ['-c', 'ls /Applications | sed "s/\\.app$//"'], 8000)
    if (r.startsWith('ERR:')) {return []}
    const out = r.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(name => ({ name }))
    reportCapabilityStatus('installed_apps', ready(`ls /Applications（${out.length} 项）`))
    return out
  }
}
