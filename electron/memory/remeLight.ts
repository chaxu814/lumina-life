// ============================================================
// memory/remeLight.ts — ReMe Light 记忆管理器 (P0-2)
//
// 对标 QwenPaw ReMe Light：
//   - Markdown 知识库：可直接阅读、编辑、链接
//   - 可搜索、可热更新
//   - 与对话上下文集成
//   - 支持验证和重建索引
// ============================================================

import * as fs from 'fs'
import * as path from 'path'
import { getMemoryStore, getMemoryVectorStore, type MemoryStore } from './memoryStore'
import { getAgentMemoryManager, type MemoryNote, type AgentMemory } from '../agentMemoryManager'
import { ScrollContext, type ScrollRecallOptions, type ScrollRecallResult } from './scrollContext'

// ═══════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════

export interface ReMeMemoryEntry {
  id: string
  content: string
  type: 'long_term' | 'daily_note' | 'fact' | 'reflection' | 'persona'
  agentId?: string
  createdAt: number
  updatedAt: number
  tags?: string[]
  links?: string[] // 链接到其他记忆条目
}

export interface ReMeSearchOptions {
  query: string
  agentId?: string
  type?: ReMeMemoryEntry['type']
  limit?: number
  dateFrom?: string
  dateTo?: string
}

export interface ReMeSearchResult {
  entry: ReMeMemoryEntry
  score: number
  snippet: string
}

export interface ReMeIndexStats {
  totalEntries: number
  byType: Record<string, number>
  lastIndexed: number
}

// ═══════════════════════════════════════════════════════════
// ReMeLight — Markdown 知识库管理器
// ═══════════════════════════════════════════════════════════

export class ReMeLight {
  private memoryStore: MemoryStore
  private agentMemoryManager = getAgentMemoryManager()
  private scrollContext: ScrollContext
  private initialized = false

  constructor() {
    this.memoryStore = getMemoryStore()
    this.scrollContext = new ScrollContext()
  }

  /** 初始化 ReMe 记忆系统 */
  init(): void {
    if (this.initialized) return
    
    this.scrollContext.init()
    this.initialized = true
    console.log('[ReMeLight] 初始化完成')
  }

  // ── 索引化 ─────────────────────────────────────────────

  /**
   * 重建记忆索引（从现有 Markdown 和 SQLite 重新构建）
   */
  rebuildIndex(): ReMeIndexStats {
    this.init()
    const stats: ReMeIndexStats = {
      totalEntries: 0,
      byType: {},
      lastIndexed: Date.now(),
    }

    // 从所有 Agent 的记忆中提取条目
    const allMemories = this.agentMemoryManager.getAll()
    for (const [agentId, memory] of Object.entries(allMemories)) {
      // 索引长期记忆
      for (const line of memory.longTerm) {
        if (line.trim()) {
          this.indexEntry({
            id: `lt_${agentId}_${stats.totalEntries}`,
            content: line,
            type: 'long_term',
            agentId,
            createdAt: memory.lastUpdated,
            updatedAt: memory.lastUpdated,
          })
          stats.totalEntries++
          stats.byType['long_term'] = (stats.byType['long_term'] || 0) + 1
        }
      }

      // 索引每日笔记
      for (const [date, note] of Object.entries(memory.notes)) {
        this.indexEntry({
          id: `dn_${agentId}_${date}`,
          content: note.content,
          type: 'daily_note',
          agentId,
          createdAt: note.createdAt,
          updatedAt: note.updatedAt,
          tags: note.tags,
          links: this.extractLinks(note.content),
        })
        stats.totalEntries++
        stats.byType['daily_note'] = (stats.byType['daily_note'] || 0) + 1
      }
    }

    // 索引事实记忆
    const facts = this.memoryStore.getFacts(undefined, 100)
    for (const fact of facts) {
      this.indexEntry({
        id: `fact_${fact.id}`,
        content: fact.content,
        type: 'fact',
        createdAt: new Date(fact.timestamp).getTime(),
        updatedAt: new Date(fact.timestamp).getTime(),
        tags: [fact.category],
      })
      stats.totalEntries++
      stats.byType['fact'] = (stats.byType['fact'] || 0) + 1
    }

    // 索引反思记忆
    const reflections = this.memoryStore.getReflections(50)
    for (const ref of reflections) {
      this.indexEntry({
        id: `ref_${Date.now()}_${stats.totalEntries}`,
        content: `${ref.topic}: ${ref.insight}`,
        type: 'reflection',
        createdAt: new Date(ref.timestamp).getTime(),
        updatedAt: new Date(ref.timestamp).getTime(),
      })
      stats.totalEntries++
      stats.byType['reflection'] = (stats.byType['reflection'] || 0) + 1
    }

    console.log(`[ReMeLight] 索引重建完成，共 ${stats.totalEntries} 条记忆`)
    return stats
  }

  /**
   * 索引单条记忆
   */
  private indexEntry(entry: ReMeMemoryEntry): void {
    // 这里可以扩展为向量索引
    // 目前先存储到 memory_store
    const key = `reme_${entry.id}`
    this.memoryStore.getDb().prepare(`
      INSERT OR REPLACE INTO semantic_memories (key, value, metadata, created_at)
      VALUES (?, ?, ?, datetime('now','localtime'))
    `).run(key, entry.content, JSON.stringify({
      type: entry.type,
      agentId: entry.agentId,
      tags: entry.tags || [],
      links: entry.links || [],
    }))
  }

  // ── 搜索 ───────────────────────────────────────────────

  /**
   * 搜索记忆（支持全文、标签、日期范围）
   */
  async search(options: ReMeSearchOptions): Promise<ReMeSearchResult[]> {
    const { query, agentId, type, limit = 20, dateFrom, dateTo } = options

    // 使用 Scroll Context 进行全文搜索
    const scrollResults = this.scrollContext.recall({
      query,
      agentId,
      limit: limit * 2, // 多取一些以便过滤
    })

    // 同时搜索 semantic_memories 表
    const db = this.memoryStore.getDb()
    let sql = 'SELECT key, value, metadata, created_at FROM semantic_memories WHERE 1=1'
    const params: any[] = []

    if (query.trim()) {
      sql += ' AND value LIKE ?'
      params.push(`%${query.trim()}%`)
    }
    if (agentId) {
      sql += ' AND metadata LIKE ?'
      params.push(`%"agentId":"${agentId}"%`)
    }
    if (type) {
      sql += ' AND metadata LIKE ?'
      params.push(`%"type":"${type}"%`)
    }
    if (dateFrom) {
      sql += ' AND created_at >= ?'
      params.push(dateFrom)
    }
    if (dateTo) {
      sql += ' AND created_at <= ?'
      params.push(dateTo)
    }

    sql += ' ORDER BY created_at DESC LIMIT ?'
    params.push(limit)

    const rows = db.prepare(sql).all(...params) as any[]
    const semanticResults: ReMeSearchResult[] = rows.map(row => {
      const metadata = JSON.parse(row.metadata as string || '{}')
      const content = row.value as string
      return {
        entry: {
          id: row.key.replace('reme_', ''),
          content,
          type: metadata.type || 'long_term',
          agentId: metadata.agentId,
          createdAt: new Date(row.created_at).getTime(),
          updatedAt: new Date(row.created_at).getTime(),
          tags: metadata.tags || [],
          links: metadata.links || [],
        },
        score: this.scoreResult(content, query, metadata),
        snippet: this.buildSnippet(content, query),
      }
    })

    // 合并结果
    const merged: ReMeSearchResult[] = []
    for (const r of scrollResults) {
      merged.push({
        entry: {
          id: r.entry.id.toString(),
          content: r.entry.content,
          type: 'daily_note' as ReMeMemoryEntry['type'],
          agentId: r.entry.agentId || '',
          createdAt: new Date(r.entry.createdAt).getTime(),
          updatedAt: new Date(r.entry.createdAt).getTime(),
        },
        score: r.score,
        snippet: r.snippet,
      })
    }
    for (const r of semanticResults) {
      merged.push(r)
    }

    // 去重并排序
    const unique = new Map<string, ReMeSearchResult>()
    for (const r of merged) {
      const key = r.entry.id
      if (!unique.has(key) || unique.get(key)!.score < r.score) {
        unique.set(key, r)
      }
    }

    // 🆕 Rerank 重排序（如果启用）
    const vectorStore = getMemoryVectorStore()
    if (vectorStore.rerankStatus.enabled && unique.size > 1) {
      try {
        const docs = Array.from(unique.values()).map((r) => r.entry.content)
        const rerankResults = await vectorStore.rerank(query, docs, limit)

        const reranked: ReMeSearchResult[] = []
        for (const rr of rerankResults) {
          const original = Array.from(unique.values())[rr.index]
          if (original) {
            reranked.push({
              ...original,
              score: rr.score, // 使用 rerank 分数覆盖
            })
          }
        }
        console.log(`[ReMeLight] 🔄 Rerank 完成: ${rerankResults.length} 条结果已重排`)
        return reranked
      } catch (err) {
        console.warn('[ReMeLight] Rerank 失败，使用原始排序:', err)
      }
    }

    return Array.from(unique.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
  }

  /**
   * 获取记忆上下文（用于注入到 system prompt）
   */
  getMemoryContext(agentId: string, maxChars = 2000): string {
    const lines: string[] = ['🧠 【ReMe 记忆上下文】']

    // 1. 长期记忆
    const memory = this.agentMemoryManager.get(agentId)
    if (memory.longTerm.length > 0) {
      lines.push('\n## 长期记忆')
      for (const item of memory.longTerm.slice(-10)) {
        lines.push(`- ${item}`)
      }
    }

    // 2. 最近每日笔记
    const recentNotes = Object.entries(memory.notes)
      .sort(([a], [b]) => b.localeCompare(a))
      .slice(0, 5)
    if (recentNotes.length > 0) {
      lines.push('\n## 最近笔记')
      for (const [date, note] of recentNotes) {
        lines.push(`- [[${date}]] ${note.content.slice(0, 100)}`)
      }
    }

    // 3. 相关事实
    const facts = this.memoryStore.getFacts(undefined, 5)
    if (facts.length > 0) {
      lines.push('\n## 相关事实')
      for (const fact of facts) {
        lines.push(`- [${fact.category}] ${fact.content}`)
      }
    }

    const block = lines.join('\n')
    if (block.length > maxChars) {
      return block.slice(0, maxChars) + '\n...（记忆上下文已截断）'
    }
    return block
  }

  // ── 工具方法 ───────────────────────────────────────────

  private extractLinks(text: string): string[] {
    // 提取 [[link]] 格式的链接
    const links = text.match(/\[\[([^\]]+)\]\]/g) || []
    return links.map(l => l.replace(/[\[\]]/g, ''))
  }

  private scoreResult(content: string, query: string, metadata: any): number {
    let score = 0
    if (!query.trim()) return score
    
    const lowerContent = content.toLowerCase()
    const lowerQuery = query.toLowerCase()
    
    // 精确匹配加分
    if (lowerContent.includes(lowerQuery)) {
      score += 10
      // 计算匹配次数
      const matches = lowerContent.split(lowerQuery).length - 1
      score += Math.min(matches * 2, 10)
    }
    
    // 标签匹配
    if (metadata.tags?.some((t: string) => t.toLowerCase().includes(lowerQuery))) {
      score += 5
    }
    
    // 类型匹配
    if (metadata.type === query.toLowerCase()) {
      score += 3
    }
    
    // 时间衰减（越新越高分）
    const age = Date.now() - (metadata.createdAt || Date.now())
    const daysOld = age / (1000 * 60 * 60 * 24)
    score += Math.max(0, 5 - daysOld * 0.1)
    
    return score
  }

  private buildSnippet(content: string, query: string): string {
    if (!query.trim()) return content.slice(0, 120)
    const lower = content.toLowerCase()
    const idx = lower.indexOf(query.toLowerCase())
    if (idx === -1) return content.slice(0, 120)
    const start = Math.max(0, idx - 40)
    const end = Math.min(content.length, idx + query.length + 80)
    return (start > 0 ? '...' : '') + content.slice(start, end) + (end < content.length ? '...' : '')
  }

  // ── 验证与修复 ─────────────────────────────────────────

  /**
   * 验证记忆完整性
   */
  validateMemory(agentId: string): { valid: boolean; issues: string[] } {
    const issues: string[] = []
    
    try {
      const memory = this.agentMemoryManager.get(agentId)
      
      // 检查 memory.json 与 MEMORY.md 一致性
      const memoryDir = this.agentMemoryManager['_getMemoryDir'](agentId)
      const mdPath = path.join(memoryDir, 'MEMORY.md')
      const jsonPath = path.join(memoryDir, 'memory.json')
      
      if (!fs.existsSync(mdPath)) {
        issues.push('MEMORY.md 缺失')
      }
      if (!fs.existsSync(jsonPath)) {
        issues.push('memory.json 缺失')
      }
      
      // 检查每日笔记引用有效性
      const content = fs.existsSync(mdPath) ? fs.readFileSync(mdPath, 'utf-8') : ''
      const noteRefs = content.match(/\[\[([^\]]+)\]\]/g) || []
      for (const ref of noteRefs) {
        const date = ref.match(/\[\[(.+?)\]\]/)?.[1]
        if (date) {
          const notePath = path.join(memoryDir, `${date}.md`)
          if (!fs.existsSync(notePath)) {
            issues.push(`每日笔记缺失: ${date}.md`)
          }
        }
      }
    } catch (e) {
      issues.push(`验证失败: ${e}`)
    }
    
    return {
      valid: issues.length === 0,
      issues,
    }
  }

  /**
   * 修复记忆问题
   */
  repairMemory(agentId: string): string[] {
    const repaired: string[] = []
    const validation = this.validateMemory(agentId)
    
    for (const issue of validation.issues) {
      if (issue.includes('MEMORY.md 缺失')) {
        // 重新生成 MEMORY.md
        const memory = this.agentMemoryManager.get(agentId)
        this.agentMemoryManager.save(agentId, memory)
        repaired.push('重新生成 MEMORY.md')
      } else if (issue.includes('memory.json 缺失')) {
        // 重新生成 memory.json
        const memory = this.agentMemoryManager.get(agentId)
        this.agentMemoryManager.save(agentId, memory)
        repaired.push('重新生成 memory.json')
      } else if (issue.includes('每日笔记缺失')) {
        // 清理无效引用
        const match = issue.match(/每日笔记缺失: (.+\.md)/)
        if (match) {
          const date = match[1].replace('.md', '')
          const memory = this.agentMemoryManager.get(agentId)
          delete memory.notes[date]
          this.agentMemoryManager.save(agentId, memory)
          repaired.push(`清理无效笔记引用: ${date}`)
        }
      }
    }
    
    return repaired
  }
}

// ═══════════════════════════════════════════════════════════
// 单例
// ═══════════════════════════════════════════════════════════

let _instance: ReMeLight | null = null

export function getReMeLight(): ReMeLight {
  if (!_instance) {
    _instance = new ReMeLight()
    _instance.init()
  }
  return _instance
}

export function initReMeLight(): ReMeLight {
  _instance = new ReMeLight()
  _instance.init()
  return _instance
}
