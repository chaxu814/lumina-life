// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// tests/customAgent/manager.test.ts — 自定义 Agent CRUD 单测（内存 fs）
import { describe, it, expect, beforeEach } from 'vitest'
import {
  CustomAgentManager,
  isValidAgentId,
  normalizeAgentConfig,
  type AgentFs,
} from '../../electron/agents/customAgentManager'

/** 内存文件系统（带目录树） */
class MemFs {
  files = new Map<string, string>()
  dirs = new Set<string>()
  private norm(p: string) { return p.replace(/\\/g, '/') }
  fs: AgentFs = {
    readFileSync: (p) => { const k = this.norm(p); if (!this.files.has(k)) {throw new Error('ENOENT ' + p)} return this.files.get(k)! },
    writeFileSync: (p, data) => { this.files.set(this.norm(p), data) },
    existsSync: (p) => { const k = this.norm(p); return this.files.has(k) || this.dirs.has(k) },
    mkdirSync: (p, opts) => { if (opts.recursive) {this.dirs.add(this.norm(p))} },
    readdirSync: (p) => {
      const k = this.norm(p).replace(/\/$/, '')
      const set = new Set<string>()
      for (const d of this.dirs) {
        const prefix = k + '/'
        if (d.startsWith(prefix)) {
          const rest = d.slice(prefix.length)
          const child = rest.split('/')[0]
          if (child) {set.add(child)}
        }
      }
      for (const f of this.files.keys()) {
        const prefix = k + '/'
        if (f.startsWith(prefix)) {
          const rest = f.slice(prefix.length)
          const child = rest.split('/')[0]
          if (child) {set.add(child)}
        }
      }
      return [...set]
    },
    rmSync: (p, _opts) => {
      const k = this.norm(p).replace(/\/$/, '')
      for (const key of [...this.files.keys()]) { if (key === k || key.startsWith(k + '/')) {this.files.delete(key)} }
      for (const d of [...this.dirs]) { if (d === k || d.startsWith(k + '/')) {this.dirs.delete(d)} }
    },
  }
}

describe('isValidAgentId', () => {
  it('合法 id 通过', () => {
    expect(isValidAgentId('my_agent')).toBe(true)
    expect(isValidAgentId('X1-bot')).toBe(true)
  })
  it('非法 id 拒绝（路径穿越/纯数字/空）', () => {
    expect(isValidAgentId('../etc')).toBe(false)
    expect(isValidAgentId('1abc')).toBe(false)
    expect(isValidAgentId('')).toBe(false)
    expect(isValidAgentId('a b')).toBe(false)
  })
})

describe('CustomAgentManager CRUD', () => {
  let mgr: CustomAgentManager
  let mem: MemFs
  beforeEach(() => {
    mem = new MemFs()
    mem.dirs.add('/root/electron/agents/custom')
    mgr = new CustomAgentManager('/root/electron/agents/custom', mem.fs)
  })

  it('创建 Agent 并写入 4 件套', () => {
    const cfg = mgr.createAgent({ id: 'helper', name: '我的助手', personality: '热心' })
    expect(cfg.id).toBe('helper')
    expect(cfg.toolsets).toContain('agent')
    expect(mem.files.has('/root/electron/agents/custom/helper/agent.json')).toBe(true)
    expect(mem.files.has('/root/electron/agents/custom/helper/SOUL.md')).toBe(true)
    expect(mem.files.has('/root/electron/agents/custom/helper/PROFILE.md')).toBe(true)
    expect(mem.files.has('/root/electron/agents/custom/helper/MEMORY.md')).toBe(true)
  })

  it('重复 id 抛错', () => {
    mgr.createAgent({ id: 'dup' })
    expect(() => mgr.createAgent({ id: 'dup' })).toThrow(/已存在/)
  })

  it('列出全部并按名字排序', () => {
    mgr.createAgent({ id: 'b1', name: 'B' })
    mgr.createAgent({ id: 'a2', name: 'A' })
    const list = mgr.listCustomAgents()
    expect(list.map(a => a.name)).toEqual(['A', 'B'])
  })

  it('getAgent 读取单个', () => {
    mgr.createAgent({ id: 'g1', name: '读我' })
    const cfg = mgr.getAgent('g1')
    expect(cfg && cfg.name).toBe('读我')
    expect(mgr.getAgent('nope')).toBeNull()
  })

  it('updateAgent 更新配置并重写 SOUL', () => {
    mgr.createAgent({ id: 'u1' })
    const cfg = mgr.updateAgent('u1', { name: '新名字', soulContent: '# 全新人格' })
    expect(cfg.name).toBe('新名字')
    expect(mgr.readSoul('u1')).toBe('# 全新人格')
  })

  it('deleteAgent 删除目录', () => {
    mgr.createAgent({ id: 'd1' })
    mgr.deleteAgent('d1')
    expect(mgr.getAgent('d1')).toBeNull()
    expect(mem.files.has('/root/electron/agents/custom/d1/agent.json')).toBe(false)
  })

  it('update 非法 id 抛错', () => {
    expect(() => mgr.updateAgent('../evil', {})).toThrow()
  })
})

describe('normalizeAgentConfig 默认值', () => {
  it('填充默认工具集与角色', () => {
    const cfg = normalizeAgentConfig({ id: 'c1' })
    expect(cfg.toolsets).toEqual(['agent', 'files_core'])
    expect(cfg.teamRole).toBe('member')
    expect(cfg.soulFile).toBe('SOUL.md')
    expect(cfg.visible).toBe(true)
  })
  it('非法 id 抛错', () => {
    expect(() => normalizeAgentConfig({ id: '9bad' })).toThrow()
  })
})
