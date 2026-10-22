// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// cuPermissions.ts — Computer Use 权限门 (v3.20, 同类工程实践：四道关)
//
// 同类项目的安全模型：应用白名单（read / click / full 三级）+ 前台校验
// + 会话锁 + 危险分区（浏览器只读 / 终端 IDE 只点）+ 系统键黑名单 + 剪贴板授权。
// 本模块把这套模型落地为 Lumina 的「动作执行前统一权限门」：
//
//   决策函数 decideCuGate() 是纯函数（可单测），不依赖 electron / fs。
//   持久化（cu-policy.json）、前台探测（Win32/PowerShell）、会话锁是 I/O 层。
//
// 原则：
//   - 权限门只在「动作执行前」判断；destructiveReason 的 shell 命令正则仍在 cuCore 兜底。
//   - 探测失败（非 Windows / 脚本异常）默认放行并告警，绝不把用户卡死。
//   - 系统键黑名单在任何授权级别下都硬拦截（授权也不能让 agent 锁屏/开运行框）。
// ============================================================

import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { execFile } from 'child_process'
import * as os from 'os'
import type { CuAction } from './cuCore'
import { gateHumanInput, releaseHumanLease } from './cuInputGuard'

// ═══════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════

export type CuLevel = 'none' | 'read' | 'click' | 'full'

export type AppCategory = 'browser' | 'terminal' | 'ide' | 'other'

export interface CuPolicy {
  /** 总开关：false 时权限门不拦截（保留旧行为） */
  enabled: boolean
  /** 未知应用的默认授权级别 */
  defaultLevel: CuLevel
  /** 进程名（小写、可带/不带 .exe）→ 授权级别 */
  rules: Record<string, CuLevel>
  /** 浏览器分区：只读（连点都不行） */
  browserReadonly: boolean
  /** 终端/IDE 分区：只点不打（禁止键盘输入/粘贴） */
  terminalClickOnly: boolean
  /** 剪贴板写入需要 full 授权（复制到系统剪贴板是写入动作） */
  clipboardGrant: boolean
  /** 全局系统键黑名单（任何级别都拦截） */
  systemKeyBlocklist: string[]
  /** 会话锁开关：同一时刻只允许一个操控者 */
  sessionLock: boolean
  /** 动作后画面验证（dHash 无变化提示未命中） */
  verifyAfterAction: boolean
  /** 判定「无变化」的汉明距离阈值（0~1，越小越严格） */
  noChangeThreshold: number
  /** v3.30 用户一碰鼠标/键盘就中止自动操作（ForegroundLease 人机互斥） */
  humanInterrupt: boolean
  /** v3.30 截取覆盖所有显示器的虚拟桌面 */
  multiMonitor: boolean
  /** v3.30 截图隐私遮罩：非前台窗口区域涂黑 */
  maskBackgroundWindows: boolean
}

export interface GateContext {
  /** 前台进程名（小写、不含 .exe）；探测不到给 null */
  proc?: string | null
  /** 前台窗口标题 */
  title?: string | null
  /** 当前动作的会话/操控者标识（用于会话锁比对） */
  sessionId?: string | null
}

export interface GateDecision {
  allow: boolean
  /** 拒绝原因（中文，直接回给 agent） */
  reason?: string
  /** 该应用的授权级别 */
  level?: CuLevel
  /** 应用分区 */
  category?: AppCategory
}

// ═══════════════════════════════════════════════════════════
// 应用分区表（进程名小写，比较时统一去 .exe）
// ═══════════════════════════════════════════════════════════

export const BROWSER_PROCS = [
  'chrome', 'msedge', 'firefox', 'brave', 'opera', 'opera_gx', 'vivaldi', 'arc',
  '360se', '360chrome', 'qqbrowser', 'sogouexplorer', 'maxthon', 'iexplore',
  'msedgewebview2', 'thorium', 'centbrowser', 'starbyte', 'flock',
  // ── macOS（System Events 报的进程名，无 .app 后缀）──
  'safari', 'google chrome', 'chromium', 'firefox', 'microsoft edge',
  'brave browser', 'opera', 'vivaldi', 'arc', 'safari technology preview',
  // Electron 系（含自家 Lumina）
  'electron',
]

export const TERMINAL_PROCS = [
  'powershell', 'pwsh', 'cmd', 'conhost', 'windowsterminal', 'wt',
  'git-bash', 'bash', 'sh', 'zsh', 'wsl', 'wslhost', 'alacritty',
  'wezterm', 'wezterm-gui', 'hyper', 'tabby', 'putty', 'mobaxterm',
  'powershell_ise', 'cmder', 'tilix', 'kitty',
  // ── macOS 终端 ──
  'terminal', 'iterm', 'iterm2', 'warp', 'alacritty',
]

export const IDE_PROCS = [
  'code', 'cursor', 'windsurf', 'trae', 'vscode', 'idea', 'idea64',
  'webstorm', 'pycharm', 'pycharm64', 'goland', 'rider', 'clion',
  'rubymine', 'datagrip', 'phpstorm', 'fleet', 'sublime_text',
  'notepad++', 'devenv', 'atom', 'zed', 'eclipse', 'netbeans',
  'code-insiders', 'androidstudio', 'unity', 'unrealeditor',
  // ── macOS IDE ──
  'xcode', 'android studio', 'intellij idea', 'visual studio code',
  'sublime text', 'nova', 'pycharm ce',
]

/**
 * 默认系统键黑名单：
 *  - Win 组合键（运行框/锁屏/桌面/资源管理器/快捷菜单）
 *  - 任务管理器、安全注意序列、Alt+Tab 切换、窗口切换
 *  - 锁屏 / 电源键
 */
export const DEFAULT_SYSTEM_KEY_BLOCKLIST = [
  'win', 'win_r', 'win_l', 'win_d', 'win_e', 'win_x', 'win_tab',
  'win_m', 'win_i', 'win_u', 'win_pause', 'win_shift_s',
  'ctrl_shift_esc', 'ctrl_alt_del', 'alt_tab', 'alt_shift_tab',
  'alt_f4', 'ctrl_esc', 'sleep', 'power', 'lock',
  // ── macOS 等价越权键（Command 对应 Windows 的 Win）──
  // Command+Space  Spotlight/输入源切换、Command+Tab 应用切换、
  // Command+Q 强杀前台 App、Command+Option+Esc 强制退出、Command+L 锁屏
  'cmd_space', 'cmd_tab', 'cmd_shift_tab', 'cmd_q', 'cmd_l',
  'ctrl_cmd_q', 'ctrl_alt_cmd', 'cmd_h', 'cmd_m',
]

/** 终端/IDE 分区下仍然允许的「只读导航键」 */
export const TERMINAL_SAFE_KEYS = new Set([
  'esc', 'tab', 'up', 'down', 'left', 'right',
  'pageup', 'pagedown', 'home', 'end', 'ctrl_c',
])

// ═══════════════════════════════════════════════════════════
// 动作分级
// ═══════════════════════════════════════════════════════════

/** 动作需要的最低授权级别（read 级动作任何授权都能做） */
export function requiredLevel(act: CuAction): CuLevel {
  switch (act.action_type) {
    // 只读动作：截图 / 滚动 / 等待
    case 'scroll':
    case 'wait':
    case 'screenshot':
      return 'read'
    // 点击类动作
    case 'click':
    case 'left_click':
    case 'right_click':
    case 'double_click':
    case 'drag':
    case 'hover':
    case 'mouse_move':
    case 'long_press':
    case 'select_text':
      return 'click'
    // 写入类动作：打字 / 按键 / 剪贴板 / 关窗 / 赋值
    case 'type':
    case 'keypress':
    case 'key':
    case 'clipboard':
    case 'close_window':
    case 'set_value':
      return 'full'
    // 打开应用按点击级处理（只是启动，不产生输入）
    case 'open_app':
      return 'click'
    default:
      // 未知动作按 full 对待（保守）
      return 'full'
  }
}

/** 动作是否预期会改变画面（用于动作后验证） */
export function expectsVisualChange(act: CuAction): boolean {
  return act.action_type === 'click'
    || act.action_type === 'left_click'
    || act.action_type === 'right_click'
    || act.action_type === 'double_click'
    || act.action_type === 'drag'
    || act.action_type === 'long_press'
    || act.action_type === 'select_text'
}

export const LEVEL_RANK: Record<CuLevel, number> = {
  none: 0,
  read: 1,
  click: 2,
  full: 3,
}

/** 进程名归一化：去路径、去 .exe、转小写；macOS 额外去 .app 后缀 */
export function normalizeProc(name?: string | null): string {
  if (!name) {return ''}
  let s = String(name).trim().toLowerCase()
  s = s.split(/[\\/]/).pop() || s
  if (s.endsWith('.exe')) {s = s.slice(0, -4)}
  // macOS：进程名可能带 .app（System Events / 活动监视器两种都给法）
  if (s.endsWith('.app')) {s = s.slice(0, -4)}
  return s
}

/** 判定应用分区 */
export function categorize(proc: string): AppCategory {
  const p = normalizeProc(proc)
  if (BROWSER_PROCS.includes(p)) {return 'browser'}
  if (TERMINAL_PROCS.includes(p)) {return 'terminal'}
  if (IDE_PROCS.includes(p)) {return 'ide'}
  return 'other'
}

/** 按键名归一化（ctrl+shift+esc → ctrl_shift_esc，兼容连字符） */
export function normalizeKey(key?: string | null): string {
  return normalizeKeyRaw(key)
}

function normalizeKeyRaw(key?: string | null): string {
  if (!key) {return ''}
  return String(key).trim().toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[+-]/g, '_')
    .replace(/meta/g, 'win')
    .replace(/command/g, 'win')
    .replace(/control/g, 'ctrl')
    .replace(/return/g, 'enter')
    .replace(/escape/g, 'esc')
}

// ═══════════════════════════════════════════════════════════
// 纯决策函数（核心，可单测）
// ═══════════════════════════════════════════════════════════

/**
 * 权限门决策。
 *
 * @param policy 当前策略
 * @param act    即将执行的动作
 * @param ctx    前台环境 + 会话信息
 * @returns allow=false 时必须中止执行并把 reason 回给 agent
 */
export function decideCuGate(policy: CuPolicy, act: CuAction, ctx: GateContext = {}): GateDecision {
  if (!policy.enabled) {return { allow: true, level: 'full', category: 'other' }}

  const proc = normalizeProc(ctx.proc)
  const category = categorize(proc)
  const need = requiredLevel(act)

  // ── 1. 系统键黑名单（全局硬拦截，任何授权都不放行） ──
  if (act.action_type === 'keypress' && act.key) {
    const key = normalizeKey(act.key)
    if (policy.systemKeyBlocklist.map(normalizeKey).includes(key)) {
      return {
        allow: false,
        category,
        level: need,
        reason: `系统快捷键「${act.key}」在黑名单中，禁止模拟（防止锁屏/任务管理器/窗口切换等越权操作）。请改用直接点击界面元素。`,
      }
    }
  }

  // ── 2. 解析该应用的授权级别 ──
  let level: CuLevel = policy.defaultLevel
  if (proc) {
    // 精确匹配优先，其次规则表里的归一化匹配
    if (policy.rules[proc]) {
      level = policy.rules[proc]
    } else {
      for (const [ruleProc, ruleLevel] of Object.entries(policy.rules)) {
        if (normalizeProc(ruleProc) === proc) {
          level = ruleLevel
          break
        }
      }
    }
  }

  // ── 3. 危险分区强制降级 ──
  // 浏览器：只读。连点都不允许（网页操作必须走 browser 工具链，有导航审计）。
  if (category === 'browser' && policy.browserReadonly) {
    level = 'read'
  }
  // 终端/IDE：只点不打。键盘输入/粘贴是高危（一条命令就是一次真实执行）。
  if ((category === 'terminal' || category === 'ide') && policy.terminalClickOnly) {
    if (level === 'full') {level = 'click'}
    if (act.action_type === 'type' || act.action_type === 'clipboard' || act.action_type === 'set_value') {
      return {
        allow: false,
        category,
        level,
        reason: `检测到前台是${category === 'terminal' ? '终端' : 'IDE'}（${proc}），按安全分区策略禁止键盘输入/粘贴，只能点击。如需执行命令请改用 shell_exec 工具（有高危命令拦截）。`,
      }
    }
    if (act.action_type === 'keypress' && act.key) {
      const key = normalizeKey(act.key)
      if (!TERMINAL_SAFE_KEYS.has(key)) {
        return {
          allow: false,
          category,
          level,
          reason: `检测到前台是${category === 'terminal' ? '终端' : 'IDE'}（${proc}），按键「${act.key}」不在只读导航键白名单内，禁止模拟。`,
        }
      }
      // 只读导航键（方向键/分页/esc/ctrl_c 等）等价于点击级操作，直接放行
      return { allow: true, category, level }
    }
  }

  // 浏览器分区：显式拒绝点击与写入（滚动/截图允许）
  if (category === 'browser' && policy.browserReadonly && LEVEL_RANK[need] >= LEVEL_RANK.click) {
    return {
      allow: false,
      category,
      level: 'read',
      reason: `检测到前台是浏览器（${proc}），按安全分区策略浏览器只读（禁止模拟点击/输入）。网页操作请改用 browser 工具（带导航审计与白名单）。`,
    }
  }

  // ── 4. 剪贴板授权 ──
  if (act.action_type === 'clipboard' && policy.clipboardGrant && LEVEL_RANK[level] < LEVEL_RANK.full) {
    return {
      allow: false,
      category,
      level,
      reason: `写入系统剪贴板需要 full 级授权（当前应用「${proc || '未知'}」为 ${level}）。请先让用户在设置中授权该应用，或改用键盘输入。`,
    }
  }

  // ── 5. 通用级别比较 ──
  if (LEVEL_RANK[level] < LEVEL_RANK[need]) {
    const needCn: Record<CuLevel, string> = {
      none: '禁止操作', read: '只读', click: '点击', full: '完整控制',
    }
    return {
      allow: false,
      category,
      level,
      reason: `权限不足：动作「${act.action_type}」需要「${needCn[need]}」权限，前台应用「${proc || '未知'}」当前授权级别为「${needCn[level]}」。可在团队面板的 Computer Use 策略中为该应用授权。`,
    }
  }

  return { allow: true, level, category }
}

// ═══════════════════════════════════════════════════════════
// 策略持久化
// ═══════════════════════════════════════════════════════════

export function defaultPolicy(): CuPolicy {
  return {
    enabled: true,
    defaultLevel: 'click',
    rules: {
      // 系统外壳/桌面：默认可点不可乱打
      explorer: 'click',
      // 记事本等普通编辑器：完整控制（用户日常打字场景）
      notepad: 'full',
      '写字板': 'full',
      winword: 'full',
      excel: 'full',
      // macOS 日常文本/办公应用：完整控制
      textedit: 'full',
      pages: 'full',
      'microsoft word': 'full',
      'microsoft excel': 'full',
      notes: 'full',
      // Lumina 自己：完整控制
      lumina: 'full',
    },
    browserReadonly: true,
    terminalClickOnly: true,
    clipboardGrant: true,
    systemKeyBlocklist: [...DEFAULT_SYSTEM_KEY_BLOCKLIST],
    sessionLock: true,
    verifyAfterAction: true,
    noChangeThreshold: 0.02,
    humanInterrupt: true,
    multiMonitor: false,
    maskBackgroundWindows: false,
  }
}

function policyPath(): string {
  const base = app?.getPath ? app.getPath('userData') : process.cwd()
  return path.join(base, 'cu-policy.json')
}

let _cachedPolicy: CuPolicy | null = null

export function getCuPolicy(): CuPolicy {
  if (_cachedPolicy) {return _cachedPolicy}
  try {
    const p = policyPath()
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf-8'))
      const merged: CuPolicy = { ...defaultPolicy(), ...raw }
      // 黑名单做并集，保证新增强制键不会被旧配置绕过
      merged.systemKeyBlocklist = Array.from(new Set([
        ...DEFAULT_SYSTEM_KEY_BLOCKLIST,
        ...(raw.systemKeyBlocklist || []),
      ]))
      _cachedPolicy = merged
    } else {
      _cachedPolicy = defaultPolicy()
    }
  } catch {
    _cachedPolicy = defaultPolicy()
  }
  return _cachedPolicy!
}

/** 原子写入策略（temp + rename） */
export function setCuPolicy(patch: Partial<CuPolicy>): CuPolicy {
  const next = { ...getCuPolicy(), ...patch }
  _cachedPolicy = next
  try {
    const p = policyPath()
    const tmp = p + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8')
    fs.renameSync(tmp, p)
  } catch (e) {
    console.warn('[cuPermissions] 策略持久化失败:', (e as Error)?.message)
  }
  return next
}

/** 为某个应用授予级别 */
export function grantApp(proc: string, level: CuLevel): CuPolicy {
  const key = normalizeProc(proc)
  const rules = { ...getCuPolicy().rules, [key]: level }
  return setCuPolicy({ rules })
}

/** 撤销应用授权（回到默认级别） */
export function revokeApp(proc: string): CuPolicy {
  const key = normalizeProc(proc)
  const rules = { ...getCuPolicy().rules }
  delete rules[key]
  return setCuPolicy({ rules })
}

// ═══════════════════════════════════════════════════════════
// 前台应用探测（Windows: Win32 API via PowerShell；其余平台 fail-open）
// ═══════════════════════════════════════════════════════════

const FOREGROUND_PS = `# cu-foreground: 获取前台窗口进程名与标题
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class Win32 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
}
"@
$h = [Win32]::GetForegroundWindow()
$pid = 0
[void][Win32]::GetWindowThreadProcessId($h, [ref]$pid)
$proc = ""
$title = ""
try { $proc = (Get-Process -Id $pid -ErrorAction Stop).ProcessName } catch {}
try {
  $sb = New-Object System.Text.StringBuilder 512
  [void][Win32]::GetWindowText($h, $sb, 512)
  $title = $sb.ToString()
} catch {}
Write-Output "$proc|$title"
`

interface FgCache { at: number; proc: string; title: string }
let _fgCache: FgCache | null = null
const FG_CACHE_MS = 400

function psScriptPath(): string {
  const base = app?.getPath ? app.getPath('userData') : os.tmpdir()
  const dir = path.join(base, 'scripts')
  if (!fs.existsSync(dir)) {fs.mkdirSync(dir, { recursive: true })}
  const p = path.join(dir, 'cu-foreground.ps1')
  if (!fs.existsSync(p)) {
    fs.writeFileSync(p, FOREGROUND_PS, 'utf-8')
  }
  return p
}

/**
 * macOS：经 AppleScript System Events 取前台 App 名与窗口标题。
 * 与 Windows 版同形（proc|title），使 decideCuGate 的分区/授权逻辑零改动复用。
 *
 * 缓存策略与 Windows 一致（400ms），避免连续动作反复起进程。
 * 缓存变量（_fgCache / FG_CACHE_MS）在上方 FgCache 处已声明，此处直接复用。
 */

/** 从 execFile 结果里取前台信息；统一在这里做归一化与缓存 */
function absorbForeground(stdout: string): { proc: string; title: string } {
  const line = String(stdout || '').trim().split(/\r?\n/).pop() || ''
  const idx = line.indexOf('|')
  const proc = normalizeProc(idx >= 0 ? line.slice(0, idx) : line)
  const title = idx >= 0 ? line.slice(idx + 1) : ''
  _fgCache = { at: Date.now(), proc, title }
  return { proc, title }
}

/**
 * 探测前台应用。返回 {proc, title}；探测不到返回 null（调用方 fail-open）。
 * 结果缓存 400ms，避免连续动作时反复起 PowerShell / osascript。
 */
export function getForegroundApp(): Promise<{ proc: string; title: string } | null> {
  // macOS：System Events 同样需要辅助功能权限；未授权时 resolve(null) 由上层 fail-open
  if (process.platform === 'darwin') {
    const now = Date.now()
    if (_fgCache && now - _fgCache.at < FG_CACHE_MS) {
      return Promise.resolve({ proc: _fgCache.proc, title: _fgCache.title })
    }
    return new Promise((resolve) => {
      try {
        execFile('osascript', [
          '-e', 'tell application "System Events" to set fw to first application process whose frontmost is true',
          '-e', 'tell application "System Events" to return (name of fw) & "|" & (name of window 1 of fw)',
        ], { timeout: 2500, maxBuffer: 64 * 1024 }, (err, stdout) => {
          if (err) {
            console.warn('[cuPermissions] macOS 前台探测失败（放行）:', err.message)
            resolve(null)
            return
          }
          const out = String(stdout || '').trim()
          if (!out || out.startsWith('execution error') || out.startsWith('ERR:')) {
            console.warn('[cuPermissions] macOS 前台探测返回异常（放行）:', out.slice(0, 120))
            resolve(null)
            return
          }
          resolve(absorbForeground(out))
        })
      } catch (e) {
        console.warn('[cuPermissions] macOS 前台探测异常（放行）:', (e as Error)?.message)
        resolve(null)
      }
    })
  }

  if (process.platform !== 'win32') {
    return Promise.resolve(null)
  }
  const now = Date.now()
  if (_fgCache && now - _fgCache.at < FG_CACHE_MS) {
    return Promise.resolve({ proc: _fgCache.proc, title: _fgCache.title })
  }
  return new Promise((resolve) => {
    try {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psScriptPath()],
        { timeout: 2500, windowsHide: true, maxBuffer: 64 * 1024 },
        (err, stdout) => {
          if (err) {
            console.warn('[cuPermissions] 前台探测失败（放行）:', err.message)
            resolve(null)
            return
          }
          resolve(absorbForeground(String(stdout)))
        },
      )
    } catch (e) {
      console.warn('[cuPermissions] 前台探测异常（放行）:', (e as Error)?.message)
      resolve(null)
    }
  })
}

/** 清除前台缓存（会话切换时调用） */
export function clearForegroundCache(): void {
  _fgCache = null
}

// ═══════════════════════════════════════════════════════════
// 会话锁（内存 + 锁文件，防两个操控者同时驱动键鼠）
// ═══════════════════════════════════════════════════════════

interface CuSession {
  id: string
  label: string
  pid: number
  startedAt: number
}

let _activeSession: CuSession | null = null

function lockPath(): string {
  const base = app?.getPath ? app.getPath('userData') : process.cwd()
  return path.join(base, 'cu-session.lock')
}

/** 判断 pid 是否存活（Windows 下 process.kill(pid,0) 可用） */
function pidAlive(pid: number): boolean {
  if (pid === process.pid) {return true}
  try {
    process.kill(pid, 0)
    return true
  } catch (e: any) {
    // ESRCH = 不存在；EPERM = 存在但无权访问（也算存活）
    return e?.code === 'EPERM'
  }
}

/** 读取锁文件，陈旧锁自动清理 */
function readStaleLock(): CuSession | null {
  try {
    const p = lockPath()
    if (!fs.existsSync(p)) {return null}
    const s = JSON.parse(fs.readFileSync(p, 'utf-8')) as CuSession
    if (!s.pid || !pidAlive(s.pid)) {
      fs.rmSync(p, { force: true })
      return null
    }
    return s
  } catch {
    return null
  }
}

/**
 * 获取当前活动会话（内存优先，锁文件兜底）。
 */
export function getActiveSession(): CuSession | null {
  if (_activeSession) {return _activeSession}
  const lock = readStaleLock()
  if (lock) {_activeSession = lock}
  return _activeSession
}

/**
 * 申请会话锁。
 * @returns 成功返回 true；已有其他会话持锁返回 false。
 */
export function acquireCuSession(id: string, label: string): boolean {
  const policy = getCuPolicy()
  if (!policy.sessionLock) {return true}
  const existing = getActiveSession()
  if (existing && existing.id !== id) {
    console.warn(`[cuPermissions] 会话锁被占用: ${existing.id}(${existing.label})，拒绝 ${id}(${label})`)
    return false
  }
  _activeSession = { id, label, pid: process.pid, startedAt: Date.now() }
  try {
    fs.writeFileSync(lockPath(), JSON.stringify(_activeSession, null, 2), 'utf-8')
  } catch (e) {
    console.warn('[cuPermissions] 会话锁写入失败:', (e as Error)?.message)
  }
  clearForegroundCache()
  return true
}

/** 释放会话锁（只有持锁者自己能释放） */
export function releaseCuSession(id: string): void {
  releaseHumanLease(id)
  if (_activeSession && _activeSession.id === id) {
    _activeSession = null
    try {fs.rmSync(lockPath(), { force: true })} catch { /* ignore */ }
  }
}

/**
 * 会话锁校验：动作声明的 sessionId 与持锁者不一致时拒绝。
 * 未声明 sessionId 的动作（如旧式 IPC）在有锁时也拒绝，防止绕过。
 */
export function checkSession(sessionId?: string | null): { ok: boolean; reason?: string } {
  const policy = getCuPolicy()
  if (!policy.sessionLock) {return { ok: true }}
  const lock = getActiveSession()
  if (!lock) {return { ok: true }}
  if (sessionId && sessionId === lock.id) {return { ok: true }}
  return {
    ok: false,
    reason: `Computer Use 会话锁正被「${lock.label}」占用，当前操控者必须等待其结束，避免并发键鼠冲突。`,
  }
}

export type { CuSession }

// ═══════════════════════════════════════════════════════════
// 统一执行前门禁（会话锁 + 前台探测 + 纯决策）
// ═══════════════════════════════════════════════════════════

/**
 * 动作执行前统一门禁。由 cuCore.executeCuAction 调用。
 * 任何探测异常都 fail-open（放行并告警），绝不把用户卡死。
 *
 * @param act 即将执行的动作
 * @param opts.sessionId 操控者会话标识（desktop_act / 引擎批次）
 */
export async function gateCuAction(
  act: CuAction,
  opts: { sessionId?: string | null } = {},
): Promise<GateDecision> {
  const policy = getCuPolicy()
  if (!policy.enabled) {return { allow: true, level: 'full', category: 'other' }}

  // 1. 会话锁校验（廉价，先做）
  if (policy.sessionLock) {
    const sess = checkSession(opts.sessionId)
    if (!sess.ok) {return { allow: false, reason: sess.reason }}
  }

  // 1.5 v3.30 ForegroundLease：真人一碰键鼠，整轮自动操作立刻中止
  //     （只读动作不触发建约，只在物理动作上检查）
  if (policy.humanInterrupt && opts.sessionId && requiredLevel(act) !== 'read') {
    try {
      const v = gateHumanInput(opts.sessionId)
      if (v.interrupted) {
        return { allow: false, category: 'other', reason: v.reason }
      }
    } catch (e) {
      console.warn('[cuPermissions] 人机输入仲裁异常（放行）:', (e as Error)?.message)
    }
  }

  // 2. 只读动作无需前台探测（截图/滚动/等待本身不构成越权）
  const need = requiredLevel(act)
  if (need === 'read') {
    return decideCuGate(policy, act, { proc: null, title: null, sessionId: opts.sessionId })
  }

  // 3. 前台应用探测
  let fg: { proc: string; title: string } | null = null
  try {
    fg = await getForegroundApp()
  } catch (e) {
    console.warn('[cuPermissions] 前台探测异常（放行）:', (e as Error)?.message)
  }
  return decideCuGate(policy, act, {
    proc: fg?.proc ?? null,
    title: fg?.title ?? null,
    sessionId: opts.sessionId,
  })
}

