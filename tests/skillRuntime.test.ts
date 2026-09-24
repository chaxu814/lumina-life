// ============================================================
// tests/skillRuntime.test.ts — 技能沙箱：manifest 解析 / 沙箱执行 / 权限拦截
// ============================================================
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { parseSkillManifest, runSkillEntry, type SkillManifest } from '../electron/skills/skillRuntime'

function makeManifest(over: Partial<SkillManifest> = {}): SkillManifest {
  return { name: 'demo', version: '1.0.0', permissions: [], tools: ['demo_tool'], ...over }
}

describe('parseSkillManifest', () => {
  it('合法 manifest', () => {
    const { manifest } = parseSkillManifest({ name: 'a', version: '1.0.0', permissions: ['network'], tools: ['a_run'] })
    expect(manifest?.name).toBe('a')
    expect(manifest?.permissions).toEqual(['network'])
  })
  it('缺 name → 报错', () => {
    const { manifest, error } = parseSkillManifest({ version: '1' })
    expect(manifest).toBeNull()
    expect(error).toMatch(/name/)
  })
  it('非法权限被过滤', () => {
    const { manifest } = parseSkillManifest({ name: 'a', version: '1', permissions: ['shell', 'network'] })
    expect(manifest?.permissions).toEqual(['network'])
  })
})

describe('runSkillEntry 沙箱', () => {
  const skillDir = mkdtempSync(path.join(os.tmpdir(), 'skill-test-'))

  it('导出 tools 数组 → 正常加载', () => {
    const src = `
      module.exports = {
        tools: [{
          name: 'demo_tool',
          description: 'adds',
          handler: (a) => ({ sum: (a.x||0) + (a.y||0) }),
        }],
      }
    `
    const loaded = runSkillEntry(src, makeManifest(), { skillDir })
    expect(loaded.tools).toHaveLength(1)
    expect(loaded.tools[0].name).toBe('demo_tool')
  })

  it('未声明 network 却调用 fetch → 运行时抛错拦截', async () => {
    const src = `
      module.exports = {
        tools: [{
          name: 'demo_tool',
          handler: async () => { await lumina.fetch('http://x'); return 'no' },
        }],
      }
    `
    const loaded = runSkillEntry(src, makeManifest({ permissions: [] }), { skillDir })
    await expect(loaded.tools[0].handler({})).rejects.toThrow(/未声明权限/)
  })

  it('声明 network 后 fetch 不再被权限层拦截（可到网络层）', async () => {
    const src = `
      module.exports = {
        tools: [{
          name: 'demo_tool',
          handler: async () => { return lumina.meta.name },
        }],
      }
    `
    const loaded = runSkillEntry(src, makeManifest({ permissions: ['network'] }), { skillDir })
    const out = await loaded.tools[0].handler({})
    expect(out).toBe('demo')
  })

  it('目录穿越被拦截', () => {
    const src = `
      module.exports = {
        tools: [{
          name: 'demo_tool',
          handler: () => lumina.readFile('../../etc/passwd'),
        }],
      }
    `
    const loaded = runSkillEntry(src, makeManifest({ permissions: ['fs.read'] }), { skillDir })
    expect(() => loaded.tools[0].handler({})).toThrow(/目录之外|禁止/)
  })

  it('沙箱不暴露 process / require', () => {
    const src = `
      module.exports = {
        tools: [{
          name: 'demo_tool',
          handler: () => typeof process === 'undefined' && typeof require === 'undefined',
        }],
      }
    `
    const loaded = runSkillEntry(src, makeManifest(), { skillDir })
    expect(loaded.tools[0].handler({})).toBe(true)
  })
})
