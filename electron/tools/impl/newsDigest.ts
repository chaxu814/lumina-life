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
import type { DigestNarrative } from './newsNarrator'
import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { stateFilePath } from '../../core/pathsFallback'

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
    // ⚠️ 不要退回 process.cwd()：开发态 cwd 就是项目根，会把状态写进 Git 工作区
    return stateFilePath('news-fingerprints.json')
  }
}

function loadFingerprints(): FingerprintStore {
  if (_fingerprintCache) {return _fingerprintCache}
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
    if (!fs.existsSync(dir)) {fs.mkdirSync(dir, { recursive: true })}
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
  if (timestamps.length === 0) {return { total: 0, oldest: '-', newest: '-' }}
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
    if (!groups[cat]) {groups[cat] = []}
    groups[cat].push(item)
  }

  return groups
}

// ═══════════════════════════════════════════════════════════
// 邮件正文组装
// ═══════════════════════════════════════════════════════════

/**
 * 组装邮件正文（Markdown 格式）
 *
 * v1.1 两种形态：
 *   - `narrated`（传了 narrative）：LLM 已接入 → 导读 + 逐条人话点评 + 链接
 *   - `plain`（默认，narrative 为空）：**只给标题和网址**，不编不装。
 *     用户没配 LLM 时，这是唯一诚实的输出——没有摘要就别假装有。
 */
export function assembleDigestBody(
  filtered: FilteredItem[],
  options?: {
    title?: string
    showSource?: boolean
    maxItems?: number
    /** LLM 叙述结果；给了就走叙述形态 */
    narrative?: DigestNarrative | null
  },
): string {
  const { title, showSource = true, maxItems = 20, narrative = null } = options || {}
  const dateStr = new Date().toLocaleDateString('zh-CN', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  })
  const displayTitle = title || `📡 Lumina 新闻早报 — ${dateStr}`

  if (filtered.length === 0) {
    return `${displayTitle}\n\n📭 今日没有筛选出值得关注的新闻。`
  }

  const sliced = filtered.slice(0, maxItems)
  const lines: string[] = [displayTitle, '']

  if (narrative) {
    lines.push('## 📝 今日导读', '')
    if (narrative.lead) { lines.push(narrative.lead, '') }
    if (narrative.takeaway) {
      lines.push(`> 💡 **${narrative.takeaway}**`, '')
    }
    lines.push('---', '')
  }

  // 逐条：叙述形态带点评，plain 形态只有标题 + 网址
  const commentByIndex = new Map<number, string>()
  if (narrative) {
    for (const it of narrative.items) { commentByIndex.set(it.index, it.comment) }
  }

  sliced.forEach((f, i) => {
    const sourceTag = showSource ? `  _${f.item.source}_` : ''
    if (narrative) {
      lines.push(`**${i + 1}. ${f.item.title}**${sourceTag}`)
      const c = commentByIndex.get(i)
      if (c) { lines.push(`   ${c}`) }
      lines.push(`   📎 ${f.item.url}`)
    } else {
      // 极简：一行标题、一行网址，不堆分类、不打星、不编标签
      lines.push(`**${i + 1}. ${f.item.title}**`)
      lines.push(`${f.item.url}`)
    }
    lines.push('')
  })

  lines.push('---')
  lines.push(`📬 Lumina 智能推送 · ${new Date().toLocaleTimeString('zh-CN')}`)
  if (narrative) {
    lines.push('💡 前往设置 → 新闻订阅 调整兴趣偏好')
  } else {
    lines.push('💡 接入 LLM 后 Lumina 会为你写导读（设置 → LLM 模型）')
  }

  return lines.join('\n')
}

/**
 * 组装为 HTML 格式（更美观的邮件）
 */
export function assembleDigestHTML(
  filtered: FilteredItem[],
  options?: { title?: string; maxItems?: number; bilingual?: boolean; narrative?: DigestNarrative | null },
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
  const html = enhancedMd
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^---$/gm, '<hr>')
    // 引用块（叙述形态的「值得关注」）
    .replace(/^&gt;\s*(.+)$/gm, '<blockquote style="margin:8px 0;padding:8px 12px;border-left:3px solid #8b5cf6;background:#f5f3ff;border-radius:4px;color:#6d28d9;">$1</blockquote>')
    .replace(/^📎 (.+)$/gm, '📎 <a href="$1">$1</a>')
    // 极简形态：裸 URL 单独一行 → 也变成可点链接
    .replace(/^(https?:\/\/\S+)$/gm, '<a href="$1">$1</a>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>')

  return `<div style="font-family: 'Microsoft YaHei', '微软雅黑', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 640px; margin: 0 auto; padding: 20px; color: #333; line-height: 1.7;">
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
  if (items.length <= 3) {return items}

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
    for (const t of a) {if (b.has(t)) {inter++}}
    const union = new Set([...a, ...b])
    return inter / union.size
  }

  const keep = new Array<boolean>(items.length).fill(true)
  const THRESHOLD = 0.45

  for (let i = 0; i < items.length; i++) {
    if (!keep[i]) {continue}
    const a = tokenize(items[i].title)
    for (let j = i + 1; j < items.length; j++) {
      if (!keep[j]) {continue}
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
