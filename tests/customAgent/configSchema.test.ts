// tests/customAgent/configSchema.test.ts — agent.json 格式与默认值单测
import { describe, it, expect } from 'vitest'
import {
  normalizeAgentConfig,
  isValidAgentId,
  KNOWN_TOOLSETS,
  type CustomAgentConfig,
} from '../../electron/agents/customAgentManager'

describe('agent.json 格式 schema', () => {
  it('生成的配置满足约定字段', () => {
    const cfg = normalizeAgentConfig({
      id: 'my_agent',
      name: '我的助手',
      icon: '🤖',
      personality: '自定义人格描述',
      toolsets: ['agent', 'files_core'],
      teamRole: 'member',
    })
    // 任务给定的 agent.json 字段全部存在
    expect(cfg).toMatchObject({
      id: 'my_agent',
      name: '我的助手',
      icon: '🤖',
      archetype: 'custom',
      personality: '自定义人格描述',
      soulFile: 'SOUL.md',
      profileFile: 'PROFILE.md',
      memoryFile: 'MEMORY.md',
      ttsVoice: expect.any(String),
      toolsets: ['agent', 'files_core'],
      visible: true,
      teamRole: 'member',
    })
    // model 子对象结构
    expect(cfg.model).toMatchObject({ provider: '', model: '', baseUrl: '', apiKey: '' })
    // createdAt 是日期串
    expect(cfg.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('JSON 序列化/反序列化无损', () => {
    const cfg = normalizeAgentConfig({ id: 'roundtrip', name: 'RT' })
    const parsed = JSON.parse(JSON.stringify(cfg)) as CustomAgentConfig
    const rebuilt = normalizeAgentConfig(parsed)
    expect(rebuilt.id).toBe('roundtrip')
    expect(rebuilt.toolsets).toEqual(cfg.toolsets)
  })

  it('空 toolsets 回退到默认', () => {
    expect(normalizeAgentConfig({ id: 't1', toolsets: [] }).toolsets).toEqual(['agent', 'files_core'])
  })

  it('teamRole 非法值回退 member', () => {
    expect(normalizeAgentConfig({ id: 'r1', teamRole: 'boss' as any }).teamRole).toBe('member')
    expect(normalizeAgentConfig({ id: 'r2', teamRole: 'leader' }).teamRole).toBe('leader')
  })

  it('已知工具集白名单非空', () => {
    expect(KNOWN_TOOLSETS.length).toBeGreaterThan(0)
    expect(KNOWN_TOOLSETS).toContain('agent')
  })

  it('id 安全：拒绝路径穿越与非法字符', () => {
    const bad = ['../x', 'a/b', 'A B', '', '9x', 'x'.repeat(50)]
    for (const b of bad) {expect(isValidAgentId(b)).toBe(false)}
  })
})
