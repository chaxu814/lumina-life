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
import { extractMainContent, decodeEntities } from '../utils/contentExtractor'
import { renderPageWithBrowser, isRendererAvailable } from '../utils/pageRenderer'
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
export function isCaptchaPage(html: string): boolean {
  const lower = html.toLowerCase()
  // 常见验证/拦截特征
  //
  // ⚠️ 这个函数用于**搜索引擎结果页**（Bing/Baidu 被拦时会直接返回验证页）。
  //   它直接扫原始 HTML，所以只放"拦截图里才会出现"的特征词。
  //   2026-10-12 移除了两个过宽的词：
  //     · `429`  —— 结果页里出现数字 429（价格、编号）就误判；
  //     · `captcha` —— 正常网页的 JS 里几乎都有 captcha 相关代码，
  //       用它判断**内容页**会把 B 站这种正常页面判成验证页（实测误杀）。
  //   判断"抓到的网页是不是挑战页"请用 isChallengePage()。
  const captchaSignals = [
    // 百度安全验证
    '安全验证', '百度安全验证', '请完成安全验证', '验证码',
    // 通用
    '您的访问已被暂时限制', '检测到异常流量', '请滑动验证', '请点击验证',
    'unusual traffic', 'verify you are human',
    'please complete the security check', 'security check',
    // Bing 特殊
    'please complete the security check to access', 'sorry, your request was blocked',
    // Google
    'please show you', 're not a robot', 'your computer or network may be sending automated queries',
    // 其他
    'too many requests', 'rate limit',
    // 🆕 2026-10-12: Cloudflare / JS 挑战页。
    //   实测：抓 anibase.net 拿到的是「Just a moment...」挑战页。
    //   它**不是乱码**（所以 looksLikeBinaryOrMojibake 拦不住），
    //   若不当成失败，就会被当作"网页正文"塞进上下文 —— 纯噪音。
    'just a moment...', 'checking your browser', 'cf-browser-verification', 'cf_chl_opt',
    'ddos protection by cloudflare', 'attention required',
    'enable javascript and cookies to continue', 'please enable javascript',
    '请开启 javascript', '请启用 javascript', '正在检查您的浏览器',
  ]
  return captchaSignals.some(s => lower.includes(s))
}

/**
 * 判断**抓到的网页**是不是反爬 / JS 挑战页（2026-10-12 新增）。
 *
 * 与 isCaptchaPage 的区别（重要）：
 *   那个函数直接扫原始 HTML，`captcha` / `429` 这类词命中的门槛很低 ——
 *   而**正常网页的 JS 里几乎都有验证码相关代码**。
 *   实测误杀：B 站视频页被 isCaptchaPage 判为验证页，于是已经抓到手的正文被丢弃
 *   （那页明明有可读内容）。**判据本身成了故障源。**
 *
 * 所以这里改成两条更严的判据：
 *   ① 先剥掉 script/style，只看**用户可见文本**；
 *   ② 且页面必须**很短**（挑战页/占位页通常只有几百字符）——
 *      正常长文里出现"验证"字样不该被误杀。
 */
export function isChallengePage(html: string): boolean {
  const visible = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (visible.length > 2000) {return false}
  const lower = visible.toLowerCase()
  const markers = [
    'just a moment', 'checking your browser', 'cf-browser-verification',
    'ddos protection by cloudflare', 'enable javascript and cookies', 'attention required',
    '百度安全验证', '请完成安全验证', '安全验证', '请滑动验证', '请点击验证',
    'unusual traffic', 'verify you are human', 'please complete the security check',
    'too many requests', 'access denied', '请开启 javascript', '请启用 javascript',
  ]
  return markers.some(s => lower.includes(s))
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

export function normalizeResults(results: Array<{ title: string; link: string; desc: string }>, max: number, query?: string): string {
  // ── 相关性过滤（2026-10-07）──────────────────────────────
  //
  // 【要解决的真实故障】用户搜「美股 宏观 消息 2026年10月7日 美联储」，
  //   BING 返回的第一条是「美（汉语文字）_百度百科 —— 美（拼音：měi）为汉语
  //   一级通用字」。它长度 > 20，通过了 isValidResult() 的全部检查，
  //   于是被当成「有效结果」返回、还写进了缓存，**回退链根本没触发**。
  //
  // 【为什么靠长度/黑名单拦不住】垃圾结果永远是「有内容、无错误串」的。
  //   唯一能判的是**它和查询到底有没有关系**。这里用 CJK 2-gram 重叠度：
  //   查询的 2-gram 与结果文本（标题+摘要）的 2-gram 交集为空 → 判为无关。
  //
  //   上面那条垃圾的 2-gram 是 {美汉,汉语,语文,文字,百度,百科,拼音…}，
  //   与查询 {美股,宏观,消息,美联,联储…} 交集为空 → 被正确剔除。
  //
  // 🆕 2026-10-12 补丁：改用 **intentTokens**（剔除「出处/来源/意思/拼音…」等
  //   零意图通用词）。原实现用全量 token，于是
  //     「尼 -字典-意思-解释-拼音-注音-读音-部首-出处」
  //   靠查询里的「出处」二字拿到 1 个交集，被误判为相关并返回（实测故障）。
  //   通用词不是证据 —— 任何词典页都含这些字。
  const qTokens = query ? intentTokens(query) : null

  const scored = results
    .filter(r => {
      if (!r.title) {return false}
      // 词典/百科单字条目：与任何查询都不该算数
      if (isDictionaryEntry(r.title, r.link)) {return false}
      // 无查询上下文时不过滤（保持旧行为）
      if (!qTokens || qTokens.size < 2) {return true}
      const rTokens = relevanceTokens(`${r.title} ${r.desc}`)
      return countOverlap(qTokens, rTokens) > 0
    })

  const uniq = new Map<string, { title: string; link: string; desc: string }>()
  for (const r of scored) {
    const key = r.title.toLowerCase().slice(0, 60) || r.link.toLowerCase()
    const prev = uniq.get(key)
    const curScore = resultQualityScore(r)
    if (!prev || curScore > resultQualityScore(prev)) {uniq.set(key, r)}
  }

  // 🆕 2026-10-12：按**相关性**排序，让真正相关的结果排到最前。
  //   原来只做去重、不排序 → 引擎给的垃圾条目会一直占着前面的位置，
  //   而 `enrichWithPageContent` 抓的是 top-2 —— 抓到的就是垃圾页。
  //   现在：相关性（与查询意图的交集数）优先，其次质量分，同分保持引擎原序。
  //
  // 🆕 2026-10-13：再加一层**主体短语加权** —— 标题/摘要里出现**完整主体**
  //   （如「尼古喵喵」而不是只命中「喵」）是最强的相关信号，
  //   权重高于 n-gram 交集数，避免"碎片命中多但主体不对"的结果排前面。
  const subject = query ? coreSubject(query) : ''
  const ranked = Array.from(uniq.values()).map((r, i) => {
    const text = `${r.title} ${r.desc}`
    return {
      r,
      i,
      rel: qTokens && qTokens.size >= 2 ? countOverlap(qTokens, relevanceTokens(text)) : 0,
      subjectHit: subject && subject.length >= 2 && text.includes(subject) ? 1 : 0,
    }
  })
  ranked.sort((a, b) =>
    (b.subjectHit - a.subjectHit) ||
    (b.rel - a.rel) ||
    (resultQualityScore(b.r) - resultQualityScore(a.r)) ||
    (a.i - b.i),
  )

  const out = ranked.slice(0, max).map(x => x.r)
  if (out.length === 0) {return '（未找到与查询相关的有效结果）'}
  return out.map((r, i) => `${i + 1}. ${r.title}\n   ${decodeBingRedirect(r.link)}\n   ${r.desc}`).join('\n\n')
}

// ═══════════════════════════════════════════════════════════
// 相关性判定（2026-10-07）
// ═══════════════════════════════════════════════════════════

/**
 * 抽取用于相关性比对的 token：
 *   · 英文/数字词（长度 ≥ 2）
 *   · CJK 2-gram（中文无空格，用相邻二字切分）
 * 纯数字（年份等）会被排除，避免「2026」这种噪声制造假相关。
 */
export function relevanceTokens(s: string): Set<string> {
  const out = new Set<string>()
  if (!s) {return out}
  const norm = s.toLowerCase()
  for (const m of norm.matchAll(/[a-z]{2,}|\d{3,}/g)) {
    const tok = m[0]
    if (/^[a-z]+$/.test(tok)) {out.add(tok); continue}
    // 年份（1900–2099）几乎不携带检索意图，只会制造假相关（如查询与结果
    // 都含「2026」就被判为相关）—— 排除。
    if (/^(19|20)\d{2}$/.test(tok)) {continue}
    // 其余 4 位以上的数字保留：股票代码（002519 / 00700）是有意义的检索词
    if (tok.length >= 4) {out.add(tok)}
  }
  const cjk = norm.replace(/[^\u4e00-\u9fa5]+/g, ' ')
  for (const seg of cjk.split(/\s+/)) {
    for (let i = 0; i + 2 <= seg.length; i++) {out.add(seg.slice(i, i + 2))}
  }
  return out
}

export function countOverlap(a: Set<string>, b: Set<string>): number {
  let n = 0
  for (const t of a) {if (b.has(t)) {n++}}
  return n
}

// ═══════════════════════════════════════════════════════════
// 通用词剔除（2026-10-12）
// ═══════════════════════════════════════════════════════════

/**
 * 「不携带检索意图」的通用词 / 词典字段词 / SEO 填充词。
 *
 * 【为什么要单独列出来】实测故障（2026-10-12）：
 *   用户问「尼古喵喵是什么」，模型把查询写成
 *     `"尼古喵喵" 猫 梗 出处 来源`
 *   于是 BING 返回的**字典条目**
 *     「尼 -字典-意思-解释-拼音-注音-读音-部首-出处」
 *   靠查询里的「出处」二字命中了相关性检查，被判为"有效结果"返回，
 *   真正相关的「【官方中字】迷你尼古喵喵 第1集_B站」反倒被挤到后面。
 *
 *   问题在于：这类词（出处 / 来源 / 意思 / 拼音 / 简介 …）**任何**词典页、
 *   SEO 聚合页、模板页里都有。拿它们当"命中"依据，等于没有过滤。
 *   所以判定相关性时必须先把它们从查询侧剔除。
 */
const GENERIC_QUERY_WORDS = [
  '出处', '来源', '意思', '解释', '释义', '含义', '拼音', '注音', '读音',
  '部首', '笔画', '笔顺', '组词', '造句', '近义词', '反义词', '词性',
  '字典', '词典', '汉典', '大全', '排行', '免费', '在线', '简介', '资料',
  '相关', '介绍', '官网', '官方', '下载', '图片', '视频',
  '是什么', '什么是', '什么', '怎么', '如何', '为什么', '哪里', '哪个',
]

/** 通用词的 token 集合（含各词自身的 CJK 2-gram，与 relevanceTokens 同口径） */
const GENERIC_TOKENS: Set<string> = (() => {
  const out = new Set<string>()
  for (const w of GENERIC_QUERY_WORDS) {
    out.add(w)
    for (let i = 0; i + 2 <= w.length; i++) {out.add(w.slice(i, i + 2))}
  }
  return out
})()

/**
 * 查询的「检索意图 token」= relevanceTokens(query) 去掉通用词。
 *
 * 相关性判定只用这个集合，避免「出处/来源」这类词制造假命中。
 * 如果剔除后剩余 token 不足 2 个（查询本身就是通用词堆砌），
 * 调用方应放弃过滤 —— 没有任何依据可判。
 */
export function intentTokens(query: string): Set<string> {
  const out = new Set<string>()
  for (const t of relevanceTokens(query)) {
    if (!GENERIC_TOKENS.has(t)) {out.add(t)}
  }
  return out
}

/**
 * 词典 / 百科「单字条目」判定。
 * 形如「美（汉语文字）_百度百科」「好_百度百科」—— 这类结果几乎总是
 * 「查询被拆成单字」或「引擎给出的词典卡片」，对信息检索没有价值。
 *
 * 🆕 2026-10-12 扩充：原实现只认「单字（拼音…）」和「单字_百度百科」两种形状，
 *   漏掉了把释义字段全塞进标题的词典页 —— 实测漏过的是：
 *     「尼 -字典-意思-解释-拼音-注音-读音-部首-出处」(shidianguji.com)
 *   它既不是单字 + 百科后缀，也没有全角括号，于是原判据全部落空。
 *   现在补两条：字段词密度 + 词典站域名。
 */
const DICT_FIELD_WORDS = /拼音|注音|部首|笔画|笔顺|释义|读音|字典|词典|汉典|组词|造句|近义词|反义词|词性|繁体|汉字/g
const DICT_HOSTS = /shidianguji|zdic|guoxuedashi|hanyu\.baidu|5156edu|zidian8|cidianwang|hancidian/i

export function isDictionaryEntry(title: string, link?: string): boolean {
  const t = title.trim()
  if (!t) {return false}
  // ① 「X（拼音/释义…）」开头的单字条目
  if (/^[\u4e00-\u9fa5]（[^）]{0,12}）/.test(t)) {return true}
  // ② 纯单字 + 百科/词典来源
  if (/^[\u4e00-\u9fa5]$/.test(t.replace(/[_\-–—\s]*(百度百科|维基百科|词典|汉典|在线新华字典).*$/, ''))) {
    return true
  }
  // ③ 🆕 词典字段词密度：标题里堆 ≥3 个词典字段 → 必然是词典/字源页
  //    （正常内容的标题不会同时出现「拼音/注音/部首/出处」这些东西）
  if ((t.match(DICT_FIELD_WORDS) || []).length >= 3) {return true}
  // ④ 🆕 词典站域名
  if (link && DICT_HOSTS.test(link)) {return true}
  return false
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

/**
 * 查询的「核心主体」= 最长的中日韩文字连续串（≥2 字）。
 *   「尼古喵喵 动画」→「尼古喵喵」；「美股 宏观 消息」→「美股」（并列取首个）
 */
export function coreSubject(query: string): string {
  const runs = String(query || '').match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]{2,}/g)
  if (!runs || runs.length === 0) {return ''}
  let best = ''
  for (const r of runs) {if (r.length > best.length) {best = r}}
  return best
}

/** 结果里有没有出现核心主体（用于判断"引擎是不是把词拆错了"） */
export function resultsMentionSubject(content: string, subject: string): boolean {
  if (!subject || subject.length < 2) {return true}
  return content.includes(subject)
}

// ═══════════════════════════════════════════════════════════
// 引擎结果页获取（含渲染兜底）
// ═══════════════════════════════════════════════════════════

/**
 * 取搜索引擎结果页的 HTML —— 被验证拦截时用**离屏浏览器**重试。
 *
 * 【为什么搜索引擎也需要渲染兜底】实测 2026-10-13：
 *   Bing 与百度曾**同时**被拦（Bing 无有效结果 + 百度安全验证），
 *   整条搜索链直接「所有引擎均失败」——用户什么资料都拿不到。
 *   搜索引擎的验证是针对"像爬虫的请求"的，换成真浏览器渲染大多能过。
 *
 * 【两处判据为什么不同】
 *   · HTTP 拿到的页面用 `isCaptchaPage`（扫原始 HTML，对引擎页够用且敏感）；
 *   · **渲染后**的页面必须用 `isChallengePage`（只看可见文本）——
 *     正常结果页的 JS 里也含 captcha 字样，用前者会把好页面误判成验证页。
 */
async function fetchSearchHtml(
  url: string,
  headers: Record<string, string>,
): Promise<{ html: string; blocked: boolean }> {
  const html = await httpGetText(url, headers, 15000)
  if (!isCaptchaPage(html)) {return { html, blocked: false}}
  if (!isRendererAvailable()) {return { html, blocked: true}}

  console.log('[search] 🖥️ 搜索引擎被验证拦截，改用浏览器渲染重试')
  const rendered = await renderPageWithBrowser(url, { timeoutMs: 18000 })
  if (rendered?.html && rendered.html.length > 1000 && !isChallengePage(rendered.html)) {
    console.log('[search] ✅ 渲染重试成功')
    return { html: rendered.html, blocked: false }
  }
  return { html, blocked: true }
}

// ═══════════════════════════════════════════════════════════
// 自动正文抓取 (v6.0)
// ═══════════════════════════════════════════════════════════

/**
 * 判断某个 URL 是不是「搜索引擎自己的页面」。
 *
 * 【为什么需要精确判断，不能一刀切排除整个域名】
 *   旧实现是 `!url.includes('baidu.com')` —— 把**整个百度域名**排除了。
 *   但百度搜索结果的链接正是 `https://www.baidu.com/link?url=…` 跳转，
 *   于是一旦用百度作为引擎，`extractTopLinks` 永远返回空 →
 *   **「自动抓正文」在百度这条路线上彻底失效**（实测 2026-10-13：
 *   用百度搜索时日志显示「候选 0 条」）。
 *
 *   现在只排除"引擎自己的搜索页/入口页"，放行结果跳转链接。
 */
export function isEnginePage(url: string): boolean {
  return (
    /(?:^|\/\/)[^/]*bing\.com\/search/i.test(url) ||
    /(?:^|\/\/)[^/]*baidu\.com\/(?:s\b|from=)/i.test(url) ||
    /(?:^|\/\/)[^/]*google\.[^/]*\/search/i.test(url) ||
    /(?:^|\/\/)[^/]*duckduckgo\.com\/(?:\?|html)/i.test(url)
  )
}

/** 从搜索结果中提取链接（top N 条） */
export function extractTopLinks(results: string, maxLinks: number): string[] {
  const links: string[] = []
  const linkRegex = /https?:\/\/[^\s\n)]+/g
  let match
  while ((match = linkRegex.exec(results)) !== null && links.length < maxLinks) {
    const url = match[0].replace(/[）\)]。，,、>]+$/, '')
    // 只排除引擎自己的搜索页；百度的 /link?url= 这类结果跳转必须放行
    if (!isEnginePage(url) && !links.includes(url)) {
      links.push(url)
    }
  }
  return links.slice(0, maxLinks)
}

/**
 * 判断抓到的文本是不是**二进制 / 乱码**（2026-10-12）。
 *
 * 【为什么必须有这道闸】实测故障：抓 bilibili 页面时，响应是 gzip 压缩的，
 *   而当时的 httpClient 没有解压能力，于是"网页正文"是这样一坨：
 *     `📄 ****` + `�y��6���S�6T�K�L-)���R…`
 *   它被**原样追加进了模型的上下文** —— 不但没帮上忙，还占了 2000 字的坑，
 *   把真正有用的搜索结果挤出去。这比"没抓到"更糟。
 *
 * 根因（解压缺失）已在 httpClient 修掉，但这里仍保留一道**独立**的闸：
 *   今后任何编码/解析异常都只会表现为"这条没抓到"，而不会污染上下文。
 */
export function looksLikeBinaryOrMojibake(text: string): boolean {
  if (!text || text.length < 20) {return true}
  const s = text.slice(0, 4000)
  let suspicious = 0
  for (const ch of s) {
    const c = ch.codePointAt(0) as number
    if (c === 0xFFFD) {suspicious += 2; continue}                       // 解码失败的替换符
    if (c < 0x20 && c !== 0x0A && c !== 0x09 && c !== 0x0D) {suspicious += 2; continue}
    if (c >= 0x7F && c <= 0x9F) {suspicious += 2; continue}             // C1 控制符
    if (c >= 0xE000 && c <= 0xF8FF) {suspicious += 2; continue}         // 私用区
  }
  if (suspicious / s.length > 0.01) {return true}
  // UTF-8 被当 Latin-1 解出的典型形态：大量落在 U+0080–U+00FF（Latin-1 补充区）。
  //   正常中英文正文几乎不含这些字符；法/德等带重音的正文占比也远低于 8%。
  let latin1 = 0
  for (const ch of s) {
    const c = ch.codePointAt(0) as number
    if (c >= 0x80 && c <= 0xFF) {latin1++}
  }
  return latin1 / s.length > 0.08
}

/** 抓取网页正文并提取关键段落（每个页面 ≤ 1500 字） */
async function fetchPageContent(url: string): Promise<{ title: string; snippet: string } | null> {
  try {
    const html = await httpGetText(url, { 'Accept-Language': 'zh-CN,zh;q=0.9' }, 10000)
    // ⚠️ 这里必须用 isChallengePage（只看可见文本 + 短页）而不是 isCaptchaPage ——
    //   后者扫原始 HTML，正常网页 JS 里的 captcha/429 字样会把 B 站这种正常页面
    //   判成验证页，导致**已经抓到的正文被丢弃**（实测误杀）。
    if (!html || isChallengePage(html)) {return null}

    return extractFromHtml(html, url)
  } catch {
    return null
  }
}

/**
 * 从 HTML 里提取「标题 + 正文」（2026-10-12 抽出，供 HTTP 抓取与浏览器渲染共用）。
 *
 * 旧实现是"删掉标签 + 保留长度 > 20 的行"，实测**模板噪音占了大半**：
 * 实测 B 站视频页抓回 375 字，真正信息只有一两句；mfuns 页 9003 字里
 * 大半是弹幕列表/推荐位/备案号。噪音会**挤掉上下文预算**，
 * 让模型把注意力花在「沪ICP备2022032900号」上。
 *
 * 现在交给 contentExtractor（零依赖的 Readability-lite）。
 */
function extractFromHtml(html: string, url: string): { title: string; snippet: string } | null {
  const extracted = extractMainContent(html, { maxChars: 1500 })

  // 抓到乱码就当"没抓到"，绝不把乱码塞进模型上下文
  if (looksLikeBinaryOrMojibake(extracted.text)) {
    console.log(`[search] 🚫 抓到的正文疑似二进制/乱码，已丢弃: ${url.slice(0, 80)}`)
    return null
  }
  if (!extracted.text || extracted.text.length < 50) {return null}

  return { title: extracted.title || url, snippet: extracted.text }
}

/** 为搜索结果自动抓取正文（最多保留 2 篇可读的） */
async function enrichWithPageContent(
  originalContent: string,
  query: string,
): Promise<string> {
  // 🆕 2026-10-12: 候选从 2 条放宽到 **6** 条（≈整页结果），最多保留 2 篇可读的。
  //   实测：查「尼古喵喵」时，最相关的几条恰好都是抓不到的站点
  //   （B站视频页 = JS 渲染、百度百科 = 安全验证、Anibase = Cloudflare 挑战页），
  //   而第 5 条 mfuns.net 是能抓到正文的 —— 只试 2 条等于白跑一趟。
  //   并行抓取，多试几条的墙钟时间几乎不变，只是多几个请求。
  const links = extractTopLinks(originalContent, 6)
  if (links.length === 0) {return originalContent}

  // 🆕 2026-10-12：**并行**抓取。原来串行 await，最坏情况 2 × 10s 超时 = 20s，
  //   对交互式对话来说太久（用户会以为卡死）。并行后最坏仍是一个超时的时间。
  const pages = await Promise.all(links.map(url => fetchPageContent(url)))

  // 🆕 2026-10-12: 按正文长度**从长到短**挑 2 篇。
  //   候选里常有"抓到了但只有几十字"的页面（JS 渲染的页面只剩标题），
  //   按原顺序取前 2 篇可能塞进两段没营养的文本，把真正有料的挤掉。
  const ok = pages
    .filter((p): p is { title: string; snippet: string } => !!p && p.snippet.length > 100)
    .sort((a, b) => b.snippet.length - a.snippet.length)
    .slice(0, 2)

  // 🆕 2026-10-12: HTTP 全军覆没时，用**离屏真浏览器**兜底渲染。
  //   这是覆盖 B站 / 百科 / 知乎 这类站点（JS 渲染 or 反爬）的唯一办法 ——
  //   实测：B 站视频页 HTTP 只拿到标题，渲染后能拿到完整正文。
  //   成本很高（每页 2~5 秒、并发上限 1），所以**只在一条都没抓到时才用**，
  //   且最多试 2 条。
  if (ok.length === 0 && isRendererAvailable()) {
    for (const url of links.slice(0, 2)) {
      const rendered = await renderPageWithBrowser(url)
      if (!rendered) {continue}
      // 渲染结果复用同一套正文提取规则，保证两条路径的输出形态一致
      const fromHtml = extractFromHtml(rendered.html, url)
      const snippet = fromHtml?.snippet || rendered.text.slice(0, 1500)
      if (snippet && snippet.length > 100) {
        console.log(`[search] 🖥️ 浏览器渲染兜底成功: ${url.slice(0, 70)}`)
        ok.push({ title: rendered.title || fromHtml?.title || url, snippet })
      }
      if (ok.length >= 2) {break}
    }
  }

  const pageContents = ok.map(p => `📄 **${p.title || ''}**\n${p.snippet.slice(0, 2000)}`)

  if (pageContents.length === 0) {return originalContent}

  return `${originalContent}\n\n━━━ 网页正文（AI 抓取，可直接据此总结）━━━\n\n${pageContents.join('\n\n---\n\n')}`
}

/**
 * 查询净化（2026-10-12）—— 剔除**通用疑问词 / 填充词**。
 *
 * 【为什么必须做这件事】实测对照（同一时刻、同一引擎、同一实体）：
 *
 *   查询 `尼古喵喵`        → ✅ 结果全是相关的（B站动画、Anibase 资料）
 *   查询 `尼古喵喵 动画`   → ✅ 相关
 *   查询 `尼古喵喵 是什么` → ❌ **10 条全是「尼」字的字典页**
 *   查询 `尼古喵喵 梗`     → ❌ 同上
 *
 *   根因：搜索引擎对中文会分词。查询里塞进「是什么 / 梗 / 出处」这类词后，
 *   分词结果里「尼古喵喵」被切碎，引擎退化成**单字「尼」**匹配，
 *   于是返回一堆「尼（汉语文字）_百度百科」。**越"礼貌"的问法越搜不到。**
 *
 *   而模型天然爱加这些词（DB 里实际出现的查询：`"尼古喵喵" 猫 梗 出处 来源`）。
 *   所以不能指望模型写对 —— 由代码把通用词摘掉。
 *
 * 安全网：净化后过短（查询本身就是疑问句）→ 原样返回，绝不把问题抹空。
 * 另外 webSearch 里还有一层兜底：净化后搜不到会**用原查询再试一轮**。
 */
const QUERY_FILLER =
  /(是什么|什么是|什么意思|是谁|是什么梗|什么梗|的梗|梗|出处|来源|介绍|简介|资料|由来|来历|为什么|怎么样|怎样|怎么|如何|哪个|哪里|哪些|什么)/g

export function sanitizeQuery(query: string): string {
  let cleaned = String(query || '')
    .replace(QUERY_FILLER, ' ')
    .replace(/[?？!！。，,、；;：:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  // 🐛 2026-10-13 修复：摘掉通用词后会留下**悬空助词**。
  //   实测：「量子纠缠的由来」→ 摘掉「由来」→ **「量子纠缠的」**，
  //   末尾那个「的」是纯噪声，会污染检索（也难看）。
  //   所以再清一次首尾的助词/语气词。
  cleaned = cleaned
    .replace(/^[\s的地得]*(?:的|地|得)?[\s的]+/, '')
    .replace(/[\s的地得了吗呢吧啊]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  // 净化后有效字符不足 2 个 → 说明查询本身就是一句疑问（如「是什么」），
  //   摘掉就什么都不剩了，此时保留原查询。
  //   同理：净化后只剩代词（「这个梗的来历」→「这个」）也保留原查询 ——
  //   搜「这个」没有任何意义，不如带着限定词去搜。
  const PRONOUN_ONLY = /^(?:这个|那个|这些|那些|它|他|她|我|你|这里|那里|此事|该事)$/
  if (cleaned.replace(/\s/g, '').length < 2 || PRONOUN_ONLY.test(cleaned)) {return query}
  return cleaned
}

/**
 * 判断是否该**自动**抓取正文（2026-10-12 新增）。
 *
 * 【要解决的期望落差】用户原话：
 *   「不是那种收集相关的网站然后再整理总结的么」
 *   期望流程 = 搜索 → 打开相关网站 → 读正文 → 整理总结
 *   实际流程 = 搜一下，把标题/摘要原样摊开 → 模型只能凭标题猜
 *
 * 根因：`fetchPages` 默认 false，而工具描述里没告诉模型「什么时候该开」，
 *   于是模型永远只调一次裸搜索。把"该不该抓"交给模型判断是不可靠的 ——
 *   改为由代码判定：满足任一条件就自动抓。
 *
 *   ① 查询是**信息型**（是什么 / 介绍 / 资料 / 由来 / 出处 / 为什么 / 原理…）
 *      —— 这类问题的答案必然在正文里，标题摘要给不出来；
 *   ② 有效结果偏少（< 3 条）—— 材料不够，必须自己抓。
 */
const INFORMATIONAL_QUERY =
  /是什么|什么是|是谁|什么意思|介绍|简介|资料|由来|起源|出处|来历|背景|为什么|怎么|如何|原理|区别|评价|怎么样|值得|推荐|梗/

export function shouldAutoFetchPages(query: string, content: string): boolean {
  if (!content || !isValidResult(content)) {return false}
  if (INFORMATIONAL_QUERY.test(query)) {return true}
  // 结果条数：匹配 "1. " 这类编号行
  const resultCount = (content.match(/^\d+\.\s/gm) || []).length
  return resultCount > 0 && resultCount < 3
}

// ═══════════════════════════════════════════════════════════
// 结构化检索接口（2026-10-12 新增）
//
// 【为什么需要】`deep_research`（深度调研）此前用的是
//   `https://api.duckduckgo.com/?format=json` —— 那是**即时答案 API**，
//   只返回百科摘要，根本不是网页搜索；而且实测**三个查询全部超时不可达**。
//   结果：「帮我调研 X」这类请求走进 deep_research → 搜索恒返回空 →
//   整条多轮调研流水线跑完只产出一份空报告。**功能是死的。**
//
//   现在把结构化检索暴露出来，让深度调研复用同一条（已验证的）搜索栈：
//   净化查询 → 多引擎回退 → 相关性过滤 → 排序。
// ═══════════════════════════════════════════════════════════

/**
 * 把 `normalizeResults` 产出的文本解析回结构化结果。
 *
 * 格式（本模块自己写的，属内部稳定契约）：
 *   1. 标题
 *      https://链接
 *      摘要
 *
 * 注意：只认「标题行 + 至少一个 http 链接」的块，其它文本（如抓取正文段）会被忽略。
 */
export function parseResultBlocks(text: string): Array<{ title: string; link: string; desc: string }> {
  const out: Array<{ title: string; link: string; desc: string }> = []
  let cur: { title: string; link: string; desc: string } | null = null
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim()
    if (/^\d+\.\s/.test(line)) {
      if (cur) {out.push(cur)}
      cur = { title: line.replace(/^\d+\.\s*/, '').trim(), link: '', desc: '' }
      continue
    }
    if (!cur) {continue}
    if (/^https?:\/\//i.test(line)) {
      if (!cur.link) {cur.link = line}
      continue
    }
    if (line) {cur.desc = cur.desc ? `${cur.desc} ${line}` : line}
  }
  if (cur) {out.push(cur)}
  return out.filter(r => r.title && r.link)
}

/**
 * 结构化搜索 —— 返回结果数组（而非给模型看的文本）。
 * 供 `deep_research` 等需要自己处理结果的调用方使用。
 */
export async function searchStructured(
  query: string,
  count = 5,
): Promise<Array<{ title: string; link: string; desc: string }>> {
  const q = sanitizeQuery(query)
  const text = await searchWithFallback(q, 'bing', Math.min(Math.max(count, 1), 10))
  if (!isValidResult(text)) {return []}
  return parseResultBlocks(text).slice(0, count)
}

/** 抓取单页可读正文（结构化版）—— 供需要"读正文"的调用方使用 */
export async function fetchReadablePage(url: string): Promise<{ title: string; text: string } | null> {
  const page = await fetchPageContent(url)
  if (page) {return { title: page.title, text: page.snippet }}

  // 🆕 2026-10-12: HTTP 拿不到时用离屏浏览器兜底（反爬 / JS 渲染站点）。
  //   深度调研是"慢而全"的操作，值得为拿到真材料多花几秒。
  if (isRendererAvailable()) {
    const rendered = await renderPageWithBrowser(url)
    if (rendered) {
      const extracted = extractFromHtml(rendered.html || '', url)
      const text = extracted?.snippet || rendered.text.slice(0, 1500)
      if (text && text.length > 100) {
        return { title: rendered.title || extracted?.title || url, text }
      }
    }
  }
  return null
}

// ═══════════════════════════════════════════════════════════
// 工具定义
// ═══════════════════════════════════════════════════════════

export const webSearchDef: ToolDef = {
  name: 'web_search',
  description: `网页搜索（多引擎，默认 bing）。结果已按相关性过滤掉词典页 / SEO 垃圾页。
参数含义见下方 schema。

⚠️ 用法约定（直接影响回答质量）:
1. query 写「实体词 + 限定词」，**别写疑问句**：「是什么 / 梗 / 出处 / 来源」会被自动摘掉，
   它们会让引擎的中文分词退化成**单字匹配**、搜出一堆字典页。
   ✅ "尼古喵喵 动画"    ❌ "尼古喵喵 梗 出处 来源"
2. 「是什么 / 介绍 / 资料」这类问题的答案在**网页正文**里：
   结果带「网页正文（AI 抓取）」就直接读它总结；正文不足则用 web_fetch(url) 打开最相关那条读完再答，
   别凭标题猜。
   （正文段已自动剥离导航/弹幕/推荐/备案号等模板噪音；B站/百科这类站点会自动改用浏览器渲染获取。）
3. 回答要给出**信息来源**（网站名或链接）；别重复搜同一个词。`,
  params: {
    query: { type: 'string', description: '搜索关键词', required: true },
    engine: { type: 'string', description: '搜索引擎: bing / google / baidu / brave (默认 bing)', required: false },
    braveApiKey: { type: 'string', description: 'Brave Search API 的 X-Subscription-Token (可选)', required: false },
    count: { type: 'number', description: '结果数量 (1-10，默认5)', required: false },
    fetchPages: { type: 'boolean', description: '是否抓取网页正文 (默认 false；信息型问题会自动抓取)', required: false },
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
    const { html, blocked } = await fetchSearchHtml(url, { 'Accept-Language': 'zh-CN,zh;q=0.9' })

    // v6.0: 验证页检测（渲染兜底已在 fetchSearchHtml 内尝试过）
    if (blocked) {
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
    const content = normalizeResults(results, count, query)
    // 🔧 只缓存**有效**结果。否则「无结果」与「垃圾结果」会被缓存住，
    //   用户反复搜同一个词时永远拿到同一份垃圾，回退引擎的结果被缓存挡住。
    //   （2026-10-07「搜到单字词典」那次，缓存就是帮凶。）
    if (isValidResult(content)) {cacheSet(cacheKey, content)}
    return content
  } catch (e) {
    return `Bing 搜索出错: ${e instanceof Error ? e.message : String(e)}`
  }
}

/** Google 网页搜索 (HTML 解析) — v6.0: 验证页检测 */
/**
 * Bing RSS 搜索 —— 结构最稳定的兜底引擎（2026-10-13 并入主栈）。
 *
 * 【为什么保留它】搜索引擎改版会让 HTML 解析失效（本项目已踩过多次），
 *   而 RSS 的 XML 结构多年不变；实测它的摘要还更完整
 *   （直接带「日文原名：ヤニねこ…全12集」这类正文信息）。
 *
 * 【为什么并入主栈】它原先是**另一条独立搜索栈**（`impl/webSearch.ts`，
 *   只被 browser 工具使用），那条栈没有相关性过滤/重排/正文抓取 ——
 *   于是「模型用 web_search」和「模型用 browser 搜索」拿到的质量不一样。
 *   现在合并成一条栈：结果同样过 `normalizeResults`（词典过滤 + 相关性 + 主体加权）。
 */
async function searchBingRss(query: string, count: number): Promise<string> {
  try {
    const cacheKey = `bingrss:${query}:${count}`
    const cached = cacheGet(cacheKey)
    if (cached) {return cached}

    const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${count}&format=rss`
    const xml = await httpGetText(url, { 'Accept-Language': 'zh-CN,zh;q=0.9' }, 10000)
    if (isCaptchaPage(xml)) {return '__CAPTCHA_BLOCKED__'}

    const items = xml.match(/<item>([\s\S]*?)<\/item>/g) || []
    const results = items.slice(0, count).map(item => {
      const pick = (re1: RegExp, re2: RegExp): string => {
        const m = item.match(re1) || item.match(re2)
        return m ? decodeEntities(m[1] || '') : ''
      }
      return {
        title: pick(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/, /<title>([\s\S]*?)<\/title>/).trim(),
        link: pick(/<link>([\s\S]*?)<\/link>/, /<link>([\s\S]*?)<\/link>/).trim(),
        desc: pick(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/, /<description>([\s\S]*?)<\/description>/).slice(0, 220),
      }
    }).filter(r => r.title && /^https?:\/\//i.test(r.link))

    if (results.length === 0) {return '（Bing RSS 未返回结果）'}

    const content = normalizeResults(results, count, query)
    if (isValidResult(content)) {cacheSet(cacheKey, content)}
    return content
  } catch (e) {
    return `Bing RSS 搜索出错: ${e instanceof Error ? e.message : String(e)}`
  }
}

async function searchGoogle(query: string, count: number): Promise<string> {
  try {
    const cacheKey = `google:${query}:${count}`
    const cached = cacheGet(cacheKey)
    if (cached) {return cached}

    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=${count}&hl=zh-CN`
    const { html, blocked } = await fetchSearchHtml(url, { 'Accept-Language': 'zh-CN,zh;q=0.9' })

    if (blocked) {
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

    const content = normalizeResults(results, count, query)
    // 🔧 只缓存**有效**结果。否则「无结果」与「垃圾结果」会被缓存住，
    //   用户反复搜同一个词时永远拿到同一份垃圾，回退引擎的结果被缓存挡住。
    //   （2026-10-07「搜到单字词典」那次，缓存就是帮凶。）
    if (isValidResult(content)) {cacheSet(cacheKey, content)}
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
    const { html, blocked } = await fetchSearchHtml(url, { 'Accept-Language': 'zh-CN,zh;q=0.9', 'Cookie': 'BAIDUID=;' })

    if (blocked) {
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

    const content = normalizeResults(results, count, query)
    // 🔧 只缓存**有效**结果。否则「无结果」与「垃圾结果」会被缓存住，
    //   用户反复搜同一个词时永远拿到同一份垃圾，回退引擎的结果被缓存挡住。
    //   （2026-10-07「搜到单字词典」那次，缓存就是帮凶。）
    if (isValidResult(content)) {cacheSet(cacheKey, content)}
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
    return normalizeResults(results, count, query)
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
    // 🆕 2026-10-13: 把 Bing RSS 并入主栈（原先是另一条独立搜索栈，见下）
    //   ⚠️ 名字必须与 `bing` 不同：buildEngineOrder 末尾**按 name 去重**，
    //   同名会被当成重复项过滤掉 —— RSS 兜底就永远不会执行。
    bingrss: { name: 'Bing RSS', execute: (q, c) => searchBingRss(q, c) },
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
  //   `bingrss` 放在 HTML 系引擎之后：它是**结构最稳定**的兜底 ——
  //   搜索引擎改版会让 HTML 解析失效，而 RSS 的 XML 结构多年不变，
  //   且实测它的摘要更完整（直接带「日文原名：ヤニねこ…全12集」这类正文信息）。
  for (const name of ['bing', 'baidu', 'google', 'bingrss', 'brave']) {
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
  const rawQuery: string = String(args.query || '')
  const engine: string = (args.engine || 'bing').toLowerCase()
  const count = Math.min(args.count || 5, 10)
  const fetchPages: boolean = args.fetchPages === true
  const skipDate: boolean = args.skipDate === true
  const start = Date.now()

  // 🆕 2026-10-12: 查询净化 —— 摘掉「是什么 / 梗 / 出处」这类通用词。
  //   实测：加了这些词，引擎的中文分词会退化成单字匹配，返回一堆字典页。
  //   （对照实验见 sanitizeQuery 的注释）
  const sanitized = sanitizeQuery(rawQuery)

  // P1: 自动日期注入（除非调用方明确跳过）
  let query = skipDate ? sanitized : injectDateIfNeeded(sanitized)

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

  // 🆕 2026-10-13 多轮追问式检索：结果里**连核心主体都没出现** → 基本可以断定
  //   引擎把查询拆错了（实测：`尼古喵喵 是什么` 会让 Bing 退化成单字「尼」匹配，
  //   返回一屏字典页）。这时不是把一轮烂结果交给模型，而是**再追问一次** ——
  //   用引号把主体括起来强制短语匹配（`"尼古喵喵"`）。
  //   只有当第二轮确实更好（结果里出现了主体）才采用，否则保持原结果。
  const subject = coreSubject(query)
  if (isValidResult(content) && subject && !resultsMentionSubject(content, subject)) {
    const quoted = `"${subject}"`
    console.log(`[search] 🔁 结果未提及核心主体「${subject}」，改用短语匹配重搜: ${quoted}`)
    const refined = await searchWithFallback(
      skipDate ? quoted : injectDateIfNeeded(quoted), engine, count, args.braveApiKey,
    )
    if (isValidResult(refined) && resultsMentionSubject(refined, subject)) {
      console.log(`[search] ✅ 追问重搜命中主体`)
      content = refined
      query = quoted
    }
  }

  // 🆕 2026-10-12: 兜底 —— 净化后的查询搜不到时，**用原查询再试一轮**。
  //   净化是启发式的，可能恰好摘掉了必要限定词；宁可多花一次请求，
  //   也不要因为"我们改写了查询"而让用户拿不到结果。
  if (!isValidResult(content) && sanitized !== rawQuery) {
    console.log(`[search] ↩️ 净化查询无有效结果，改用原查询重试: "${rawQuery.slice(0, 60)}"`)
    const retry = await searchWithFallback(
      skipDate ? rawQuery : injectDateIfNeeded(rawQuery), engine, count, args.braveApiKey,
    )
    if (isValidResult(retry)) {
      content = retry
      query = skipDate ? rawQuery : injectDateIfNeeded(rawQuery)
    }
  }

  // P1: 自动抓取正文
  //   🆕 2026-10-12：除了模型显式传 fetchPages:true，信息型问题**自动**抓正文 ——
  //   用户期望的是「收集相关网站 → 整理总结」，而模型永远只调一次裸搜索。
  //   注意这里用**原始查询**判断是否"信息型"：净化会把「是什么」摘掉，
  //   而"这是不是一个信息型问题"要看用户原本怎么问。
  const needFetch = fetchPages || shouldAutoFetchPages(rawQuery, content)
  if (needFetch && isValidResult(content)) {
    console.log(`[search] 📄 ${fetchPages ? '显式请求' : '自动'}抓取正文（候选 ${extractTopLinks(content, 6).length} 条，最多保留 2 篇）...`)
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
