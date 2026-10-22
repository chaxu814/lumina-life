// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
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

// ═══════════════════════════════════════════════════════════
// 默认搜索引擎（地址栏输入非网址时用）
// ═══════════════════════════════════════════════════════════

/** 默认搜索引擎：Bing。urlTemplate 里的 {q} 会被替换为编码后的查询词 */
export const SEARCH_ENGINE = {
  id: 'bing',
  name: 'Bing',
  urlTemplate: 'https://www.bing.com/search?q={q}',
} as const

/** 把查询词拼成搜索 URL */
export function buildSearchUrl(query: string, engine: { urlTemplate: string } = SEARCH_ENGINE): string {
  return engine.urlTemplate.replace('{q}', encodeURIComponent(String(query || '').trim()))
}

/** 输入是否"像网址"（裸域名 / localhost / host:port），而不是搜索词 */
function looksLikeDomain(s: string): boolean {
  if (/\s/.test(s)) {return false}                 // 有空格 → 搜索词
  if (/[\u4e00-\u9fa5]/.test(s)) {return false}    // 含中文 → 搜索词
  if (/^localhost(:\d+)?([/?#].*)?$/i.test(s)) {return true}
  return /^[\w-]+(\.[\w-]+)+(:\d+)?([/?#].*)?$/.test(s)
}

/**
 * 解析地址栏输入 → 最终导航 URL。
 *   · 空                     → about:blank
 *   · scheme://…             → 只放行 http(s)/file，其余落空白页
 *   · 像网址（裸域名/localhost/host:port）→ 补 https://
 *   · 其它伪协议（about: 放行，javascript:/data: 落空白页）
 *   · 其余（中文 / 空格 / 裸词）→ 当作搜索词，走默认搜索引擎（Bing）
 */
export function resolveAddressInput(raw: string, engine: { urlTemplate: string } = SEARCH_ENGINE): string {
  const s = String(raw || '').trim()
  if (!s) {return 'about:blank'}

  // 1) 显式 "scheme://"
  const m = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s)
  if (m) {return /^(https?|file)$/i.test(m[1]) ? s : 'about:blank'}

  // 2) 像网址（含 localhost / host:port）→ 补 https
  //    必须放在"伪协议"判断之前，否则 localhost:3000 会被当成 scheme=localhost
  if (looksLikeDomain(s)) {return `https://${s}`}

  // 3) 其余带冒号的伪协议：about: 放行，javascript:/data:/mailto: 一律拒绝
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    return /^about:/i.test(s) ? s : 'about:blank'
  }

  // 4) 其它 → 搜索
  return buildSearchUrl(s, engine)
}
