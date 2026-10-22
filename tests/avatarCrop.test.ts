// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// avatarCrop.test.ts — 头像裁剪纯函数单测（node 环境）
//
// 覆盖 lib/avatarCrop.ts：边界钳制 / 中心锚缩放 / 初始构图 / 百分比。
//  Regression 用例对应 2026-10-19 重写前的四个已知问题：
//   · 裁剪框可以拖出容器（旧版只钳了 x/y，size 超界后右下越界）；
//   · 缩放以左上角为锚导致构图乱跳（zoomCrop 必须保中心）；
//   · 小容器（maxSize < MIN_CROP）下尺寸/坐标不许出现负数。
// ============================================================
import { describe, it, expect } from 'vitest'
import {
  clampCrop, zoomCrop, initialCrop, zoomPercent, MIN_CROP,
  type CropRect, type CropBounds,
} from '../src/lib/avatarCrop'

const BOUNDS: CropBounds = { w: 400, h: 300 }

describe('clampCrop', () => {
  it('正常值原样通过', () => {
    const c = { x: 10, y: 20, size: 100 }
    expect(clampCrop(c, BOUNDS)).toEqual(c)
  })

  it('越界坐标被钳回容器内', () => {
    const c = clampCrop({ x: -50, y: 999, size: 100 }, BOUNDS)
    expect(c.x).toBe(0)
    expect(c.y).toBe(BOUNDS.h - 100) // 200
    expect(c.x + c.size).toBeLessThanOrEqual(BOUNDS.w)
    expect(c.y + c.size).toBeLessThanOrEqual(BOUNDS.h)
  })

  it('size 超过容器短边时封顶（旧版允许 500，直接越界）', () => {
    const c = clampCrop({ x: 0, y: 0, size: 999 }, BOUNDS)
    expect(c.size).toBe(300)
    expect(c.x + c.size).toBeLessThanOrEqual(BOUNDS.w)
  })

  it('size 小于最小值时兜底', () => {
    expect(clampCrop({ x: 0, y: 0, size: 5 }, BOUNDS).size).toBe(MIN_CROP)
  })

  it('极小容器不出负数', () => {
    const tiny = { w: 10, h: 8 }
    const c = clampCrop({ x: -100, y: -100, size: 500 }, tiny)
    expect(c.size).toBe(MIN_CROP) // MIN_CROP > 容器时允许溢出但不许负坐标
    expect(c.x).toBeGreaterThanOrEqual(0)
    expect(c.y).toBeGreaterThanOrEqual(0)
  })
})

describe('zoomCrop（中心锚）', () => {
  const start: CropRect = { x: 150, y: 100, size: 100 } // 中心 (200,150)

  it('放大后中心不变', () => {
    const z = zoomCrop(start, 200, BOUNDS)
    expect(z.size).toBe(200)
    expect(z.x + z.size / 2).toBeCloseTo(200, 5)
    expect(z.y + z.size / 2).toBeCloseTo(150, 5)
  })

  it('缩小后中心不变', () => {
    const z = zoomCrop(start, 50, BOUNDS)
    expect(z.size).toBe(50)
    expect(z.x + z.size / 2).toBeCloseTo(200, 5)
    expect(z.y + z.size / 2).toBeCloseTo(150, 5)
  })

  it('放大到容器短边上限即封顶', () => {
    const z = zoomCrop(start, 10000, BOUNDS)
    expect(z.size).toBe(300)
    expect(z.x + z.size).toBeLessThanOrEqual(BOUNDS.w)
    expect(z.y + z.size).toBeLessThanOrEqual(BOUNDS.h)
  })

  it('缩小到低于 MIN_CROP 时兜底', () => {
    expect(zoomCrop(start, 1, BOUNDS).size).toBe(MIN_CROP)
  })

  it('靠边缩放时框被钳回容器内且不穿越中心', () => {
    const edge: CropRect = { x: 0, y: 0, size: 80 }
    const z = zoomCrop(edge, 300, BOUNDS)
    expect(z.size).toBe(300)
    expect(z.x).toBe(0)
    expect(z.y).toBe(0)
  })
})

describe('initialCrop / zoomPercent', () => {
  it('初始构图居中且占短边 70%', () => {
    const c = initialCrop(BOUNDS)
    expect(c.size).toBe(210) // round(300*0.7)
    expect(c.x).toBe(95)     // (400-210)/2
    expect(c.y).toBe(45)     // (300-210)/2
  })

  it('百分比按短边计算', () => {
    expect(zoomPercent({ x: 0, y: 0, size: 300 }, BOUNDS)).toBe(100)
    expect(zoomPercent({ x: 0, y: 0, size: 150 }, BOUNDS)).toBe(50)
  })
})
