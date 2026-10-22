// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// cuGeometry.test.ts — Computer Use 归一化坐标 / PNG 尺寸单测
// ============================================================

import { describe, it, expect } from 'vitest'
import {
  clamp, normToPx, mapNormPoint, pngDimensions,
  gridDims, cellToNorm, zoomCrop, localToGlobal,
} from '../electron/tools/impl/cuGeometry'

describe('clamp', () => {
  it('keeps in-range values', () => {
    expect(clamp(5, 0, 10)).toBe(5)
  })
  it('clamps low/high', () => {
    expect(clamp(-3, 0, 10)).toBe(0)
    expect(clamp(99, 0, 10)).toBe(10)
  })
  it('falls back to min for non-finite', () => {
    expect(clamp(NaN, 0, 10)).toBe(0)
    expect(clamp(Infinity, 0, 10)).toBe(10)
  })
})

describe('normToPx', () => {
  it('maps anchors 0/50/100', () => {
    expect(normToPx(0, 1920)).toBe(0)
    expect(normToPx(50, 1920)).toBe(960)
    expect(normToPx(100, 1920)).toBe(1919) // 夹到 dim-1
  })
  it('maps vertical axis', () => {
    expect(normToPx(0, 1080)).toBe(0)
    expect(normToPx(50, 1080)).toBe(540)
    expect(normToPx(100, 1080)).toBe(1079)
  })
  it('clamps out-of-range normalized values', () => {
    expect(normToPx(-20, 1920)).toBe(0)
    expect(normToPx(140, 1920)).toBe(1919)
  })
  it('handles non-finite input gracefully', () => {
    expect(normToPx(undefined as any, 1920)).toBe(0)
    expect(normToPx(50, 0)).toBe(0)
    expect(normToPx(50, NaN)).toBe(0)
  })
  it('rounds to integer pixels', () => {
    const p = normToPx(33, 1920)
    expect(Number.isInteger(p)).toBe(true)
    expect(p).toBe(Math.round(0.33 * 1920))
  })
})

describe('mapNormPoint', () => {
  it('maps both axes', () => {
    expect(mapNormPoint(50, 50, 1920, 1080)).toEqual({ x: 960, y: 540 })
  })
  it('maps corners inside bounds', () => {
    expect(mapNormPoint(100, 100, 1920, 1080)).toEqual({ x: 1919, y: 1079 })
    expect(mapNormPoint(0, 0, 1920, 1080)).toEqual({ x: 0, y: 0 })
  })
})

describe('pngDimensions', () => {
  function makePng(w: number, h: number): Buffer {
    const buf = Buffer.alloc(32)
    // PNG 签名
    buf[0] = 0x89; buf[1] = 0x50; buf[2] = 0x4e; buf[3] = 0x47
    buf[4] = 0x0d; buf[5] = 0x0a; buf[6] = 0x1a; buf[7] = 0x0a
    // 'IHDR'
    buf[12] = 0x49; buf[13] = 0x48; buf[14] = 0x44; buf[15] = 0x52
    buf.writeUInt32BE(w, 16)
    buf.writeUInt32BE(h, 20)
    return buf
  }

  it('reads width/height from IHDR', () => {
    expect(pngDimensions(makePng(1920, 1080))).toEqual({ w: 1920, h: 1080 })
    expect(pngDimensions(makePng(3440, 1440))).toEqual({ w: 3440, h: 1440 })
  })

  it('returns null for non-png buffer', () => {
    const jpg = Buffer.alloc(32); jpg[0] = 0xff; jpg[1] = 0xd8
    expect(pngDimensions(jpg)).toBeNull()
  })

  it('returns null for too-small buffer', () => {
    expect(pngDimensions(Buffer.alloc(8))).toBeNull()
    expect(pngDimensions(null as any)).toBeNull()
  })

  it('rejects absurd dimensions', () => {
    expect(pngDimensions(makePng(999999, 999999))).toBeNull()
  })
})

// ── Set-of-Mark 网格 ─────────────────────────────────────
describe('gridDims / cellToNorm', () => {
  it('16:9 → 10 cols × 6 rows = 60 cells', () => {
    expect(gridDims(1920, 1080, 10)).toEqual({ cols: 10, rows: 6, count: 60 })
  })
  it('defaults to 10 cols', () => {
    expect(gridDims(1920, 1080).cols).toBe(10)
  })
  it('cell 0 → top-left cell center', () => {
    expect(cellToNorm(0, 10, 6)).toEqual({ nx: 5, ny: 100 / 12 })
  })
  it('last cell → bottom-right center', () => {
    expect(cellToNorm(59, 10, 6)).toEqual({ nx: 95, ny: (5.5 * 100) / 6 })
  })
  it('row-major: cell 10 starts second row first col', () => {
    expect(cellToNorm(10, 10, 6)).toEqual({ nx: 5, ny: (1.5 * 100) / 6 })
  })
  it('out-of-range / invalid → null', () => {
    expect(cellToNorm(60, 10, 6)).toBeNull()
    expect(cellToNorm(-1, 10, 6)).toBeNull()
    expect(cellToNorm(NaN, 10, 6)).toBeNull()
  })
})

// ── zoom 裁剪与坐标变换 ──────────────────────────────────
describe('zoomCrop / localToGlobal', () => {
  it('centered crop keeps the requested span', () => {
    expect(zoomCrop(50, 50, 25)).toEqual({ nx0: 37.5, ny0: 37.5, nx1: 62.5, ny1: 62.5 })
  })
  it('near top-left corner shifts crop to stay on screen', () => {
    const c = zoomCrop(5, 5, 25)
    expect(c.nx0).toBe(0); expect(c.ny0).toBe(0)
    expect(c.nx1).toBe(25); expect(c.ny1).toBe(25)
  })
  it('near bottom-right corner shifts back', () => {
    const c = zoomCrop(100, 100, 20)
    expect(c.nx1).toBe(100); expect(c.ny1).toBe(100)
    expect(c.nx0).toBe(80); expect(c.ny0).toBe(80)
  })
  it('span is clamped to 4–100', () => {
    expect(zoomCrop(50, 50, 500)).toEqual({ nx0: 0, ny0: 0, nx1: 100, ny1: 100 })
    const t = zoomCrop(50, 50, 1)
    expect(t.nx1 - t.nx0).toBe(4)
  })
  it('local center maps back to global center', () => {
    expect(localToGlobal(50, 50, zoomCrop(50, 50, 25))).toEqual({ nx: 50, ny: 50 })
  })
  it('local corners map to crop corners', () => {
    const c = zoomCrop(50, 50, 25)
    expect(localToGlobal(0, 0, c)).toEqual({ nx: 37.5, ny: 37.5 })
    expect(localToGlobal(100, 100, c)).toEqual({ nx: 62.5, ny: 62.5 })
  })
  it('clamps local coords into 0–100', () => {
    const c = zoomCrop(50, 50, 25)
    expect(localToGlobal(-50, 200, c)).toEqual({ nx: 37.5, ny: 62.5 })
  })
})

// ── 高分屏缩放回归（100% / 125% / 150% / 200% / 4K）────────────
// 核心不变量：坐标映射只认「本次截图真实像素」，归一化坐标在任何 DPI 下
// 都应落在相同的相对位置；截图尺寸来源（PNG IHDR）与 Electron 兜底
// (size*scaleFactor) 必须一致。真实 DPI 虚拟化下的点击落点由真机清单核验。
describe('DPI / 缩放矩阵回归', () => {
  const SCALES = [
    { name: 'FHD 100%', logical: { w: 1920, h: 1080 }, scale: 1 },
    { name: 'FHD 125%', logical: { w: 1920, h: 1080 }, scale: 1.25 },
    { name: 'FHD 150%', logical: { w: 1920, h: 1080 }, scale: 1.5 },
    { name: '2K 150%', logical: { w: 2560, h: 1440 }, scale: 1.5 },
    { name: '4K 200%', logical: { w: 1920, h: 1080 }, scale: 2 },
    { name: '4K 250%', logical: { w: 1536, h: 864 }, scale: 2.5 },
  ]

  function makePng(w: number, h: number): Buffer {
    const buf = Buffer.alloc(32)
    buf[0] = 0x89; buf[1] = 0x50; buf[2] = 0x4e; buf[3] = 0x47
    buf[4] = 0x0d; buf[5] = 0x0a; buf[6] = 0x1a; buf[7] = 0x0a
    buf[12] = 0x49; buf[13] = 0x48; buf[14] = 0x44; buf[15] = 0x52
    buf.writeUInt32BE(w, 16); buf.writeUInt32BE(h, 20)
    return buf
  }

  it.each(SCALES)('$name：PNG IHDR 尺寸 = Electron 兜底 size×scale', ({ logical, scale }) => {
    const pw = Math.round(logical.w * scale)
    const ph = Math.round(logical.h * scale)
    expect(pngDimensions(makePng(pw, ph))).toEqual({ w: pw, h: ph })
  })

  it.each(SCALES)('$name：归一化坐标按比例映射，中心恒为物理中心', ({ logical, scale }) => {
    const w = Math.round(logical.w * scale), h = Math.round(logical.h * scale)
    const center = mapNormPoint(50, 50, w, h)
    expect(center.x / w).toBeCloseTo(0.5, 3)
    expect(center.y / h).toBeCloseTo(0.5, 3)
    // 锚点：左上角 0，右下角不越界（dim-1）
    expect(mapNormPoint(0, 0, w, h)).toEqual({ x: 0, y: 0 })
    const br = mapNormPoint(100, 100, w, h)
    expect(br.x).toBe(w - 1); expect(br.y).toBe(h - 1)
  })

  it.each(SCALES)('$name：同一归一化点在不同 DPI 下像素比例一致', ({ logical, scale }) => {
    const w = Math.round(logical.w * scale), h = Math.round(logical.h * scale)
    const p = mapNormPoint(33, 72, w, h)
    expect(p.x / w).toBeCloseTo(0.33, 2)
    expect(p.y / h).toBeCloseTo(0.72, 2)
  })

  it.each(SCALES)('$name：Set-of-Mark 网格只随宽高比变化，16:9 恒为 10×6', ({ logical, scale }) => {
    const w = Math.round(logical.w * scale), h = Math.round(logical.h * scale)
    expect(gridDims(w, h, 10)).toEqual({ cols: 10, rows: 6, count: 60 })
  })

  it.each(SCALES)('$name：SoM 格中心 → 像素落点恒在该格内', ({ logical, scale }) => {
    const w = Math.round(logical.w * scale), h = Math.round(logical.h * scale)
    const { cols, rows } = gridDims(w, h, 10)
    for (let id = 0; id < cols * rows; id += 7) {
      const c = cellToNorm(id, cols, rows)!
      const p = mapNormPoint(c.nx, c.ny, w, h)
      const r = Math.floor(id / cols), cc = id % cols
      const cellW = w / cols, cellH = h / rows
      expect(p.x).toBeGreaterThanOrEqual(Math.floor(cc * cellW))
      expect(p.x).toBeLessThanOrEqual(Math.ceil((cc + 1) * cellW))
      expect(p.y).toBeGreaterThanOrEqual(Math.floor(r * cellH))
      expect(p.y).toBeLessThanOrEqual(Math.ceil((r + 1) * cellH))
    }
  })

  it.each(SCALES)('$name：zoom 局部放大后坐标可还原（细定位链路）', () => {
    const crop = zoomCrop(30, 60, 20)
    const g = localToGlobal(50, 50, crop)
    expect(g.nx).toBeCloseTo(30, 6); expect(g.ny).toBeCloseTo(60, 6)
  })
})
