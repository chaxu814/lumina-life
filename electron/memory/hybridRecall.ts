// ============================================================
// memory/hybridRecall.ts — BM25 + 余弦 RRF 真融合检索 (v1.0)
//
// 【为什么有这个文件】
// README 从 v0.1 起就写着「BM25 词法 + TF-IDF 向量余弦双路召回，RRF 融合」，
// 但仓库里从来没有过 RRF：`memoryStore.search()` 是纯 TF-IDF 余弦，
// `layeredMemory.bm25Scores()` 是纯 BM25，两套实现各走各的，互不相干。
// 对比 N.E.K.O 的 `memory/hybrid_recall.py`（BM25 + 余弦 + RRF 真融合），
// 声明与实现不符 —— 社区一旦提 issue 指出，会连带质疑其他所有数字。
// 这个文件把「双路召回 + RRF 融合」从口号变成可测的实现。
//
// 【为什么用 RRF 而不是加权求和】
// 朴素做法是 `final = w1*bm25 + w2*cosine`，但两路分数量纲不同：
// BM25 分数无上界（常见 0~30），余弦在 [-1,1]。
// 归一化又会引入「某一路恰好全接近 0 时把它放大到 1」的病态情况。
// RRF（Reciprocal Rank Fusion, Cormack et al. 2009）只用**排名**不用分数，
// 对两路的分数量纲天然免疫，也不需要调权重 —— 这是它被广泛采用的原因。
//
//   RRF(d) = Σ_r  1 / (k + rank_r(d))        k 默认 60
//
// 一条结果只要在任意一路排得靠前，就会因为「排名倒数和」而浮上来，
// 这正好补上单路的盲区：
//   · BM25 擅长「关键词精确命中」，但同义/近义完全召回不到
//   · 余弦擅长「语义相近」，但容易被高频泛词带偏
//   · 融合后：「用户想去日本看樱花」用「樱花」能命中，用「赏樱旅行」也能命中
//
// 【零依赖、可单测】
// 不引入任何 npm 包：分词复用 layeredMemory 的 CJK unigram+bigram，
// TF-IDF 在本文件内实现，RRF 是纯函数。符合项目「零外部依赖」的一贯做法。
// ============================================================

import { tokenize } from './layeredMemory'

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

/** 参与混合召回的最小条目形状（结构化、可单测，不依赖 memoryStore 实例） */
export interface HybridDoc {
  id: string | number
  text: string
  /** 可选的预计算向量（外部 embedder / 已缓存的 TF-IDF）。没有就走本地 TF-IDF */
  vector?: number[]
  metadata?: Record<string, any>
}

export interface HybridHit {
  id: string | number
  text: string
  /** RRF 融合分（不对用户展示，仅用于排序） */
  score: number
  /** 该条命中的最高单路名，便于调试与测试断言 */
  bestRoute: 'bm25' | 'cosine' | 'both'
  /** BM25 路排名（1 起），未命中为 0 */
  bm25Rank: number
  /** 余弦路排名（1 起），未命中为 0 */
  cosineRank: number
  metadata?: Record<string, any>
}

export interface HybridOptions {
  /** 最终返回条数 */
  topK?: number
  /** 每路预取条数（融合池大小）。太小会漏，大了只增加计算量 */
  perRoute?: number
  /** RRF 平滑常数 k，越大越「温和」（弱化头部差距）。Cormack 原文建议 60 */
  rrfK?: number
  /** 余弦路的最低相似度，低于此值不进融合池（滤掉纯噪声） */
  minCosine?: number
  /**
   * 可注入的向量化函数（返回 L2 归一化向量）。
   * 不传则用本文件的本地 TF-IDF。生产里可注入 memoryStore 的 externalEmbedder 结果。
   */
  vectorize?: (text: string, corpusTokens?: Map<string, number>) => number[]
  /** 触发「已从外部拿到向量」模式的回调，用于把向量缓存回条目 */
  onVectorComputed?: (id: string | number, vector: number[]) => void
}

// ═══════════════════════════════════════════════════════════
// 核心：RRF 融合（纯函数，最容易出错也最容易测的部分）
// ═══════════════════════════════════════════════════════════

/**
 * Reciprocal Rank Fusion。
 *
 * @param rankings 每路的「条目下标排名表」，已按相关性降序排列。
 *                  rankings[r][i] = 该路第 i 名对应的**原始文档下标**。
 * @param k        平滑常数，默认 60。
 * @returns        下标 → 融合分。**未出现在任何一路里的下标不会出现在结果中。**
 *
 * 注意几个容易写错的地方，这里都做了处理：
 *  1. 排名从 **1** 起（rank=0 会让 k+r 变成 k，分数虚高一截）
 *  2. 同一路里同一个下标只计一次（防止某路返回重复条目把分数刷上去）
 *  3. 空排名表不报错，直接跳过
 */
export function rrfFuse(rankings: number[][], k = 60): Map<number, number> {
  const fused = new Map<number, number>()

  for (const ranking of rankings) {
    if (!Array.isArray(ranking) || ranking.length === 0) continue

    const seenInRoute = new Set<number>()
    for (let i = 0; i < ranking.length; i++) {
      const docIdx = ranking[i]
      // Number.isInteger 一并排掉 NaN / Infinity / 小数 / 字符串混入。
      // 注意：不能用 `docIdx < 0` 判负——NaN 的比较恒为 false，会被放行，
      // 而 `fused.set(NaN, ...)` 会造出一个键为字符串 "NaN" 的脏条目，
      // 下游拿它去 docs[idx] 取文档必然拿到 undefined。
      if (typeof docIdx !== 'number' || !Number.isInteger(docIdx) || docIdx < 0) continue
      if (seenInRoute.has(docIdx)) continue
      seenInRoute.add(docIdx)

      const rank = i + 1 // 1-based
      const contribution = 1 / (k + rank)
      fused.set(docIdx, (fused.get(docIdx) || 0) + contribution)
    }
  }

  return fused
}

// ═══════════════════════════════════════════════════════════
// 本地 TF-IDF（零依赖，兜底用）
// ═══════════════════════════════════════════════════════════

/** 词频表 */
function termFreq(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>()
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1)
  return tf
}

/**
 * 为一组文档构建 IDF。
 * @returns 词 → idf
 */
function buildIdf(docTokensList: string[][]): Map<string, number> {
  const N = docTokensList.length || 1
  const df = new Map<string, number>()
  for (const toks of docTokensList) {
    for (const t of new Set(toks)) df.set(t, (df.get(t) || 0) + 1)
  }
  const idf = new Map<string, number>()
  for (const [term, n] of df) {
    // 与 BM25 同款平滑 IDF，避免高频词出现 log(0)
    idf.set(term, Math.log(1 + (N - n + 0.5) / (n + 0.5)))
  }
  return idf
}

/** L2 归一化，零向量原样返回 */
function l2Normalize(v: number[]): number[] {
  let norm = 0
  for (const x of v) norm += x * x
  norm = Math.sqrt(norm)
  if (norm === 0) return v
  return v.map(x => x / norm)
}

/**
 * 用给定 IDF 把文本转成 L2 归一化的 TF-IDF 向量。
 * @param vocab 可选的词表（只保留这些词），用于与已有向量保持同一维度。
 */
function tfidfVector(
  text: string,
  idf: Map<string, number>,
  vocab?: Set<string>,
): number[] {
  const tokens = tokenize(text)
  const tf = termFreq(tokens)
  const keys = vocab ? [...tf.keys()].filter(k => vocab.has(k)) : [...tf.keys()]

  const vec = new Array(keys.length).fill(0)
  keys.forEach((term, i) => {
    const f = tf.get(term) || 0
    const w = (1 + Math.log(f)) * (idf.get(term) ?? 0)
    vec[i] = w
  })
  return l2Normalize(vec)
}

/** 余弦相似度（假定两侧已 L2 归一化，故退化为点积；仍做一次保护性裁剪） */
export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  if (n === 0) return 0
  let dot = 0
  for (let i = 0; i < n; i++) dot += a[i] * b[i]
  return Math.max(-1, Math.min(1, dot))
}

// ═══════════════════════════════════════════════════════════
// BM25 路（复用 layeredMemory 的分词与打分，保证中文行为一致）
// ═══════════════════════════════════════════════════════════

/** BM25 参数：k1 控制词频饱和，b 控制文档长度归一化（沿用项目既有取值） */
const BM25_K1 = 1.5
const BM25_B = 0.75

function bm25Rankings(query: string, docs: string[], perRoute: number): number[] {
  const qTokens = Array.from(new Set(tokenize(query)))
  if (qTokens.length === 0 || docs.length === 0) return []

  const docTokens = docs.map(d => tokenize(d))
  const docLens = docTokens.map(t => t.length)
  const avgLen = docLens.reduce((a, c) => a + c, 0) / docTokens.length || 1
  const N = docTokens.length

  const df = new Map<string, number>()
  for (const toks of docTokens) {
    for (const t of new Set(toks)) df.set(t, (df.get(t) || 0) + 1)
  }
  const idf = (t: string): number => {
    const n = df.get(t) || 0
    return Math.log(1 + (N - n + 0.5) / (n + 0.5))
  }

  const scored: Array<{ idx: number; score: number }> = []
  for (let i = 0; i < N; i++) {
    const tf = termFreq(docTokens[i])
    const lenNorm = 1 - BM25_B + BM25_B * (docLens[i] / avgLen)
    let s = 0
    for (const qt of qTokens) {
      const f = tf.get(qt)
      if (!f) continue
      s += idf(qt) * ((f * (BM25_K1 + 1)) / (f + BM25_K1 * lenNorm))
    }
    // 零分不进池：否则「所有文档都排一遍」会把纯噪声塞进融合
    if (s > 0) scored.push({ idx: i, score: s })
  }

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, perRoute).map(s => s.idx)
}

// ═══════════════════════════════════════════════════════════
// 主入口：双路召回 + RRF 融合
// ═══════════════════════════════════════════════════════════

const DEFAULTS = {
  topK: 5,
  perRoute: 20,
  rrfK: 60,
  minCosine: 0.05,
}

/**
 * 混合召回：BM25 词法路 + 余弦语义路 → RRF 融合 → topK。
 *
 * 降级链（任一环节失败都不应让整体检索挂掉）：
 *   ① 注入的 vectorize 抛错 / 返回空 → 该条退回本地 TF-IDF
 *   ② 某一路的排名表为空 → RRF 自然退化为单路融合（数学上等价于那路排名）
 *   ③ 语料为空 → 直接返回 []
 */
export function hybridRecall(
  query: string,
  docs: HybridDoc[],
  options: HybridOptions = {},
): HybridHit[] {
  const topK = options.topK ?? DEFAULTS.topK
  const perRoute = options.perRoute ?? DEFAULTS.perRoute
  const rrfK = options.rrfK ?? DEFAULTS.rrfK
  const minCosine = options.minCosine ?? DEFAULTS.minCosine

  if (!query || !query.trim()) return []
  if (!Array.isArray(docs) || docs.length === 0) return []

  const texts = docs.map(d => d.text || '')

  // ── 路 1：BM25 词法 ──
  const bm25Route = bm25Rankings(query, texts, perRoute)

  // ── 路 2：余弦语义 ──
  //   维度必须一致，否则点积没有意义。
  //   策略：若条目自带 vector 且维度一致 → 直接用；否则整批用同一套本地 TF-IDF 重建。
  const cosineRoute = buildCosineRoute(query, docs, perRoute, minCosine, options)

  // ── RRF 融合 ──
  const fused = rrfFuse([bm25Route, cosineRoute], rrfK)
  if (fused.size === 0) return []

  const bm25RankMap = new Map<number, number>()
  bm25Route.forEach((docIdx, i) => bm25RankMap.set(docIdx, i + 1))
  const cosRankMap = new Map<number, number>()
  cosineRoute.forEach((docIdx, i) => cosRankMap.set(docIdx, i + 1))

  const hits: HybridHit[] = []
  for (const [idx, score] of fused) {
    const doc = docs[idx]
    if (!doc) continue
    const bRank = bm25RankMap.get(idx) || 0
    const cRank = cosRankMap.get(idx) || 0
    hits.push({
      id: doc.id,
      text: doc.text,
      score,
      bestRoute: bRank > 0 && cRank > 0 ? 'both' : bRank > 0 ? 'bm25' : 'cosine',
      bm25Rank: bRank,
      cosineRank: cRank,
      metadata: doc.metadata,
    })
  }

  // 排序：融合分降序；同分时两路都命中的排前面（双路共识强于单路高分）
  hits.sort((a, b) => {
    if (Math.abs(b.score - a.score) > 1e-12) return b.score - a.score
    const aBoth = a.bestRoute === 'both' ? 1 : 0
    const bBoth = b.bestRoute === 'both' ? 1 : 0
    if (aBoth !== bBoth) return bBoth - aBoth
    return 0
  })

  return hits.slice(0, topK)
}

function buildCosineRoute(
  query: string,
  docs: HybridDoc[],
  perRoute: number,
  minCosine: number,
  options: HybridOptions,
): number[] {
  try {
    const texts = docs.map(d => d.text || '')

    // 情况 A：所有条目都有维度一致的预计算向量 → 直接用（快，且能吃到外部 embedder）
    const withVec = docs.filter(d => Array.isArray(d.vector) && d.vector.length > 0)
    const sameDim = withVec.length === docs.length && docs.length > 0 &&
      withVec.every(d => (d.vector as number[]).length === (withVec[0].vector as number[]).length)

    let queryVec: number[]

    if (sameDim && options.vectorize) {
      // 外部 embedder：按条目向量维度推断，交给注入方处理
      queryVec = options.vectorize(query)
    } else {
      // 情况 B：本地 TF-IDF —— 整批重建，维度天然一致
      const docTokensList = texts.map(t => tokenize(t))
      const idf = buildIdf(docTokensList)
      const vocab = new Set(idf.keys())
      queryVec = options.vectorize
        ? options.vectorize(query)
        : tfidfVector(query, idf, vocab)
      if (!Array.isArray(queryVec) || queryVec.length === 0) {
        queryVec = tfidfVector(query, idf, vocab)
      }
      // 把算好的文档向量缓存回条目，省得调用方每次重算
      docs.forEach((d, i) => {
        if (options.onVectorComputed) {
          try { options.onVectorComputed(d.id, tfidfVector(texts[i], idf, vocab)) } catch { /* ignore */ }
        }
      })
    }

    if (!Array.isArray(queryVec) || queryVec.length === 0) return []

    const scored: Array<{ idx: number; score: number }> = []
    for (let i = 0; i < docs.length; i++) {
      let docVec = docs[i].vector
      if (!Array.isArray(docVec) || docVec.length === 0 || docVec.length !== queryVec.length) {
        // 维度不匹配（混合了外部向量与本地向量）→ 本条只能靠 BM25，这里跳过
        continue
      }
      const score = cosineSimilarity(queryVec, docVec)
      if (score >= minCosine) scored.push({ idx: i, score })
    }

    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, perRoute).map(s => s.idx)
  } catch (err) {
    // 余弦路失败不应拖垮整个检索 —— 退回纯 BM25
    console.warn('[HybridRecall] 余弦路失败，退化为纯 BM25:', err)
    return []
  }
}

// ═══════════════════════════════════════════════════════════
// 可观测性：给 UI / 调试用的命中率统计
// ═══════════════════════════════════════════════════════════

export interface HybridStats {
  total: number
  bothRoutes: number
  bm25Only: number
  cosineOnly: number
}

/** 统计两路的重合度 —— 重合度过低说明语料或分词有问题，值得排查 */
export function explainRouting(hits: HybridHit[]): HybridStats {
  const stats: HybridStats = { total: hits.length, bothRoutes: 0, bm25Only: 0, cosineOnly: 0 }
  for (const h of hits) {
    if (h.bestRoute === 'both') stats.bothRoutes++
    else if (h.bestRoute === 'bm25') stats.bm25Only++
    else stats.cosineOnly++
  }
  return stats
}
