// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/teamRegistry.test.ts — 动态团队注册中心单元测试
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest'
import { getTeamRegistry, useTestRegistry } from '../electron/core/teamRegistry'

describe('TeamRegistry', () => {
  let registry: ReturnType<typeof getTeamRegistry>

  beforeEach(() => {
    // 使用测试实例（隔离每个测试）
    registry = useTestRegistry()
  })

  it('初始化时只有内置成员', () => {
    const all = registry.getAllMembers()
    expect(all.length).toBeGreaterThanOrEqual(3)
    const ids = all.map(m => m.id)
    expect(ids).toContain('lumina')
    expect(ids).toContain('yak')
    expect(ids).toContain('recha')
  })

  it('内置成员 isBuiltIn 为 true', () => {
    const all = registry.getAllMembers()
    const lumina = all.find(m => m.id === 'lumina')
    expect(lumina).toBeDefined()
    expect(registry.isBuiltIn('lumina')).toBe(true)
  })

  it('可以注册新的动态成员', () => {
    const ok = registry.register({
      id: 'test-agent',
      name: '测试助手',
      icon: '🤖',
      role: 'worker',
      description: '测试用动态成员',
      capabilities: ['测试', '验证'],
      triggers: ['test', '测试'],
    })
    expect(ok).toBe(true)

    const all = registry.getAllMembers()
    const agent = all.find(m => m.id === 'test-agent')
    expect(agent).toBeDefined()
    expect(agent?.name).toBe('测试助手')
    // 内置成员没有 isBuiltIn 字段，动态成员通过 registry 方法判断
    expect(registry.isBuiltIn('test-agent')).toBe(false)
    // DynamicMemberRegistration 有 capabilities
    const dyn = registry.getDynamicMembers()
    const dynAgent = dyn.find(m => m.id === 'test-agent')
    expect(dynAgent?.capabilities).toEqual(['测试', '验证'])
  })

  it('重复 ID 注册返回 false', () => {
    registry.register({
      id: 'dup-agent', name: 'Dup', icon: '🤖', role: 'worker',
      description: '', capabilities: [], triggers: [],
    })
    const ok = registry.register({
      id: 'dup-agent', name: 'Dup Again', icon: '🤖', role: 'worker',
      description: '', capabilities: [], triggers: [],
    })
    expect(ok).toBe(false)
  })

  it('不能注册内置成员 ID', () => {
    const ok = registry.register({
      id: 'lumina', name: 'Fake Lumina', icon: '🐱', role: 'worker',
      description: '', capabilities: [], triggers: [],
    })
    expect(ok).toBe(false)
  })

  it('可以移除动态成员', () => {
    registry.register({
      id: 'temp-agent', name: 'Temp', icon: '🔄', role: 'worker',
      description: '', capabilities: [], triggers: [],
    })
    expect(registry.getAllMembers().find(m => m.id === 'temp-agent')).toBeDefined()

    const removed = registry.unregister('temp-agent')
    expect(removed).toBe(true)
    expect(registry.getAllMembers().find(m => m.id === 'temp-agent')).toBeUndefined()
  })

  it('不能移除内置成员', () => {
    const removed = registry.unregister('lumina')
    expect(removed).toBe(false)
  })

  it('listAll 返回包含所有内置 + 动态成员的合并列表', () => {
    const before = registry.getAllMembers().length
    registry.register({
      id: 'extra-1', name: 'Extra 1', icon: '1️⃣', role: 'worker',
      description: '', capabilities: [], triggers: [],
    })
    registry.register({
      id: 'extra-2', name: 'Extra 2', icon: '2️⃣', role: 'worker',
      description: '', capabilities: [], triggers: [],
    })
    expect(registry.getAllMembers().length).toBe(before + 2)
  })

  it('查询动态成员通过 getDynamicMembers', () => {
    registry.register({
      id: 'query-test', name: 'Query', icon: '🔍', role: 'worker',
      description: '查询测试', capabilities: ['search'], triggers: [],
    })
    const dyn = registry.getDynamicMembers()
    expect(dyn.find(m => m.id === 'query-test')).toBeDefined()
    expect(dyn.find(m => m.id === 'lumina')).toBeUndefined()
  })

  it('unregister 不存在的 ID 返回 false', () => {
    const removed = registry.unregister('non-existent')
    expect(removed).toBe(false)
  })
})
