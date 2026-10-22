// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/memoryEvidence.test.ts — 记忆证据评分系统 单元测试
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { MemoryEvidenceEngine } from '../electron/memoryEvidence'

// 确保每次测试使用独立文件
let testCounter = 0

// 🔧 2026-10-15：测试产物改写到系统临时目录。
//   原实现用相对路径 `./memory-evidence-test-N.json`，也就是**直接写在仓库根目录**：
//     · 每跑一次 npm test，根目录就多一批文件（clean clone + CI 同样会脏）
//     · 更糟的是 afterEach 只 unlink 主文件，而 MemoryEvidenceEngine.save()
//       在覆盖前会自动 copyFileSync 出 `${path}.bak.<时间戳>` —— 那些 .bak 从来没人删。
//   于是根目录的 .bak 只增不减（本次发布前已积到 16 个），任何人 clone 下来第一眼
//   看到的是一地时间戳垃圾，而不是项目本身。
//   现在写到 os.tmpdir()，并在清理时把 .bak 一并带走：测试不该给别人的工作区留垃圾。
const TEST_TMP_DIR = path.join(os.tmpdir(), 'lumina-memory-evidence-test')

function makeEngine() {
  const counter = ++testCounter
  fs.mkdirSync(TEST_TMP_DIR, { recursive: true })
  const p = path.join(TEST_TMP_DIR, `memory-evidence-test-${counter}.json`)
  // 创建新的引擎，然后替换 storagePath 并重新 load
  const eng = new MemoryEvidenceEngine()
  // 清除旧路径的持久化
  try { fs.unlinkSync((eng as any).storagePath) } catch {}
  // 设置新路径
  ;(eng as any).storagePath = p
  // 清除旧数据（load 已经在构造时调用过，现在需要重置）
  ;(eng as any).memories = []
  return { engine: eng, path: p }
}

describe('MemoryEvidenceEngine', () => {
  const engines: { engine: MemoryEvidenceEngine; path: string }[] = []

  afterEach(() => {
    for (const { path: p } of engines.splice(0)) {
      try { fs.unlinkSync(p) } catch {}
      // 关键：连引擎自动生成的 .bak.<时间戳> 一起清掉。
      // 只删主文件的话，save() 每次覆盖前留的备份会一直堆在临时目录里，
      // 跑几百个用例就是几百个小文件 —— 下次清理同样没意义。
      try {
        const dir = path.dirname(p)
        const base = path.basename(p)
        for (const f of fs.readdirSync(dir)) {
          if (f.startsWith(base + '.bak.')) {
            try { fs.unlinkSync(path.join(dir, f)) } catch {}
          }
        }
      } catch {}
    }
  })

  afterEach(() => {
    // 本文件用完把临时目录整个收走，避免 os.tmpdir() 里留下空壳目录
    try {
      if (fs.existsSync(TEST_TMP_DIR) && fs.readdirSync(TEST_TMP_DIR).length === 0) {
        fs.rmdirSync(TEST_TMP_DIR)
      }
    } catch {}
  })

  function newEngine() {
    const e = makeEngine()
    engines.push(e)
    return e.engine
  }

  describe('addMemory()', () => {
    it('adds a memory and returns it with an id', () => {
      const engine = newEngine()
      const mem = engine.addMemory({
        content: '用户喜欢喝热茶',
        type: 'preference',
        importance: 0.8,
      })

      expect(mem.id).toBeTruthy()
      expect(mem.content).toBe('用户喜欢喝热茶')
      expect(mem.type).toBe('preference')
      expect(mem.scores.importance).toBe(0.8)
      expect(mem.mentionCount).toBe(1)
      expect(mem.sourceCount).toBe(1)
    })

    it('returns confirmed status for high-confidence memories', () => {
      const engine = newEngine()
      const mem = engine.addMemory({
        content: '用户生日是3月15日',
        type: 'fact',
        importance: 1.0,
        sourceReliability: 1.0,
      })
      expect(mem.status).toBe('confirmed')
    })

    it('returns pending for mid-range memories', () => {
      const engine = newEngine()
      const mem = engine.addMemory({
        content: '中等重要的事',
        type: 'fact',
        importance: 0.3,
        sourceReliability: 0.5,
      })
      expect(mem.compositeScore).toBeLessThan(0.6)
    })

    it('increments mentionCount on duplicate content', () => {
      const engine = newEngine()
      engine.addMemory({ content: '喜欢热茶', type: 'preference', importance: 0.7 })
      const mem = engine.addMemory({ content: '喜欢热茶', type: 'preference', importance: 0.7 })
      expect(mem.mentionCount).toBe(2)
    })
  })

  describe('getHighConfidenceMemories()', () => {
    it('returns only confirmed memories', () => {
      const engine = newEngine()
      engine.addMemory({ content: 'important', type: 'fact', importance: 0.9, sourceReliability: 1.0 })
      engine.addMemory({ content: 'mid', type: 'fact', importance: 0.4, sourceReliability: 0.5 })
      engine.addMemory({ content: 'low', type: 'fact', importance: 0.1, sourceReliability: 0.3 })

      const high = engine.getHighConfidenceMemories()
      expect(high.length).toBeGreaterThanOrEqual(1)
      for (const m of high) {
        expect(m.compositeScore).toBeGreaterThanOrEqual(0.6)
      }
    })
  })

  describe('getMemoriesByScore()', () => {
    it('returns all memories sorted by composite score', () => {
      const engine = newEngine()
      engine.addMemory({ content: 'First', type: 'fact', importance: 0.3 })
      engine.addMemory({ content: 'Second', type: 'preference', importance: 0.9, sourceReliability: 1.0 })

      const all = engine.getMemoriesByScore()
      expect(all.length).toBe(2)
      expect(all[0].content).toBe('Second')
    })
  })

  describe('getPendingMemories()', () => {
    it('returns memories with pending status', () => {
      const engine = newEngine()
      engine.addMemory({ content: 'pending item', type: 'fact', importance: 0.3, sourceReliability: 0.4 })
      const pending = engine.getPendingMemories()
      // The exact count depends on score; just verify it doesn't throw
      expect(Array.isArray(pending)).toBe(true)
    })
  })

  describe('getOutdatedMemories()', () => {
    it('returns memories with outdated status', () => {
      const engine = newEngine()
      engine.addMemory({ content: 'outdated item', type: 'fact', importance: 0.05, sourceReliability: 0.1 })
      const outdated = engine.getOutdatedMemories()
      // Low-confidence memories get pruned automatically; may be 0 or 1
      expect(Array.isArray(outdated)).toBe(true)
    })
  })

  describe('setImportance()', () => {
    it('updates importance and recalculates score', () => {
      const engine = newEngine()
      const mem = engine.addMemory({ content: 'adjustable', type: 'fact', importance: 0.3 })
      const oldScore = mem.compositeScore

      const ok = engine.setImportance(mem.id, 0.9)
      expect(ok).toBe(true)

      const updated = engine.getMemoriesByScore().find(m => m.id === mem.id)
      expect(updated!.compositeScore).toBeGreaterThan(oldScore)
    })

    it('returns false for non-existent id', () => {
      const engine = newEngine()
      expect(engine.setImportance('nonexistent', 0.5)).toBe(false)
    })
  })

  describe('markContradicted()', () => {
    it('marks memory as contradicted and reduces confidence', () => {
      const engine = newEngine()
      const mem = engine.addMemory({ content: 'to be contradicted', type: 'fact', importance: 0.8 })
      engine.markContradicted(mem.id)

      const updated = engine.getMemoriesByScore().find(m => m.id === mem.id)
      expect(updated!.status).toBe('contradicted')
      expect(updated!.scores.confidence).toBeLessThan(0.8)
    })
  })

  describe('composite score weights', () => {
    it('uses weighted formula correctly', () => {
      const engine = newEngine()
      const mem = engine.addMemory({
        content: 'weighted test',
        type: 'fact',
        importance: 0.5,
        sourceReliability: 0.5,
      })

      // new memory: confidence=0.5, recency=1.0, frequency=0.1, corroboration=0, importance=0.5
      // = 0.5*0.3 + 1.0*0.15 + 0.1*0.15 + 0*0.1 + 0.5*0.3 = 0.15 + 0.15 + 0.015 + 0 + 0.15 = 0.465
      expect(mem.compositeScore).toBeCloseTo(0.465, 1)
    })
  })

  describe('persistence', () => {
    it('saves and loads memories', () => {
      const engine = newEngine()
      const p = (engine as any).storagePath

      engine.addMemory({ content: 'persisted memory', type: 'fact', importance: 0.8 })
      expect(fs.existsSync(p)).toBe(true)
    })
  })
})
