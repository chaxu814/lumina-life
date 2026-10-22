// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// browser/browserWindow.ts — Lumina 内置浏览器
//
// 架构（这里最容易搞反，改之前先看清楚）：
//   BrowserWindow.webContents → 只跑工具栏宿主页 browser.html，**永不导航**
//   <webview id="view">       → 真正的网页本体，唯一的地址/标题/缩放真相源
//
// 之前把导航/读取/点击/截图全打在窗口 webContents 上，后果是：
//   - 一 navigate 整个窗口被目标网页替换，工具栏直接消失
//   - 地址栏永远显示 file:///.../browser.html（宿主页自己的地址）
//   - 页面标题每次 page-title-updated 就再拼一次 "— Lumina 浏览器"，无限重复
//   - Agent 的 browser_read 读到的是工具栏文字，browser_click 点的是工具栏按钮
//
// 现在统一为：主进程 → executeJavaScript → 宿主页 window.__b → <webview>，
// 宿主页把 webview 状态通过 browser:state-changed 回报，主进程缓存后广播。
//
// 安全边界：
//   - 独立 session（不污染用户日常浏览数据）
//   - 只放行 http/https/file/about:blank，拦 javascript:/data:
//   - 不授予页面 Node 集成（nodeIntegration:false + contextIsolation）
//   - 窗口始终 skipTaskbar，单例复用
// ============================================================

import {
  BrowserWindow,
  Session,
  ipcMain,
  screen,
  session as electronSession,
} from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'

/** 内置浏览器专用 session：与用户默认浏览数据隔离，可整体清理 */
const SESSION_PARTITION = 'persist:lumina-browser'

/** 设备预设与地址规则来自纯函数模块，方便单测 */
export { DEVICE_PRESETS, isAllowedUrl, normalizeUrl, resolveAddressInput, buildSearchUrl, SEARCH_ENGINE } from './browserUrl'
export type { DevicePreset } from './browserUrl'
import { isAllowedUrl, normalizeUrl, resolveAddressInput } from './browserUrl'
import { getAppIconPath } from '../appIcon'

export interface BrowserState {
  url: string
  title: string
  canBack: boolean
  canForward: boolean
  loading: boolean
  zoom: number
}

const EMPTY_STATE: BrowserState = {
  url: '',
  title: '',
  canBack: false,
  canForward: false,
  loading: false,
  zoom: 1,
}

let win: BrowserWindow | null = null
let ipcRegistered = false
/** 宿主页（工具栏）加载完成的信号——所有转发都要先等它，否则 window.__b 还不存在 */
let hostReady: Promise<void> = Promise.resolve()
/** 宿主页回报的最新状态，作为宿主没醒时的兜底 */
let lastState: BrowserState = { ...EMPTY_STATE }

function resolveHtml(): string {
  const candidates = [
    join(__dirname, 'browser.html'),                                  // out/main
    join(__dirname, '..', '..', 'electron', 'browser', 'browser.html'), // dev
    join(process.cwd(), 'electron', 'browser', 'browser.html'),
  ]
  for (const c of candidates) {if (existsSync(c)) {return c}}
  return candidates[0]
}

function resolvePreload(): string {
  const candidates = [
    join(__dirname, '..', 'preload', 'browser.js'),          // out/preload
    join(__dirname, '..', '..', 'out', 'preload', 'browser.js'),
    join(process.cwd(), 'out', 'preload', 'browser.js'),
  ]
  for (const c of candidates) {if (existsSync(c)) {return c}}
  return candidates[0]
}

/** 必须拿浏览器自己的 partition，否则"清除 Cookie 与缓存"会顺手清掉用户日常浏览数据 */
function getSession(): Session {
  return electronSession.fromPartition(SESSION_PARTITION)
}

/** 单例窗口：已开就复用并聚焦 */
export function showBrowserWindow(initialUrl?: string): BrowserWindow {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) {win.restore()}
    win.show()
    win.focus()
    if (initialUrl) {void navigate(initialUrl)}
    return win
  }

  const display = screen.getPrimaryDisplay()
  const { width: dw, height: dh } = display.workAreaSize
  const width = Math.min(1180, Math.max(720, Math.floor(dw * 0.8)))
  const height = Math.min(820, Math.max(520, Math.floor(dh * 0.8)))

  win = new BrowserWindow({
    width,
    height,
    minWidth: 560,
    minHeight: 420,
    title: 'Lumina 浏览器',
    icon: getAppIconPath(256),
    backgroundColor: '#12141a',
    show: false,
    autoHideMenuBar: true,
    skipTaskbar: true,
    webPreferences: {
      preload: resolvePreload(),
      partition: SESSION_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      // 宿主页只用 contextBridge，不用 Node API，关掉 sandbox 以避开
      // sandbox 与 <webview> 的已知兼容问题；页面侧仍是 nodeIntegration:false。
      sandbox: false,
      // 工具栏宿主页用 <webview> 承载真实页面
      webviewTag: true,
    },
  })

  const w = win
  hostReady = new Promise<void>((resolve) => {
    let settled = false
    const finish = () => { if (!settled) { settled = true; resolve() } }
    w.webContents.once('did-finish-load', finish)
    w.webContents.once('did-fail-load', (_e, _code, desc) => {
      console.warn('[Browser] 工具栏宿主页加载失败：', desc)
      finish()
    })
  })
  hostReady.then(() => { if (initialUrl) {void navigate(initialUrl)} })

  // 宿主页绝不能被导航走：一旦离开 browser.html，工具栏就没了。
  // 注意 will-navigate 只对"页面/用户发起的导航"触发，loadFile 不受影响。
  w.webContents.on('will-navigate', (e) => e.preventDefault())
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  // 网页本体的白名单挂在 webview 上，规则只在 browserUrl.ts 里存在一份
  w.webContents.on('did-attach-webview', (_e, guest) => {
    guest.on('will-navigate', (ev, url) => {
      if (!isAllowedUrl(url)) {ev.preventDefault()}
    })
    guest.setWindowOpenHandler(({ url }) => {
      // target=_blank 一律在当前窗口里打开，不弹新窗
      if (isAllowedUrl(url)) {void navigate(url)}
      return { action: 'deny' }
    })
  })

  w.on('closed', () => {
    if (win === w) {
      win = null
      lastState = { ...EMPTY_STATE }
    }
  })

  void w.loadFile(resolveHtml())
  return w
}

export function getBrowserWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null
}

export function isBrowserOpen(): boolean {
  return !!getBrowserWindow()?.isVisible()
}

/**
 * 调用宿主页暴露的 window.__b.<method>(...args)。
 * executeJavaScript 会自动 await 返回的 Promise，所以可以直接拿异步结果。
 */
async function callHost<T>(method: string, args: unknown[] = []): Promise<T> {
  if (!getBrowserWindow()) {throw new Error('浏览器未打开')}
  await hostReady
  const w = getBrowserWindow()
  if (!w) {throw new Error('浏览器未打开')}
  const literal = args.map((a) => JSON.stringify(a === undefined ? null : a)).join(',')
  const code =
    `(function(){` +
    `  if (!window.__b) throw new Error('工具栏宿主页未就绪');` +
    `  return window.__b.${method}(${literal});` +
    `})()`
  return (await w.webContents.executeJavaScript(code, true)) as T
}

function sendState(s: BrowserState): void {
  lastState = s
  getBrowserWindow()?.webContents.send('browser:state', s)
}

/** 当前浏览器状态（URL/标题/前进后退/加载中/缩放），全部来自 webview */
export async function getBrowserState(): Promise<BrowserState> {
  try {
    const s = await callHost<BrowserState>('state')
    if (s && typeof s.url === 'string') {
      lastState = { ...EMPTY_STATE, ...s }
    }
  } catch {
    // 宿主页还没醒：用宿主页最后一次回报的状态兜底
  }
  return { ...lastState }
}

export async function navigate(
  raw: string,
): Promise<{ ok: boolean; url?: string; title?: string; error?: string }> {
  const input = String(raw || '').trim()
  // 地址栏输入：像网址 → 补全；否则 → 默认搜索引擎（Bing）搜索
  const target = resolveAddressInput(input)
  if (!isAllowedUrl(target)) {return { ok: false, error: `不支持的地址：${raw}` }}

  if (!getBrowserWindow()) {
    showBrowserWindow(input)
    return { ok: true, url: target }
  }
  try {
    const r = await callHost<{ ok: boolean; url?: string; title?: string; error?: string }>(
      'navigate',
      [target],
    )
    // 导航完把新状态推给工具栏，Agent 打开的网页用户地址栏也能看到
    sendState(await getBrowserState())
    return { ok: true, url: r?.url || target, title: r?.title }
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) }
  }
}

/** 在网页本体里执行一段 JS（供 Agent 读页面/点元素/填输入框） */
async function execInPage(src: string): Promise<any> {
  return callHost<any>('exec', [src])
}

/** 当前页面可读文本（供 Agent 读取页面内容） */
export async function readPage(
  limit = 6000,
): Promise<{ ok: boolean; url?: string; title?: string; text?: string; error?: string }> {
  if (!getBrowserWindow()) {return { ok: false, error: '浏览器未打开' }}
  const n = Math.max(200, Math.min(20000, limit))
  try {
    // 用 String.fromCharCode(10) 代替 \n，避免多层转义把源码里的换行写坏
    const text = await execInPage(
      `(function(){
         var NL = String.fromCharCode(10);
         var t = (document.body && document.body.innerText) || '';
         t = t.replace(new RegExp(NL + '{3,}', 'g'), NL + NL).trim();
         return t.slice(0, ${n});
       })()`,
    )
    const st = await getBrowserState()
    return { ok: true, url: st.url, title: st.title, text: String(text || '') }
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) }
  }
}

/** 按选择器取元素可交互信息（链接/按钮），供 Agent 决定点哪里 */
export async function readInteractive(
  limit = 200,
): Promise<{ ok: boolean; items: any[]; error?: string }> {
  if (!getBrowserWindow()) {return { ok: false, items: [], error: '浏览器未打开' }}
  const n = Math.max(10, Math.min(1000, limit))
  try {
    const items = await execInPage(
      `(function(){
         var sel = 'a, button, input, textarea, select, [role=button], [onclick]';
         var out = [];
         document.querySelectorAll(sel).forEach(function (el, i) {
           if (out.length >= ${n}) return;
           var r = el.getBoundingClientRect();
           if (!r.width || !r.height) return;              // 不可见
           var st = getComputedStyle(el);
           if (st.visibility === 'hidden' || st.display === 'none') return;
           out.push({
             i: i,
             tag: el.tagName.toLowerCase(),
             text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 80),
             href: el.getAttribute('href') || undefined,
             type: el.getAttribute('type') || undefined,
             x: Math.round(r.x), y: Math.round(r.y),
             w: Math.round(r.width), h: Math.round(r.height),
           });
         });
         return out;
       })()`,
    )
    return { ok: true, items: Array.isArray(items) ? items : [] }
  } catch (e: any) {
    return { ok: false, items: [], error: String(e?.message || e) }
  }
}

/** 点第 i 个可交互元素（index 来自 readInteractive 的序号） */
export async function clickInteractive(
  index: number,
): Promise<{ ok: boolean; error?: string; clicked?: any }> {
  if (!getBrowserWindow()) {return { ok: false, error: '浏览器未打开' }}
  try {
    const clicked = await execInPage(
      `(function(){
         var sel = 'a, button, input, textarea, select, [role=button], [onclick]';
         var el = document.querySelectorAll(sel)[${Number(index) || 0}];
         if (!el) return null;
         el.scrollIntoView({ block: 'center' });
         el.click();
         return { tag: el.tagName.toLowerCase(), text: (el.innerText || el.value || '').trim().slice(0, 80) };
       })()`,
    )
    if (!clicked) {return { ok: false, error: `没有索引为 ${index} 的可点击元素` }}
    return { ok: true, clicked }
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) }
  }
}

/** 在第 i 个输入框里填值（index 为 readInteractive 的序号） */
export async function typeInto(
  index: number,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!getBrowserWindow()) {return { ok: false, error: '浏览器未打开' }}
  const value = JSON.stringify(String(text ?? ''))
  try {
    const okd = await execInPage(
      `(function(){
         var sel = 'input, textarea';
         var el = document.querySelectorAll(sel)[${Number(index) || 0}];
         if (!el) return false;
         el.focus();
         var setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value');
         if (setter && setter.set) setter.set.call(el, ${value});
         else el.value = ${value};
         el.dispatchEvent(new Event('input', { bubbles: true }));
         el.dispatchEvent(new Event('change', { bubbles: true }));
         return true;
       })()`,
    )
    return okd ? { ok: true } : { ok: false, error: `没有索引为 ${index} 的输入框` }
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) }
  }
}

/** 截图当前网页本体（不是工具栏） */
export async function screenshot(): Promise<{ ok: boolean; dataUrl?: string; error?: string }> {
  if (!getBrowserWindow()) {return { ok: false, error: '浏览器未打开' }}
  try {
    const dataUrl = await callHost<string>('shot')
    if (!dataUrl || !String(dataUrl).startsWith('data:image')) {
      return { ok: false, error: '截图失败：页面未返回图像' }
    }
    return { ok: true, dataUrl }
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) }
  }
}

export function closeBrowser(): void {
  const w = win
  win = null
  lastState = { ...EMPTY_STATE }
  if (w && !w.isDestroyed()) {w.close()}
}

// ─── IPC（供浏览器窗口自身的工具栏 / 渲染进程调用） ─────────────────────

export function registerBrowserIpc(): void {
  if (ipcRegistered) {return}
  ipcRegistered = true

  // 宿主页在 webview 事件后回报状态，这里缓存并广播给工具栏
  ipcMain.on('browser:state-changed', (_e, s: any) => {
    if (!s || typeof s.url !== 'string') {return}
    sendState({ ...EMPTY_STATE, ...s })
  })

  ipcMain.handle('browser:state', async () => {
    const s = await getBrowserState()
    return { ok: true, ...s }
  })

  // 这些入口保留给渲染进程（任务工作区按钮等）用；工具栏自身的按钮
  // 在页面里直接调 window.__b，少一次 IPC 往返。
  ipcMain.handle('browser:navigate', async (_e, url: string) => navigate(url))
  ipcMain.handle('browser:back', async () => {
    await callHost('back').catch(() => undefined)
    sendState(await getBrowserState())
    return { ok: true }
  })
  ipcMain.handle('browser:forward', async () => {
    await callHost('forward').catch(() => undefined)
    sendState(await getBrowserState())
    return { ok: true }
  })
  ipcMain.handle('browser:reload', async () => {
    await callHost('reload').catch(() => undefined)
    sendState(await getBrowserState())
    return { ok: true }
  })

  ipcMain.handle('browser:open-external', async (_e, url: string) => {
    try {
      const target = normalizeUrl(String(url || ''))
      if (!isAllowedUrl(target)) {return { ok: false }}
      const { shell } = require('electron')
      await shell.openExternal(target)
      return { ok: true }
    } catch {
      return { ok: false }
    }
  })

  ipcMain.handle('browser:clear-data', async () => {
    try {
      const ses = getSession()
      await ses.clearStorageData()
      await ses.clearCache()
      return { ok: true }
    } catch {
      return { ok: false }
    }
  })

  // 注意：browser:close 由 main.ts 的 IPC 段统一注册（渲染进程与工具栏共用
  // 同一个通道）。Electron 对同一通道注册第二个 handler 会直接抛错，这里不要重复注册。
}
