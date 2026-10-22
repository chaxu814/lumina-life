// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
/**
 * pageRenderer.ts —— 离屏真浏览器渲染（反爬 / JS 渲染站点的兜底）
 *
 * ────────────────────────────────────────────────────────────
 * 【要解决的真实问题】2026-10-12：HTTP 抓取对一批站点完全无效 ——
 *   · B 站视频页：正文由 JS 渲染，HTTP 拿到的 HTML 里几乎没有文字；
 *   · 百度百科：返回「百度安全验证」；
 *   · 知乎 / Anibase：Cloudflare 挑战页 / 占位页。
 *   结果是「收集资料」在最需要它的站点上直接失败。
 *
 * 【为什么用 Electron 自己的浏览器而不是 Chrome CDP】
 *   仓库里已有 `tools/impl/browser_cdp.ts`（会话式的浏览器控制），
 *   但它是为「交互操作」设计的：要建会话、有 5 分钟空闲回收、面向点击/截图。
 *   我们这里只需要「加载 → 等渲染 → 取文本 → 关掉」这一件事，
 *   用 Electron 现成的 `BrowserWindow` + `executeJavaScript` 更轻、更可控，
 *   也不必依赖用户机器上装了 Chrome。
 *
 * 【安全与成本约束】（每一处都是刻意加的）
 *   · `show: false` 离屏；`nodeIntegration: false` + `contextIsolation: true` + `sandbox: true`
 *   · 拒绝一切权限请求（定位/摄像头/通知/剪贴板…）
 *   · 拦截 window.open（防弹窗）
 *   · 拦截下载（防把文件下到用户磁盘）
 *   · 并发上限 1：渲染很贵（每个页面 2~5 秒），绝不并发开一堆窗口
 *   · 总超时兜底，超时立刻销毁窗口
 *   · 非 Electron 环境（单元测试 / 纯 Node）优雅返回 null
 * ────────────────────────────────────────────────────────────
 */

import { BrowserWindow, session as electronSession } from 'electron'
import { getAppIconPath } from '../../appIcon'

export interface RenderedPage {
  /** 渲染后的可见文本（innerText —— 浏览器已自动排除 display:none 的元素） */
  text: string
  /** 渲染后的完整 HTML（供正文提取器复用同一套规则） */
  html: string
  title: string
}

export interface RenderOptions {
  /** 总超时（毫秒），默认 20s */
  timeoutMs?: number
  /** 载入完成后再等一会儿让 JS 把内容渲染出来，默认 900ms */
  settleMs?: number
}

/** 渲染专用分区：持久化，让「人机验证」一次通过后后续复用，减少反复验证 */
const RENDER_PARTITION = 'persist:lumina-render'

/** 并发上限：渲染很贵，同时开多个窗口会拖慢整机 */
const MAX_CONCURRENT = 1
let activeRenders = 0

/** 权限/下载拦截只需对分区设置一次 */
let partitionHardened = false

/** 是否具备渲染能力（Electron 环境 + BrowserWindow 可用） */
export function isRendererAvailable(): boolean {
  return typeof BrowserWindow === 'function'
}

function hardenPartition(): void {
  if (partitionHardened) {return}
  partitionHardened = true
  try {
    const ses = electronSession.fromPartition(RENDER_PARTITION)
    // 拒绝一切权限请求 —— 我们只是读文本，不需要任何设备能力
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    // 拦截下载
    ses.on('will-download', (event) => { event.preventDefault() })
  } catch { /* 分区不可用时忽略：后续仍可渲染，只是少了这层加固 */ }
}

/**
 * 用离屏浏览器加载页面并取回渲染后的文本。
 *
 * 失败/超时/无渲染能力时**返回 null**（调用方据此保持"没抓到"的语义，
 * 不要伪造内容）。
 */
export async function renderPageWithBrowser(
  url: string,
  opts?: RenderOptions,
): Promise<RenderedPage | null> {
  if (!isRendererAvailable()) {return null}
  if (activeRenders >= MAX_CONCURRENT) {
    console.log('[pageRenderer] 已有渲染在进行，跳过本次（避免同时开多个窗口）')
    return null
  }
  if (!/^https?:\/\//i.test(url)) {return null}

  const timeoutMs = opts?.timeoutMs ?? 20000
  const settleMs = opts?.settleMs ?? 900

  activeRenders++
  let win: BrowserWindow | null = null
  try {
    hardenPartition()

    win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      // 项目约定：每个 BrowserWindow 都要显式设 icon，
      // 否则任务栏/Alt-Tab 会显示 Electron 默认原子图标（tests/windowIcon.test.ts 会把关）
      icon: getAppIconPath(256),
      webPreferences: {
        partition: RENDER_PARTITION,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        javascript: true,
        images: false,          // 只读文字，不加载图片：更快、更省流量
        backgroundThrottling: false,   // 离屏窗口不要被节流，否则渲染会变慢
      },
    })

    // 防弹窗
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    // 防跳转劫持：只允许最初的 URL 及其同源跳转（重定向到别的域就不再跟随）
    let currentUrl = url
    win.webContents.on('will-navigate', (event, navUrl) => {
      try {
        const from = new URL(currentUrl)
        const to = new URL(navUrl)
        if (to.hostname !== from.hostname) {
          event.preventDefault()
          console.log(`[pageRenderer] 阻止跨站跳转: ${from.hostname} → ${to.hostname}`)
        } else {
          currentUrl = navUrl
        }
      } catch { /* URL 解析失败则不拦截 */ }
    })

    const loadPromise = win.loadURL(url)
    // 有些站点会一直挂着不触发 did-finish-load，必须自己兜超时
    const loaded = await Promise.race([
      loadPromise.then(() => true).catch(() => false),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), timeoutMs)),
    ])
    if (!loaded) {
      console.log(`[pageRenderer] 加载超时/失败: ${url.slice(0, 80)}`)
      return null
    }

    // 等 JS 把内容渲染出来（SPA 常见）
    await new Promise(resolve => setTimeout(resolve, settleMs))

    const payload = await win.webContents.executeJavaScript(
      `JSON.stringify({
         title: document.title || '',
         text: (document.body && document.body.innerText) ? document.body.innerText : '',
         html: document.documentElement ? document.documentElement.outerHTML : ''
       })`,
      true,
    ) as string

    const parsed = JSON.parse(payload || '{}') as Partial<RenderedPage>
    const text = String(parsed.text || '').trim()
    if (!text || text.length < 20) {
      console.log(`[pageRenderer] 渲染后仍无文本: ${url.slice(0, 80)}`)
      return null
    }

    return {
      text,
      html: String(parsed.html || ''),
      title: String(parsed.title || '').trim(),
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`[pageRenderer] 渲染失败: ${msg.slice(0, 120)}`)
    return null
  } finally {
    activeRenders--
    try { win?.destroy() } catch { /* 窗口可能已销毁 */ }
  }
}
