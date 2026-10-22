// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// tests/tokenEstimator.test.ts — TokenEstimator 单元测试
import { describe, it, expect } from 'vitest'
import { TokenEstimator } from '../electron/tokenEstimator'

describe('TokenEstimator', () => {
  describe('estimate()', () => {
    it('returns 0 for empty string', () => {
      const te = new TokenEstimator()
      expect(te.estimate('')).toBe(0)
    })

    it('estimates pure English text (~4 chars/token)', () => {
      const te = new TokenEstimator()
      const tokens = te.estimate('Hello World')
      expect(tokens).toBeGreaterThanOrEqual(2)
      expect(tokens).toBeLessThanOrEqual(5)
    })

    it('estimates pure Chinese text (~1.5 chars/token)', () => {
      const te = new TokenEstimator()
      const tokens = te.estimate('这是一段中文测试文本用于验证')
      expect(tokens).toBeGreaterThanOrEqual(5)
      expect(tokens).toBeLessThanOrEqual(15)
    })

    it('is roughly linear with text length', () => {
      const te = new TokenEstimator()
      const short = te.estimate('hello')
      const long = te.estimate('hello '.repeat(100))
      expect(long).toBeGreaterThan(short * 50)
    })
  })

  describe('estimateMessages()', () => {
    it('sums across multiple messages', () => {
      const te = new TokenEstimator()
      const msgs = [
        { content: 'Hello', role: 'user' },
        { content: 'World', role: 'assistant' },
      ]
      expect(te.estimateMessages(msgs)).toBeGreaterThan(0)
    })

    it('includes tool_calls if present', () => {
      const te = new TokenEstimator()
      const msgs = [
        { content: 'run', role: 'assistant', tool_calls: [{ name: 'test', args: '{}' }] },
      ]
      const withTools = te.estimateMessages(msgs)
      const withoutTools = te.estimate('run')
      expect(withTools).toBeGreaterThan(withoutTools)
    })

    it('returns 0 for empty array', () => {
      const te = new TokenEstimator()
      expect(te.estimateMessages([])).toBe(0)
    })
  })

  describe('accumulation & thresholds', () => {
    it('add() and getTotal() accumulate correctly', () => {
      const te = new TokenEstimator()
      te.add(100)
      te.add(50)
      expect(te.getTotal()).toBe(150)
    })

    it('reset() clears total', () => {
      const te = new TokenEstimator()
      te.add(100)
      te.reset()
      expect(te.getTotal()).toBe(0)
    })

    it('needsCompaction() triggers at threshold', () => {
      const te = new TokenEstimator({ threshold: 1000 })
      te.add(999)
      expect(te.needsCompaction()).toBe(false)
      te.add(2)
      expect(te.needsCompaction()).toBe(true)
    })

    it('needsWarning() triggers at warningRatio threshold', () => {
      // 显式传入 warningRatio，避免与默认值耦合
      const te = new TokenEstimator({ threshold: 10000, warningRatio: 0.75 })
      // 75% of 10000 = 7500
      te.add(7499)
      expect(te.needsWarning()).toBe(false)
      te.add(2)  // 7501 > 7500
      expect(te.needsWarning()).toBe(true)
    })

    it('compactionUrgency() returns 0-1 range', () => {
      const te = new TokenEstimator({ threshold: 100 })
      expect(te.compactionUrgency()).toBe(0)
      te.add(100)
      expect(te.compactionUrgency()).toBe(1)
    })

    it('format() formats large numbers', () => {
      expect(TokenEstimator.format(500)).toBe('500')
      expect(TokenEstimator.format(1500)).toBe('1.5k')
      expect(TokenEstimator.format(999)).toBe('999')
    })
  })
})
