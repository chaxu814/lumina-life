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
import { classifyModelError, describeLimitation, looksLikeVisionModel, isLocalEndpoint } from '../../core/modelCompat'

// 安全策略对外仍可从 cuCore 引用
export { destructiveReason, isDestructive } from './cuSafety'

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
}

export interface CuExecResult {
  ok: boolean
  msg: string
  /** 命中高危硬拦截 */
  denied?: boolean
}

export interface CuScreen {
  buffer: Buffer
  b64: string
  w: number
  h: number
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

  const bodyObj: any = {
    model: cfg.model,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: [
        { type: 'text', text: usr },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}`, detail: 'high' } },
      ] },
    ],
    max_tokens: 1024,
    temperature: 0.3,
  }
  if (jsonMode) bodyObj.response_format = { type: 'json_object' }
  // 软提示：本地端点 + 模型名不像 VLM（不硬拦，避免误伤自命名的视觉模型；失败时再给明确提示）
  if (isLocalEndpoint(cfg.url) && !looksLikeVisionModel(cfg.model)) {
    console.warn(`[CU] 视觉端点模型「${cfg.model}」从命名看不像视觉模型，若看屏/识图失败，请换 Qwen2.5-VL / GPT-4o / GLM-4V 等 VLM`)
  }
  const body = JSON.stringify(bodyObj)

  return new Promise<string>((resolve, reject) => {
    const r = t.request({
      hostname: u.hostname, port: u.port || (t === https ? 443 : 80),
      path: u.pathname, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cfg.key}`,
        'Content-Length': String(Buffer.byteLength(body)),
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
            if (kind === 'vision' || kind === 'tools') return reject(new Error(visionHint()))
            return reject(new Error(msg))
          }
          if (code >= 400) {
            const kind = classifyModelError(code, d)
            if (kind === 'vision' || kind === 'tools') return reject(new Error(visionHint()))
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
    r.write(body)
    r.end()
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
        try { if (fs.statSync(pngPath).size > 0) resolve(pngPath); else reject(new Error('screenshot_fallback:empty')) }
        catch (e: any) { reject(new Error(`screenshot_fallback:${e.message}`)) }
      })
  })
}

export async function captureScreenBuffer(): Promise<Buffer> {
  try {
    // screenshot-desktop 不传 filename 时直接返回 PNG Buffer
    const buf = await screenshot({ format: 'png' }) as unknown as Buffer
    if (buf && buf.length > 0) return buf
    throw new Error('empty_capture')
  } catch (e: any) {
    console.warn('[cuCore] screenshot-desktop failed, fallback PowerShell:', e?.message || e)
    const p = path.join(os.tmpdir(), `lu-sc-${Date.now()}.png`)
    await screenshotFallbackPS(p)
    const buf = fs.readFileSync(p)
    try { fs.unlinkSync(p) } catch {}
    return buf
  }
}

/** 截屏并解析真实像素尺寸 + base64（坐标映射以此为准） */
export async function captureScreen(): Promise<CuScreen> {
  const buffer = await captureScreenBuffer()
  const dims = pngDimensions(buffer)
  let w = dims?.w || 0
  let h = dims?.h || 0
  if (!w || !h) {
    try {
      const d = screen.getPrimaryDisplay()
      w = Math.round(d.size.width * d.scaleFactor)
      h = Math.round(d.size.height * d.scaleFactor)
    } catch { /* 保持 0，坐标回退像素模式 */ }
  }
  return { buffer, b64: buffer.toString('base64'), w, h }
}

// ──────────────────────────────────────────────────────────
// 4. 命令执行辅助
// ──────────────────────────────────────────────────────────

function execCmd(cmd: string, args: string[], timeout = 15000): Promise<string> {
  return new Promise<string>(resolve => {
    const child = cp.execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err) resolve(`ERR:${err.message}|${String(stderr).slice(0, 100)}`)
      else resolve(String(stdout).trim())
    })
    if (child.stdin) child.stdin.end()
  })
}

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
        if (err) resolve(`ERR:${err.message}|${String(stderr).slice(0, 100)}`)
        else resolve(String(stdout).trim())
      })
  })
}

// ──────────────────────────────────────────────────────────
// 5. 键鼠原语
// ──────────────────────────────────────────────────────────

export async function cuClick(x: number, y: number, btn: 'left' | 'right', dbl: boolean): Promise<string> {
  const plat = process.platform
  const rx = Math.round(x), ry = Math.round(y)

  if (plat === 'win32') {
    const click = dbl ? '[MO]::DoubleClickLeft()'
      : btn === 'right' ? '[MO]::ClickRight()' : '[MO]::ClickLeft()'
    const r = await runPS([
      "Add-Type @'",
      'using System;using System.Runtime.InteropServices;',
      'public class MO{',
      '[DllImport("user32.dll")]public static extern void mouse_event(uint f,uint dx,uint dy,uint d,int e);',
      'public const uint L=0x0002;public const uint LU=0x0004;',
      'public const uint R=0x0008;public const uint RU=0x0010;',
      'public static void ClickLeft(){mouse_event(L,0,0,0,0);System.Threading.Thread.Sleep(50);mouse_event(LU,0,0,0,0);}',
      'public static void ClickRight(){mouse_event(R,0,0,0,0);System.Threading.Thread.Sleep(50);mouse_event(RU,0,0,0,0);}',
      'public static void DoubleClickLeft(){ClickLeft();System.Threading.Thread.Sleep(100);ClickLeft();}',
      '}',
      "'@",
      'Add-Type -AssemblyName System.Windows.Forms',
      `[System.Windows.Forms.Cursor]::Position=New-Object System.Drawing.Point(${rx},${ry})`,
      'Start-Sleep -Milliseconds 80',
      click,
      "Write-Output 'OK'",
    ])
    return r.startsWith('ERR:') ? `点击失败:${r.slice(4)}` : '点击完成'
  }

  if (plat === 'darwin') {
    const osaCmd = dbl
      ? `tell application "System Events" to click at {${rx},${ry}}; delay 0.1; tell application "System Events" to click at {${rx},${ry}}`
      : `tell application "System Events" to click at {${rx},${ry}}`
    const r = await execCmd('osascript', ['-e', osaCmd])
    return r.startsWith('ERR:') ? `点击失败:${r.slice(4)}` : '点击完成'
  }

  const btnCode = btn === 'right' ? '3' : '1'
  const r = await execCmd('xdotool', ['mousemove', String(rx), String(ry), 'click', '--repeat', String(dbl ? 2 : 1), '--delay', '100', btnCode])
  return r.startsWith('ERR:') ? `点击失败:${r.slice(4)}` : '点击完成'
}

/** 键盘输入文本：Windows 走剪贴板粘贴（支持中文/长文本），并备份恢复原剪贴板 */
export async function cuType(text: string): Promise<string> {
  const plat = process.platform
  if (plat === 'win32') {
    if (!text) return '输入完成'
    let backup = ''
    try { backup = clipboard.readText() } catch { /* 忽略 */ }
    try { clipboard.writeText(text) } catch (e: any) { return `输入失败:剪贴板${e?.message || e}` }
    const r = await runPS([
      'Add-Type -AssemblyName System.Windows.Forms',
      "[System.Windows.Forms.SendKeys]::SendWait('^v')",
      "Write-Output 'OK'",
    ])
    await new Promise(res => setTimeout(res, 120))
    try { clipboard.writeText(backup) } catch { /* 还原失败不影响结果 */ }
    return r.startsWith('ERR:') ? `输入失败:${r.slice(4)}` : '输入完成'
  }
  if (plat === 'darwin') {
    const escaped = text.replace(/"/g, '\\"')
    const r = await execCmd('osascript', ['-e', `tell application "System Events" to keystroke "${escaped}"`])
    return r.startsWith('ERR:') ? `输入失败:${r.slice(4)}` : '输入完成'
  }
  const r = await execCmd('xdotool', ['type', '--delay', '50', text])
  return r.startsWith('ERR:') ? `输入失败:${r.slice(4)}` : '输入完成'
}

/** 单个按键 / 组合键（enter、esc、tab、ctrl_c、ctrl_v、alt_f4…） */
export async function cuPressKey(key: string): Promise<string> {
  const plat = process.platform
  const k = (key || '').toLowerCase()
  if (!k) return '按键失败:空按键'

  if (plat === 'win32') {
    const map: Record<string, string> = {
      enter: '{ENTER}', tab: '{TAB}', esc: '{ESC}', escape: '{ESC}',
      backspace: '{BACKSPACE}', delete: '{DELETE}', space: ' ',
      up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}',
      home: '{HOME}', end: '{END}', pageup: '{PGUP}', pagedown: '{PGDN}',
      ctrl_c: '^c', ctrl_v: '^v', ctrl_a: '^a', ctrl_x: '^x', ctrl_z: '^z', ctrl_y: '^y',
      ctrl_s: '^s', ctrl_f: '^f', alt_f4: '%{F4}', win: '^{ESC}',
    }
    const token = map[k] || (k.length === 1 ? k : `{${k.toUpperCase()}}`)
    const r = await runPS([
      'Add-Type -AssemblyName System.Windows.Forms',
      `[System.Windows.Forms.SendKeys]::SendWait('${token}')`,
      "Write-Output 'OK'",
    ])
    return r.startsWith('ERR:') ? `按键失败:${r.slice(4)}` : '按键完成'
  }
  if (plat === 'darwin') {
    const r = await execCmd('osascript', ['-e', `tell application "System Events" to key code ${key}`])
    return r.startsWith('ERR:') ? `按键失败:${r.slice(4)}` : '按键完成'
  }
  const r = await execCmd('xdotool', ['key', k])
  return r.startsWith('ERR:') ? `按键失败:${r.slice(4)}` : '按键完成'
}

/** 打开应用（按名称或路径） */
export async function cuOpenApp(app: string): Promise<string> {
  const name = (app || '').trim()
  if (!name) return '打开应用失败:空名称'
  const plat = process.platform
  try {
    if (plat === 'win32') {
      const r = await execCmd('cmd', ['/c', 'start', '', name])
      return r.startsWith('ERR:') ? `打开应用失败:${r.slice(4)}` : '已尝试打开应用'
    }
    if (plat === 'darwin') {
      const r = await execCmd('open', ['-a', name])
      return r.startsWith('ERR:') ? `打开应用失败:${r.slice(4)}` : '已尝试打开应用'
    }
    const r = await execCmd('xdg-open', [name])
    return r.startsWith('ERR:') ? `打开应用失败:${r.slice(4)}` : '已尝试打开应用'
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
  const plat = process.platform
  const n = Math.abs(amount)
  if (plat === 'win32') {
    const dirHex = amount > 0 ? '0x0800' : '0x0078'
    const reps = Array(Math.min(20, Math.max(1, n))).fill(`[MS]::mouse_event(${dirHex},0,0,0,0);Start-Sleep -Milliseconds 20`).join(';')
    const r = await runPS([
      "Add-Type @'",
      'using System;using System.Runtime.InteropServices;',
      'public class MS{[DllImport("user32.dll")]public static extern void mouse_event(uint f,uint dx,uint dy,uint d,int e);}',
      "'@",
      reps,
      "Write-Output 'OK'",
    ])
    return r.startsWith('ERR:') ? `滚动失败:${r.slice(4)}` : '滚动完成'
  }
  if (plat === 'darwin') {
    const r = await execCmd('osascript', ['-e',
      `tell application "System Events" to repeat ${n} times\n  key code 124 using {control down}\n  delay 0.02\nend repeat`])
    return r.startsWith('ERR:') ? `滚动失败:${r.slice(4)}` : '滚动完成'
  }
  const btnCode = amount > 0 ? '5' : '4'
  const r = await execCmd('xdotool', ['click', '--repeat', String(n), '--delay', '50', btnCode])
  return r.startsWith('ERR:') ? `滚动失败:${r.slice(4)}` : '滚动完成'
}

export async function cuDrag(x1: number, y1: number, x2: number, y2: number): Promise<string> {
  const plat = process.platform
  const rx1 = Math.round(x1), ry1 = Math.round(y1), rx2 = Math.round(x2), ry2 = Math.round(y2)

  if (plat === 'win32') {
    const r = await runPS([
      "Add-Type @'",
      'using System;using System.Runtime.InteropServices;',
      'public class MD{',
      '[DllImport("user32.dll")]public static extern void mouse_event(uint f,uint dx,uint dy,uint d,int e);',
      '[DllImport("user32.dll")]public static extern bool SetCursorPos(int X,int Y);',
      '}',
      "'@",
      `[MD]::SetCursorPos(${rx1},${ry1})`,
      'Start-Sleep -Milliseconds 80',
      '[MD]::mouse_event(0x0002,0,0,0,0)',
      'Start-Sleep -Milliseconds 50',
      `$steps=20;for($i=1;$i -le $steps;$i++){$nx=[int](${rx1}+(${rx2}-${rx1})*$i/$steps);$ny=[int](${ry1}+(${ry2}-${ry1})*$i/$steps);[MD]::SetCursorPos($nx,$ny);Start-Sleep -Milliseconds 15}`,
      `[MD]::SetCursorPos(${rx2},${ry2})`,
      'Start-Sleep -Milliseconds 50',
      '[MD]::mouse_event(0x0004,0,0,0,0)',
      "Write-Output 'OK'",
    ])
    return r.startsWith('ERR:') ? `拖拽失败:${r.slice(4)}` : '拖拽完成'
  }
  if (plat === 'darwin') {
    const r = await execCmd('osascript', ['-e',
      `tell application "System Events"\n  set mousePosition to {${rx1},${ry1}}\n  perform action "AXPress" at mousePosition\n  delay 0.05\n  set mousePosition to {${rx2},${ry2}}\n  perform action "AXPress" at mousePosition\nend tell`])
    return r.startsWith('ERR:') ? `拖拽失败:${r.slice(4)}` : '拖拽完成'
  }
  const r = await execCmd('bash', ['-c',
    `xdotool mousemove ${rx1} ${ry1} && xdotool mousedown 1 && xdotool mousemove ${rx2} ${ry2} && xdotool mouseup 1`])
  return r.startsWith('ERR:') ? `拖拽失败:${r.slice(4)}` : '拖拽完成'
}

// ──────────────────────────────────────────────────────────
// 6. 高危动作硬拦截 —— 判定在 ./cuSafety（destructiveReason），于 executeCuAction 内调用
// ──────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────
// 7. 统一动作执行（归一化坐标 → 像素 → 原语）
// ──────────────────────────────────────────────────────────

export async function executeCuAction(act: CuAction, view: CuView): Promise<CuExecResult> {
  const toPxX = (n?: number, px?: number): number =>
    typeof n === 'number' && Number.isFinite(n) ? normToPx(n, view.imgW) : Math.max(0, Math.round(Number(px) || 0))
  const toPxY = (n?: number, px?: number): number =>
    typeof n === 'number' && Number.isFinite(n) ? normToPx(n, view.imgH) : Math.max(0, Math.round(Number(px) || 0))
  const hasNorm = (a: CuAction) => typeof a.nx === 'number' && typeof a.ny === 'number'
  const hasPx = (a: CuAction) => typeof a.x === 'number' && typeof a.y === 'number'

  switch (act.action_type) {
    case 'click':
    case 'double_click':
    case 'right_click': {
      if (!hasNorm(act) && !hasPx(act)) return { ok: false, msg: '❌ 缺少坐标' }
      const btn = act.action_type === 'right_click' ? 'right' as const : 'left' as const
      const dbl = act.action_type === 'double_click'
      const msg = await cuClick(toPxX(act.nx, act.x), toPxY(act.ny, act.y), btn, dbl)
      return { ok: !msg.startsWith('❌') && !msg.startsWith('点击失败'), msg }
    }
    case 'type': {
      if (!act.text) return { ok: false, msg: '❌ 缺少输入文本' }
      const deny = destructiveReason(act.text)
      if (deny) return { ok: false, msg: `🚫 ${deny}`, denied: true }
      const msg = await cuType(act.text)
      return { ok: !msg.startsWith('❌') && !msg.startsWith('输入失败'), msg }
    }
    case 'keypress':
    case 'key': {
      if (!act.key) return { ok: false, msg: '❌ 缺少按键' }
      const deny = destructiveReason(act.key)
      if (deny) return { ok: false, msg: `🚫 ${deny}`, denied: true }
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
      if ((!hasNorm(act) && !hasPx(act)) || (!endNorm && !endPx)) return { ok: false, msg: '❌ 缺少拖拽坐标' }
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
      if (!name) return { ok: false, msg: '❌ 缺少应用名' }
      const msg = await cuOpenApp(name)
      return { ok: !/失败|ERR:/i.test(msg), msg }
    }
    case 'close_window': {
      const msg = await cuPressKey('alt_f4')
      return { ok: !msg.startsWith('❌') && !msg.startsWith('按键失败'), msg }
    }
    case 'clipboard': {
      if (!act.text) return { ok: false, msg: '❌ 缺少剪贴板文本' }
      const msg = cuSetClipboard(act.text)
      return { ok: !msg.startsWith('写剪贴板失败'), msg }
    }
    default:
      return { ok: false, msg: `❓ 未知操作类型: ${act.action_type}` }
  }
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
