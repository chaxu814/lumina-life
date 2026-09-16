// ============================================================
// cuGeometry.test.ts — Computer Use 归一化坐标 / PNG 尺寸单测
// ============================================================

import { describe, it, expect } from 'vitest'
import { clamp, normToPx, mapNormPoint, pngDimensions } from '../electron/tools/impl/cuGeometry'

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
