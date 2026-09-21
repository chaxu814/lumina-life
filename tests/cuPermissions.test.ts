// ============================================================
// tests/cuPermissions.test.ts — Computer Use 权限门纯决策测试 (v3.20)
//
// 覆盖：系统键黑名单、浏览器只读、终端/IDE 只点不打、剪贴板授权、
//       级别不足、规则表精确匹配、总开关、进程名归一化。
// ============================================================

import { describe, it, expect, vi } from 'vitest'

// 决策函数测试不碰 I/O，但模块顶层 import electron，给一个指向临时目录的假 app
vi.mock('electron', () => {
  const os = require('os'); const path = require('path'); const fs = require('fs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-cu-policy-'))
  return { app: { getPath: () => dir } }
})

import {
  defaultPolicy, decideCuGate, normalizeProc, normalizeKey, categorize,
  requiredLevel,
} from '../electron/tools/impl/cuPermissions'
import type { CuAction } from '../electron/tools/impl/cuCore'

function act(partial: Partial<CuAction>): CuAction {
  return { action_type: 'click', ...partial }
}

describe('requiredLevel 分级', () => {
  it('read 级：截图/滚动/等待', () => {
    expect(requiredLevel(act({ action_type: 'screenshot' }))).toBe('read')
    expect(requiredLevel(act({ action_type: 'scroll' }))).toBe('read')
    expect(requiredLevel(act({ action_type: 'wait' }))).toBe('read')
  })
  it('click 级：点击/拖拽/打开应用', () => {
    expect(requiredLevel(act({ action_type: 'click' }))).toBe('click')
    expect(requiredLevel(act({ action_type: 'drag' }))).toBe('click')
    expect(requiredLevel(act({ action_type: 'open_app' }))).toBe('click')
  })
  it('full 级：打字/按键/剪贴板/关窗', () => {
    expect(requiredLevel(act({ action_type: 'type' }))).toBe('full')
    expect(requiredLevel(act({ action_type: 'keypress' }))).toBe('full')
    expect(requiredLevel(act({ action_type: 'clipboard' }))).toBe('full')
    expect(requiredLevel(act({ action_type: 'close_window' }))).toBe('full')
  })
})

describe('归一化工具', () => {
  it('normalizeProc 去路径去 .exe 转小写', () => {
    expect(normalizeProc('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')).toBe('powershell')
    expect(normalizeProc('CODE.EXE')).toBe('code')
    expect(normalizeProc(null)).toBe('')
  })
  it('normalizeKey 连字符/control/command 归一', () => {
    expect(normalizeKey('Ctrl+Shift+Esc')).toBe('ctrl_shift_esc')
    expect(normalizeKey('control-shift-esc')).toBe('ctrl_shift_esc')
    expect(normalizeKey('command')).toBe('win')
  })
  it('categorize 分区识别', () => {
    expect(categorize('chrome.exe')).toBe('browser')
    expect(categorize('msedge')).toBe('browser')
    expect(categorize('powershell')).toBe('terminal')
    expect(categorize('cmd')).toBe('terminal')
    expect(categorize('code')).toBe('ide')
    expect(categorize('idea64')).toBe('ide')
    expect(categorize('notepad')).toBe('other')
  })
})

describe('decideCuGate', () => {
  it('总开关关闭时全部放行', () => {
    const p = { ...defaultPolicy(), enabled: false }
    expect(decideCuGate(p, act({ action_type: 'type' }), { proc: 'chrome' }).allow).toBe(true)
  })

  it('系统键黑名单在任何级别下硬拦截（即使 full 授权）', () => {
    const p = defaultPolicy()
    const d = decideCuGate(p, act({ action_type: 'keypress', key: 'win_r' }), { proc: 'notepad' })
    expect(d.allow).toBe(false)
    expect(d.reason).toContain('黑名单')
    expect(decideCuGate(p, act({ action_type: 'keypress', key: 'ctrl+shift+esc' }), { proc: 'notepad' }).allow).toBe(false)
    expect(decideCuGate(p, act({ action_type: 'keypress', key: 'alt_f4' }), { proc: 'notepad' }).allow).toBe(false)
    expect(decideCuGate(p, act({ action_type: 'keypress', key: 'alt-tab' }), { proc: 'notepad' }).allow).toBe(false)
  })

  it('浏览器分区：只读，点击/输入都拒绝，滚动/截图允许', () => {
    const p = defaultPolicy()
    expect(decideCuGate(p, act({ action_type: 'click' }), { proc: 'chrome' }).allow).toBe(false)
    expect(decideCuGate(p, act({ action_type: 'type', text: 'x' }), { proc: 'msedge' }).allow).toBe(false)
    expect(decideCuGate(p, act({ action_type: 'scroll' }), { proc: 'chrome' }).allow).toBe(true)
    expect(decideCuGate(p, act({ action_type: 'screenshot' }), { proc: 'chrome' }).allow).toBe(true)
  })

  it('终端分区：只点不打，type/clipboard 硬拒，导航键白名单放行', () => {
    const p = defaultPolicy()
    expect(decideCuGate(p, act({ action_type: 'click' }), { proc: 'powershell' }).allow).toBe(true)
    expect(decideCuGate(p, act({ action_type: 'type', text: 'rm -rf /' }), { proc: 'powershell' }).allow).toBe(false)
    expect(decideCuGate(p, act({ action_type: 'clipboard', text: 'x' }), { proc: 'cmd' }).allow).toBe(false)
    expect(decideCuGate(p, act({ action_type: 'keypress', key: 'enter' }), { proc: 'powershell' }).allow).toBe(false)
    expect(decideCuGate(p, act({ action_type: 'keypress', key: 'ctrl_c' }), { proc: 'powershell' }).allow).toBe(true)
    expect(decideCuGate(p, act({ action_type: 'keypress', key: 'Tab' }), { proc: 'powershell' }).allow).toBe(true)
  })

  it('IDE 分区同终端策略', () => {
    const p = defaultPolicy()
    expect(decideCuGate(p, act({ action_type: 'type', text: 'x' }), { proc: 'code' }).allow).toBe(false)
    expect(decideCuGate(p, act({ action_type: 'click' }), { proc: 'cursor' }).allow).toBe(true)
  })

  it('剪贴板：未知应用默认 click 级，写入被拒；full 授权应用放行', () => {
    const p = defaultPolicy()
    const denied = decideCuGate(p, act({ action_type: 'clipboard', text: '秘密' }), { proc: 'someapp' })
    expect(denied.allow).toBe(false)
    expect(denied.reason).toContain('full')
    // notepad 默认 full
    expect(decideCuGate(p, act({ action_type: 'clipboard', text: '你好' }), { proc: 'notepad' }).allow).toBe(true)
  })

  it('级别不足：默认 click 级未知应用拒绝 type/keypress', () => {
    const p = defaultPolicy()
    const d = decideCuGate(p, act({ action_type: 'type', text: 'hi' }), { proc: 'unknownapp' })
    expect(d.allow).toBe(false)
    expect(d.level).toBe('click')
  })

  it('规则表精确匹配优先，full 授权应用可打字/关窗', () => {
    const p = defaultPolicy()
    expect(decideCuGate(p, act({ action_type: 'type', text: 'hi' }), { proc: 'winword' }).allow).toBe(true)
    expect(decideCuGate(p, act({ action_type: 'close_window' }), { proc: 'excel' }).allow).toBe(true)
  })

  it('read 级授权下：截图/滚动放行，点击及以上拒绝', () => {
    const p = { ...defaultPolicy(), defaultLevel: 'read' as const, rules: {} }
    expect(decideCuGate(p, act({ action_type: 'screenshot' }), { proc: 'anything' }).allow).toBe(true)
    expect(decideCuGate(p, act({ action_type: 'scroll' }), { proc: 'anything' }).allow).toBe(true)
    expect(decideCuGate(p, act({ action_type: 'click' }), { proc: 'anything' }).allow).toBe(false)
  })

  it('none 级（应用被拉黑）下连只读动作都拒绝', () => {
    const p = { ...defaultPolicy(), rules: { evil: 'none' } }
    expect(decideCuGate(p, act({ action_type: 'screenshot' }), { proc: 'evil' }).allow).toBe(false)
  })

  it('浏览器只读开关关闭后点击可按默认级别放行', () => {
    const p = { ...defaultPolicy(), browserReadonly: false, defaultLevel: 'click' as const }
    expect(decideCuGate(p, act({ action_type: 'click' }), { proc: 'chrome' }).allow).toBe(true)
  })
})
