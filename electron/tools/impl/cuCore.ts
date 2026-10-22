// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// cuCore.ts — Computer Use 共享执行内核（两套 CU 的单一事实源）
//
// 统一收敛：
//   1. 视觉模型配置 getCuVlmConfig（设置 → 环境变量兜底）
//   2. 截屏 captureScreen（screenshot-desktop + PowerShell 回退，返回 b64/真实像素尺寸）
//   3. VLM 调用 callVisionModel（OpenAI 兼容、多模态）
//   4. 键鼠原语 cuClick / cuType / cuScroll / cuDrag / cuPressKey
//      —— Windows 走 PowerShell，输入走剪贴板（支持中文）
//   5. 统一动作执行 executeCuAction（归一化 0–100 坐标 → 像素，高危硬拦截）
//   6. 全局急停信号 requestCuAbort / isCuAborted（全局快捷键触发）
//
// agent 工具闭环 (tools/impl/computerUse.ts) 与 IPC 引擎 (electron/computerUse.ts)
// 都调用本模块，保证中文输入、拖拽、归一化坐标、急停与安全策略完全一致。
// ============================================================

import * as cp from 'child_process'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'
import * as https from 'https'
import * as http from 'http'
import { clipboard, screen } from 'electron'
import screenshot from 'screenshot-desktop'
import { getAgentConfig } from '../../agentConfig'
import { normToPx, pngDimensions } from './cuGeometry'
import { destructiveReason } from './cuSafety'
import {
  gateCuAction, getCuPolicy, expectsVisualChange,
} from './cuPermissions'
import { humanClick, humanHover, humanDrag } from './humanMouse'
import { computeDhashFromImage, verifyChange } from './cuVerify'
import { classifyModelError, describeLimitation, looksLikeVisionModel, isLocalEndpoint } from '../../core/modelCompat'
import { getPlatformAdapter } from '../../core/platform'

// 安全策略对外仍可从 cuCore 引用
export { destructiveReason, isDestructive } from './cuSafety'

// 组合键 → SendKeys 记号（纯函数，抽到 cuKeyTokens 供 WindowsAdapter 共用，避免循环依赖）
export { buildSendKeysToken, SENDKEY_NAMED } from './cuKeyTokens'

// ──────────────────────────────────────────────────────────
// 0. 类型
// ──────────────────────────────────────────────────────────

/** 统一动作（坐标一律以归一化 0–100 为首选，像素 x/y 仅作兼容回退） */
export interface CuAction {
  action_type: string
  /** 归一化 0–100 */
  nx?: number; ny?: number; nx2?: number; ny2?: number
  /** 像素坐标（兼容） */
  x?: number; y?: number; drag_end_x?: number; drag_end_y?: number
  text?: string
  scroll_amount?: number
  wait_seconds?: number
  key?: string
  /** open_app 目标应用名（也兼容 text） */
  app?: string
}

export interface CuView {
  /** 当前模型所见画面的真实像素尺寸（归一化坐标据此换算） */
  imgW: number
  imgH: number
  /** v3.30 多显示器：虚拟桌面左上角物理像素偏移（默认 0/0） */
  vx?: number
  vy?: number
}

export interface CuExecResult {
  ok: boolean
  msg: string
  /** 命中高危硬拦截 */
  denied?: boolean
  /** v3.30 拒绝类别（gate=权限门，hard=高危命令，policy=策略） */
  denyReason?: 'gate' | 'hard' | 'policy'
  /** v3.33 观察员（CU 三人组）：是否跑了 dHash 验证、画面是否变化（未验证为 undefined） */
  verified?: boolean
  changed?: boolean
}

export interface CuScreen {
  buffer: Buffer
  b64: string
  w: number
  h: number
  /** v3.30 虚拟桌面左上角物理像素偏移（多显示器时可能为负） */
  vx: number
  vy: number
}

// ──────────────────────────────────────────────────────────
// 1. 视觉模型配置
// ──────────────────────────────────────────────────────────

export function getCuVlmConfig(): { url: string; key: string; model: string } {
  const envUrl = process.env.LUMINA_VLM_BASE_URL
  const envKey = process.env.LUMINA_VLM_API_KEY || process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || ''
  const envModel = process.env.LUMINA_VLM_MODEL
  if (envUrl && envKey) {
    return { url: envUrl.replace(/\/+$/, ''), key: envKey, model: envModel || process.env.LLM_MODEL || 'gpt-4o' }
  }
  try {
    const cfg = getAgentConfig()
    if (cfg.isConfigured('lumina')) {
      const lumina = cfg.get('lumina')
      if (lumina && lumina.endpoint && lumina.apiKey) {
        return {
          url: String(lumina.endpoint).replace(/\/+$/, ''),
          key: lumina.apiKey,
          model: envModel || lumina.model || 'gpt-4o',
        }
      }
    }
  } catch { /* 配置模块在测试 / 特殊环境不可用，降级 */ }
  return {
    url: (process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    key: process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '',
    model: process.env.LLM_MODEL || 'gpt-4o',
  }
}

// ──────────────────────────────────────────────────────────
// 2. VLM 调用
// ──────────────────────────────────────────────────────────

export function callVisionModel(sys: string, usr: string, b64: string, jsonMode = false, mime = 'image/png'): Promise<string> {
  const cfg = getCuVlmConfig()
  const u = new URL(cfg.url + '/chat/completions')
  const t = u.protocol === 'https:' ? https : http

  const userContent: any[] = [{ type: 'text', text: usr }]
  // 仅在确实提供截图时附带图像；空 b64 时走纯文本（否则部分服务端会因空 data URL 报错）
  if (b64) {
    userContent.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${b64}`, detail: 'high' } })
  }

  const bodyObj: any = {
    model: cfg.model,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: userContent },
    ],
    max_tokens: 1024,
    temperature: 0.3,
  }
  if (jsonMode) {bodyObj.response_format = { type: 'json_object' }}
  // 软提示：本地端点 + 模型名不像 VLM（不硬拦，避免误伤自命名的视觉模型；失败时再给明确提示）
  if (isLocalEndpoint(cfg.url) && !looksLikeVisionModel(cfg.model)) {
    console.warn(`[CU] 视觉端点模型「${cfg.model}」从命名看不像视觉模型，若看屏/识图失败，请换 Qwen2.5-VL / GPT-4o / GLM-4V 等 VLM`)
  }

  /** 发一次请求；bodyStr 已序列化，便于降级重试时换一份 body */
  const doRequest = (bodyStr: string): Promise<string> => new Promise<string>((resolve, reject) => {
    const r = t.request({
      hostname: u.hostname, port: u.port || (t === https ? 443 : 80),
      path: u.pathname, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cfg.key}`,
        'Content-Length': String(Buffer.byteLength(bodyStr)),
      },
      timeout: 30000,
    }, res => {
      let d = ''
      res.on('data', c => d += c)
      res.on('end', () => {
        const code = res.statusCode || 0
        const visionHint = () => describeLimitation('vision', cfg.model)
        try {
          const j = JSON.parse(d)
          if (j.error) {
            const msg = String(j.error.message || j.error || 'vlm_err')
            const kind = classifyModelError(code, msg + ' ' + d)
            // 纯文本模型收到图片 → 给出明确的换模型提示，而不是一坨 400
            if (kind === 'vision' || kind === 'tools') {return reject(new Error(visionHint()))}
            return reject(new Error(msg))
          }
          if (code >= 400) {
            const kind = classifyModelError(code, d)
            if (kind === 'vision' || kind === 'tools') {return reject(new Error(visionHint()))}
            return reject(new Error(`vlm_http_${code}:${d.slice(0, 200)}`))
          }
          resolve(j.choices?.[0]?.message?.content || '')
        } catch {
          // 非 JSON 错误页（网关 HTML 等）：本地且模型不像 VLM 时给视觉提示
          if (code >= 400 && isLocalEndpoint(cfg.url) && !looksLikeVisionModel(cfg.model)) {
            return reject(new Error(visionHint()))
          }
          reject(new Error(`vlm_parse:${d.slice(0, 200)}`))
        }
      })
    })
    r.on('error', reject)
    r.on('timeout', () => { r.destroy(); reject(new Error('vlm_timeout')) })
    r.write(bodyStr)
    r.end()
  })

  const body = JSON.stringify(bodyObj)

  return doRequest(body).catch(err => {
    // 🐛 2026-10-10 修复（dev 控制台实测）：
    //   `response_format.type = 'json_object'` **并非所有 OpenAI 兼容服务端都支持**。
    //   实测 LM Studio 直接 400：
    //     `'response_format.type' must be 'json_schema' or 'text'`
    //   → 视觉理解**每次都失败**（截图白拍，只留下一条 warning）。
    //   这里在「明确因 response_format 被拒」时去掉该字段重试一次：
    //   系统提示里本来就要求「只输出 JSON」，且解析侧（parseVision）能容忍额外文字，
    //   所以降级是安全的；支持严格模式的端点仍走第一次请求，行为不变。
    const msg = String((err as Error)?.message || err)
    if (jsonMode && /response_format|json_schema|json_object/i.test(msg)) {
      console.warn('[CU] 服务端不支持 response_format=json_object，已去掉该字段重试（结果解析不变）')
      const retryBodyObj: any = { ...bodyObj }
      delete retryBodyObj.response_format
      return doRequest(JSON.stringify(retryBodyObj))
    }
    throw err
  })
}

// ──────────────────────────────────────────────────────────
// 3. 截屏（Buffer；失败回退 PowerShell）
// ──────────────────────────────────────────────────────────

function screenshotFallbackPS(pngPath: string): Promise<string> {
  const psCmd = [
    'Add-Type -AssemblyName System.Windows.Forms,System.Drawing;',
    '$s=[System.Windows.Forms.Screen]::PrimaryScreen;',
    `$b=New-Object System.Drawing.Bitmap($s.Bounds.Width,$s.Bounds.Height);`,
    '$g=[System.Drawing.Graphics]::FromImage($b);',
    '$g.CopyFromScreen($s.Bounds.X,$s.Bounds.Y,0,0,$s.Bounds.Size);',
    `$b.Save('${pngPath.replace(/\\/g, '\\\\')}',[System.Drawing.Imaging.ImageFormat]::Png);`,
    '$g.Dispose();$b.Dispose();',
  ].join(' ')
  const psB64 = Buffer.from(psCmd, 'utf16le').toString('base64')
  return new Promise<string>((resolve, reject) => {
    cp.execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', psB64],
      { timeout: 8000, windowsHide: true },
      (err) => {
        if (err) { try { fs.unlinkSync(pngPath) } catch {}; reject(new Error(`screenshot_fallback:${err.code || 'unknown'}`)); return }
        try { if (fs.statSync(pngPath).size > 0) {resolve(pngPath);} else {reject(new Error('screenshot_fallback:empty'))} }
        catch (e: any) { reject(new Error(`screenshot_fallback:${e.message}`)) }
      })
  })
}

/** v3.30 PowerShell 截取整个虚拟桌面（所有显示器），输出 PNG 路径 */
function virtualScreenCapturePS(pngPath: string): Promise<string> {
  const psCmd = [
    'Add-Type -AssemblyName System.Windows.Forms,System.Drawing;',
    '$vs=[System.Windows.Forms.SystemInformation]::VirtualScreen;',
    '$b=New-Object System.Drawing.Bitmap($vs.Width,$vs.Height);',
    '$g=[System.Drawing.Graphics]::FromImage($b);',
    '$g.CopyFromScreen($vs.X,$vs.Y,0,0,$vs.Size);',
    `$b.Save('${pngPath.replace(/\\/g, '\\\\')}',[System.Drawing.Imaging.ImageFormat]::Png);`,
    '$g.Dispose();$b.Dispose();',
  ].join(' ')
  const psB64 = Buffer.from(psCmd, 'utf16le').toString('base64')
  return new Promise<string>((resolve, reject) => {
    cp.execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', psB64],
      { timeout: 10000, windowsHide: true },
      (err) => {
        if (err) { try { fs.unlinkSync(pngPath) } catch {}; reject(new Error(`virtual_capture:${err.code || 'unknown'}`)); return }
        try { if (fs.statSync(pngPath).size > 0) {resolve(pngPath)} else {reject(new Error('virtual_capture:empty'))} }
        catch (e: any) { reject(new Error(`virtual_capture:${e.message}`)) }
      })
  })
}

/**
 * v3.30 隐私遮罩：把非前台窗口区域涂黑后再返回模型。
 * 进程 DPI 置为 aware，矩形坐标与物理像素截图对齐。best-effort，失败返回原图。
 */
async function applyPrivacyMask(src: Buffer): Promise<Buffer> {
  if (process.platform !== 'win32') {return src}
  const inP = path.join(os.tmpdir(), `lu-mask-in-${Date.now()}.png`)
  const outP = path.join(os.tmpdir(), `lu-mask-out-${Date.now()}.png`)
  const ps = [
    'Add-Type @"',
    'using System;using System.Runtime.InteropServices;using System.Text;',
    'public class W{',
    '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
    '[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);',
    '[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);',
    '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);',
    '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();',
    'public delegate bool EnumProc(IntPtr h, IntPtr l);',
    '[StructLayout(LayoutKind.Sequential)] public struct R { public int L, T, Rr, B; }',
    '}',
    '"@',
    '[W]::SetProcessDPIAware() | Out-Null',
    `$b=[System.Drawing.Image]::FromFile('${inP.replace(/\\/g, '\\\\')}')`,
    '$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height',
    '$g=[System.Drawing.Graphics]::FromImage($bmp)',
    '$g.DrawImage($b,0,0)',
    '$fg=[W]::GetForegroundWindow()',
    '$brush=New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::Black)',
    '$rects=New-Object System.Collections.ArrayList',
    '$cb=[W+EnumProc]{ param($h,$l) ',
    '  if ([W]::IsWindowVisible($h) -and $h -ne $fg) {',
    '    $r=New-Object W+R; if ([W]::GetWindowRect($h,[ref]$r)) {',
    '      $w=$r.Rr-$r.L; $hh=$r.B-$r.T; if ($w -gt 200 -and $hh -gt 120) { [void]$rects.Add(@($r.L,$r.T,$w,$hh)) } } }',
    '  return $true }',
    '[W]::EnumWindows($cb,[IntPtr]::Zero) | Out-Null',
    'foreach ($x in $rects) { $g.FillRectangle($brush, $x[0], $x[1], $x[2], $x[3]) }',
    `$bmp.Save('${outP.replace(/\\/g, '\\\\')}',[System.Drawing.Imaging.ImageFormat]::Png)`,
    '$g.Dispose();$bmp.Dispose();$b.Dispose();',
  ]
  try {
    fs.writeFileSync(inP, src)
    const out = await runPS(ps, 12000)
    if (out.startsWith('ERR:')) {return src}
    if (fs.existsSync(outP) && fs.statSync(outP).size > 0) {
      return fs.readFileSync(outP)
    }
    return src
  } catch {
    return src
  } finally {
    try { fs.unlinkSync(inP) } catch { /* ignore */ }
    try { fs.unlinkSync(outP) } catch { /* ignore */ }
  }
}

/** 计算虚拟桌面（所有显示器）相对主屏幕的物理像素边界 */
export function virtualDesktopBounds(): { x: number; y: number; w: number; h: number } {
  try {
    let x = 0, y = 0, r = 0, b = 0
    for (const d of screen.getAllDisplays()) {
      const sf = d.scaleFactor || 1
      const bx = Math.round(d.bounds.x * sf)
      const by = Math.round(d.bounds.y * sf)
      const bw = Math.round(d.bounds.width * sf)
      const bh = Math.round(d.bounds.height * sf)
      x = Math.min(x, bx); y = Math.min(y, by)
      r = Math.max(r, bx + bw); b = Math.max(b, by + bh)
    }
    return { x, y, w: r - x, h: b - y }
  } catch {
    return { x: 0, y: 0, w: 0, h: 0 }
  }
}

export async function captureScreenBuffer(): Promise<Buffer> {
  const policy = getCuPolicy()
  // 非 Windows：走平台适配器（macOS screencapture / Linux grim·scrot）。
  // Windows 仍优先 screenshot-desktop + PowerShell 虚拟桌面（性能更好、行为不变）。
  if (process.platform !== 'win32') {
    try {
      const { buffer } = await getPlatformAdapter().screenshot()
      if (buffer && buffer.length > 0) {return buffer}
    } catch (e: any) {
      console.warn('[cuCore] 适配器截屏失败，回退 screenshot-desktop:', e?.message || e)
    }
  }
  // v3.30 多显示器：PowerShell 直接截虚拟桌面（screenshot-desktop 只截主屏）
  if (policy.multiMonitor && process.platform === 'win32') {
    try {
      const p = path.join(os.tmpdir(), `lu-vsc-${Date.now()}.png`)
      await virtualScreenCapturePS(p)
      const buf = fs.readFileSync(p)
      try { fs.unlinkSync(p) } catch {}
      if (buf.length > 0) {return buf}
    } catch (e: any) {
      console.warn('[cuCore] 虚拟桌面截图失败，回退主屏:', e?.message || e)
    }
  }
  try {
    // screenshot-desktop 不传 filename 时直接返回 PNG Buffer
    const buf = await screenshot({ format: 'png' }) as unknown as Buffer
    if (buf && buf.length > 0) {return buf}
    throw new Error('empty_capture')
  } catch (e: any) {
    // PowerShell 截图回退仅在 Windows 存在 powershell 可执行文件；
    // 非 Windows 此处只应作为「适配器截屏已失败」后的兜底，绝不能再去 exec powershell（mac/Linux 无此二进制，会抛晦涩 ENOENT）。
    if (process.platform !== 'win32') {
      throw new Error(`截屏失败：当前平台(${process.platform})适配器与 screenshot-desktop 均不可用。${e?.message || e}`)
    }
    console.warn('[cuCore] screenshot-desktop failed, fallback PowerShell:', e?.message || e)
    const p = path.join(os.tmpdir(), `lu-sc-${Date.now()}.png`)
    await screenshotFallbackPS(p)
    const buf = fs.readFileSync(p)
    try { fs.unlinkSync(p) } catch {}
    return buf
  }
}

/** 截屏并解析真实像素尺寸 + base64（坐标映射以此为准）。opts 当前仅用于调用方语义统一，截图本身不区分会话 */
export async function captureScreen(_opts?: { sessionId?: string }): Promise<CuScreen> {
  const policy = getCuPolicy()
  let buffer = await captureScreenBuffer()
  // v3.30 隐私遮罩（非前台窗口涂黑）
  if (policy.maskBackgroundWindows && process.platform === 'win32') {
    try { buffer = await applyPrivacyMask(buffer) } catch { /* 遮罩失败返回原图 */ }
  }
  const dims = pngDimensions(buffer)
  let w = dims?.w || 0
  let h = dims?.h || 0
  let vx = 0, vy = 0
  if (policy.multiMonitor) {
    const vb = virtualDesktopBounds()
    if (vb.w > 0 && vb.h > 0) { vx = vb.x; vy = vb.y; w = vb.w; h = vb.h }
  }
  if (!w || !h) {
    try {
      const d = screen.getPrimaryDisplay()
      w = Math.round(d.size.width * d.scaleFactor)
      h = Math.round(d.size.height * d.scaleFactor)
    } catch { /* 保持 0，坐标回退像素模式 */ }
  }
  return { buffer, b64: buffer.toString('base64'), w, h, vx, vy }
}

// ──────────────────────────────────────────────────────────
// 4. 命令执行辅助
// ──────────────────────────────────────────────────────────
// 注：早期的本地 execCmd 已删除——键鼠/打开应用全部委托 PlatformAdapter，
// 跨平台统一的 execCmd 见 electron/core/platform/PlatformAdapter.ts。
// 本文件仅剩 Windows 专用的 runPS（仅被 applyPrivacyMask 调用，win32 门控）。

function runPS(lines: string[], timeout = 15000): Promise<string> {
  const ps1 = path.join(os.tmpdir(), `lu-ps-${Date.now()}-${Math.round(Math.random() * 1e6)}.ps1`)
  return new Promise<string>(resolve => {
    try { fs.writeFileSync(ps1, lines.join('\n'), 'utf-8') } catch (e: any) {
      return resolve(`ERR:ps1_write:${e.message}`)
    }
    cp.execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1],
      { timeout, windowsHide: true },
      (err, stdout, stderr) => {
        try { fs.unlinkSync(ps1) } catch {}
        if (err) {resolve(`ERR:${err.message}|${String(stderr).slice(0, 100)}`)}
        else {resolve(String(stdout).trim())}
      })
  })
}

// ──────────────────────────────────────────────────────────
// 5. 键鼠原语
// ──────────────────────────────────────────────────────────

export async function cuClick(x: number, y: number, btn: 'left' | 'right', dbl: boolean): Promise<string> {
  // 拟人化移动：缓动+随机抖动+点击前停顿；instant 模式退回原瞬移
  return humanClick(getPlatformAdapter(), x, y, btn, dbl)
}

/** v3.30 悬停（只移动光标不点击，用于展开 hover 菜单/工具提示） */
export async function cuHover(x: number, y: number, holdMs = 400): Promise<string> {
  return humanHover(getPlatformAdapter(), x, y, holdMs)
}

/** v3.30 长按（左键按下保持，默认 800ms，用于右键/长按手势/拖拽排序） */
export async function cuLongPress(x: number, y: number, holdMs = 800): Promise<string> {
  return getPlatformAdapter().mouseLongPress(x, y, holdMs)
}

/** 键盘输入文本：Windows 走剪贴板粘贴（支持中文/长文本），并备份恢复原剪贴板 */
export async function cuType(text: string): Promise<string> {
  return getPlatformAdapter().keyboardType(text)
}

/** 单个按键 / 组合键（enter、esc、tab、ctrl_c、ctrl_v、alt_f4、ctrl_shift_a…） */
export async function cuPressKey(key: string): Promise<string> {
  return getPlatformAdapter().keyPress(key)
}

/** 打开应用（按名称或路径） */
export async function cuOpenApp(app: string): Promise<string> {
  const name = (app || '').trim()
  if (!name) {return '打开应用失败:空名称'}
  try {
    return await getPlatformAdapter().openApp(name)
  } catch (e: any) {
    return `打开应用失败:${e?.message || e}`
  }
}

/** 写入系统剪贴板（仅写入，不粘贴） */
export function cuSetClipboard(text: string): string {
  try { clipboard.writeText(text ?? ''); return '已写入剪贴板' }
  catch (e: any) { return `写剪贴板失败:${e?.message || e}` }
}

export async function cuScroll(amount: number): Promise<string> {
  return getPlatformAdapter().mouseScroll(amount)
}

export async function cuDrag(x1: number, y1: number, x2: number, y2: number): Promise<string> {
  return humanDrag(getPlatformAdapter(), x1, y1, x2, y2)
}

// ──────────────────────────────────────────────────────────
// 6. 高危动作硬拦截 —— 判定在 ./cuSafety（destructiveReason），于 executeCuAction 内调用
// ──────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────
// 7. 统一动作执行（归一化坐标 → 像素 → 原语）
//    v3.20: 外层 executeCuAction 套「权限门 + 动作后验证」，
//    本函数是不做门禁的原始执行（保留导出，供门禁用 / 测试）。
// ──────────────────────────────────────────────────────────

export async function executeCuActionRaw(act: CuAction, view: CuView): Promise<CuExecResult> {
  const vx = view.vx || 0, vy = view.vy || 0
  const toPxX = (n?: number, px?: number): number =>
    typeof n === 'number' && Number.isFinite(n)
      ? normToPx(n, view.imgW) + vx
      : Math.round(Number(px) || 0)
  const toPxY = (n?: number, px?: number): number =>
    typeof n === 'number' && Number.isFinite(n)
      ? normToPx(n, view.imgH) + vy
      : Math.round(Number(px) || 0)
  const hasNorm = (a: CuAction) => typeof a.nx === 'number' && typeof a.ny === 'number'
  const hasPx = (a: CuAction) => typeof a.x === 'number' && typeof a.y === 'number'

  switch (act.action_type) {
    case 'click':
    case 'double_click':
    case 'right_click': {
      if (!hasNorm(act) && !hasPx(act)) {return { ok: false, msg: '❌ 缺少坐标' }}
      const btn = act.action_type === 'right_click' ? 'right' as const : 'left' as const
      const dbl = act.action_type === 'double_click'
      const msg = await cuClick(toPxX(act.nx, act.x), toPxY(act.ny, act.y), btn, dbl)
      return { ok: !msg.startsWith('❌') && !msg.startsWith('点击失败'), msg }
    }
    // v3.30 悬停：移动光标并短暂停留（hover 菜单 / tooltip）
    case 'hover':
    case 'mouse_move': {
      if (!hasNorm(act) && !hasPx(act)) {return { ok: false, msg: '❌ 缺少坐标' }}
      const msg = await cuHover(toPxX(act.nx, act.x), toPxY(act.ny, act.y),
        Math.max(100, Math.min(3000, Number(act.wait_seconds) ? Number(act.wait_seconds) * 1000 : 400)))
      return { ok: !msg.startsWith('❌') && !msg.includes('失败'), msg }
    }
    // v3.30 长按：左键按下保持（默认 800ms，可用 hold_seconds 覆盖）
    case 'long_press': {
      if (!hasNorm(act) && !hasPx(act)) {return { ok: false, msg: '❌ 缺少坐标' }}
      const hold = Math.max(150, Math.min(5000, Number(act.wait_seconds) ? Number(act.wait_seconds) * 1000 : 800))
      const msg = await cuLongPress(toPxX(act.nx, act.x), toPxY(act.ny, act.y), hold)
      return { ok: !msg.startsWith('❌') && !msg.includes('失败'), msg }
    }
    // v3.30 文本选择：从起点拖到终点（文本选择手势）
    case 'select_text': {
      const endNorm = typeof act.nx2 === 'number' && typeof act.ny2 === 'number'
      const endPx = typeof act.drag_end_x === 'number' && typeof act.drag_end_y === 'number'
      if ((!hasNorm(act) && !hasPx(act)) || (!endNorm && !endPx)) {return { ok: false, msg: '❌ 缺少选择起点/终点坐标' }}
      const msg = await cuDrag(
        toPxX(act.nx, act.x), toPxY(act.ny, act.y),
        toPxX(act.nx2, act.drag_end_x), toPxY(act.ny2, act.drag_end_y),
      )
      return { ok: !msg.includes('失败'), msg: msg.includes('拖拽完成') ? '文本选择完成' : msg }
    }
    // v3.30 给输入框赋值：点击聚焦 → 全选 → 替换输入
    case 'set_value': {
      if (!hasNorm(act) && !hasPx(act)) {return { ok: false, msg: '❌ 缺少输入框坐标' }}
      if (!act.text) {return { ok: false, msg: '❌ 缺少文本' }}
      const deny = destructiveReason(act.text)
      if (deny) {return { ok: false, msg: `🚫 ${deny}`, denied: true, denyReason: 'hard' }}
      const clickMsg = await cuClick(toPxX(act.nx, act.x), toPxY(act.ny, act.y), 'left', false)
      if (clickMsg.includes('失败')) {return { ok: false, msg: clickMsg }}
      await new Promise(r => setTimeout(r, 140))
      const sel = await cuPressKey('ctrl_a')
      await new Promise(r => setTimeout(r, 60))
      const typeMsg = await cuType(act.text)
      const ok = !sel.includes('失败') && !typeMsg.includes('失败')
      return { ok, msg: ok ? `赋值完成（${act.text.slice(0, 20)}${act.text.length > 20 ? '…' : ''}）` : `${sel}；${typeMsg}` }
    }
    case 'type': {
      if (!act.text) {return { ok: false, msg: '❌ 缺少输入文本' }}
      const deny = destructiveReason(act.text)
      if (deny) {return { ok: false, msg: `🚫 ${deny}`, denied: true, denyReason: 'hard' }}
      const msg = await cuType(act.text)
      return { ok: !msg.startsWith('❌') && !msg.startsWith('输入失败'), msg }
    }
    case 'keypress':
    case 'key': {
      if (!act.key) {return { ok: false, msg: '❌ 缺少按键' }}
      const deny = destructiveReason(act.key)
      if (deny) {return { ok: false, msg: `🚫 ${deny}`, denied: true, denyReason: 'hard' }}
      const msg = await cuPressKey(act.key)
      return { ok: !msg.startsWith('❌') && !msg.startsWith('按键失败'), msg }
    }
    case 'scroll': {
      const msg = await cuScroll(act.scroll_amount || 3)
      return { ok: !msg.startsWith('❌') && !msg.startsWith('滚动失败'), msg }
    }
    case 'drag': {
      const endNorm = typeof act.nx2 === 'number' && typeof act.ny2 === 'number'
      const endPx = typeof act.drag_end_x === 'number' && typeof act.drag_end_y === 'number'
      if ((!hasNorm(act) && !hasPx(act)) || (!endNorm && !endPx)) {return { ok: false, msg: '❌ 缺少拖拽坐标' }}
      const msg = await cuDrag(
        toPxX(act.nx, act.x), toPxY(act.ny, act.y),
        toPxX(act.nx2, act.drag_end_x), toPxY(act.ny2, act.drag_end_y),
      )
      return { ok: !msg.startsWith('❌') && !msg.startsWith('拖拽失败'), msg }
    }
    case 'wait': {
      const sec = Math.max(0, Math.min(60, Number(act.wait_seconds) || 1))
      await new Promise(r => setTimeout(r, sec * 1000))
      return { ok: true, msg: `等待 ${sec} 秒` }
    }
    case 'open_app': {
      const name = (act.app || act.text || '').trim()
      if (!name) {return { ok: false, msg: '❌ 缺少应用名' }}
      const msg = await cuOpenApp(name)
      return { ok: !/失败|ERR:/i.test(msg), msg }
    }
    case 'close_window': {
      const msg = await cuPressKey('alt_f4')
      return { ok: !msg.startsWith('❌') && !msg.startsWith('按键失败'), msg }
    }
    case 'clipboard': {
      if (!act.text) {return { ok: false, msg: '❌ 缺少剪贴板文本' }}
      const msg = cuSetClipboard(act.text)
      return { ok: !msg.startsWith('写剪贴板失败'), msg }
    }
    default:
      return { ok: false, msg: `❓ 未知操作类型: ${act.action_type}` }
  }
}

/**
 * 统一动作执行（v3.20 起带权限门 + 动作后验证）。
 *
 * ① 权限门：会话锁 → 前台应用探测 → 白名单/分区/系统键决策（见 cuPermissions）
 * ② 动作后验证：点击/拖拽类动作前后截图算 dHash，无变化则提示重新观察（见 cuVerify）
 *
 * 门禁任何异常 fail-open（放行并告警），保证不会因探测故障把用户卡死。
 *
 * @param opts.sessionId 操控者会话标识（agent 批次 / 引擎任务），用于会话锁
 */
export async function executeCuAction(
  act: CuAction,
  view: CuView,
  opts?: { sessionId?: string | null },
): Promise<CuExecResult> {
  resetCuAbort()

  // ⓪ 平台能力门：当前平台/会话不支持桌面操控时，返回明确错误（含平台与原因），不抛异常。
  // Windows 上 mouse/keyboard 恒为 true，此处不改变任何既有行为。
  {
    const cap = getPlatformAdapter().capabilities
    const NEEDS_MOUSE = new Set([
      'click', 'double_click', 'right_click', 'hover', 'mouse_move', 'long_press',
      'drag', 'select_text', 'set_value', 'scroll',
    ])
    const NEEDS_KEYBOARD = new Set(['type', 'keypress', 'key', 'set_value', 'close_window'])
    const NEEDS_OPENAPP = new Set(['open_app'])
    const needMouse = NEEDS_MOUSE.has(act.action_type)
    const needKeyboard = NEEDS_KEYBOARD.has(act.action_type)
    const needOpenApp = NEEDS_OPENAPP.has(act.action_type)
    if ((needMouse && !cap.mouse)
      || (needKeyboard && !cap.keyboard)
      || (needOpenApp && !cap.openApp)) {
      const reason = cap.notes.join('；') || '当前平台不支持该桌面操控能力'
      return {
        ok: false,
        msg: `❌ 当前平台(${cap.platform})不支持「${act.action_type}」：${reason}`,
        denied: true,
        denyReason: 'policy',
      }
    }
  }

  // ① 权限门
  try {
    const gate = await gateCuAction(act, { sessionId: opts?.sessionId ?? null })
    if (!gate.allow) {
      return { ok: false, msg: `🚫 ${gate.reason || '权限门拒绝该动作'}`, denied: true, denyReason: 'gate' }
    }
  } catch (e: any) {
    console.warn('[cuCore] 权限门异常（放行）:', e?.message || e)
  }

  // ② 动作前 dHash（仅对预期改变画面的动作）
  const policy = getCuPolicy()
  const doVerify = policy.enabled && policy.verifyAfterAction && expectsVisualChange(act)
  let beforeHash: boolean[] | null = null
  if (doVerify) {
    try {
      beforeHash = computeDhashFromImage(await captureScreenBuffer())
    } catch { /* 验证失败不阻塞动作 */ }
  }

  const result = await executeCuActionRaw(act, view)

  // ② 动作后验证：无变化时把提示追加到成功消息后（不判失败，让 agent 自行决定重看）
  if (doVerify && beforeHash && result.ok && !result.denied) {
    try {
      // 给 UI 一点响应时间（弹窗/高亮/页面切换）
      await new Promise(r => setTimeout(r, 260))
      const afterHash = computeDhashFromImage(await captureScreenBuffer())
      const vr = verifyChange(beforeHash, afterHash, policy.noChangeThreshold)
      result.verified = true
      result.changed = vr.changed
      if (!vr.changed) {
        result.msg = `${result.msg}\n${vr.hint}`
      }
    } catch { /* 验证失败忽略 */ }
  }

  return result
}

// ──────────────────────────────────────────────────────────
// 8. 全局急停信号（桌面操控是单鼠标单例资源，全局急停合理）
// ──────────────────────────────────────────────────────────

let _cuAborted = false
/** 一次新的操控运行开始时调用，清除上一次急停 */
export function resetCuAbort(): void { _cuAborted = false }
/** 全局快捷键 / 停止按钮触发 */
export function requestCuAbort(): void { _cuAborted = true }
export function isCuAborted(): boolean { return _cuAborted }
