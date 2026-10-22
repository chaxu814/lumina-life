// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// services/themeClient.ts — 渲染进程侧主题应用
//
// 启动时向主进程拉取当前主题，把 resolvedVars 写入 <html> 的
// inline custom property；订阅 theme:changed 实时跟随切换。
// 桌宠/托盘窗口由主进程 executeJavaScript 注入，不走这里。
// ============================================================

/** 当前生效的主题名（供设置面板高亮） */
let currentThemeName = ''

export function getActiveThemeName(): string {
  return currentThemeName
}

/** 把 resolvedVars 注入 documentElement（inline 覆盖 stylesheet） */
export function injectThemeVars(vars: Record<string, string>, isDark: boolean): void {
  const el = document.documentElement
  for (const [k, v] of Object.entries(vars)) {
    try { el.style.setProperty(k, v) } catch { /* 非法值忽略 */ }
  }
  el.style.colorScheme = isDark ? 'dark' : 'light'

  // 🐛 同步 data-theme：命名主题是唯一色源，但它只注入 inline 变量，
  // 而 global.css 里 `[data-theme="dark"]` 那一大段（--surface-0 等的暗色值、
  // 表单控件暗色覆盖、面板内联样式兜底）全靠这个属性选择器触发。
  // 两边不同步就会出现「变量是暗的、组件走浅色分支」或反过来的割裂。
  const next = isDark ? 'dark' : 'light'
  if (el.getAttribute('data-theme') !== next) {
    el.setAttribute('data-theme', next)
  }
}

/** 订阅主题变化 */
export function initThemeClient(): void {
  const api = (window as any).luminaAPI
  if (!api?.themeGetCurrent) { return }

  // 启动时应用持久化主题
  api.themeGetCurrent().then((res: any) => {
    if (res?.ok && res.resolvedVars) {
      currentThemeName = res.theme?.name || ''
      injectThemeVars(res.resolvedVars, !!res.theme?.isDark)
    }
  }).catch(() => { /* 主进程未就绪则忽略 */ })

  // 跟随主题切换
  if (typeof api.themeOnChanged === 'function') {
    api.themeOnChanged((payload: { name: string; isDark: boolean; resolvedVars: Record<string, string> }) => {
      currentThemeName = payload.name
      injectThemeVars(payload.resolvedVars, payload.isDark)
    })
  }
}
