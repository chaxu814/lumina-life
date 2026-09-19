// ============================================================
// impl/newsCollectorHn.ts — Hacker News 采集器 (v1.0)
//
// 从 Firebase API 拉取 Hacker News Top Stories，
// 连带社区热门评论一起采集。
// 参考：Horizon src/scrapers/hackernews.py
// ============================================================

import { httpGet } from '../utils/httpClient'
import { makeId, makeFingerprint, type NewsItem, type NewsCategory } from './newsCollector'

// ═══════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════

const HN_API = 'https://hacker-news.firebaseio.com/v0'
const TOP_COMMENTS_LIMIT = 5
const MIN_SCORE = 80
const FETCH_TOP_N = 30

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

interface HnStory {
  id: number
  title: string
  url?: string
  by: string
  score: number
  descendants: number
  time: number
  text?: string
  kids?: number[]
}

interface HnComment {
  id: number
  by: string
  text: string
  time: number
  deleted?: boolean
  dead?: boolean
}

/** Hacker News 专有元数据（附加到 NewsItem） */
export interface HnMeta {
  discussionUrl: string
  commentCount: number
  descendants: number
  by: string
  score: number
}

// ═══════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

// ═══════════════════════════════════════════════════════════
// 核心采集
// ═══════════════════════════════════════════════════════════

async function fetchItem<T>(id: number): Promise<T | null> {
  try {
    const res = await httpGet(`${HN_API}/item/${id}.json`, {}, 10_000)
    if (!res.ok) {return null}
    return JSON.parse(res.text)
  } catch {
    return null
  }
}

async function fetchTopStoryIds(): Promise<number[]> {
  try {
    const res = await httpGet(`${HN_API}/topstories.json`, {}, 15_000)
    if (!res.ok) {return []}
    return JSON.parse(res.text).slice(0, FETCH_TOP_N)
  } catch {
    return []
  }
}

async function fetchComments(ids: number[]): Promise<HnComment[]> {
  const results = await Promise.allSettled(
    ids.slice(0, TOP_COMMENTS_LIMIT).map(id => fetchItem<HnComment>(id)),
  )
  return results
    .filter((r): r is PromiseFulfilledResult<HnComment> =>
      r.status === 'fulfilled' && r.value !== null)
    .map(r => r.value)
    .filter(c => !c.deleted && !c.dead && c.text)
}

function buildContent(story: HnStory, comments: HnComment[]): string {
  const parts: string[] = []
  if (story.text) {parts.push(stripHtml(story.text))}
  if (comments.length > 0) {
    parts.push('\n--- 社区评论 (Hacker News) ---')
    for (const c of comments) {
      const text = stripHtml(c.text).slice(0, 500)
      parts.push(`[${c.by}]: ${text}`)
    }
  }
  return parts.join('\n\n')
}

/**
 * 采集 Hacker News Top Stories（含顶评论、元数据）
 */
export async function collectHackerNews(): Promise<NewsItem[]> {
  const ids = await fetchTopStoryIds()
  if (ids.length === 0) {
    console.log('[HackerNews] 无法获取文章列表')
    return []
  }

  // 批量拉取文章详情
  const stories = (await Promise.allSettled(ids.map(id => fetchItem<HnStory>(id))))
    .filter((r): r is PromiseFulfilledResult<HnStory> =>
      r.status === 'fulfilled' && r.value !== null)
    .map(r => r.value)
    .filter(s => s.score >= MIN_SCORE && s.title)

  if (stories.length === 0) {return []}

  const now = new Date().toISOString()
  const items: NewsItem[] = []

  // 分批拉取评论（每次最多 10 篇，避免并发过高）
  const batchSize = 10
  for (let i = 0; i < stories.length; i += batchSize) {
    const batch = stories.slice(i, i + batchSize)
    const commentsList = await Promise.allSettled(
      batch.map(s => fetchComments(s.kids || [])),
    )

    for (let j = 0; j < batch.length; j++) {
      const story = batch[j]
      const comments = (commentsList[j] as PromiseFulfilledResult<HnComment[]>)?.value || []
      const url = story.url || `https://news.ycombinator.com/item?id=${story.id}`
      const discussionUrl = `https://news.ycombinator.com/item?id=${story.id}`
      const content = buildContent(story, comments)

      const item: NewsItem & { _hnMeta?: HnMeta; _commentContent?: string } = {
        id: makeId(story.title, url, 'Hacker News'),
        title: story.title,
        url,
        source: 'Hacker News',
        category: 'tech' as NewsCategory,
        pubDate: new Date(story.time * 1000).toISOString(),
        summary: `${story.title} | ⭐ ${story.score} | 💬 ${story.descendants || 0}条讨论`,
        content,
        hotScore: Math.min(100, Math.round((story.score / 500) * 100)),
        fingerprint: makeFingerprint(story.title, url),
        _hnMeta: {
          discussionUrl,
          commentCount: comments.length,
          descendants: story.descendants || 0,
          by: story.by,
          score: story.score,
        },
        _commentContent: comments.length > 0
          ? comments.map(c => `[${c.by}]: ${stripHtml(c.text).slice(0, 300)}`).join('\n')
          : undefined,
      }

      items.push(item)
    }
  }

  console.log(`[HackerNews] 采集 ${items.length} 条（从 ${stories.length} 篇跳过 ${ids.length - stories.length} 篇低分）`)
  return items
}
