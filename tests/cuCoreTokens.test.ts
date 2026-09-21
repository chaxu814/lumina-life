// ============================================================
// tests/cuCoreTokens.test.ts — v3.30 组合键解析
// ============================================================

import { describe, it, expect, vi } from 'vitest'
import * as os from 'os'

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
  clipboard: { writeText: vi.fn(), readText: vi.fn(() => '') },
  screen: { getPrimaryDisplay: () => ({ size: { width: 1920, height: 1080 }, scaleFactor: 1 }) },
}))
vi.mock('screenshot-desktop', () => ({ default: vi.fn().mockResolvedValue(Buffer.from([])) }))

import { buildSendKeysToken } from '../electron/tools/impl/cuCore'

describe('buildSendKeysToken（组合键 → WScript.Shell SendKeys）', () => {
  it('单字符统一小写（大小写由上层走剪贴板）', () => {
    expect(buildSendKeysToken('a')).toBe('a')
    expect(buildSendKeysToken('A')).toBe('a')
  })
  it('命名键映射', () => {
    expect(buildSendKeysToken('enter')).toBe('{ENTER}')
    expect(buildSendKeysToken('escape')).toBe('{ESC}')
    expect(buildSendKeysToken('shift_tab')).toBe('+{TAB}')
    expect(buildSendKeysToken('ctrl_shift_esc')).toBe('^+{ESC}')
  })
  it('兼容 ctrl+c / alt+tab 写法', () => {
    expect(buildSendKeysToken('ctrl+c')).toBe('^c')
    expect(buildSendKeysToken('alt+tab')).toBe('%{TAB}')
  })
  it('未知修饰段保守失败', () => {
    expect(buildSendKeysToken('foo_bar')).toBeNull()
    expect(buildSendKeysToken('')).toBeNull()
  })
})
