// tests/modelImporter.test.ts — Live2D 形象导入器测试（内存 fs，不碰真实磁盘）
import { describe, it, expect, vi } from 'vitest'
import {
  validateModel3,
  sanitizeModelName,
  isSafeRelativePath,
  collectReferencedFiles,
  planModelImport,
  executePlan,
  type ModelImporterFs,
} from '../electron/pet/modelImporter'

describe('validateModel3', () => {
  it('合法 Cubism4 模型通过', () => {
    const r = validateModel3({ Version: 4, FileReferences: { Moc: 'a.moc3', Textures: ['a.png'] } })
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })
  it('缺少 Moc / 错误后缀被拒', () => {
    expect(validateModel3({ Version: 4, FileReferences: {} }).valid).toBe(false)
    expect(validateModel3({ Version: 4, FileReferences: { Moc: 'a.txt' } }).valid).toBe(false)
  })
  it('Version 越界被拒', () => {
    expect(validateModel3({ Version: 2, FileReferences: { Moc: 'a.moc3' } }).valid).toBe(false)
  })
})

describe('sanitizeModelName', () => {
  it('去掉目录与扩展名、替换非法字符', () => {
    expect(sanitizeModelName('C:\\models\\My Cat!.model3.json')).toBe('My_Cat')
    expect(sanitizeModelName('haru/haru.model3.json')).toBe('haru')
  })
  it('空名走 fallback', () => {
    expect(sanitizeModelName('???', 'fb')).toBe('fb')
    expect(sanitizeModelName('', 'fb')).toBe('fb')
  })
})

describe('isSafeRelativePath', () => {
  it('放行普通相对路径', () => {
    expect(isSafeRelativePath('a.moc3')).toBe(true)
    expect(isSafeRelativePath('textures/a.png')).toBe(true)
  })
  it('拒绝目录穿越 / 绝对路径 / 盘符', () => {
    expect(isSafeRelativePath('../x.moc3')).toBe(false)
    expect(isSafeRelativePath('a/../../b')).toBe(false)
    expect(isSafeRelativePath('/etc/passwd')).toBe(false)
    expect(isSafeRelativePath('C:\\windows\\x')).toBe(false)
  })
})

describe('collectReferencedFiles', () => {
  it('收集 Moc/Textures/Motions/Expressions', () => {
    const refs = collectReferencedFiles({
      FileReferences: {
        Moc: 'a.moc3',
        Textures: ['t1.png', 't2.png'],
        Physics: 'physics.json',
        Motions: { idle: [{ File: 'm/idle.motion3.json' }] },
        Expressions: [{ File: 'e/exp.exp3.json' }],
      },
    })
    expect(refs).toContain('a.moc3')
    expect(refs).toContain('t2.png')
    expect(refs).toContain('physics.json')
    expect(refs).toContain('m/idle.motion3.json')
    expect(refs).toContain('e/exp.exp3.json')
  })
})

function makeFs(entryJson: Record<string, unknown>) {
  const mem: Record<string, string> = { '/src/cat/cat.model3.json': JSON.stringify(entryJson) }
  const copied: Array<[string, string]> = []
  const fs: ModelImporterFs = {
    readText: async p => {
      if (!(p in mem)) throw new Error('ENOENT ' + p)
      return mem[p]
    },
    fileExists: async p => p in mem,
    ensureDir: vi.fn(async () => {}),
    copyFile: vi.fn(async (f, t) => { copied.push([f, t]) }),
  }
  return { fs, copied }
}

describe('planModelImport / executePlan', () => {
  it('合法模型生成复制计划并执行', async () => {
    const { fs, copied } = makeFs({
      Version: 4,
      FileReferences: { Moc: 'cat.moc3', Textures: ['tex/a.png'] },
    })
    const plan = await planModelImport('/src/cat', 'cat.model3.json', '/models', 'My Cat', fs)
    expect(plan.modelName).toBe('My_Cat')
    expect(plan.targetDir).toBe('/models/My_Cat')
    const rels = plan.files.map(f => f.rel)
    expect(rels).toContain('cat.model3.json')
    expect(rels).toContain('cat.moc3')
    expect(rels).toContain('tex/a.png')

    const res = await executePlan(plan, fs)
    expect(res.fileCount).toBe(3)
    expect(copied).toHaveLength(3)
  })

  it('资源路径含 .. 时拒绝导入', async () => {
    const { fs } = makeFs({ Version: 4, FileReferences: { Moc: '../../../evil.moc3' } })
    await expect(planModelImport('/src/cat', 'cat.model3.json', '/models', 'x', fs)).rejects.toThrow(/不安全/)
  })

  it('入口 JSON 非法时报错', async () => {
    const mem: Record<string, string> = { '/s/m.model3.json': '{ not json' }
    const fs: ModelImporterFs = {
      readText: async p => mem[p], fileExists: async p => p in mem, ensureDir: async () => {}, copyFile: async () => {},
    }
    await expect(planModelImport('/s', 'm.model3.json', '/d', 'n', fs)).rejects.toThrow(/JSON/)
  })
})
