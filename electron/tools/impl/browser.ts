// ============================================================
// tool_browser.ts — Agent 联网浏览器工具 (v3.6)
//
// v3.6: 搜索引擎独立为 webSearch.ts (DDG Lite + DDG HTML 双引擎)
//       browser 工具本身专注 URL 操作和结果路由
// ============================================================

import type { ToolDef, ToolResult } from '../types'
import { webSearch, fetchWebContent } from './webSearch'
import { exec } from 'child_process'

export const browserDef: ToolDef = {
  name: 'browser',
  description: `联网浏览器工具。支持五种操作：
- action="search": 搜索互联网（DuckDuckGo 双引擎自动回退，结果带标题/链接/摘要）
- action="open": 获取指定 URL 的网页正文内容（HTTP 抓取+智能正文提取）
- action="search_and_read": 搜索后自动尝试读取前几个结果，失败时自动 fallback 到下一个候选链接，直到成功
- action="launch": 在系统默认浏览器中打开指定 URL（真正打开浏览器窗口！用户可以看到网页）
- action="snapshot": 等同于 open，获取网页文本内容`,
  params: {
    action: { type: 'string', description: '操作: "search"(搜索) / "open"(获取内容) / "search_and_read"(搜+读) / "launch"(打开浏览器)', required: true },
    query: { type: 'string', description: '搜索关键词 (action=search/search_and_read 时必填)', required: false },
    url: { type: 'string', description: '网页 URL，必须以 http:// 或 https:// 开头 (action=open/launch 时必填)', required: false },
    count: { type: 'number', description: '搜索结果数量 (1-10，默认5)', required: false },
  },
  toolsets: ['agent', 'chat', 'web'],
}

export async function browserHandler(args: Record<string, any>): Promise<ToolResult> {
  const action = args.action || 'search'
  const start = Date.now()

  try {
    switch (action) {
      case 'search': {
        const query = args.query
        if (!query) {
          return { callId: '', ok: true, content: '⚠️ browser(action="search") 需要 query 参数。', durationMs: Date.now() - start }
        }
        const count = Math.min(args.count || 5, 10)
        const result = await webSearch(query, count)
        return { callId: '', ok: true, content: result, durationMs: Date.now() - start }
      }

      case 'snapshot':
      case 'open': {
        const url = args.url
        if (!url) {
          return { callId: '', ok: true, content: '⚠️ browser(action="open") 需要 url 参数。', durationMs: Date.now() - start }
        }
        if (!url.startsWith('http')) {
          return { callId: '', ok: true, content: `⚠️ URL 格式无效: "${url}"。必须以 http:// 或 https:// 开头。`, durationMs: Date.now() - start }
        }

        try {
          const content = await fetchWebContent(url)
          return {
            callId: '', ok: true,
            content: `📄 ${url}\n\n${content}\n\n---\n💡 提示: 这是网页正文提取结果（最多5000字）。如需查看更多，请告诉我具体关注哪些内容。`,
            durationMs: Date.now() - start,
          }
        } catch (err: any) {
          const msg = err.message || String(err)
          return {
            callId: '', ok: true,
            content: `⚠️ 无法访问 ${url}（${msg}）。建议用 web_search 重新搜索相关内容。`,
            durationMs: Date.now() - start,
          }
        }
      }

      case 'search_and_read': {
        const query = args.query
        if (!query) {
          return { callId: '', ok: true, content: '⚠️ browser(action="search_and_read") 需要 query 参数。', durationMs: Date.now() - start }
        }

        const count = Math.min(args.count || 5, 10)
        const searchResult = await webSearch(query, count)
        if (searchResult.includes('未找到结果')) {
          return { callId: '', ok: true, content: `搜索 "${query}" 未找到结果。`, durationMs: Date.now() - start }
        }

        // 🔧 2026-07-14: 多候选 URL 自动 fallback
        //   提取所有搜索结果中的链接，逐个尝试抓取，直到成功为止
        const allUrls: string[] = []
        const urlRegex = /🔗\s+(\S+)/g
        let urlMatch: RegExpExecArray | null
        while ((urlMatch = urlRegex.exec(searchResult)) !== null) {
          const u = urlMatch[1].trim()
          if (u.startsWith('http') && !allUrls.includes(u)) allUrls.push(u)
        }

        if (allUrls.length === 0) {
          return { callId: '', ok: true, content: `搜索成功但无法提取链接。\n\n${searchResult}`, durationMs: Date.now() - start }
        }

        // 逐个尝试抓取，第一个成功就返回
        let lastError = ''
        for (let i = 0; i < allUrls.length; i++) {
          const url = allUrls[i]
          try {
            const content = await fetchWebContent(url)
            return {
              callId: '', ok: true,
              content: `🔍 "${query}"\n📄 ${url}\n\n${content}${allUrls.length > 1 ? `\n\n---\n💡 共 ${allUrls.length} 个结果，已成功读取第 ${i + 1} 个。` : ''}`,
              durationMs: Date.now() - start,
            }
          } catch (err: any) {
            lastError = err.message || String(err)
            console.log(`[browser] search_and_read fallback: ${url} 失败 (${lastError}), 尝试下一个...`)
            continue
          }
        }

        // 全部失败 → 返回搜索结果列表 + 提示
        return {
          callId: '', ok: true,
          content: `⚠️ 尝试了 ${allUrls.length} 个链接均无法读取（最后错误: ${lastError}）。\n\n以下是搜索结果，可尝试手动打开：\n\n${searchResult}\n\n💡 建议改为 browser(action="launch", url="...") 直接在浏览器中打开查看。`,
          durationMs: Date.now() - start,
        }
      }

      case 'launch': {
        const url = args.url
        if (!url) {
          return { callId: '', ok: true, content: '⚠️ browser(action="launch") 需要 url 参数。', durationMs: Date.now() - start }
        }
        if (!url.startsWith('http')) {
          return { callId: '', ok: true, content: `⚠️ URL 格式无效: "${url}"。必须以 http:// 或 https:// 开头。`, durationMs: Date.now() - start }
        }

        try {
          const { shell } = require('electron')
          await shell.openExternal(url)
        } catch {
          await new Promise<void>((resolve, reject) => {
            const cmd = process.platform === 'win32'
              ? `start "" "${url}"`
              : process.platform === 'darwin'
                ? `open "${url}"`
                : `xdg-open "${url}"`
            exec(cmd, (err: any) => err ? reject(err) : resolve())
          })
        }

        return { callId: '', ok: true, content: `✅ 已在浏览器中打开: ${url}`, durationMs: Date.now() - start }
      }

      default:
        return { callId: '', ok: false, content: '', error: `未知操作: ${action}。支持: search, open, search_and_read, launch, snapshot` }
    }
  } catch (err: any) {
    return { callId: '', ok: false, content: '', error: `${action} 失败: ${err.message}`, durationMs: Date.now() - start }
  }
}
