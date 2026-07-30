// ============================================================
// impl/newsFilter.ts — 新闻智能筛选器 (v1.0)
//
// 通过 LLM 对收集到的新闻进行：
//   1. 相关性打分（0-100）
//   2. 自动分类打标签
//   3. 多级摘要（一句话 / 三段 / 详细）
//
// 设计上不直接依赖 LLM 实现，由调用方传入 LLM 调用函数。
// ============================================================

import type { NewsItem, NewsCategory } from './newsCollector'

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

export interface FilteredItem {
  /** 原始新闻条目 */
  item: NewsItem
  /** LLM 给出的相关性评分 (0-100) */
  relevanceScore: number
  /** 精选理由 */
  reason: string
  /** 一句话摘要（用于邮件列表） */
  oneLiner: string
  /** 详细摘要（3-5 句） */
  digest: string
  /** LLM 打的关键词标签 */
  tags: string[]
  /** 社区讨论摘要（HN/Reddit 热评提炼，由 enrichment 补充） */
  communitySummary?: string
  /** 背景信息补充（来龙去脉，由 enrichment 补充） */
  background?: string
  /** 英文关键词（双语模式用） */
  enKeywords?: string
}

export type LLMCallFn = (systemPrompt: string, userContent: string) => Promise<string>

export interface FilterOptions {
  /** 用户兴趣描述（如 "关注 AI、前端开发、投资理财"） */
  interests?: string
  /** 最多保留条数 */
  maxItems?: number
  /** 最低相关性阈值（0-100） */
  minScore?: number
}

// ═══════════════════════════════════════════════════════════
// 默认兴趣配置（从用户数据目录读取，可覆盖）
// ═══════════════════════════════════════════════════════════

export const DEFAULT_INTERESTS = 'AI大模型、半导体、新能源、美股、A股、GitHub热门'

// ═══════════════════════════════════════════════════════════
// Prompt 模板
// ═══════════════════════════════════════════════════════════

function buildFilterPrompt(items: NewsItem[], interests: string): string {
  const itemsText = items.map((item, idx) => {
    let extra = ''
    // 如果含社区评论，附带前 2 条以便 LLM 判断讨论热度
    if (item._commentContent) {
      const commentSnippet = item._commentContent.split('\n').slice(0, 2).join('   \n')
      extra += `\n社区热评:\n  ${commentSnippet}`
    }
    return `[${idx + 1}]
标题: ${item.title}
来源: ${item.source}
分类: ${item.category}
摘要: ${item.summary.slice(0, 200)}${extra}
`
  }).join('\n---\n')

  return `# 任务：新闻相关性筛选

你是一个智能新闻筛选助手。用户关注以下领域：**${interests}**

请对以下 ${items.length} 条新闻逐条评估，返回 JSON 数组。

## 评估标准
- **相关性**（0-100）：与用户兴趣领域的匹配程度
- **时效性**：越新越好
- **信息量**：有实质内容的优先
- **独家性**：非泛泛而谈的优先

## 输出格式（纯 JSON 数组，不要 markdown 包裹）
[
  {
    "index": 1,
    "relevanceScore": 85,
    "reason": "与用户关心的 AI 领域直接相关",
    "oneLiner": "一句话核心摘要（15字以内）",
    "tags": ["AI", "大模型"]
  },
  ...
]

## 待评估新闻
${itemsText}`
}

function buildDigestPrompt(items: FilteredItem[]): string {
  const itemsText = items.map((item, idx) => {
    return `[${idx + 1}] ${item.item.title}
   来源: ${item.item.source}
   摘要: ${item.item.summary.slice(0, 150)}
   标签: ${item.tags.join(', ')}`
  }).join('\n')

  return `# 任务：生成新闻摘要

为用户生成一份简洁的新闻摘要。用户兴趣：科技、效率工具、开源。

要求：
1. 每条新闻用 **1-2 句话**概括核心信息
2. 按重要性排序
3. 每条标注来源
4. 末尾加一段 "🔥 今日热议"（挑出最重要的 1-2 条说明为什么值得关注）
5. 总字数控制在 500 字以内

## 新闻列表
${itemsText}`
}

// ═══════════════════════════════════════════════════════════
// JSON 解析（兼容 LLM 可能的格式问题）
// ═══════════════════════════════════════════════════════════

function parseLLMJson(raw: string): any[] {
  // 去掉可能的 markdown 代码块标记
  let cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*$/gi, '').trim()

  // 尝试直接解析
  try {
    const parsed = JSON.parse(cleaned)
    if (Array.isArray(parsed)) return parsed
    // 可能包裹在对象中
    if (parsed.items && Array.isArray(parsed.items)) return parsed.items
    if (parsed.results && Array.isArray(parsed.results)) return parsed.results
    return []
  } catch {
    // 尝试提取 JSON 数组部分
    const arrMatch = cleaned.match(/\[[\s\S]*\]/)
    if (arrMatch) {
      try {
        return JSON.parse(arrMatch[0])
      } catch {
        return []
      }
    }
    return []
  }
}

// ═══════════════════════════════════════════════════════════
// 核心函数
// ═══════════════════════════════════════════════════════════

/**
 * 使用 LLM 对新闻进行智能筛选
 *
 * @param items     原始新闻列表
 * @param llmCall   LLM 调用函数：传入 prompt 返回回复文本
 * @param options   筛选选项
 * @returns         按相关性降序排列的筛选结果
 */
export async function filterWithLLM(
  items: NewsItem[],
  llmCall: LLMCallFn,
  options?: FilterOptions,
): Promise<FilteredItem[]> {
  const {
    interests = DEFAULT_INTERESTS,
    minScore = 30,
  } = options || {}

  if (items.length === 0) return []

  // 如果条目太多，先做一轮预筛选（保留热度分 Top 50）
  const toFilter = items.length > 50
    ? items.sort((a, b) => b.hotScore - a.hotScore).slice(0, 50)
    : items

  const systemPrompt = '你是一个专业的新闻筛选助手。请严格按用户要求的 JSON 格式输出，不要添加额外说明。'
  const userPrompt = buildFilterPrompt(toFilter, interests)

  try {
    const response = await llmCall(systemPrompt, userPrompt)
    const results = parseLLMJson(response)

    if (results.length === 0) {
      console.warn('[NewsFilter] LLM 返回空结果，使用热度分降级')
      return fallbackFilter(toFilter, minScore)
    }

    const filtered: FilteredItem[] = []

    for (const r of results) {
      const idx = r.index - 1
      if (idx < 0 || idx >= toFilter.length) continue
      if ((r.relevanceScore ?? 0) < minScore) continue

      filtered.push({
        item: toFilter[idx],
        relevanceScore: r.relevanceScore,
        reason: r.reason || '',
        oneLiner: r.oneLiner || toFilter[idx].summary.slice(0, 50),
        digest: r.digest || toFilter[idx].summary,
        tags: Array.isArray(r.tags) ? r.tags : [],
      })
    }

    // 按相关性降序
    filtered.sort((a, b) => b.relevanceScore - a.relevanceScore)

    const maxItems = options?.maxItems || 15
    console.log(`[NewsFilter] LLM 筛选: ${items.length} → ${filtered.length} 条（限制 ${maxItems}）`)
    return filtered.slice(0, maxItems)
  } catch (err: any) {
    console.warn('[NewsFilter] LLM 调用失败，使用热度分降级:', err.message)
    return fallbackFilter(toFilter, minScore)
  }
}

/**
 * 降级方案：按热度分 + 来源优先级排序
 */
function fallbackFilter(items: NewsItem[], minScore: number): FilteredItem[] {
  const sourcePriority: Record<string, number> = {
    '知乎热榜': 10,
    'GitHub Trending': 9,
    '36氪': 8,
    '新浪财经': 7,
    '少数派': 6,
    '极客公园': 6,
    '阮一峰的网络日志': 5,
  }

  const scored = items.map(item => ({
    item,
    score: (sourcePriority[item.source] || 5) * 10 + item.hotScore,
  }))

  scored.sort((a, b) => b.score - a.score)

  return scored
    .filter(s => s.score >= minScore)
    .slice(0, 15)
    .map(s => ({
      item: s.item,
      relevanceScore: Math.round(s.score / 2),
      reason: '',
      oneLiner: s.item.summary.slice(0, 50),
      digest: s.item.summary,
      tags: [s.item.category],
    }))
}

/**
 * 使用 LLM 生成最终摘要文本（用于邮件正文）
 *
 * @param filtered  已筛选的新闻列表
 * @param llmCall   LLM 调用函数
 * @returns         格式化的 Markdown 摘要文本
 */
export async function generateDigestText(
  filtered: FilteredItem[],
  llmCall: LLMCallFn,
): Promise<string> {
  if (filtered.length === 0) {
    return '📭 今日没有筛选出值得关注的新闻。'
  }

  const systemPrompt = '你是一个优秀的新闻编辑，擅长将信息浓缩为易读的摘要。请用中文回复。'
  const userPrompt = buildDigestPrompt(filtered)

  try {
    const response = await llmCall(systemPrompt, userPrompt)
    return response
  } catch (err: any) {
    console.warn('[NewsFilter] 摘要生成失败，使用模板:', err.message)
    return fallbackDigest(filtered)
  }
}

/**
 * 降级摘要模板
 */
function fallbackDigest(filtered: FilteredItem[]): string {
  const lines = filtered.map((f, i) => {
    const emoji = f.item.category === 'tech' ? '💻' : f.item.category === 'finance' ? '💰' : f.item.category === 'oss' ? '🔧' : '📰'
    return `${emoji} **${f.item.title}**\n   ${f.item.summary.slice(0, 120)}\n   📎 ${f.item.url}`
  })

  return `📡 **Lumina 新闻早报** — ${new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })}

为你精选 ${filtered.length} 条值得关注的新闻：

${lines.join('\n\n')}

---
🔄 去设置中调整你的兴趣偏好
`
}

// ═══════════════════════════════════════════════════════════
// LLM 语义去重 (v2.0「雷达」升级)
// ═══════════════════════════════════════════════════════════

/**
 * 使用 LLM 对新闻进行语义级别的智能去重。
 *
 * 工作流程：
 *   1. 第一轮：URL 指纹去重（已在 newsDigest.ts 完成）
 *   2. 第二轮：热度分排序，取 Top N
 *   3. 第三轮（本函数）：把 Top N 的标题+摘要打包给 LLM
 *   4. LLM 返回哪些条目说的是同一件事，只保留热度最高的那一条
 *
 * @param items     已指纹去重+热度排序后的新闻
 * @param llmCall   LLM 调用函数
 * @param topN      取热度前多少条做语义去重（默认 40）
 * @param maxGroups 最多保留多少组独立新闻（默认 20）
 * @returns         去重后的新闻（每组只保留热度最高的那条）
 */
export async function dedupWithLLM(
  items: NewsItem[],
  llmCall: LLMCallFn,
  topN = 40,
  maxGroups = 20,
): Promise<NewsItem[]> {
  if (items.length <= 10) {
    // 条目太少，不需要语义去重
    return items
  }

  // 先按热度分降序排列，取 Top N
  const candidates = [...items].sort((a, b) => b.hotScore - a.hotScore).slice(0, topN)

  // 构建 LLM prompt
  const itemsText = candidates.map((item, idx) =>
    `[${idx + 1}]
标题: ${item.title}
来源: ${item.source}
摘要: ${item.summary.slice(0, 150)}
热度: ${item.hotScore}`,
  ).join('\n\n---\n\n')

  const systemPrompt = '你是一个专业的新闻去重助手。请严格按 JSON 数组格式输出，不要添加额外说明。'
  const userPrompt = `# 任务：新闻语义去重

以下是一批来自不同源的热门新闻，请你判断哪些条目报道的是**同一件事**或**高度相关的同一话题**。

## 要求
1. 每组只保留 1 条（推荐保留热度最高的那条）
2. 同一事件跨源报道的，只保留热度最高的一条
3. 不是同一事件的条目各自独立保留
4. 用语义判断，不只看标题关键词相同——要判断"说的是不是同一件事"

## 输出格式（纯 JSON 数组，每个元素是一个保留的 index）
[3, 7, 12, ...]

解释：返回的数组中每个数字代表要**保留**的条目的序号（1-based）。
同一事件的多个条目中，只保留热度最高的那个序号。

举例：如果条目 2 和条目 8 都是关于"苹果发布新 iPhone"的不同报道，
且条目 2 热度更高，则保留 2，不保留 8。

## 待处理新闻
${itemsText}

## 输出`
  try {
    const response = await llmCall(systemPrompt, userPrompt)
    // 解析 JSON 数组
    let cleaned = response.replace(/```json\s*/gi, '').replace(/```\s*$/gi, '').trim()
    let indices: number[]
    try {
      indices = JSON.parse(cleaned)
    } catch {
      // 尝试提取数组
      const arrMatch = cleaned.match(/\[[\s\S]*?\]/)
      if (arrMatch) {
        try { indices = JSON.parse(arrMatch[0]) } catch { indices = [] }
      } else {
        indices = []
      }
    }

    if (!Array.isArray(indices) || indices.length === 0) {
      console.warn('[NewsFilter] LLM 语义去重返回空，跳过语义去重')
      return items
    }

    // 转 0-based 并去重
    const keepIndices = new Set(indices.map(i => Math.max(0, i - 1)).filter(i => i < candidates.length))
    const keepSet = new Set(keepIndices)

    // 合并：先取出被保留的热门条目，再加入未被评估的低热度条目
    const kept = candidates.filter((_, idx) => keepSet.has(idx))
    const rest = items.filter(item => !candidates.includes(item))

    const merged = [...kept, ...rest]
    console.log(`[NewsFilter] LLM 语义去重: ${items.length} → ${merged.length} 条 (减少了 ${items.length - merged.length})`)
    return merged
  } catch (err: any) {
    console.warn('[NewsFilter] LLM 语义去重失败，保留全部:', err.message)
    return items
  }
}
