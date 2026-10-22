// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/searchRelevance.test.ts
//
// 【要防的真实故障】2026-10-07：用户搜「美股 宏观 消息 2026年10月7日 美联储」，
//   BING 返回的第一条是「美（汉语文字）_百度百科 —— 美（拼音：měi）为汉语
//   一级通用字」。它长度 > 20、不含任何错误串，于是通过了 isValidResult()
//   的全部检查，被当成「有效结果」返回并写进缓存 —— **回退链根本没触发**。
//
// 根因：有效性判定只看「有没有内容」，从不看「和查询有没有关系」。
// 本测试锁住相关性过滤与词典条目识别。
// ============================================================

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import {
  relevanceTokens,
  countOverlap,
  isDictionaryEntry,
  intentTokens,
  shouldAutoFetchPages,
  normalizeResults,
  sanitizeQuery,
  looksLikeBinaryOrMojibake,
  isCaptchaPage,
  isChallengePage,
  parseResultBlocks,
  isEnginePage,
  extractTopLinks,
  coreSubject,
  resultsMentionSubject,
} from '../electron/tools/impl/search'

describe('isDictionaryEntry — 识别词典/百科单字条目', () => {
  it('识别「美（汉语文字）_百度百科」这类条目', () => {
    expect(isDictionaryEntry('美（汉语文字）_百度百科')).toBe(true)
  })

  it('识别「美（拼音：měi）_百度百科」', () => {
    expect(isDictionaryEntry('美（拼音：měi）_百度百科')).toBe(true)
  })

  it('识别纯单字 + 百科来源', () => {
    expect(isDictionaryEntry('好_百度百科')).toBe(true)
  })

  it('正常搜索结果不误伤', () => {
    expect(isDictionaryEntry('美股行情_新浪财经')).toBe(false)
    expect(isDictionaryEntry('美联储9月会议纪要解读 - 华尔街见闻')).toBe(false)
    expect(isDictionaryEntry('2026年10月美股宏观展望')).toBe(false)
  })
})

describe('relevanceTokens — CJK 2-gram + 字母词', () => {
  it('中文切成 2-gram', () => {
    const t = relevanceTokens('美股宏观')
    expect(t.has('美股')).toBe(true)
    expect(t.has('股宏')).toBe(true)
    expect(t.has('宏观')).toBe(true)
  })

  it('字母词保留、年份级纯数字不制造假相关', () => {
    const t = relevanceTokens('GPT 发布 2026')
    expect(t.has('gpt')).toBe(true)
    // 「2026」是 4 位数字，属于年份噪声 —— 不作为 token
    expect(t.has('2026')).toBe(false)
  })
})

describe('相关性判定 — 复现并锁住 2026-10-07 的故障', () => {
  const QUERY = '美股 宏观 消息 2026年10月7日 美联储'

  it('垃圾结果（单字词典）与查询零重叠', () => {
    const q = relevanceTokens(QUERY)
    const junk = relevanceTokens('美（汉语文字）_百度百科 美（拼音：měi）为汉语一级通用字')
    expect(countOverlap(q, junk)).toBe(0)
  })

  it('真实结果与查询有重叠', () => {
    const q = relevanceTokens(QUERY)
    const real = relevanceTokens('美股宏观消息汇总_新浪财经 美联储最新表态')
    expect(countOverlap(q, real)).toBeGreaterThan(0)
  })

  it('「美联储」这种长词即使被切成 2-gram 仍能命中', () => {
    const q = relevanceTokens('美联储降息')
    const real = relevanceTokens('美联储宣布降息 25 个基点')
    expect(countOverlap(q, real)).toBeGreaterThan(0)
  })
})

// ============================================================
// 2026-10-12 故障：搜「尼古喵喵」，返回的却是一条**字典页**
//
// 截图实证：查询被模型写成 `"尼古喵喵" 猫 梗 出处 来源`，
//   BING 返回「尼 -字典-意思-解释-拼音-注音-读音-部首-出处」(shidianguji.com)。
//   它既不是单字 + 百科后缀、也没有全角括号 → 旧的 isDictionaryEntry 全部落空；
//   而相关性检查又靠查询里的「出处」二字拿到 1 个交集 → 被判为有效结果返回。
//
// 用户的期望落差：「不是那种收集相关的网站然后再整理总结的么」
//   → 搜索该给出**相关网站的正文**，而不是把标题摘要（还带垃圾）原样摊开。
// ============================================================
describe('2026-10-12 故障：词典垃圾页漏过滤 + 该抓正文却没抓', () => {
  const QUERY = '"尼古喵喵" 猫 梗 出处 来源'
  const JUNK = {
    title: '尼 -字典-意思-解释-拼音-注音-读音-部首-出处',
    link: 'https://www.shidianguji.com/character/%E5%B0%BC',
    desc: '尼 拼音:ní 部首:尸 笔画:5 释义:尼字的意思、解释、读音、部首',
  }
  const RELEVANT = {
    title: '【官方中字】迷你尼古喵喵 第1集_哔哩哔哩_bilibili',
    link: 'https://www.bilibili.com/video/BV1xx',
    desc: '尼古喵喵 迷你动画 官方中文字幕 第1集',
  }

  it('词典页能被识别出来（原来漏掉了）', () => {
    expect(isDictionaryEntry(JUNK.title, JUNK.link)).toBe(true)
  })

  it('词典站域名也能识别', () => {
    expect(isDictionaryEntry('某某字的意思', 'https://www.shidianguji.com/character/x')).toBe(true)
    expect(isDictionaryEntry('某某', 'https://hanyu.baidu.com/zici/s?wd=x')).toBe(true)
    // 百度百科本身是正常来源，不能一刀切
    expect(isDictionaryEntry('尼古喵喵是什么 - 百度百科', 'https://baike.baidu.com/item/xxx')).toBe(false)
  })

  it('「出处/来源」这类零意图通用词不再制造假相关', () => {
    const junk = relevanceTokens(`${JUNK.title} ${JUNK.desc}`)
    // 旧口径（全量 token）：靠「出处」拿到 1 个交集 → 假命中
    expect(countOverlap(relevanceTokens(QUERY), junk)).toBeGreaterThan(0)
    // 新口径（意图 token）：0 → 正确剔除
    expect(countOverlap(intentTokens(QUERY), junk)).toBe(0)
  })

  it('真正相关的结果仍然命中', () => {
    const rel = relevanceTokens(`${RELEVANT.title} ${RELEVANT.desc}`)
    expect(countOverlap(intentTokens(QUERY), rel)).toBeGreaterThan(0)
  })

  it('normalizeResults：垃圾被剔除，相关结果保留并排第一', () => {
    const out = normalizeResults([JUNK, RELEVANT], 5, QUERY)
    expect(out).not.toContain('字典')
    expect(out).toContain('尼古喵喵')
    // 排在第一（第 1 行的标题里就有实体词）
    expect(out.split('\n')[0]).toContain('尼古喵喵')
  })

  it('全部是垃圾时返回"未找到"（让回退链去试下一个引擎）', () => {
    const out = normalizeResults([JUNK], 5, QUERY)
    expect(out).toContain('未找到')
    expect(out.length).toBeLessThan(20)   // 短 → isValidResult() 判为无效 → 触发引擎回退
  })
})

describe('intentTokens — 剔除零意图通用词', () => {
  it('通用词被剔除，实体词保留', () => {
    const t = intentTokens('尼古喵喵 是什么 出处 来源')
    expect(t.has('尼古')).toBe(true)
    expect(t.has('古喵')).toBe(true)
    expect(t.has('喵喵')).toBe(true)
    expect(t.has('出处')).toBe(false)
    expect(t.has('来源')).toBe(false)
    expect(t.has('什么')).toBe(false)
  })

  it('金融类查询的实体词不受影响', () => {
    const t = intentTokens('美股 宏观 消息 2026年10月7日 美联储')
    expect(t.has('美股')).toBe(true)
    expect(t.has('美联')).toBe(true)   // 「美联储」按 2-gram 切成 美联 / 联储
    expect(t.has('联储')).toBe(true)
  })

  it('纯通用词查询剔除后为空（调用方应放弃过滤）', () => {
    expect(intentTokens('意思 解释 拼音').size).toBeLessThan(2)
  })
})

describe('isCaptchaPage — 反爬/挑战页必须被识别（否则会被当成"网页正文"）', () => {
  it('Cloudflare「Just a moment...」挑战页', () => {
    expect(isCaptchaPage('<html><head><title>Just a moment...</title></head><body>Enable JavaScript and cookies to continue</body></html>')).toBe(true)
  })

  it('百度安全验证页', () => {
    expect(isCaptchaPage('<html><title>百度安全验证</title><body>请完成安全验证</body></html>')).toBe(true)
  })

  it('正常网页不误伤', () => {
    const page = '<html><title>尼古喵喵 | 动画 (2026)</title><body>《尼古喵喵》是一部日本TV动画，全12集。</body></html>'
    expect(isCaptchaPage(page)).toBe(false)
  })
})

describe('isChallengePage — 只看可见文本，避免误杀正常网页', () => {
  it('正常网页的 JS 里含 captcha / 429 字样 → **不误杀**（实测 B 站被误杀过）', () => {
    const page = '<html><head><script>var c="/captcha/verify"; if(code===429){}</script></head>'
      + '<body><h1>【官方中字】迷你尼古喵喵 第1集</h1><p>'
      + '这是一段正常的正文内容。'.repeat(20) + '</p></body></html>'
    expect(isChallengePage(page)).toBe(false)
  })

  it('Cloudflare 挑战页 → 识别', () => {
    expect(isChallengePage('<html><title>Just a moment...</title><body>Enable JavaScript and cookies to continue</body></html>')).toBe(true)
  })

  it('百度安全验证页 → 识别', () => {
    expect(isChallengePage('<html><title>百度安全验证</title><body>请完成安全验证</body></html>')).toBe(true)
  })

  it('长页面里出现「验证」字样 → 不误杀（挑战页都很短）', () => {
    const long = '<html><body><p>请完成安全验证</p>' + '正文内容。'.repeat(500) + '</body></html>'
    expect(isChallengePage(long)).toBe(false)
  })
})

describe('looksLikeBinaryOrMojibake — 乱码绝不进模型上下文', () => {
  it('实测的乱码样本被判为垃圾', () => {
    const mojibake = '📄 ****\n�y��6���S�6T�K�L-)���R�����2�34���LU���Z�l��c���Yl���'
    expect(looksLikeBinaryOrMojibake(mojibake)).toBe(true)
  })

  it('UTF-8 被当 Latin-1 解出的乱码也被识别', () => {
    expect(looksLikeBinaryOrMojibake('ä¸æ–‡æµ‹è¯•å†…å®¹ä¸æ–‡æµ‹è¯•å†…å®¹')).toBe(true)
  })

  it('正常中文正文不误伤', () => {
    const good = '《尼古喵喵》（日文原名：ヤニねこ；英文：YaniNeko）是日本TV动画，全12集，'
      + '改编自にゃんにゃんファクトリー创作的同名漫画作品。该作最初在 Twitter 上投稿，后因好评而动画化。'
    expect(looksLikeBinaryOrMojibake(good)).toBe(false)
  })

  it('正常英文正文不误伤', () => {
    expect(looksLikeBinaryOrMojibake('This is a normal English paragraph about the anime YaniNeko, released in 2026 with 12 episodes.')).toBe(false)
  })

  it('空文本 / 过短文本判为不可用', () => {
    expect(looksLikeBinaryOrMojibake('')).toBe(true)
    expect(looksLikeBinaryOrMojibake('abc')).toBe(true)
  })
})

describe('deep_research 必须用真实搜索栈（别退回那个不可达的 DDG 即时答案 API）', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'electron', 'deepResearch.ts'), 'utf-8')
  // 只看代码，不看注释（注释里会引用这条历史域名说明教训）
  const code = src
    .split('\n')
    .filter(l => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*') })
    .join('\n')

  it('不再打 api.duckduckgo.com（实测三个查询全部超时 → 整个调研流水线恒产出空报告）', () => {
    expect(code).not.toContain('api.duckduckgo.com')
  })

  it('改用项目内已验证的搜索栈 + 单页正文抓取', () => {
    expect(code).toContain('searchStructured')
    expect(code).toContain('fetchReadablePage')
  })
})

describe('extractTopLinks / isEnginePage — 百度结果链接必须能被抓取', () => {
  it('只排除引擎自己的搜索页，不排除整个域名', () => {
    expect(isEnginePage('https://cn.bing.com/search?q=x')).toBe(true)
    expect(isEnginePage('https://www.baidu.com/s?wd=x')).toBe(true)
    expect(isEnginePage('https://www.google.com/search?q=x')).toBe(true)
    // 正常站点、以及百度的结果跳转链接都必须放行
    expect(isEnginePage('https://www.bilibili.com/video/BV1x')).toBe(false)
    expect(isEnginePage('https://www.baidu.com/link?url=abc')).toBe(false)
    expect(isEnginePage('https://baike.baidu.com/item/xxx')).toBe(false)
  })

  it('百度结果跳转链接会被提取（旧实现把整个 baidu.com 排除了 → 候选恒为 0）', () => {
    const results = [
      '1. 某标题',
      '   https://www.baidu.com/link?url=AAA',
      '   摘要',
      '',
      '2. 另一个',
      '   https://baike.baidu.com/item/%E5%B0%BC',
      '   摘要',
    ].join('\n')
    const links = extractTopLinks(results, 6)
    expect(links).toContain('https://www.baidu.com/link?url=AAA')
    expect(links).toContain('https://baike.baidu.com/item/%E5%B0%BC')
  })

  it('引擎搜索页本身不会被当成候选（避免抓回结果页自己）', () => {
    const results = '1. x\n   https://cn.bing.com/search?q=x\n   摘要'
    expect(extractTopLinks(results, 6)).toEqual([])
  })

  it('去重 + 上限生效', () => {
    const results = ['a', 'https://a.com/1', 'https://a.com/1', 'https://a.com/2', 'https://a.com/3'].join('\n')
    expect(extractTopLinks(results, 2)).toEqual(['https://a.com/1', 'https://a.com/2'])
  })
})

describe('coreSubject / 主体短语加权 — 多轮追问与重排的基础', () => {
  it('取最长的中日韩连续串作为主体', () => {
    expect(coreSubject('尼古喵喵 动画')).toBe('尼古喵喵')
    expect(coreSubject('美股 宏观 消息')).toBe('美股')
    // 只有单个两字串时也认（英文查询里的中文限定词）
    expect(coreSubject('GPT 发布')).toBe('发布')
    expect(coreSubject('openai gpt-5')).toBe('')
  })

  it('判断结果里有没有出现主体（用于识别"引擎把词拆错了"）', () => {
    const junk = '1. 尼（汉语文字）_百度百科\n   尼的拼音、部首'
    const real = '1. 尼古喵喵 | 动画 (2026) | Anibase.Net'
    expect(resultsMentionSubject(junk, '尼古喵喵')).toBe(false)
    expect(resultsMentionSubject(real, '尼古喵喵')).toBe(true)
    // 没有主体时不判（返回 true，不触发追问）
    expect(resultsMentionSubject(junk, '')).toBe(true)
  })

  it('重排：含完整主体的结果排在不含主体但碎片命中的结果之前', () => {
    const q = '尼古喵喵 动画'
    // ① 碎片命中多（尼古/古喵/喵喵 都出现在无关段落里），但没有完整主体
    const fragmented = {
      title: '尼姑与古喵喵的喵喵叫研究',
      link: 'https://a.com/1',
      desc: '尼古拉斯 古喵 喵喵 动画',
    }
    // ② 完整主体命中
    const exact = {
      title: '尼古喵喵 | 动画 (2026) | Anibase.Net',
      link: 'https://b.com/2',
      desc: '《尼古喵喵》是日本 TV 动画',
    }
    const out = normalizeResults([fragmented, exact], 5, q)
    expect(out.split('\n')[0]).toContain('Anibase')
  })
})

describe('parseResultBlocks — 把结果文本解析回结构化（供 deep_research 复用）', () => {
  it('解析标题 / 链接 / 摘要', () => {
    const sample = '1. 标题A\n   https://a.com/x\n   摘要A\n\n2. 标题B\n   https://b.com/y\n   摘要B'
    expect(parseResultBlocks(sample)).toEqual([
      { title: '标题A', link: 'https://a.com/x', desc: '摘要A' },
      { title: '标题B', link: 'https://b.com/y', desc: '摘要B' },
    ])
  })

  it('忽略没有链接的块（如"网页正文"段、失败提示）', () => {
    const text = '🔍 BING 搜索: "x"\n\n1. 标题A\n   https://a.com/x\n   摘要A\n\n'
      + '━━━ 网页正文（AI 抓取）━━━\n\n📄 **某页**\n正文内容'
    const out = parseResultBlocks(text)
    expect(out).toHaveLength(1)
    expect(out[0].link).toBe('https://a.com/x')
  })

  it('空文本 / 纯提示文本 → 空数组', () => {
    expect(parseResultBlocks('')).toEqual([])
    expect(parseResultBlocks('（未找到与查询相关的有效结果）')).toEqual([])
    expect(parseResultBlocks('⚠️ 搜索 "x" 在所有引擎均失败')).toEqual([])
  })
})

describe('sanitizeQuery — 摘掉会让分词退化的通用疑问词', () => {
  it('「XX 是什么」→ 只留实体词（实测：加「是什么」会搜出一堆字典页）', () => {
    expect(sanitizeQuery('尼古喵喵 是什么')).toBe('尼古喵喵')
    expect(sanitizeQuery('尼古喵喵是什么')).toBe('尼古喵喵')
  })

  it('「梗 / 出处 / 来源」这类填充词同样摘掉', () => {
    expect(sanitizeQuery('"尼古喵喵" 猫 梗 出处 来源')).toBe('"尼古喵喵" 猫')
  })

  it('具体限定词必须保留（它们才是有效检索词）', () => {
    expect(sanitizeQuery('尼古喵喵 动画')).toBe('尼古喵喵 动画')
    expect(sanitizeQuery('美股 宏观 消息 美联储')).toBe('美股 宏观 消息 美联储')
  })

  it('疑问句摘词后仍可检索', () => {
    expect(sanitizeQuery('什么是量子纠缠')).toBe('量子纠缠')
    expect(sanitizeQuery('怎么用 Git rebase')).toBe('用 Git rebase')
  })

  it('查询本身就是疑问词时原样保留（不能抹空）', () => {
    expect(sanitizeQuery('是什么')).toBe('是什么')
    expect(sanitizeQuery('怎么办')).toBe('怎么办')
    expect(sanitizeQuery('')).toBe('')
  })

  it('去掉标点与多余空格', () => {
    expect(sanitizeQuery('尼古喵喵？？')).toBe('尼古喵喵')
  })
})

describe('shouldAutoFetchPages — 信息型问题自动抓正文', () => {
  const validContent = '1. 标题一\n   https://a.com\n   摘要一\n\n2. 标题二\n   https://b.com\n   摘要二'

  it('信息型问题 → 自动抓（答案在正文里，标题摘要给不出来）', () => {
    expect(shouldAutoFetchPages('尼古喵喵是什么', validContent)).toBe(true)
    expect(shouldAutoFetchPages('尼古喵喵 猫 梗 出处 来源', validContent)).toBe(true)
    expect(shouldAutoFetchPages('这个梗的由来是什么', validContent)).toBe(true)
  })

  it('有效结果不足 3 条 → 自动抓（材料不够）', () => {
    expect(shouldAutoFetchPages('A股最新行情', validContent)).toBe(true)
  })

  it('结果充足且非信息型 → 不抓（省时间）', () => {
    const rich = '1. a\n   https://a.com\n   x\n\n2. b\n   https://b.com\n   x\n\n3. c\n   https://c.com\n   x'
    expect(shouldAutoFetchPages('A股最新行情', rich)).toBe(false)
  })

  it('无有效结果时不抓（没有可抓的链接）', () => {
    expect(shouldAutoFetchPages('尼古喵喵是什么', '（未找到与查询相关的有效结果）')).toBe(false)
    expect(shouldAutoFetchPages('尼古喵喵是什么', '')).toBe(false)
  })
})
