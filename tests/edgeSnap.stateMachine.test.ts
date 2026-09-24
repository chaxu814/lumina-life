import { describe, it, expect } from 'vitest'
import {
  detectEdge, calcPeekPosition, calcDockPosition, shouldSlideOut,
  DEFAULT_EDGE_SNAP,
} from '../electron/pet/edgeSnap'

describe('edgeSnap 状态机 / 灵敏度（拖拽消失修复）', () => {
  const W = 1920, H = 1080, w = 460, h = 720

  it('默认：灵敏度 20、peek 84、且 autoHideAtEdges=false（不自动藏）', () => {
    expect(DEFAULT_EDGE_SNAP.sensitivity).toBe(20)
    expect(DEFAULT_EDGE_SNAP.peekWidth).toBeGreaterThanOrEqual(84)
    expect(DEFAULT_EDGE_SNAP.autoHideAtEdges).toBe(false)
  })

  it('detectEdge 尊重自定义灵敏度：距边 15px，阈值 20→right，阈值 10→null', () => {
    const x = W - w - 15
    expect(detectEdge(x, 200, w, h, W, H, 0, 0, 20)).toBe('right')
    expect(detectEdge(x, 200, w, h, W, H, 0, 0, 10)).toBeNull()
  })

  it('窗口超出边缘（负间隙）仍判该边缘，便于完整停靠收回', () => {
    const x = W - w + 40
    expect(detectEdge(x, 200, w, h, W, H, 0, 0, 20)).toBe('right')
  })

  it('calcDockPosition 右缘：整窗留在屏内、右边贴边（x = W-w）', () => {
    const pos = calcDockPosition('right', W - w + 40, 300, w, h, W, H, 0, 0)
    expect(pos.x).toBe(W - w)
    // 整窗右边界正好到 W，不超出
    expect(pos.x + w).toBe(W)
  })

  it('calcDockPosition 左缘：x = 0，整窗可见', () => {
    const pos = calcDockPosition('left', -40, 300, w, h, W, H, 0, 0)
    expect(pos.x).toBe(0)
    expect(pos.x).toBeGreaterThanOrEqual(0)
  })

  it('calcDockPosition 上/下缘：y 分别贴 0 / H-h，整窗可见', () => {
    expect(calcDockPosition('top', 500, -30, w, h, W, H, 0, 0).y).toBe(0)
    expect(calcDockPosition('bottom', 500, H - h + 30, w, h, W, H, 0, 0).y).toBe(H - h)
  })

  it('完整停靠后另一方向被钳制回工作区，不会有任何部分在屏外', () => {
    const pos = calcDockPosition('right', 2000, 99999, w, h, W, H, 0, 0)
    expect(pos.x).toBe(W - w)
    expect(pos.y).toBe(H - h)
    expect(pos.x).toBeGreaterThanOrEqual(0)
    expect(pos.y).toBeGreaterThanOrEqual(0)
  })

  it('（仅 autoHideAtEdges=true 时）peek→靠近滑出→远离缩回', () => {
    const peek = calcPeekPosition('right', w, h, W, H, 0, 0, 84)
    expect(shouldSlideOut(W - 60, 500, peek.x, peek.y, w, h, 96)).toBe(true)
    const fullX = W - w - 12
    expect(shouldSlideOut(500, 500, fullX, peek.y, w, h, 96)).toBe(false)
    expect(shouldSlideOut(500, 500, peek.x, peek.y, w, h, 96)).toBe(false)
  })
})
