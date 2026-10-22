// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// impl/webFetch.ts — 网页内容抓取 (v2.6)
//
// 🔐 v2.6: 使用统一 HTTP 客户端，SSL 验证默认开启
//   可通过 LUMINA_ALLOW_INSECURE_SSL=1 环境变量关闭（调试用）
// ============================================================

import type { ToolDef, ToolResult } from '../types'
import { httpGet, stripHtml } from '../utils/httpClient'
import { extractMainContent } from '../utils/contentExtractor'
import { renderPageWithBrowser } from '../utils/pageRenderer'
import { isChallengePage } from './search'

// ═══════════════════════════════════════════════════════════
// 「没做成」的统一口径（与 tools/registry.ts 的 buildNotExecutedResult 对齐）
//
// 为什么不 import registry 里那个函数：registry.ts 在主进程侧加载整张
//   工具表，工具实现再反向 import 它会形成 registry ↔ impl 循环依赖。
//   所以各文件各写一份本地小函数，用同一套文案保证行为一致。
//
// 为什么失败必须 ok:false：agentRunner 只在 ok:true 时把 content 原样回灌
//   给模型（ok:false 时回灌 `工具错误: ${error}`）。返回 ok:true 的失败
//   会以「这就是网页内容」的形状进上下文，模型分不出「抓到了」和
//   「没抓到」，于是照着「⚠️ 无法访问 …」这段话里的地址继续编正文。
// ═══════════════════════════════════════════════════════════
const NOT_EXECUTED_GUIDANCE =
  '禁止据此作答，也禁止把这段内容当作事实依据继续推理；请改用可用工具重试，或直接告诉用户你做不到以及原因。'

function notExecuted(toolName: string, reason: string, detail: string): ToolResult {
  return {
    callId: '',
    ok: false,
    content: `⛔ 未执行成功（${toolName}，原因：${reason}）。以下是失败说明，不是结果。${NOT_EXECUTED_GUIDANCE}${detail ? `\n\n${detail}` : ''}`,
    error: `未执行成功（${toolName}，原因：${reason}）。${NOT_EXECUTED_GUIDANCE}${detail ? ` 实际错误/原始输出：${detail}` : ''}`,
    durationMs: 0,
  }
}

export const webFetchDef: ToolDef = {
  name: 'web_fetch',
  description: `抓取网页内容为纯文本，供分析使用。
支持普通网页和 API 返回的 JSON。

参数:
- url: 网页 URL
- extract_mode: 提取模式 ("text" 提取纯文本, "html" 保留 HTML, "json" 解析 JSON, 默认 "text")
- max_chars: 最大字符数 (默认 8000)`,
  params: {
    url: { type: 'string', description: '网页 URL', required: true },
    extract_mode: { type: 'string', description: '提取模式', required: false },
    max_chars: { type: 'number', description: '最大字符数', required: false },
  },
  toolsets: ['agent', 'chat', 'developer', 'web'],
}

export async function webFetch(args: Record<string, any>): Promise<ToolResult> {
  const { url, extract_mode = 'text', max_chars = 8000 } = args

  if (!url) {
    return notExecuted('web_fetch', '缺少参数 url（网页地址）', '请提供 url 参数，例如 web_fetch(url="https://example.com")。')
  }

  try {
    const response = await httpGet(url, {}, 15000)

    // 🆕 2026-10-12: 拿不到内容 / 拿到反爬挑战页时，改用**离屏真浏览器**渲染兜底。
    //   这是覆盖 B站、百度百科、知乎这类站点的唯一办法 ——
    //   它们要么靠 JS 渲染正文，要么直接返回验证页，纯 HTTP 注定拿不到。
    //   渲染失败才如实报失败（绝不伪造内容）。
    const needRender = !response.ok || isChallengePage(response.text)
    if (needRender) {
      const rendered = await renderPageWithBrowser(url)
      if (rendered) {
        const extracted = extractMainContent(rendered.html || '', { maxChars: Math.max(max_chars, 500) })
        const body = extracted.text || rendered.text
        const bits = [extracted.siteName || '', rendered.title || extracted.title].filter(Boolean)
        return {
          callId: '',
          ok: true,
          content: `📄 网页内容 (${url})\n🖥️ 经浏览器渲染获取（纯 HTTP ${response.ok ? '拿到的是验证页' : `失败 HTTP ${response.status}`}）`
            + (bits.length ? `\n📌 来源: ${bits.join(' · ')}` : '')
            + `\n📏 ${body.length} 字符\n\n${body.slice(0, max_chars)}`,
        }
      }
      if (!response.ok) {
        // HTTP 非 200 且渲染也没成功 = 真的拿不到，必须显式失败（保留状态码）
        return notExecuted(
          'web_fetch',
          `无法访问 ${url}（HTTP ${response.status}）`,
          `已尝试浏览器渲染仍未取得内容。可换一个来源，或用 web_search 搜索该主题。原始响应状态: HTTP ${response.status}`,
        )
      }
      // 拿到的是验证页、渲染也失败 → 如实说清楚（不要当成"网页内容"回灌）
      return notExecuted(
        'web_fetch',
        `${url} 返回的是验证/反爬页面（不是网页正文）`,
        '已尝试浏览器渲染仍未通过。可换一个来源，或改用 web_search 搜索该主题。',
      )
    }

    let content: string
    let sourceNote = ''
    const contentType = response.contentType

    if (extract_mode === 'json' || contentType.includes('json')) {
      content = JSON.stringify(JSON.parse(response.text), null, 2)
    } else if (extract_mode === 'html') {
      content = response.text
    } else {
      // 🆕 2026-10-12: 默认模式改用正文提取（Readability-lite），不再"删标签了事"。
      //   旧实现把整页标签删掉后原样返回，导航/弹幕/推荐/备案号全都混在里面 ——
      //   模型得自己从一堆「沪ICP备…」里找有用信息。
      const extracted = extractMainContent(response.text, { maxChars: Math.max(max_chars, 500) })
      content = extracted.text || stripHtml(response.text)
      const bits = [extracted.siteName, extracted.title].filter(Boolean)
      if (bits.length > 0) {sourceNote = `\n📌 来源: ${bits.join(' · ')}`}
    }

    // 截断
    if (content.length > max_chars) {
      content = content.slice(0, max_chars) + '\n\n...(内容已截断，前 ' + max_chars + ' 字符)'
    }

    // 统计
    const wordCount = content.split(/\s+/).length
    const charCount = content.length

    return {
      callId: '',
      ok: true,
      content: `📄 网页内容 (${url})${sourceNote}\n📏 ${charCount} 字符 / ~${wordCount} 词\n\n${content}`,
    }
  } catch (err: any) {
    // 抛异常同样是没抓到正文；error 里必须带上原始 message，不能只写「失败」
    return notExecuted('web_fetch', `抓取 ${url} 时发生异常`, `原始错误: ${err.message || String(err)}`)
  }
}


