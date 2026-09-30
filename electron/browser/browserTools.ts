// ============================================================
// browser/browserTools.ts — 内置浏览器的 Agent 工具集
//
// 让 Lumina / Yak / 热茶 能像人一样操作应用内浏览器：
//   browser_open / browser_read / browser_list / browser_click /
//   browser_type / browser_screenshot / browser_close
//
// 与用户共用同一个浏览器窗口 —— 用户看到的就是 Agent 在操作的那一页，
// 不会出现"Agent 偷偷开了个看不见的浏览器"。
//
// 安全：所有跳转先过 isAllowedUrl 白名单；工具本身只在显式调用时开浏览器。
// ============================================================

import type { ToolDef, ToolResult } from '../tools/types'
import {
  showBrowserWindow, closeBrowser, navigate, readPage, readInteractive,
  clickInteractive, typeInto, screenshot, normalizeUrl,
} from './browserWindow'

function ok(text: string, extra?: Record<string, unknown>): ToolResult {
  return { callId: '', ok: true, content: text, ...(extra as any) }
}

function fail(text: string): ToolResult {
  return { callId: '', ok: false, content: text, error: 'browser_error' }
}

export const browserOpenDef: ToolDef = {
  name: 'browser_open',
  description:
    '打开/切换应用内置浏览器并访问网址。支持 http/https/文件地址；不写协议会按 https 处理。'
    + '浏览器是用户可见的窗口，用户能同时看到你正在看什么。',
  params: { url: { type: 'string', description: '要打开的网址，例如 https://example.com 或 example.com', required: true } },
  toolsets: ['browser', 'agent'],
}

export async function browserOpen(args: Record<string, any>): Promise<ToolResult> {
  const url = String(args?.url ?? '').trim()
  if (!url) return fail('请提供要打开的网址')
  showBrowserWindow()
  const r = await navigate(url)
  if (!r.ok) return fail(`打开失败：${r.error || url}`)
  const finalUrl = r.url || normalizeUrl(url)
  const head = `🌐 已打开：${r.title || finalUrl}\n🔗 ${finalUrl}\n\n`
  return ok(head + '可以用 browser_read 读页面、browser_list 找可点元素。')
}

export const browserReadDef: ToolDef = {
  name: 'browser_read',
  description: '读取当前浏览器页面的可见文本内容（自动去除多余空行并截断）。',
  params: { limit: { type: 'number', description: '最多读取字符数，默认 6000', required: false } },
  toolsets: ['browser', 'agent'],
}

export async function browserRead(args: Record<string, any>): Promise<ToolResult> {
  const r = await readPage(Number(args?.limit) || 6000)
  if (!r.ok) return fail(`读取失败：${r.error}`)
  const head = `📄 ${r.title || '页面'}\n🔗 ${r.url}\n\n`
  return ok(head + (r.text || '(页面无可读文本)'))
}

export const browserListDef: ToolDef = {
  name: 'browser_list',
  description:
    '列出当前页面可交互的元素（链接/按钮/输入框），返回序号与位置。'
    + '之后用 browser_click / browser_type 里的 index 指定目标。',
  params: { limit: { type: 'number', description: '最多返回多少个，默认 200', required: false } },
  toolsets: ['browser', 'agent'],
}

export async function browserList(args: Record<string, any>): Promise<ToolResult> {
  const r = await readInteractive(Number(args?.limit) || 200)
  if (!r.ok) return fail(`列举失败：${r.error}`)
  if (r.items.length === 0) return ok('当前页面没有可交互元素')
  const lines = r.items.map((it: any) =>
    `[${it.i}] <${it.tag}> "${it.text}"${it.href ? ` → ${it.href}` : ''} @(${it.x},${it.y})`)
  return ok(`共 ${r.items.length} 个可交互元素：\n` + lines.join('\n'))
}

export const browserClickDef: ToolDef = {
  name: 'browser_click',
  description: '点击当前页面的第 index 个可交互元素（先用 browser_list 拿 index）。',
  params: { index: { type: 'number', description: '元素序号，来自 browser_list', required: true } },
  toolsets: ['browser', 'agent'],
}

export async function browserClick(args: Record<string, any>): Promise<ToolResult> {
  const r = await clickInteractive(Number(args?.index) || 0)
  if (!r.ok) return fail(`点击失败：${r.error}`)
  return ok(`👆 已点击 <${r.clicked?.tag}> "${r.clicked?.text ?? ''}"`)
}

export const browserTypeDef: ToolDef = {
  name: 'browser_type',
  description: '在当前页面的第 index 个输入框里填入文本并触发 input/change 事件。',
  params: {
    index: { type: 'number', description: '输入框序号，来自 browser_list', required: true },
    text: { type: 'string', description: '要填入的文本', required: true },
  },
  toolsets: ['browser', 'agent'],
}

export async function browserType(args: Record<string, any>): Promise<ToolResult> {
  const r = await typeInto(Number(args?.index) || 0, String(args?.text ?? ''))
  if (!r.ok) return fail(`输入失败：${r.error}`)
  return ok(`⌨️ 已填入第 ${args?.index} 个输入框`)
}

export const browserShotDef: ToolDef = {
  name: 'browser_screenshot',
  description: '截取当前浏览器页面，返回 PNG（data URL）。',
  params: {},
  toolsets: ['browser', 'agent'],
}

export async function browserShot(): Promise<ToolResult> {
  const r = await screenshot()
  if (!r.ok) return fail(`截图失败：${r.error}`)
  return ok(`📸 已截图（${Math.round((r.dataUrl?.length || 0) / 1024)} KB data URL）`, {
    dataUrl: r.dataUrl,
  } as any)
}

export const browserCloseDef: ToolDef = {
  name: 'browser_close',
  description: '关闭内置浏览器窗口。',
  params: {},
  toolsets: ['browser', 'agent'],
}

export async function browserClose(): Promise<ToolResult> {
  closeBrowser()
  return ok('已关闭内置浏览器')
}

/** 注册全部浏览器工具 */
export function registerBrowserTools(registerTool: (def: ToolDef, fn: (a: Record<string, any>) => Promise<ToolResult>) => void): void {
  registerTool(browserOpenDef, browserOpen)
  registerTool(browserReadDef, browserRead)
  registerTool(browserListDef, browserList)
  registerTool(browserClickDef, browserClick)
  registerTool(browserTypeDef, browserType)
  registerTool(browserShotDef, browserShot)
  registerTool(browserCloseDef, browserClose)
}

export * from './browserWindow'
