// ============================================================
// impl/image.ts — 截图/剪贴板工具 (v2.10.1)
// v2.10.1: 所有 PowerShell 改用 -EncodedCommand 杜绝编码乱码
// ============================================================

import { execFile } from 'child_process'
import type { ToolDef, ToolResult } from '../types'

// PowerShell 安全执行
function psExecAsync(script: string, timeout = 15000): Promise<{ ok: boolean; stdout: string; error?: string }> {
  return new Promise((resolve) => {
    const b64 = Buffer.from(script, 'utf16le').toString('base64')
    execFile('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', b64,
    ], { timeout, windowsHide: true }, (err, stdout) => {
      resolve({ ok: !err, stdout: String(stdout || ''), error: err?.message })
    })
  })
}

export const screenshotDef: ToolDef = {
  name: 'screenshot',
  description: '截取当前屏幕 (Windows)。保存为 PNG 文件。',
  params: {
    savePath: { type: 'string', description: '保存路径 (如 C:\\screenshot.png)。不填则保存到桌面。', required: false },
  },
  toolsets: ['agent'],
}

export async function screenshot(args: Record<string, any>): Promise<ToolResult> {
  const desktop = process.env.USERPROFILE + '\\Desktop'
  const savePath = args.savePath || `${desktop}\\lumina_screenshot_${Date.now()}.png`
  const safePath = savePath.replace(/\\/g, '\\\\')

  const psScript = [
    'Add-Type -AssemblyName System.Windows.Forms;',
    'Add-Type -AssemblyName System.Drawing;',
    '$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds;',
    '$m=New-Object System.Drawing.Bitmap($b.Width,$b.Height);',
    '$g=[System.Drawing.Graphics]::FromImage($m);',
    '$g.CopyFromScreen(0,0,0,0,$m.Size);',
    `$m.Save('${safePath}',[System.Drawing.Imaging.ImageFormat]::Png);`,
    '$g.Dispose();$m.Dispose();',
    `Write-Output 'OK:${safePath}';`,
  ].join('\n')

  const { ok, error } = await psExecAsync(psScript, 15000)
  if (!ok) {
    return { callId: '', ok: false, content: '', error: error || '截图失败' }
  }
  return { callId: '', ok: true, content: `截图已保存: ${savePath}` }
}

export const clipboardGetDef: ToolDef = {
  name: 'clipboard_get',
  description: '读取剪贴板文本内容',
  params: {},
  toolsets: ['agent'],
}

export async function clipboardGet(): Promise<ToolResult> {
  const { ok, stdout, error } = await psExecAsync('Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::GetText();', 5000)
  if (!ok) {
    return { callId: '', ok: false, content: '', error: '无法读取剪贴板' }
  }
  const text = stdout.trim()
  return { callId: '', ok: true, content: text || '(剪贴板为空)' }
}

export const clipboardSetDef: ToolDef = {
  name: 'clipboard_set',
  description: '设置剪贴板内容',
  params: {
    text: { type: 'string', description: '要复制到剪贴板的文本', required: true },
  },
  toolsets: ['agent'],
}

export async function clipboardSet(args: Record<string, any>): Promise<ToolResult> {
  const escaped = args.text.replace(/'/g, "''")
  const { ok, error } = await psExecAsync(
    `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::SetText('${escaped}');`,
    5000
  )
  if (!ok) {
    return { callId: '', ok: false, content: '', error: error || '无法设置剪贴板' }
  }
  return { callId: '', ok: true, content: `已复制到剪贴板 (${args.text.length} 字符)` }
}
