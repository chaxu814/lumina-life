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

  // v15 角色统一：全应用为 热茶=程序员、Yak=分析/审查（原先是反的）
  it('热茶 has full dev tools（代码工程师）', () => {
    const tools = RECHA_PERSONA.allowedTools
    expect(tools).toContain('file_read')
    expect(tools).toContain('web_search')
    expect(tools).toContain('shell_exec')
    expect(tools).toContain('file_write')
    expect(tools).toContain('file_edit')
    // 只写代码不提交 git
    expect(tools).not.toContain('git_commit')
  })

  it('Yak has limited read-only tools（审查员）', () => {
    const tools = YAK_PERSONA.allowedTools
    expect(tools).toContain('file_read')
    expect(tools).toContain('web_search')
    // Yak 只审不改
    expect(tools).not.toContain('shell_exec')
    expect(tools).not.toContain('file_write')
    expect(tools).not.toContain('file_edit')
    expect(tools).not.toContain('git_commit')
  })

  it('Yak can review without write tools（只审不改）', () => {
    const tools = YAK_PERSONA.allowedTools
    expect(tools).toContain('file_read')
    expect(tools).toContain('web_search')
    expect(tools).not.toContain('file_write')
    expect(tools).not.toContain('file_edit')
    expect(tools).not.toContain('shell_exec')
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

  // v15 角色统一：写入能力跟着热茶走，审查能力跟着 Yak 走
  it('热茶 can use shell and write files（代码工程师）', () => {
    const allTools = ['shell_exec', 'file_read', 'file_write', 'web_search', 'git_commit']
    const blocked = computeDisabled(RECHA_PERSONA.allowedTools, allTools)
    expect(blocked).not.toContain('shell_exec')
    expect(blocked).not.toContain('file_read')
    expect(blocked).not.toContain('file_write')
    // 不代替用户提交 git
    expect(blocked).toContain('git_commit')
  })

  it('Yak has shell and write tools blocked（只审不改）', () => {
    const allTools = ['shell_exec', 'file_read', 'file_write', 'web_search', 'browser']
    const blocked = computeDisabled(YAK_PERSONA.allowedTools, allTools)
    expect(blocked).toContain('shell_exec')
    expect(blocked).toContain('file_write')
    expect(blocked).not.toContain('file_read')
    expect(blocked).not.toContain('web_search')
  })
})
