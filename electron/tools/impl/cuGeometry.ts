// ============================================================
// cuGeometry.ts — Computer Use 坐标 / 图像纯几何工具
//
// 零依赖、可单测：
//   - 归一化坐标(0–100) ↔ 像素坐标 的换算（免疫分辨率 / 高分屏 DPI）
//   - 从 PNG 文件头(IHDR)直接读取截图宽高（模型所见即所测）
//
// 为什么需要归一化坐标：
//   让 VLM 输出 0–100 的相对坐标（像人看屏幕那样判断“在画面百分之几的位置”），
//   引擎再按“本次截图的真实像素尺寸”换算成鼠标坐标。模型不需要知道分辨率，
//   也不会因为高分屏缩放 / 不同机器分辨率而点偏。
// ============================================================

/** 将数值夹在 [min,max]；NaN 视为 min，±Infinity 夹到对应边界 */
export function clamp(n: number, min: number, max: number): number {
  if (Number.isNaN(n)) {return min}
  return Math.min(max, Math.max(min, n))
}

/**
 * 归一化坐标 → 像素坐标。
 * @param n    0–100（0 居首、50 居中、100 居末）
 * @param dim  该轴真实像素尺寸（截图宽/高）
 * n=100 时夹到 dim-1，避免越界 1px。
 */
export function normToPx(n: number, dim: number): number {
  if (!Number.isFinite(dim) || dim <= 0) {return 0}
  const safe = Number.isFinite(n) ? n : 0
  const v = Math.round((clamp(safe, 0, 100) / 100) * dim)
  return Math.max(0, Math.min(dim - 1, v))
}

/** 归一化点 → 像素点 */
export function mapNormPoint(nx: number, ny: number, w: number, h: number): { x: number; y: number } {
  return { x: normToPx(nx, w), y: normToPx(ny, h) }
}

/**
 * 解析 PNG 的 IHDR 宽高。
 * PNG 结构：8 字节签名 → 第一个 chunk 即 IHDR
 *   偏移 0..7   签名 89 50 4E 47 0D 0A 1A 0A
 *   偏移 8..11  IHDR length(=13)
 *   偏移 12..15 'IHDR'
 *   偏移 16..19 宽度(big-endian uint32)
 *   偏移 20..23 高度(big-endian uint32)
 * 只需前 24 字节，不解码整图。
 */
export function pngDimensions(buf: Buffer): { w: number; h: number } | null {
  try {
    if (!buf || buf.length < 24) {return null}
    // PNG 签名
    if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) {return null}
    // IHDR 标识（偏移 12..15）
    if (!(buf[12] === 0x49 && buf[13] === 0x48 && buf[14] === 0x44 && buf[15] === 0x52)) {return null}
    const w = buf.readUInt32BE(16)
    const h = buf.readUInt32BE(20)
    if (!w || !h || w > 7680 || h > 4320) {return null} // 合理性护栏（8K）
    return { w, h }
  } catch {
    return null
  }
}

// ============================================================
// Set-of-Mark 网格（把“估坐标”变成“读编号”，显著提升小模型准度）
// ============================================================

export interface GridInfo { cols: number; rows: number; count: number }

/** 按画面宽高比决定网格行列（默认横向 10 格，行数随比例，夹在 4–16） */
export function gridDims(imgW: number, imgH: number, cols = 10): GridInfo {
  const safeCols = Math.max(2, Math.round(cols))
  const ratio = imgW > 0 && imgH > 0 ? imgH / imgW : 9 / 16
  let rows = Math.round(safeCols * ratio)
  rows = Math.max(4, Math.min(16, rows))
  return { cols: safeCols, rows, count: safeCols * rows }
}

/**
 * 网格编号（row-major，从 0 开始，从左到右、从上到下）→ 格子中心归一化坐标。
 * 越界返回 null。
 */
export function cellToNorm(cell: number, cols: number, rows: number): { nx: number; ny: number } | null {
  if (!Number.isFinite(cell) || cols <= 0 || rows <= 0) {return null}
  const count = cols * rows
  const id = Math.floor(cell)
  if (id < 0 || id >= count) {return null}
  const r = Math.floor(id / cols)
  const c = id % cols
  return {
    nx: (c + 0.5) * (100 / cols),
    ny: (r + 0.5) * (100 / rows),
  }
}

// ============================================================
// zoom 局部放大（粗选格 → 放大 → 细定位）
// ============================================================

export interface NormRect { nx0: number; ny0: number; nx1: number; ny1: number }

/** 以 (cx,cy) 为中心、span 为边长(归一化)求裁剪框；clamp 到 0–100，越界时平移保持尺寸 */
export function zoomCrop(cx: number, cy: number, span: number): NormRect {
  const s = clamp(span, 4, 100)
  const half = s / 2
  let x0 = cx - half, x1 = cx + half
  let y0 = cy - half, y1 = cy + half
  if (x0 < 0) { x1 -= x0; x0 = 0 }
  if (x1 > 100) { x0 -= (x1 - 100); x1 = 100 }
  if (y0 < 0) { y1 -= y0; y0 = 0 }
  if (y1 > 100) { y0 -= (y1 - 100); y1 = 100 }
  return {
    nx0: clamp(x0, 0, 100 - s),
    ny0: clamp(y0, 0, 100 - s),
    nx1: clamp(x1, s, 100),
    ny1: clamp(y1, s, 100),
  }
}

/** 放大裁剪图内的局部归一化坐标 (0–100) → 全屏全局归一化坐标 */
export function localToGlobal(lx: number, ly: number, crop: NormRect): { nx: number; ny: number } {
  const cx = clamp(lx, 0, 100)
  const cy = clamp(ly, 0, 100)
  return {
    nx: crop.nx0 + (cx / 100) * (crop.nx1 - crop.nx0),
    ny: crop.ny0 + (cy / 100) * (crop.ny1 - crop.ny0),
  }
}
