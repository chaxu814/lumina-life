// ============================================================
// teachRecorder.ts — v3.31 Teach 录制回放（P2，对标 cc-haha #10）
//
// cc-haha 可「演示一次 → 自动沉淀成技能」。Lumina 落地（Windows）：
//   1. 低级钩子 WH_MOUSE_LL / WH_KEYBOARD_LL 录制（v3.31 升级，替代 50ms 轮询）：
//      左/右键点击、拖拽、滚轮（含方向与格数）、组合键、功能键、连续打字；
//      注入事件过滤（不录自己回放的动作）、SetProcessDPIAware 坐标物理像素；
//   2. 隐私设计：录制必须用户显式开始；「聚合打字」默认关（避免在密码框录到密码）；
//   3. 纯转换函数 eventsToActions 把原始事件转成 CuAction，
//      像素坐标按录制时屏幕尺寸归一化，回放时按当前屏缩放；
//   4. 回放走既有 executeCuAction（带会话锁/权限/真人中止），不是旁路注入。
//
// v3.30→v3.31 收口：
//   - 滚轮可录（轮询 GetAsyncKeyState 取不到 wheel，钩子可以）；
//   - 键盘有 key-up 沿，修饰键状态不再靠「一次消费」猜；
//   - 连续打字可聚合为 type 动作（剪贴板粘贴，支持长文本）；
//   - 回放同时开放 UI 入口（IPC teach:replay）。
// ============================================================

import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { spawn, type ChildProcess } from 'child_process'

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

/**
 * 原始事件：
 *  md/mu 鼠标键按下/抬起（b=L/R/M，带 x/y）
 *  wheel 滚轮（d=带符号 WHEEL_DELTA，正=向上，带 x/y）
 *  kd/ku 键盘按下/抬起（b=vk 码字符串）
 *  key  v3.30 兼容：仅按下沿的旧事件
 */
export interface RawEvent {
  /** ms 时间戳（相对录制开始） */
  t: number
  k: 'md' | 'mu' | 'wheel' | 'kd' | 'ku' | 'key'
  /** 鼠标键 L/R/M；键盘为 vk 码（字符串）；wheel 可为空 */
  b?: string
  /** 滚轮带符号增量（WHEEL_DELTA 单位，通常 ±120） */
  d?: number
  x?: number
  y?: number
}

export interface LessonMeta {
  id: string
  name: string
  description: string
  screenW: number
  screenH: number
  createdAt: number
  tags: string[]
  /** v3.31：回放时是否把连续打字聚合为 type 文本动作 */
  aggregateTyping?: boolean
}

export interface Lesson extends LessonMeta {
  events: RawEvent[]
}

// ═══════════════════════════════════════════════════════════
// 纯转换：原始事件 → CuAction（可单测）
// ═══════════════════════════════════════════════════════════

export type ConvertedAction =
  | { action_type: 'click'; nx: number; ny: number; wait_seconds?: number }
  | { action_type: 'right_click'; nx: number; ny: number }
  | { action_type: 'drag'; nx: number; ny: number; nx2: number; ny2: number; wait_seconds?: number }
  | { action_type: 'scroll'; nx: number; ny: number; scroll_amount: number }
  | { action_type: 'type'; text: string }
  | { action_type: 'keypress'; key: string }

const VK_NAMES: Record<number, string> = {
  0x0D: 'enter', 0x1B: 'escape', 0x09: 'tab', 0x20: 'space', 0x08: 'backspace',
  0x2E: 'delete', 0x2D: 'insert', 0x25: 'left', 0x26: 'up', 0x27: 'right', 0x28: 'down',
  0x21: 'pageup', 0x22: 'pagedown', 0x24: 'home', 0x23: 'end',
  0x70: 'f1', 0x71: 'f2', 0x72: 'f3', 0x73: 'f4', 0x74: 'f5', 0x75: 'f6',
  0x76: 'f7', 0x78: 'f9', 0x79: 'f10', 0x7A: 'f11', 0x7B: 'f12',
  0xBA: ';', 0xBB: '=', 0xBC: ',', 0xBD: '-', 0xBE: '.', 0xBF: '/', 0xC0: '`',
  0xDB: '[', 0xDC: '\\', 0xDD: ']', 0xDE: "'",
}
/** shift 按住时的 OEM 键面（US 键盘，best-effort） */
const VK_SHIFTED: Record<number, string> = {
  0x30: ')', 0x31: '!', 0x32: '@', 0x33: '#', 0x34: '$', 0x35: '%',
  0x36: '^', 0x37: '&', 0x38: '*', 0x39: '(',
  0xBA: ':', 0xBB: '+', 0xBC: '<', 0xBD: '_', 0xBE: '>', 0xBF: '?', 0xC0: '~',
  0xDB: '{', 0xDC: '|', 0xDD: '}', 0xDE: '"',
}
const MOD_VK: Record<number, string> = { 0x11: 'ctrl', 0x12: 'alt', 0x10: 'shift' }
const STOP_VK = 0x77 // F8 结束录制
const DRAG_THRESHOLD = 6 // px
const TYPE_GAP_MS = 900 // 打字间隔超过该值切分一段 type
const SCROLL_CLAMP = 20

function vkToKey(vk: number): string | null {
  if (VK_NAMES[vk]) {return VK_NAMES[vk]}
  if (vk >= 0x41 && vk <= 0x5A) {return String.fromCharCode(vk).toLowerCase()}
  if (vk >= 0x30 && vk <= 0x39) {return String(vk - 0x30)}
  return null
}

/** 可聚合进文本的字符（无修饰或仅 shift） */
function vkToChar(vk: number, shift: boolean): string | null {
  if (vk === 0x20) {return ' '}
  if (shift && VK_SHIFTED[vk] !== undefined) {return VK_SHIFTED[vk]}
  if (vk >= 0x41 && vk <= 0x5A) {return String.fromCharCode(vk + (shift ? 0 : 32))}
  if (vk >= 0x30 && vk <= 0x39) {return String(vk - 0x30)}
  if (VK_NAMES[vk] && /^[;=,.\-/`'\\[\]]$/.test(VK_NAMES[vk])) {return VK_NAMES[vk]}
  return null
}

export interface ConvertOptions {
  /** 连续打字聚合为 type 动作（默认 false：每个字母走 keypress，兼容 v3.30） */
  aggregateTyping?: boolean
}

/**
 * 事件流 → CuAction 列表。
 *   md…mu 位移 < 阈值 = 点击（R 键为右键）；≥ 阈值 = 拖拽
 *   wheel 连续滚轮合并为一个 scroll（位置取首事件，格数带符号夹紧）
 *   修饰键按住期间的普通键 = 组合键（ctrl+s、alt+tab…）
 *   无修饰可打印键：aggregateTyping 时聚合进 type 文本；否则逐键 keypress
 *   非打印键（enter/esc/方向键…）= keypress
 */
export function eventsToActions(
  events: RawEvent[],
  screenW: number,
  screenH: number,
  opts: ConvertOptions = {},
): ConvertedAction[] {
  const out: ConvertedAction[] = []
  const norm = (x: number, y: number) => ({
    nx: screenW > 0 ? Math.max(0, Math.min(100, (x / screenW) * 100)) : 0,
    ny: screenH > 0 ? Math.max(0, Math.min(100, (y / screenH) * 100)) : 0,
  })

  let down: { b: string; x: number; y: number; t: number } | null = null
  const mods = new Set<string>()
  // 打字缓冲
  let typeBuf = ''
  let lastTypeAt = -1
  const flushType = () => {
    if (typeBuf) {
      out.push({ action_type: 'type', text: typeBuf })
      typeBuf = ''
      lastTypeAt = -1
    }
  }
  // 滚轮缓冲（相邻 wheel 事件合并）
  let wheelAcc = 0
  let wheelAt = -1
  let wheelX = 0
  let wheelY = 0
  const flushWheel = () => {
    if (wheelAcc !== 0) {
      const a = norm(wheelX, wheelY)
      const amount = Math.max(-SCROLL_CLAMP, Math.min(SCROLL_CLAMP, Math.round(wheelAcc / 120)))
      if (amount !== 0) {out.push({ action_type: 'scroll', ...a, scroll_amount: amount })}
      wheelAcc = 0
      wheelAt = -1
    }
  }

  const keyDown = (vk: number, t: number) => {
    if (vk === STOP_VK) {return}
    if (MOD_VK[vk]) {
      // shift 是打字的一部分（大写/符号面），不切段；ctrl/alt 才是组合键
      if (MOD_VK[vk] !== 'shift') {flushType()}
      mods.add(MOD_VK[vk])
      return
    }
    const onlyShift = mods.size === 1 && mods.has('shift')
    const noMod = mods.size === 0
    if (opts.aggregateTyping && (noMod || onlyShift)) {
      const ch = vkToChar(vk, mods.has('shift'))
      if (ch !== null) {
        if (typeBuf && t - lastTypeAt > TYPE_GAP_MS) {flushType()}
        typeBuf += ch
        lastTypeAt = t
        return
      }
      // backspace 回退缓冲
      if (vk === 0x08 && typeBuf) {
        typeBuf = typeBuf.slice(0, -1)
        return
      }
    }
    flushType()
    const key = vkToKey(vk)
    if (!key) {return}
    if (mods.size > 0) {
      const order = ['ctrl', 'alt', 'shift'].filter(m => mods.has(m))
      out.push({ action_type: 'keypress', key: [...order, key].join('+') })
      // 修饰键在 key-up 时才真正释放；旧轮询事件没有 up，下一个普通键不重复带修饰
    } else {
      out.push({ action_type: 'keypress', key })
    }
  }

  const keyUp = (vk: number) => {
    if (MOD_VK[vk]) {
      mods.delete(MOD_VK[vk])
    }
  }

  for (let i = 0; i < events.length; i++) {
    const e = events[i]
    if (e.k === 'md') {
      flushType(); flushWheel()
      down = { b: e.b || 'L', x: e.x || 0, y: e.y || 0, t: e.t }
    } else if (e.k === 'mu' && down) {
      const dx = (e.x || 0) - down.x
      const dy = (e.y || 0) - down.y
      const dist = Math.hypot(dx, dy)
      const a = norm(down.x, down.y)
      if (dist >= DRAG_THRESHOLD) {
        const b = norm(e.x || 0, e.y || 0)
        const dur = (e.t - down.t) / 1000
        out.push({
          action_type: 'drag',
          nx: a.nx, ny: a.ny, nx2: b.nx, ny2: b.ny,
          wait_seconds: Math.max(0.15, Math.min(3, dur)),
        })
      } else if (down.b === 'R') {
        out.push({ action_type: 'right_click', ...a })
      } else {
        out.push({ action_type: 'click', ...a, wait_seconds: 0.15 })
      }
      down = null
    } else if (e.k === 'wheel') {
      flushType()
      const delta = Number(e.d) || 0
      if (delta === 0) {continue}
      if (wheelAcc === 0 || (wheelAt >= 0 && e.t - wheelAt > 260)) {
        flushWheel()
        wheelX = e.x || 0; wheelY = e.y || 0
      }
      wheelAcc += delta
      wheelAt = e.t
    } else if (e.k === 'kd' || e.k === 'key') {
      keyDown(parseInt(e.b || '0', 10), e.t)
    } else if (e.k === 'ku') {
      keyUp(parseInt(e.b || '0', 10))
    }
  }
  flushWheel()
  flushType()
  return out
}

// ═══════════════════════════════════════════════════════════
// PowerShell 低级钩子录制脚本（v3.31）
// ═══════════════════════════════════════════════════════════

const TEACH_PS = `# Lumina Teach recorder (v3.31) — generated, do not edit
param([string]$OutFile)
$ErrorActionPreference = 'Stop'
$src = @"
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public class LuminaTeachHook {
  private delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);
  [DllImport("kernel32.dll")] private static extern IntPtr GetModuleHandle(string n);
  [DllImport("user32.dll")] private static extern IntPtr SetWindowsHookEx(int id, HookProc cb, IntPtr hMod, uint tid);
  [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr h, int n, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] private static extern bool UnhookWindowsHookEx(IntPtr h);
  [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
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
  private static System.IO.StreamWriter w;
  private static long t0;
  private static long Now() { return (long)(DateTime.UtcNow - new DateTime(1970,1,1)).TotalMilliseconds - t0; }
  private static void Emit(string s) { w.WriteLine(s); w.Flush(); }
  private static string MouseName(uint msg) {
    if (msg == 0x0201 || msg == 0x0202) return "L";
    if (msg == 0x0204 || msg == 0x0205) return "R";
    if (msg == 0x0207 || msg == 0x0208) return "M";
    return "";
  }
  private static IntPtr MouseCb(int nCode, IntPtr wParam, IntPtr lParam) {
    if (nCode >= 0) {
      MSLL d = (MSLL)Marshal.PtrToStructure(lParam, typeof(MSLL));
      if ((d.flags & INJ_M) == 0) {
        uint msg = (uint)wParam;
        long t = Now();
        if (msg == 0x0201 || msg == 0x0204 || msg == 0x0207)
          Emit("{\\"t\\":" + t + ",\\"k\\":\\"md\\",\\"b\\":\\"" + MouseName(msg) + "\\",\\"x\\":" + d.pt.x + ",\\"y\\":" + d.pt.y + "}");
        else if (msg == 0x0202 || msg == 0x0205 || msg == 0x0208)
          Emit("{\\"t\\":" + t + ",\\"k\\":\\"mu\\",\\"b\\":\\"" + MouseName(msg) + "\\",\\"x\\":" + d.pt.x + ",\\"y\\":" + d.pt.y + "}");
        else if (msg == 0x020A) {
          short delta = (short)(d.mouseData >> 16);
          Emit("{\\"t\\":" + t + ",\\"k\\":\\"wheel\\",\\"d\\":" + delta + ",\\"x\\":" + d.pt.x + ",\\"y\\":" + d.pt.y + "}");
        }
      }
    }
    return CallNextHookEx(mh, nCode, wParam, lParam);
  }
  private static IntPtr KeyCb(int nCode, IntPtr wParam, IntPtr lParam) {
    if (nCode >= 0) {
      KBDLL d = (KBDLL)Marshal.PtrToStructure(lParam, typeof(KBDLL));
      if ((d.flags & INJ_K) == 0) {
        if (d.vk == 0x77) {
          Emit("{\\"t\\":" + Now() + ",\\"k\\":\\"kd\\",\\"b\\":\\"119\\"}");
          Application.Exit();
        } else {
          bool up = (d.flags & K_UP) != 0 || (uint)wParam == 0x0101 || (uint)wParam == 0x0105;
          Emit("{\\"t\\":" + Now() + ",\\"k\\":\\"" + (up ? "ku" : "kd") + "\\",\\"b\\":\\"" + d.vk + "\\"}");
        }
      }
    }
    return CallNextHookEx(kh, nCode, wParam, lParam);
  }
  public static void Run(string outFile) {
    try { SetProcessDPIAware(); } catch {}
    w = new System.IO.StreamWriter(outFile, false, System.Text.Encoding.UTF8);
    t0 = (long)(DateTime.UtcNow - new DateTime(1970,1,1)).TotalMilliseconds;
    IntPtr mod = GetModuleHandle(null);
    mcb = new HookProc(MouseCb);
    kcb = new HookProc(KeyCb);
    mh = SetWindowsHookEx(WH_MOUSE_LL, mcb, mod, 0);
    kh = SetWindowsHookEx(WH_KEYBOARD_LL, kcb, mod, 0);
    Application.Run();
    try { UnhookWindowsHookEx(mh); } catch {}
    try { UnhookWindowsHookEx(kh); } catch {}
    w.Close();
  }
}
"@
Add-Type -TypeDefinition $src -ReferencedAssemblies System.Windows.Forms,System.Drawing
[LuminaTeachHook]::Run($OutFile)
`

// ═══════════════════════════════════════════════════════════
// 录制器（spawn 管理）
// ═══════════════════════════════════════════════════════════

function teachDir(): string {
  const base = app?.getPath ? app.getPath('userData') : process.cwd()
  return path.join(base, 'teach')
}
function scriptsDir(): string {
  const base = app?.getPath ? app.getPath('userData') : process.cwd()
  return path.join(base, 'scripts')
}

/** 每次启动覆盖写入，保证脚本随版本更新 */
function ensureScript(): string {
  const dir = scriptsDir()
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'teach-record-v331.ps1')
  fs.writeFileSync(file, TEACH_PS, 'utf-8')
  return file
}

/** 解析 JSONL 为事件数组（坏行跳过） */
export function parseEvents(text: string): RawEvent[] {
  const out: RawEvent[] = []
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim()
    if (!s) {continue}
    try {
      const e = JSON.parse(s)
      if (e && typeof e.t === 'number' && typeof e.k === 'string') {out.push(e as RawEvent)}
    } catch { /* 跳过坏行 */ }
  }
  return out.sort((a, b) => a.t - b.t)
}

export class TeachRecorder {
  private proc: ChildProcess | null = null
  private outFile: string | null = null
  private startedAt = 0

  get recording(): boolean {return !!this.proc}

  /** 开始录制（F8 结束，或调 stop()） */
  start(): { ok: boolean; message: string; outFile?: string } {
    if (this.proc) {return { ok: false, message: '正在录制中' }}
    if (process.platform !== 'win32') {return { ok: false, message: 'Teach 录制目前仅支持 Windows' }}
    const dir = teachDir()
    fs.mkdirSync(path.join(dir, 'raw'), { recursive: true })
    const id = `rec_${Date.now().toString(36)}`
    this.outFile = path.join(dir, 'raw', `${id}.jsonl`)
    const script = ensureScript()
    try {
      this.proc = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', script, '-OutFile', this.outFile,
      ], { windowsHide: true })
      this.startedAt = Date.now()
      this.proc.on('exit', () => { this.proc = null })
      this.proc.on('error', () => { this.proc = null })
      return { ok: true, message: '开始录制：操作（含滚轮）后按 F8 结束', outFile: this.outFile }
    } catch (e: any) {
      this.proc = null
      return { ok: false, message: `录制启动失败：${e?.message || e}` }
    }
  }

  /** 结束录制并读回事件 */
  async stop(): Promise<{ ok: boolean; events?: RawEvent[]; outFile?: string; durationMs?: number; message?: string }> {
    if (!this.proc || !this.outFile) {return { ok: false, message: '当前没有录制任务' }}
    const file = this.outFile
    const proc = this.proc
    this.proc = null
    return await new Promise(resolve => {
      const timer = setTimeout(() => {
        try {proc.kill()} catch { /* ignore */ }
      }, 3000)
      proc.on('exit', () => {
        clearTimeout(timer)
        let text = ''
        try {text = fs.readFileSync(file, 'utf-8')} catch { /* ignore */ }
        resolve({
          ok: true,
          events: parseEvents(text),
          outFile: file,
          durationMs: Date.now() - this.startedAt,
        })
      })
      // 用户可能没按 F8：直接关闭进程兜底
      try {proc.kill()} catch { /* ignore */ }
    })
  }
}

// ═══════════════════════════════════════════════════════════
// Lesson 存储（沉淀为技能）
// ═══════════════════════════════════════════════════════════

export class LessonStore {
  constructor(public readonly dir: string = teachDir()) {
    fs.mkdirSync(dir, { recursive: true })
  }

  private file(id: string): string {
    return path.join(this.dir, `${id.replace(/[^A-Za-z0-9_\-]/g, '_')}.json`)
  }

  save(input: {
    name: string
    description?: string
    events: RawEvent[]
    screenW: number
    screenH: number
    tags?: string[]
    id?: string
    aggregateTyping?: boolean
  }): Lesson {
    const id = input.id || `lesson_${Date.now().toString(36)}`
    const lesson: Lesson = {
      id,
      name: input.name,
      description: input.description || '',
      screenW: input.screenW,
      screenH: input.screenH,
      createdAt: Date.now(),
      tags: input.tags || [],
      aggregateTyping: !!input.aggregateTyping,
      events: input.events,
    }
    fs.writeFileSync(this.file(id), JSON.stringify(lesson, null, 2), 'utf-8')
    return lesson
  }

  get(id: string): Lesson | null {
    try {
      const f = this.file(id)
      if (!fs.existsSync(f)) {return null}
      return JSON.parse(fs.readFileSync(f, 'utf-8'))
    } catch {return null}
  }

  list(): Array<Omit<Lesson, 'events'> & { eventCount: number }> {
    type Item = Omit<Lesson, 'events'> & { eventCount: number }
    try {
      const items: Item[] = []
      for (const f of fs.readdirSync(this.dir)) {
        if (!(f.startsWith('lesson_') && f.endsWith('.json'))) {continue}
        try {
          const l = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf-8')) as Lesson
          const { events, ...meta } = l
          items.push({ ...meta, eventCount: events?.length || 0 })
        } catch { /* 跳过坏文件 */ }
      }
      return items.sort((a, b) => b.createdAt - a.createdAt)
    } catch {return []}
  }

  remove(id: string): boolean {
    try {
      const f = this.file(id)
      if (fs.existsSync(f)) {fs.rmSync(f); return true}
      return false
    } catch {return false}
  }
}

let _recorder: TeachRecorder | null = null
let _lessons: LessonStore | null = null
export function getTeachRecorder(): TeachRecorder {
  if (!_recorder) {_recorder = new TeachRecorder()}
  return _recorder
}
export function getLessonStore(): LessonStore {
  if (!_lessons) {_lessons = new LessonStore()}
  return _lessons
}
