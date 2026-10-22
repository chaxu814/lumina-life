// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// pet/life/alphaTrim.ts — 🔍 按可见像素 alpha 测包围盒（alpha-trim 纯逻辑）
//
// 从 WebGL readPixels 读出的 RGBA 缓冲里，找到 alpha 超过阈值的像素包围盒，
// 输出相对整块 getBounds 的「四边内缩比例」{l,t,r,b}，供 setShape 贴身裁剪。
//
// 注意：readPixels 原点在左下，而内缩比例按「自上而下」描述，因此扫描时
// 对 Y 做翻转（row = bh-1-sy）。
// 零依赖、可单测（在 125%/150%/4K 缩放下，比例是无量纲的，天然 DPI 无关）。
// ============================================================

export interface TrimRatios {
  /** 左边内缩比例 0–maxSide */
  l: number
  /** 上边内缩比例 */
  t: number
  /** 右边内缩比例 */
  r: number
  /** 下边内缩比例 */
  b: number
}

export interface ScanAlphaOptions {
  /** 采样步长（降采样控制 CPU），默认 2 */
  step?: number
  /** alpha 阈值（> 才算可见），默认 28 */
  alphaThreshold?: number
  /** 单边最多内缩比例，防误裁，默认 0.45 */
  maxSide?: number
}

/**
 * 扫描 RGBA 缓冲，返回四边内缩比例；整幅全透明时返回 null（由调用方回退上次结果）。
 */
export function scanAlphaBounds(
  rgba: Uint8Array,
  bw: number,
  bh: number,
  opts: ScanAlphaOptions = {},
): TrimRatios | null {
  if (!rgba || bw <= 0 || bh <= 0) {return null}
  const step = Math.max(1, Math.round(opts.step ?? 2))
  const ALPHA = opts.alphaThreshold ?? 28
  const cap = opts.maxSide ?? 0.45

  let minX = bw, minY = bh, maxX = -1, maxY = -1
  for (let sy = 0; sy < bh; sy += step) {
    const row = bh - 1 - sy // readPixels 原点在左下，翻转为自上而下
    const rowBase = row * bw * 4
    for (let sx = 0; sx < bw; sx += step) {
      const a = rgba[rowBase + sx * 4 + 3]
      if (a > ALPHA) {
        if (sx < minX) {minX = sx}
        if (sx > maxX) {maxX = sx}
        if (sy < minY) {minY = sy}
        if (sy > maxY) {maxY = sy}
      }
    }
  }
  if (maxX < 0) {return null} // 全透明：保留上次

  const l = Math.min(cap, Math.max(0, (minX - step) / bw))
  const r = Math.min(cap, Math.max(0, (bw - 1 - maxX - step) / bw))
  const t = Math.min(cap, Math.max(0, (minY - step) / bh))
  const b = Math.min(cap, Math.max(0, (bh - 1 - maxY - step) / bh))
  return { l, t, r, b }
}

/**
 * 画布 backing store 与 CSS 像素的比值（readPixels 用）。
 *
 * 高画质下 PIXI renderer resolution = devicePixelRatio，低画质固定为 1，
 * 因此 readPixels 区域不能一律乘 devicePixelRatio，否则在 125/150% 缩放 +
 * 低画质时读错区域、误判包围盒而把模型裁掉。直接用「画布实际像素宽 /
 * CSS 宽」最稳，对任意 DPI 与画质都正确。
 */
export function backingPixelScale(canvasWidth: number, cssWidth: number, devicePixelRatio: number): number {
  if (canvasWidth > 0 && cssWidth > 0 && Number.isFinite(canvasWidth) && Number.isFinite(cssWidth)) {
    return canvasWidth / cssWidth
  }
  return devicePixelRatio > 0 ? devicePixelRatio : 1
}
