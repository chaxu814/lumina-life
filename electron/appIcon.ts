// ============================================================
// appIcon.ts — 统一解析应用图标路径（开发 / 打包后都能用）
//
// 图标资源放在项目根 resources/：
//   icon.ico（Windows 多尺寸，electron-builder 用于 exe/安装包/快捷方式）
//   icon.png（512，窗口/通知/mac/linux）
//   icon-16.png / icon-32.png（托盘等小尺寸）
//
// 运行时路径：
//   开发：out/main/… → 项目根 resources/icon.png
//   打包：extraResources 把 resources/ 拷到 resourcesPath/resources/
// ============================================================
import { existsSync } from 'fs'
import { join } from 'path'
import { nativeImage } from 'electron'

let cached: string | null = null

export function getAppIconPath(size: 16 | 32 | 256 | 512 = 256): string {
  if (size === 256 && cached && existsSync(cached)) return cached
  const name = size === 16 ? 'icon-16.png' : size === 32 ? 'icon-32.png' : 'icon.png'
  const candidates = [
    // 打包后：resourcesPath/resources/icon.png（extraResources from:resources to:resources）
    join(process.resourcesPath || '', 'resources', name),
    // 开发：out/main 上两级到项目根 resources
    join(__dirname, '..', '..', 'resources', name),
    // 兜底：其它构建布局
    join(__dirname, '..', 'resources', name),
    join(process.resourcesPath || '', 'resources', 'icon.png'),
  ]
  for (const c of candidates) {
    if (c && existsSync(c)) {
      if (size === 256) cached = c
      return c
    }
  }
  return join(__dirname, '..', '..', 'resources', 'icon.png')
}

/** Windows 托盘图标：优先用 16x16 专用图，找不到再从大图缩放 */
export function getTrayIcon() {
  const small = nativeImage.createFromPath(getAppIconPath(16))
  if (!small.isEmpty()) return small
  return nativeImage.createFromPath(getAppIconPath(256)).resize({ width: 16, height: 16 })
}
