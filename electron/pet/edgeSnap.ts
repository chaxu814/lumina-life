// ============================================================
// pet/edgeSnap.ts — 屏幕边缘吸附 + 窥视 (peek) 纯几何函数
//
// 不依赖 Electron，可单测。窗口坐标均为 DIP（与 Electron Bounds 一致）。
// 多显示器场景由调用方通过 screen.getDisplayMatching 选对 workArea 后传入。
// ============================================================

export type EdgeSide = 'left' | 'right' | 'top' | 'bottom'

export interface EdgeSnapConfig {
  enabled: boolean
  /** 距边缘多少 px 内触发吸附 */
  sensitivity: number
  /** 吸附后露出的宽度/高度（px） */
  peekWidth: number
  /** 鼠标距离窥视区多远内滑出（px） */
  mouseThreshold: number
  /**
   * 松手贴边时是否自动隐藏成窥视窄条（peek）。
   * false（默认）：完整停靠在边缘，人物始终全部可见，不会"消失"。
   * true：旧行为，自动缩成 peekWidth 窄条，鼠标靠近再滑出。
   */
  autoHideAtEdges: boolean
}

export const DEFAULT_EDGE_SNAP: EdgeSnapConfig = {
  enabled: true,
  sensitivity: 20,
  peekWidth: 84,
  mouseThreshold: 96,
  autoHideAtEdges: false,
}

/**
 * 检测窗口当前靠近哪条屏幕边缘（拖拽结束时调用）。
 * 返回 null 表示不靠近任何边缘，不需要吸附。
 */
export function detectEdge(
  windowX: number, windowY: number, windowW: number, windowH: number,
  screenW: number, screenH: number,
  /** 工作区起点（任务栏/Dock 偏移），通常 = workArea.x/y */
  workX: number, workY: number,
  /** 触发吸附的距离阈值（= EdgeSnapConfig.sensitivity），默认 20 */
  sensitivity = 20,
): EdgeSide | null {
  // 与各边缘的距离（负值=窗口超出工作区，不应视为贴边，用 Infinity 排除）
  const distLeft = Math.max(0, windowX - workX)
  const distRight = Math.max(0, (workX + screenW) - (windowX + windowW))
  const distTop = Math.max(0, windowY - workY)
  const distBottom = Math.max(0, (workY + screenH) - (windowY + windowH))

  // 找最小距离
  const candidates: { side: EdgeSide; dist: number }[] = [
    { side: 'left', dist: distLeft },
    { side: 'right', dist: distRight },
    { side: 'top', dist: distTop },
    { side: 'bottom', dist: distBottom },
  ]
  candidates.sort((a, b) => a.dist - b.dist)
  const nearest = candidates[0]
  if (nearest.dist <= sensitivity) {return nearest.side}
  return null
}

/**
 * 计算吸附后的窥视位置：只露出 peekWidth px。
 * 返回窗口左上角坐标。
 */
export function calcPeekPosition(
  edge: EdgeSide, windowW: number, windowH: number,
  screenW: number, screenH: number,
  workX: number, workY: number,
  peekWidth: number,
): { x: number; y: number } {
  switch (edge) {
    case 'left':
      // 只露出右侧 peekWidth px：窗口左上角在 workX - (windowW - peekWidth)
      return { x: Math.round(workX - (windowW - peekWidth)), y: Math.round(workY + (screenH - windowH) / 2) }
    case 'right':
      return { x: Math.round(workX + screenW - peekWidth), y: Math.round(workY + (screenH - windowH) / 2) }
    case 'top':
      return { x: Math.round(workX + (screenW - windowW) / 2), y: Math.round(workY - (windowH - peekWidth)) }
    case 'bottom':
      return { x: Math.round(workX + (screenW - windowW) / 2), y: Math.round(workY + screenH - peekWidth) }
  }
}

/**
 * 计算"完整停靠"位置：人物整个留在屏幕内、贴在指定边缘（不隐藏）。
 * 沿边方向贴齐工作区，另一方向保留用户松手时的位置（并钳制回工作区）。
 * 返回窗口左上角坐标。
 */
export function calcDockPosition(
  edge: EdgeSide,
  windowX: number, windowY: number, windowW: number, windowH: number,
  screenW: number, screenH: number,
  workX: number, workY: number,
): { x: number; y: number } {
  let x = windowX
  let y = windowY
  if (edge === 'left') { x = workX }
  else if (edge === 'right') { x = workX + screenW - windowW }
  else if (edge === 'top') { y = workY }
  else if (edge === 'bottom') { y = workY + screenH - windowH }
  // 另一方向（以及贴边方向本身）钳制回工作区，保证整窗可见
  x = Math.min(Math.max(x, workX), workX + screenW - windowW)
  y = Math.min(Math.max(y, workY), workY + screenH - windowH)
  return { x: Math.round(x), y: Math.round(y) }
}

/**
 * 判断鼠标是否靠近窥视区，需要把窗口滑出到完整位置。
 * peekX/peekY = 窗口左上角；peekW/peekH = 窗口尺寸。
 */
export function shouldSlideOut(
  mouseX: number, mouseY: number,
  peekX: number, peekY: number, peekW: number, peekH: number,
  threshold: number,
): boolean {
  // 鼠标在窗口矩形外延 threshold 范围内
  const left = peekX - threshold
  const right = peekX + peekW + threshold
  const top = peekY - threshold
  const bottom = peekY + peekH + threshold
  return mouseX >= left && mouseX <= right && mouseY >= top && mouseY <= bottom
}

/**
 * 复位到屏幕中央（双击/快捷键触发）。
 */
export function resetPosition(
  windowW: number, windowH: number,
  screenW: number, screenH: number,
  workX: number, workY: number,
): { x: number; y: number } {
  return {
    x: Math.round(workX + (screenW - windowW) / 2),
    y: Math.round(workY + (screenH - windowH) / 2),
  }
}
