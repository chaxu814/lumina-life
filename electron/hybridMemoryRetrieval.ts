// ============================================================
// hybridMemoryRetrieval.ts — 混合记忆检索 (P4-4)
//
// 目标：解决 CJK 子串召回问题
// 方案：向量检索 + BM25 关键词 fallback
//
// 当前状态（2026-09 诚实标注）：
//   ✅ BM25 词法召回：已实现（k1=1.5, b=0.75，中文单字+短语双重索引）
//   ⚠️ 向量语义召回：预留接口，未实现
//      RetrievalResult.source 枚举含 'vector'/'hybrid'，
//      但 search() 当前只返回 source: 'bm25'。
// TODO(vector-recall): 接入本地 embedding 服务（Ollama / Python sidecar）
//   后实现向量召回，并与 BM25 做 RRF 融合。见 Roadmap v1.2.0。
// ============================================================

import { getAgentMemoryManager, type MemoryNote } from './agentMemoryManager'
import { getAgentProfileManager } from './agentProfileManager'

// ═══════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════

export interface RetrievalResult {
  note: MemoryNote
  score: number
  source: 'vector' | 'bm25' | 'hybrid'
  matchedText?: string
}

export interface RetrievalOptions {
  agentId?: string
  topK?: number
  minScore?: number
  dateRange?: { start: string; end: string }
  tags?: string[]
}

// ═══════════════════════════════════════════════════════════
// BM25 简易实现
// ═══════════════════════════════════════════════════════════

class BM25 {
  private documents: string[][] = []
  private docLengths: number[] = []
  private avgDocLength: number = 0
  private k1: number = 1.5
  private b: number = 0.75
  private df: Map<string, number> = new Map()
  private totalDocs: number = 0

  addDocument(text: string): void {
    const tokens = this._tokenize(text)
    this.documents.push(tokens)
    this.docLengths.push(tokens.length)
    
    // 计算文档频率
    const uniqueTokens = new Set(tokens)
    for (const token of uniqueTokens) {
      this.df.set(token, (this.df.get(token) || 0) + 1)
    }
    
    this.totalDocs++
    this.avgDocLength = this.docLengths.reduce((a, b) => a + b, 0) / this.totalDocs
  }

  search(query: string, topK: number = 10): Array<{ docIndex: number; score: number }> {
    const queryTokens = this._tokenize(query)
    const scores: Array<{ docIndex: number; score: number }> = []

    for (let i = 0; i < this.totalDocs; i++) {
      let score = 0
      const docTokens = this.documents[i]
      const docLength = this.docLengths[i]

      for (const qToken of queryTokens) {
        const tf = docTokens.filter(t => t === qToken).length
        const df = this.df.get(qToken) || 0
        
        if (tf === 0 || df === 0) {continue}

        // BM25 公式
        const idf = Math.log((this.totalDocs - df + 0.5) / (df + 0.5) + 1)
        const numerator = tf * (this.k1 + 1)
        const denominator = tf + this.k1 * (1 - this.b + this.b * docLength / this.avgDocLength)
        score += idf * (numerator / denominator)
      }

      if (score > 0) {
        scores.push({ docIndex: i, score })
      }
    }

    return scores
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
  }

  private _tokenize(text: string): string[] {
    // 中文：按字符分词；英文：按空格分词
    const tokens: string[] = []
    
    // 提取中文字符
    const chinese = text.match(/[\u4e00-\u9fa5]+/g) || []
    for (const phrase of chinese) {
      // 对中文短语，同时保留完整短语和单字
      tokens.push(phrase.toLowerCase())
      for (const char of phrase) {
        tokens.push(char.toLowerCase())
      }
    }
    
    // 提取英文单词
    const english = text.match(/[a-zA-Z0-9]+/g) || []
    for (const word of english) {
      tokens.push(word.toLowerCase())
    }
    
    return tokens
  }
}

// ═══════════════════════════════════════════════════════════
// 混合检索管理器
// ═══════════════════════════════════════════════════════════

export class HybridMemoryRetrieval {
  private _bm25Cache = new Map<string, BM25>() // agentId -> BM25

  /** 检索记忆 */
  async retrieve(query: string, options: RetrievalOptions = {}): Promise<RetrievalResult[]> {
    const {
      agentId,
      topK = 10,
      minScore = 0.1,
      dateRange,
      tags,
    } = options

    const memoryManager = getAgentMemoryManager()
    const profileManager = getAgentProfileManager()
    const agentIds = agentId ? [agentId] : Object.keys(profileManager.getAll())

    const results: RetrievalResult[] = []

    for (const aid of agentIds) {
      const memory = memoryManager.get(aid)
      const notes = Object.values(memory.notes)

      // 日期过滤
      let filteredNotes = notes
      if (dateRange) {
        filteredNotes = notes.filter(n => n.date >= dateRange.start && n.date <= dateRange.end)
      }

      // 标签过滤
      if (tags && tags.length > 0) {
        filteredNotes = filteredNotes.filter(n => n.tags && n.tags.some(t => tags.includes(t)))
      }

      // BM25 检索
      const bm25 = this._getBM25(aid, filteredNotes)
      const bm25Results = bm25.search(query, topK)

      // 转换为结果
      for (const { docIndex, score } of bm25Results) {
        if (score < minScore) {continue}
        
        const note = filteredNotes[docIndex]
        if (!note) {continue}

        // 查找匹配文本
        const matchedText = this._findMatchedText(query, note.content)

        results.push({
          note,
          score,
          source: 'bm25',
          matchedText,
        })
      }
    }

    // 按分数排序并返回 topK
    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
  }

  /** 清除 BM25 缓存 */
  clearCache(agentId?: string): void {
    if (agentId) {
      this._bm25Cache.delete(agentId)
    } else {
      this._bm25Cache.clear()
    }
  }

  // ── 私有方法 ─────────────────────────────────────────

  private _getBM25(agentId: string, notes: MemoryNote[]): BM25 {
    const cacheKey = `${agentId}:${notes.length}`
    
    if (!this._bm25Cache.has(cacheKey)) {
      const bm25 = new BM25()
      for (const note of notes) {
        bm25.addDocument(`${note.date}\n${note.content}`)
      }
      this._bm25Cache.set(cacheKey, bm25)
    }
    
    return this._bm25Cache.get(cacheKey)!
  }

  private _findMatchedText(query: string, content: string): string | undefined {
    // 简单的前后文提取
    const lowerContent = content.toLowerCase()
    const lowerQuery = query.toLowerCase()
    
    const index = lowerContent.indexOf(lowerQuery)
    if (index >= 0) {
      const start = Math.max(0, index - 30)
      const end = Math.min(content.length, index + query.length + 30)
      return content.slice(start, end)
    }
    
    return undefined
  }
}

// ═══════════════════════════════════════════════════════════
// 单例
// ═══════════════════════════════════════════════════════════

let _instance: HybridMemoryRetrieval | null = null

export function getHybridMemoryRetrieval(): HybridMemoryRetrieval {
  if (!_instance) {
    _instance = new HybridMemoryRetrieval()
  }
  return _instance
}
