// ============================================================
// cuInputGuard.ts — v3.30 ForegroundLease：人机输入冲突仲裁
//
// 对标 cc-haha win_helper 的 lease：自动操作期间用户一碰鼠标/键盘，
// 当前动作批次立即中止，避免两套键鼠互踩。
//
// 关键难点：GetLastInputInfo 无法区分「真人输入」与「AI 注入输入」
// （mouse_event/SendInput 也会刷新它）。因此这里用 Windows 低级钩子
// WH_MOUSE_LL / WH_KEYBOARD_LL，它们的 flags 里带 LLMHF_INJECTED /
// LLKHF_INJECTED 位——注入事件一律忽略，只统计真人事件。
//
// 钩子跑在一个常驻 PowerShell 进程里（带消息泵），用 stdout 行上报：
//   M <tick>   鼠标移动（仅真人）
//   C <tick>   鼠标按键（含滚轮按下）
//   W <tick>   鼠标滚轮
//   K <tick> <vk> 键盘按下（已过滤 UP 与注入）
//
// ⚠️ 平台现状：本模块的运行时实现（常驻 PowerShell 钩子）**仅 Windows 可用**。
//   • win32  ：WH_MOUSE_LL / WH_KEYBOARD_LL + LLMHF_INJECTED/LLKHF_INJECTED 过滤注入事件
//   • darwin ：**未实现**（等价物是 CGEventTap 原生 helper，需单独签名/公证）
//              gateHumanInput 会登记 unsupported 状态并只记一次日志，
//              而不是静默返回「未打断」让用户误以为保护开着。
//   • linux  ：同理未实现（需 XRecord / libinput 钩子）。
//   纯逻辑部分（InputState / LeaseBookkeeper / checkLeaseInterrupt）与平台无关，可单测。
// ============================================================

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { join } from 'path'
import { mkdirSync, writeFileSync, existsSync } from 'fs'
import { reportCapabilityStatus, unsupported } from '../../core/platform/platformStatus'

// ──────────────────────────────────────────────────────────
// 纯逻辑：输入状态
// ──────────────────────────────────────────────────────────

export interface GuardSnapshot {
  /** 真人鼠标按键/滚轮最后一次 tick（0=从未） */
  clickTick: number
  /** 真人键盘最后一次 tick */
  keyTick: number
  /** 真人鼠标移动事件计数（移动用计数，避免手抖误杀） */
  moveCount: number
}

export class InputState {
  clickTick = 0
  keyTick = 0
  moveCount = 0

  apply(line: string): void {
    const parts = line.trim().split(/\s+/)
    const t = Number(parts[1])
    if (!Number.isFinite(t)) {return}
    switch (parts[0]) {
      case 'C': case 'W':
        this.clickTick = t
        break
      case 'K':
        this.keyTick = t
        break
      case 'M':
        this.moveCount += 1
        break
      default:
        break
    }
  }

  snapshot(): GuardSnapshot {
    return { clickTick: this.clickTick, keyTick: this.keyTick, moveCount: this.moveCount }
  }
}

export interface InterruptVerdict {
  interrupted: boolean
  reason: string
}

/**
 * 判定租约是否被真人打断（纯函数）。
 * @param lease   建约时的快照
 * @param current 当前快照
 * @param moveThreshold 建约后真人移动事件超过该阈值视为「抢鼠标」（防抖，默认 8 次≈400ms 内的明显动作）
 */
export function checkLeaseInterrupt(
  lease: GuardSnapshot,
  current: GuardSnapshot,
  moveThreshold = 8,
): InterruptVerdict {
  if (current.clickTick > lease.clickTick) {
    return { interrupted: true, reason: '检测到用户按下了鼠标按键/滚轮，已立即中止自动操作' }
  }
  if (current.keyTick > lease.keyTick) {
    return { interrupted: true, reason: '检测到用户正在使用键盘，已立即中止自动操作' }
  }
  if (current.moveCount - lease.moveCount > moveThreshold) {
    return { interrupted: true, reason: '检测到用户正在移动鼠标，已立即中止自动操作' }
  }
  return { interrupted: false, reason: '' }
}

/**
 * 租约簿记：sessionId → 基线快照；被打断的租约置 broken，
 * 必须等会话释放（release）后才允许新一轮自动操作。
 */
export class LeaseBookkeeper {
  private leases = new Map<string, GuardSnapshot>()
  private broken = new Set<string>()

  touch(id: string, snap: GuardSnapshot): void {
    if (!this.leases.has(id)) {
      this.leases.set(id, snap)
      this.broken.delete(id)
    }
  }

  markBroken(id: string): void {this.broken.add(id)}
  isBroken(id: string): boolean {return this.broken.has(id)}
  release(id: string): void {
    this.leases.delete(id)
    this.broken.delete(id)
  }
  baseline(id: string): GuardSnapshot | undefined {return this.leases.get(id)}
}

// ──────────────────────────────────────────────────────────
// 运行时：常驻 PowerShell 钩子
// ──────────────────────────────────────────────────────────

const HOOK_PS = `# Lumina v3.30 真人输入监视钩子（低级钩子，过滤注入事件）
$ErrorActionPreference = 'Stop'
$src = @"
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public class LuminaHumanHook {
  private delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);
  [DllImport("kernel32.dll")] private static extern IntPtr GetModuleHandle(string n);
  [DllImport("user32.dll")] private static extern IntPtr SetWindowsHookEx(int id, HookProc cb, IntPtr hMod, uint tid);
  [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr h, int n, IntPtr w, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] private struct POINT { public int x; public int y; }
  [StructLayout(LayoutKind.Sequential)] private struct MSLL { public POINT pt; public uint mouseData; public uint flags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] private struct KBDLL { public int vk; public int scan; public uint flags; public uint time; public IntPtr extra; }
  private const int WH_MOUSE_LL = 14;
  private const int WH_KEYBOARD_LL = 13;
  private const uint INJ_M = 0x1;
  private const uint INJ_K = 0x10;
  private const uint K_UP = 0x80;
  private static HookProc mcb;
  private static HookProc kcb;
  private static IntPtr mh;
  private static IntPtr kh;
  private static void Emit(string s) { Console.Out.WriteLine(s); Console.Out.Flush(); }
  private static IntPtr MouseCb(int nCode, IntPtr wParam, IntPtr lParam) {
    if (nCode >= 0) {
      MSLL d = (MSLL)Marshal.PtrToStructure(lParam, typeof(MSLL));
      if ((d.flags & INJ_M) == 0) {
        uint w = (uint)wParam;
        if (w == 0x0200) Emit("M " + Environment.TickCount);
        else if (w == 0x020A) Emit("W " + Environment.TickCount);
        else if (w == 0x0201 || w == 0x0204 || w == 0x0207) Emit("C " + Environment.TickCount);
      }
    }
    return CallNextHookEx(mh, nCode, wParam, lParam);
  }
  private static IntPtr KeyCb(int nCode, IntPtr wParam, IntPtr lParam) {
    if (nCode >= 0) {
      KBDLL d = (KBDLL)Marshal.PtrToStructure(lParam, typeof(KBDLL));
      if ((d.flags & INJ_K) == 0 && (d.flags & K_UP) == 0) {
        Emit("K " + Environment.TickCount + " " + d.vk);
      }
    }
    return CallNextHookEx(kh, nCode, wParam, lParam);
  }
  public static void Start() {
    IntPtr mod = GetModuleHandle(null);
    mcb = new HookProc(MouseCb);
    kcb = new HookProc(KeyCb);
    mh = SetWindowsHookEx(WH_MOUSE_LL, mcb, mod, 0);
    kh = SetWindowsHookEx(WH_KEYBOARD_LL, kcb, mod, 0);
    Application.Run();
  }
}
"@
Add-Type -TypeDefinition $src -ReferencedAssemblies System.Windows.Forms,System.Drawing
[LuminaHumanHook]::Start()
`

let scriptsDir: string | null = null
try {
  // 惰性引入，避免测试环境（无 Electron app）直接崩
   
  const { app } = require('electron')
  scriptsDir = join(app.getPath('userData'), 'scripts')
} catch { /* 非 Electron 环境 */ }

function hookScriptPath(): string | null {
  if (!scriptsDir) {return null}
  try {
    if (!existsSync(scriptsDir)) {mkdirSync(scriptsDir, { recursive: true })}
    const p = join(scriptsDir, 'cu-human-hook.ps1')
    if (!existsSync(p)) {writeFileSync(p, HOOK_PS, 'utf8')}
    return p
  } catch {return null}
}

class HumanInputGuard {
  private state = new InputState()
  private proc: ChildProcessWithoutNullStreams | null = null
  private starting = false
  private restarts = 0
  private lastExitAt = 0

  private start(): void {
    if (this.starting || this.proc || process.platform !== 'win32') {return}
    const script = hookScriptPath()
    if (!script) {return}
    this.starting = true
    try {
      const p = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
        { windowsHide: true },
      )
      this.proc = p
      p.stdout.setEncoding('utf8')
      p.stdout.on('data', (chunk: string) => {
        for (const line of chunk.split(/\r?\n/)) {
          if (line.trim()) {this.state.apply(line)}
        }
      })
      p.stderr.on('data', () => { /* 钩子错误静默，fail-open */ })
      p.on('exit', () => {
        this.proc = null
        this.starting = false
        // 偶发崩溃最多重启 3 次，避免疯狂拉进程
        const now = Date.now()
        if (this.restarts < 3 && now - this.lastExitAt > 3000) {
          this.restarts += 1
          this.lastExitAt = now
          setTimeout(() => this.start(), 500)
        }
      })
      p.on('error', () => {
        this.proc = null
        this.starting = false
      })
      // 钩子安装需要一拍；立刻到达的输入状态在下次 action 时自然可见
      setTimeout(() => { this.starting = false }, 1500)
    } catch {
      this.proc = null
      this.starting = false
    }
  }

  /** 确保钩子进程在跑（CU 会话首次动作时调用） */
  ensureRunning(): void {
    if (process.platform === 'win32' && !this.proc && !this.starting) {this.start()}
  }

  current(): GuardSnapshot {
    return this.state.snapshot()
  }

  dispose(): void {
    try {this.proc?.kill()} catch { /* ignore */ }
    this.proc = null
  }
}

let _guard: HumanInputGuard | null = null
export function getHumanInputGuard(): HumanInputGuard {
  if (!_guard) {_guard = new HumanInputGuard()}
  return _guard
}

// ──────────────────────────────────────────────────────────
// 会话级租约（供 cuPermissions.gateCuAction 调用）
// ──────────────────────────────────────────────────────────

const book = new LeaseBookkeeper()

/**
 * 动作前检查：首次动作建约（以当前输入状态为基线）；
 * 之后任何真人输入都打断租约，被打断的会话所有后续动作一律拒绝。
 */
export function gateHumanInput(sessionId?: string | null): InterruptVerdict {
  if (!sessionId) {
    return { interrupted: false, reason: '' }
  }
  if (process.platform === 'darwin') {
    // macOS 诚实降级：没有等价实现。
    // Windows 靠 WH_MOUSE_LL/WH_KEYBOARD_LL 且用 LLMHF_INJECTED/LLKHF_INJECTED
    // 过滤掉自家注入事件；macOS 的等价物是 CGEventTap（kCGHIDEventTap），
    // 必须写原生 helper（C/Swift/Objective-C）+ 单独签名公证，
    // 在本次交付范围内**未实现**。
    //
    // 为什么不静默返回「未打断」：那样用户以为「一碰鼠标就自动中止」的保护
    // 开着，实际上开着的是空气——自动操作会跟真人抢鼠标而不自知。
    // 这里只在本会话首次建约时登记一次 needs_permission/unsupported 状态，
    // 让设置页能诚实地展示「真人接管守卫：macOS 不支持」。
    reportHumanGuardUnsupported()
    return { interrupted: false, reason: '' }
  }
  if (process.platform !== 'win32') {
    return { interrupted: false, reason: '' }
  }
  const guard = getHumanInputGuard()
  guard.ensureRunning()
  const snap = guard.current()
  if (book.isBroken(sessionId)) {
    return { interrupted: true, reason: '本自动操作会话已因用户接管而中止；如需继续，请重新发起任务' }
  }
  const baseline = book.baseline(sessionId)
  if (!baseline) {
    book.touch(sessionId, snap)
    return { interrupted: false, reason: '' }
  }
  const v = checkLeaseInterrupt(baseline, snap)
  if (v.interrupted) {book.markBroken(sessionId)}
  return v
}

let _macUnsupportedLogged = false
/**
 * 登记「macOS 无真人接管守卫」这一事实（每次进程只登记一次，避免刷日志）。
 * 不抛异常、不阻断 CU——只是把「没这个保护」如实告诉上层。
 */
function reportHumanGuardUnsupported(): void {
  if (_macUnsupportedLogged) {return}
  _macUnsupportedLogged = true
  reportCapabilityStatus('human_input_guard', unsupported(
    'macOS 尚无「真人接管守卫」：该能力依赖 Windows 低级钩子（WH_MOUSE_LL/WH_KEYBOARD_LL）过滤注入事件，'
    + 'macOS 的等价实现需 CGEventTap 原生 helper（需单独签名/公证），本版未实现。',
    '因此在 macOS 上自动操作期间手动碰鼠标/键盘**不会**中止当前批次。',
  ))
  console.info('[cuInputGuard] macOS：真人接管守卫未实现（需 CGEventTap 原生 helper），自动操作不会因手动输入而中止')
}

export function releaseHumanLease(sessionId?: string | null): void {
  if (sessionId) {book.release(sessionId)}
}

/** 测试用：清空租约 */
export function _resetLeaseBookForTest(): void {
  for (const id of [...(book as any).leases.keys()]) {book.release(id)}
}
