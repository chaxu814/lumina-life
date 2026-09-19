// ============================================================
// impl/search.ts — 多引擎网页搜索工具 (v6.0)
//
// 🔐 v6.0: 多引擎自动回退 + 验证页检测 + 日期注入 + 自动抓取正文
//
// 变更记录:
//   v6.0  (2026-07-14)
//     - P0: 多引擎自动回退链 (Bing → Baidu → Google → Brave)
//     - P0: 验证页/验证码检测，遇 captcha 自动换引擎
//     - P1: 时效性查询自动追加日期
//     - P1: 搜索结果自动抓取 top-2 正文
//     - 修复: 缺失 decodeBingRedirect 函数导致引用报错
//   v5.5  支持缓存，新增 Brave Search API
//   v5.6  使用统一 HTTP 客户端
// ============================================================

import { httpGetText, stripHtml } from '../utils/httpClient'
import type { ToolDef, ToolResult } from '../types'

// ═══════════════════════════════════════════════════════════
// 本地结果缓存（进程内）
// ═══════════════════════════════════════════════════════════

type CacheKey = string
interface CacheItem { expire: number; content: string }
const searchCache = new Map<CacheKey, CacheItem>()
const CACHE_TTL_MS = 1000 * 60 * 2 // 2 分钟

function cacheGet(key: string): string | null {
  const item = searchCache.get(key)
  if (!item) {return null}
  if (Date.now() > item.expire) { searchCache.delete(key); return null }
  return item.content
}
function cacheSet(key: string, content: string) {
  searchCache.set(key, { expire: Date.now() + CACHE_TTL_MS, content })
}

// ═══════════════════════════════════════════════════════════
// 验证页 / 验证码检测 (v6.0)
// ═══════════════════════════════════════════════════════════

/** 检测 HTML 是否为验证/安全拦截页面（而非真实搜索结果） */
function isCaptchaPage(html: string): boolean {
  const lower = html.toLowerCase()
  // 常见验证/拦截特征
  const captchaSignals = [
    // 百度安全验证
    '安全验证', '百度安全验证', '请完成安全验证', '验证码', 'captcha',
    // 通用
    '您的访问已被暂时限制', '检测到异常流量', '请滑动验证', '请点击验证',
    'unusual traffic', 'verify you are human', 'captcha',
    'please complete the security check', 'security check',
    // Bing 特殊
    'please complete the security check to access', 'sorry, your request was blocked',
    // Google
    'please show you', 're not a robot', 'your computer or network may be sending automated queries',
    // 其他
    'too many requests', 'rate limit', '429',
  ]
  return captchaSignals.some(s => lower.includes(s))
}

// ═══════════════════════════════════════════════════════════
// 时效性检测和日期注入 (v6.0, 从 preExecuteSearch 移植)
// ═══════════════════════════════════════════════════════════

/** 判断 query 是否为时效性查询，若是则自动追加日期 */
function injectDateIfNeeded(query: string): string {
  const now = new Date()
  const dateStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`

  // Layer 1: 时间词
  const hasTimeWord = /今天|今日|最近|最新|现在|当前|实时|本月|本周|这两天|眼下|这会儿|昨晚|今早|凌晨|刚刚|新(的)?[闻问]/.test(query)

  // Layer 2: 时效领域
  const timeSensitiveDomain =
    /股票|股价|行情|走势|涨了|跌了|涨停|跌停|A股|美股|港股|基金|大盘|指数|期货|原油|黄金|白银|汇率|美元|人民币|比特币|加密货币|以太坊|区块[链连]|市值|成交量|资金|北向|南向|板块|概念股|估值|泡沫|回调|反弹|牛市|熊市|仓位|减持|增持|回购|分红|送股/.source +
    /|财报|业绩|营收|利润|净利润|毛利率|净利率|资产负债|现金流|评级|目标价|研报|公告|披露|上市|IPO|退市|ST/.source +
    /|新闻|热点|头条|热搜|资讯|报道|消息|传闻|爆料|辟谣|声明|回应|抗议|示威|冲突|战争|停火|制裁|关税|贸易战/.source +
    /|科技|数码|手机|芯片|AI|人工智能|大模型|GPT|发布|上市|新品|销量|价格|降价|涨价|评测|跑分|系统|更新|升级|补丁|漏洞|破解/.source +
    /|体育|比赛|比分|赛果|联赛|NBA|CBA|英超|欧冠|世界杯|奥运|金牌|冠军|亚军|娱乐|票房|电影|电视剧|综艺|收视率|番位|热搜/.source +
    /|天气|温度|降雨|降雪|台风|地震|海啸|洪水|干旱|高温|寒潮|预警|空气质量|雾霾|PM2[.]?5/.source +
    /|选举|投票|民调|总统|首相|总理|当选|就职|辞职|下台|政策|法规|立法|禁令|开放|限制|签证|移民|人口|GDP|通胀|CPI|失业率/.source +
    /|路况|航班|高铁|地铁|公交|油价|电价|水价|放假|假期|节日|春运|国庆|春节|五一|中秋/.source +
    /|疫情|病例|感染|疫苗|药物|获批|临床|试验|医保|集采|医院|挂号|健康/.source +
    /|期货|伦敦金|白银|纽铜|伦铜|美油|布油|天然气/.source +
    /|年报|半年报|季报|一季报|中报|三季报|预告|快报/.source +
    /|涨停|跌停|连板|封板|开板|炸板|核按|天地板|地天板/.source
  const inTimeDomain = new RegExp(timeSensitiveDomain).test(query)

  // Layer 3: 历史数据排除
  const isHistorical = /(?:去年|前年|上年|\d{4}\s*年|\d{4}\s*[–\-]\s*\d{4})/.test(query)

  const isTimeSensitive = (hasTimeWord || inTimeDomain) && !isHistorical

  if (isTimeSensitive && !query.includes(String(now.getFullYear()))) {
    const enhanced = `${query} ${dateStr}`
    console.log(`[search] 📅 时效性查询，追加日期: "${query}" → "${enhanced}"`)
    return enhanced
  }
  return query
}

// ═══════════════════════════════════════════════════════════
// 结果质量工具
// ═══════════════════════════════════════════════════════════

function decodeBingRedirect(link: string): string {
  if (!link) {return ''}
  if (link.includes('/url?q=')) {
    try { return decodeURIComponent(link.split('/url?q=')[1].split('&')[0]) } catch { return link }
  }
  if (link.startsWith('/')) {return `https://cn.bing.com${link}`}
  if (link.startsWith('http')) {return link}
  return ''
}

function looksSponsorLike(s?: string): boolean {
  if (!s) {return false}
  const t = s.toLowerCase()
  return t.includes('赞助') || t.includes('广告') || t.includes('推广') || t.includes('sponsored') || t.includes('ad ')
}

function resultQualityScore(r: { title: string; link: string; desc: string }): number {
  let score = 0
  if (r.title.length >= 12) {score += 2}
  if (r.desc.length >= 40) {score += 2}
  if (/^https?:\/\//i.test(r.link)) {score += 1}
  if (!looksSponsorLike(r.title + ' ' + r.desc)) {score += 3}
  if (r.link.includes('bing.com')) {score -= 2}
  return score
}

function normalizeResults(results: Array<{ title: string; link: string; desc: string }>, max: number): string {
  const uniq = new Map<string, { title: string; link: string; desc: string }>()
  for (const r of results) {
    if (!r.title) {continue}
    const key = r.title.toLowerCase().slice(0, 60) || r.link.toLowerCase()
    const prev = uniq.get(key)
    const curScore = resultQualityScore(r)
    if (!prev || curScore > resultQualityScore(prev)) {uniq.set(key, r)}
  }
  const out = Array.from(uniq.values()).slice(0, max)
  if (out.length === 0) {return '（未找到有效结果）'}
  return out.map((r, i) => `${i + 1}. ${r.title}\n   ${decodeBingRedirect(r.link)}\n   ${r.desc}`).join('\n\n')
}

/** 验证结果是否有效（非空、非验证页、非错误） */
function isValidResult(content: string): boolean {
  if (!content || content.length < 20) {return false}
  if (content.includes('（未找到有效结果）')) {return false}
  if (content.includes('搜索出错') || content.includes('搜索超时')) {return false}
  // 检查是否返回了 captcha 页面（个别引擎可能没检测到）
  if (isCaptchaPage(content)) {return false}
  return true
}

// ═══════════════════════════════════════════════════════════
// 自动正文抓取 (v6.0)
// ═══════════════════════════════════════════════════════════

/** 从搜索结果中提取链接（top N 条） */
function extractTopLinks(results: string, maxLinks: number): string[] {
  const links: string[] = []
  const linkRegex = /https?:\/\/[^\s\n)]+/g
  let match
  while ((match = linkRegex.exec(results)) !== null && links.length < maxLinks) {
    const url = match[0].replace(/[）\)]。，,、>]+$/, '')
    if (!url.includes('bing.com') && !url.includes('baidu.com') && !links.includes(url)) {
      links.push(url)
    }
  }
  return links.slice(0, maxLinks)
}

/** 抓取网页正文并提取关键段落（每个页面 ≤ 1500 字） */
async function fetchPageContent(url: string): Promise<{ title: string; snippet: string } | null> {
  try {
    const html = await httpGetText(url, { 'Accept-Language': 'zh-CN,zh;q=0.9' }, 10000)
    if (!html || isCaptchaPage(html)) {return null}

    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
    const title = titleMatch ? stripHtml(titleMatch[1]).trim() : ''

    // 清理 HTML 标签，提取正文
    let text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
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

    // 过滤短行和无意义行
    const lines = text.split('\n').filter(l => l.trim().length > 20)
    text = lines.join('\n')

    // 截取关键内容
    if (text.length > 1500) {text = text.slice(0, 1500) + '\n...(截断)'}
    if (!text || text.length < 50) {return null}

    return { title, snippet: text }
  } catch {
    return null
  }
}

/** 为搜索结果自动抓取 top-2 正文（仅当结果有效且链接 ≥ 1） */
async function enrichWithPageContent(
  originalContent: string,
  query: string,
): Promise<string> {
  const links = extractTopLinks(originalContent, 2)
  if (links.length === 0) {return originalContent}

  const pageContents: string[] = []
  for (const url of links) {
    const page = await fetchPageContent(url)
    if (page && page.snippet.length > 100) {
      pageContents.push(
        `📄 **${page.title || url}**\n${page.snippet.slice(0, 1500)}`,
      )
    }
  }

  if (pageContents.length === 0) {return originalContent}

  return `${originalContent}\n\n━━━ 网页正文（AI 抓取）━━━\n\n${pageContents.join('\n\n---\n\n')}`
}

// ═══════════════════════════════════════════════════════════
// Tool Defs
// ═══════════════════════════════════════════════════════════

export const webSearchDef: ToolDef = {
  name: 'web_search',
  description: `网页搜索。支持多引擎，默认 bing。
参数:
- query: 搜索关键词 (必填)
- engine: 搜索引擎 ("bing"|"google"|"baidu"|"brave"，默认 "bing")
- braveApiKey: Brave Search API 的 X-Subscription-Token (可选)
- count: 结果数量 (1-10，默认5)
- fetchPages: 是否自动抓取正文 (true/false，默认 false)
- skipDate: 禁用自动日期追加 (true/false，默认 false)

使用示例:
web_search({"query": "A股 最新 2026年7月", "engine": "baidu", "count": 5})
web_search({"query": "今日股市行情", "fetchPages": true, "count": 5})`,
  params: {
    query: { type: 'string', description: '搜索关键词', required: true },
    engine: { type: 'string', description: '搜索引擎: bing / google / baidu / brave (默认 bing)', required: false },
    braveApiKey: { type: 'string', description: 'Brave Search API 的 X-Subscription-Token (可选)', required: false },
    count: { type: 'number', description: '结果数量 (1-10，默认5)', required: false },
    fetchPages: { type: 'boolean', description: '是否自动抓取正文 (默认 false)', required: false },
    skipDate: { type: 'boolean', description: '禁用自动日期追加 (默认 false)', required: false },
  },
  toolsets: ['agent', 'chat'],
}

// ═══════════════════════════════════════════════════════════
// 搜索引擎实现
// ═══════════════════════════════════════════════════════════

/** Bing 网页搜索 (HTML 解析) — v6.0: 验证页检测 */
async function searchBing(query: string, count: number): Promise<string> {
  try {
    const cacheKey = `bing:${query}:${count}`
    const cached = cacheGet(cacheKey)
    if (cached) {return cached}

    const url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&count=${count}`
    const html = await httpGetText(url, { 'Accept-Language': 'zh-CN,zh;q=0.9' }, 15000)

    // v6.0: 验证页检测
    if (isCaptchaPage(html)) {
      console.log('[search] ⚠️ Bing 触发安全验证，切换引擎')
      return '__CAPTCHA_BLOCKED__'
    }

    const results: Array<{ title: string; link: string; desc: string }> = []
    const blocks = html.split(/<li class="b_algo"/).slice(1)
    for (const block of blocks) {
      const titleMatch = block.match(/<h2>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i) ||
                         block.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
      const link = titleMatch ? titleMatch[1] : ''
      const title = titleMatch ? stripHtml(titleMatch[2]) : ''
      const descMatch = block.match(/<p class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i) ||
                        block.match(/<p[^>]*>([\s\S]*?)<\/p>/i)
      const desc = descMatch ? stripHtml(descMatch[1]).slice(0, 220) : ''
      results.push({ title, link, desc })
    }
    const content = normalizeResults(results, count)
    cacheSet(cacheKey, content)
    return content
  } catch (e) {
    return `Bing 搜索出错: ${e instanceof Error ? e.message : String(e)}`
  }
}

/** Google 网页搜索 (HTML 解析) — v6.0: 验证页检测 */
async function searchGoogle(query: string, count: number): Promise<string> {
  try {
    const cacheKey = `google:${query}:${count}`
    const cached = cacheGet(cacheKey)
    if (cached) {return cached}

    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=${count}&hl=zh-CN`
    const html = await httpGetText(url, { 'Accept-Language': 'zh-CN,zh;q=0.9' }, 15000)

    if (isCaptchaPage(html)) {
      console.log('[search] ⚠️ Google 触发安全验证')
      return '__CAPTCHA_BLOCKED__'
    }

    const results: Array<{ title: string; link: string; desc: string }> = []
    const blocks = html.split(/<div class="g[\s"]/).slice(1)
    for (const block of blocks) {
      const titleMatch = block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i)
      const linkMatch = block.match(/href="(https?:\/\/[^"]+)"/)
      const descMatch = block.match(/<div[^>]*class="[^"]*VwiC3b[^"]*"[^>]*>([\s\S]*?)<\/div>/i) ||
                       block.match(/<span[^>]*class="[^"]*st[^"]*"[^>]*>([\s\S]*?)<\/span>/i) ||
                       block.match(/<div[^>]*>([\s\S]{50,320}?)<\/div>/)

      const title = titleMatch ? stripHtml(titleMatch[1]).slice(0, 100) : '(无标题)'
      const link = linkMatch ? linkMatch[1] : ''
      const desc = descMatch ? stripHtml(descMatch[1]).slice(0, 220) : ''
      results.push({ title, link, desc })
    }

    if (results.length === 0) {
      const h3Matches = [...html.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/gi)]
      const linkMatches = [...html.matchAll(/href="(\/url\?q=(https?:\/\/[^"&]+)|(https?:\/\/[^"]+))"/gi)]
      for (let i = 0; i < Math.min(h3Matches.length, count); i++) {
        const title = stripHtml(h3Matches[i][1]).slice(0, 100)
        const rawLink = linkMatches[i]?.[2] || linkMatches[i]?.[3] || ''
        results.push({ title, link: rawLink, desc: '' })
      }
    }

    const content = normalizeResults(results, count)
    cacheSet(cacheKey, content)
    return content
  } catch (err: any) {
    return `Google 搜索出错: ${err.message}`
  }
}

/** 百度网页搜索 (HTML 解析) — v6.0: 验证页检测 */
async function searchBaidu(query: string, count: number): Promise<string> {
  try {
    const cacheKey = `baidu:${query}:${count}`
    const cached = cacheGet(cacheKey)
    if (cached) {return cached}

    const url = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&rn=${count}&tn=baiduhome_pg`
    const html = await httpGetText(url, { 'Accept-Language': 'zh-CN,zh;q=0.9', 'Cookie': 'BAIDUID=;' }, 15000)

    if (isCaptchaPage(html)) {
      console.log('[search] ⚠️ 百度触发安全验证，切换引擎')
      return '__CAPTCHA_BLOCKED__'
    }

    const results: Array<{ title: string; link: string; desc: string }> = []

    const resultBlocks = html.match(/<div[^>]*class="[^"]*(?:result|c-container)[^"]*"[^>]*data-mu="[^"]*"[^>]*>/gi) || []
    if (resultBlocks.length === 0) {
      const h3Matches = [...html.matchAll(/<h3[^>]*class="[^"]*t[^"]*"[^>]*>[\s\S]*?<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)]
      for (let i = 0; i < Math.min(h3Matches.length, count); i++) {
        const link = h3Matches[i][1] || ''
        const title = stripHtml(h3Matches[i][2]).slice(0, 100)
        results.push({ title, link, desc: '' })
      }
    } else {
      for (const rb of resultBlocks) {
        const contextStart = html.indexOf(rb)
        if (contextStart < 0) {continue}
        const block = html.slice(contextStart, contextStart + 3000)

        const titleMatch = block.match(/<h3[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i) || block.match(/<a[^>]*>([\s\S]*?)<\/a>/i)
        const linkMatch = block.match(/href="(https?:\/\/[^"]+)"/) || block.match(/data-mu="(https?:\/\/[^"]+)"/)
        const descMatch = block.match(/<span[^>]*class="[^"]*content-right_[^"]*"[^>]*>([\s\S]*?)<\/span>/i) ||
                         block.match(/<div[^>]*class="[^"]*c-abstract[^"]*"[^>]*>([\s\S]*?)<\/div>/i) ||
                         block.match(/<div[^>]*class="[^"]*c-span-last[^"]*"[^>]*>([\s\S]*?)<\/div>/i)

        const title = titleMatch ? stripHtml(titleMatch[1]).slice(0, 100) : '(无标题)'
        const link = linkMatch ? linkMatch[1] : ''
        const desc = descMatch ? stripHtml(descMatch[1]).slice(0, 220) : ''
        results.push({ title, link, desc })
      }
    }

    const content = normalizeResults(results, count)
    cacheSet(cacheKey, content)
    return content
  } catch (err: any) {
    return `百度搜索出错: ${err.message}`
  }
}

/** Brave Search API (JSON) — v5.5: 稳定性最高 */
async function searchBrave(query: string, count: number, apiKey?: string): Promise<string> {
  try {
    if (!apiKey) {return '__BRAVE_NO_KEY__'}

    const url = `https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({
      q: query,
      count: String(Math.min(count, 20)),
      country: 'cn',
      search_lang: 'zh',
    })}`
    const html = await httpGetText(url, {
      'Accept': 'application/json',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'X-Subscription-Token': apiKey,
    }, 15000)

    let data: any
    try { data = JSON.parse(html) } catch {
      return `Brave 搜索返回非 JSON: ${html.slice(0, 200)}`
    }

    const results: Array<{ title: string; link: string; desc: string }> = []
    const items = data?.web?.results ?? data?.results ?? []
    for (const item of items) {
      const title = stripHtml(item.title || '').slice(0, 120)
      const link = item.url || item.link || ''
      const desc = stripHtml(item.description || item.snippet || '').slice(0, 240)
      if (!title) {continue}
      results.push({ title, link, desc })
    }

    if (results.length === 0) {return `Brave 搜索 "${query}" 未找到结果`}
    return normalizeResults(results, count)
  } catch (e) {
    return `Brave 搜索出错: ${e instanceof Error ? e.message : String(e)}`
  }
}

// ═══════════════════════════════════════════════════════════
// 多引擎自动回退链 (v6.0)
// ═══════════════════════════════════════════════════════════

/**
 * 执行搜索，并按引擎优先级自动回退。
 *
 * 回退逻辑:
 *   1. 如果指定了 engine，先试指定引擎
 *   2. 如果指定引擎返回验证页/无结果，自动尝试其他引擎
 *   3. 回退顺序: bing → baidu → google → brave（需 API key）
 */
async function searchWithFallback(
  query: string,
  preferredEngine: string,
  count: number,
  braveApiKey?: string,
): Promise<string> {
  // 定义引擎优先级列表（含每个引擎的执行函数）
  // 如果用户指定了引擎，将其排在首位
  const engineOrder = buildEngineOrder(preferredEngine, braveApiKey)
  const errors: string[] = []

  for (const { name, execute } of engineOrder) {
    console.log(`[search] 🔄 尝试引擎: ${name} (query="${query.slice(0, 60)}")`)
    try {
      const result = await execute(query, count)
      // 检查是否是验证拦截
      if (result === '__CAPTCHA_BLOCKED__') {
        console.log(`[search] ⚠️ ${name} 验证拦截，回退下一引擎`)
        errors.push(`${name}: CAPTCHA`)
        continue
      }
      if (result === '__BRAVE_NO_KEY__') {
        console.log(`[search] ⚠️ ${name} 无 API key，跳过`)
        errors.push(`${name}: 无 API key`)
        continue
      }
      // 检查结果是否有效
      if (isValidResult(result)) {
        console.log(`[search] ✅ ${name} 成功，${result.length} 字符`)
        return result
      }
      console.log(`[search] ⚠️ ${name} 无有效结果，回退下一引擎`)
      errors.push(`${name}: 无有效结果`)
    } catch (err: any) {
      console.log(`[search] ❌ ${name} 异常: ${err.message}`)
      errors.push(`${name}: ${err.message}`)
    }
  }

  // 所有引擎都失败
  return [
    `⚠️ 搜索 "${query}" 在所有引擎均失败（${errors.join('; ')}）`,
    ``,
    `建议手动打开浏览器搜索:`,
    `- 百度: https://www.baidu.com/s?wd=${encodeURIComponent(query)}`,
    `- Google: https://www.google.com/search?q=${encodeURIComponent(query)}`,
  ].join('\n')
}

interface EngineEntry {
  name: string
  execute: (q: string, c: number) => Promise<string>
}

function buildEngineOrder(preferred: string, braveApiKey?: string): EngineEntry[] {
  const allEngines: Record<string, EngineEntry> = {
    bing:   { name: 'Bing',     execute: (q, c) => searchBing(q, c) },
    baidu:  { name: 'Baidu',    execute: (q, c) => searchBaidu(q, c) },
    google: { name: 'Google',   execute: (q, c) => searchGoogle(q, c) },
    brave:  { name: 'Brave',    execute: (q, c) => searchBrave(q, c, braveApiKey) },
  }

  // 排序：用户指定的引擎优先，brave 放最后（需要 API key）
  const ordered: EngineEntry[] = []

  // 先把用户指定的引擎放前面
  const prefEngine = allEngines[preferred]
  if (prefEngine) {
    ordered.push(prefEngine)
  }

  // 再补其他引擎
  for (const name of ['bing', 'baidu', 'google', 'brave']) {
    if (name !== preferred && allEngines[name]) {
      ordered.push(allEngines[name])
    }
  }

  // 去重（如果用户指定的引擎恰好是 brave，不放两次）
  const seen = new Set<string>()
  return ordered.filter(e => {
    if (seen.has(e.name)) {return false}
    seen.add(e.name)
    return true
  })
}

// ═══════════════════════════════════════════════════════════
// 主搜索入口 (v6.0 重写)
// ═══════════════════════════════════════════════════════════

export async function webSearch(args: Record<string, any>): Promise<ToolResult> {
  let query: string = args.query
  const engine: string = (args.engine || 'bing').toLowerCase()
  const count = Math.min(args.count || 5, 10)
  const fetchPages: boolean = args.fetchPages === true
  const skipDate: boolean = args.skipDate === true
  const start = Date.now()

  // P1: 自动日期注入（除非调用方明确跳过）
  if (!skipDate) {
    query = injectDateIfNeeded(query)
  }

  const cacheKey = `v6:${engine}:${query}:${count}:${args.braveApiKey || ''}:fp=${fetchPages}`

  const cached = cacheGet(cacheKey)
  if (cached) {
    return {
      callId: '',
      ok: true,
      content: `🔍 ${engine.toUpperCase()} 搜索: "${query}"\n\n${cached}\n\n（缓存结果）`,
      durationMs: Date.now() - start,
    }
  }

  // 多引擎自动回退（P0）
  let content = await searchWithFallback(query, engine, count, args.braveApiKey)

  // P1: 自动抓取正文
  if (fetchPages && isValidResult(content)) {
    console.log(`[search] 📄 自动抓取正文 (top-2)...`)
    content = await enrichWithPageContent(content, query)
  }

  // 标记使用到的引擎（如果用户指定的引擎与最终使用的不同，说明发生了回退）
  const usedEngine = content.includes('Bing') ? 'bing'
    : content.includes('Baidu') ? 'baidu'
    : content.includes('Google') ? 'google'
    : content.includes('Brave') ? 'brave'
    : engine

  cacheSet(cacheKey, content)
  return {
    callId: '',
    ok: true,
    content: `🔍 ${usedEngine.toUpperCase()} 搜索: "${query}"\n\n${content}`,
    durationMs: Date.now() - start,
  }
}
