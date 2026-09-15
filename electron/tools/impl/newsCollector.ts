// ============================================================
// impl/newsCollector.ts — 新闻聚合采集器 + Daily Paper
//
// 来源：
//   1. 通用 RSS/Atom 订阅源
//   2. 百度热搜
//   3. arXiv 论文 RSS (Daily Paper)
// ============================================================

import { fetchFeeds, type RSSItem, type RSSFeed } from './rssParser'
import { httpGet, stripHtml } from '../utils/httpClient'

// ═══════════════════════════════════════════════════════════
// 统一新闻条目类型
// ═══════════════════════════════════════════════════════════

export type NewsCategory =
  | 'tech'       // 科技
  | 'ai'         // AI 人工智能
  | 'finance'    // 财经
  | 'trending'   // 热搜/热门
  | 'oss'        // 开源
  | 'general'    // 综合
  | 'paper'      // 学术论文

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

/** 股票行情类型 */
export interface StockQuote {
  code: string
  name: string
  price: number
  changePercent: number
  volume?: number
}

/** 东方财富默认监控列表 */
export const DEFAULT_STOCK_WATCHLIST = [
  '1.000001',  // 上证指数
  '0.399001',  // 深证成指
  '0.399006',  // 创业板指
] as const

/** 解析东方财富行情数据 */
export function parseEastMoneyQuote(raw: any): StockQuote {
  return {
    code: String(raw?.f12 ?? ''),
    name: String(raw?.f14 ?? ''),
    price: Number(raw?.f2 ?? 0),
    changePercent: Number(raw?.f3 ?? 0),
    volume: Number(raw?.f6 ?? 0),
  }
}

// ═══════════════════════════════════════════════════════════
// 默认 RSS 订阅源配置（用户可自行扩展）
// ═══════════════════════════════════════════════════════════

export const DEFAULT_RSS_SOURCES: Array<{ url: string; name: string; category: NewsCategory }> = [
  // ── AI / 科技（中文）──
  { url: 'https://www.36kr.com/feed', name: '36氪', category: 'tech' },
  { url: 'https://www.solidot.org/index.rss', name: 'Solidot', category: 'tech' },
  { url: 'https://sspai.com/feed', name: '少数派', category: 'tech' },
  { url: 'https://www.oschina.net/news/rss', name: '开源中国', category: 'oss' },

  // ── AI / 科技（英文）──
  { url: 'https://techcrunch.com/feed/', name: 'TechCrunch', category: 'tech' },
  { url: 'https://www.theverge.com/rss/index.xml', name: 'The Verge', category: 'tech' },
  { url: 'https://huggingface.co/blog/feed.xml', name: 'Hugging Face', category: 'ai' },
  { url: 'https://openai.com/blog/rss.xml', name: 'OpenAI Blog', category: 'ai' },
  { url: 'https://blog.google/technology/ai/rss/', name: 'Google AI Blog', category: 'ai' },
  { url: 'https://www.technologyreview.com/topic/artificial-intelligence/feed', name: 'MIT Tech Review AI', category: 'ai' },
  // 注：arXiv 论文由 collectArxivPapers() 单独采集（更完善的解析），不在此重复
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
  // 按分类给基础热度分：AI 源最高，科技/财经次之，论文/综合再次
  const baseScore: Record<NewsCategory, number> = {
    ai: 80,
    tech: 70,
    finance: 70,
    oss: 68,
    paper: 60,
    trending: 55,
    general: 50,
  }
  return {
    id: makeId(item.title, item.link, sourceName),
    title: item.title,
    url: item.link,
    source: sourceName,
    category,
    pubDate: item.pubDate,
    summary: stripHtml(item.description).slice(0, 300),
    content: stripHtml(item.description),
    hotScore: baseScore[category] ?? 50,
    fingerprint: makeFingerprint(item.title, item.link),
  }
}

// ═══════════════════════════════════════════════════════════
// 1. RSS 通用源
// ═══════════════════════════════════════════════════════════

async function collectFromRSS(
  sources: Array<{ url: string; name: string; category: NewsCategory }>,
  timeoutMs: number = 15000,
  perFeedLimit: number = 8,
): Promise<NewsItem[]> {
  const urls = sources.map(s => s.url)
  const feeds = await fetchFeeds(urls, timeoutMs)
  const items: NewsItem[] = []

  for (const feed of feeds) {
    const srcConfig = sources.find(s => s.url === feed.link || feed.items.some((i: RSSItem) => i.link.includes(s.url.slice(0, 20))))
    const sourceName = srcConfig?.name || feed.title
    const category = srcConfig?.category || 'general'

    // 每个源最多取 perFeedLimit 条，按发布时间倒序（RSS 通常已排序，取前 N 条）
    for (const rssItem of feed.items.slice(0, perFeedLimit)) {
      items.push(rssItemToNewsItem(rssItem, sourceName, category))
    }
  }

  return items
}

// ═══════════════════════════════════════════════════════════
// 2. arXiv 论文 (Daily Paper)
// ═══════════════════════════════════════════════════════════

async function collectArxivPapers(): Promise<NewsItem[]> {
  try {
    const categories = ['cs.ai', 'cs.cl', 'cs.lg', 'cs.cv']
    const tasks = categories.map(cat => 
      fetchFeeds([`https://rss.arxiv.org/rss/${cat}`], 15000)
    )
    const results = await Promise.allSettled(tasks)
    const items: NewsItem[] = []

    for (let i = 0; i < results.length; i++) {
      const result = results[i]
      if (result.status === 'fulfilled') {
        const feed = (result as PromiseFulfilledResult<RSSFeed[]>).value[0]
        const sourceName = DEFAULT_RSS_SOURCES.find(s => s.url.includes(categories[i]))?.name || `arXiv ${categories[i]}`
        
        for (const rssItem of feed.items) {
          // arXiv RSS 条目通常包含 <arxiv:summary> 标签，摘要放在 description 中
          const summary = stripHtml(rssItem.description).slice(0, 500)
          items.push({
            id: makeId(rssItem.title, rssItem.link, sourceName),
            title: rssItem.title,
            url: rssItem.link,
            source: sourceName,
            category: 'paper',
            pubDate: rssItem.pubDate || new Date().toISOString(),
            summary: summary,
            content: summary,
            hotScore: 70, // 论文默认热度较高
            fingerprint: makeFingerprint(rssItem.title, rssItem.link),
          })
        }
      }
    }

    console.log(`[NewsCollector] arXiv 论文: ${items.length} 条`)
    return items.slice(0, 10) // 限制数量（论文太专业，不需要太多）
  } catch (err: any) {
    console.warn('[NewsCollector] arXiv 论文抓取失败:', err.message)
    return []
  }
}

// ═══════════════════════════════════════════════════════════
// 3. 百度热搜（关键词过滤：只保留科技/AI/财经相关）
// ═══════════════════════════════════════════════════════════

/** 百度热搜白名单关键词——只保留与 AI/科技/财经/产业相关的热搜 */
const BAIDU_WHITELIST = [
  // AI / 大模型
  'ai', 'AI', '人工智能', '大模型', 'gpt', 'GPT', 'claude', 'gemini', 'deepseek', 'qwen',
  '通义', '文心', '豆包', 'kimi', '智谱', 'openai', 'anthropic', '英伟达', 'nvidia',
  '机器学习', '深度学习', '神经网络', '自动驾驶', '机器人', '具身智能', 'aigc', 'AIGC',
  '算力', 'gpu', 'GPU', '芯片', '半导体', '光刻', '晶圆', '台积电', '中芯',
  // 科技 / 互联网
  '科技', '互联网', '手机', '华为', '小米', '苹果', 'iphone', '特斯拉', '比亚迪',
  '新能源', '电动车', '光伏', '储能', '电池', '充电', '量子', '卫星', '航天',
  '编程', '开源', 'github', 'GitHub', 'linux', 'windows', '安卓', '鸿蒙',
  '字节', '腾讯', '阿里', '百度', '京东', '美团', '拼多多', '滴滴', '网易',
  '微软', 'google', 'Google', '谷歌', 'meta', 'amazon', '亚马逊',
  // 财经 / 股市
  '股', 'A股', '美股', '港股', '基金', '债券', '期货', '汇率', '人民币',
  '经济', '金融', '央行', '降息', '加息', '通胀', 'cpi', 'CPI', 'GDP',
  '上市', 'IPO', '财报', '营收', '利润', '涨停', '跌停', '牛市', '熊市',
  '证监会', '银保监', '上证', '深证', '创业板', '科创板', '北证',
  '房地产', '房价', '楼市', '利率', '存款', '贷款', '理财',
]

/** 黑名单关键词——社会事件/娱乐八卦/灾难等，即使命中白名单也排除 */
const BAIDU_BLACKLIST = [
  '明星', '出轨', '离婚', '官宣', '恋情', '分手', '复合', '结婚', '婚礼',
  '综艺', '选秀', '偶像', '粉丝', '塌房', '代言', '红毯', '首映', '票房',
  '电视剧', '电影', '网剧', '男主', '女主', '演技', '歌手', '演唱会',
  '车祸', '身亡', '死亡', '遇难', '去世', '自杀', '被杀', '遇害',
  '地震', '洪水', '台风', '暴雨', '泥石流', '火灾', '爆炸', '坍塌',
  '被捕', '被抓', '判刑', '入狱', '涉案', '调查', '纪委', '监委',
  '减肥', '整容', '医美', '养生', '偏方', '星座', '运势',
]

/** 判断百度热搜标题是否与 AI/科技/财经相关 */
function isRelevantBaiduHot(title: string): boolean {
  const lower = title.toLowerCase()
  // 先查黑名单
  for (const kw of BAIDU_BLACKLIST) {
    if (title.includes(kw) || lower.includes(kw.toLowerCase())) return false
  }
  // 再查白名单
  for (const kw of BAIDU_WHITELIST) {
    if (title.includes(kw) || lower.includes(kw.toLowerCase())) return true
  }
  return false
}

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

    // 步骤3: 配对（顺序一致）+ 关键词过滤
    for (let i = 0; i < titleMatches.length; i++) {
      const { url, title } = titleMatches[i]
      // 只保留 AI/科技/财经相关的热搜，过滤社会/娱乐/灾难
      if (!isRelevantBaiduHot(title)) continue
      const hotNum = hotValues[i] || 0
      const fullUrl = url.startsWith('http') ? url : `https://top.baidu.com${url}`
      // 百度热搜降为辅助参考分（40-65），不再压过专业源
      const hotScore = Math.min(65, Math.round((hotNum / 10000000) * 40) + 40)

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
        if (title && title.length > 1 && isRelevantBaiduHot(title)) {
          const url = `https://www.baidu.com/s?wd=${encodeURIComponent(title)}`
          items.push({
            id: makeId(title, url, '百度热搜'),
            title, url,
            source: '百度热搜',
            category: 'trending',
            pubDate: new Date().toISOString(),
            summary: `🔥 ${title}`,
            content: title,
            hotScore: Math.max(40, 60 - idx * 2),
            fingerprint: makeFingerprint(title, url),
          })
          idx++
        }
      }
    }

    console.log(`[NewsCollector] 百度热搜: ${items.length} 条（关键词过滤后）`)
    return items.slice(0, 10) // 百度热搜只作辅助，最多 10 条
  } catch (err: any) {
    console.warn('[NewsCollector] 百度热搜抓取失败:', err.message)
    return []
  }
}

// ═══════════════════════════════════════════════════════════
// 4. GitHub Trending（开源项目热榜）
// ═══════════════════════════════════════════════════════════

async function collectGithubTrending(): Promise<NewsItem[]> {
  try {
    const res = await httpGet('https://github.com/trending?since=daily', {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    }, 15000)

    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    const html = res.text
    const items: NewsItem[] = []

    // GitHub Trending 结构：<article class="Box-row"> 包含 <h2><a href="/owner/repo">
    const articleRegex = /<article class="Box-row">([\s\S]*?)<\/article>/g
    let am: RegExpExecArray | null

    while ((am = articleRegex.exec(html)) !== null) {
      const block = am[1]

      // 提取仓库名和链接
      const repoMatch = block.match(/<h2[^>]*>\s*<a\s+href="([^"]+)"/i)
      if (!repoMatch) continue
      const repoPath = repoMatch[1].trim()
      const repoName = repoPath.replace(/^\//, '').replace(/\s+/g, '')
      const fullUrl = `https://github.com${repoPath}`

      // 提取描述
      const descMatch = block.match(/<p class="col-9[^"]*"[^>]*>\s*([\s\S]*?)\s*<\/p>/i)
      const description = descMatch ? stripHtml(descMatch[1]).trim() : ''

      // 提取语言
      const langMatch = block.match(/itemprop="programmingLanguage">\s*([^<]+?)\s*</i)
      const language = langMatch ? langMatch[1].trim() : ''

      // 提取星标数
      const starMatch = block.match(/(\d[\d,]*)\s*stars today/i)
      const starsToday = starMatch ? parseInt(starMatch[1].replace(/,/g, ''), 10) : 0

      const title = `⭐ ${repoName}${language ? ` [${language}]` : ''}`
      const summary = description
        ? `${description}${starsToday ? ` — 今日 +${starsToday} ⭐` : ''}`
        : `GitHub 热门开源项目${starsToday ? ` — 今日 +${starsToday} ⭐` : ''}`

      items.push({
        id: makeId(repoName, fullUrl, 'GitHub Trending'),
        title,
        url: fullUrl,
        source: 'GitHub Trending',
        category: 'oss',
        pubDate: new Date().toISOString(),
        summary,
        content: description,
        hotScore: Math.min(95, 60 + Math.round(starsToday / 50)),
        fingerprint: makeFingerprint(repoName, fullUrl),
      })
    }

    console.log(`[NewsCollector] GitHub Trending: ${items.length} 条`)
    return items.slice(0, 15)
  } catch (err: any) {
    console.warn('[NewsCollector] GitHub Trending 抓取失败:', err.message)
    return []
  }
}

// ═══════════════════════════════════════════════════════════
// 5. 财经新闻（东方财富 7x24 快讯 + 金十数据）
// ═══════════════════════════════════════════════════════════

async function collectFinanceNews(): Promise<NewsItem[]> {
  const items: NewsItem[] = []

  // 5a. 东方财富 7x24 快讯
  try {
    const res = await httpGet(
      'https://np-listapi.eastmoney.com/comm/web/getNewsByColumns?client=web&biz=web_news_col&column=350&order=1&needInteractData=0&page_index=1&page_size=20',
      {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://kuaixun.eastmoney.com/',
      },
      10000,
    )
    if (res.ok) {
      const data = JSON.parse(res.text)
      const list = data?.data?.list || []
      for (const item of list) {
        const title = String(item.title || item.content || '').replace(/<[^>]+>/g, '').trim()
        if (!title || title.length < 5) continue
        const url = item.url || item.share_url || `https://so.eastmoney.com/news/s?keyword=${encodeURIComponent(title.slice(0, 20))}`
        const pubTime = item.showtime || item.display_time || ''
        items.push({
          id: makeId(title, url, '东方财富'),
          title,
          url,
          source: '东方财富',
          category: 'finance',
          pubDate: pubTime || new Date().toISOString(),
          summary: title.slice(0, 200),
          content: title,
          hotScore: 70,
          fingerprint: makeFingerprint(title, url),
        })
      }
    }
  } catch (err: any) {
    console.warn('[NewsCollector] 东方财富快讯抓取失败:', err.message)
  }

  // 5b. 金十数据快讯
  try {
    const res = await httpGet(
      'https://flash-api.jin10.com/get_flash_list?channel=-8200&vip=1&max_time=&t=' + Date.now(),
      {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.jin10.com/',
        'x-app-id': 'bVBF4FyRTn5NJF5n',
        'x-version': '1.0.0',
      },
      10000,
    )
    if (res.ok) {
      const data = JSON.parse(res.text)
      const list = data?.data || []
      for (const item of list) {
        const content = String(item.data?.content || item.content || '').replace(/<[^>]+>/g, '').trim()
        if (!content || content.length < 8) continue
        // 只保留财经相关（金十本身就是财经源，但过滤广告/无关内容）
        const title = content.length > 60 ? content.slice(0, 60) + '...' : content
        const url = `https://www.jin10.com/flash_detail/${item.id || ''}`
        items.push({
          id: makeId(content, url, '金十数据'),
          title,
          url,
          source: '金十数据',
          category: 'finance',
          pubDate: item.time || new Date().toISOString(),
          summary: content.slice(0, 200),
          content,
          hotScore: 65,
          fingerprint: makeFingerprint(content, url),
        })
      }
    }
  } catch (err: any) {
    console.warn('[NewsCollector] 金十数据抓取失败:', err.message)
  }

  console.log(`[NewsCollector] 财经新闻: ${items.length} 条`)
  return items.slice(0, 20)
}

// ═══════════════════════════════════════════════════════════
// 6. Hacker News（集成已有采集器）
// ═══════════════════════════════════════════════════════════

async function collectHackerNews(): Promise<NewsItem[]> {
  try {
    // 动态导入避免循环依赖
    const { collectHackerNews: collectHn } = await import('./newsCollectorHn')
    const items = await collectHn()
    console.log(`[NewsCollector] Hacker News: ${items.length} 条`)
    return items.slice(0, 15)
  } catch (err: any) {
    console.warn('[NewsCollector] Hacker News 抓取失败:', err.message)
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
  /** 是否采集 arXiv 论文 */
  arxiv?: boolean
  /** 是否采集 GitHub Trending */
  github?: boolean
  /** 是否采集财经新闻 */
  finance?: boolean
  /** 是否采集 Hacker News */
  hn?: boolean
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
    arxiv: true,
    github: true,
    finance: true,
    hn: true,
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
  if (opts.arxiv) tasks.push(collectArxivPapers())
  if (opts.github) tasks.push(collectGithubTrending())
  if (opts.finance) tasks.push(collectFinanceNews())
  if (opts.hn) tasks.push(collectHackerNews())

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
  // 总量上限：防止过多条目拖慢 LLM 筛选（各源已有限额，这里是兜底）
  return deduped.slice(0, 200)
}