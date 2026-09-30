// ============================================================
// tool_browser.ts — Agent 联网浏览器工具 (v3.6)
//
// v3.6: 搜索引擎独立为 webSearch.ts (DDG Lite + DDG HTML 双引擎)
//       browser 工具本身专注 URL 操作和结果路由
// ============================================================

import type { ToolDef, ToolResult } from '../types'
import { webSearch, fetchWebContent } from './webSearch'
import { exec } from 'child_process'

// ═══════════════════════════════════════════════════════════
// 「没做成」的统一口径（与 tools/registry.ts 的 buildNotExecutedResult 对齐）
//
// 为什么不 import registry 里那个函数：registry.ts 在主进程侧加载整张
//   工具表，工具实现再反向 import 它会形成 registry ↔ impl 循环依赖。
//   所以各文件各写一份本地小函数，用同一套文案保证行为一致。
//
// 为什么失败必须 ok:false：agentRunner 只在 ok:true 时把 content 原样回灌
//   给模型（ok:false 时回灌 `工具错误: ${error}`）。返回 ok:true 的失败
//   会以「这就是结果」的形状进上下文，模型分不出「读到了」和「没读到」，
//   于是顺着这段文本继续编 —— 编造就是这么来的。
//
// 边界口径：**查询确实跑了但结果为 0 条**属于成功的查询，保持 ok:true，
//   只在 content 里写明「查询成功，0 条结果」；只有真的没做成才走本函数。
// ═══════════════════════════════════════════════════════════
const NOT_EXECUTED_GUIDANCE =
  '禁止据此作答，也禁止把这段内容当作事实依据继续推理；请改用可用工具重试，或直接告诉用户你做不到以及原因。'

function notExecuted(toolName: string, reason: string, detail: string, durationMs = 0): ToolResult {
  return {
    callId: '',
    ok: false,
    content: `⛔ 未执行成功（${toolName}，原因：${reason}）。以下是失败说明，不是结果。${NOT_EXECUTED_GUIDANCE}${detail ? `\n\n${detail}` : ''}`,
    error: `未执行成功（${toolName}，原因：${reason}）。${NOT_EXECUTED_GUIDANCE}${detail ? ` 实际错误/原始输出：${detail}` : ''}`,
    durationMs,
  }
}

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
          return notExecuted('browser(action="search")', '缺少参数 query（搜索关键词）', '', Date.now() - start)
        }
        const count = Math.min(args.count || 5, 10)
        const result = await webSearch(query, count)
        return { callId: '', ok: true, content: result, durationMs: Date.now() - start }
      }

      case 'snapshot':
      case 'open': {
        const url = args.url
        if (!url) {
          return notExecuted(`browser(action="${action}")`, '缺少参数 url（网页地址）', '', Date.now() - start)
        }
        if (!url.startsWith('http')) {
          return notExecuted(`browser(action="${action}")`, `URL 格式无效: "${url}"，必须以 http:// 或 https:// 开头`, '', Date.now() - start)
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
          return notExecuted(
            `browser(action="${action}")`,
            `无法访问 ${url}（${msg}）`,
            `建议改用 browser(action="search", query="...") 重新搜索，或换一个来源。原始错误: ${msg}`,
            Date.now() - start,
          )
        }
      }

      case 'search_and_read': {
        const query = args.query
        if (!query) {
          return notExecuted('browser(action="search_and_read")', '缺少参数 query（搜索关键词）', '', Date.now() - start)
        }

        const count = Math.min(args.count || 5, 10)
        const searchResult = await webSearch(query, count)
        // ⚠️ 口径：搜索真的跑了、只是 0 条命中 = 成功的查询，保持 ok:true，
        //    但必须写明「0 条结果」，否则模型会当成「拿到了内容」。
        if (searchResult.includes('未找到结果')) {
          return {
            callId: '', ok: true,
            content: `✅ 查询成功，0 条结果：搜索 "${query}" 在所有引擎都没有命中。这条是「查过了、没有」，不是搜索结果。`,
            durationMs: Date.now() - start,
          }
        }

        // 🔧 2026-07-14: 多候选 URL 自动 fallback
        //   提取所有搜索结果中的链接，逐个尝试抓取，直到成功为止
        const allUrls: string[] = []
        const urlRegex = /🔗\s+(\S+)/g
        let urlMatch: RegExpExecArray | null
        while ((urlMatch = urlRegex.exec(searchResult)) !== null) {
          const u = urlMatch[1].trim()
          if (u.startsWith('http') && !allUrls.includes(u)) {allUrls.push(u)}
        }

        if (allUrls.length === 0) {
          // 搜索本身有返回，但没能提取出任何可读链接 → 这次「搜+读」没做成
          return notExecuted(
            'browser(action="search_and_read")',
            '搜索返回了内容但提取不到任何链接，读取阶段无法进行',
            `以下是原始搜索输出（仅供参考，不是读取到的正文）:\n\n${searchResult}`,
            Date.now() - start,
          )
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

        // 全部失败 → 没读到任何正文，属实失败（搜索结果只是线索，不是结果）
        return notExecuted(
          'browser(action="search_and_read")',
          `尝试了 ${allUrls.length} 个链接均无法读取正文`,
          `最后一个链接的错误: ${lastError}\n\n以下仅为搜索结果线索，未读取正文:\n\n${searchResult}\n\n💡 建议改为 browser(action="launch", url="...") 直接在浏览器中打开查看。`,
          Date.now() - start,
        )
      }

      case 'launch': {
        const url = args.url
        if (!url) {
          return notExecuted('browser(action="launch")', '缺少参数 url（网页地址）', '', Date.now() - start)
        }
        if (!url.startsWith('http')) {
          return notExecuted('browser(action="launch")', `URL 格式无效: "${url}"，必须以 http:// 或 https:// 开头`, '', Date.now() - start)
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
