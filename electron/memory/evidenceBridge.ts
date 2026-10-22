// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// evidenceBridge.ts — 记忆证据链桥接层（v3.34 新增）
//
// 【背景】本项目其实有**两套**记忆可信度机制：
//
//   1. memoryStore.ts 的 SOURCE_CONFIDENCE（**已上线**）
//      —— 记忆的权威性只由 `source` 决定，模型无权自封 confidence=1.0。
//         这是反幻觉设计里做得最好的部分，有 tests/memoryConfidence.test.ts 覆盖。
//
//   2. memoryEvidence.ts 的五维证据评分（**此前是死代码**）
//      —— confidence 0.30 / recency 0.15 / frequency 0.15 /
//         corroboration 0.10 / importance 0.30，带 7 天半衰期衰减，
//         状态机 confirmed / pending / outdated / contradicted。
//         16KB 实现，只有 tests/memoryEvidence.test.ts 在测，
//         0 个生产 import —— README 却拿「证据链」当卖点。
//
// 【为什么不直接把两套合并成一套】
// 第 1 套是**写入期**的硬约束（防模型吹牛），第 2 套是**读取期**的排序与
// 生命周期（决定什么值得召回、什么该被时间淘汰）。它们回答的是不同问题，
// 硬合并会破坏第 1 套最关键的「权威性只由 source 决定」这条不变量。
//
// 【这个文件做什么】
// 作为适配层把两套接起来，而不是改写任何一套：
//   · 写入时：用第 1 套算出的 confidence 当 sourceReliability 喂给第 2 套
//     （仅在 memory_save 工具写 fact / 纠正旧记忆时触发）
//   · 读取时：第 2 套的 compositeScore 给 memory_search 工具的返回结果重排，
//     并标出 pending/contradicted
//   · 面板：getEvidenceStats 供「记忆剧场」UI 展示证据分布
//
// 【当前生效边界（P2-14 口径收敛）】
// 证据评分只在「记忆工具（memory_search）检索结果」与「记忆剧场」UI 生效；
// 回复前的自动召回走 memoryStore.searchHybrid → hybridRecall（BM25+TF-IDF+RRF
// 混合排序），不经过证据评分。getVerifiedContext 尚未接线进 prompt 路径。
// ============================================================

import { getMemoryEvidence, type ScoredMemory } from '../memoryEvidence'
import { SOURCE_CONFIDENCE, type FactSource } from './memoryStore'

/** 记忆类型 → 证据引擎的 ScoredMemory.type */
type EvidenceKind = ScoredMemory['type']

/** memory_v2 的 category → 证据引擎类型 */
const CATEGORY_TO_EVIDENCE: Record<string, EvidenceKind> = {
  fact: 'fact',
  reflection: 'reflection',
  persona: 'persona',
  lesson: 'lesson',
  preference: 'preference',
}

/** 惰性初始化：构造函数会做文件 I/O，绝不能在模块顶层触发 */
let _bridgeReady = false
function ensureReady(): boolean {
  if (_bridgeReady) {return true}
  try {
    getMemoryEvidence()
    _bridgeReady = true
    return true
  } catch (e: any) {
    // 证据链是增强项，失败绝不能拖垮记忆主流程
    console.warn('[EvidenceBridge] 初始化失败，证据链降级为不可用：', e?.message || e)
    return false
  }
}

/**
 * 写入一条记忆到证据链。
 * @param content   记忆正文
 * @param category  memory_v2 的 category（fact / reflection / persona / lesson / preference）
 * @param source    来源（决定权威性，只接受 memoryStore 认得的 FactSource）
 * @returns 证据评分摘要，失败返回 null（调用方应静默忽略）
 */
export function recordEvidence(
  content: string,
  category: string,
  source?: string,
): { score: number; status: string } | null {
  if (!ensureReady()) {return null}
  const text = String(content || '').trim()
  if (!text) {return null}

  try {
    const kind = CATEGORY_TO_EVIDENCE[category] ?? 'fact'
    // 第 1 套的结论作为第 2 套的 sourceReliability —— 两套的唯一接口点。
    // 模型给不了 confidence，但 source 可以；权威性仍然只来自 source。
    const cap = SOURCE_CONFIDENCE[source as FactSource]
    const sourceReliability = cap?.default ?? 0.6

    const scored = getMemoryEvidence().addMemory({
      content: text,
      type: kind,
      sourceReliability,
      // 非 fact 类不额外抬重要性，避免"反思"因为类型本身就压过"事实"
      importance: kind === 'fact' ? 0.6 : 0.5,
      isNewSource: true,
    })
    return { score: scored.compositeScore, status: scored.status }
  } catch (e: any) {
    console.warn('[EvidenceBridge] 记录失败：', e?.message || e)
    return null
  }
}

/** 标记一条记忆被证伪（用户纠正 / 出现矛盾时调用） */
export function contradictEvidence(content: string): boolean {
  if (!ensureReady()) {return false}
  try {
    return getMemoryEvidence().contradictByContent(String(content || '')) !== null
  } catch {return false}
}

/**
 * 给 memory_search 工具的返回结果重排：已确认的排前面，被证伪的沉底。
 * 注意：这是记忆工具内的重排；回复前的自动召回走 hybridRecall（BM25+TF-IDF+RRF），
 * 不经此函数。
 */
export function rankByEvidence<T>(
  results: T[],
  /** 从条目里取用于比对证据链的文本（不同召回层的字段名不一致：事实用 content，混合检索用 entry.text） */
  getText: (item: T) => string,
): { ranked: T[]; demoted: number } {
  if (!ensureReady() || results.length === 0) {return { ranked: results, demoted: 0 }}
  try {
    const engine = getMemoryEvidence()
    const scored = new Map<string, ScoredMemory>()
    for (const s of engine.getMemoriesByScore()) {scored.set(s.content.slice(0, 80), s)}

    let demoted = 0
    const ranked = results.map(r => {
      const text = getText(r)
      const s = text ? scored.get(text.slice(0, 80)) : undefined
      if (s?.status === 'contradicted' || s?.status === 'outdated') {demoted++}
      return { item: r, boost: s ? (s.status === 'confirmed' ? s.compositeScore : -s.compositeScore) : 0 }
    })
    ranked.sort((a, b) => b.boost - a.boost)
    return { ranked: ranked.map(r => r.item), demoted }
  } catch {return { ranked: results, demoted: 0 }}
}

/**
 * 【尚未接线】设计意图：只有高置信（confirmed）的记忆才允许进 system prompt，
 * 模型看不到自己拿不准的东西，就不会拿它当权威事实去回答用户。
 * 当前生产路径的自动召回走 hybridRecall（BM25+TF-IDF+RRF），本函数暂无调用方。
 */
export function getVerifiedContext(maxMemories = 8): string {
  if (!ensureReady()) {return ''}
  try {
    return getMemoryEvidence().getPromptContext(maxMemories)
  } catch {return ''}
}

/** 证据链统计（给「记忆剧场」面板 / 诊断用） */
export function getEvidenceStats(): { total: number; confirmed: number; pending: number; outdated: number; contradicted: number } {
  if (!ensureReady()) {return { total: 0, confirmed: 0, pending: 0, outdated: 0, contradicted: 0 }}
  try {
    const e = getMemoryEvidence()
    const all = e.getMemoriesByScore()
    const by = (s: string) => all.filter(m => m.status === s).length
    return {
      total: all.length,
      confirmed: by('confirmed'),
      pending: by('pending'),
      outdated: by('outdated'),
      contradicted: by('contradicted'),
    }
  } catch {return { total: 0, confirmed: 0, pending: 0, outdated: 0, contradicted: 0 }}
}
