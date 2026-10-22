// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/macCoordinate.test.ts — macOS 坐标系换算单测
//
// 这是 macOS 适配里最容易出错的一块（截图像素 vs 注入 point），
// 且换算是**纯函数**，因此可以在 Windows 开发机上完整验证。
//
// 覆盖：
//   • 缩放比三种来源（显式锁定 / 截图像素反推 / 显示器 scaleFactor 兜底）
//   • 1× 非 Retina 与 2× Retina 两种实际配置
//   • 多显示器并集与负坐标原点（副屏在左/上）
//   • pixel↔point 往返一致性
//   • 夹取边界；几何未知时不误夹
// ============================================================

import { describe, it, expect } from 'vitest'
import {
  computeCaptureGeometry, pixelToPoint, pointToPixel,
  clampPointToDesktop, toInjectablePoint, describeGeometry,
  type DisplayInfo,
} from '../electron/core/platform/macCoordinate'

const RETINA_1512: DisplayInfo = {
  bounds: { x: 0, y: 0, width: 1512, height: 982 },
  scaleFactor: 2,
}
const NON_RETINA: DisplayInfo = {
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  scaleFactor: 1,
}

describe('computeCaptureGeometry — 缩放比来源', () => {
  it('有截图像素时按实测反推（Retina 2×）', () => {
    const g = computeCaptureGeometry([RETINA_1512], 3024, 1964)
    expect(g.scaleX).toBeCloseTo(2, 5)
    expect(g.scaleY).toBeCloseTo(2, 5)
    expect(g.scaleLocked).toBe(false)
    expect(g.pointW).toBe(1512)
    expect(g.pointH).toBe(982)
  })

  it('有截图像素时按实测反推（非 Retina 1×）', () => {
    const g = computeCaptureGeometry([NON_RETINA], 1920, 1080)
    expect(g.scaleX).toBeCloseTo(1, 5)
    expect(g.scaleY).toBeCloseTo(1, 5)
  })

  it('★ 自校正：显示器报 2× 但截图实际 1× 时，实测比例算成 1（不硬编码 2）', () => {
    // 若硬编码 2，这里就会把注入坐标放大一倍，Retina/非 Retina 通吃地错。
    const g = computeCaptureGeometry([RETINA_1512], 1512, 982)
    expect(g.scaleX).toBeCloseTo(1, 5)
    expect(g.scaleY).toBeCloseTo(1, 5)
  })

  it('无截图尺寸时回退到显示器 scaleFactor', () => {
    const g = computeCaptureGeometry([RETINA_1512], 0, 0)
    expect(g.scaleX).toBe(2)
    expect(g.scaleY).toBe(2)
  })

  it('forceScale 优先于实测（显式锁定）', () => {
    const g = computeCaptureGeometry([RETINA_1512], 3024, 1964, 1)
    expect(g.scaleLocked).toBe(true)
    expect(g.scaleX).toBe(1)
    expect(g.scaleY).toBe(1)
  })

  it('无显示器信息时比例退化为 1，几何为空（不猜）', () => {
    const g = computeCaptureGeometry([], 0, 0)
    expect(g.scaleX).toBe(1)
    expect(g.pointW).toBe(0)
    expect(g.pointH).toBe(0)
  })

  it('混合缩放取面积最大显示器的比例（而非简单平均）', () => {
    const big: DisplayInfo = { bounds: { x: 0, y: 0, width: 1512, height: 982 }, scaleFactor: 2 }
    const small: DisplayInfo = { bounds: { x: 1512, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }
    const g = computeCaptureGeometry([small, big], 0, 0)
    // 1920*1080=2073600 > 1512*982=1484784 → 取小屏的 1×
    expect(g.scaleX).toBe(1)
  })
})

describe('computeCaptureGeometry — 多显示器并集', () => {
  it('并集原点与尺寸（副屏在右）', () => {
    const right: DisplayInfo = { bounds: { x: 1512, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }
    const g = computeCaptureGeometry([RETINA_1512, right], 0, 0)
    expect(g.originX).toBe(0)
    expect(g.pointW).toBe(1512 + 1920)
    expect(g.pointH).toBe(1080)
  })

  it('副屏在左 → 原点 x 为负', () => {
    const left: DisplayInfo = { bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }
    const g = computeCaptureGeometry([RETINA_1512, left], 0, 0)
    expect(g.originX).toBe(-1920)
    expect(g.pointW).toBe(1512 + 1920)
  })

  it('副屏在上 → 原点 y 为负', () => {
    const up: DisplayInfo = { bounds: { x: 0, y: -1080, width: 1920, height: 1080 }, scaleFactor: 1 }
    const g = computeCaptureGeometry([RETINA_1512, up], 0, 0)
    expect(g.originY).toBe(-1080)
  })
})

describe('pixelToPoint / pointToPixel', () => {
  it('★ Retina：截图像素 → point 除以缩放比', () => {
    const g = computeCaptureGeometry([RETINA_1512], 3024, 1964)
    // 截图像素 (3024, 1964) 是右下角 → point (1511, 981)
    expect(pixelToPoint(3024, 1964, g)).toEqual({ x: 1512, y: 982 })
    // 中心 (1512, 982) 像素 → (756, 491) point
    expect(pixelToPoint(1512, 982, g)).toEqual({ x: 756, y: 491 })
  })

  it('非 Retina 时比例 1，像素=point', () => {
    const g = computeCaptureGeometry([NON_RETINA], 1920, 1080)
    expect(pixelToPoint(640, 480, g)).toEqual({ x: 640, y: 480 })
  })

  it('副屏在左：减去负原点后得到正的 point 偏移', () => {
    const left: DisplayInfo = { bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }
    const g = computeCaptureGeometry([RETINA_1512, left], 0, 0, 1)
    // 截图像素 x=0 即虚拟桌面最左（副屏左缘）→ point 恰为 -1920
    expect(pixelToPoint(0, 0, g)).toEqual({ x: -1920, y: 0 })
  })

  it('point → pixel 为逆运算', () => {
    const g = computeCaptureGeometry([RETINA_1512], 3024, 1964)
    expect(pointToPixel(756, 491, g)).toEqual({ x: 1512, y: 982 })
  })

  it('往返一致：pixel→point→pixel 复原原值（容 1px 取整）', () => {
    const g = computeCaptureGeometry([RETINA_1512], 3024, 1964)
    for (const [px, py] of [[0, 0], [756, 491], [1512, 982], [3000, 1900]]) {
      const p = pixelToPoint(px, py, g)
      const back = pointToPixel(p.x, p.y, g)
      expect(Math.abs(back.x - px)).toBeLessThanOrEqual(2)
      expect(Math.abs(back.y - py)).toBeLessThanOrEqual(2)
    }
  })

  it('非有限输入退化为 0，不产生 NaN', () => {
    const g = computeCaptureGeometry([NON_RETINA], 1920, 1080)
    const p = pixelToPoint(NaN, Infinity, g)
    expect(Number.isFinite(p.x)).toBe(true)
    expect(Number.isFinite(p.y)).toBe(true)
  })
})

describe('clampPointToDesktop / toInjectablePoint', () => {
  it('夹到桌面有效范围内', () => {
    const g = computeCaptureGeometry([NON_RETINA], 1920, 1080)
    expect(clampPointToDesktop(-50, -50, g)).toEqual({ x: 0, y: 0 })
    expect(clampPointToDesktop(99999, 99999, g)).toEqual({ x: 1919, y: 1079 })
  })

  it('★ 几何未知（未截图/无显示器）时不夹取，避免全被压成 (0,0)', () => {
    const g = computeCaptureGeometry([], 0, 0)
    expect(g.pointW).toBe(0)
    expect(clampPointToDesktop(500, 400, g)).toEqual({ x: 500, y: 400 })
    // 这是个真实的坑：若按空矩形夹取，所有点击都会落在 (0,0)
  })

  it('toInjectablePoint：换算 + 夹取一步到位', () => {
    const g = computeCaptureGeometry([RETINA_1512], 3024, 1964)
    // Retina 下 2× 缩放：截图像素 (756,491) → point (378,246)
    expect(toInjectablePoint(756, 491, g)).toEqual({ x: 378, y: 246 })
    // 超出上界的像素会被夹回桌面右下角
    expect(toInjectablePoint(99999, 99999, g)).toEqual({ x: 1511, y: 981 })
  })

  it('toInjectablePoint 在非 Retina 上退化为恒等', () => {
    const g = computeCaptureGeometry([NON_RETINA], 1920, 1080)
    expect(toInjectablePoint(123, 456, g)).toEqual({ x: 123, y: 456 })
  })
})

describe('describeGeometry', () => {
  it('输出含比例与原点，可读', () => {
    const g = computeCaptureGeometry([RETINA_1512], 3024, 1964)
    const s = describeGeometry(g)
    expect(s).toMatch(/2\.00×/)
    expect(s).toMatch(/1512×982/)
  })
})
