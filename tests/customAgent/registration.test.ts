// tests/customAgent/registration.test.ts — 自定义 Agent 注册到团队单测
import { describe, it, expect, beforeEach } from 'vitest'
import {
  CustomAgentManager,
  registerCustomAgents,
  type AgentFs,
} from '../../electron/agents/customAgentManager'

/** 与 manager.test.ts 同款内存 fs（已验证可工作） */
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
      const collect = (entry: string) => {
        const prefix = k + '/'
        if (entry.startsWith(prefix)) {
          const child = entry.slice(prefix.length).split('/')[0]
          if (child) {set.add(child)}
        }
      }
      this.dirs.forEach(collect)
      this.files.forEach((_v, f) => collect(f))
      return [...set]
    },
    rmSync: (p) => {
      const k = this.norm(p).replace(/\/$/, '')
      for (const key of [...this.files.keys()]) { if (key === k || key.startsWith(k + '/')) {this.files.delete(key)} }
      for (const d of [...this.dirs]) { if (d === k || d.startsWith(k + '/')) {this.dirs.delete(d)} }
    },
  }
}

function makeManager(): CustomAgentManager {
  const mem = new MemFs()
  mem.dirs.add('/root/electron/agents/custom')
  return new CustomAgentManager('/root/electron/agents/custom', mem.fs)
}

describe('registerCustomAgents', () => {
  let mgr: CustomAgentManager
  beforeEach(() => {
    mgr = makeManager()
    delete (global as any).__lumina_custom_profiles
  })

  it('把可见 Agent 注册到 global.__lumina_custom_profiles', () => {
    mgr.createAgent({ id: 'researcher', name: '研究员', teamRole: 'member' })
    const profiles = registerCustomAgents(mgr)
    expect(profiles).toHaveLength(1)
    expect(profiles[0].id).toBe('custom_researcher')
    expect(profiles[0].role).toBe('worker')
    expect((global as any).__lumina_custom_profiles).toHaveLength(1)
  })

  it('leader 角色映射为 boss 角色', () => {
    mgr.createAgent({ id: 'lead', name: '领队', teamRole: 'leader' })
    const profiles = registerCustomAgents(mgr)
    expect(profiles[0].role).toBe('boss')
  })

  it('不可见 Agent 不注册', () => {
    mgr.createAgent({ id: 'hidden', name: '隐藏', visible: false })
    const profiles = registerCustomAgents(mgr)
    expect(profiles).toHaveLength(0)
  })

  it('注册后包含 SOUL 作为 systemPrompt', () => {
    mgr.createAgent({ id: 'writer', name: '写手' })
    mgr.updateAgent('writer', { soulContent: '# 写手人格\n你只写文章。' })
    const profiles = registerCustomAgents(mgr)
    expect(profiles[0].systemPrompt).toContain('写手人格')
  })
})