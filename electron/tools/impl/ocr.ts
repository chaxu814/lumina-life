// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// impl/ocr.ts — OCR 文字识别 + 桌面自动化工具 (v2.3 / v2.10.1)
//
// OCR: Windows 截图 → Tesseract/PowerShell 文字识别
// 桌面: 鼠标移动/点击、键盘输入、窗口管理
//
// v2.10.1: 所有 PowerShell 调用改用 -EncodedCommand (UTF-16LE Base64)
//          彻底解决中文 Windows CP936/GBK 编码乱码问题
// ============================================================

import { execFile, exec } from 'child_process'
import { join } from 'path'
import { tmpdir } from 'os'
import fs from 'fs'
import type { ToolDef, ToolResult } from '../types'

// ═══════════════════════════════════════════════════════════
// PowerShell 安全执行助手
// 使用 -EncodedCommand (UTF-16LE → Base64) 彻底避免编码问题
// ═══════════════════════════════════════════════════════════

function runPowerShell(script: string, timeout = 15000): Promise<{ ok: boolean; stdout: string; error?: string }> {
  return new Promise((resolve) => {
    const b64 = Buffer.from(script, 'utf16le').toString('base64')
    execFile('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', b64,
    ], { timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, stdout: String(stdout || ''), error: err.message })
      } else {
        resolve({ ok: true, stdout: String(stdout || ''), error: undefined })
      }
    })
  })
}

// ═══════════════════════════════════════════════════════════
// OCR — 屏幕文字识别
// ═══════════════════════════════════════════════════════════

export const ocrDef: ToolDef = {
  name: 'ocr',
  description: '对屏幕区域截图并识别其中的文字内容。能看到屏幕上的任何文字。用于"看看有什么"、"读一下这个"等场景。',
  params: {
    region: { type: 'string', description: '可选: "full"(全屏)/"active"(当前窗口)，默认 "full"', required: false },
    language: { type: 'string', description: '识别语言: "chs"(中文) / "eng"(英文) / "chi_sim"(简体中文)，默认 "chs"', required: false },
  },
  toolsets: ['agent', 'desktop'],
}

export async function ocr(args: Record<string, any>): Promise<ToolResult> {
  const region = args.region || 'full'
  const lang = args.language || 'chs'
  const screenshotPath = join(tmpdir(), `lumina-ocr-${Date.now()}.png`)

  const safePath = screenshotPath.replace(/\\/g, '\\\\')

  const psScreenshot = [
    'Add-Type -AssemblyName System.Windows.Forms;',
    'Add-Type -AssemblyName System.Drawing;',
    '$s=Get-Date;',
    '$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds;',
    '$m=New-Object System.Drawing.Bitmap($b.Width,$b.Height);',
    '$g=[System.Drawing.Graphics]::FromImage($m);',
    '$g.CopyFromScreen($b.X,$b.Y,0,0,$b.Size);',
    `$m.Save('${safePath}',[System.Drawing.Imaging.ImageFormat]::Png);`,
    '$g.Dispose();$m.Dispose();',
    "Write-Output 'OK';",
  ].join(' ')

  const { ok, error } = await runPowerShell(psScreenshot, 15000)

  if (!ok) {
    return { callId: '', ok: false, content: '', error: `截图失败: ${error}` }
  }

  if (!fs.existsSync(screenshotPath)) {
    return { callId: '', ok: false, content: '', error: '截图文件未生成' }
  }

  // Step 2: OCR 识别
  try {
    const text = await tryOCR(screenshotPath, lang)
    try { fs.unlinkSync(screenshotPath) } catch { /* ignore */ }
    return { callId: '', ok: true, content: text || '(未识别到文字)' }
  } catch (ocrErr: any) {
    try { fs.unlinkSync(screenshotPath) } catch { /* ignore */ }
    return { callId: '', ok: false, content: '', error: `OCR失败: ${ocrErr.message}` }
  }
}

async function tryOCR(imagePath: string, lang: string): Promise<string> {
  // 尝试 tesseract (如果已安装)
  return new Promise((resolve, reject) => {
    const tesseractCmd = `tesseract "${imagePath}" stdout -l ${lang} 2>nul`
    exec(tesseractCmd, { timeout: 30000, windowsHide: true }, (err, stdout) => {
      if (err) {
        // tesseract 不可用，回退到 PowerShell UWP OCR
        tryUwpOCR(imagePath, lang).then(resolve).catch(reject)
        return
      }
      const text = stdout.trim()
      if (!text) {
        tryUwpOCR(imagePath, lang).then(resolve).catch(reject)
        return
      }
      resolve(text)
    })
  })
}

async function tryUwpOCR(imagePath: string, _lang: string): Promise<string> {
  const escapedPath = imagePath.replace(/\\/g, '\\\\')
  const psScript = [
    '$ErrorActionPreference="Stop";',
    '[Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime]|Out-Null;',
    '[Windows.Media.Ocr.OcrEngine,Windows.Media.Ocr,ContentType=WindowsRuntime]|Out-Null;',
    '[Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]|Out-Null;',
    '[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]|Out-Null;',
    `$f=[Windows.Storage.StorageFile]::GetFileFromPathAsync('${escapedPath}').GetAwaiter().GetResult();`,
    '$s=$f.OpenReadAsync().GetAwaiter().GetResult();',
    '$d=[Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($s).GetAwaiter().GetResult();',
    '$b=$d.GetSoftwareBitmapAsync().GetAwaiter().GetResult();',
    '$e=[Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages();',
    '$r=$e.RecognizeAsync($b).GetAwaiter().GetResult();',
    '$t=$r.Lines|ForEach-Object{$_.Text};',
    '$s.Dispose();',
    'if($t.Count -eq 0){"(未识别到文字)"}else{$t -join "`n"};',
  ].join(' ')

  const { ok, stdout, error } = await runPowerShell(psScript, 30000)
  if (!ok) {throw new Error(error || 'UWP OCR 失败')}
  return stdout.trim() || '(未识别到文字)'
}

// ═══════════════════════════════════════════════════════════
// 桌面自动化 — 鼠标 / 键盘
// ═══════════════════════════════════════════════════════════

export const desktopClickDef: ToolDef = {
  name: 'desktop_click',
  description: '将鼠标移动到屏幕指定坐标并点击（左键/右键/双击）。可以用于"移动鼠标到那里"、"帮我点一下"、"打开这个图标"等场景。',
  params: {
    x: { type: 'number', description: 'X 坐标 (像素)，例如 500', required: true },
    y: { type: 'number', description: 'Y 坐标 (像素)，例如 300', required: true },
    button: { type: 'string', description: '"left"(左键) / "right"(右键) / "middle"(中键)，默认 "left"', required: false },
    double: { type: 'boolean', description: '是否双击，默认 false', required: false },
  },
  toolsets: ['agent', 'desktop'],
  dangerous: true,
}

export async function desktopClick(args: Record<string, any>): Promise<ToolResult> {
  const { x, y } = args
  const button = args.button || 'left'
  const double = args.double || false

  const psScript = [
    'Add-Type -AssemblyName System.Windows.Forms;',
    `[System.Windows.Forms.Cursor]::Position=New-Object System.Drawing.Point(${x},${y});`,
    'Start-Sleep -Milliseconds 80;',
    'Add-Type @"',
    'using System;using System.Runtime.InteropServices;',
    'public class MO{',
    '[DllImport("user32.dll")]public static extern void mouse_event(uint f,uint dx,uint dy,uint d,int e);',
    'public const uint L=0x0002;public const uint LU=0x0004;',
    'public const uint R=0x0008;public const uint RU=0x0010;',
    'public static void CL(){mouse_event(L,0,0,0,0);System.Threading.Thread.Sleep(50);mouse_event(LU,0,0,0,0);}',
    'public static void CR(){mouse_event(R,0,0,0,0);System.Threading.Thread.Sleep(50);mouse_event(RU,0,0,0,0);}',
    'public static void DC(){CL();System.Threading.Thread.Sleep(100);CL();}',
    '}',
    '"@;',
    button === 'right'
      ? '[MO]::CR();'
      : double
        ? '[MO]::DC();'
        : '[MO]::CL();',
    "Write-Output 'OK';",
  ].join(' ')

  const { ok, error } = await runPowerShell(psScript, 10000)
  if (!ok) {
    return { callId: '', ok: false, content: '', error: error || '点击失败' }
  }
  const desc = double ? '双击' : '点击'
  return { callId: '', ok: true, content: `已${desc}屏幕坐标 (${x}, ${y}) [${button}键]` }
}

export const desktopTypeDef: ToolDef = {
  name: 'desktop_type',
  description: '模拟键盘输入文字。用于"帮我输入这段文字"、"在搜索框里打字"等操作。',
  params: {
    text: { type: 'string', description: '要输入的文字', required: true },
    delay: { type: 'number', description: '输入前等待的毫秒数 (给你时间聚焦目标窗口)，默认 1000', required: false },
  },
  toolsets: ['agent', 'desktop'],
  dangerous: true,
}

export async function desktopType(args: Record<string, any>): Promise<ToolResult> {
  const { text } = args
  const delay = args.delay || 1000

  // 安全转义 SendKeys 特殊字符
  const safe = text
    .replace(/'/g, "''")
    .replace(/\(/g, '{(}')
    .replace(/\)/g, '{)}')
    .replace(/\+/g, '{+}')
    .replace(/\^/g, '{^}')
    .replace(/%/g, '{%}')
    .replace(/~/g, '{~}')
    .replace(/\{/g, '{{}')
    .replace(/\}/g, '{}}')

  const psScript = [
    'Add-Type -AssemblyName System.Windows.Forms;',
    `Start-Sleep -Milliseconds ${delay};`,
    `[System.Windows.Forms.SendKeys]::SendWait('${safe}');`,
    "Write-Output 'OK';",
  ].join(' ')

  const { ok, error } = await runPowerShell(psScript, 15000)
  if (!ok) {
    return { callId: '', ok: false, content: '', error: error || '输入失败' }
  }
  return { callId: '', ok: true, content: `已输入: "${text.slice(0, 50)}${text.length > 50 ? '...' : ''}"` }
}

export const desktopKeyDef: ToolDef = {
  name: 'desktop_key',
  description: '按下键盘按键或组合键。用于"按回车确认"、"Ctrl+S保存"、"Alt+Tab切换窗口"等操作。',
  params: {
    keys: { type: 'string', description: '按键组合。如 "Enter"、"Ctrl+S"、"Alt+Tab"、"Win+D"、"Escape"', required: true },
  },
  toolsets: ['agent', 'desktop'],
  dangerous: true,
}

export async function desktopKey(args: Record<string, any>): Promise<ToolResult> {
  const { keys } = args
  // 转换组合键格式: Ctrl+S → ^(s)  Alt+Tab → %({TAB})
  const keyMap: Record<string, string> = {
    'enter': '{ENTER}',
    'tab': '{TAB}',
    'escape': '{ESC}',
    'esc': '{ESC}',
    'backspace': '{BS}',
    'delete': '{DEL}',
    'up': '{UP}',
    'down': '{DOWN}',
    'left': '{LEFT}',
    'right': '{RIGHT}',
    'home': '{HOME}',
    'end': '{END}',
    'space': ' ',
    'f1': '{F1}', 'f2': '{F2}', 'f3': '{F3}', 'f4': '{F4}',
    'f5': '{F5}', 'f6': '{F6}', 'f7': '{F7}', 'f8': '{F8}',
    'printscreen': '{PRTSC}',
    'win': '^{ESC}',
  }

  const parts = keys.toLowerCase().split('+')
  let sendKeys = ''
  const modifiers: string[] = []
  let mainKey = ''

  for (const p of parts) {
    const trimmed = p.trim()
    if (trimmed === 'ctrl' || trimmed === 'control') {modifiers.push('^')}
    else if (trimmed === 'alt') {modifiers.push('%')}
    else if (trimmed === 'shift') {modifiers.push('+')}
    else if (trimmed === 'win' || trimmed === 'windows') {modifiers.push('^{ESC}')}
    else {mainKey = trimmed}
  }

  if (modifiers.includes('^{ESC}') && mainKey) {
    // Win+Key 不支持 SendKeys，提示使用其他方式
    // 降级为只发送主键
    sendKeys = keyMap[mainKey] || `{${mainKey.toUpperCase()}}`
  } else if (mainKey) {
    const mappedKey = keyMap[mainKey] || `{${mainKey.toUpperCase()}}`
    sendKeys = modifiers.join('') + (modifiers.length > 0 ? `(${mappedKey.replace(/[{}]/g, '')})` : mappedKey)
  } else if (modifiers.length === 1 && modifiers[0] === '^{ESC}') {
    sendKeys = '^{ESC}' // Win键单独
  } else {
    sendKeys = keyMap[parts[0]] || `{${parts[0].toUpperCase()}}`
  }

  const psFinal = [
    'Add-Type -AssemblyName System.Windows.Forms;',
    'Start-Sleep -Milliseconds 300;',
    `[System.Windows.Forms.SendKeys]::SendWait('${sendKeys}');`,
    "Write-Output 'OK';",
  ].join(' ')

  const { ok, error } = await runPowerShell(psFinal, 10000)
  if (!ok) {
    return { callId: '', ok: false, content: '', error: error || '按键失败' }
  }
  return { callId: '', ok: true, content: `已按下: ${keys}` }
}

export const desktopScreenSizeDef: ToolDef = {
  name: 'desktop_screen_size',
  description: '获取屏幕分辨率信息。在需要点击屏幕坐标前，先用此工具获取屏幕大小。',
  params: {},
  toolsets: ['agent', 'desktop'],
}

export async function desktopScreenSize(): Promise<ToolResult> {
  const psScript = [
    'Add-Type -AssemblyName System.Windows.Forms;',
    '$s=[System.Windows.Forms.Screen]::AllScreens;',
    'foreach($i in $s){$b=$i.Bounds;"$($b.Width)x$($b.Height) at ($($b.X),$($b.Y))$(if($i.Primary){"(主屏)"}else{""})"};',
  ].join(' ')

  const { ok, stdout, error } = await runPowerShell(psScript, 5000)
  if (!ok) {
    return { callId: '', ok: false, content: '', error: error || '获取屏幕尺寸失败' }
  }
  return { callId: '', ok: true, content: stdout.trim() }
}

// ═══════════════════════════════════════════════════════════
// 桌面自动化 — 仅移动鼠标（不点击）
// ═══════════════════════════════════════════════════════════

export const desktopMouseMoveDef: ToolDef = {
  name: 'desktop_mouse_move',
  description: '将鼠标移动到屏幕指定坐标位置，不点击。用于"把鼠标移到那里"、"鼠标挪到角落"等场景。配合 desktop_click 先移动再点击使用。',
  params: {
    x: { type: 'number', description: '目标 X 坐标 (像素)，左上角为 0', required: true },
    y: { type: 'number', description: '目标 Y 坐标 (像素)，左上角为 0', required: true },
  },
  toolsets: ['agent', 'desktop'],
  dangerous: true,
}

export async function desktopMouseMove(args: Record<string, any>): Promise<ToolResult> {
  const { x, y } = args
  const psScript = [
    'Add-Type -AssemblyName System.Windows.Forms;',
    `[System.Windows.Forms.Cursor]::Position=New-Object System.Drawing.Point(${x},${y});`,
    "Write-Output 'OK';",
  ].join(' ')
  const { ok, error } = await runPowerShell(psScript, 5000)
  if (!ok) {
    return { callId: '', ok: false, content: '', error: error || '移动鼠标失败' }
  }
  return { callId: '', ok: true, content: `鼠标已移动到 (${x}, ${y})` }
}
