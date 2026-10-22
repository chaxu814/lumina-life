// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// electron/core/platform/macCoordinate.ts — macOS 屏幕坐标系换算
//
// ============================================================
// ⚠️ 这是 macOS 适配里最容易出错、也最需要写清楚的一块。三个坐标系：
//
//   ① 截图像素（screencapture 产出的 PNG 尺寸）
//   ② macOS 逻辑点（point，AppleScript / cliclick 使用的坐标系）
//   ③ Electron DIP（screen.getAllDisplays().bounds 的单位）
//
//   在 macOS 上 ② 和 ③ 是**同一个坐标系**（DIP == point），所以只需处理 ①↔②。
//
// 事实基础（macOS 坐标系约定）：
//   • 坐标原点：主显示器（menu bar 所在那块）左上角，向右为 x 正，向下为 y 正。
//     副显示器在主屏左边时 x 为负，在上方时 y 为负。AppleScript click at 与
//     cliclick m:x,y 都遵循这个原点。
//   • point 与 backing pixel 的比 = 该显示器的 scaleFactor。Retina 屏通常为 2。
//   • `screencapture`（不带 -R/-D/-x 之外的区域参数）写出的 PNG 是**背衬分辨率**，
//     即同一区域用 point × backingScale 的像素表示。Retina 上一块
//     1512×982 point 的屏会得到 3024×1964 的 PNG。
//   • 因此：模型在截图像素坐标里给的 0–100 归一化位置，换算成注入坐标时
//     **必须除以缩放比**，否则 Retina 上每次点击都落在目标左上方向的一半处。
//
// 本模块采取「实测比例」而非「硬编码 2x」：
//   用 Electron 报出的虚拟桌面 point 尺寸，与实际截图像素尺寸相比，得到
//   effectiveScale = pixelW / pointW。若某台机器 / 某个系统版本 / 某个
//   screencapture 版本实际给出 1x，比例自然算出 1，无需改代码。
//   硬编码 2 会在非 Retina 或已按点输出图的情况下把坐标放大一倍——
//   那是最容易漏测、且症状最迷惑的一类 bug。
//
// 混合缩放多显示器（外接 1x 屏 + 内建 Retina）下，虚拟桌面是**单一整数比例**，
// 无法逐显示器精确换算（AppleScript 本身也没有「指定显示器」的概念）。
//   → computeCaptureGeometry 取最接近实际像素尺寸的那个 scaleFactor，
//     即以「并集面积」最小误差为准；并在 notes 中提示该限制。
//   → 实机若要精确，只能改成逐显示器分块注入（本模块未实现，属于已知限制）。
// ============================================================
//
// 纯函数模块：无 electron / 无 fs，可在 Windows 上完整单测。
// 显示器信息由调用方注入（MacAdapter 从 electron.screen 取），便于测试。
// ============================================================

/** 显示器信息（单位=point/DIP，与 electron.screen.getAllDisplays() 同构） */
export interface DisplayInfo {
  /** 逻辑矩形，原点为主屏左上角；副屏在左/上时为负 */
  bounds: { x: number; y: number; width: number; height: number }
  /** 背衬缩放比，Retina=2，非 Retina=1 */
  scaleFactor: number
}

export interface CaptureGeometry {
  /** 虚拟桌面（point 坐标）原点，通常是 0,0；副屏在左/上时为负 */
  originX: number
  originY: number
  /** 虚拟桌面 point 宽高 */
  pointW: number
  pointH: number
  /** 实测缩放比 = 截图像素 / point，至少 0.01；1 表示非 Retina 或按点输出 */
  scaleX: number
  scaleY: number
  /** 是否由调用方显式锁定了缩放（true 时不再用截图尺寸反推） */
  scaleLocked: boolean
}

const MIN_SCALE = 0.01

/**
 * 由显示器信息 + 实际截图像素尺寸，推导截图坐标系 ↔ 注入坐标系的换算关系。
 *
 * @param displays   所有显示器（Electron DIP=point）
 * @param pixelW     本次截图 PNG 的实际像素宽（未知传 0）
 * @param pixelH     本次截图 PNG 的实际像素高（未知传 0）
 * @param forceScale 显式锁定缩放比（如未来接入 CGEvent 原生坐标时用）；给了就不再反推
 */
export function computeCaptureGeometry(
  displays: DisplayInfo[],
  pixelW = 0,
  pixelH = 0,
  forceScale?: number,
): CaptureGeometry {
  const list = Array.isArray(displays) ? displays.filter(d => d && d.bounds) : []

  // 虚拟桌面并集（point 空间）
  let minX = 0, minY = 0, maxX = 0, maxY = 0
  if (list.length > 0) {
    minX = Infinity; minY = Infinity; maxX = -Infinity; maxY = -Infinity
    for (const d of list) {
      const b = d.bounds
      if (!Number.isFinite(b.x) || !Number.isFinite(b.y)
        || !Number.isFinite(b.width) || !Number.isFinite(b.height)) {continue}
      minX = Math.min(minX, b.x)
      minY = Math.min(minY, b.y)
      maxX = Math.max(maxX, b.x + b.width)
      maxY = Math.max(maxY, b.y + b.height)
    }
  }
  const pointW = Math.max(0, maxX - minX)
  const pointH = Math.max(0, maxY - minY)

  // ── 缩放比来源 1：调用方显式锁定 ──
  if (typeof forceScale === 'number' && Number.isFinite(forceScale) && forceScale > 0) {
    return {
      originX: minX === Infinity ? 0 : minX,
      originY: minY === Infinity ? 0 : minY,
      pointW, pointH,
      scaleX: forceScale, scaleY: forceScale,
      scaleLocked: true,
    }
  }

  // ── 缩放比来源 2：截图尺寸反推（首选，自校正真实输出比例） ──
  if (pointW > 0 && pointH > 0 && pixelW > 0 && pixelH > 0) {
    return {
      originX: minX === Infinity ? 0 : minX,
      originY: minY === Infinity ? 0 : minY,
      pointW, pointH,
      scaleX: pixelW / pointW,
      scaleY: pixelH / pointH,
      scaleLocked: false,
    }
  }

  // ── 缩放比来源 3：显示器 scaleFactor（截图尺寸未知时的兜底） ──
  const fallback = list.length > 0 ? typicalScale(list) : 1
  return {
    originX: minX === Infinity ? 0 : minX,
    originY: minY === Infinity ? 0 : minY,
    pointW, pointH,
    scaleX: fallback, scaleY: fallback,
    scaleLocked: false,
  }
}

/**
 * 混合缩放时的「典型」缩放比：取面积占比最大的那块显示器的 scaleFactor
 * （主屏通常是那块，且面积最大），而非简单平均。
 * 单一缩放比全同则直接返回该值。
 */
function typicalScale(list: DisplayInfo[]): number {
  const valid = list.filter(d => d.scaleFactor > 0)
  if (valid.length === 0) {return 1}
  if (valid.every(d => d.scaleFactor === valid[0].scaleFactor)) {return valid[0].scaleFactor}
  let best = valid[0]
  let bestArea = -1
  for (const d of valid) {
    const area = Math.abs(d.bounds.width * d.bounds.height)
    if (area > bestArea) { best = d; bestArea = area }
  }
  return best.scaleFactor
}

/**
 * 截图像素坐标 → 注入坐标（point）。
 *
 * 关键推导（符号容易搞反，这里写死）：
 *   截图 PNG 的左上角 = **虚拟桌面并集的左上角** = point 坐标 geo.originX/originY。
 *   截图像素 0 对应 point originX（副屏在左时 originX 是负数，如 -1920）。
 *   截图像素向右增长，point 也向右增长。
 *   ∴ P = origin + px / scale
 *
 * 反例：副屏在左、originX=-1920 时，截图像素 x=0 是副屏左缘，
 *   它的 point 坐标正是 -1920，而不是 +1920。若写成 `px/scale - origin`
 *   会在多显示器布局下整体平移一个屏的宽度——症状是「点右边的东西点到了左边」。
 */
export function pixelToPoint(
  x: number, y: number,
  geo: CaptureGeometry,
): { x: number; y: number } {
  const px = Number.isFinite(x) ? x : 0
  const py = Number.isFinite(y) ? y : 0
  return {
    x: Math.round(geo.originX + px / (geo.scaleX || 1)),
    y: Math.round(geo.originY + py / (geo.scaleY || 1)),
  }
}

/**
 * 注入坐标（point）→ 截图像素坐标（pixelToPoint 的逆运算）。
 * 用于「把窗口中心点（point）反推成截图坐标」等逆向场景。
 * 宽高不参与本函数；若需要矩形，用 pointRectToPixel。
 */
export function pointToPixel(
  x: number, y: number,
  geo: CaptureGeometry,
): { x: number; y: number } {
  const px = Number.isFinite(x) ? x : 0
  const py = Number.isFinite(y) ? y : 0
  return {
    x: Math.round((px - geo.originX) * geo.scaleX),
    y: Math.round((py - geo.originY) * geo.scaleY),
  }
}

/**
 * point 矩形 → pixel 矩形（x/y/w/h 整体缩放）。
 *
 * 为什么要整个矩形一起换：若只换原点而把 point 的 w/h 直接当像素用，
 * 中心点计算会混用两套单位，Retina 上中心会偏移半个控件宽/高。
 */
export function pointRectToPixel(
  rect: { x: number; y: number; w: number; h: number },
  geo: CaptureGeometry,
): { x: number; y: number; w: number; h: number } {
  const tl = pointToPixel(rect.x, rect.y, geo)
  return {
    x: tl.x,
    y: tl.y,
    w: Math.round((Number.isFinite(rect.w) ? rect.w : 0) * geo.scaleX),
    h: Math.round((Number.isFinite(rect.h) ? rect.h : 0) * geo.scaleY),
  }
}

/**
 * 把 point 坐标夹到有效虚拟桌面范围内。
 *
 * 为什么需要：归一化坐标 0/100 换算出来可能正好落在边界外一个像素，
 * cliclick / System Events 对负坐标与大坐标的行为不一致（可能直接无操作）。
 * 这里做一次夹取，行为可预期。
 */
export function clampPointToDesktop(
  x: number, y: number,
  geo: CaptureGeometry,
): { x: number; y: number } {
  // 几何未知（尚未截图 / 无显示器信息）时**不做夹取**：
  // 此时 pointW/pointH 为 0，若仍按「空矩形」夹取会把所有坐标压成 (0,0)，
  // 反而制造一个更难排查的 bug。宁可原样透传给 cliclick 让它自己处理。
  if (!(geo.pointW > 0) || !(geo.pointH > 0)) {
    return {
      x: Number.isFinite(x) ? Math.round(x) : 0,
      y: Number.isFinite(y) ? Math.round(y) : 0,
    }
  }
  const minX = geo.originX
  const minY = geo.originY
  const maxX = geo.originX + Math.max(0, geo.pointW - 1)
  const maxY = geo.originY + Math.max(0, geo.pointH - 1)
  const cx = Number.isFinite(x) ? Math.min(maxX, Math.max(minX, Math.round(x))) : minX
  const cy = Number.isFinite(y) ? Math.min(maxY, Math.max(minY, Math.round(y))) : minY
  return { x: cx, y: cy }
}

/**
 * 一步到位：截图像素坐标 → 夹取到有效桌面内的注入 point 坐标。
 * 这是 MacAdapter 里所有键鼠原语的统一入口。
 */
export function toInjectablePoint(
  px: number, py: number,
  geo: CaptureGeometry,
): { x: number; y: number } {
  const p = pixelToPoint(px, py, geo)
  return clampPointToDesktop(p.x, p.y, geo)
}

/** 人类可读的换算说明（设置页 / 排障日志用） */
export function describeGeometry(geo: CaptureGeometry): string {
  const s = `${geo.scaleX.toFixed(2)}×`
  return `截图坐标系 → 注入坐标系：比例 ${s}，虚拟桌面原点 (${geo.originX},${geo.originY})，point 尺寸 ${geo.pointW}×${geo.pointH}`
}
