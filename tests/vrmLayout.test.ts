// ============================================================
// tests/vrmLayout.test.ts — VRM 桌宠广告牌布局纯计算
// ============================================================

import { describe, it, expect } from 'vitest'
import { scaleToFit, centeredBottomRect, characterPixelSize, toPhysicalRect } from '../electron/pet/vrm/vrmLayout'

describe('scaleToFit', () => {
  it('受高度限制时按高度收敛', () => {
    expect(scaleToFit(100, 200, 400, 1000)).toBeCloseTo(2, 5)
  })
  it('受宽度限制时按宽度收敛', () => {
    expect(scaleToFit(400, 100, 500, 200)).toBeCloseTo(0.5, 5)
  })
  it('非法尺寸返回 1', () => {
    expect(scaleToFit(0, 100, 100, 100)).toBe(1)
  })
})

describe('characterPixelSize', () => {
  it('常规比例：高度占屏幕 78%', () => {
    const s = characterPixelSize(0.4, 1920, 1080)
    expect(s.height).toBe(Math.round(1080 * 0.78))
    expect(s.width).toBe(Math.round(s.height * 0.4))
  })
  it('超宽模型按宽度上限收敛', () => {
    const s = characterPixelSize(5, 1920, 1080)
    const maxW = 1920 * 0.6
    expect(s.width).toBeLessThanOrEqual(Math.round(maxW))
    expect(s.width).toBe(Math.round(maxW))
  })
})

describe('centeredBottomRect', () => {
  it('水平居中、贴底并留间距', () => {
    const r = centeredBottomRect(300, 840, 1920, 1080)
    expect(r.width).toBe(300)
    expect(r.height).toBe(840)
    expect(r.x).toBe(Math.round((1920 - 300) / 2))
    expect(r.y).toBe(Math.round(1080 - 840 - 1080 * 0.03))
  })
  it('不超过宽度上限', () => {
    const r = centeredBottomRect(5000, 840, 1000, 1000)
    expect(r.width).toBeLessThanOrEqual(600)
  })
})

describe('toPhysicalRect', () => {
  it('按 dpr 放大', () => {
    const r = toPhysicalRect({ x: 10, y: 20, width: 30, height: 40 }, 1.5)
    expect(r).toEqual({ x: 15, y: 30, width: 45, height: 60 })
  })
  it('dpr 非法时回退 1', () => {
    const r = toPhysicalRect({ x: 1, y: 1, width: 2, height: 2 }, 0)
    expect(r).toEqual({ x: 1, y: 1, width: 2, height: 2 })
  })
})
