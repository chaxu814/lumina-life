import { describe, it, expect } from 'vitest'
import {
  detectEdge, calcPeekPosition, shouldSlideOut, resetPosition,
  DEFAULT_EDGE_SNAP,
} from '../electron/pet/edgeSnap'

describe('edgeSnap 边缘吸附几何', () => {
  const workX = 0, workY = 0, screenW = 1920, screenH = 1080

  it('默认配置合理', () => {
    expect(DEFAULT_EDGE_SNAP.enabled).toBe(true)
    expect(DEFAULT_EDGE_SNAP.sensitivity).toBeGreaterThan(0)
    expect(DEFAULT_EDGE_SNAP.peekWidth).toBeGreaterThan(0)
  })

  it('窗口紧贴左边缘时检测到 left', () => {
    const edge = detectEdge(0, 500, 460, 720, screenW, screenH, workX, workY)
    expect(edge).toBe('left')
  })

  it('窗口紧贴右边缘时检测到 right', () => {
    const edge = detectEdge(1920 - 460, 500, 460, 720, screenW, screenH, workX, workY)
    expect(edge).toBe('right')
  })

  it('窗口紧贴顶部时检测到 top', () => {
    const edge = detectEdge(700, 0, 460, 720, screenW, screenH, workX, workY)
    expect(edge).toBe('top')
  })

  it('窗口紧贴底部时检测到 bottom', () => {
    const edge = detectEdge(700, 1080 - 720, 460, 720, screenW, screenH, workX, workY)
    expect(edge).toBe('bottom')
  })

  it('窗口在屏幕中央时不检测到边缘', () => {
    const edge = detectEdge(700, 200, 460, 720, screenW, screenH, workX, workY)
    expect(edge).toBeNull()
  })

  it('calcPeekPosition left 时窗口大部分在屏幕外', () => {
    const pos = calcPeekPosition('left', 460, 720, screenW, screenH, workX, workY, 40)
    // peekWidth=40: x = 0 - (460 - 40) = -420
    expect(pos.x).toBe(-420)
    // y 垂直居中
    expect(pos.y).toBe(Math.round((screenH - 720) / 2))
  })

  it('calcPeekPosition right 时窗口右侧贴边', () => {
    const pos = calcPeekPosition('right', 460, 720, screenW, screenH, workX, workY, 40)
    expect(pos.x).toBe(screenW - 40)
  })

  it('shouldSlideOut 鼠标远离窗口返回 false', () => {
    // 窗口在 x=-420 到 40，阈值80 → 检测区 [-500, 120]
    // 鼠标在 x=800 远离窗口
    const result = shouldSlideOut(800, 500, -420, 180, 460, 720, 80)
    expect(result).toBe(false)
  })

  it('shouldSlideOut 鼠标在窗口附近返回 true', () => {
    // 窗口在 x=-420 到 40，阈值80 → 检测区 [-500, 120]
    // 鼠标在 x=0 在检测区内
    const result = shouldSlideOut(0, 500, -420, 180, 460, 720, 80)
    expect(result).toBe(true)
  })

  it('shouldSlideOut 鼠标在窗口内返回 true', () => {
    const result = shouldSlideOut(100, 500, -420, 180, 460, 720, 80)
    // 鼠标 x=100 在窗口 [-420, 40] 附近（threshold=80 → [-500, 120]）
    expect(result).toBe(true)
  })

  it('resetPosition 复位到屏幕中央', () => {
    const pos = resetPosition(460, 720, screenW, screenH, workX, workY)
    expect(pos.x).toBe(Math.round((screenW - 460) / 2))
    expect(pos.y).toBe(Math.round((screenH - 720) / 2))
  })

  it('多显示器 workArea 偏移被正确考虑', () => {
    // 假设副显示器 workArea 从 x=1920 开始
    const edge = detectEdge(1920, 500, 460, 720, 1920, 1080, 1920, 0)
    expect(edge).toBe('left')
  })
})
