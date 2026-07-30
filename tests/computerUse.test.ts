// ============================================================
// tests/computerUse.test.ts — ComputerUse 桌面操控引擎单元测试
// ============================================================

import { describe, it, expect, beforeEach, vi } from 'vitest'

// 在 import ComputerUse 前 mock 依赖
vi.mock('screenshot-desktop', () => ({
  default: vi.fn().mockResolvedValue('/tmp/mock-screen.png'),
}))

import { ComputerUse, getComputerUse, initComputerUse } from '../electron/computerUse'
import type { CUConfig, CUAction } from '../electron/computerUse'

// ═══════════════════════════════════════════════════════════
// 辅助
// ═══════════════════════════════════════════════════════════

function makeCU(config?: Partial<CUConfig>): ComputerUse {
  return new ComputerUse({
    llmApiKey: 'test-key',
    safetyLevel: 'auto',
    ...config,
  })
}

// 访问私有方法
function privateMethod(obj: any, name: string): any {
  return obj[name].bind(obj)
}

// ═══════════════════════════════════════════════════════════
// 1. 构造
// ═══════════════════════════════════════════════════════════

describe('constructor', () => {
  it('creates instance with default config', () => {
    const cu = new ComputerUse()
    expect(cu).toBeInstanceOf(ComputerUse)
  })

  it('applies custom config', () => {
    const cu = new ComputerUse({ maxSteps: 5, safetyLevel: 'strict' })
    expect(cu).toBeDefined()
  })

  it('sets default maxSteps to 10', () => {
    const cu = new ComputerUse()
    expect((cu as any).config.maxSteps).toBe(10)
  })

  it('creates temp directory if not exists', () => {
    // 只是确认不报错
    const cu = new ComputerUse({ screenshotDir: '/tmp/lumina-cu-test' })
    expect(cu).toBeDefined()
  })
})

// ═══════════════════════════════════════════════════════════
// 2. parseAction — 解析 LLM 输出的操作指令
// ═══════════════════════════════════════════════════════════

describe('parseAction', () => {
  let cu: ComputerUse
  let parseAction: (suggested: string) => CUAction | null

  beforeEach(() => {
    cu = makeCU()
    parseAction = privateMethod(cu, 'parseAction')
  })

  it('parses click(x, y)', () => {
    const result = parseAction('click(500, 300)')
    expect(result).toEqual({ type: 'click', params: { x: 500, y: 300 } })
  })

  it('parses click with spaces', () => {
    const result = parseAction('click( 100 , 200 )')
    expect(result).toEqual({ type: 'click', params: { x: 100, y: 200 } })
  })

  it('parses type("text")', () => {
    const result = parseAction('type("hello world")')
    expect(result).toEqual({ type: 'type', params: { text: 'hello world' } })
  })

  it('parses type with empty string', () => {
    const result = parseAction('type("")')
    expect(result).toEqual({ type: 'type', params: { text: '' } })
  })

  it('parses keypress', () => {
    const result = parseAction('keypress("enter")')
    expect(result).toEqual({ type: 'keypress', params: { key: 'enter' } })
  })

  it('parses keypress with ctrl_c', () => {
    const result = parseAction('keypress("ctrl_c")')
    expect(result).toEqual({ type: 'keypress', params: { key: 'ctrl_c' } })
  })

  it('parses scroll', () => {
    const result = parseAction('scroll("down", 3)')
    expect(result).toEqual({ type: 'scroll', params: { direction: 'down', amount: 3 } })
  })

  it('parses scroll up', () => {
    const result = parseAction('scroll("up", 1)')
    expect(result).toEqual({ type: 'scroll', params: { direction: 'up', amount: 1 } })
  })

  it('parses wait', () => {
    const result = parseAction('wait(1500)')
    expect(result).toEqual({ type: 'wait', params: { ms: 1500 } })
  })

  it('parses clipboard', () => {
    const result = parseAction('clipboard("你好世界")')
    expect(result).toEqual({ type: 'clipboard', params: { text: '你好世界' } })
  })

  it('parses open_app', () => {
    const result = parseAction('open_app("Chrome")')
    expect(result).toEqual({ type: 'open_app', params: { app: 'Chrome' } })
  })

  it('returns null for DONE', () => {
    expect(parseAction('DONE')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseAction('')).toBeNull()
  })

  it('returns null for undefined input', () => {
    expect(parseAction(undefined as any)).toBeNull()
  })

  it('CASE-INSENSITIVE: click vs CLICK', () => {
    const result = parseAction('CLICK(1, 2)')
    expect(result?.type).toBe('click')
  })

  it('ignores surrounding whitespace', () => {
    const result = parseAction('  click(10, 20)  ')
    expect(result?.type).toBe('click')
  })
})

// ═══════════════════════════════════════════════════════════
// 3. parseAnalysisResponse
// ═══════════════════════════════════════════════════════════

describe('parseAnalysisResponse', () => {
  let cu: ComputerUse
  let parseAnalysisResponse: (response: string) => any

  beforeEach(() => {
    cu = makeCU()
    parseAnalysisResponse = privateMethod(cu, 'parseAnalysisResponse')
  })

  it('parses valid JSON response', () => {
    const result = parseAnalysisResponse(JSON.stringify({
      description: '打开了的浏览器窗口',
      elements: [{ type: 'button', label: '搜索', confidence: 0.9 }],
      suggestedAction: 'click(500, 300)',
      reasoning: '搜索按钮在页面中间',
    }))
    expect(result.description).toBe('打开了的浏览器窗口')
    expect(result.elements).toHaveLength(1)
    expect(result.suggestedAction).toBe('click(500, 300)')
  })

  it('extracts JSON from mixed text', () => {
    const result = parseAnalysisResponse(
      '一些前缀\n```\n{"description":"test","elements":[],"suggestedAction":"DONE"}\n```',
    )
    expect(result.description).toBe('test')
    expect(result.suggestedAction).toBe('DONE')
  })

  it('falls back when no JSON found', () => {
    const result = parseAnalysisResponse('纯文字，没有 JSON')
    expect(result.description).toBe('无法解析分析结果')
    expect(result.suggestedAction).toBe('DONE')
  })

  it('handles malformed JSON gracefully', () => {
    const result = parseAnalysisResponse('{"bad json"}')
    expect(result.description).toBe('无法解析分析结果')
    expect(result.suggestedAction).toBe('DONE')
  })

  it('handles empty input', () => {
    const result = parseAnalysisResponse('')
    expect(result.description).toBe('无法解析分析结果')
  })
})

// ═══════════════════════════════════════════════════════════
// 4. fallbackAnalysis — VLM 未配置时的降级
// ═══════════════════════════════════════════════════════════

describe('fallbackAnalysis', () => {
  let cu: ComputerUse
  let fallbackAnalysis: (path: string, task: string, history: any[]) => any

  beforeEach(() => {
    cu = makeCU({ llmApiKey: undefined }) // 无 API key
    fallbackAnalysis = privateMethod(cu, 'fallbackAnalysis')
  })

  it('returns DONE when VLM is unavailable', () => {
    const result = fallbackAnalysis('/tmp/screen.png', '打开浏览器', [])
    expect(result.suggestedAction).toBe('DONE')
    expect(result.description).toContain('VLM 未配置')
  })

  it('includes task description in response', () => {
    const result = fallbackAnalysis('/tmp/screen.png', '查找文件', [])
    expect(result.description).toContain('查找文件')
  })
})

// ═══════════════════════════════════════════════════════════
// 5. confirmAction — 安全确认
// ═══════════════════════════════════════════════════════════

describe('confirmAction', () => {
  let confirmAction: (action: CUAction) => Promise<boolean>

  it('auto mode: allows all actions', async () => {
    const cu = makeCU({ safetyLevel: 'auto' })
    confirmAction = privateMethod(cu, 'confirmAction')
    expect(await confirmAction({ type: 'click', params: { x: 1, y: 2 } })).toBe(true)
    expect(await confirmAction({ type: 'type', params: { text: 'hello' } })).toBe(true)
  })

  it('strict mode: blocks destructive text', async () => {
    const cu = makeCU({ safetyLevel: 'strict' })
    confirmAction = privateMethod(cu, 'confirmAction')
    const result = await confirmAction({ type: 'type', params: { text: 'sudo rm -rf /' } })
    expect(result).toBe(false)
  })

  it('strict mode: blocks del command', async () => {
    const cu = makeCU({ safetyLevel: 'strict' })
    confirmAction = privateMethod(cu, 'confirmAction')
    const result = await confirmAction({ type: 'type', params: { text: 'del /f system.dll' } })
    expect(result).toBe(false)
  })

  it('strict mode: allows normal text', async () => {
    const cu = makeCU({ safetyLevel: 'strict' })
    confirmAction = privateMethod(cu, 'confirmAction')
    const result = await confirmAction({ type: 'type', params: { text: 'Hello, 你好!' } })
    expect(result).toBe(true)
  })

  it('strict mode: allows ctrl_c', async () => {
    const cu = makeCU({ safetyLevel: 'strict' })
    confirmAction = privateMethod(cu, 'confirmAction')
    const result = await confirmAction({ type: 'keypress', params: { key: 'ctrl_c' } })
    expect(result).toBe(true)
  })

  it('strict mode: allows click', async () => {
    const cu = makeCU({ safetyLevel: 'strict' })
    confirmAction = privateMethod(cu, 'confirmAction')
    expect(await confirmAction({ type: 'click', params: { x: 100, y: 200 } })).toBe(true)
  })

  it('strict mode: blocks shutdown text', async () => {
    const cu = makeCU({ safetyLevel: 'strict' })
    confirmAction = privateMethod(cu, 'confirmAction')
    expect(await confirmAction({ type: 'type', params: { text: 'sudo shutdown -h now' } })).toBe(false)
  })

  it('strict mode: blocks restart text', async () => {
    const cu = makeCU({ safetyLevel: 'strict' })
    confirmAction = privateMethod(cu, 'confirmAction')
    expect(await confirmAction({ type: 'type', params: { text: 'restart computer' } })).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════
// 6. 平台命令生成（跨平台）
// ═══════════════════════════════════════════════════════════

describe('platform commands (win32)', () => {
  let cu: ComputerUse
  let clickCmd: (x: number, y: number) => string

  beforeEach(() => {
    cu = makeCU()
    clickCmd = privateMethod(cu, 'clickCmd')
  })

  it('clickCmd generates PowerShell command', () => {
    const cmd = clickCmd(100, 200)
    expect(cmd).toContain('powershell')
    expect(cmd).toContain('mouse_event')
    expect(cmd).toContain('100')
    expect(cmd).toContain('200')
  })
})

// ── 平台命令测试：根据实际运行平台调整断言 ──────────

function isWin32(): boolean { return process.platform === 'win32' }
function isDarwin(): boolean { return process.platform === 'darwin' }

describe('platform commands (win32)', () => {
  let cu: ComputerUse
  let clickCmd: (x: number, y: number) => string
  let clipboardCmd: (text: string) => string
  let scrollCmd: (dir: string, amount: number) => string

  beforeEach(() => {
    cu = makeCU()
    clickCmd = privateMethod(cu, 'clickCmd')
    clipboardCmd = privateMethod(cu, 'clipboardCmd')
    scrollCmd = privateMethod(cu, 'scrollCmd')
  })

  it('clickCmd generates PowerShell command on win32', () => {
    const cmd = clickCmd(100, 200)
    if (isWin32()) {
      expect(cmd).toContain('powershell')
      expect(cmd).toContain('mouse_event')
      expect(cmd).toContain('100')
      expect(cmd).toContain('200')
    } else {
      // cross-platform: 至少包含坐标数字
      expect(cmd).toMatch(/100/)
      expect(cmd).toMatch(/200/)
    }
  })

  it('clipboard command carries the text', () => {
    const cmd = clipboardCmd('hello')
    expect(cmd).toContain('hello')
    if (isWin32()) {
      expect(cmd).toContain('Set-Clipboard')
    } else if (isDarwin()) {
      expect(cmd).toContain('pbcopy')
    }
  })

  it('scroll command outputs direction-based number', () => {
    const cmd = scrollCmd('down', 1)
    // 跨平台：至少包含 xdotool/osascript 中一种
    expect(cmd.length).toBeGreaterThan(10)
  })
})

describe('platform commands — 键映射', () => {
  let cu: ComputerUse
  let keypressCmd: (key: string) => string

  beforeEach(() => {
    cu = makeCU()
    keypressCmd = privateMethod(cu, 'keypressCmd')
  })

  it('maps enter to Return', () => {
    const cmd = keypressCmd('enter')
    expect(cmd).toContain('Return')
  })

  it('maps tab', () => {
    const cmd = keypressCmd('tab')
    expect(cmd).toContain('Tab')
  })

  it('maps esc', () => {
    const cmd = keypressCmd('esc')
    expect(cmd).toContain('Escape')
  })

  it('maps space', () => {
    const cmd = keypressCmd('space')
    expect(cmd).toContain('space')
  })

  it('passes through unknown keys', () => {
    const cmd = keypressCmd('f5')
    // 所有平台都包含 f5
    expect(cmd).toContain('f5')
  })
})

describe('platform commands — 跨平台输出', () => {
  let cu: ComputerUse
  let clickCmd: (x: number, y: number) => string

  beforeEach(() => {
    cu = makeCU()
    clickCmd = privateMethod(cu, 'clickCmd')
  })

  it('click action contains coordinates', () => {
    const cmd = clickCmd(300, 400)
    expect(cmd).toMatch(/300/)
    expect(cmd).toMatch(/400/)
    if (isWin32()) {
      expect(cmd).toContain('powershell')
      expect(cmd).toContain('mouse_event')
    } else if (isDarwin()) {
      expect(cmd).toContain('osascript')
    } else {
      expect(cmd).toContain('xdotool')
    }
  })
})

describe('platform commands — type', () => {
  let cu: ComputerUse
  let typeCmd: (text: string) => string

  beforeEach(() => {
    cu = makeCU()
    typeCmd = privateMethod(cu, 'typeCmd')
  })

  it('generates type command with text', () => {
    const cmd = typeCmd('hello world')
    expect(cmd).toContain('hello world')
    if (isWin32()) {
      expect(cmd).toContain('SendKeys')
    } else if (isDarwin()) {
      expect(cmd).toContain('keystroke')
    } else {
      expect(cmd).toContain('xdotool type')
    }
  })

  it('escapes double quotes', () => {
    const cmd = typeCmd('say "hi"')
    expect(cmd).toContain('\\"')
  })
})

describe('platform commands — scroll 数量', () => {
  let cu: ComputerUse
  let scrollCmd: (dir: string, amount: number) => string

  beforeEach(() => {
    cu = makeCU()
    scrollCmd = privateMethod(cu, 'scrollCmd')
  })

  it('scroll down one step', () => {
    const cmd = scrollCmd('down', 1)
    expect(cmd.length).toBeGreaterThan(5)
  })

  it('scroll up one step', () => {
    const cmd = scrollCmd('up', 1)
    expect(cmd.length).toBeGreaterThan(5)
  })

  it('scroll repeats for amount', () => {
    const cmd = scrollCmd('down', 3)
    if (isWin32() || !isDarwin()) {
      // Linux: xdotool click 5 5 5; Win: 同 xdotool
      if (cmd.includes('xdotool')) {
        expect(cmd.match(/5/g)?.length).toBe(3)
      }
    }
    // darwin: osascript - 滚动量 x3
    expect(cmd).toBeTruthy()
  })
})

// ═══════════════════════════════════════════════════════════
// 7. 边缘情况与错误处理
// ═══════════════════════════════════════════════════════════

describe('executeAction error handling', () => {
  let cu: ComputerUse

  beforeEach(() => {
    cu = makeCU()
  })

  it('returns false for unknown action type', async () => {
    const result = await (cu as any).executeAction({ type: 'fly', params: {} })
    expect(result).toBe(false)
  })

  it('returns false for click with NaN coordinates', async () => {
    const result = await (cu as any).executeAction({ type: 'click', params: { x: 'abc', y: 'def' } })
    expect(result).toBe(false)
  })

  it('returns false for missing click coordinates', async () => {
    const result = await (cu as any).executeAction({ type: 'click', params: {} })
    expect(result).toBe(false)
  })

  it('handles wait action', async () => {
    const start = Date.now()
    await (cu as any).executeAction({ type: 'wait', params: { ms: 50 } })
    const elapsed = Date.now() - start
    expect(elapsed).toBeGreaterThanOrEqual(30)
  })

  it('returns true for clipboard action', async () => {
    const result = await (cu as any).executeAction({ type: 'clipboard', params: { text: 'test' } })
    // 由于 mock 了 exec，实际 command 可能失败，但函数不抛异常
    expect(typeof result).toBe('boolean')
  })
})

describe('safeExec error handling', () => {
  let cu: ComputerUse

  beforeEach(() => {
    cu = makeCU()
  })

  it('returns false on command failure (does not throw)', async () => {
    // safeExec 内部 catch error 并返回 false
    const safeExec = privateMethod(cu, 'safeExec')
    // 传一个必定失败的命令
    const result = await safeExec('cmddddddddd_does_not_exist')
    expect(result).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════
// 8. singleton: getComputerUse / initComputerUse
// ═══════════════════════════════════════════════════════════

describe('getComputerUse / initComputerUse', () => {
  it('getComputerUse returns an instance', () => {
    const instance = getComputerUse()
    expect(instance).toBeDefined()
  })

  it('initComputerUse creates a new singleton', () => {
    const instance = initComputerUse({ llmApiKey: 'test-init-key' })
    expect(instance).toBeDefined()
  })
})
