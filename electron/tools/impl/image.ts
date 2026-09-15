// ============================================================
// impl/image.ts - Screenshot/Clipboard/Image Generation (v3.0)
// v3.0: Added image generation (OpenAI DALL-E)
// ============================================================

import { execFile } from 'child_process'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ToolDef, ToolResult } from '../types'

// PowerShell safe execution
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
  description: 'Take screenshot (Windows). Save as PNG.',
  params: {
    savePath: { type: 'string', description: 'Save path (e.g. C:\\screenshot.png). Empty = Desktop.', required: false },
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
    return { callId: '', ok: false, content: '', error: error || 'Screenshot failed' }
  }
  return { callId: '', ok: true, content: `Screenshot saved: ${savePath}` }
}

export const clipboardGetDef: ToolDef = {
  name: 'clipboard_get',
  description: 'Get clipboard text',
  params: {},
  toolsets: ['agent'],
}

export async function clipboardGet(): Promise<ToolResult> {
  const { ok, stdout, error } = await psExecAsync('Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::GetText();', 5000)
  if (!ok) {
    return { callId: '', ok: false, content: '', error: 'Cannot read clipboard' }
  }
  const text = stdout.trim()
  return { callId: '', ok: true, content: text || '(clipboard empty)' }
}

export const clipboardSetDef: ToolDef = {
  name: 'clipboard_set',
  description: 'Set clipboard text',
  params: {
    text: { type: 'string', description: 'Text to copy', required: true },
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
    return { callId: '', ok: false, content: '', error: error || 'Cannot set clipboard' }
  }
  return { callId: '', ok: true, content: `Copied to clipboard (${args.text.length} chars)` }
}

// ============================================================
// Image Generation (Phase 3 Light Media)
// ============================================================

export const imageGenerateDef: ToolDef = {
  name: 'image_generate',
  description: 'Generate image from text (OpenAI DALL-E). Requires API Key.',
  params: {
    prompt: { type: 'string', description: 'Image description', required: true },
    size: { type: 'string', description: 'Size (1024x1024 / 512x512 / 256x256)', required: false },
    n: { type: 'number', description: 'Count (1-4)', required: false },
  },
  toolsets: ['agent', 'media'],
}

export async function imageGenerate(args: Record<string, any>): Promise<ToolResult> {
  const { prompt, size = '1024x1024', n = 1 } = args

  // Get API Key from config
  const configPath = join(process.env.APPDATA || '', 'lumina', 'lumina-config.json')
  let apiKey = ''
  try {
    const config = JSON.parse(require('fs').readFileSync(configPath, 'utf-8'))
    apiKey = config.openai?.apiKey || ''
  } catch {
    apiKey = process.env.OPENAI_API_KEY || ''
  }

  if (!apiKey) {
    return {
      callId: '',
      ok: false,
      content: '',
      error: 'No OpenAI API Key configured. Please set OPENAI_API_KEY env var or configure in settings.',
    }
  }

  try {
    const response = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'dall-e-3',
        prompt,
        n: Math.min(n, 4),
        size,
      }),
    })

    if (!response.ok) {
      const error = await response.text()
      return { callId: '', ok: false, content: '', error: `DALL-E request failed: ${error}` }
    }

    const data = await response.json()
    const images = data.data || []

    // Download images
    const saveDir = join(process.env.USERPROFILE || '', 'Desktop', 'lumina_images')
    mkdirSync(saveDir, { recursive: true })

    const savedPaths: string[] = []
    for (let i = 0; i < images.length; i++) {
      const imgUrl = images[i].url
      const imgResponse = await fetch(imgUrl)
      const buffer = Buffer.from(await imgResponse.arrayBuffer())
      const savePath = join(saveDir, `lumina_${Date.now()}_${i + 1}.png`)
      writeFileSync(savePath, buffer)
      savedPaths.push(savePath)
    }

    return {
      callId: '',
      ok: true,
      content: `Generated ${savedPaths.length} images:\n${savedPaths.map(p => `- ${p}`).join('\n')}`,
    }
  } catch (err: any) {
    return { callId: '', ok: false, content: '', error: `Image generation failed: ${err.message}` }
  }
}
