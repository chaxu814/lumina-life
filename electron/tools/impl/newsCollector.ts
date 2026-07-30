// ============================================================
// impl/newsCollector.ts — 新闻聚合采集器
//
// 来源：
//   1. 通用 RSS/Atom 订阅源
//   2. 百度热搜
// ============================================================

import { fetchFeeds, type RSSItem, type RSSFeed } from './rssParser'
import { httpGet, stripHtml } from '../utils/httpClient'

// ═══════════════════════════════════════════════════════════
// 统一新闻条目类型
// ═══════════════════════════════════════════════════════════

export type NewsCategory =
  | 'tech'       // 科技
  | 'finance'    // 财经
  | 'trending'   // 热搜/热门
  | 'oss'        // 开源
  | 'general'    // 综合

export interface NewsItem {
  /** 唯一标识（内容去重用） */
  id: string
  /** 标题 */
  title: string
  /** URL */
  url: string
  /** 来源名称（如 "知乎热榜"、"百度热搜"、"东方财富"） */
  source: string
  /** 分类 */
  category: NewsCategory
  /** 发布时间（ISO 字符串，可为空） */
  pubDate: string
  /** 摘要/简介 */
  summary: string
  /** 原始全文（用于 LLM 筛选，可为空） */
  content: string
  /** 热度分（0-100，用于排序） */
  hotScore: number
  /** 原始数据指纹（去重用） */
  fingerprint: string
  /** Hacker News 元数据（可选） */
  _hnMeta?: {
    discussionUrl: string
    commentCount: number
    descendants: number
    by: string
    score: number
  }
  /** 评论原文（供 LLM 筛选用） */
  _commentContent?: string
}

// ═══════════════════════════════════════════════════════════
// 默认 RSS 订阅源配置（用户可自行扩展）
// ═══════════════════════════════════════════════════════════

export const DEFAULT_RSS_SOURCES: Array<{ url: string; name: string; category: NewsCategory }> = [
  // ── 科技 ──
  { url: 'https://www.36kr.com/feed', name: '36氪', category: 'tech' },
  { url: 'https://sspai.com/feed', name: '少数派', category: 'tech' },
  // 注: 阮一峰(feedburner)、极客公园(geekpark)、异步社区(epubit) 因网络超时/偶发410已移除
]

// ═══════════════════════════════════════════════════════════
// 生成指纹
// ═══════════════════════════════════════════════════════════

export function makeFingerprint(title: string, url: string): string {
  // 归一化：去空格、转小写
  const t = title.replace(/\s+/g, '').toLowerCase().slice(0, 60)
  const u = url.replace(/https?:\/\//, '').replace(/[?#].*$/, '').toLowerCase()
  return `${t}::${u}`
}

export function makeId(title: string, url: string, source: string): string {
  const raw = `${source}::${title}::${url}`
  let hash = 0
  for (let i = 0; i < raw.length; i++) {
    const char = raw.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash // Convert to 32bit integer
  }
  return `news_${Math.abs(hash).toString(16)}`
}

function rssItemToNewsItem(item: RSSItem, sourceName: string, category: NewsCategory): NewsItem {
  return {
    id: makeId(item.title, item.link, sourceName),
    title: item.title,
    url: item.link,
    source: sourceName,
    category,
    pubDate: item.pubDate,
    summary: stripHtml(item.description).slice(0, 300),
    content: stripHtml(item.description),
    hotScore: 50,
    fingerprint: makeFingerprint(item.title, item.link),
  }
}

// ═══════════════════════════════════════════════════════════
// 1. RSS 通用源
// ═══════════════════════════════════════════════════════════

async function collectFromRSS(
  sources: Array<{ url: string; name: string; category: NewsCategory }>,
  timeoutMs: number = 15000,
): Promise<NewsItem[]> {
  const urls = sources.map(s => s.url)
  const feeds = await fetchFeeds(urls, timeoutMs)
  const items: NewsItem[] = []

  for (const feed of feeds) {
    const srcConfig = sources.find(s => s.url === feed.link || feed.items.some((i: RSSItem) => i.link.includes(s.url.slice(0, 20))))
    const sourceName = srcConfig?.name || feed.title
    const category = srcConfig?.category || 'general'

    for (const rssItem of feed.items) {
      items.push(rssItemToNewsItem(rssItem, sourceName, category))
    }
  }

  return items
}

// ═══════════════════════════════════════════════════════════
// 3. 百度热搜
// ═══════════════════════════════════════════════════════════

async function collectBaiduHot(): Promise<NewsItem[]> {
  try {
    const res = await httpGet('https://top.baidu.com/board?tab=realtime', {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    }, 15000)

    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    const html = res.text
    const items: NewsItem[] = []

    // 百度热搜结构 (2024+):
    // <div class="content_1YWBm">
    //   <a href="URL" class="title_dIF3B ...">
    //     <div class="c-single-text-ellipsis"> 标题 </div>
    //   </a>
    // </div>
    // 热度在同级 <div class="hot-index_1Bl1a"> 数字 </div>
    //
    // 使用两步解析：先提取所有标题+URL，再提取所有热度，按序配对

    // 步骤1: 提取标题和URL对
    const titleRegex = /<div class="content_1YWBm">\s*<a\s+href="([^"]+)"\s+class="title_dIF3B[^"]*"[^>]*>\s*<div class="c-single-text-ellipsis">\s*([^<]+?)\s*<\/div>/g
    const titleMatches: Array<{ url: string; title: string }> = []
    let tm: RegExpExecArray | null
    while ((tm = titleRegex.exec(html)) !== null) {
      const url = tm[1].trim()
      const title = tm[2].trim()
      if (title) {
        titleMatches.push({ url, title })
      }
    }

    // 步骤2: 提取所有热度指数
    const hotRegex = /<div class="hot-index_1Bl1a">\s*(\d+)\s*<\/div>/g
    const hotValues: number[] = []
    let hm: RegExpExecArray | null
    while ((hm = hotRegex.exec(html)) !== null) {
      hotValues.push(parseInt(hm[1], 10) || 0)
    }

    // 步骤3: 配对（顺序一致）
    for (let i = 0; i < titleMatches.length; i++) {
      const { url, title } = titleMatches[i]
      const hotNum = hotValues[i] || 0
      const fullUrl = url.startsWith('http') ? url : `https://top.baidu.com${url}`
      const hotScore = Math.min(100, Math.round((hotNum / 10000000) * 100))

      items.push({
        id: makeId(title, fullUrl, '百度热搜'),
        title,
        url: fullUrl,
        source: '百度热搜',
        category: 'trending',
        pubDate: new Date().toISOString(),
        summary: `🔥 ${title} — 热搜指数 ${hotNum.toLocaleString()}`,
        content: title,
        hotScore: Math.max(60, hotScore),
        fingerprint: makeFingerprint(title, fullUrl),
      })
    }

    // 兜底：如果上面的解析失败，使用更宽松的正则
    if (items.length === 0) {
      const fallbackRegex = /class="c-single-text-ellipsis">\s*([^<]+?)\s*<\/div>/g
      let fm: RegExpExecArray | null
      let idx = 0
      while ((fm = fallbackRegex.exec(html)) !== null) {
        const title = fm[1].trim()
        if (title && title.length > 1) {
          const url = `https://www.baidu.com/s?wd=${encodeURIComponent(title)}`
          items.push({
            id: makeId(title, url, '百度热搜'),
            title, url,
            source: '百度热搜',
            category: 'trending',
            pubDate: new Date().toISOString(),
            summary: `🔥 ${title}`,
            content: title,
            hotScore: Math.max(60, 100 - idx * 2),
            fingerprint: makeFingerprint(title, url),
          })
          idx++
        }
      }
    }

    console.log(`[NewsCollector] 百度热搜: ${items.length} 条`)
    return items
  } catch (err: any) {
    console.warn('[NewsCollector] 百度热搜抓取失败:', err.message)
    return []
  }
}

// ═══════════════════════════════════════════════════════════
// 统一收集选项
// ═══════════════════════════════════════════════════════════

export interface CollectOptions {
  /** 包含的 RSS 源（可选，默认使用 DEFAULT_RSS_SOURCES） */
  rssSources?: Array<{ url: string; name: string; category: NewsCategory }>
  /** 是否采集 RSS 源（细粒度开关，true=使用默认源） */
  rss?: boolean
  /** 是否采集百度热搜 */
  baidu?: boolean
  /** 超时时间（毫秒） */
  timeoutPerSource?: number
}

// ═══════════════════════════════════════════════════════════
// 统一采集入口
// ═══════════════════════════════════════════════════════════

/**
 * 统一采集入口——并行采集所有启用的来源
 *
 * @param options  采集选项（各源开关），默认全开
 * @returns 合并后的 NewsItem 数组（已按热度降序排序）
 */
export async function collectAll(options?: CollectOptions): Promise<NewsItem[]> {
  const opts: CollectOptions = {
    rss: true,
    baidu: true,
    ...options,
  }

  const tasks: Array<Promise<NewsItem[]>> = []
  const timeout = opts.timeoutPerSource ?? 15000

  // RSS 源：若有自定义源则使用自定义，否则根据 rss 开关决定是否使用默认源
  if (opts.rssSources !== undefined) {
    tasks.push(collectFromRSS(opts.rssSources, timeout))
  } else if (opts.rss !== false) {
    // 无自定义 RSS 且 rss 开关未关闭时使用默认源
    tasks.push(collectFromRSS(DEFAULT_RSS_SOURCES, timeout))
  }
  if (opts.baidu) tasks.push(collectBaiduHot())

  const results = await Promise.allSettled(tasks)
  const allItems: NewsItem[] = []

  for (const result of results) {
    if (result.status === 'fulfilled') {
      allItems.push(...result.value)
    }
  }

  // 去重 + 按热度降序排序
  const seen = new Set<string>()
  const deduped: NewsItem[] = []

  for (const item of allItems.sort((a, b) => b.hotScore - a.hotScore)) {
    if (!seen.has(item.id)) {
      seen.add(item.id)
      deduped.push(item)
    }
  }

  console.log(`[NewsCollector] 采集完成: ${allItems.length} 条原始, ${deduped.length} 条去重后`)
  return deduped
}