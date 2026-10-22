// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// impl/newsEnricher.ts — 新闻背景补充引擎 (v1.0)
//
// 为筛选后的每篇新闻补充：
//   1. 社区讨论摘要（HN 评论提炼）
//   2. 背景信息（来龙去脉，使用项目已有的 webSearch 工具）
//   3. 英文关键词（双语模式用）
//
// 异步执行，不阻塞推送流程。
// ============================================================

import type { FilteredItem } from './newsFilter'
import { webSearch } from './search'

// ═══════════════════════════════════════════════════════════
// 工具函数：简化的内存缓存，避免同次推送重复请求
// ═══════════════════════════════════════════════════════════

const bgCache = new Map<string, string>()
function bgCacheKey(title: string): string {
  return title.replace(/\s+/g, '').toLowerCase().slice(0, 40)
}

// ═══════════════════════════════════════════════════════════
// 社区摘要
// ═══════════════════════════════════════════════════════════

/**
 * 如果新闻条目本身自带社区评论（_commentContent），
 * 直接从中提取高频观点作为 communitySummary；
 * 否则置空（后续可扩展为用 LLM 从 HN/Reddit API 拉取）。
 */
function inferCommunitySummary(item: FilteredItem): string | undefined {
  const raw = item.item._commentContent
  if (!raw) {return undefined}

  // 截取前 3 条评论中较短的表达
  const lines = raw.split('\n').filter(Boolean).slice(0, 3)
  if (lines.length === 0) {return undefined}

  // 简单的摘要：提取每条评论的前 80 字
  const snippets = lines.map(l => {
    const match = l.match(/\[([^\]]+)\]:\s*(.+)/)
    if (match) {return `${match[1]}: ${match[2].slice(0, 80)}`}
    return l.slice(0, 100)
  })

  return snippets.join(' | ')
}

// ═══════════════════════════════════════════════════════════
// 背景信息补充（搜索引擎兜底）
// ═══════════════════════════════════════════════════════════

/**
 * 对一条新闻执行简单网页搜索获取背景。
 * 使用当前环境已有的 webSearch 能力（通过动态 import 避免循环依赖）。
 *
 * 这里采用最轻量的方式：直接使用 httpClient 搜索 HT-News 站点，
 * 或者使用已有的 search.ts 中的 webSearch。
 *
 * 注意：enrichItemsBackground 在调度器中异步调用，
 * 不会阻塞推送流程。
 */
async function enrichOne(item: FilteredItem): Promise<void> {
  const title = item.item.title
  const key = bgCacheKey(title)
  if (bgCache.has(key)) {
    // 同一批中同名新闻共享结果
    const cached = bgCache.get(key)
    if (cached) {item.background = cached}
    return
  }

  // 如果是 HN 来源且本身已带背景（story.text），直接使用
  if (item.item._hnMeta && item.item.content) {
    const content = item.item.content
    // 取正文前 300 字作为背景（去掉评论部分）
    const mainBody = content.split('--- 社区评论')[0].trim()
    if (mainBody.length > 50) {
      item.background = mainBody.slice(0, 400)
      bgCache.set(key, item.background)
      return
    }
  }

  // 尝试使用项目中已有的搜索工具
  try {
    // 先用标题生成背景摘要 —— 通过 LLM 在筛选阶段已带 digest
    // 所以这里只做简短补充
    // 如果 digest 够长就不用额外搜索了
    if (item.digest.length > 100) {
      bgCache.set(key, '') // 标记已处理
      return
    }

    // 项目已有 webSearch，尝试获取背景
    // 但为了避免慢速请求阻塞，这里只做轻量尝试
    // 具体实现取决于 search.ts 是否可用
    try {
      const result = await webSearch({ query: title, count: 2, engine: 'bing' })
      if (result && result.content) {
        // 取搜索结果的前 400 字
        const snippet = result.content.replace(/<[^>]+>/g, '').trim().slice(0, 400)
        if (snippet.length > 50) {
          item.background = snippet
          bgCache.set(key, snippet)
          return
        }
      }
    } catch {
      // search.ts 可能不可用（import 失败或函数不支持）
      // 静默跳过
    }

    bgCache.set(key, '')
  } catch {
    // 完全降级
  }
}

// ═══════════════════════════════════════════════════════════
// 英文关键词
// ═══════════════════════════════════════════════════════════

/**
 * 简单英文关键词提取：从标题中提取英文词汇。
 * 可扩展为用 LLM 提取。
 */
function extractEnglishKeywords(title: string): string | undefined {
  // 提取标题中所有 >=3 字母的英文词
  const words = title.match(/\b[a-zA-Z]{3,}\b/g)
  if (!words || words.length === 0) {return undefined}
  // 去重取前 6 个
  return [...new Set(words.map(w => w.toLowerCase()))].slice(0, 6).join(', ')
}

// ═══════════════════════════════════════════════════════════
// 主入口
// ═══════════════════════════════════════════════════════════

/**
 * 对筛选后的新闻条目进行背景信息补充。
 * - communitySummary：优先从 _commentContent 提取
 * - background：优先用已有正文，其次搜索引擎兜底
 * - enKeywords：标题自动提取
 *
 * @param filtered  筛选后的新闻列表（会被原地修改）
 * @param interests 用户兴趣（预留，可用于引导搜索方向）
 */
export async function enrichItemsBackground(
  filtered: FilteredItem[],
  interests?: string,
): Promise<void> {
  if (filtered.length === 0) {return}

  console.log(`[NewsEnricher] 🔍 开始补充 ${filtered.length} 条新闻背景...`)

  let enrichedCount = 0
  let communityCount = 0

  for (const item of filtered) {
    // 1. 社区讨论摘要
    if (!item.communitySummary) {
      const cs = inferCommunitySummary(item)
      if (cs) {
        item.communitySummary = cs
        communityCount++
      }
    }

    // 2. 背景补充
    if (!item.background) {
      await enrichOne(item)
      if (item.background) {enrichedCount++}
    }

    // 3. 英文关键词（双语模式用）
    if (!item.enKeywords) {
      const ek = extractEnglishKeywords(item.item.title)
      if (ek) {item.enKeywords = ek}
    }
  }

  console.log(`[NewsEnricher] ✅ 完成: communitySummary=${communityCount} background=${enrichedCount}`)
}
