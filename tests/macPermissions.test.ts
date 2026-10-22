// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/macPermissions.test.ts — macOS 失败诊断 + 结构化降级单测
//
// 纯函数，Windows 上可完整验证。验证三件事：
//   1. 真实 macOS 错误串能被归到正确的授权类别
//   2. 分类不依赖措辞的唯一性（措辞变体也命中；分类失败时保留原文）
//   3. 状态通道：needs_permission / unsupported / ready 三态正确登记与读取
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest'
import {
  classifyMacFailure, formatFailure, isPermissionFailure, failureMessage,
} from '../electron/core/platform/macPermissions'
import {
  reportCapabilityStatus, getCapabilityStatus, getAllCapabilityStatuses,
  isCapabilityBlocked, blockedCapabilitiesHint, resetCapabilityStatuses,
  needsPermission, unsupported, ready,
  MAC_PERMISSION_SETTINGS_PATH,
} from '../electron/core/platform/platformStatus'

beforeEach(() => { resetCapabilityStatuses() })

describe('classifyMacFailure — 辅助功能', () => {
  it('osascript -1743 判为辅助功能未授权', () => {
    const d = classifyMacFailure(
      'ERR:Command failed: osascript -e ... (-1743)|Not authorized to send Apple events to System Events',
      'input',
    )
    expect(d.kind).toBe('accessibility')
    expect(d.permission).toBe('accessibility')
    expect(d.message).toMatch(/辅助功能/)
    expect(isPermissionFailure(d)).toBe(true)
  })

  it('措辞变体：assistive access', () => {
    const d = classifyMacFailure('not authorized for assistive access', 'input')
    expect(d.kind).toBe('accessibility')
  })

  it('★ -1743 不得被误判为「自动化」——否则会把用户引到错误的设置面板', () => {
    // 该串同时含 "Not authorized to send Apple events"（自动化的特征），
    // 但在 macOS 上这一条实际就是辅助功能没开，必须优先命中辅助功能。
    const d = classifyMacFailure('Not authorized to send Apple events to System Events. (-1743)')
    expect(d.kind).toBe('accessibility')
    expect(d.permission).toBe('accessibility')
  })
})

describe('classifyMacFailure — 屏幕录制', () => {
  it('screencapture 的 tccERR 判为屏幕录制未授权', () => {
    const d = classifyMacFailure('ERR:screencapture: tccERR 123|', 'screenshot')
    expect(d.kind).toBe('screen_recording')
    expect(d.permission).toBe('screen_recording')
    expect(d.message).toMatch(/屏幕与系统音频录制|Screen Recording/)
  })

  it('CGError 变体', () => {
    const d = classifyMacFailure('kCGErrorFailure | not permitted', 'screenshot')
    expect(d.kind).toBe('screen_recording')
  })

  it('★ 截屏失败但措辞陌生时，仍按屏幕录制兜底（macOS 截屏失败最常见原因）', () => {
    const d = classifyMacFailure('ERR:some totally unknown failure|', 'screenshot')
    expect(d.kind).toBe('screen_recording')
    expect(d.raw).toContain('unknown failure')
  })
})

describe('classifyMacFailure — 命令缺失 / 超时 / 自动化', () => {
  it('ENOENT 判为命令不存在（提示 brew install cliclick）', () => {
    const d = classifyMacFailure('spawn cliclick ENOENT', 'input')
    expect(d.kind).toBe('not_found')
    expect(d.message).toMatch(/brew install cliclick/)
    expect(isPermissionFailure(d)).toBe(false)
  })

  it('command not found 同类', () => {
    expect(classifyMacFailure('cliclick: command not found', 'input').kind).toBe('not_found')
  })

  it('超时判为 timeout', () => {
    const d = classifyMacFailure('Command failed: ETIMEDOUT', 'input')
    expect(d.kind).toBe('timeout')
  })

  it('纯 Apple events 失败（无 -1743）判为自动化', () => {
    const d = classifyMacFailure('Not authorized to send Apple events', 'app')
    expect(d.kind).toBe('automation')
    expect(d.permission).toBe('automation')
  })
})

describe('formatFailure / failureMessage', () => {
  it('分类成功时不重复贴原始串', () => {
    const d = classifyMacFailure('ERR:-1743 not authorized|', 'input')
    expect(formatFailure(d)).not.toMatch(/ERR:/)
  })

  it('★ 分类失败时必须保留原始错误（排障唯一线索）', () => {
    const d = classifyMacFailure('ERR:weird unknown thing|', 'app')
    expect(d.kind).toBe('unknown')
    expect(formatFailure(d)).toMatch(/原始错误/)
    expect(formatFailure(d)).toMatch(/weird unknown thing/)
  })

  it('failureMessage 带动作动词前缀', () => {
    const d = classifyMacFailure('ERR:-1743|', 'input')
    expect(failureMessage(d, '移动')).toMatch(/^移动失败:/)
  })

  it('原始串过长时截断，不撑爆 UI', () => {
    const d = classifyMacFailure('x'.repeat(5000), 'app')
    expect(d.raw.length).toBeLessThanOrEqual(301)
  })
})

// ── 结构化状态通道 ──────────────────────────────────────

describe('platformStatus 结构化降级通道', () => {
  it('未登记的能力默认 ready（Windows 从不登记 → 行为不变）', () => {
    expect(getCapabilityStatus('mouse').state).toBe('ready')
    expect(isCapabilityBlocked('mouse')).toBe(false)
  })

  it('needs_permission 携带权限键与设置路径', () => {
    reportCapabilityStatus('screenshot', needsPermission('screen_recording', '截屏'))
    const s = getCapabilityStatus('screenshot')
    expect(s.state).toBe('needs_permission')
    if (s.state === 'needs_permission') {
      expect(s.permission).toBe('screen_recording')
      expect(s.settingsPath).toBe(MAC_PERMISSION_SETTINGS_PATH.screen_recording)
      expect(s.reason).toMatch(/截屏/)
      expect(s.reason).toMatch(/重启/)
    }
    expect(isCapabilityBlocked('screenshot')).toBe(true)
  })

  it('unsupported 记录原因', () => {
    reportCapabilityStatus('mouse', unsupported('长按需 cliclick'))
    const s = getCapabilityStatus('mouse')
    expect(s.state).toBe('unsupported')
    expect(s.state === 'unsupported' && s.reason).toMatch(/cliclick/)
  })

  it('ready 状态不算被阻断', () => {
    reportCapabilityStatus('keyboard', ready('AppleScript'))
    expect(isCapabilityBlocked('keyboard')).toBe(false)
  })

  it('getAllCapabilityStatuses 只列已登记项', () => {
    reportCapabilityStatus('uia', needsPermission('accessibility', '读元素树'))
    const all = getAllCapabilityStatuses()
    expect(Object.keys(all)).toEqual(['uia'])
  })

  it('blockedCapabilitiesHint 汇总可读提示；无阻断时为空串', () => {
    expect(blockedCapabilitiesHint()).toBe('')
    reportCapabilityStatus('screenshot', needsPermission('screen_recording', '截屏'))
    reportCapabilityStatus('mouse', unsupported('长按需 cliclick'))
    const hint = blockedCapabilitiesHint()
    expect(hint).toMatch(/屏幕截图/)
    expect(hint).toMatch(/鼠标控制/)
    expect(hint).toMatch(/屏幕与系统音频录制/)
  })

  it('resetCapabilityStatuses 清空', () => {
    reportCapabilityStatus('mouse', unsupported('x'))
    resetCapabilityStatuses()
    expect(getAllCapabilityStatuses()).toEqual({})
  })

  it('三种权限都有明确设置路径', () => {
    expect(MAC_PERMISSION_SETTINGS_PATH.accessibility).toMatch(/辅助功能/)
    expect(MAC_PERMISSION_SETTINGS_PATH.screen_recording).toMatch(/屏幕/)
    expect(MAC_PERMISSION_SETTINGS_PATH.automation).toMatch(/自动化/)
  })
})
