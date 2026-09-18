// ============================================================
// tests/platformCaps.test.ts — 桌宠窗口跨平台能力探测
// ============================================================

import { describe, it, expect } from 'vitest'
import { resolvePlatformCaps, SOLID_PANEL_BG } from '../electron/pet/platformCaps'

describe('resolvePlatformCaps 透明窗能力', () => {
  it('Windows：透明 + setShape 都支持', () => {
    const c = resolvePlatformCaps({ platform: 'win32' })
    expect(c.transparent).toBe(true)
    expect(c.setShape).toBe(true)
    expect(c.backgroundColor).toBe('#00000000')
    expect(c.label).toBe('Windows')
  })

  it('macOS：透明可用，但 setShape 不支持', () => {
    const c = resolvePlatformCaps({ platform: 'darwin' })
    expect(c.transparent).toBe(true)
    expect(c.setShape).toBe(false)
  })

  it('Linux Wayland：默认透明，setShape 关闭', () => {
    const c = resolvePlatformCaps({ platform: 'linux', sessionType: 'wayland' })
    expect(c.transparent).toBe(true)
    expect(c.setShape).toBe(false)
    expect(c.label).toContain('Wayland')
  })

  it('Linux X11 无合成器：LUMINA_DISABLE_TRANSPARENCY=1 退化为实色面板，不黑屏', () => {
    const c = resolvePlatformCaps({ platform: 'linux', sessionType: 'x11', disableTransparency: '1' })
    expect(c.transparent).toBe(false)
    expect(c.setShape).toBe(false)
    expect(c.backgroundColor).toBe(SOLID_PANEL_BG)
    expect(c.note).toContain('面板')
  })

  it('Linux 强制 setShape 开关生效', () => {
    const c = resolvePlatformCaps({ platform: 'linux', forceSetShape: '1' })
    expect(c.setShape).toBe(true)
  })

  it('未知平台：保守退化为实色面板', () => {
    const c = resolvePlatformCaps({ platform: 'freebsd' })
    expect(c.transparent).toBe(false)
    expect(c.backgroundColor).toBe(SOLID_PANEL_BG)
  })
})
