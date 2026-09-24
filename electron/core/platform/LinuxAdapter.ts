// ============================================================
// electron/core/platform/LinuxAdapter.ts — Linux 桌面控制实现
//
// X11  : 全局键鼠注入走 xdotool；截屏走 scrot / import(ImageMagick) / gnome-screenshot。
// Wayland: 出于安全模型限制，合成器不允许任意客户端全局注入键鼠 → 明确禁用
//          mouse/keyboard，并提示用户切换到 X11 会话；截屏仍可走 grim。
//
// 检测项可在构造时注入（便于单测 mock，不实际调用系统命令）：
//   sessionType        ← $XDG_SESSION_TYPE
//   xdotoolAvailable   ← commandExists('xdotool')
//   grimAvailable      ← commandExists('grim')（Wayland 截屏）
// ============================================================

import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'
import {
  PlatformAdapter, PlatformCapabilities, ScreenCaptureResult,
  ActiveWindowInfo, InstalledApp, execCmd, wrapCmdResult, readPngSize, commandExists,
} from './PlatformAdapter'

export interface LinuxAdapterOptions {
  /** 'wayland' | 'x11' | 'aquamarine' | undefined */
  sessionType?: string
  /** 注入 xdotool 是否可用（默认运行时探测） */
  xdotoolAvailable?: boolean
  /** 注入 grim 是否可用（默认运行时探测；Wayland 截屏依赖） */
  grimAvailable?: boolean
}

export class LinuxAdapter implements PlatformAdapter {
  readonly capabilities: PlatformCapabilities
  private readonly sessionType: string
  private readonly xdotoolAvailable: boolean
  private readonly grimAvailable: boolean

  constructor(opts: LinuxAdapterOptions = {}) {
    this.sessionType = (opts.sessionType ?? process.env.XDG_SESSION_TYPE ?? '').toLowerCase()
    this.xdotoolAvailable = opts.xdotoolAvailable ?? commandExists('xdotool')
    // aquamarine 是 KDE Plasma 6 新 Wayland 后端，对全局注入同样受限，按 Wayland 处理
    const isWayland = this.sessionType === 'wayland' || this.sessionType === 'aquamarine'
    this.grimAvailable = isWayland
      ? (opts.grimAvailable ?? commandExists('grim'))
      : true

    const notes: string[] = []
    if (isWayland) {
      notes.push('Wayland 出于安全限制不支持全局桌面键鼠注入，Computer Use 已禁用鼠标/键盘。')
      notes.push('如需桌面操控，请注销并切换到 X11 会话（部分发行版在登录齿轮处选择）；或评估 ydotool（需 uinput 权限）。')
      if (!this.grimAvailable) {
        notes.push('Wayland 截屏需安装 grim：sudo apt install grim（wlroots）/ GNOME 可用 gnome-screenshot。')
      }
      this.capabilities = {
        platform: 'linux',
        mouse: false,
        keyboard: false,
        // 能力位恒为 true（Wayland 截屏走 grim 是既定路径）；
        // grim 实际缺失时在 screenshot() 调用时抛清晰安装指引，见下。
        screenshot: true,
        windowInfo: false,
        uia: false,
        openApp: true,
        installedApps: false,
        notes,
      }
      return
    }

    if (!this.xdotoolAvailable) {
      notes.push('未检测到 xdotool，全局鼠标/键盘注入不可用。请安装：sudo apt install xdotool（或发行版对应包）。')
      this.capabilities = {
        platform: 'linux',
        mouse: false,
        keyboard: false,
        screenshot: true,
        windowInfo: false,
        uia: false,
        openApp: true,
        installedApps: false,
        notes,
      }
      return
    }

    this.capabilities = {
      platform: 'linux',
      mouse: true,
      keyboard: true,
      screenshot: true,
      windowInfo: true,
      uia: false,
      openApp: true,
      installedApps: false,
      notes: ['Linux 无 Windows UIA 元素树，Computer Use 以截屏+坐标为主。'],
    }
  }

  /** 当前显示服务器（对外只读） */
  get displayServer(): 'x11' | 'wayland' | 'aquamarine' | undefined {
    if (this.sessionType === 'wayland' || this.sessionType === 'aquamarine') {
      return this.sessionType
    }
    if (this.sessionType === 'x11') {return 'x11'}
    return undefined
  }

  private isWayland(): boolean {
    return this.sessionType === 'wayland' || this.sessionType === 'aquamarine'
  }

  private requireMouse(): string | null {
    if (!this.capabilities.mouse) {
      return `桌面操控在当前 Linux 会话不可用：${this.capabilities.notes.join('；')}`
    }
    return null
  }

  async mouseMove(x: number, y: number): Promise<string> {
    const deny = this.requireMouse(); if (deny) {return `移动失败:${deny}`}
    const rx = Math.round(x), ry = Math.round(y)
    const r = await execCmd('xdotool', ['mousemove', String(rx), String(ry)])
    return wrapCmdResult(r, '移动')
  }

  async mouseClick(x: number, y: number, button: 'left' | 'right', dbl: boolean): Promise<string> {
    const deny = this.requireMouse(); if (deny) {return `点击失败:${deny}`}
    const rx = Math.round(x), ry = Math.round(y)
    const btnCode = button === 'right' ? '3' : '1'
    const r = await execCmd('xdotool', ['mousemove', String(rx), String(ry), 'click', '--repeat', String(dbl ? 2 : 1), '--delay', '100', btnCode])
    return wrapCmdResult(r, '点击')
  }

  async mouseHover(x: number, y: number, _holdMs: number): Promise<string> {
    const deny = this.requireMouse(); if (deny) {return `悬停失败:${deny}`}
    const rx = Math.round(x), ry = Math.round(y)
    const r = await execCmd('xdotool', ['mousemove', String(rx), String(ry)])
    return wrapCmdResult(r, '悬停')
  }

  async mouseLongPress(x: number, y: number, holdMs: number): Promise<string> {
    const deny = this.requireMouse(); if (deny) {return `长按失败:${deny}`}
    const rx = Math.round(x), ry = Math.round(y)
    const hold = (holdMs / 1000).toFixed(2)
    const r = await execCmd('bash', ['-c',
      `xdotool mousemove ${rx} ${ry} mousedown 1 && sleep ${hold} && xdotool mouseup 1`])
    return wrapCmdResult(r, '长按')
  }

  async mouseDrag(x1: number, y1: number, x2: number, y2: number): Promise<string> {
    const deny = this.requireMouse(); if (deny) {return `拖拽失败:${deny}`}
    const rx1 = Math.round(x1), ry1 = Math.round(y1), rx2 = Math.round(x2), ry2 = Math.round(y2)
    const r = await execCmd('bash', ['-c',
      `xdotool mousemove ${rx1} ${ry1} && xdotool mousedown 1 && xdotool mousemove ${rx2} ${ry2} && xdotool mouseup 1`])
    return wrapCmdResult(r, '拖拽')
  }

  async mouseScroll(amount: number): Promise<string> {
    const deny = this.requireMouse(); if (deny) {return `滚动失败:${deny}`}
    const n = Math.abs(amount)
    const btnCode = amount > 0 ? '5' : '4'
    const r = await execCmd('xdotool', ['click', '--repeat', String(n), '--delay', '50', btnCode])
    return wrapCmdResult(r, '滚动')
  }

  async keyboardType(text: string): Promise<string> {
    const deny = this.requireMouse(); if (deny) {return `输入失败:${deny}`}
    if (!text) {return '输入完成'}
    const r = await execCmd('xdotool', ['type', '--delay', '50', text])
    return wrapCmdResult(r, '输入')
  }

  async keyPress(key: string): Promise<string> {
    const deny = this.requireMouse(); if (deny) {return `按键失败:${deny}`}
    const k = (key || '').toLowerCase()
    if (!k) {return '按键失败:空按键'}
    const r = await execCmd('xdotool', ['key', k])
    return wrapCmdResult(r, '按键')
  }

  async screenshot(): Promise<ScreenCaptureResult> {
    const tmp = path.join(os.tmpdir(), `lu-lx-sc-${Date.now()}.png`)
    try {
      // Wayland 优先 grim（需预先探测到）；X11 尝试 gnome-screenshot / scrot / import
      let candidates: Array<[string, string[]]>
      if (this.isWayland()) {
        candidates = this.grimAvailable
          ? [['grim', [tmp]]]
          : []
      } else {
        candidates = [
          ['gnome-screenshot', ['-f', tmp]],
          ['scrot', [tmp]],
          ['import', ['-window', 'root', tmp]],
        ]
      }

      if (candidates.length === 0) {
        throw new Error('截屏失败：Wayland 下未检测到 grim。请安装：sudo apt install grim（wlroots）；GNOME 可用 gnome-screenshot。')
      }

      let lastErr = ''
      for (const [bin, args] of candidates) {
        const r = await execCmd(bin, args, 10000)
        if (!r.startsWith('ERR:')) {
          try {
            const buf = fs.readFileSync(tmp)
            if (buf.length > 0) {
              const { w, h } = readPngSize(buf)
              return { buffer: buf, w, h }
            }
          } catch (e: any) { lastErr = e?.message || e }
        } else {
          lastErr = r.slice(4)
        }
      }
      throw new Error(`截屏失败：未找到可用截图工具（grim/gnome-screenshot/scrot/import）。${lastErr}`)
    } finally {
      try { fs.unlinkSync(tmp) } catch { /* ignore */ }
    }
  }

  async getActiveWindow(): Promise<ActiveWindowInfo | null> {
    // Wayland/aquamarine：合成器不暴露全局窗口枚举，xdotool 在此会话本就无效，
    // 直接返回 null（能力矩阵 windowInfo=false），不浪费一次注定失败的 xdotool 调用。
    if (this.isWayland()) {return null}
    if (!this.xdotoolAvailable) {return null}
    const r = await execCmd('xdotool', ['getactivewindow', 'getwindowname'], 8000)
    if (r.startsWith('ERR:')) {return null}
    const title = r.split(/\r?\n/).pop() || ''
    return { title: title.trim(), processName: '', bounds: { x: 0, y: 0, w: 0, h: 0 } }
  }

  async getUiaTree(): Promise<unknown[]> {
    return []
  }

  async openApp(appName: string): Promise<string> {
    const r = await execCmd('xdg-open', [appName])
    return r.startsWith('ERR:') ? `打开应用失败:${r.slice(4)}` : '已尝试打开应用'
  }

  async getInstalledApps(): Promise<InstalledApp[]> {
    return []
  }
}
