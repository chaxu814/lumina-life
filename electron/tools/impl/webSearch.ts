// ============================================================
// tools/impl/webSearch.ts ?可靠的网络搜?(v3.8)
//
// 🔐 v3.8: 使用统一 HTTP 客户端，SSL 验证默认开?
//
// v3.7: DDG 国内不可??Bing RSS 作为首选引?
//   回退? Bing RSS ?DDG Lite ?DDG HTML ?降级链接
//   ?browser.ts ?browser(action="search") 内部调用
// ============================================================
import { httpGet } from '../utils/httpClient'

// ══════════════════════════════════════════════════════════?
// Bing RSS ?首选引?(国内可用)
// ══════════════════════════════════════════════════════════?
async function bingRssSearch(query: string, count = 5): Promise<string> {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${count}&format=rss`
  const res = await httpGet(url, {}, 10000)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)

  const items = res.text.match(/<item>([\s\S]*?)<\/item>/g)
  if (!items || items.length === 0) return `搜索 "${query}" 未找到结果。`

  const results: string[] = []
  for (let i = 0; i < Math.min(items.length, count); i++) {
    const item = items[i]
    const title = (item.match(/<title><!\[CDATA\[([^\]]*)\]\]><\/title>/) || item.match(/<title>([^<]*)<\/title>/))?.[1] || '(无标?'
    const link = (item.match(/<link>([^<]+)<\/link>/))?.[1] || ''
    const desc = (item.match(/<description><!\[CDATA\[([^\]]*)\]\]><\/description>/) || item.match(/<description>([^<]*)<\/description>/))?.[1] || ''
    results.push(`**${i + 1}. ${title}**\n   🔗 ${link}\n   📄 ${desc.slice(0, 200)}`)
  }
  return `🔍 搜索 "${query}" (${results.length} ?:\n\n${results.join('\n\n')}`
}

// ══════════════════════════════════════════════════════════?
// DuckDuckGo Lite ?备用引擎
// ══════════════════════════════════════════════════════════?
async function ddgLiteSearch(query: string, count = 5): Promise<string> {
  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`
  const res = await httpGet(url, {}, 8000)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)

  const results: string[] = []
  const linkRegex = /<a[^>]*href="(https?:\/\/[^"]+)"[^>]*class="result-link"[^>]*>([\s\S]*?)<\/a>/gi
  const snippetRegex = /<span[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/span>/gi
  let match
  const links: Array<{ url: string; title: string }> = []

  while ((match = linkRegex.exec(res.text)) !== null && links.length < count) {
    const rawUrl = match[1].replace(/&amp;/g, '&').replace(/^\/\/duckduckgo\.com\/l\/\?uddg=/, '')
    let realUrl = rawUrl
    try {
      const u = new URL(rawUrl)
      const uddg = u.searchParams.get('uddg')
      if (uddg) realUrl = decodeURIComponent(uddg)
    } catch { /* keep original */ }
    links.push({ url: realUrl, title: match[2].replace(/<[^>]+>/g, '').trim() })
  }

  const snippets: string[] = []
  while ((match = snippetRegex.exec(res.text)) !== null && snippets.length < count) {
    snippets.push(match[1].replace(/<[^>]+>/g, '').trim())
  }

  for (let i = 0; i < links.length; i++) {
    const snippet = snippets[i] || '(无摘?'
    results.push(`**${i + 1}. ${links[i].title}**\n   🔗 ${links[i].url}\n   📄 ${snippet.slice(0, 200)}`)
  }
  return results.length > 0
    ? `🔍 搜索 "${query}" (${results.length} ?:\n\n${results.join('\n\n')}`
    : `搜索 "${query}" 未找到结果。`
}

// ══════════════════════════════════════════════════════════?
// DuckDuckGo HTML API ?第三备用
// ══════════════════════════════════════════════════════════?
async function ddgHtmlSearch(query: string, count = 5): Promise<string> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  const res = await httpGet(url, {}, 8000)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)

  const results: string[] = []
  const blockRegex = /<div[^>]*class="result[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?=<div[^>]*class="result|$)/gi
  let match
  while ((match = blockRegex.exec(res.text)) !== null && results.length < count) {
    const block = match[1]
    const linkMatch = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i)
    const snippetMatch = block.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i)
    if (linkMatch && linkMatch[1]) {
      const url = linkMatch[1].replace(/&amp;/g, '&')
      const title = linkMatch[2].replace(/<[^>]+>/g, '').trim()
      const snippet = snippetMatch?.[1]?.replace(/<[^>]+>/g, '').trim() || '(无摘?'
      results.push(`**${results.length + 1}. ${title}**\n   🔗 ${url}\n   📄 ${snippet.slice(0, 200)}`)
    }
  }
  return results.length > 0
    ? `🔍 搜索 "${query}" (${results.length} ?:\n\n${results.join('\n\n')}`
    : `搜索 "${query}" 未找到结果。`
}

// ══════════════════════════════════════════════════════════?
// 统一搜索: Bing RSS ?DDG Lite ?DDG HTML ?降级链接
// ══════════════════════════════════════════════════════════?
export async function webSearch(query: string, count = 5): Promise<string> {
  // Level 1: Bing RSS (国内首?
  try {
    const result = await bingRssSearch(query, count)
    if (!result.includes('未找到结果')) return result
  } catch (err: any) {
    console.log('[webSearch] Bing RSS 失败:', err.message)
  }

  // Level 2: DDG Lite
  try {
    const result = await ddgLiteSearch(query, count)
    if (!result.includes('未找到结果')) return result
  } catch (err: any) {
    console.log('[webSearch] DDG Lite 失败:', err.message)
  }

  // Level 3: DDG HTML
  try {
    const result = await ddgHtmlSearch(query, count)
    if (!result.includes('未找到结果')) return result
  } catch (err: any) {
    console.log('[webSearch] DDG HTML 失败:', err.message)
  }

  // Level 4: 降级
  return [
    `⚠️ 自动搜索未返回结果。建?`,
    ``,
    `1. 用浏览器打开: open_file(target="https://www.baidu.com/s?wd=${encodeURIComponent(query)}")`,
    `2. 或用: open_file(target="https://www.google.com/search?q=${encodeURIComponent(query)}")`,
    `3. 搜中文内容用百度，英文用 Google`,
  ].join('\n')
}

// ══════════════════════════════════════════════════════════?
// 网页内容抓取
// ══════════════════════════════════════════════════════════?
export async function fetchWebContent(url: string): Promise<string> {
  const res = await httpGet(url, {}, 15000)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)

  let html = res.text
  html = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
  html = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
  html = html.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
  html = html.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
  html = html.replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = titleMatch?.[1]?.trim() || ''

  const descMatch = html.match(/<meta[^>]+name="description"[^>]+content="([^"]+)"/i)
  const description = descMatch?.[1] || ''

  let text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/ {2,}/g, ' ')
    .trim()

  const lines = text.split('\n').filter(l => l.trim().length > 15)
  text = lines.join('\n')

  const header = [title, description].filter(Boolean).join(' ?')
  let result = header ? `📄 ${header}\n\n${text}` : text

  if (result.length > 5000) result = result.slice(0, 5000) + '\n...(已截?'

  return result || '(页面无有效文?'
}
