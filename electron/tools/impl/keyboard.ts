// ============================================================
// impl/keyboard.ts — 键盘控制工具 (v2.5 / v2.10.1)
//
// 借鉴 Hiyori: 桌面级键盘模拟，支持组合键、文本输入
// v2.10.1: 所有 PowerShell 改用 -EncodedCommand (UTF-16LE Base64) 杜绝编码乱码
// ============================================================

import type { ToolDef, ToolResult } from '../types'
import { execFileSync } from 'child_process'

// ═══════════════════════════════════════════════════════════
// PowerShell 安全执行 (UTF-16LE Base64)
// ═══════════════════════════════════════════════════════════

function psExec(script: string, timeout = 5000): string {
  const b64 = Buffer.from(script, 'utf16le').toString('base64')
  return execFileSync('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', b64,
  ], { timeout, windowsHide: true, encoding: 'utf-8' }).toString().trim()
}

// ═══════════════════════════════════════════════════════════
// keyboard_press — 按键/组合键
// ═══════════════════════════════════════════════════════════

export const keyboardPressDef: ToolDef = {
  name: 'keyboard_press',
  description: `模拟键盘按键，支持组合键和功能键。

常用键名: enter, escape, tab, space, backspace, delete, home, end
方向键: arrow_up, arrow_down, arrow_left, arrow_right
修饰键组合: ctrl+c, alt+f4, win+r, ctrl+shift+esc
功能键: f1-f12

参数:
- keys: 按键或组合键 (如 "ctrl+s", "enter", "alt+tab")
- count: 按键次数 (默认 1)
- delay_ms: 按键间隔毫秒 (默认 50)`,
  params: {
    keys: { type: 'string', description: '按键名或组合键', required: true },
    count: { type: 'number', description: '按键次数', required: false },
    delay_ms: { type: 'number', description: '按键间隔', required: false },
  },
  toolsets: ['desktop', 'agent'],
}

export async function keyboardPress(args: Record<string, any>): Promise<ToolResult> {
  const { keys, count = 1, delay_ms = 50 } = args

  try {
    const isWin = process.platform === 'win32'
    let script: string

    if (isWin) {
      for (let i = 0; i < count; i++) {
        const script = [
          'Add-Type -AssemblyName System.Windows.Forms;',
          `[System.Windows.Forms.SendKeys]::SendWait('${keys.replace(/'/g, "''")}');`,
        ].join('\n')
        psExec(script, 5000)
        if (i < count - 1) await sleep(delay_ms)
      }
    } else {
      // macOS/Linux 使用 osascript/xdotool
      for (let i = 0; i < count; i++) {
        if (process.platform === 'darwin') {
          execFileSync('osascript', ['-e', `tell application "System Events" to keystroke "${keys}"`], { timeout: 3000 })
        } else {
          execFileSync('xdotool', ['key', keys], { timeout: 3000 })
        }
        if (i < count - 1) await sleep(delay_ms)
      }
    }

    return {
      callId: '',
      ok: true,
      content: `⌨️ 按键: "${keys}" ×${count}`,
    }
  } catch (err: any) {
    return {
      callId: '',
      ok: false,
      content: '',
      error: `按键失败: ${err.message}`,
    }
  }
}

// ═══════════════════════════════════════════════════════════
// keyboard_type — 文本输入
// ═══════════════════════════════════════════════════════════

export const keyboardTypeDef: ToolDef = {
  name: 'keyboard_type',
  description: `模拟键盘输入文本到当前焦点窗口。

参数:
- text: 要输入的文本
- delay_ms: 字符间延迟 (默认 30ms，防止过快丢失字符)`,
  params: {
    text: { type: 'string', description: '要输入的文本', required: true },
    delay_ms: { type: 'number', description: '字符间延迟毫秒数', required: false },
  },
  toolsets: ['desktop', 'agent'],
}

export async function keyboardType(args: Record<string, any>): Promise<ToolResult> {
  const { text, delay_ms = 30 } = args

  try {
    const isWin = process.platform === 'win32'
    // Windows: 使用 PowerShell SendKeys
    if (isWin) {
      const escaped = text
        .replace(/\{/g, '{{}')
        .replace(/\}/g, '{}}')
        .replace(/\+/g, '{+}')
        .replace(/\^/g, '{^}')
        .replace(/\%/g, '{%}')
        .replace(/\~/g, '{~}')
        .replace(/\(/g, '{(}')
        .replace(/\)/g, '{)}')
        .replace(/\n/g, '{ENTER}')

      const script = [
        'Add-Type -AssemblyName System.Windows.Forms;',
        `[System.Windows.Forms.SendKeys]::SendWait('${escaped}');`,
      ].join('\n')
      psExec(script, 10000)
    } else {
      const escaped = text.replace(/"/g, '\\"')
      if (process.platform === 'darwin') {
        execFileSync('osascript', ['-e', `tell application "System Events" to keystroke "${escaped}"`], { timeout: 10000 })
      } else {
        execFileSync('xdotool', ['type', escaped], { timeout: 10000 })
      }
    }

    return {
      callId: '',
      ok: true,
      content: `⌨️ 已输入文本 (${text.length} 字符)`,
    }
  } catch (err: any) {
    return {
      callId: '',
      ok: false,
      content: '',
      error: `文本输入失败: ${err.message}`,
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}
