// ============================================================
// agentRunner.preprocess.ts — 消息发送前的检索预处理
//
// 【为什么从 agentRunner.ts 拆出来】
// agentRunner.ts 超过 4000 行，核心运行循环、工具执行、模型探测、
// 情绪门控、提示词构建全挤在一个文件里。2026-10-05 的发布前复核把它
// 定为 P2 风险项：单文件过大意味着任何一次改动都要在 4k 行里找上下文，
// 也让同类项目踩过的「大会话打不开」那类性能问题更难定位。
//
// 【拆分原则：只搬不加不改】
// 这一块（意图识别 → 自动搜索 / URL 抓取 → 结果注入）本来就是一个
// 独立的输入变换管线：text 进，注入过上下文的 text 出，不依赖 AgentRunner
// 的任何实例状态，所以它**可以**被干净地切出去。
//
// ⚠️ 本次拆分是**纯搬运**：函数体、注释、常量、调用顺序一字未改，
// 只调整了 import 与可见性。任何行为差异都应视为拆分引入的回归。
// 回归由 tests/agentRunnerPreprocess.test.ts 把关。
//
// 【为什么保留 re-export】
// 原先调用方从 './agentRunner' 引入这些符号。保留 re-export 让它们继续可用，
// 避免一次性改动全仓调用点（那是另一种风险，与本次目标无关）。
// ============================================================

import { SEARCH_INTENT_PATTERNS, SEARCH_EXCLUDE_PATTERNS, COMPANION_CHAT_PATTERNS, COLLECT_INTENT_PATTERNS } from './agentRunner.constants'
import { webSearch } from './tools/impl/search'
import { extractUrls, collectUrls, saveCollected } from './tools/impl/contentCollector'

/** 搜索意图检测模式 — 三层递进 */

/** 一条消息是否属于"不该自动联网"的自我指涉/陪伴闲聊 */
export function isCompanionChat(text: string): boolean {
  return COMPANION_CHAT_PATTERNS.some(re => re.test(text))
}

export async function preExecuteSearch(text: string, skipAutoSearch = false): Promise<string | null> {
  const trimmed = text.trim()

  // 显式关闭自动搜索（桌宠陪伴会话），或命中自我指涉/陪伴闲聊 → 直接不搜；模型之后仍可自行调用 web_search
  if (skipAutoSearch || isCompanionChat(trimmed)) {
    console.log(`[PreSearch] 🚫 跳过自动搜索（${skipAutoSearch ? '会话关闭自动搜索' : '自我指涉/陪伴闲聊'}）: "${trimmed.slice(0, 40)}"`)
    return null
  }

  // 获取当前日期，用于时效性查询注入
  const _now = new Date()
  const _dateStr = `${_now.getFullYear()}-${String(_now.getMonth()+1).padStart(2,'0')}-${String(_now.getDate()).padStart(2,'0')}`
  // ── 时效性判断（v12.0 重写：三层递进，更加灵活） ──
  //
  // 策略：不依赖穷举关键词，而是从"用户怎么说"来判断时效性。
  //
  // Layer 1: 时间词触发
  //   只要消息含"今天/最近/最新/现在/当前/实时/本月/本周/今日/这两天"等时间词，
  //   说明用户关心的是当下 → 直接视为时效性。无论问的是股票还是电影还是天气。
  //   例："今天北京天气" → ✅ | "最近有什么好电影" → ✅ | "现在黄金多少钱" → ✅
  //
  // Layer 2: 时效领域触发
  //   虽然没有时间词，但问的是天生有时效性的领域 → 也视为时效性。
  //   金融、新闻、天气、体育、科技、娱乐、政治、灾害…这些领域的数据每天变化。
  //   例："比特币怎么样" → ✅ | "湖人队比赛" → ✅ | "iOS 19 发布" → ✅
  //
  // Layer 3: 历史数据排除
  //   如果用户明确提到了往年日期（"2024年""去年""上个月"），不覆盖。
  //   例："2024年A股表现" → ❌ 不加日期 | "去年黄金价格" → ❌ 不加日期
  // ────────────────────────────────────────────────────────

  // Layer 1: 时间词（只要有，任何话题都变时效）
  const _HAS_TIME_WORD = /今天|今日|最近|最新|现在|当前|实时|本月|本周|这两天|眼下|这会儿|昨晚|今早|凌晨|刚刚|新(的)?[闻问]/

  // Layer 2: 时效领域（覆盖九大类）
  const _TIME_SENSITIVE_DOMAIN =
    // 金融投资
    /股票|股价|行情|走势|涨了|跌了|涨停|跌停|A股|美股|港股|基金|大盘|指数|期货|原油|黄金|白银|汇率|美元|人民币|比特币|加密货币|以太坊|区块[链连]|市值|成交量|资金|北向|南向|板块|概念股|估值|泡沫|回调|反弹|牛市|熊市|仓位|减持|增持|回购|分红|送股/
    // 公司财务
    .source + // 分开写避免超长 regex 可读性差，用 + 连接
    /|财报|业绩|营收|利润|净利润|毛利率|净利率|资产负债|现金流|评级|目标价|研报|公告|披露|上市|IPO|退市|ST/
    .source +
    // 新闻热点
    /|新闻|热点|头条|热搜|资讯|报道|消息|传闻|爆料|辟谣|声明|回应|抗议|示威|冲突|战争|停火|制裁|关税|贸易战/
    .source +
    // 科技数码
    /|科技|数码|手机|芯片|AI|人工智能|大模型|GPT|发布|上市|新品|销量|价格|降价|涨价|评测|跑分|系统|更新|升级|补丁|漏洞|破解/
    .source +
    // 体育娱乐
    /|体育|比赛|比分|赛果|联赛|NBA|CBA|英超|欧冠|世界杯|奥运|金牌|冠军|亚军|娱乐|票房|电影|电视剧|综艺|收视率|番位|热搜/
    .source +
    // 天气灾害
    /|天气|温度|降雨|降雪|台风|地震|海啸|洪水|干旱|高温|寒潮|预警|空气质量|雾霾|PM2[.]?5/
    .source +
    // 政治社会
    /|选举|投票|民调|总统|首相|总理|当选|就职|辞职|下台|政策|法规|立法|禁令|开放|限制|签证|移民|人口|GDP|通胀|CPI|失业率/
    .source +
    // 交通生活
    /|路况|航班|高铁|地铁|公交|油价|电价|水价|放假|假期|节日|春运|国庆|春节|五一|中秋/
    .source +
    // 医疗卫生
    /|疫情|病例|感染|疫苗|药物|获批|临床|试验|医保|集采|医院|挂号|健康/
  const _TIME_SENSITIVE_REGEX = new RegExp(_TIME_SENSITIVE_DOMAIN)

  // Layer 3: 历史数据排除（提到往年 → 不加今日日期）
  const _HISTORICAL_REF = /(?:去年|前年|上年|\d{4}\s*年|\d{4}\s*[–\-]\s*\d{4})/

  // ── 排除不搜的消息 ──
  for (const ex of SEARCH_EXCLUDE_PATTERNS) {
    if (ex.test(trimmed)) {
      // 🔧 2026-08-14: Rescue — 如果消息包含明显搜索意图关键词，不排除
      //   解决"打开看看最新的AI新闻"等混合指令被误拦截的问题
      const rescueSignals = /今天|今日|最近|最新|现在|当前|实时|本月|本周|[？?]|股票|新闻|天气|AI|人工智能|分析|对比|推荐|介绍|价格|行情|走势|发布|上市|销量|票房|比分|赛果|地震|台风|预警|汇率|比特币|加密货币|以太坊|区块[链连]|市值|成交量|资金|板块|概念股|估值|泡沫|回调|反弹|牛市|熊市|仓位|减持|增持|回购|分红|送股|财报|业绩|营收|利润|净利润|毛利率|净率|资产负债|现金流|评级|目标价|研报|公告|披露|上市|IPO|退市|ST|科技|数码|手机|芯片|大模型|GPT|评测|跑分|系统|更新|升级|补丁|漏洞|破解|体育|比赛|联赛|NBA|英超|欧冠|世界杯|奥运|金牌|冠军|亚军|娱乐|电影|电视剧|综艺|番位|热搜|路况|航班|高铁|地铁|公交|油价|电价|水价|放假|假期|节日|春运|国庆|春节|五一|中秋|疫情|病例|感染|疫苗|药物|获批|临床|试验|医保|集采|医院|挂号|健康|选举|投票|民调|总统|首相|总理|当选|就职|辞职|下台|政策|法规|立法|禁令|开放|限制|签证|移民|人口|GDP|通胀|CPI|失业率/
      if (rescueSignals.test(trimmed)) {
        console.log('[PreSearch] 🚪 排除模式命中但 Rescue 放行（含搜索意图关键词）')
        break
      }
      return null
    }
  }

  const intent = matchSearchIntent(trimmed)
  if (intent) {
    let query = intent.query

    // ── v12.0 改进：三层时效性判断 ──
    //   Layer 1: 用户消息含时间词 → 必时效
    //   Layer 2: 属时效领域 → 时效
    //   Layer 3: 提到往年 → 排除
    //
    //   ✅ 覆盖场景：
    //     "今天北京天气" "最近有什么好电影" "比特币怎么样" "湖人比赛"
    //     "iOS 19 发布了？" "查一下五一放假安排" "油价又涨了？"
    //   ❌ 不追加日期：
    //     "2024年A股走势" "去年黄金价格" "巴菲特投资理念"
    const hasTimeWord = _HAS_TIME_WORD.test(trimmed)
    const inTimeDomain = _TIME_SENSITIVE_REGEX.test(query) || _TIME_SENSITIVE_REGEX.test(trimmed)
    const isHistorical = _HISTORICAL_REF.test(trimmed)

    const isTimeSensitive = (hasTimeWord || inTimeDomain) && !isHistorical
    if (isTimeSensitive && !query.includes(String(_now.getFullYear()))) {
      query = `${query} ${_dateStr}`
      console.log(`[PreSearch] 📅 时效性查询，追加日期后: "[${query}]" (时间词=${hasTimeWord}, 时效领域=${inTimeDomain})`)
    }

    // .x: 保护专有名词 — 对「汉字+数字」混合词（如"科创50"）加引号，防止百度拆词
    //   也处理数字在前的场景（如"50ETF"被拆成"50"+"ETF"）
    const _MIXED_NOUN = /[\u4e00-\u9fff]+(?:[\d]+(?:[\u4e00-\u9fff]+)?)|(?:[\d]+[\u4e00-\u9fff]+)/g
    const mixedMatches = query.match(_MIXED_NOUN)
    if (mixedMatches) {
      let protectedQuery = query
      for (const noun of mixedMatches) {
        // 跳过表年份/月份的结构（"2026年"、"7月"等）
        if (/^(?:\d+年|\d+月|\d+日)$/.test(noun)) {continue}
        // 跳过纯数字或纯汉字的
        if (/^\d+$/.test(noun) || /^[\u4e00-\u9fff]+$/.test(noun)) {continue}
        if (noun.length >= 3 && !protectedQuery.includes(`"${noun}"`)) {
          protectedQuery = protectedQuery.replace(noun, `"${noun}"`)
        }
      }
      if (protectedQuery !== query) {
        console.log(`[PreSearch] 🔒 专有名词加引号: "${query}" → "${protectedQuery}"`)
        query = protectedQuery
      }
    }

    try {
      console.log(`[PreSearch] 检测到意图 ["${intent.description}": "${query}"]，执行搜索...`)
      // 时效性查询获取更多结果（10条），非时效性保持5条
      const searchCount = isTimeSensitive
        ? 10
        : Math.min(5, Math.max(3, Math.floor(query.length / 10)))
      // 🔧 2026-07-12: 默认引擎改为 baidu（中文搜索最准，之前 Bing 对时间词过度匹配）
      // .x: 方案 3 — 首次用 baidu；结果质量差时自动 fallback 到 bing
      const result = await webSearch({ query, engine: 'baidu', count: searchCount })
      const content = typeof result === 'string' ? result : (result.content || '')
      if (content && !content.includes('未找到结果') && !content.includes('搜索出错') && !content.includes('搜索超时')) {
        // .x: 质量检查 — 对混合词查询，百度结果过短或出现歧义时补查 Bing
        const hadMixedNoun = mixedMatches && mixedMatches.some(m => !/^(?:\d+年|\d+月|\d+日)$/.test(m) && m.length >= 3)
        const isBaiduQualityLow = hadMixedNoun && (
          content.length < 200 ||
          content.includes('（未找到有效结果）') ||
          content.split('\n\n').filter(l => /^\d+\./.test(l.trim())).length <= 1
        )
        if (isBaiduQualityLow) {
          console.log(`[PreSearch] ⚠️ 百度结果质量不佳（${content.length} 字符，${content.split('\n\n').filter(l => /^\d+\./.test(l.trim())).length} 条），尝试 Bing 补充...`)
          const bingResult = await webSearch({ query, engine: 'bing', count: searchCount })
          const bingContent = typeof bingResult === 'string' ? bingResult : (bingResult.content || '')
          if (bingContent && !bingContent.includes('未找到结果') && !bingContent.includes('搜索出错') && !bingContent.includes('搜索超时')) {
            console.log(`[PreSearch] ✅ Bing 补充成功，${bingContent.length} 字符`)
            return `【百度搜索】\n${content}\n\n【Bing 搜索补充】\n${bingContent}`
          }
        }
        console.log(`[PreSearch] 搜索完成，${content.length} 字符`)
        return content
      }
      console.log(`[PreSearch] 无结果: ${content?.slice(0, 80)}`)
    } catch (err: any) {
      console.warn(`[PreSearch] 搜索失败: ${err.message}`)
    }
  }
  return null
}

/**
 * 从用户消息里提取「要搜什么」（纯函数，可单测）。
 *
 * 【为什么抽出来】这段逻辑原来内联在 `preExecuteSearch` 的循环里，
 *   只能靠**联网**才能验证，于是「查询被提取错」这类 bug 长期没被发现。
 *   实测 2026-10-13：「使命召唤23什么时候发布」被提取成 **「发布」**
 *   （主体整个丢掉）—— 抽成纯函数后可以直接断言"提取出来的查询里必须含主体"。
 *
 * 返回第一个命中的意图模式；query 为清洗后的搜索词。
 */
export function matchSearchIntent(trimmed: string): { query: string; description: string } | null {
  for (const pattern of SEARCH_INTENT_PATTERNS) {
    const match = trimmed.match(pattern.regex)
    if (!match) {continue}

    // 提取搜索查询词
    let query = (match[1] || trimmed)
      .replace(/[:：]\s*$/, '')   // 去冒号
      .replace(/[，,；;]\s*$/, '') // 去逗号
      .trim()
      .slice(0, 200)

    if (query.length < 2) {continue}

    // 🔧 2026-07-12: 清理 query 首部的"最近""今天"等时间词（防止搜索引擎把时间词当核心关键词）
    query = query.replace(/^(?:最近|今天|今日|现在|当前|眼下|这会儿|这两天|本周|本月)\s*(?:的|有|是)?\s*/i, '').trim()

    // 过滤无意义的查询词
    //   🆕 2026-10-13: 除了原来的固定词表，再补一条"纯命令"识别 ——
    //   用户只发「帮我查一下」（没有检索对象）时，会把 **「帮我查一下」本身**
    //   拿去搜索，返回一堆无关结果。这类纯命令（没有检索对象）直接不搜。
    const noise = /^(?:一下|一下吗|看看|搜一搜|搜索|查查|查一下|搜一下|帮我|帮我搜|帮我查|这个|那个|这些|那些|它|他|她|我|你|怎么|什么|为什么|谁|多少|几|哪|吗|呢|吧|啊)$/i
    const cmdOnly = /^(?:帮我|请|给我|帮忙)?\s*(?:搜|搜索|搜一下|搜一搜|查|查一下|查阅|检索|查找|找找|找一下|看一下|看看|来一下)?\s*(?:一下|一搜|一次|吗|呢|吧|啊)?$/i
    if ((noise.test(query) || cmdOnly.test(query)) && query.replace(/\s/g, '').length >= 2) {continue}

    return { query, description: pattern.description }
  }
  return null
}

/**
 * 🆕 v5.0.1: 收集预处理 — 检测 URL 或"收集"意图
 *
 * 两种触发方式：
 *   1. 用户消息直接包含 URL → 自动抓取
 *   2. 用户说"收集/汇总/爬这几个网页" → 提取 URL 后批量抓取
 *
 * 效果：抓取到的内容以 Markdown 格式注入系统消息，
 *   LLM 看到后直接总结/分析，无需调用工具。
 */

export async function preExecuteCollect(text: string): Promise<string | null> {
  // Step 1: 检测是否有明确的"收集"意图（含 URL）
  const hasCollectIntent = COLLECT_INTENT_PATTERNS.some(p => p.test(text))
  const urls = extractUrls(text)

  if (urls.length === 0) {return null}

  // Step 2: 如果有收集意图或多于 1 个 URL，执行批量收集
  if (hasCollectIntent || urls.length >= 2) {
    try {
      console.log(`[PreCollect] 检测到收集意图，${urls.length} 个 URL，执行批量抓取...`)
      const result = await collectUrls(urls, 5000, 40000)
      
      // 尝试保存到文件
      let savedPath = ''
      try { savedPath = await saveCollected(result) } catch {}
      
      const successCount = result.items.filter(i => i.success).length
      console.log(`[PreCollect] 收集完成: ${successCount}/${urls.length} 成功`)
      
      let output = result.summary
      if (savedPath) {
        output += `\n\n📁 已保存到: ${savedPath}`
      }
      return output
    } catch (err: any) {
      console.warn(`[PreCollect] 收集失败: ${err.message}`)
    }
  }

  // Step 3: 单个 URL — 直接抓取注入
  if (urls.length === 1) {
    try {
      console.log(`[PreCollect] 检测到 URL: ${urls[0]}，自动抓取...`)
      const result = await collectUrls(urls, 8000, 30000)
      if (result.items.length > 0 && result.items[0].success) {
        const item = result.items[0]
        return `📄 网页内容 (${item.charCount} 字符)\n🔗 ${item.url}\n📌 ${item.title}\n\n---\n${item.content}`
      }
    } catch (err: any) {
      console.warn(`[PreCollect] URL 抓取失败: ${err.message}`)
    }
  }

  return null
}

// ═══════════════════════════════════════════════════════════
// 🆕 FIX-2: 统一预处理 — 合并 URL 收集 + 搜索预检查
//
// 之前: sendMessage 中分别调用 preExecuteSearch 和 preExecuteCollect，
//   两次 URL 提取、两次结果注入，逻辑分散，难以统一控制。
//
// 现在: 一次调用，按"先 URL 后搜索"的顺序执行，返回统一结果对象。
//   调用方只需处理 preprocessResult 即可同时获得两种预处理结果。
// ═══════════════════════════════════════════════════════════

/**
 * 统一预处理入口：按序执行 URL 收集 → 搜索预检查，返回合并结果。
 *
 * 执行顺序保证：
 *   1. URL/收集预处理优先 — 如果用户发了 URL，先抓取内容
 *   2. 搜索预检查次之 — 再判断搜索意图并搜索
 *
 * 返回 { collectResult, searchResult }，字段为 null 表示无需/无结果。
 */
export async function preProcessMessage(text: string, opts: { skipAutoSearch?: boolean } = {}): Promise<{
  collectResult: string | null;
  searchResult: string | null;
}> {
  // Step 1: URL/收集预处理（优先级高 — 用户明确给了 URL 就先抓取）
  const collectResult = await preExecuteCollect(text)

  // Step 2: 搜索预处理（普通搜索意图检查）
  const searchResult = await preExecuteSearch(text, opts.skipAutoSearch === true)

  return { collectResult, searchResult }
}

// ═══════════════════════════════════════════════════════════
