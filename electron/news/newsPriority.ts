// ============================================================
// newsPriority.ts — 新闻分级：哪条值得弹系统通知（纯函数）
//
// 分级策略是「改造 2」的核心：**不是每条新闻都弹窗**。
// 只有满足下列任一条件的内容才升级为高优先级：
//   1. 相关性评分超过阈值（用户明确配置）
//   2. 命中用户订阅话题关键词（从 interests 切词）
//   3. 重大新闻分类 + 热度达标（默认 finance/trending 里的突发）
//
// 其余一律 'normal' —— 保持「仅桌宠气泡 + 侧边栏」的克制行为。
// ============================================================

import type { FilteredItem } from '../tools/impl/newsFilter'
import type { NotifyPriority } from '../proactive/notificationPolicy'

export interface PriorityOptions {
  /** 相关性评分阈值，超过即视为高优先级 */
  scoreThreshold: number
  /** 重大新闻分类 */
  majorCategories: string[]
  /** 重大新闻分类下的热度阈值 */
  majorHotScore: number
  /** 订阅话题关键词（已切好词）；为空则不按话题判定 */
  keywords: string[]
}

export const DEFAULT_PRIORITY_OPTIONS: PriorityOptions = {
  scoreThreshold: 85,
  majorCategories: ['finance', 'trending'],
  majorHotScore: 90,
  keywords: [],
}

export interface PriorityVerdict {
  priority: NotifyPriority
  /** 命中的理由（可多条），用于日志与调试 */
  reasons: string[]
}

/**
 * 把 interests 字符串切成关键词。
 * 默认值形如 'AI大模型发布与更新、AI编程工具、半导体芯片…'
 * 按中英文标点 + 空白切分，丢掉单字符噪声。
 */
export function splitInterests(interests: string | undefined | null): string[] {
  if (!interests) {return []}
  return Array.from(
    new Set(
      interests
        .split(/[、，,;；/|\s]+/)
        .map(s => s.trim())
        .filter(s => s.length >= 2),
    ),
  )
}

/** 判断某段文本是否命中任一关键词（英文大小写不敏感） */
export function matchesKeywords(text: string, keywords: string[]): string[] {
  if (!text || keywords.length === 0) {return []}
  const hay = text.toLowerCase()
  return keywords.filter(k => hay.includes(k.toLowerCase()))
}

/**
 * 对单条新闻分级。
 *
 * 注意：这里刻意 **不** 把「热度高」单独当作高优先级条件——
 * 热榜第一名不等于用户关心。热度只在重大分类下作为辅助条件。
 */
export function classifyNewsPriority(
  item: FilteredItem,
  interests: string | undefined | null,
  options: Partial<PriorityOptions> = {},
): PriorityVerdict {
  const opts: PriorityOptions = { ...DEFAULT_PRIORITY_OPTIONS, ...options }
  const keywords = opts.keywords.length > 0 ? opts.keywords : splitInterests(interests)
  const reasons: string[] = []

  const source = item.item
  const corpus = [
    source.title, source.summary, item.oneLiner, item.digest,
    (item.tags || []).join(' '),
  ].filter(Boolean).join(' \n ')

  // 规则 1：相关性评分
  if (item.relevanceScore >= opts.scoreThreshold) {
    reasons.push(`相关性 ${Math.round(item.relevanceScore)} ≥ ${opts.scoreThreshold}`)
  }

  // 规则 2：命中订阅话题
  const hits = matchesKeywords(corpus, keywords)
  if (hits.length > 0) {
    reasons.push(`命中订阅话题：${hits.slice(0, 3).join('/')}`)
  }

  // 规则 3：重大分类 + 热度
  if (opts.majorCategories.includes(source.category) && source.hotScore >= opts.majorHotScore) {
    reasons.push(`重大分类 ${source.category} 且热度 ${source.hotScore} ≥ ${opts.majorHotScore}`)
  }

  return {
    priority: reasons.length > 0 ? 'high' : 'normal',
    reasons,
  }
}

/**
 * 汇总一批新闻：返回 { high, normal } 两个桶 + 每条的分级理由。
 * 用于「同批只弹一条系统通知」的分级决策。
 */
export function classifyBatch(
  items: FilteredItem[],
  interests: string | undefined | null,
  options: Partial<PriorityOptions> = {},
): {
  high: Array<{ item: FilteredItem; reasons: string[] }>
  normal: Array<{ item: FilteredItem; reasons: string[] }>
  verdicts: Map<string, PriorityVerdict>
} {
  const high: Array<{ item: FilteredItem; reasons: string[] }> = []
  const normal: Array<{ item: FilteredItem; reasons: string[] }> = []
  const verdicts = new Map<string, PriorityVerdict>()

  for (const item of items) {
    const verdict = classifyNewsPriority(item, interests, options)
    verdicts.set(item.item.id, verdict)
    const entry = { item, reasons: verdict.reasons }
    if (verdict.priority === 'high') {high.push(entry)}
    else {normal.push(entry)}
  }

  return { high, normal, verdicts }
}
