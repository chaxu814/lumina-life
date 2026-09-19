// ============================================================
// tools/impl/contentCollector.ts — 批量内容收集器 (v5.0.2)
//
// 🔐 v5.0.2: 使用统一 HTTP 客户端，SSL 验证默认开启
//
// 解决本地 LLM 不支持 function calling 的痛点：
//   收集多个 URL 的内容 → 提取正文 → 合并保存为 Markdown
//
// 触发模式：
//   - "收集/爬这几个网页的内容: url1 url2 url3"
//   - "帮我汇总这些链接"
//   - 用户消息中包含多个 URL
// ============================================================

import type { ToolDef, ToolResult } from '../types'
import * as fs from 'fs'
import * as path from 'path'
import { httpGet } from '../utils/httpClient'

// ═══════════════════════════════════════════════════════════
// HTML → 纯文本
// ═══════════════════════════════════════════════════════════

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim()
}

/** 提取标题 */
function extractTitle(html: string, fallbackUrl: string): string {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i)
  return match ? match[1].trim() : fallbackUrl
}

// ═══════════════════════════════════════════════════════════
// URL 提取
// ═══════════════════════════════════════════════════════════

const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`\[\]()]+/gi

/** 从文本中提取所有 URL */
export function extractUrls(text: string): string[] {
  const matches = text.match(URL_REGEX) || []
  // 去重 + 清理尾部标点
  const seen = new Set<string>()
  return matches
    .map(u => u.replace(/[。，,;:;！!？?、。）》\)】]+$/, ''))
    .filter(u => {
      if (seen.has(u)) {return false}
      seen.add(u)
      return true
    })
}

// ═══════════════════════════════════════════════════════════
// 收集结果类型
// ═══════════════════════════════════════════════════════════

export interface CollectedItem {
  url: string
  title: string
  content: string
  charCount: number
  success: boolean
  error?: string
}

export interface CollectResult {
  items: CollectedItem[]
  totalChars: number
  savedPath?: string
  summary: string
}

// ═══════════════════════════════════════════════════════════
// 批量收集
// ═══════════════════════════════════════════════════════════

export async function collectUrls(
  urls: string[],
  maxCharsPerPage = 5000,
  maxTotalChars = 30000,
): Promise<CollectResult> {
  const items: CollectedItem[] = []
  let totalChars = 0

  for (const url of urls) {
    try {
      const res = await httpGet(url, {}, 12000)
      if (!res.ok) {
        items.push({ url, title: url, content: '', charCount: 0, success: false, error: `HTTP ${res.status}` })
        continue
      }

      const title = extractTitle(res.text, url)
      const rawText = stripHtml(res.text)
      const truncated = rawText.slice(0, maxCharsPerPage)

      // 检查总量限制
      if (totalChars + truncated.length > maxTotalChars) {
        const remaining = maxTotalChars - totalChars
        if (remaining > 500) {
          items.push({ url, title, content: truncated.slice(0, remaining), charCount: remaining, success: true })
        }
        break
      }

      items.push({ url, title, content: truncated, charCount: truncated.length, success: true })
      totalChars += truncated.length
    } catch (err: any) {
      items.push({ url, title: url, content: '', charCount: 0, success: false, error: err.message })
    }
  }

  return {
    items,
    totalChars,
    summary: buildSummary(items),
  }
}

/** 生成收集结果摘要（注入到 system prompt） */
function buildSummary(items: CollectedItem[]): string {
  const success = items.filter(i => i.success)
  const failed = items.filter(i => !i.success)

  let summary = `📚 已收集 ${success.length} 个网页的内容 (共 ${items.reduce((s, i) => s + i.charCount, 0)} 字符)\n\n`

  for (const item of success) {
    summary += `---\n## ${item.title}\n🔗 ${item.url}\n\n${item.content.slice(0, 3000)}\n\n`
  }

  if (failed.length > 0) {
    summary += `\n⚠️ 以下 ${failed.length} 个网页无法访问:\n`
    for (const item of failed) {
      summary += `- ${item.url} (${item.error})\n`
    }
  }

  return summary
}

// ═══════════════════════════════════════════════════════════
// 保存为 Markdown 文件
// ═══════════════════════════════════════════════════════════

function getCollectedDir(): string {
  const candidates = [
    path.join(process.cwd(), 'collected'),
    'J:\\LuminaLife2.0\\collected',
    'I:\\LuminaLife2.0\\collected',
    path.join(require('os').homedir(), 'Lumina', 'collected'),
  ]
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.dirname(dir))) {
        if (!fs.existsSync(dir)) {fs.mkdirSync(dir, { recursive: true })}
        return dir
      }
    } catch {}
  }
  // fallback
  const fallback = path.join(process.cwd(), 'collected')
  try { fs.mkdirSync(fallback, { recursive: true }) } catch {}
  return fallback
}

export async function saveCollected(result: CollectResult, topic?: string): Promise<string> {
  const dir = getCollectedDir()
  const dateStr = new Date().toISOString().slice(0, 10)
  const safeTopic = (topic || 'collected').replace(/[\\/:*?"<>|]/g, '_').slice(0, 50)
  const filename = `${dateStr}_${safeTopic}.md`
  const filepath = path.join(dir, filename)

  let md = `# ${topic || '内容收集'} (${dateStr})\n\n`
  md += `> 共收集 ${result.items.length} 个网页，${result.totalChars} 字符\n\n`

  for (const item of result.items) {
    if (item.success) {
      md += `## ${item.title}\n\n`
      md += `**来源:** ${item.url}\n\n`
      md += `${item.content}\n\n---\n\n`
    } else {
      md += `## ⚠️ ${item.url}\n\n> 无法访问: ${item.error}\n\n---\n\n`
    }
  }

  fs.writeFileSync(filepath, md, 'utf-8')
  return filepath
}

// ═══════════════════════════════════════════════════════════
// Tool 注册
// ═══════════════════════════════════════════════════════════

export const contentCollectorDef: ToolDef = {
  name: 'content_collect',
  description: `批量收集网页内容。自动抓取 URL → 提取正文 → 保存为 Markdown。
参数:
- urls: URL 列表 (必填，逗号分隔)
- topic: 主题/文件名 (选填)
- max_chars_per_page: 单页最大字符数 (默认 5000)`,
  params: {
    urls: { type: 'string', description: 'URL 列表，逗号分隔', required: true },
    topic: { type: 'string', description: '收集主题/文件名', required: false },
    max_chars_per_page: { type: 'number', description: '单页最大字符数', required: false },
  },
  toolsets: ['agent', 'web'],
}

export async function contentCollector(args: Record<string, any>): Promise<ToolResult> {
  const urlStr = args.urls || ''
  const urls = urlStr.split(/[,，\s]+/).filter(Boolean)
  if (urls.length === 0) {
    return { callId: '', ok: true, content: '⚠️ content_collect 需要 urls 参数。', durationMs: 0 }
  }

  try {
    const result = await collectUrls(urls, args.max_chars_per_page || 5000)
    const savedPath = await saveCollected(result, args.topic || extractUrls(urlStr).join('_'))

    const content = `✅ 已收集 ${result.summary}\n\n📁 已保存到: ${savedPath}`
    return { callId: '', ok: true, content, durationMs: 0 }
  } catch (err: any) {
    return { callId: '', ok: false, content: `收集失败: ${err.message}`, durationMs: 0 }
  }
}
