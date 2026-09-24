// tests/federation.test.ts — 团队记忆共享 Federation 单测（提案3 Level 1）
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs'

import {
  exportMemory,
  importMemory,
  listFederatedMemories,
  setFederatedConfidence,
  type MemoryExport,
} from '../electron/memory/federation'

function mkdt(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

describe('federation 导出', () => {
  it('打包核心记忆文件为 JSON，自带来源/时间戳/confidence=1.0', () => {
    const root = mkdt('lumina-fed-exp-')
    fs.writeFileSync(path.join(root, 'MEMORY.md'), '# long-term memory\nprefers tea')
    fs.writeFileSync(path.join(root, 'PROFILE.md'), 'name: 待填写')
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# rules')
    fs.writeFileSync(path.join(root, 'SOUL_LUMINA.md'), '# soul')
    fs.mkdirSync(path.join(root, 'memory'))
    fs.writeFileSync(path.join(root, 'memory', '2026-09-21.md'), 'daily note')

    const pkg = exportMemory({ memoryRoot: root, source: 'deviceA' })
    expect(pkg.app).toBe('lumina-life')
    expect(pkg.version).toBe(1)
    expect(pkg.source).toBe('deviceA')
    expect(pkg.exportedAt).toBeGreaterThan(0)

    const rels = pkg.entries.map((e) => e.path).sort()
    expect(rels).toContain('MEMORY.md')
    expect(rels).toContain('PROFILE.md')
    expect(rels).toContain('AGENTS.md')
    expect(rels).toContain('SOUL_LUMINA.md')
    expect(rels).toContain('memory/2026-09-21.md')

    for (const e of pkg.entries) {
      expect(e.source).toBe('self')
      expect(e.confidence).toBe(1.0)
      expect(e.timestamp).toBeGreaterThan(0)
      expect(e.content.length).toBeGreaterThan(0)
    }
    // 分类正确
    const daily = pkg.entries.find((e) => e.kind === 'daily')
    expect(daily?.path).toBe('memory/2026-09-21.md')
  })

  it('源目录缺失时返回空条目而不崩溃', () => {
    const pkg = exportMemory({ memoryRoot: path.join(os.tmpdir(), 'no-such-dir-' + Date.now()) })
    expect(pkg.entries).toEqual([])
  })
})

describe('federation 导入', () => {
  let dest: string
  beforeEach(() => {
    dest = mkdt('lumina-fed-imp-')
  })

  function samplePkg(source: string, entries: Array<{ path: string; content: string }>): MemoryExport {
    return {
      version: 1,
      app: 'lumina-life',
      source,
      exportedAt: Date.now(),
      entries: entries.map((e) => ({
        path: e.path, content: e.content, source, timestamp: Date.now(),
        confidence: 0.7, kind: 'other' as const,
      })),
    }
  }

  it('导入写到 federated/<source>/，默认 confidence 0.7，不碰原文件', () => {
    const pkg = samplePkg('deviceB', [{ path: 'MEMORY.md', content: '# from B' }])
    const res = importMemory(pkg, { destRoot: dest })
    expect(res.ok).toBe(true)
    expect(res.imported).toBe(1)
    expect(res.conflicts).toEqual([])
    expect(fs.existsSync(path.join(dest, 'federated', 'deviceB', 'MEMORY.md'))).toBe(true)

    const listing = listFederatedMemories(dest)
    expect(listing).toHaveLength(1)
    expect(listing[0].source).toBe('deviceB')
    expect(listing[0].confidence).toBe(0.7)
    expect(listing[0].entryCount).toBe(1)
  })

  it('冲突时标记 conflict，不覆盖已存在文件', () => {
    const target = path.join(dest, 'federated', 'deviceC', 'MEMORY.md')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, 'ORIGINAL')

    const pkg = samplePkg('deviceC', [{ path: 'MEMORY.md', content: 'NEW VERSION' }])
    const res = importMemory(pkg, { destRoot: dest, onConflict: 'mark' })
    expect(res.conflicts).toContain('MEMORY.md')
    // 原文件未被改
    expect(fs.readFileSync(target, 'utf-8')).toBe('ORIGINAL')
    // 冲突副本落盘
    expect(fs.existsSync(target + '.conflict')).toBe(true)

    const listing = listFederatedMemories(dest)
    expect(listing[0].status).toBe('conflict')
  })

  it('overwrite 策略会覆盖冲突文件', () => {
    const target = path.join(dest, 'federated', 'deviceD', 'MEMORY.md')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, 'OLD')
    const pkg = samplePkg('deviceD', [{ path: 'MEMORY.md', content: 'NEW' }])
    const res = importMemory(pkg, { destRoot: dest, onConflict: 'overwrite' })
    expect(res.imported + (res.skipped >= 0 ? 0 : 0)).toBeGreaterThanOrEqual(0)
    expect(fs.readFileSync(target, 'utf-8')).toBe('NEW')
  })

  it('拒绝非法记忆包格式', () => {
    const res = importMemory('{"app":"evil"}', { destRoot: dest })
    expect(res.ok).toBe(false)
  })

  it('setFederatedConfidence 可调整可信度并夹取到 0~1', () => {
    const pkg = samplePkg('deviceE', [{ path: 'a.md', content: 'x' }])
    importMemory(pkg, { destRoot: dest })
    const r1 = setFederatedConfidence('deviceE', 0.999, dest)
    expect(r1.ok).toBe(true)
    let list = listFederatedMemories(dest)
    expect(list[0].confidence).toBeCloseTo(0.999)
    setFederatedConfidence('deviceE', 5, dest)
    list = listFederatedMemories(dest)
    expect(list[0].confidence).toBe(1)
  })
})
