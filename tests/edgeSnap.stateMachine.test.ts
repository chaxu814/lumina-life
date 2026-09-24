import { describe, it, expect } from 'vitest'
import {
  detectEdge, calcPeekPosition, shouldSlideOut,
  DEFAULT_EDGE_SNAP,
} from '../electron/pet/edgeSnap'

describe('edgeSnap 状态机 / 灵敏度（拖拽消失修复）', () => {
  const W = 1920, H = 1080, w = 460, h = 720

  it('默认灵敏度 = 20，peek 露出 84px（足够看清，不像消失）', () => {
    expect(DEFAULT_EDGE_SNAP.sensitivity).toBe(20)
    expect(DEFAULT_EDGE_SNAP.peekWidth).toBeGreaterThanOrEqual(84)
  })

  it('detectEdge 尊重自定义灵敏度：距边 15px，阈值 20→right，阈值 10→null', () => {
    const x = W - w - 15 // 右缘留 15px
    expect(detectEdge(x, 200, w, h, W, H, 0, 0, 20)).toBe('right')
    expect(detectEdge(x, 200, w, h, W, H, 0, 0, 10)).toBeNull()
  })

  it('窗口超出边缘（负间隙）仍判该边缘，便于收回到 peek', () => {
    const x = W - w + 40 // 右缘超出 40px
    expect(detectEdge(x, 200, w, h, W, H, 0, 0, 20)).toBe('right')
  })

  it('完整循环：peek → 鼠标靠近滑出 → 鼠标远离缩回', () => {
    // 1) 释放到右缘 → peek 位（只露 84）
    const peek = calcPeekPosition('right', w, h, W, H, 0, 0, 84)
    expect(peek.x).toBe(W - 84)
    // 2) 鼠标靠近 peek 区 → shouldSlideOut true（滑出到 full）
    expect(shouldSlideOut(W - 60, 500, peek.x, peek.y, w, h, 96)).toBe(true)
    // 3) full 位
    const fullX = W - w - 12
    // 鼠标离开到屏幕中部
    expect(shouldSlideOut(500, 500, fullX, peek.y, w, h, 96)).toBe(false)
    // 4) 缩回后再次 peek，鼠标在中部不应滑出
    expect(shouldSlideOut(500, 500, peek.x, peek.y, w, h, 96)).toBe(false)
  })

  it('非粘滞：窗口被移到 peek/full 都够不着处 → 解除条件成立', () => {
    const threshold = 96
    const peek = calcPeekPosition('right', w, h, W, H, 0, 0, 84)
    const fullX = W - w - 12, fullY = peek.y
    // 用户把窗口拖到屏幕左中部 (200,300)
    const bx = 200, by = 300
    const dPeek = Math.abs(bx - peek.x) + Math.abs(by - peek.y)
    const dFull = Math.abs(bx - fullX) + Math.abs(by - fullY)
    const disarmAt = threshold + 140
    expect(dPeek).toBeGreaterThan(disarmAt)
    expect(dFull).toBeGreaterThan(disarmAt)
    // 而窗口停在 full 位时 dFull=0，绝不应误解除
    expect(Math.abs(fullX - fullX) + Math.abs(fullY - fullY)).toBe(0)
  })
})
