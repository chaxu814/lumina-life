// ============================================================
// tests/modelValidator.test.ts — Live2D 模型包安全校验
// ============================================================
import { describe, it, expect } from 'vitest'
import {
  scanExecutableFiles, schemaCheck, extractMocRel,
  validateModelPackage, type ModelValidatorFs,
} from '../electron/pet/modelValidator'

describe('scanExecutableFiles 恶意脚本检测', () => {
  it('正常资源文件 → 无 issue', () => {
    const issues = scanExecutableFiles(['mao_pro.model3.json', 'mao_pro.moc3', 'textures/tex01.png', 'motions/idle.mtn'])
    expect(issues).toHaveLength(0)
  })

  it('含 .js → block', () => {
    const issues = scanExecutableFiles(['model3.json', 'hax.js'])
    expect(issues.some((i) => i.level === 'block' && i.code === 'MODEL-JS-SCRIPT')).toBe(true)
  })

  it('含 .exe → block', () => {
    const issues = scanExecutableFiles(['model3.json', 'setup.exe'])
    expect(issues.every((i) => i.level === 'block')).toBe(true)
  })

  it('含 .html → warn（可能是预览页）', () => {
    const issues = scanExecutableFiles(['model3.json', 'preview.html'])
    expect(issues.some((i) => i.level === 'warn' && i.code === 'MODEL-HTML-PAGE')).toBe(true)
  })
})

describe('schemaCheck 复用 model3 校验', () => {
  it('缺 FileReferences → invalid', () => {
    expect(schemaCheck({ Version: 4 }).valid).toBe(false)
  })
  it('合法 → valid', () => {
    const r = schemaCheck({ Version: 4, FileReferences: { Moc: 'x.moc3', Textures: ['a.png'] } })
    expect(r.valid).toBe(true)
  })
})

describe('validateModelPackage 集成（注入内存 fs）', () => {
  function mem(files: Record<string, string>): ModelValidatorFs {
    // 归一化：Windows 下 path.join 会产生反斜杠路径，测试里只按 basename 查找
    const norm = (p: string) => p.replace(/\\/g, '/').split('/').pop() || p
    return {
      async readText(p) {
        const k = norm(p)
        if (!(k in files)) {throw new Error('no such file: ' + p)}
        return files[k]
      },
      async fileExists(p) {return norm(p) in files},
      async listFiles() {return Object.keys(files)},
    }
  }

  it('合法模型 + 无脚本 → pass', async () => {
    const fs = mem({
      'model3.json': JSON.stringify({ Version: 4, FileReferences: { Moc: 'm.moc3', Textures: ['t.png'] } }),
      'm.moc3': 'binary',
      't.png': 'x',
    })
    const out = await validateModelPackage('/model', 'model3.json', fs)
    expect(out.level).toBe('pass')
    expect(out.schemaValid).toBe(true)
  })

  it('moc3 缺失 → block', async () => {
    const fs = mem({
      'model3.json': JSON.stringify({ Version: 4, FileReferences: { Moc: 'missing.moc3', Textures: ['t.png'] } }),
      't.png': 'x',
    })
    const out = await validateModelPackage('/model', 'model3.json', fs)
    expect(out.level).toBe('block')
    expect(out.issues.some((i) => i.code === 'MODEL-MISSING-MOC')).toBe(true)
  })

  it('带恶意 .js → block', async () => {
    const fs = mem({
      'model3.json': JSON.stringify({ Version: 4, FileReferences: { Moc: 'm.moc3', Textures: ['t.png'] } }),
      'm.moc3': 'b',
      't.png': 'x',
      'loader.js': 'console.log(1)',
    })
    const out = await validateModelPackage('/model', 'model3.json', fs)
    expect(out.level).toBe('block')
    expect(out.issues.some((i) => i.code === 'MODEL-JS-SCRIPT')).toBe(true)
  })
})

describe('extractMocRel', () => {
  it('取到 Moc 字段', () => {
    expect(extractMocRel({ FileReferences: { Moc: 'a.moc3' } })).toBe('a.moc3')
    expect(extractMocRel(null)).toBeNull()
  })
})
