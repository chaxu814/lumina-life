// ============================================================
// impl/webFetch.ts — 网页内容抓取 (v2.6)
//
// 🔐 v2.6: 使用统一 HTTP 客户端，SSL 验证默认开启
//   可通过 LUMINA_ALLOW_INSECURE_SSL=1 环境变量关闭（调试用）
// ============================================================

import type { ToolDef, ToolResult } from '../types'
import { httpGet, stripHtml } from '../utils/httpClient'

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
    return { callId: '', ok: true, content: '⚠️ web_fetch 需要 url 参数。请提供网页地址。', durationMs: 0 }
  }

  try {
    const response = await httpGet(url, 15000)

    if (!response.ok) {
      return {
        callId: '',
        ok: true,
        content: `⚠️ 无法访问 ${url}（HTTP ${response.status}）。可尝试 browser(action="search_and_read", query="...") 通过搜索自动获取内容，或换一个来源。`,
        durationMs: 0,
      }
    }

    let content: string
    const contentType = response.contentType

    if (extract_mode === 'json' || contentType.includes('json')) {
      content = JSON.stringify(JSON.parse(response.text), null, 2)
    } else {
      content = extract_mode === 'html' ? response.text : stripHtml(response.text)
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
      content: `📄 网页内容 (${url})\n📏 ${charCount} 字符 / ~${wordCount} 词\n\n${content}`,
    }
  } catch (err: any) {
    return {
      callId: '',
      ok: false,
      content: '',
      error: `网页抓取失败: ${err.message}`,
    }
  }
}


