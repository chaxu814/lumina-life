// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// tests/memoryConfidence.test.ts — 记忆可信度（防幻觉固化）回归测试
//
// 背景：旧实现里模型只要调一次 memory_save，就写进 confidence=1.0 / source='user_said'，
// 之后 memory_get 把「(100%)」喂回模型 —— 一次编造被永久固化成权威事实，且没有纠正路径。
// 这里锁住四条规则：来源决定置信度 / 外部 confidence 一律 clamp / 低置信度带「未验证」标注 /
// 写入去重 + 高置信度覆盖低置信度 + 旧数据迁移后降权。
//
// ⚠️ better-sqlite3 的 .node 二进制是给 Electron 编译的，系统 Node 下加载会失败，
//    所以这里用 Node 内置的 node:sqlite 顶替（API 子集兼容：exec/prepare/run/get/all/pragma）。

import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('electron', () => ({
  app: { getPath: () => process.cwd(), getVersion: () => '0.0.0-test' },
  ipcMain: { handle: () => {} },
}))

vi.mock('better-sqlite3', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  class NodeSqliteShim {
    private db: any
    constructor(filename?: string) { this.db = new DatabaseSync(filename || ':memory:') }
    pragma(stmt: string) { this.db.exec(`PRAGMA ${stmt}`) }
    exec(sql: string) { this.db.exec(sql) }
    prepare(sql: string) {
      const stmt = this.db.prepare(sql)
      return {
        run: (...p: any[]) => stmt.run(...p),
        get: (...p: any[]) => stmt.get(...p),
        all: (...p: any[]) => stmt.all(...p),
      }
    }
    close() { this.db.close() }
  }
  return { default: NodeSqliteShim }
})

import {
  MemoryStore,
  normalizeFactSource,
  resolveConfidence,
  resolveSourceCap,
  clampConfidence,
  normalizeFactContent,
  factContentKey,
  markUnverifiedFact,
  SOURCE_CONFIDENCE,
  LEGACY_CONFIDENCE_CAP,
  UNVERIFIED_CONFIDENCE,
} from '../electron/memory/memoryStore'

let store: MemoryStore
beforeEach(() => {
  store = new MemoryStore(':memory:')
})

describe('来源强度 → 置信度', () => {
  it('三种 source 落库的 confidence 分别是 0.95 / 1.0 / 0.6', () => {
    store.addFact({ category: 'user', content: '用户说喜欢 pnpm', source: 'user_stated' })
    store.addFact({ category: 'user', content: '用户确认部署用 electron-builder', source: 'user_confirmed' })
    store.addFact({ category: 'user', content: '用户可能在用 Rust', source: 'model_inferred' })

    expect(store.getFacts('user', 10).find(f => f.content === '用户说喜欢 pnpm')!.confidence).toBeCloseTo(0.95)
    expect(store.getFacts('user', 10).find(f => f.content === '用户确认部署用 electron-builder')!.confidence).toBeCloseTo(1.0)
    expect(store.getFacts('user', 10).find(f => f.content === '用户可能在用 Rust')!.confidence).toBeCloseTo(0.6)
  })

  it('不传 source 时默认 model_inferred（≤0.6）', () => {
    store.addFact({ category: 'user', content: '模型自己脑补的偏好' })
    expect(store.getFacts('user', 10)[0].confidence).toBeLessThanOrEqual(0.6)
    expect(store.getFacts('user', 10)[0].source).toBe('model_inferred')
  })

  it('外部传 confidence:1.0 + model_inferred → 被 clamp 到 ≤0.6', () => {
    store.addFact({ category: 'user', content: '模型自称 100% 确定的事', confidence: 1.0, source: 'model_inferred' })
    const f = store.getFacts('user', 10)[0]
    expect(f.confidence).toBeLessThanOrEqual(0.6)
  })

  it('外部传 confidence 超出上限一律向下 clamp（user_stated 传 1.0 → 0.95）', () => {
    store.addFact({ category: 'user', content: '用户说过的一句话', confidence: 1.0, source: 'user_stated' })
    expect(store.getFacts('user', 10)[0].confidence).toBeCloseTo(0.95)
  })

  it('纯函数：clampConfidence / resolveConfidence / resolveSourceCap', () => {
    expect(clampConfidence(1.0, 0.6)).toBe(0.6)
    expect(clampConfidence(undefined, 0.6)).toBe(0.6)   // 没传就用上限（=缺省值）
    expect(clampConfidence(-1, 0.6)).toBe(0)
    expect(resolveConfidence('model_inferred', 0.9)).toBe(0.6)
    expect(resolveConfidence('user_confirmed', 1.0)).toBe(1.0)
    // 旧来源按 user_said 处理但上限压到 0.9
    expect(resolveSourceCap('user_said')).toBe(LEGACY_CONFIDENCE_CAP)
    expect(resolveConfidence('user_said', 1.0)).toBe(0.9)
    expect(resolveSourceCap(null)).toBe(LEGACY_CONFIDENCE_CAP)
    expect(SOURCE_CONFIDENCE.user_confirmed.cap).toBe(1.0)
    expect(SOURCE_CONFIDENCE.user_stated.cap).toBe(0.95)
    expect(SOURCE_CONFIDENCE.model_inferred.cap).toBe(0.6)
  })

  it('normalizeFactSource 归一化旧枚举 / 未知值', () => {
    expect(normalizeFactSource('user_stated')).toBe('user_stated')
    expect(normalizeFactSource('user_said')).toBe('user_stated')     // 旧枚举
    expect(normalizeFactSource('observed')).toBe('model_inferred')   // 模型自称观察到
    expect(normalizeFactSource('inferred')).toBe('model_inferred')
    expect(normalizeFactSource(undefined)).toBe('model_inferred')
    expect(normalizeFactSource('瞎写的')).toBe('model_inferred')
  })
})

describe('低置信度标注', () => {
  it('memory_get 对低置信度带「未验证」标注、高置信度不带', async () => {
    const { memoryGet } = await import('../electron/tools/impl/memory_v2')
    const lines: string[] = []

    store.addFact({ category: 'user', content: '模型推断：用户住在杭州', source: 'model_inferred' })
    store.addFact({ category: 'user', content: '用户亲口说住在杭州', source: 'user_stated' })
    store.addFact({ category: 'user', content: '用户确认生日是 3 月 1 日', source: 'user_confirmed' })

    // memory_v2 走的是全局单例，测试里替换成当前 :memory: 实例
    const storeMod = await import('../electron/memory/memoryStore')
    vi.spyOn(storeMod, 'getMemoryStore').mockReturnValue(store)

    const out = await memoryGet({ section: 'facts' })
    expect(out.ok).toBe(true)
    for (const l of out.content.split('\n')) {lines.push(l)}

    const inferred = lines.find(l => l.includes('模型推断：用户住在杭州'))!
    const stated = lines.find(l => l.includes('用户亲口说住在杭州'))!
    const confirmed = lines.find(l => l.includes('用户确认生日是 3 月 1 日'))!

    expect(inferred).toContain('未验证')
    expect(inferred).toContain('60%')
    expect(stated).not.toContain('未验证')
    expect(confirmed).not.toContain('未验证')
    expect(confirmed).toContain('100%')
    vi.restoreAllMocks()
  })

  it('markUnverifiedFact：< 0.8 标注，其余只给百分比', () => {
    expect(markUnverifiedFact('x', { confidence: 0.6 })).toBe('x【未验证·模型推断，置信度 60%】')
    expect(markUnverifiedFact('x', { confidence: 0.95 })).toBe('x（95%）')
    expect(markUnverifiedFact('x', { confidence: UNVERIFIED_CONFIDENCE })).toBe('x（80%）')
  })

  it('注入 System Prompt 的记忆文本同样带「未验证」标注', () => {
    store.addFact({ category: 'user', content: '模型推断：用户是画家', source: 'model_inferred' })
    expect(store.getMemoryInjectionText()).toContain('未验证')
  })
})

describe('写入去重与纠正', () => {
  it('同内容重复写入不产生重复行（含标点/大小写/空白差异）', () => {
    store.addFact({ category: 'user', content: '用户喜欢 TypeScript', source: 'user_stated' })
    store.addFact({ category: 'user', content: '  用户喜欢 typescript！ ', source: 'user_stated' })
    store.addFact({ category: 'user', content: '用户喜欢 TypeScript', source: 'user_confirmed' })

    expect(store.getFacts('user', 50)).toHaveLength(1)
    const raw = store.getDb().prepare('SELECT COUNT(*) as c FROM facts').get() as { c: number }
    expect(raw.c).toBe(1)
  })

  it('normalizeFactContent / factContentKey 归一化一致', () => {
    expect(normalizeFactContent('  用户 喜欢  TypeScript！ ')).toBe(normalizeFactContent('用户喜欢typescript'))
    expect(factContentKey('user', '用户喜欢 TypeScript')).toBe(factContentKey('user', '用户喜欢typescript'))
    expect(factContentKey('user', 'a')).not.toBe(factContentKey('event', 'a'))
  })

  it('高置信度覆盖低置信度：旧记录被替换，不并存两条', () => {
    store.addFact({ category: 'user', content: '用户用 vite 构建', source: 'model_inferred' })
    expect(store.getFacts('user', 50)[0].confidence).toBeCloseTo(0.6)

    store.addFact({ category: 'user', content: '用户用 vite 构建', source: 'user_confirmed' })
    const all = store.getFacts('user', 50)
    expect(all).toHaveLength(1)                       // 没有两条矛盾事实并存
    expect(all[0].confidence).toBeCloseTo(1.0)
    expect(all[0].source).toBe('user_confirmed')

    // 反向：更弱的说法不能把已确认的事实降级
    store.addFact({ category: 'user', content: '用户用 vite 构建', source: 'model_inferred' })
    expect(store.getFacts('user', 50)).toHaveLength(1)
    expect(store.getFacts('user', 50)[0].confidence).toBeCloseTo(1.0)
  })
})

describe('旧数据迁移', () => {
  let tmpDir = ''
  let legacyPath = ''

  /**
   * 造一个「老版本库」：先建表（走一遍当前 schema），再绕过 addFact 裸插老数据，最后关闭。
   * 下次 new MemoryStore(path) 就会触发迁移 —— 和真实用户升级时的路径一致。
   */
  function seedLegacyDb(rows: Array<{ content: string; confidence: number; source: string | null }>): void {
    const seeded = new MemoryStore(legacyPath)
    for (const r of rows) {
      seeded.getDb().prepare(
        "INSERT INTO facts (category, content, confidence, source, created_at) VALUES ('user',?,?,?,'2026-01-01')"
      ).run(r.content, r.confidence, r.source)
    }
    seeded.close()
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-memory-confidence-'))
    legacyPath = path.join(tmpDir, 'legacy-memory.db')
  })

  it('无 source 的老行：按 user_said 处理且 confidence ≤ 0.9', () => {
    seedLegacyDb([{ content: '老版本写死的假事实', confidence: 1.0, source: null }])
    store.close()

    store = new MemoryStore(legacyPath) // ← 迁移在这里发生
    const f = store.getFacts('user', 50)[0]
    expect(f.source).toBe('user_said')
    expect(f.confidence).toBeLessThanOrEqual(0.9)
    expect(f.confidence).not.toBe(1.0) // 绝不再以 100% 权威示人
  })

  it('迁移后旧的 user_said 行同样被压到 ≤0.9，且可被用户确认后的新写入覆盖', () => {
    seedLegacyDb([{ content: '老版本写死的第二条', confidence: 1.0, source: 'user_said' }])
    store.close()

    store = new MemoryStore(legacyPath)
    expect(store.getFacts('user', 50)[0].confidence).toBeLessThanOrEqual(LEGACY_CONFIDENCE_CAP)

    // 老行的内容指纹已由迁移回填 → 用户确认后可以走纠正路径（而不是并存两条矛盾事实）
    store.addFact({ category: 'user', content: '老版本写死的第二条', source: 'user_confirmed' })
    const all = store.getFacts('user', 50)
    expect(all).toHaveLength(1)
    expect(all[0].confidence).toBeCloseTo(1.0)
  })

  it('迁移是向后兼容的 ADD COLUMN，不删列不重建表；新枚举的 1.0 不被压', () => {
    store.close()
    store = new MemoryStore(legacyPath) // 建库 + 跑一次迁移
    const cols = (store.getDb().prepare('PRAGMA table_info(facts)').all() as Array<{ name: string }>).map(c => c.name)
    expect(cols).toEqual(expect.arrayContaining([
      'id', 'category', 'content', 'confidence', 'source', 'created_at', 'content_key', 'hit_count',
    ]))

    store.addFact({ category: 'user', content: '用户确认过的一条', source: 'user_confirmed' })
    store.close()

    // 再次启动 → 迁移重跑，不能把新枚举的 1.0 误压成 0.9（幂等）
    store = new MemoryStore(legacyPath)
    expect(store.getFacts('user', 50)[0].confidence).toBeCloseTo(1.0)
  })
})
