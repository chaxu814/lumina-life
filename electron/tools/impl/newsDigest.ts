// ============================================================
// impl/newsDigest.ts — 新闻去重 + 摘要组装 (v1.0)
//
// 功能:
//   1. URL + 内容指纹双去重（持久化指纹防重复推送）
//   2. 按分类分组
//   3. 组装邮件正文 HTML
// ============================================================

import type { NewsItem } from './newsCollector'
import type { FilteredItem } from './newsFilter'
import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'

// ═══════════════════════════════════════════════════════════
// 持久化指纹存储（防重复推送）
// ═══════════════════════════════════════════════════════════

interface FingerprintStore {
  /** 已推送的指纹集合 */
  seen: Record<string, number>  // fingerprint → timestamp
}

let _fingerprintCache: FingerprintStore | null = null

function getFingerprintPath(): string {
  try {
    return path.join(app.getPath('userData'), 'news-fingerprints.json')
  } catch {
    return path.join(process.cwd(), 'news-fingerprints.json')
  }
}

function loadFingerprints(): FingerprintStore {
  if (_fingerprintCache) return _fingerprintCache
  try {
    const filePath = getFingerprintPath()
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf-8')
      _fingerprintCache = JSON.parse(raw)
    } else {
      _fingerprintCache = { seen: {} }
    }
  } catch {
    _fingerprintCache = { seen: {} }
  }
  return _fingerprintCache!
}

function saveFingerprints(): void {
  try {
    const filePath = getFingerprintPath()
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify(_fingerprintCache, null, 2), 'utf-8')
  } catch (err) {
    console.warn('[NewsDigest] 指纹保存失败:', err)
  }
}

// ═══════════════════════════════════════════════════════════
// 去重
// ═══════════════════════════════════════════════════════════

export interface DedupOptions {
  /** 指纹保留时间（ms），超过此时间视为新内容，默认 72h */
  ttlMs?: number
  /** 是否自动清理过期指纹，默认 true */
  autoClean?: boolean
}

/**
 * 去重：去除已推送过的条目
 *
 * @param items   原始条目
 * @param options 去重选项
 * @returns       去重后的新条目
 */
export function deduplicate(items: NewsItem[], options?: DedupOptions): NewsItem[] {
  const { ttlMs = 72 * 3600 * 1000, autoClean = true } = options || {}
  const store = loadFingerprints()
  const now = Date.now()

  // 自动清理过期指纹
  if (autoClean) {
    const before = Object.keys(store.seen).length
    for (const [fp, ts] of Object.entries(store.seen)) {
      if (now - ts > ttlMs) {
        delete store.seen[fp]
      }
    }
    const after = Object.keys(store.seen).length
    if (before !== after) {
      console.log(`[NewsDigest] 清理过期指纹: ${before} → ${after}`)
    }
  }

  const deduped: NewsItem[] = []

  for (const item of items) {
    const fp = item.fingerprint

    // URL 去重（更严格的备选）
    const urlFp = `url::${item.url.replace(/https?:\/\//, '').replace(/[?#].*$/, '').toLowerCase()}`

    if (store.seen[fp] || store.seen[urlFp]) {
      continue
    }

    // 标记为已见
    store.seen[fp] = now
    store.seen[urlFp] = now
    deduped.push(item)
  }

  saveFingerprints()
  console.log(`[NewsDigest] 去重: ${items.length} → ${deduped.length} 条新内容`)
  return deduped
}

/**
 * 重置所有指纹（调试用）
 */
export function resetFingerprints(): void {
  _fingerprintCache = { seen: {} }
  saveFingerprints()
  console.log('[NewsDigest] 指纹已重置')
}

/**
 * 获取当前指纹统计
 */
export function getFingerprintStats(): { total: number; oldest: string; newest: string } {
  const store = loadFingerprints()
  const timestamps = Object.values(store.seen)
  if (timestamps.length === 0) return { total: 0, oldest: '-', newest: '-' }
  return {
    total: timestamps.length,
    oldest: new Date(Math.min(...timestamps)).toISOString(),
    newest: new Date(Math.max(...timestamps)).toISOString(),
  }
}

// ═══════════════════════════════════════════════════════════
// 按分类分组
// ═══════════════════════════════════════════════════════════

export function groupByCategory(items: FilteredItem[]): Record<string, FilteredItem[]> {
  const groups: Record<string, FilteredItem[]> = {}

  for (const item of items) {
    const cat = item.item.category
    if (!groups[cat]) groups[cat] = []
    groups[cat].push(item)
  }

  return groups
}

// ═══════════════════════════════════════════════════════════
// 邮件正文组装
// ═══════════════════════════════════════════════════════════

const CATEGORY_EMOJI: Record<string, string> = {
  tech: '💻',
  finance: '💰',
  trending: '🔥',
  oss: '🔧',
  general: '📰',
}

const CATEGORY_LABEL: Record<string, string> = {
  tech: '科技前沿',
  finance: '财经资讯',
  trending: '热门话题',
  oss: '开源项目',
  general: '综合',
}

/**
 * 组装邮件正文（Markdown 格式）
 */
export function assembleDigestBody(
  filtered: FilteredItem[],
  options?: {
    title?: string
    showSource?: boolean
    maxItems?: number
  },
): string {
  const { title, showSource = true, maxItems = 20 } = options || {}
  const dateStr = new Date().toLocaleDateString('zh-CN', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  })
  const displayTitle = title || `📡 Lumina 新闻早报 — ${dateStr}`

  if (filtered.length === 0) {
    return `${displayTitle}\n\n📭 今日没有筛选出值得关注的新闻。`
  }

  const sliced = filtered.slice(0, maxItems)
  const groups = groupByCategory(sliced)
  const lines: string[] = [displayTitle, '']

  // 分类输出
  for (const [cat, items] of Object.entries(groups)) {
    const emoji = CATEGORY_EMOJI[cat] || '📌'
    const label = CATEGORY_LABEL[cat] || cat
    lines.push(`### ${emoji} ${label}（${items.length} 条）`)
    lines.push('')

    for (let i = 0; i < items.length; i++) {
      const f = items[i]
      const scoreBar = '⭐'.repeat(Math.max(1, Math.round(f.relevanceScore / 20)))
      const sourceTag = showSource ? `  _${f.item.source}_` : ''

      lines.push(`**${i + 1}. ${f.item.title}**${sourceTag}`)
      if (f.oneLiner) lines.push(`   ${f.oneLiner}`)
      if (f.tags.length > 0) lines.push(`   🏷️ ${f.tags.slice(0, 3).join(', ')} ${scoreBar}`)
      lines.push(`   📎 ${f.item.url}`)
      lines.push('')
    }
  }

  // 脚注
  lines.push('---')
  lines.push(`📬 Lumina 智能推送 · ${new Date().toLocaleTimeString('zh-CN')}`)
  lines.push('💡 前往设置 → 新闻订阅 调整兴趣偏好')

  return lines.join('\n')
}

/**
 * 组装为 HTML 格式（更美观的邮件）
 */
export function assembleDigestHTML(
  filtered: FilteredItem[],
  options?: { title?: string; maxItems?: number; bilingual?: boolean },
): string {
  const { bilingual = false } = options || {}
  const md = assembleDigestBody(filtered, options)

  // 如果启用双语，在每个条目后追加英文关键词
  let enhancedMd = md
  if (bilingual) {
    const lines = md.split('\n')
    const out: string[] = []
    for (const line of lines) {
      out.push(line)
      // 在 URL 行后追加英文关键词（如果有）
      const urlMatch = line.match(/^📎 (.+)$/)
      if (urlMatch) {
        // 查找对应的 FilteredItem
        const url = urlMatch[1]
        const found = filtered.find(f => f.item.url === url || f.item.url.includes(url.slice(0, 40)))
        if (found?.enKeywords) {
          out.push(`   🌐 EN: ${found.enKeywords}`)
        }
      }
    }
    enhancedMd = out.join('\n')
  }

  // 简单 Markdown → HTML 转换（够用就好）
  let html = enhancedMd
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^---$/gm, '<hr>')
    .replace(/^📎 (.+)$/gm, '📎 <a href="$1">$1</a>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>')

  return `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 640px; margin: 0 auto; padding: 20px; color: #333;">
<p>${html}</p>
</div>`
}

// ═══════════════════════════════════════════════════════════
// 跨源去重：识别不同源报道的同一事件并合并
// ═══════════════════════════════════════════════════════════

/**
 * 基于标题相似度做跨源去重。
 * 使用简单的 Jaccard + 公共子串检测，
 * 不同源报道同一事件时保留热度最高的那条。
 *
 * @param items  去重后但跨源可能有重复的条目
 * @returns      合并后的条目，同一事件只保留热度最高的一条
 */
export function mergeCrossSourceDuplicates(items: NewsItem[]): NewsItem[] {
  if (items.length <= 3) return items

  function tokenize(s: string): Set<string> {
    return new Set(
      s.replace(/[^\w\u4e00-\u9fff]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length > 1)
        .map(t => t.toLowerCase()),
    )
  }

  function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
    let inter = 0
    for (const t of a) if (b.has(t)) inter++
    const union = new Set([...a, ...b])
    return inter / union.size
  }

  const keep = new Array<boolean>(items.length).fill(true)
  const THRESHOLD = 0.45

  for (let i = 0; i < items.length; i++) {
    if (!keep[i]) continue
    const a = tokenize(items[i].title)
    for (let j = i + 1; j < items.length; j++) {
      if (!keep[j]) continue
      const b = tokenize(items[j].title)
      const sim = jaccardSimilarity(a, b)
      if (sim >= THRESHOLD) {
        // 保留热度高者，淘汰热度低者
        if (items[i].hotScore >= items[j].hotScore) {
          keep[j] = false
        } else {
          keep[i] = false
          break // i 已被淘汰，不再比较
        }
      }
    }
  }

  const merged = items.filter((_, idx) => keep[idx])
  if (merged.length < items.length) {
    console.log(`[NewsDigest] 跨源去重: ${items.length} → ${merged.length}（合并 ${items.length - merged.length} 条重复报道）`)
  }
  return merged
}
