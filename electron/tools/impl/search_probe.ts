// ============================================================
// impl/search_probe.ts — 搜索引擎探测脚本 (调试用)
//
// 🔐 使用统一 HTTP 客户端，SSL 验证默认开启
// ============================================================

import { httpGetText } from '../utils/httpClient'

(async () => {
  const url = 'https://www.bing.com/search?q=A%E8%82%A1+%E6%9C%80%E8%BF%91+%E7%83%9F%E5%BC%8F+%E5%B0%8F%E9%97%AE&setmkt=zh-CN'
  const html = await httpGetText(url, {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  })

  // 只检查关键统计量，不打印大段 HTML
  const algoCount = (html.match(/<li class="b_algo"/g) || []).length
  const anyAlgo = /<li[^>]*class="[^"]*b_algo[^"]*"/.test(html) ? 1 : 0
  console.log('htmlBytes', html.length)
  console.log('b_algoCount', algoCount)
  console.log('anyAlgo', anyAlgo)

  const titleMatches = [...html.matchAll(/<h2>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)]
  console.log('titleLinkMatches', titleMatches.length)
  if (titleMatches[0]) {
    console.log('firstTitleLink', titleMatches[0][1])
    console.log('firstTitleText', titleMatches[0][2].replace(/<[^>]+>/g, '').slice(0, 80))
  }
})().catch(e => console.error(e))
