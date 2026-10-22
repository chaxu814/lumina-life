// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// lib/a11yFontScale.ts — 字号缩放（无障碍）的行内 px 缩放器
//
// 【为什么需要这个文件】
// 「更多设置 → 无障碍 → 字号缩放（100/125/150%）」旧实现是
// `document.documentElement.style.zoom = scale` —— 纯放大镜：
//   · 头像、图标、边框、间距跟着一起放大（用户要的是「字号」缩放）；
//   · 固定尺寸的桌面窗口下放大后内容溢出/被裁切，没有重排；
//   · 最关键：TSX 里几千处 inline `fontSize: 14` 根本不读任何变量，
//     就算 CSS 变量体系改造了也覆盖不到它们。
//
// 现在的覆盖分两路：
//   ① CSS 变量 / em：global.css 的 --font-size-* 已乘上 var(--font-scale)；
//   ② inline px（本文件）：记录每个元素的「设计字号」，按倍率写回。
//
// 【为什么用 MutationObserver】
// React 重渲染会把 fontSize 写回设计值（它不知道自己被缩放过）。
// 观察 style 属性变化后重新应用即可；用「期望值 === 当前值则跳过」
// 避免自触发死循环。
// ============================================================

/** 解析 inline font-size；仅接受 px 数值（'14px' → 14）。非 px 返回 null */
export function parsePxFontSize(value: string): number | null {
  if (!value) {return null}
  const m = /^\s*(-?\d+(?:\.\d+)?)px\s*$/.exec(value)
  return m ? parseFloat(m[1]) : null
}

/** 按倍率计算缩放后的字号（保留一位小数内的精度，去掉浮点尾巴） */
export function scaledFontSize(base: number, scale: number): string {
  const v = base * scale
  // 13*1.25 = 16.25 → '16.25px'；14*1.25 = 17.5 → '17.5px'；整数时无小数点
  return `${Math.round(v * 100) / 100}px`
}

/** 元素是否跳过缩放：SVG 内部（图标/线条画，靠 stroke 与宽高不靠字号） */
export function shouldSkipFontScale(el: Element): boolean {
  return !!el.closest?.('svg') || el.tagName === 'svg'
}

/** dataset 键：设计字号（scale=1 时的原始值）与已应用的倍率 */
const BASE_ATTR = 'fsBase'
const SCALE_ATTR = 'fsScale'

/**
 * 对单个元素应用缩放。幂等：
 * 连续调用同一 scale 不会重复写入（React 重渲染写回设计值后调用可再修正）。
 *
 * 基准（fsBase）的信任判定——当前值是以下三种之一：
 *   a) 设计值：新元素 / React 刚渲染 / 组件动态改了字号 → 以当前值为基准重记；
 *   b) 我们写的缩放产物（=== fsBase × fsScale）→ 基准可信，不动；
 *   c) 空/非 px（CSS 类管的字号）→ 清记录跳过。
 */
export function applyFontScaleToElement(el: HTMLElement, scale: number): void {
  if (shouldSkipFontScale(el)) {return}
  const current = parsePxFontSize(el.style.fontSize)
  const ds = el.dataset as Record<string, string | undefined>

  if (current === null) {
    if (BASE_ATTR in ds) {delete ds[BASE_ATTR]}
    if (SCALE_ATTR in ds) {delete ds[SCALE_ATTR]}
    return
  }

  const appliedScale = ds[SCALE_ATTR] !== undefined ? parseFloat(ds[SCALE_ATTR]) : null
  const recordedBase = ds[BASE_ATTR] !== undefined ? parseFloat(ds[BASE_ATTR]) : null
  const isScaledArtifact =
    appliedScale !== null && recordedBase !== null &&
    Math.abs(recordedBase * appliedScale - current) < 0.01

  if (!isScaledArtifact) {
    ds[BASE_ATTR] = String(current) // 情况 a：当前值就是设计值
  }

  const design = parseFloat(ds[BASE_ATTR] as string)
  const desired = scaledFontSize(design, scale)
  if (el.style.fontSize !== desired) {
    el.style.fontSize = desired
    ds[SCALE_ATTR] = String(scale)
  }
}

/** 全量应用（用户在设置里切换倍率时调用；也用于启动时对齐持久化值） */
export function applyFontScale(root: ParentNode, scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) {return 0}
  let applied = 0
  const all = (root as Element).querySelectorAll<HTMLElement>('*')
  for (let i = 0; i < all.length; i++) {
    const el = all[i]
    if (shouldSkipFontScale(el)) {continue}
    const before = el.style.fontSize
    applyFontScaleToElement(el, scale)
    if (el.style.fontSize !== before) {applied++}
  }
  return applied
}

/**
 * 启动观察器：应对 React 重渲染（style 被写回设计值）与新节点插入。
 * 返回停止函数。只在主窗口调用一次（App.tsx mount 时）。
 */
export function startFontScaleObserver(getScale: () => number, root: ParentNode = document.body): () => void {
  if (typeof MutationObserver === 'undefined') {return () => {}}

  let scheduled = false
  const flush = () => {
    scheduled = false
    applyFontScale(root, getScale())
  }
  const schedule = () => {
    if (scheduled) {return}
    scheduled = true
    // rAF 合并一批 mutation；SSR/测试环境下降级为微任务
    if (typeof requestAnimationFrame === 'function') {requestAnimationFrame(flush)}
    else {Promise.resolve().then(flush)}
  }

  const observer = new MutationObserver((mutations) => {
    let relevant = false
    for (const m of mutations) {
      if (m.type === 'childList' && (m.addedNodes.length > 0)) {relevant = true; break}
      if (m.type === 'attributes' && m.attributeName === 'style') {relevant = true; break}
    }
    if (relevant) {schedule()}
  })
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] })
  return () => observer.disconnect()
}
