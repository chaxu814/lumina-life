// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// knowledgeBase.ts — Lumina 知识库引擎 (v3.9)
//
// 功能:
//   1. 文件索引 — 拖入文档自动分块 + 向量化
//   2. 语义搜索 — 对话时检索相关内容增强回答
//   3. 知识管理 — 增删改查 + 批量导入
//
// 架构:
//   本地文件存储 + 轻量 TF-IDF 向量化 (无需外部服务)
//   未来可升级为 embedding API 调用
// ============================================================

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

// ═══════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════

export interface KBDocument {
  id: string
  title: string
  source: string        // 原始文件路径
  sourceType: 'file' | 'url' | 'note'
  content: string       // 原始内容
  chunks: KBChunk[]     // 分块
  tags: string[]
  createdAt: number
  updatedAt: number
  size: number          // 字节数
}

export interface KBChunk {
  id: string
  docId: string
  index: number
  content: string
  /** TF-IDF 向量（稀疏表示：词 → 权重） */
  vector: Record<string, number>
}

export interface KBSearchResult {
  docId: string
  chunkId: string
  title: string
  content: string
  score: number
  source: string
}

export interface KBStats {
  totalDocs: number
  totalChunks: number
  totalSize: number
  lastIndexed: number | null
}

// ═══════════════════════════════════════════════════════════
// 知识库引擎
// ═══════════════════════════════════════════════════════════

const KB_DIR = path.join(os.homedir(), '.lumina', 'knowledge')
const KB_INDEX_FILE = path.join(KB_DIR, 'index.json')

const CHUNK_SIZE = 500      // 每块约500字符
const CHUNK_OVERLAP = 100   // 块间重叠100字符

// 中文停用词
const STOP_WORDS = new Set([
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一',
  '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着',
  '没有', '看', '好', '自己', '这', '他', '她', '它', '们', '那', '些',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'and', 'but', 'or', 'not', 'no', 'if', 'then', 'than', 'that', 'this',
])

// ═══════════════════════════════════════════════════════════
// 核心实现
// ═══════════════════════════════════════════════════════════

export class KnowledgeBase {
  private documents: Map<string, KBDocument> = new Map()
  private dirty = false

  constructor() {
    this.ensureDir()
    this.loadIndex()
  }

  private ensureDir(): void {
    if (!fs.existsSync(KB_DIR)) {
      fs.mkdirSync(KB_DIR, { recursive: true })
    }
  }

  private loadIndex(): void {
    try {
      if (fs.existsSync(KB_INDEX_FILE)) {
        const raw = fs.readFileSync(KB_INDEX_FILE, 'utf-8')
        const docs: KBDocument[] = JSON.parse(raw)
        for (const doc of docs) {
          this.documents.set(doc.id, doc)
        }
        console.log(`[KB] 加载 ${docs.length} 篇文档`)
      }
    } catch (err) {
      console.error('[KB] 加载索引失败:', err)
    }
  }

  private saveIndex(): void {
    try {
      const docs = Array.from(this.documents.values())
      fs.writeFileSync(KB_INDEX_FILE, JSON.stringify(docs, null, 2), 'utf-8')
      this.dirty = false
    } catch (err) {
      console.error('[KB] 保存索引失败:', err)
    }
  }

  /** 分词 */
  private tokenize(text: string): string[] {
    // 中英文混合分词
    const tokens: string[] = []

    // 英文单词
    const enWords = text.match(/[a-zA-Z]+/g) || []
    for (const w of enWords) {
      const lower = w.toLowerCase()
      if (lower.length > 1 && !STOP_WORDS.has(lower)) {
        tokens.push(lower)
      }
    }

    // 中文分词（简化：按字符切分 + 2-gram）
    const cnChars = text.replace(/[a-zA-Z0-9\s\p{P}]/gu, '')
    for (let i = 0; i < cnChars.length; i++) {
      const c = cnChars[i]
      if (!STOP_WORDS.has(c) && c.trim()) {
        tokens.push(c)
      }
    }
    // 2-gram
    for (let i = 0; i < cnChars.length - 1; i++) {
      const bigram = cnChars.slice(i, i + 2)
      tokens.push(bigram)
    }

    return tokens
  }

  /** 计算 TF-IDF 向量 */
  private computeVector(chunkText: string, allDocs: KBDocument[]): Record<string, number> {
    const tokens = this.tokenize(chunkText)
    const tf: Record<string, number> = {}
    const totalTokens = tokens.length || 1

    // TF
    for (const t of tokens) {
      tf[t] = (tf[t] || 0) + 1
    }
    for (const t of Object.keys(tf)) {
      tf[t] /= totalTokens
    }

    // IDF（简化：总文档数 / 包含该词的文档数）
    const docCount = allDocs.length || 1
    const df: Record<string, number> = {}
    for (const t of Object.keys(tf)) {
      let count = 0
      for (const doc of allDocs) {
        if (doc.content.includes(t)) {count++}
      }
      df[t] = Math.log((docCount + 1) / (count + 1)) + 1
    }

    // TF-IDF
    const vector: Record<string, number> = {}
    for (const t of Object.keys(tf)) {
      vector[t] = tf[t] * (df[t] || 1)
    }

    return vector
  }

  /** 分块 */
  private chunkText(text: string): string[] {
    const chunks: string[] = []
    let start = 0
    while (start < text.length) {
      const end = Math.min(start + CHUNK_SIZE, text.length)
      // 尽量在句号/换行处断句
      let breakPoint = end
      if (end < text.length) {
        const searchEnd = Math.min(end + 50, text.length)
        const slice = text.slice(end, searchEnd)
        const match = slice.match(/[。！？\n\r]/)
        if (match && match.index !== undefined) {
          breakPoint = end + match.index + 1
        }
      }
      chunks.push(text.slice(start, breakPoint).trim())
      start = Math.max(start, breakPoint - CHUNK_OVERLAP)
    }
    return chunks.filter(c => c.length > 10)
  }

  /** 添加文档 */
  async addDocument(params: {
    title: string
    content: string
    source?: string
    sourceType?: KBDocument['sourceType']
    tags?: string[]
  }): Promise<KBDocument> {
    const allDocs = Array.from(this.documents.values())
    const id = `kb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const chunkTexts = this.chunkText(params.content)
    const chunks: KBChunk[] = chunkTexts.map((text, i) => ({
      id: `${id}-c${i}`,
      docId: id,
      index: i,
      content: text,
      vector: this.computeVector(text, allDocs),
    }))

    const doc: KBDocument = {
      id,
      title: params.title,
      source: params.source || '',
      sourceType: params.sourceType || 'note',
      content: params.content,
      chunks,
      tags: params.tags || [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      size: Buffer.byteLength(params.content, 'utf-8'),
    }

    this.documents.set(id, doc)
    this.dirty = true

    // 异步保存
    setTimeout(() => { if (this.dirty) {this.saveIndex()} }, 1000)

    return doc
  }

  /** 从文件导入 */
  async importFile(filePath: string): Promise<KBDocument> {
    const ext = path.extname(filePath).toLowerCase()
    const supported = ['.md', '.txt', '.json', '.html', '.csv', '.log', '.xml', '.yaml', '.yml', '.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.go', '.rs', '.css', '.sql']
    
    if (!supported.includes(ext)) {
      throw new Error(`不支持的文件类型: ${ext}`)
    }

    const raw = fs.readFileSync(filePath, 'utf-8')
    let content = raw

    // HTML 简单去标签
    if (ext === '.html') {
      content = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    }

    // 限制大小
    if (content.length > 500000) {
      content = content.slice(0, 500000) + '\n\n...(已截断，文件过大)'
    }

    const title = path.basename(filePath)
    const doc = await this.addDocument({
      title,
      content,
      source: filePath,
      sourceType: 'file',
      tags: this.extractTags(title, content),
    })

    return doc
  }

  /** 从 URL 导入 */
  async importUrl(url: string, title: string, content: string): Promise<KBDocument> {
    return this.addDocument({
      title: title || url,
      content,
      source: url,
      sourceType: 'url',
      tags: this.extractTags(title, content),
    })
  }

  /** 创建笔记 */
  async createNote(title: string, content: string, tags?: string[]): Promise<KBDocument> {
    return this.addDocument({
      title,
      content,
      sourceType: 'note',
      tags,
    })
  }

  /** 提取标签 */
  private extractTags(title: string, content: string): string[] {
    const tags = new Set<string>()
    const combined = (title + ' ' + content.slice(0, 1000)).toLowerCase()

    const techKeywords = [
      'react', 'vue', 'angular', 'svelte', 'next.js', 'nuxt', 'node.js',
      'python', 'java', 'golang', 'rust', 'typescript', 'javascript',
      'ai', 'machine learning', 'deep learning', 'llm', 'gpt', 'claude',
      'docker', 'kubernetes', 'aws', 'azure', 'gcp', 'api', 'graphql',
      'database', 'sql', 'mongodb', 'redis', 'postgresql', 'mysql',
      'frontend', 'backend', 'fullstack', 'devops', 'security',
      '算法', '数据结构', '设计模式', '架构', '微服务', '测试',
    ]

    for (const kw of techKeywords) {
      if (combined.includes(kw)) {tags.add(kw)}
    }

    return Array.from(tags).slice(0, 10)
  }

  /** 搜索 */
  search(query: string, topK: number = 5): KBSearchResult[] {
    const queryTokens = this.tokenize(query)
    if (queryTokens.length === 0) {return []}

    // 查询向量
    const queryVec: Record<string, number> = {}
    for (const t of queryTokens) {
      queryVec[t] = (queryVec[t] || 0) + 1
    }
    const qNorm = Math.sqrt(Object.values(queryVec).reduce((s, v) => s + v * v, 0)) || 1
    for (const t of Object.keys(queryVec)) {
      queryVec[t] /= qNorm
    }

    // 余弦相似度
    const results: KBSearchResult[] = []
    for (const doc of this.documents.values()) {
      for (const chunk of doc.chunks) {
        const cNorm = Math.sqrt(Object.values(chunk.vector).reduce((s, v) => s + v * v, 0)) || 1
        let dotProduct = 0
        for (const [token, qWeight] of Object.entries(queryVec)) {
          const cWeight = chunk.vector[token] || 0
          dotProduct += qWeight * cWeight
        }
        const score = dotProduct / (cNorm || 1)

        if (score > 0.05) {
          results.push({
            docId: doc.id,
            chunkId: chunk.id,
            title: doc.title,
            content: chunk.content.slice(0, 300),
            score,
            source: doc.source,
          })
        }
      }
    }

    results.sort((a, b) => b.score - a.score)
    return results.slice(0, topK)
  }

  /** 获取文档 */
  getDocument(id: string): KBDocument | undefined {
    return this.documents.get(id)
  }

  /** 删除文档 */
  deleteDocument(id: string): boolean {
    const existed = this.documents.delete(id)
    if (existed) {
      this.saveIndex()
    }
    return existed
  }

  /** 更新文档 */
  async updateDocument(id: string, updates: Partial<Pick<KBDocument, 'title' | 'content' | 'tags'>>): Promise<KBDocument | null> {
    const doc = this.documents.get(id)
    if (!doc) {return null}

    if (updates.title) {doc.title = updates.title}
    if (updates.tags) {doc.tags = updates.tags}
    if (updates.content !== undefined) {
      const allDocs = Array.from(this.documents.values())
      const chunkTexts = this.chunkText(updates.content)
      doc.content = updates.content
      doc.chunks = chunkTexts.map((text, i) => ({
        id: `${id}-c${i}`,
        docId: id,
        index: i,
        content: text,
        vector: this.computeVector(text, allDocs),
      }))
      doc.size = Buffer.byteLength(updates.content, 'utf-8')
    }
    doc.updatedAt = Date.now()
    this.saveIndex()
    return doc
  }

  /** 获取统计 */
  getStats(): KBStats {
    let totalChunks = 0
    let totalSize = 0
    let lastIndexed: number | null = null
    for (const doc of this.documents.values()) {
      totalChunks += doc.chunks.length
      totalSize += doc.size
      if (!lastIndexed || doc.updatedAt > lastIndexed) {
        lastIndexed = doc.updatedAt
      }
    }
    return {
      totalDocs: this.documents.size,
      totalChunks,
      totalSize,
      lastIndexed,
    }
  }

  /** 获取所有文档列表 */
  listDocuments(): Pick<KBDocument, 'id' | 'title' | 'sourceType' | 'tags' | 'createdAt' | 'size'>[] {
    return Array.from(this.documents.values()).map(d => ({
      id: d.id,
      title: d.title,
      sourceType: d.sourceType,
      tags: d.tags,
      createdAt: d.createdAt,
      size: d.size,
    }))
  }

  /** 构建 RAG 上下文（供对话使用） */
  buildRAGContext(query: string, maxTokens: number = 2000): string {
    const results = this.search(query, 5)
    if (results.length === 0) {return ''}

    let context = '【知识库相关内容】\n'
    let totalLen = 0
    for (const r of results) {
      const entry = `📄 ${r.title} (相关度: ${(r.score * 100).toFixed(0)}%)\n${r.content}\n---\n`
      if (totalLen + entry.length > maxTokens * 4) {break}
      context += entry
      totalLen += entry.length
    }
    return context
  }
}

// ═══════════════════════════════════════════════════════════
// 单例
// ═══════════════════════════════════════════════════════════

let _instance: KnowledgeBase | null = null

export function getKnowledgeBase(): KnowledgeBase {
  if (!_instance) {
    _instance = new KnowledgeBase()
  }
  return _instance
}

export function initKnowledgeBase(): KnowledgeBase {
  return getKnowledgeBase()
}
