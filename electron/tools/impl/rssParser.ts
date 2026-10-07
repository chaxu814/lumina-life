// ============================================================
// impl/rssParser.ts — 轻量 RSS/Atom 解析器 (v1.0)
//
// 不依赖外部 npm 包，直接用 httpGet + 正则/字符串解析 XML。
// 同时支持 RSS 2.0 和 Atom 1.0 格式。
// ============================================================

import { httpGet } from '../utils/httpClient'

// ═══════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════

export interface RSSItem {
  title: string
  link: string
  pubDate: string
  description: string
  /** 源名称 */
  source: string
  /** 唯一标识（用于去重） */
  guid: string
}

export interface RSSFeed {
  title: string
  link: string
  description: string
  items: RSSItem[]
}

// ═══════════════════════════════════════════════════════════
// 核心解析
// ═══════════════════════════════════════════════════════════

/**
 * 解析 XML 标签内容（简单正则，适合 RSS/Atom 这种结构化 XML）
 */
function extractTag(xml: string, tag: string): string {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i')
  const match = xml.match(regex)
  return match ? match[1].trim() : ''
}

/**
 * 提取所有同名标签的内容数组
 */
function extractAllTags(xml: string, tag: string): string[] {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi')
  const results: string[] = []
  let match
  while ((match = regex.exec(xml)) !== null) {
    results.push(match[1].trim())
  }
  return results
}

/**
 * 从 CDATA 包裹中提取内容
 *
 * 兼容两种情况：
 *   1. 规范的 `<![CDATA[xxx]]>`
 *   2. 已经被上游（或某次错误的转义）弄成 `[[CDATA[xxx]]]` 的残留
 *      —— The Verge 等源的 title 里会直接出现这种，v1.0 的正则不认它，
 *      于是 `[[CDATA[...]]]` 原样进了邮件正文。
 */
function extractCData(raw: string): string {
  const m = raw.match(/<!\[CDATA\[([\s\S]*?)\]\]>/)
  if (m) { return m[1].trim() }
  const m2 = raw.match(/\[\[CDATA\[([\s\S]*?)\]\]\]/)
  if (m2) { return m2[1].trim() }
  return raw
}

const HTML_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', hellip: '…',
  mdash: '—', ndash: '–', middot: '·', raquo: '»', laquo: '«',
}

/** 解 HTML 实体（数字 + 命名），RSS 标题里 `&#8230;` `&amp;` 很常见 */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-zA-Z]+);/g, (m, n) => HTML_ENTITIES[n.toLowerCase()] ?? m)
}

/**
 * 把一个 Atom/RSS 文本字段清洗成「人能读的标题/摘要」。
 * 顺序：CDATA → HTML 标签 → 实体 → 残留标记 → 空白折叠。
 */
export function cleanFeedText(raw: string, maxLen = 300): string {
  if (!raw) { return '' }
  let s = extractCData(raw)
  s = s.replace(/<br\s*\/?>/gi, ' ')
  s = s.replace(/<[^>]*>/g, '')          // 残留 HTML 标签
  s = decodeEntities(s)
  s = s.replace(/\[\[?CDATA\[/gi, '').replace(/\]\]?\]/g, '')
  s = s.replace(/\s+/g, ' ').trim()
  if (s.length > maxLen) { s = s.slice(0, maxLen - 1).trimEnd() + '…' }
  return s
}

/**
 * 判断是否为 Atom 格式
 */
function isAtom(xml: string): boolean {
  return xml.includes('<feed') && xml.includes('xmlns="http://www.w3.org/2005/Atom"')
}

/**
 * 解析 RSS 2.0 格式
 */
function parseRSS(xml: string, feedUrl: string): RSSFeed {
  const channel = extractTag(xml, 'channel')
  const title = cleanFeedText(extractTag(channel, 'title'), 200)
  const link = extractTag(channel, 'link')
  const description = cleanFeedText(extractTag(channel, 'description'), 500)

  // 提取所有 <item>
  const rawItems = extractAllTags(channel, 'item')
  const items: RSSItem[] = rawItems.map((raw, idx) => {
    const title = cleanFeedText(extractTag(raw, 'title'), 200)
    const link = extractTag(raw, 'link').trim()
    const pubDate = extractTag(raw, 'pubDate')
    const description = cleanFeedText(extractTag(raw, 'description'), 500)
    const guid = cleanFeedText(extractTag(raw, 'guid')) || link || `${feedUrl}#${idx}`
    return {
      title,
      link: link || guid,
      pubDate,
      description,
      source: title,
      guid,
    }
  })

  return { title, link, description, items }
}

/**
 * 解析 Atom 1.0 格式
 */
function parseAtom(xml: string, feedUrl: string): RSSFeed {
  const title = cleanFeedText(extractTag(xml, 'title'), 200)
  const linkMatch = xml.match(/<link[^>]*href="([^"]+)"/)
  const link = linkMatch ? linkMatch[1] : feedUrl
  const description = cleanFeedText(extractTag(xml, 'subtitle'), 500)

  const rawEntries = extractAllTags(xml, 'entry')
  const items: RSSItem[] = rawEntries.map((raw, idx) => {
    // 🐛 v1.0 漏了 extractCData —— Atom 的 <title type="html"><![CDATA[…]]></title>
    // 直接把 `[[CDATA[…]]]` 带进了标题。现在统一走 cleanFeedText。
    const title = cleanFeedText(extractTag(raw, 'title'), 200)
    const linkMatch = raw.match(/<link[^>]*href="([^"]+)"/)
    const link = linkMatch ? linkMatch[1] : ''
    const pubDate = extractTag(raw, 'published') || extractTag(raw, 'updated')
    const content = cleanFeedText(extractTag(raw, 'content') || extractTag(raw, 'summary'), 500)
    const id = extractTag(raw, 'id') || link || `${feedUrl}#${idx}`
    return {
      title,
      link,
      pubDate,
      description: content,
      source: title,
      guid: id,
    }
  })

  return { title, link, description, items }
}

/**
 * 从 XML 字符串中解析 RSS/Atom feed
 */
export function parseFeedXML(xml: string, feedUrl: string): RSSFeed {
  if (isAtom(xml)) {
    return parseAtom(xml, feedUrl)
  }
  return parseRSS(xml, feedUrl)
}

/**
 * 获取并解析一个 RSS/Atom feed
 *
 * @param url  feed URL
 * @param timeoutMs  超时毫秒
 * @returns    RSSFeed | null（失败返回 null）
 */
export async function fetchFeed(url: string, timeoutMs = 15000): Promise<RSSFeed | null> {
  try {
    const res = await httpGet(url, {
      Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml',
    }, timeoutMs)

    if (!res.ok || !res.text) {
      console.warn(`[RSSParser] HTTP ${res.status} — ${url}`)
      return null
    }

    const feed = parseFeedXML(res.text, url)
    if (!feed.items || feed.items.length === 0) {
      console.warn(`[RSSParser] 空 feed — ${url}`)
      return null
    }

    console.log(`[RSSParser] ✅ ${feed.title}: ${feed.items.length} 条`)
    return feed
  } catch (err: any) {
    console.warn(`[RSSParser] ❌ ${url}: ${err.message}`)
    return null
  }
}

/**
 * 并发获取多个 feed
 */
export async function fetchFeeds(
  urls: string[],
  timeoutMs = 15000,
): Promise<RSSFeed[]> {
  const results = await Promise.allSettled(
    urls.map(url => fetchFeed(url, timeoutMs)),
  )
  return results
    .filter(r => r.status === 'fulfilled' && r.value !== null)
    .map(r => (r as PromiseFulfilledResult<RSSFeed>).value)
}
