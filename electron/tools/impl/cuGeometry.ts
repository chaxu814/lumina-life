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
  if (Number.isNaN(n)) return min
  return Math.min(max, Math.max(min, n))
}

/**
 * 归一化坐标 → 像素坐标。
 * @param n    0–100（0 居首、50 居中、100 居末）
 * @param dim  该轴真实像素尺寸（截图宽/高）
 * n=100 时夹到 dim-1，避免越界 1px。
 */
export function normToPx(n: number, dim: number): number {
  if (!Number.isFinite(dim) || dim <= 0) return 0
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
    if (!buf || buf.length < 24) return null
    // PNG 签名
    if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null
    // IHDR 标识（偏移 12..15）
    if (!(buf[12] === 0x49 && buf[13] === 0x48 && buf[14] === 0x44 && buf[15] === 0x52)) return null
    const w = buf.readUInt32BE(16)
    const h = buf.readUInt32BE(20)
    if (!w || !h || w > 7680 || h > 4320) return null // 合理性护栏（8K）
    return { w, h }
  } catch {
    return null
  }
}
