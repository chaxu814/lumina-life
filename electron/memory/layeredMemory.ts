// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// memory/layeredMemory.ts — 五层记忆检索门面 (v0.1)
//
// 五维记忆分层，把已有 SQLite 记忆（画像/事实/反思/摘要/
// 对话历史）组织成明确的五层，统一召回并注入 prompt：
//
//   persona   人格/身份层：用户画像 + 稳定人格特质（长期、低变动、始终在场）
//   facts     事实层：    可复用的事实（偏好/习惯/事件/环境），BM25 检索
//   reflection 反思层：   对话后沉淀的洞察/行动建议，BM25 检索
//   recent    近期层：    最近对话摘要（这几天发生了什么）
//   working   工作层：    最近几条原始对话（当前话题的短期上下文）
//
// 与旧版差异：
//   - 旧版事实召回是 SQL `LIKE %整句%`，中文多词几乎命不中；
//     这里用 BM25（拉丁词 + 中文 unigram/bigram 分词），零依赖、纯本地。
//   - 分层带预算，避免「只取最相关的事实」却丢掉身份/近期上下文。
//
// 纯 TS、通过适配器接口注入（不直接 import better-sqlite3），便于单测。
// ============================================================

import { dictMatch } from './cjkDict'

export type LayerName = 'working' | 'recent' | 'facts' | 'reflection' | 'persona'

export interface LayeredItem {
  layer: LayerName
  text: string
  /** 综合得分（检索相关度 + 层权重 + 新鲜度），仅用于同层排序 */
  score: number
  meta?: {
    confidence?: number
    topic?: string
    ageHours?: number
    source?: string
  }
}

export interface LayeredRecall {
  byLayer: Record<LayerName, LayeredItem[]>
  /** 按注入顺序（persona→facts→reflection→recent→working）排好的条目 */
  merged: LayeredItem[]
  /** 可直接拼进 system prompt 的中文段落；空记忆时为 '' */
  prompt: string
  stats: { items: number; perLayer: Record<LayerName, number> }
}

// ── 适配器：描述从 MemoryStore 取数的最小接口（真实实现见 createMemoryStoreAdapter）──
export interface LayeredMemorySource {
  /** 工作层：最近原始对话（跨会话，最新在前） */
  getRecentConversation?(limit: number): Array<{ role: string; content: string; createdAt?: string }>
  /** 近期层：最近对话摘要 */
  getRecentSummaries?(limit: number): string[]
  /** 事实层：候选事实（可多取，交给 BM25 排） */
  getFacts?(limit: number): Array<{ content: string; category?: string; confidence?: number; source?: string; timestamp?: string; created_at?: string }>
  /** 反思层 */
  getReflections?(limit: number): Array<{ topic?: string; insight: string; action?: string; timestamp?: string }>
  /** 人格层：用户画像 */
  getUserProfile?(): { name?: string; preferences?: string[]; habits?: string[]; communicationStyle?: string; personality?: string } | null
  /** 人格层：人格特质 */
  getPersona?(): { traits?: string[] } | null
}

export interface LayeredRecallOptions {
  query?: string
  /** 各层预算（条数） */
  budget?: Partial<Record<LayerName, number>>
  /** 每条文本最大长度（字符） */
  maxLineLen?: number
  /** 事实候选池大小（BM25 排序前的拉取量） */
  factPool?: number
}

// ═══════════════════════════════════════════════════════════
// 分词与 BM25（零依赖，支持中文）
// ═══════════════════════════════════════════════════════════

/** 拉丁/数字词 */
const LATIN_RE = /[a-z0-9][a-z0-9'_.\-]*/gi

// 🆕 中文词表分词增强开关（默认开；由存储层按 feature flag 设置）。
//    关闭后回到纯 unigram+bigram，行为与历史版本完全一致。
let _cjkDictEnabled = true
export function setCjkDictEnabled(v: boolean): void { _cjkDictEnabled = !!v }
export function isCjkDictEnabled(): boolean { return _cjkDictEnabled }

/** 分词：拉丁词 + 中文 unigram/bigram（bigram 显著提升中文短词召回）
 *  🆕 词表命中时**额外**加入完整词（「苹果手机」→ 苹果/手机），
 *     属于严格增量：只增加匹配机会，不降低召回。 */
export function tokenize(text: string): string[] {
  if (!text) {return []}
  const lower = text.toLowerCase()
  const tokens: string[] = []
  // 拉丁/数字
  const latin = lower.match(LATIN_RE)
  if (latin) {tokens.push(...latin)}
  // 中文：拆出连续 CJK 段，做 unigram + bigram
  const cjkRuns = lower.match(/[\u4e00-\u9fff]+/g)
  if (cjkRuns) {
    for (const run of cjkRuns) {
      const chars = Array.from(run)
      for (const ch of chars) {tokens.push(ch)}
      for (let i = 0; i < chars.length - 1; i++) {tokens.push(chars[i] + chars[i + 1])}
      // 🆕 词表最长匹配：额外补充完整词（严格增量）
      if (_cjkDictEnabled) {
        const words = dictMatch(run)
        for (const w of words) {tokens.push(w)}
      }
    }
  }
  return tokens
}

/** 计算每个词在文档中的词频 */
function termFreq(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>()
  for (const t of tokens) {tf.set(t, (tf.get(t) || 0) + 1)}
  return tf
}

/**
 * BM25 相关性打分。docs 为待排文档，返回与 docs 等长的得分数组（>=0）。
 * 无查询词时返回全 0（调用方改按置信度/时间排序）。
 */
export function bm25Scores(query: string, docs: string[], k1 = 1.5, b = 0.75): number[] {
  const qTokens = Array.from(new Set(tokenize(query)))
  const scores = new Array(docs.length).fill(0)
  if (!qTokens.length || !docs.length) {return scores}

  const docTokens = docs.map(d => tokenize(d))
  const docLens = docTokens.map(t => t.length)
  const avgLen = docLens.reduce((a, c) => a + c, 0) / docs.length || 1
  const N = docs.length

  // 文档频率 df
  const df = new Map<string, number>()
  for (const toks of docTokens) {
    for (const t of new Set(toks)) {df.set(t, (df.get(t) || 0) + 1)}
  }
  const idf = (t: string): number => {
    const n = df.get(t) || 0
    return Math.log(1 + (N - n + 0.5) / (n + 0.5))
  }

  for (let i = 0; i < N; i++) {
    const tf = termFreq(docTokens[i])
    const lenNorm = 1 - b + b * (docLens[i] / avgLen)
    let s = 0
    for (const qt of qTokens) {
      const f = tf.get(qt) || 0
      if (!f) {continue}
      s += idf(qt) * ((f * (k1 + 1)) / (f + k1 * lenNorm))
    }
    scores[i] = s
  }
  return scores
}

function clip(s: string, max: number): string {
  const t = (s || '').replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

function ageHours(ts?: string): number | undefined {
  if (!ts) {return undefined}
  const t = Date.parse(ts.replace(' ', 'T'))
  if (Number.isNaN(t)) {return undefined}
  return Math.max(0, (Date.now() - t) / 3_600_000)
}

/** 指数时间衰减（半衰期 7 天），给近期内容一点加权 */
function recencyBoost(ageH?: number): number {
  if (ageH === undefined) {return 0}
  return Math.exp(-ageH / (24 * 7))
}

function safe<T>(fn: () => T, fallback: T): T {
  try { return fn() } catch { return fallback }
}

// ═══════════════════════════════════════════════════════════
// 五层召回
// ═══════════════════════════════════════════════════════════

const DEFAULT_BUDGET: Record<LayerName, number> = {
  persona: 5,
  facts: 6,
  reflection: 3,
  recent: 3,
  working: 4,
}

const LAYER_TITLE: Record<LayerName, string> = {
  persona: '我对用户的基本了解',
  facts: '我记得的事实',
  reflection: '我的一些反思',
  recent: '最近发生的事',
  working: '刚刚的对话',
}
const LAYER_ORDER: LayerName[] = ['persona', 'facts', 'reflection', 'recent', 'working']

export function buildLayeredRecall(src: LayeredMemorySource | null | undefined, opts: LayeredRecallOptions = {}): LayeredRecall {
  const budget = { ...DEFAULT_BUDGET, ...(opts.budget || {}) }
  const maxLineLen = opts.maxLineLen ?? 80
  const empty: LayeredRecall = {
    byLayer: { persona: [], facts: [], reflection: [], recent: [], working: [] },
    merged: [], prompt: '', stats: { items: 0, perLayer: { persona: 0, facts: 0, reflection: 0, recent: 0, working: 0 } },
  }
  if (!src) {return empty}

  const byLayer: Record<LayerName, LayeredItem[]> = { persona: [], facts: [], reflection: [], recent: [], working: [] }

  // ── persona（身份层，始终在场，不按查询排序）──
  const personaLines: string[] = []
  const profile = safe(() => src.getUserProfile?.() ?? null, null)
  if (profile) {
    if (profile.name) {personaLines.push(`用户叫 ${profile.name}`)}
    for (const p of (profile.preferences || []).slice(0, 3)) {personaLines.push(`喜欢 ${p}`)}
    for (const h of (profile.habits || []).slice(0, 2)) {personaLines.push(`习惯 ${h}`)}
    if (profile.communicationStyle) {personaLines.push(`沟通风格：${profile.communicationStyle}`)}
  }
  const persona = safe(() => src.getPersona?.() ?? null, null)
  if (persona?.traits?.length) {personaLines.push(`我的性格：${persona.traits.slice(0, 3).join('、')}`)}
  byLayer.persona = [...new Set(personaLines)].slice(0, budget.persona).map(text => ({
    layer: 'persona' as const, text: clip(text, maxLineLen), score: 1,
  }))

  // ── facts（事实层，BM25 检索 + 置信度 + 新鲜度）──
  const factPool = safe(() => src.getFacts?.(opts.factPool ?? 200) ?? [], [])
  const factDocs = factPool.map(f => f.content || '')
  const factScores = bm25Scores(opts.query || '', factDocs)
  const hasQuery = factScores.some(x => x > 0)
  byLayer.facts = factPool
    .map((f, i) => {
      const age = ageHours(f.timestamp || f.created_at)
      const relevance = hasQuery ? factScores[i] : 0
      const confidence = typeof f.confidence === 'number' ? f.confidence : 0.5
      const score = hasQuery
        ? relevance * 1.0 + confidence * 0.15 + recencyBoost(age) * 0.1
        : confidence * 1.0 + recencyBoost(age) * 0.25
      return { layer: 'facts' as const, text: f.content || '', score, meta: { confidence, ageHours: age, source: f.source } }
    })
    .filter(it => it.text && (!hasQuery || it.score > 0))
    .sort((a, b) => b.score - a.score)
    .slice(0, budget.facts)
    .map(it => ({ ...it, text: clip(it.text, maxLineLen) }))

  // ── reflection（反思层，BM25；无查询时取最新）──
  const reflPool = safe(() => src.getReflections?.(budget.reflection * 4) ?? [], [])
  const reflDocs = reflPool.map(r => [r.topic, r.insight, r.action].filter(Boolean).join(' '))
  const reflScores = bm25Scores(opts.query || '', reflDocs)
  const reflHasQuery = reflScores.some(x => x > 0)
  byLayer.reflection = reflPool
    .map((r, i) => {
      const age = ageHours(r.timestamp)
      const text = r.action ? `${r.insight}（可以：${r.action}）` : r.insight
      return {
        layer: 'reflection' as const,
        text,
        score: (reflHasQuery ? reflScores[i] : 0) + recencyBoost(age) * 0.2,
        meta: { topic: r.topic, ageHours: age },
      }
    })
    .filter(it => it.text && (!reflHasQuery || it.score > 0))
    .sort((a, b) => b.score - a.score)
    .slice(0, budget.reflection)
    .map(it => ({ ...it, text: clip(it.text, maxLineLen) }))

  // ── recent（近期摘要层）──
  const summaries = safe(() => src.getRecentSummaries?.(budget.recent) ?? [], [])
  byLayer.recent = summaries.slice(0, budget.recent).map(text => ({
    layer: 'recent' as const, text: clip(text, maxLineLen), score: 0,
  }))

  // ── working（最近原始对话层）──
  const conv = safe(() => src.getRecentConversation?.(budget.working) ?? [], [])
  byLayer.working = conv.slice(0, budget.working).map(m => ({
    layer: 'working' as const,
    text: clip(`${m.role === 'user' ? '用户' : m.role === 'assistant' ? '我' : m.role}：${m.content}`, maxLineLen),
    score: 0,
  }))

  // 合并（按注入顺序）
  const merged: LayeredItem[] = []
  for (const layer of LAYER_ORDER) {merged.push(...byLayer[layer])}

  // 去重（同文本只留第一次出现的层）
  const seen = new Set<string>()
  const deduped = merged.filter(it => {
    if (seen.has(it.text)) {return false}
    seen.add(it.text)
    return true
  })

  const prompt = formatLayeredPrompt({ ...empty, byLayer, merged: deduped })
  const perLayer = {
    persona: byLayer.persona.length,
    facts: byLayer.facts.length,
    reflection: byLayer.reflection.length,
    recent: byLayer.recent.length,
    working: byLayer.working.length,
  }
  return { byLayer, merged: deduped, prompt, stats: { items: deduped.length, perLayer } }
}

/** 把五层召回渲染成可注入 system prompt 的中文段落 */
export function formatLayeredPrompt(recall: LayeredRecall): string {
  const blocks: string[] = []
  for (const layer of LAYER_ORDER) {
    const items = recall.byLayer[layer]
    if (!items.length) {continue}
    const lines = items.map(i => `- ${i.text}`).join('\n')
    blocks.push(`【${LAYER_TITLE[layer]}】\n${lines}`)
  }
  if (!blocks.length) {return ''}
  return '【你对用户的记忆，请自然运用，不要逐条念出来】\n' + blocks.join('\n')
}
