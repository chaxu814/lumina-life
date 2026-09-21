// ============================================================
// tests/cuVerify.test.ts — Computer Use 动作后验证 (dHash) 纯函数测试
// ============================================================

import { describe, it, expect, vi } from 'vitest'

// computeDhashFromImage 依赖 nativeImage，本测试只覆盖纯函数；给个空 mock 避免 import 报错
vi.mock('electron', () => ({ nativeImage: {} }))

import {
  grayFromBmp, changeScoreBetween, verifyChange,
} from '../electron/tools/impl/cuVerify'
import { dhash } from '../electron/pet/vision/screenAwareness'

function makeBmp(gray: number, w: number, h: number): Buffer {
  const buf = Buffer.alloc(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    buf[i * 4] = gray
    buf[i * 4 + 1] = gray
    buf[i * 4 + 2] = gray
    buf[i * 4 + 3] = 255
  }
  return buf
}

describe('grayFromBmp', () => {
  it('4 字节像素取 RGB 均值', () => {
    const bmp = Buffer.alloc(2 * 2 * 4)
    // 像素 0：RGB 30/60/90 → 均值 60；像素 1：0/0/0；像素 2：255/255/255；像素 3：10/20/30
    const vals = [[30, 60, 90], [0, 0, 0], [255, 255, 255], [10, 20, 30]]
    vals.forEach(([r, g, b], i) => {
      bmp[i * 4] = r; bmp[i * 4 + 1] = g; bmp[i * 4 + 2] = b; bmp[i * 4 + 3] = 255
    })
    const gray = grayFromBmp(bmp, 2, 2)
    expect(gray[0]).toBeCloseTo(60)
    expect(gray[1]).toBe(0)
    expect(gray[2]).toBe(255)
    expect(gray[3]).toBeCloseTo(20)
  })

  it('输出长度 = w*h', () => {
    expect(grayFromBmp(makeBmp(128, 9, 8), 9, 8)).toHaveLength(72)
  })
})

describe('changeScoreBetween', () => {
  it('完全相同分数为 0', () => {
    const a = [true, false, true, false]
    expect(changeScoreBetween(a, [...a])).toBe(0)
  })
  it('完全不同分数为 1', () => {
    expect(changeScoreBetween([true, true, true, true], [false, false, false, false])).toBe(1)
  })
  it('空数组按「全变化」处理（避免漏报）', () => {
    expect(changeScoreBetween([], [true, false])).toBe(1)
  })
})

describe('verifyChange', () => {
  it('两张完全相同的图（纯色）→ 无变化，给重看提示', () => {
    const h = dhash(grayFromBmp(makeBmp(100, 9, 8), 9, 8), 9, 8)
    const r = verifyChange(h, h, 0.02)
    expect(r.changed).toBe(false)
    expect(r.score).toBe(0)
    expect(r.hint).toContain('desktop_see')
  })

  it('两张明显不同的图（左亮右暗，dHash 比较左>右）→ 有变化，无提示', () => {
    const before = grayFromBmp(makeBmp(20, 9, 8), 9, 8)
    // dHash 记录「左像素 > 右像素」，构造左半亮右半暗，每行在分界处产生翻转
    const after = grayFromBmp(makeBmp(20, 9, 8), 9, 8).map((_v, i) => (i % 9 < 4 ? 230 : 20))
    const r = verifyChange(dhash(before, 9, 8), dhash(after, 9, 8), 0.02)
    expect(r.changed).toBe(true)
    expect(r.score).toBeGreaterThan(0.02)
    expect(r.hint).toBe('')
  })
})
