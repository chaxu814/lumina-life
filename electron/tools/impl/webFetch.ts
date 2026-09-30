// ============================================================
// impl/webFetch.ts — 网页内容抓取 (v2.6)
//
// 🔐 v2.6: 使用统一 HTTP 客户端，SSL 验证默认开启
//   可通过 LUMINA_ALLOW_INSECURE_SSL=1 环境变量关闭（调试用）
// ============================================================

import type { ToolDef, ToolResult } from '../types'
import { httpGet, stripHtml } from '../utils/httpClient'

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

    if (!response.ok) {
      // HTTP 非 200 = 根本没拿到内容，必须显式失败（原文保留，别丢状态码）
      return notExecuted(
        'web_fetch',
        `无法访问 ${url}（HTTP ${response.status}）`,
        `可尝试 browser(action="search_and_read", query="...") 通过搜索自动获取内容，或换一个来源。原始响应状态: HTTP ${response.status}`,
      )
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
    // 抛异常同样是没抓到正文；error 里必须带上原始 message，不能只写「失败」
    return notExecuted('web_fetch', `抓取 ${url} 时发生异常`, `原始错误: ${err.message || String(err)}`)
  }
}


