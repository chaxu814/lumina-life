// ============================================================
// cuUia.ts — v3.31 Windows UI Automation 元素树（P2，同类工程实践）
//
// 同类项目在截图之外还给模型「可交互元素树」（名字/控件类型/位置），
// 点击不依赖坐标猜测。Lumina：
//   - PowerShell 加载 UIAutomationClient/UIAutomationTypes，
//     取前台窗口 FindAll(Descendants)，cap 200 个元素，输出 JSON；
//   - 元素索引缓存（每次扫描刷新），click_element/uia_set 走缓存中心坐标；
//   - v3.31 set_value 优先走 ValuePattern.SetValue（控件级直接赋值，
//     不经过键盘/剪贴板、不吃焦点时序），控件不支持时回退
//     「点击聚焦 → Ctrl+A → 粘贴」复合动作，可靠面更广。
//
// 纯函数（parseUiaJson / 元素中心归一化）可单测；PS 执行部分 best-effort。
// ============================================================

import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { execFile } from 'child_process'
import { axRoleToUiType, type AxElement } from '../../core/platform/macAccessibility'
import { pointRectToPixel, type CaptureGeometry } from '../../core/platform/macCoordinate'
import { getPlatformAdapter, type PlatformAdapter } from '../../core/platform'

export interface UiaElement {
  /** 本次扫描内的序号（0 起） */
  index: number
  name: string
  automationId: string
  /** 控件类型友好名（Button / Edit / TabItem…） */
  type: string
  /** 物理像素矩形（左上 + 宽高） */
  rect: { x: number; y: number; w: number; h: number }
  enabled: boolean
  focused: boolean
}

export interface NormalizedUiaElement extends UiaElement {
  /** 中心归一化坐标（按传入截图尺寸） */
  nx: number
  ny: number
}

// ═══════════════════════════════════════════════════════════
// 纯函数
// ═══════════════════════════════════════════════════════════

/** 把 PS 输出的 JSON 数组解析为 UiaElement（坏数据容错） */
export function parseUiaJson(raw: string, cap = 200): UiaElement[] {
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start < 0 || end <= start) {return []}
  let arr: any[]
  try {
    arr = JSON.parse(raw.slice(start, end + 1))
  } catch {return []}
  if (!Array.isArray(arr)) {return []}
  const out: UiaElement[] = []
  for (const item of arr.slice(0, cap)) {
    const r = item.r || {}
    const w = Number(r.w) || 0
    const h = Number(r.h) || 0
    // 零尺寸/离屏元素没什么可点的价值，过滤
    if (w < 2 || h < 2) {continue}
    const typeRaw = String(item.t || '')
      .replace(/^ControlType\./, '')
      .replace(/^Windows\.UI\.Xaml\.Automation\.Peers\./, '')
    out.push({
      index: out.length,
      name: String(item.n || '').slice(0, 120),
      automationId: String(item.a || '').slice(0, 120),
      type: typeRaw,
      rect: { x: Number(r.x) || 0, y: Number(r.y) || 0, w, h },
      enabled: item.e !== false && item.e !== 0,
      focused: !!item.f,
    })
  }
  return out
}

/** 元素中心 → 归一化坐标（0–100，与 cuGeometry.normToPx 约定一致） */
export function normalizeElements(els: UiaElement[], imgW: number, imgH: number, vx = 0, vy = 0): NormalizedUiaElement[] {
  return els.map(e => {
    const cx = e.rect.x + e.rect.w / 2 - vx
    const cy = e.rect.y + e.rect.h / 2 - vy
    return {
      ...e,
      nx: imgW > 0 ? Math.max(0, Math.min(100, (cx / imgW) * 100)) : 0,
      ny: imgH > 0 ? Math.max(0, Math.min(100, (cy / imgH) * 100)) : 0,
    }
  })
}

/** 元素列表渲染成给模型看的紧凑文本（坐标为 0–100 归一化） */
export function renderElementsText(els: NormalizedUiaElement[]): string {
  if (!els.length) {return '（前台窗口未识别到可交互元素）'}
  const lines = els.map(e => {
    const label = [e.name, e.automationId].filter(Boolean).join(' / ') || '(无名称)'
    return `[${e.index}] ${e.type} ${label} @(${e.nx.toFixed(1)},${e.ny.toFixed(1)})${e.focused ? ' *焦点*' : ''}${e.enabled ? '' : ' 禁用'}`
  })
  return ['前台窗口可交互元素（用 index 调用 desktop_element_act 的 click）：', ...lines].join('\n')
}

// ═══════════════════════════════════════════════════════════
// PowerShell 执行
// ═══════════════════════════════════════════════════════════

const UIA_PS = `# Lumina UIA scan (v3.30) — generated, do not edit
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$sig = @'
using System;
using System.Runtime.InteropServices;
public class LuminaUia {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@
Add-Type -TypeDefinition $sig -ErrorAction SilentlyContinue
try {
  [System.Windows.Automation.AutomationElement] | Out-Null
} catch {}
$hwnd = [LuminaUia]::GetForegroundWindow()
if ($hwnd -eq [IntPtr]::Zero) { Write-Output '[]'; exit 0 }
$root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
if ($null -eq $root) { Write-Output '[]'; exit 0 }
$cond = [System.Windows.Automation.Condition]::TrueCondition
$all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
$cap = 200
$out = New-Object System.Collections.ArrayList
for ($i = 0; $i -lt [Math]::Min($all.Count, $cap); $i++) {
  $el = $all.Item($i)
  $c = $el.Current
  $r = $c.BoundingRectangle
  $type = ''
  try { $type = $c.ControlType.ProgrammaticName } catch {}
  $obj = [ordered]@{
    n = $c.Name
    a = $c.AutomationId
    t = $type
    r = [ordered]@{ x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height }
    e = $c.IsEnabled
    f = $c.HasKeyboardFocus
  }
  [void]$out.Add($obj)
}
$json = $out | ConvertTo-Json -Depth 5 -Compress
if ($out.Count -eq 1) { $json = "[$json]" }
Write-Output $json
`

function ensureScript(): string {
  const base = app?.getPath ? app.getPath('userData') : process.cwd()
  const dir = path.join(base, 'scripts')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'cu-uia.ps1')
  if (!fs.existsSync(file)) {fs.writeFileSync(file, UIA_PS, 'utf-8')}
  return file
}

let _nonWinLogged = false

function runPS(): Promise<string> {
  return new Promise(resolve => {
    if (process.platform !== 'win32') {
      // 优雅降级：真正的 UIA 扫描仅 Windows。非 Windows 走 scanAxMac()（macOS AX）。
      if (!_nonWinLogged) {
        _nonWinLogged = true
        console.info('[cuUia] Windows UIA 仅在 win32 可用，当前平台(' + process.platform + ')不走 PS 扫描')
      }
      resolve('')
      return
    }
    execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', ensureScript(),
    ], { windowsHide: true, timeout: 20000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        console.warn('[cuUia] 扫描失败:', err.message, String(stderr).slice(0, 200))
        resolve('')
        return
      }
      resolve(String(stdout || ''))
    })
  })
}

// ═══════════════════════════════════════════════════════════
// v3.31：ValuePattern 控件级赋值（不经过键盘/剪贴板）
// ═══════════════════════════════════════════════════════════

const UIA_SET_PS = `# Lumina UIA set-value (v3.31) — generated, do not edit
param([int]$X, [int]$Y, [string]$Text)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
try {
  $pt = New-Object System.Windows.Point($X, $Y)
  $el = [System.Windows.Automation.AutomationElement]::FromPoint($pt)
  if ($null -eq $el) { Write-Output 'NOPATTERN:no-element'; exit 0 }
  $target = $null
  $cur = $el
  for ($i=0; $i -lt 4; $i++) {
    if ($null -eq $cur) { break }
    $ct = ''
    try { $ct = $cur.Current.ControlType.ProgrammaticName } catch {}
    if ($ct -eq 'ControlType.Edit' -or $ct -eq 'ControlType.Document' -or $ct -eq 'ControlType.ComboBox') { $target = $cur; break }
    $cur = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($cur)
  }
  if ($null -eq $target) { $target = $el }
  $vp = $null
  try { $vp = $target.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern) } catch {}
  if ($null -eq $vp) { Write-Output 'NOPATTERN:not-editable'; exit 0 }
  try {
    if ($vp.Current.IsReadOnly) { Write-Output 'NOPATTERN:readonly'; exit 0 }
    $vp.SetValue($Text)
    Write-Output 'OK'
  } catch {
    Write-Output ('NOPATTERN:' + ($_.Exception.Message -replace "[\\r\\n]",' '))
  }
} catch {
  Write-Output ('NOPATTERN:' + ($_.Exception.Message -replace "[\\r\\n]",' '))
}
`

function ensureSetScript(): string {
  const base = app?.getPath ? app.getPath('userData') : process.cwd()
  const dir = path.join(base, 'scripts')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'cu-uia-set.ps1')
  fs.writeFileSync(file, UIA_SET_PS, 'utf-8')
  return file
}

/**
 * 用 ValuePattern 在物理坐标处的输入框直接赋值。
 * 成功返回 ok=true；控件不支持（NOPATTERN:*）时 ok=false，调用方回退粘贴路径。
 */
export function setValueByPoint(
  physX: number, physY: number, text: string,
): Promise<{ ok: boolean; reason?: string }> {
  return new Promise(resolve => {
    if (process.platform !== 'win32') {
      // macOS / Linux 无 UIA ValuePattern。macOS 虽可经 AX 设值，但需原生 AXUIElementSetAttributeValue
      // （AppleScript 不支持），本版未实现——回退到调用方的「点击+全选+输入」复合路径。
      // 明确返回结构化原因，不静默。
      resolve({ ok: false, reason: process.platform === 'darwin' ? 'no-ax-valuepattern' : 'non-windows' })
      return
    }
    execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', ensureSetScript(),
      '-X', String(Math.round(physX)),
      '-Y', String(Math.round(physY)),
      '-Text', text,
    ], { windowsHide: true, timeout: 15000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = String(stdout || '').trim()
      if (out === 'OK') {resolve({ ok: true }); return}
      if (out.startsWith('NOPATTERN')) {resolve({ ok: false, reason: out }); return}
      resolve({ ok: false, reason: err ? err.message : String(stderr).slice(0, 160) || 'uia-set-failed' })
    })
  })
}

// ═══════════════════════════════════════════════════════════
// 扫描缓存（会话级）
// ═══════════════════════════════════════════════════════════

interface UiaSnapshot {
  at: number
  key: string
  elements: NormalizedUiaElement[]
}

class UiaCache {
  private snap: UiaSnapshot | null = null
  /** 扫描前台窗口，归一化到截图视图；视图参数变化时缓存失效 */
  async scan(imgW: number, imgH: number, vx = 0, vy = 0, maxAgeMs = 2000): Promise<NormalizedUiaElement[]> {
    const key = `${imgW}x${imgH}@${vx},${vy}`
    if (this.snap && key === this.snap.key && Date.now() - this.snap.at < maxAgeMs) {
      return this.snap.elements
    }
    // macOS：走 AX 扫描（AppleScript System Events），坐标 point→pixel 换算
    if (process.platform === 'darwin') {
      const els = await scanAxMac()
      const adapter = getPlatformAdapter()
      const toPixelRect = (r: { x: number; y: number; w: number; h: number }) => {
        try {
          const geo = (adapter as any).geometry as CaptureGeometry | undefined
          if (geo) {return pointRectToPixel(r, geo)}
        } catch { /* 拿不到几何则按 1:1 退化 */ }
        return r
      }
      const normalized = axToNormalized(els, imgW, imgH, vx, vy, toPixelRect)
      this.snap = { at: Date.now(), key, elements: normalized }
      return normalized
    }
    const raw = await runPS()
    const parsed = parseUiaJson(raw)
    const normalized = normalizeElements(parsed, imgW, imgH, vx, vy)
    this.snap = { at: Date.now(), key, elements: normalized }
    return normalized
  }
  get(index: number): NormalizedUiaElement | undefined {
    return this.snap?.elements.find(e => e.index === index)
  }
  clear(): void {this.snap = null}
}

/** 调 macOS AX 扫描（未实现/失败返回空数组，不抛异常） */
export async function scanAxMac(): Promise<AxElement[]> {
  try {
    const adapter = getPlatformAdapter() as PlatformAdapter & { scanAxElements?: (cap?: number) => Promise<AxElement[]> }
    if (typeof adapter.scanAxElements === 'function') {return await adapter.scanAxElements()}
    return []
  } catch (e: any) {
    console.warn('[cuUia] macOS AX 扫描失败（降级为空树）:', e?.message || e)
    return []
  }
}

let _cache: UiaCache | null = null
export function getUiaCache(): UiaCache {
  if (!_cache) {_cache = new UiaCache()}
  return _cache
}

// ═══════════════════════════════════════════════════════════
// v0.1 macOS 分支：AX（Accessibility）元素树
//
// Windows UIA 的 macOS 对应技术是 AX。这里把 MacAdapter 扫到的
// AxElement（单位 point）归一化成与 UIA 完全一致的 NormalizedUiaElement，
// 因此 renderElementsText / desktop_element_act / 元素缓存等上层
// **零改动**就能在 macOS 上跑。
//
// 坐标系：imgW/imgH 是本次截图的**像素**宽高，而 AX 矩形是**点**。
// 归一化时先做 point→pixel 换算（macCoordinate.pointToPixel），
// 否则在 Retina 上所有元素坐标会偏一半。
// ═══════════════════════════════════════════════════════════

/** point 坐标的 AX 元素 → 归一化坐标的 UIA 元素（纯函数，可单测） */
export function axToNormalized(
  els: AxElement[],
  imgW: number, imgH: number, vx = 0, vy = 0,
  toPixelRect?: (r: { x: number; y: number; w: number; h: number }) => { x: number; y: number; w: number; h: number },
): NormalizedUiaElement[] {
  const conv = toPixelRect ?? ((r: { x: number; y: number; w: number; h: number }) => r)
  return els.map(e => {
    // 整个矩形（含宽高）一起从 point 换到像素，避免中心点计算混用两套单位
    const p = conv(e.rect)
    const cx = p.x + p.w / 2 - vx
    const cy = p.y + p.h / 2 - vy
    return {
      index: e.index,
      name: e.name,
      automationId: '',
      type: axRoleToUiType(e.role),
      rect: { x: p.x, y: p.y, w: p.w, h: p.h },
      enabled: e.enabled,
      focused: e.focused,
      nx: imgW > 0 ? Math.max(0, Math.min(100, (cx / imgW) * 100)) : 0,
      ny: imgH > 0 ? Math.max(0, Math.min(100, (cy / imgH) * 100)) : 0,
    }
  })
}
