// ============================================================
// pet/vrm/vrmLayout.ts — VRM 桌宠布局的纯计算（无 three 依赖，可单测）
//
// 3D 模型不像 Live2D 那样有透明像素 alpha-trim；我们把角色放进一个
// 可预测的「居中贴底广告牌」区域，窗口 setShape 就按这个矩形裁剪。
// 所有数值都是 CSS 像素（与全屏舞台窗口的 DIP 一致），物理像素在上报时乘 dpr。
// ============================================================

export interface VrmLayoutOptions {
  /** 角色目标高度占屏幕高度的比例（默认 0.78） */
  heightRatio?: number
  /** 角色底部距屏幕底的间距占屏幕高度的比例（默认 0.03） */
  bottomGapRatio?: number
  /** 角色宽度相对高度的安全上限（防止某些模型包围盒过宽） */
  maxWidthRatio?: number
}

/** 等比缩放到不超过最大高/宽 */
export function scaleToFit(srcW: number, srcH: number, maxH: number, maxW: number): number {
  if (!srcW || !srcH) return 1
  return Math.min(maxH / srcH, maxW / srcW)
}

/**
 * 计算角色在全屏舞台中的「广告牌」包围矩形（CSS 像素）。
 * charW/charH 是角色当前绘制尺寸（CSS px），viewW/viewH 是舞台尺寸。
 * 返回 {x,y,width,height}，水平居中、贴底。
 */
export function centeredBottomRect(
  charW: number,
  charH: number,
  viewW: number,
  viewH: number,
  opts: VrmLayoutOptions = {},
): { x: number; y: number; width: number; height: number } {
  const bottomGap = viewH * (opts.bottomGapRatio ?? 0.03)
  const w = Math.max(1, Math.min(charW, viewW * (opts.maxWidthRatio ?? 0.6)))
  const h = Math.max(1, Math.min(charH, viewH))
  const x = Math.round((viewW - w) / 2)
  const y = Math.round(viewH - h - bottomGap)
  return { x, y, width: Math.round(w), height: Math.round(h) }
}

/**
 * 由模型包围盒的归一化高/宽比（包围盒高=1 时的宽）与屏幕尺寸，
 * 算出角色目标绘制尺寸（CSS px）。
 * bboxAspect = width / height（模型自身包围盒宽高比）。
 */
export function characterPixelSize(
  bboxAspect: number,
  viewW: number,
  viewH: number,
  opts: VrmLayoutOptions = {},
): { width: number; height: number } {
  const heightRatio = opts.heightRatio ?? 0.78
  const targetH = viewH * heightRatio
  const maxW = viewW * (opts.maxWidthRatio ?? 0.6)
  // 先用目标高度反推宽度
  let w = targetH * bboxAspect
  let h = targetH
  if (w > maxW) { // 过宽则按宽度收敛
    w = maxW
    h = maxW / bboxAspect
  }
  return { width: Math.round(w), height: Math.round(h) }
}

/** CSS 像素矩形 → 物理像素（上报给 setShape，主进程按物理像素裁剪） */
export function toPhysicalRect(
  rect: { x: number; y: number; width: number; height: number },
  dpr: number,
): { x: number; y: number; width: number; height: number } {
  const k = dpr > 0 ? dpr : 1
  return {
    x: Math.round(rect.x * k),
    y: Math.round(rect.y * k),
    width: Math.round(rect.width * k),
    height: Math.round(rect.height * k),
  }
}
