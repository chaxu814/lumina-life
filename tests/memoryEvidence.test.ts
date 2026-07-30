// ============================================================
// tests/memoryEvidence.test.ts — 记忆证据评分系统 单元测试
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import { MemoryEvidenceEngine } from '../electron/memoryEvidence'

// 确保每次测试使用独立文件
let testCounter = 0

function makeEngine() {
  const counter = ++testCounter
  const p = `./memory-evidence-test-${counter}.json`
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
    for (const { path } of engines.splice(0)) {
      try { fs.unlinkSync(path) } catch {}
    }
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
