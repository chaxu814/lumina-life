// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// hybridMemoryRetrieval.ts — 混合记忆检索 (P4-4 / v6.2 真混合)
//
// 目标：解决 CJK 子串召回 + 词法/语义互补问题
//
// 方案（双路召回 + RRF 融合）：
//   1. BM25 词法召回：k1=1.5, b=0.75，中文单字+短语双重索引（精确词命中强）
//   2. TF-IDF 向量余弦召回：零依赖本地稀疏向量，L2 归一化，对词序/词频分布更宽容
//   3. RRF（Reciprocal Rank Fusion, k=60）融合两路排名，双路命中标记 source:'hybrid'
//
// 诚实边界：
//   - 这里的「向量」是 TF-IDF 稀疏向量（本地、零依赖、永远可用），不是 dense embedding。
//   - dense 语义向量（Ollama nomic-embed-text / 外部 embedding 服务）由
//     electron/memory/memoryStore.ts 的 MemoryVectorStore 负责，可在设置里开启；
//     未来把 dense 路并入本融合器见 Roadmap。
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
// 共享 CJK 分词（BM25 / TF-IDF 同口径）
// ═══════════════════════════════════════════════════════════

function tokenizeText(text: string): string[] {
  // 中文：按字符分词；英文：按空格分词
  const tokens: string[] = []
  // 提取中文字符：同时保留完整短语（利于整句命中）与单字（利于 CJK 召回）
  const chinese = text.match(/[\u4e00-\u9fa5]+/g) || []
  for (const phrase of chinese) {
    tokens.push(phrase.toLowerCase())
    for (const char of phrase) {
      tokens.push(char.toLowerCase())
    }
  }
  // 提取英文/数字单词
  const english = text.match(/[a-zA-Z0-9]+/g) || []
  for (const word of english) {
    tokens.push(word.toLowerCase())
  }
  return tokens
}

function cosineNorm(a: number[], b: number[]): number {
  // 向量已 L2 归一化，点积即余弦
  let s = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {s += a[i] * b[i]}
  return s
}

// ═══════════════════════════════════════════════════════════
// BM25 词法召回（export 便于单元测试）
// ═══════════════════════════════════════════════════════════

export class BM25 {
  private documents: string[][] = []
  private docLengths: number[] = []
  private avgDocLength: number = 0
  private k1: number = 1.5
  private b: number = 0.75
  private df: Map<string, number> = new Map()
  private totalDocs: number = 0

  addDocument(text: string): void {
    const tokens = tokenizeText(text)
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
    const queryTokens = tokenizeText(query)
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
}

// ═══════════════════════════════════════════════════════════
// TF-IDF 稀疏向量余弦召回（本地、零依赖）
// ═══════════════════════════════════════════════════════════

export class TfidfCosine {
  private docTokens: string[][] = []
  private vocabulary: Map<string, number> = new Map()
  private idf: Map<string, number> = new Map()
  private vectors: number[][] = []

  addDocument(text: string): void {
    this.docTokens.push(tokenizeText(text))
  }

  /** 所有文档加入后构建词汇表 / IDF / 文档向量（L2 归一化） */
  finalize(): void {
    this.vocabulary.clear()
    this.idf.clear()
    const N = this.docTokens.length
    const df = new Map<string, number>()
    for (const toks of this.docTokens) {
      for (const t of new Set(toks)) {df.set(t, (df.get(t) || 0) + 1)}
    }
    let idx = 0
    for (const term of df.keys()) {
      this.vocabulary.set(term, idx++)
      // 平滑 IDF
      this.idf.set(term, Math.log((N + 1) / ((df.get(term) || 0) + 1)) + 1)
    }
    this.vectors = this.docTokens.map(toks => this.vectorize(toks))
  }

  private vectorize(tokens: string[]): number[] {
    const vec = new Array(this.vocabulary.size).fill(0)
    const tf = new Map<string, number>()
    for (const t of tokens) {tf.set(t, (tf.get(t) || 0) + 1)}
    const maxFreq = Math.max(1, ...tf.values())
    for (const [term, freq] of tf) {
      const i = this.vocabulary.get(term)
      if (i === undefined) {continue} // 查询词在语料中没出现过，忽略
      const idf = this.idf.get(term) ?? 1
      // 平滑 TF（削弱高频虚词）再乘 IDF
      vec[i] = (0.5 + 0.5 * (freq / maxFreq)) * idf
    }
    // L2 归一化
    let norm = 0
    for (const v of vec) {norm += v * v}
    norm = Math.sqrt(norm) || 1
    for (let i = 0; i < vec.length; i++) {vec[i] /= norm}
    return vec
  }

  search(query: string, topK: number = 10): Array<{ docIndex: number; score: number }> {
    if (this.vocabulary.size === 0 || this.vectors.length === 0) {return []}
    const q = this.vectorize(tokenizeText(query))
    const out: Array<{ docIndex: number; score: number }> = []
    for (let i = 0; i < this.vectors.length; i++) {
      const score = cosineNorm(q, this.vectors[i])
      if (score > 0) {out.push({ docIndex: i, score })}
    }
    return out.sort((a, b) => b.score - a.score).slice(0, topK)
  }
}

// ═══════════════════════════════════════════════════════════
// 混合检索管理器
// ═══════════════════════════════════════════════════════════

interface FusedEntry {
  note: MemoryNote
  rrf: number
  sources: Set<string>
  bestLex: number
  bestVec: number
}

export class HybridMemoryRetrieval {
  private _bm25Cache = new Map<string, BM25>() // agentId -> BM25
  private _tfidfCache = new Map<string, TfidfCosine>() // agentId -> TF-IDF
  private readonly _rrfK = 60 // RRF 常数（标准值 60）

  /** 检索记忆：BM25 + TF-IDF 双路召回，RRF 融合 */
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

    // 用 note 对象引用做全局融合 key（跨 agent 也安全）
    const fused = new Map<MemoryNote, FusedEntry>()

    const accum = (note: MemoryNote | undefined, rank: number, source: string, raw: number) => {
      if (!note) {return}
      let e = fused.get(note)
      if (!e) {
        e = { note, rrf: 0, sources: new Set(), bestLex: 0, bestVec: 0 }
        fused.set(note, e)
      }
      e.rrf += 1 / (this._rrfK + rank + 1)
      e.sources.add(source)
      if (source === 'bm25') {e.bestLex = Math.max(e.bestLex, raw)} else {e.bestVec = Math.max(e.bestVec, raw)}
    }

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

      // ── 第 1 路：BM25 词法召回 ──
      const bm25 = this._getBM25(aid, filteredNotes)
      const bm25Results = bm25.search(query, topK)
      bm25Results.forEach(({ docIndex, score }, rank) => {
        accum(filteredNotes[docIndex], rank, 'bm25', score)
      })

      // ── 第 2 路：TF-IDF 向量余弦召回 ──
      const tfidf = this._getTfidf(aid, filteredNotes)
      const tfidfResults = tfidf.search(query, topK)
      tfidfResults.forEach(({ docIndex, score }, rank) => {
        accum(filteredNotes[docIndex], rank, 'vector', score)
      })
    }

    if (fused.size === 0) {return []}

    // RRF 分归一化到 0~1（最高分为 1），再按相对强度 minScore 过滤
    const entries = [...fused.values()]
    const maxRrf = Math.max(...entries.map(e => e.rrf))
    const results: RetrievalResult[] = entries
      .map((e) => {
        const source: RetrievalResult['source'] =
          e.sources.size >= 2 ? 'hybrid' : e.sources.has('bm25') ? 'bm25' : 'vector'
        return {
          note: e.note,
          score: maxRrf > 0 ? e.rrf / maxRrf : 0,
          source,
          matchedText: this._findMatchedText(query, e.note.content),
        }
      })
      .filter(r => r.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)

    return results
  }

  /** 清除索引缓存 */
  clearCache(agentId?: string): void {
    if (agentId) {
      this._bm25Cache.delete(agentId)
      this._tfidfCache.delete(agentId)
    } else {
      this._bm25Cache.clear()
      this._tfidfCache.clear()
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

  private _getTfidf(agentId: string, notes: MemoryNote[]): TfidfCosine {
    const cacheKey = `${agentId}:${notes.length}`
    if (!this._tfidfCache.has(cacheKey)) {
      const tfidf = new TfidfCosine()
      for (const note of notes) {
        tfidf.addDocument(`${note.date}\n${note.content}`)
      }
      tfidf.finalize()
      this._tfidfCache.set(cacheKey, tfidf)
    }
    return this._tfidfCache.get(cacheKey)!
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
