// ============================================================
// browser/browserUrl.ts — 内置浏览器的地址规则（纯函数，无 Electron 依赖）
//
// 单独成文件是为了能直接单测：browserWindow.ts 顶层 import electron，
// 在 Node 测试环境里没法直接引。
// ============================================================

/** 设备预设（对齐 DevTools 的设备模拟） */
export interface DevicePreset {
  id: string
  label: string
  width: number | null
  height: number | null
  dpr?: number
  mobile?: boolean
}

export const DEVICE_PRESETS: DevicePreset[] = [
  { id: 'responsive', label: 'Responsive', width: null, height: null },
  { id: 'desktop', label: '桌面', width: 1440, height: 900 },
  { id: 'iphone-xr', label: 'iPhone XR', width: 414, height: 896, dpr: 2, mobile: true },
  { id: 'mobile', label: 'Mobile', width: 375, height: 812, dpr: 2, mobile: true },
  { id: 'tablet', label: 'Tablet', width: 768, height: 1024, dpr: 2, mobile: true },
]

/** 允许导航的协议，其余一律拒绝（挡 javascript: / data: 之类） */
export function isAllowedUrl(raw: string): boolean {
  const s = String(raw || '').trim()
  if (!s) {return false}
  if (/^(https?:|file:|about:blank)/i.test(s)) {return true}
  // 裸域名 → 当作 https
  return /^[\w-]+(\.[\w-]+)+([/?#].*)?$/.test(s)
}

/** 补全用户输入的地址：裸域名加 https://，危险协议直接落到空白页 */
export function normalizeUrl(raw: string): string {
  const s = String(raw || '').trim()
  if (!s) {return 'about:blank'}
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    return /^(https?|file|about):/i.test(s) ? s : 'about:blank'
  }
  return `https://${s}`
}
