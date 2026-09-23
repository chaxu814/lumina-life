// ============================================================
// electron/core/platform/PlatformAdapter.ts — 跨平台桌面控制适配层（接口 + 共享工具）
//
// 目标：让 Computer Use 的键鼠/截屏/窗口信息按平台能力「能力分级、优雅降级」。
//   • Windows：PowerShell（user32.dll mouse_event / SendKeys / 剪贴板）—— 行为与改造前完全一致
//   • macOS  ：AppleScript(System Events) + screencapture；依赖辅助功能/屏幕录制授权
//   • Linux  ：X11 走 xdotool / ImageMagick-scrot；Wayland 全局注入受限，明确禁用并提示
//
// 本文件只定义接口契约与跨平台共享的进程执行辅助，具体实现见各 *Adapter.ts。
// 单测通过 platformFactory 注入，不实际执行系统命令。
// ============================================================

import * as cp from 'child_process'
import * as fs from 'fs'

// ──────────────────────────────────────────────────────────
// 类型
// ──────────────────────────────────────────────────────────

export interface ScreenCaptureResult {
  /** PNG 编码的截图缓冲 */
  buffer: Buffer
  /** 真实像素宽（读取失败时为 0，由上层 pngDimensions 兜底） */
  w: number
  /** 真实像素高 */
  h: number
}

export interface WindowRect { x: number; y: number; w: number; h: number }

export interface ActiveWindowInfo {
  title: string
  processName: string
  bounds: WindowRect
}

export interface InstalledApp {
  name: string
  path?: string
}

/** 各子能力可用性标志 + 人类可读说明（权限/依赖缺失时给前端提示） */
export interface PlatformCapabilities {
  platform: NodeJS.Platform
  /** 鼠标注入（移动/点击/拖拽/滚轮/悬停/长按） */
  mouse: boolean
  /** 键盘注入（输入文本/按键/组合键） */
  keyboard: boolean
  /** 截屏 */
  screenshot: boolean
  /** 前台窗口信息探测 */
  windowInfo: boolean
  /** 可访问性树（UIA/AX）—— 目前仅 Windows */
  uia: boolean
  /** 打开应用 / 枚举已装应用 */
  openApp: boolean
  /** 已装应用枚举 */
  installedApps: boolean
  /** 降级/授权说明（前端设置页展示） */
  notes: string[]
}

/** 平台适配器统一接口（由 WindowsAdapter / MacAdapter / LinuxAdapter 实现） */
export interface PlatformAdapter {
  readonly capabilities: PlatformCapabilities

  /** 移动光标（不点击）。返回与 cuCore 约定一致的中文结果串 */
  mouseMove(x: number, y: number): Promise<string>
  mouseClick(x: number, y: number, button: 'left' | 'right', dbl: boolean): Promise<string>
  mouseHover(x: number, y: number, holdMs: number): Promise<string>
  mouseLongPress(x: number, y: number, holdMs: number): Promise<string>
  mouseDrag(x1: number, y1: number, x2: number, y2: number): Promise<string>
  mouseScroll(amount: number): Promise<string>

  /** 输入文本（Windows 走剪贴板粘贴以支持中文） */
  keyboardType(text: string): Promise<string>
  /** 单个按键 / 组合键（enter/esc/ctrl_c/alt_f4…） */
  keyPress(key: string): Promise<string>

  screenshot(): Promise<ScreenCaptureResult>

  getActiveWindow(): Promise<ActiveWindowInfo | null>
  /**
   * 按标题子串查找窗口并使其前台 + 点击窗口中心聚焦内容区。
   * 用于自主游玩闭环每轮确保键盘输入真正进入目标窗口（浏览器弹窗/翻译气泡会抢焦点）。
   * 返回是否成功；平台未实现时由上层按 no-op 处理。
   */
  focusWindow?(titleSubstring: string): Promise<boolean>
  /** 可访问性元素树；Windows 有，其它平台返回空数组（说明见 capabilities.notes） */
  getUiaTree(): Promise<unknown[]>

  openApp(appName: string): Promise<string>
  getInstalledApps(): Promise<InstalledApp[]>
}

// ──────────────────────────────────────────────────────────
// 跨平台共享：进程执行辅助
// ──────────────────────────────────────────────────────────

/**
 * 执行外部命令并取 stdout。失败时 resolve 成 `ERR:<msg>|<stderr>`，
 * 与 cuCore 历史约定一致（调用方据此判断并拼「XX失败:」）。绝不 reject。
 */
export function execCmd(cmd: string, args: string[], timeout = 15000): Promise<string> {
  return new Promise<string>(resolve => {
    const child = cp.execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {resolve(`ERR:${err.message}|${String(stderr).slice(0, 100)}`)}
      else {resolve(String(stdout).trim())}
    })
    if (child.stdin) {child.stdin.end()}
  })
}

/** 命令是否成功（与 cuCore 历史判断一致：不以 ERR: 开头） */
export function isCmdOk(r: string): boolean {
  return !r.startsWith('ERR:')
}

/** 把命令结果包装成与 cuCore 一致的中文失败/成功串 */
export function wrapCmdResult(r: string, verb: string): string {
  return isCmdOk(r) ? `${verb}完成` : `${verb}失败:${r.slice(4)}`
}

/**
 * 读取 PNG 前 24 字节解析 IHDR 宽高（不解码整图）。
 * 失败返回 {w:0,h:0}，由上层 pngDimensions 兜底。
 */
export function readPngSize(buf: Buffer): { w: number; h: number } {
  try {
    if (buf && buf.length >= 24
      && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
      && buf[12] === 0x49 && buf[13] === 0x48 && buf[14] === 0x44 && buf[15] === 0x52) {
      const w = buf.readUInt32BE(16)
      const h = buf.readUInt32BE(20)
      if (w > 0 && h > 0 && w <= 7680 && h <= 4320) {return { w, h }}
    }
  } catch { /* ignore */ }
  return { w: 0, h: 0 }
}

/** 同步探测某命令是否在 PATH 中（best-effort，用于能力分级） */
export function commandExists(cmd: string): boolean {
  try {
    const which = process.platform === 'win32' ? 'where' : 'which'
    cp.execFileSync(which, [cmd], { windowsHide: true, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
