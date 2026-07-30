// tests/delegation.test.ts — 委托系统 + allowedTools 白名单强制 单元测试
// 按 agentTeamPersonas.ts 实际 Persona 数据验证
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: (name: string) => process.cwd() },
}))

import { LUMINA_PERSONA, RECHA_PERSONA, YAK_PERSONA } from '../electron/agentTeamPersonas'

describe('Persona allowedTools whitelist', () => {
  it('Lumina has empty allowedTools (relies on default toolset)', () => {
    const tools = LUMINA_PERSONA.allowedTools
    // Lumina 社交引擎角色没有显式限制工具——允许所有默认工具
    expect(tools).toEqual([])
  })

  it('热茶 has limited read-only tools', () => {
    const tools = RECHA_PERSONA.allowedTools
    expect(tools).toContain('file_read')
    expect(tools).toContain('web_search')
    // 热茶只能审查，不写代码
    expect(tools).not.toContain('shell_exec')
    expect(tools).not.toContain('file_write')
    expect(tools).not.toContain('git_commit')
  })

  it('Yak has full dev tools', () => {
    const tools = YAK_PERSONA.allowedTools
    expect(tools).toContain('shell_exec')
    expect(tools).toContain('file_read')
    expect(tools).toContain('file_write')
    expect(tools).toContain('file_edit')
    expect(tools).toContain('web_search')
  })
})

describe('allowedTools → disabledTools conversion', () => {
  function computeDisabled(allowed: string[], allTools: string[]): string[] {
    return allTools.filter(t => !allowed.includes(t))
  }

  it('Lumina (empty tools) has all tools blocked', () => {
    const allTools = ['shell_exec', 'file_read', 'file_write', 'web_search', 'browser']
    const blocked = computeDisabled(LUMINA_PERSONA.allowedTools, allTools)
    expect(blocked).toEqual(allTools)
  })

  it('热茶 has shell blocked (read-only reviewer)', () => {
    const allTools = ['shell_exec', 'file_read', 'file_write', 'web_search', 'git_commit']
    const blocked = computeDisabled(RECHA_PERSONA.allowedTools, allTools)
    expect(blocked).toContain('shell_exec')
    expect(blocked).toContain('file_write')
    expect(blocked).toContain('git_commit')
    expect(blocked).not.toContain('file_read')
    expect(blocked).not.toContain('web_search')
  })

  it('Yak can use shell and file tools', () => {
    const allTools = ['shell_exec', 'file_read', 'file_write', 'web_search', 'browser']
    const blocked = computeDisabled(YAK_PERSONA.allowedTools, allTools)
    expect(blocked).not.toContain('shell_exec')
    expect(blocked).not.toContain('file_read')
  })
})
