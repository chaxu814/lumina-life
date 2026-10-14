import { describe, it, expect } from 'vitest'
import { isLiteTier, LITE_TOOL_WHITELIST, LITE_SYSTEM_NOTE } from '../electron/orchestration/weakModelMode'

describe('weakModelMode', () => {
  it('isLiteTier 仅对 nano / small 为 true', () => {
    expect(isLiteTier('nano')).toBe(true)
    expect(isLiteTier('small')).toBe(true)
    expect(isLiteTier('medium')).toBe(false)
    expect(isLiteTier('large')).toBe(false)
    expect(isLiteTier('xlarge')).toBe(false)
    expect(isLiteTier('moe')).toBe(false)
    // 未知 / 空输入安全回落到 false（不误开降级）
    expect(isLiteTier(null)).toBe(false)
    expect(isLiteTier(undefined)).toBe(false)
  })

  it('白名单只包含陪伴 + 检索 + 只读的安全工具', () => {
    expect(LITE_TOOL_WHITELIST.has('memory_search')).toBe(true)
    expect(LITE_TOOL_WHITELIST.has('web_search')).toBe(true)
    expect(LITE_TOOL_WHITELIST.has('file_read')).toBe(true)
    // 团队 / 写 / 执行类一律不在白名单
    expect(LITE_TOOL_WHITELIST.has('delegate_to')).toBe(false)
    expect(LITE_TOOL_WHITELIST.has('delegate_chain')).toBe(false)
    expect(LITE_TOOL_WHITELIST.has('hire_worker')).toBe(false)
    expect(LITE_TOOL_WHITELIST.has('adversarial_review')).toBe(false)
    expect(LITE_TOOL_WHITELIST.has('phase_gate_delegate')).toBe(false)
    expect(LITE_TOOL_WHITELIST.has('shell_exec')).toBe(false)
    expect(LITE_TOOL_WHITELIST.has('file_write')).toBe(false)
    expect(LITE_TOOL_WHITELIST.has('git_commit')).toBe(false)
  })

  it('LITE_SYSTEM_NOTE 提示轻量模式且禁用团队工具', () => {
    expect(LITE_SYSTEM_NOTE).toContain('轻量模式')
    expect(LITE_SYSTEM_NOTE).toContain('delegate_to')
    expect(LITE_SYSTEM_NOTE.length).toBeGreaterThan(50)
  })
})
