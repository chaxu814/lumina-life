// ============================================================
// lib/avatarCrop.ts — 头像裁剪的纯计算（无 DOM/React 依赖）
//
// 从 ProfilePanel 的 CropModal 抽出：钳制、中心锚缩放、初始构图。
// 单测跑在 node 环境，不被 React / zustand / localStorage 牵连。
// ============================================================

/** 裁剪区域（容器内的显示坐标） */
export interface CropRect { x: number; y: number; size: number }

/** 边界（容器的 clientWidth/clientHeight） */
export interface CropBounds { w: number; h: number }

/** 最小裁剪边（显示坐标 px）——低于这个尺寸放大后全是马赛克 */
export const MIN_CROP = 24

/** 边界约束：裁剪框必须完整落在容器内，size 不超过容器短边 */
export function clampCrop(c: CropRect, bounds: CropBounds): CropRect {
  const maxSize = Math.max(MIN_CROP, Math.min(bounds.w, bounds.h))
  const size = Math.min(Math.max(MIN_CROP, c.size), maxSize)
  return {
    size,
    x: Math.min(Math.max(0, c.x), Math.max(0, bounds.w - size)),
    y: Math.min(Math.max(0, c.y), Math.max(0, bounds.h - size)),
  }
}

/** 以中心为锚缩放（构图不跳），并做边界钳制 */
export function zoomCrop(c: CropRect, nextSize: number, bounds: CropBounds): CropRect {
  const cx = c.x + c.size / 2
  const cy = c.y + c.size / 2
  return clampCrop({ x: cx - nextSize / 2, y: cy - nextSize / 2, size: nextSize }, bounds)
}

/** 初始裁剪：居中，占容器短边 70% */
export function initialCrop(bounds: CropBounds): CropRect {
  const size = Math.round(Math.max(MIN_CROP, Math.min(bounds.w, bounds.h)) * 0.7)
  return {
    size,
    x: Math.round((bounds.w - size) / 2),
    y: Math.round((bounds.h - size) / 2),
  }
}

/** 缩放宽高（显示坐标容器短边的百分比，用于 UI 展示 "128%"） */
export function zoomPercent(c: CropRect, bounds: CropBounds): number {
  const short = Math.max(MIN_CROP, Math.min(bounds.w, bounds.h))
  return Math.round((c.size / short) * 100)
}
