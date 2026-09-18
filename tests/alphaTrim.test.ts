// ============================================================
// tests/alphaTrim.test.ts — 按可见像素 alpha 测贴身裁剪（含 DPI 无关性）
// ============================================================

import { describe, it, expect } from 'vitest'
import { scanAlphaBounds, backingPixelScale } from '../electron/pet/life/alphaTrim'

/** 造一块 RGBA 缓冲，[x0,x1)×[y0,y1) 区域填不透明 */
function makeFrame(w: number, h: number, rect?: { x0: number; y0: number; x1: number; y1: number; a?: number }): Uint8Array {
  const buf = new Uint8Array(w * h * 4)
  if (!rect) return buf
  for (let y = rect.y0; y < rect.y1; y++) {
    for (let x = rect.x0; x < rect.x1; x++) {
      const i = (y * w + x) * 4
      buf[i] = 255; buf[i + 1] = 255; buf[i + 2] = 255; buf[i + 3] = rect.a ?? 255
    }
  }
  return buf
}

describe('scanAlphaBounds 基本包围', () => {
  it('全透明 → null（调用方保留上次结果）', () => {
    expect(scanAlphaBounds(makeFrame(40, 20), 40, 20)).toBeNull()
  })

  it('整块不透明 → 四边内缩约 0', () => {
    const trim = scanAlphaBounds(makeFrame(40, 20, { x0: 0, y0: 0, x1: 40, y1: 20 }), 40, 20, { step: 1 })
    expect(trim).not.toBeNull()
    expect(trim!.l).toBe(0); expect(trim!.t).toBe(0); expect(trim!.r).toBe(0); expect(trim!.b).toBe(0)
  })

  it('居中角色 → 四边内缩比例为正且对称', () => {
    const trim = scanAlphaBounds(makeFrame(40, 20, { x0: 10, y0: 5, x1: 30, y1: 15 }), 40, 20, { step: 1 })
    expect(trim).not.toBeNull()
    // l=(10-1)/40=0.225, r=(40-1-29-1)/40=0.225
    expect(trim!.l).toBeCloseTo(0.225, 3)
    expect(trim!.r).toBeCloseTo(0.225, 3)
    expect(trim!.l).toBeCloseTo(trim!.r, 6)
    expect(trim!.l).toBeLessThanOrEqual(0.45)
  })

  it('alpha 阈值：低于阈值的像素不算可见', () => {
    // 20 低于阈值 28，视为全透明
    expect(scanAlphaBounds(makeFrame(40, 20, { x0: 10, y0: 5, x1: 30, y1: 15, a: 20 }), 40, 20, { step: 1, alphaThreshold: 28 })).toBeNull()
    // 30 高于阈值
    expect(scanAlphaBounds(makeFrame(40, 20, { x0: 10, y0: 5, x1: 30, y1: 15, a: 30 }), 40, 20, { step: 1, alphaThreshold: 28 })).not.toBeNull()
  })
})

describe('scanAlphaBounds 单边内缩上限', () => {
  it('极小的居中角色：单边内缩被夹到 45%（防误裁）', () => {
    const trim = scanAlphaBounds(makeFrame(100, 100, { x0: 46, y0: 46, x1: 54, y1: 54 }), 100, 100, { step: 1, maxSide: 0.45 })
    expect(trim).not.toBeNull()
    expect(trim!.l).toBe(0.45)
    expect(trim!.r).toBe(0.45)
    expect(trim!.t).toBe(0.45)
    expect(trim!.b).toBe(0.45)
  })
})

describe('scanAlphaBounds 的 DPI 无关性（125% / 150% / 200%）', () => {
  // 同一逻辑角色（逻辑 100×100 中居中的 40×30），在不同 DPR 下物理像素不同，
  // 但内缩「比例」应一致（容差来自取整与 step）。
  const cases = [
    { name: '100%', dpr: 1 }, { name: '125%', dpr: 1.25 },
    { name: '150%', dpr: 1.5 }, { name: '200%', dpr: 2 },
  ]
  it.each(cases)('$name：内缩比例与 100% 基本一致', ({ dpr }) => {
    const LW = 100, LH = 100
    const bw = Math.round(LW * dpr), bh = Math.round(LH * dpr)
    // 逻辑矩形 30..70 × 35..65 映射到物理
    const rect = {
      x0: Math.round(30 * dpr), y0: Math.round(35 * dpr),
      x1: Math.round(70 * dpr), y1: Math.round(65 * dpr),
    }
    const trim = scanAlphaBounds(makeFrame(bw, bh, rect), bw, bh, { step: Math.max(1, Math.round(dpr)) })
    const base = scanAlphaBounds(
      makeFrame(LW, LH, { x0: 30, y0: 35, x1: 70, y1: 65 }), LW, LH, { step: 1 })
    expect(trim).not.toBeNull()
    for (const k of ['l', 't', 'r', 'b'] as const) {
      expect(Math.abs(trim![k] - base![k])).toBeLessThan(0.03)
    }
  })
})

describe('backingPixelScale：readPixels 区域的 backing/CSS 缩放（修 125/150% 低画质误裁）', () => {
  it('高画质：backing = CSS×DPR，返回 1.25 / 1.5', () => {
    // 1000 CSS 宽，125% 时 backing 1250
    expect(backingPixelScale(1250, 1000, 1.25)).toBeCloseTo(1.25, 6)
    expect(backingPixelScale(1500, 1000, 1.5)).toBeCloseTo(1.5, 6)
  })

  it('低画质（renderer resolution 固定 1）：backing 等于 CSS，即使 DPR=1.5 也返回 1', () => {
    // 这是关键回归：不能因为 devicePixelRatio=1.5 就按 1.5 读 backing（画布其实只有 1000）
    expect(backingPixelScale(1000, 1000, 1.5)).toBe(1)
    expect(backingPixelScale(1000, 1000, 1.25)).toBe(1)
  })

  it('画布/CSS 宽无效时回退到 devicePixelRatio', () => {
    expect(backingPixelScale(0, 1000, 1.5)).toBe(1.5)
    expect(backingPixelScale(1000, 0, 2)).toBe(2)
    expect(backingPixelScale(NaN, 1000, 1.25)).toBe(1.25)
  })

  it('DPR 非法时回退 1，不返回 0/NaN', () => {
    expect(backingPixelScale(0, 0, 0)).toBe(1)
    expect(backingPixelScale(0, 0, NaN)).toBe(1)
  })
})

