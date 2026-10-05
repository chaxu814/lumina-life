// ============================================================
// memoryRefiner.ts — 自动三层记忆精炼
//
// 从 agentRunner.ts 提取，负责：
//   Layer 1: 自动事实提取 (autoExtractFacts)
//   Layer 2: 自动反思生成 (autoGenerateReflections)
//   Layer 3: 自动人格更新 (autoUpdatePersona)
//
// 所有调用使用 10 秒超时，失败静默降级，不影响主对话
// v2.5 重构: 从 agentRunner.ts (785行) 提取至独立模块
// ============================================================

import { getMemoryStore, normalizeFactSource } from './memory/memoryStore'
import { globalEventBus, BusEvents } from './eventBus'
import { isEnabled } from './core/featureFlags'
// 🔧 P0-2：接入 LLM 优先级协调器，防止记忆精炼抢占用户对话的本地推理资源。
import { llmCoordinator, PRIORITY } from './llmCoordinator'
import type { AgentEvent } from './tools/types'
import type { RelationshipEventKind } from './memory/relationshipEvents'

// ═══════════════════════════════════════════════════════════
// MemoryRefiner 配置
// ═══════════════════════════════════════════════════════════

export interface RefinerConfig {
  baseUrl: string
  apiKey: string
  model: string
}

export const AUTO_REFINE_EVERY_N_TURNS = 8
export const globalTurnCount = 0

// ═══════════════════════════════════════════════════════════
// 🔧 P0-2 后台任务调度（2026-10-05）
//
// 【背景：为什么这里必须加闸门】
// autoRefine 一次会跑【4 次 LLM 调用】（事实 / 关系事件 / 反思 / 人格），
// 而且是在 agentRunner 一轮对话【刚结束】时立刻触发的。
//
// 在本地单卡推理（LM Studio + 消费级显卡）下，后果是：
//   用户上一条消息刚结束 → 记忆精炼的 4 次 prefill 抢占了整张卡
//   → 用户紧接着发下一条 → 请求排在 LM Studio 队列里等它跑完
//   → 界面表现：对话「时不时」卡一下。
// 这就是「间歇性卡顿」的完整成因 —— 它取决于后台任务那一刻有没有在跑。
//
// 【本函数的做法】
// 不自己实现排队，而是复用已有的 llmCoordinator（它已经实现了五级优先级、
// 用户活跃时暂停后台、空闲后逐级恢复）。记忆精炼属于 PRIORITY.MEMORY。
//
// 【为什么用 waitForPermission 而不是 requestPermission】
// 记忆精炼是「锦上添花」而非「必须有」：拿不到许可时直接放弃这一轮是
// 合理的，下次摘要触发时会自然补上。用 requestPermission 会静默丢弃，
// 用 waitForPermission 则会在用户空闲后自动补做 —— 不丢数据，也不抢资源。
// ═══════════════════════════════════════════════════════════

/** 等待许可的最长时间。超过则放弃本轮精炼，不阻塞调用方。 */
const REFINE_PERMISSION_TIMEOUT_MS = 8_000

/**
 * 自动三层精炼 — 从对话摘要中提取事实、反思、更新人格
 */
export async function autoRefine(
  config: RefinerConfig,
  emit?: ((event: AgentEvent) => void) | null
): Promise<void> {
  const store = getMemoryStore()
  if (!store) {return}

  // 🔧 P0-2：先要许可，拿不到就安静退出。
  if (!llmCoordinator.requestPermission('MemoryRefiner', PRIORITY.MEMORY)) {
    console.log('[MemoryRefiner] 用户活跃中，本轮精炼跳过（摘要数据不会丢，下次会补）')
    return
  }

  try {
    const summaries = store.getRecentSummaries?.(2) ?? []
    if (summaries.length === 0) {return}

    const combinedSummary = summaries.join('\n')

    // Layer 1: 事实提取
    await autoExtractFacts(config, combinedSummary)

    // Layer 1.5 (I4): 关系事件提取（叙事性，区别于客观事实）
    if (isEnabled('memory.relationshipEvents')) {
      await autoExtractRelationshipEvents(config, combinedSummary)
    }

    // Layer 2: 反思生成
    await autoGenerateReflections(config, combinedSummary)

    // Layer 3: 人格演化
    await autoUpdatePersona(config, combinedSummary)

    emit?.({ type: 'thinking', text: '🧠 三层记忆已自动精炼' })
    globalEventBus.emit(BusEvents.MEMORY_SUMMARIZED, { summary: '三层记忆精炼完成' })
  } catch (err) {
    console.error('[MemoryRefiner] 自动精炼失败:', err)
  } finally {
    // 🔴 必须在 finally 里释放。
    //   漏释放会让 runningRequests 里的 source 永远不被清除，
    //   后续 requestPermission 对这个 source 的判断会一直失真。
    llmCoordinator.releasePermission('MemoryRefiner')
  }
}

// ═══════════════════════════════════════════════════════════
// Layer 1: 自动事实提取
// ═══════════════════════════════════════════════════════════

export async function autoExtractFacts(
  config: RefinerConfig,
  text: string
): Promise<void> {
  try {
    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: `你是信息提取助手。从对话中提取客观事实，输出 JSON（仅 JSON，不要其他文本）：{"facts":[{"category":"user|environment|event|preference|habit","content":"事实描述","source":"user_stated|user_confirmed|model_inferred"}]}。最多 3 条事实。只在用户本轮对话里真的说过/确认过，才用 user_stated 或 user_confirmed；其余一律 model_inferred。不要输出 confidence——置信度由来源强度决定，不由模型自己判断。` },
          { role: 'user', content: `提取事实:\n${text.slice(0, 1000)}` },
        ],
        temperature: 0.1,
        max_tokens: 500,
      }),
      signal: AbortSignal.timeout(10000),
    })

    if (!res.ok) {return}
    const data = await res.json()
    const content = data.choices?.[0]?.message?.content || ''
    const jsonMatch = content.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {return}

    const parsed = JSON.parse(jsonMatch[0])
    const store = getMemoryStore()
    for (const fact of (parsed.facts || [])) {
      // 为什么丢掉 fact.confidence：LLM 说「这条有 0.95 的把握」是自我评价，不是证据。
      // 旧代码 `confidence: fact.confidence || 0.7` 等于让模型给自己发权威证书，
      // 幻觉一次就被写成 95% 确定的事实。现在只信 source，置信度由 store 按上限 clamp。
      // 另外这里整条链路都是模型输出（即使标了 observed 也只是模型"看到"的），
      // 所以旧枚举 observed/inferred 一律按 model_inferred 处理。
      store.addFact({
        category: fact.category || 'event',
        content: fact.content,
        source: normalizeFactSource(fact.source),
      })
    }
    console.log(`[MemoryRefiner] 自动提取 ${(parsed.facts || []).length} 条事实`)
  } catch { /* ignore */ }
}

// ═══════════════════════════════════════════════════════════
// Layer 1.5: 关系事件提取 (I4)
//
// 与 Layer 1「客观事实」互补：这里抓的是「你和用户之间的叙事性事件」——
// 承诺、共同完成的事、用户难过的时刻、争执、庆祝、小默契。
// 复用现有的 chat/completions 提取管道，不新写 LLM 调用器。
// ═══════════════════════════════════════════════════════════

const RELATIONSHIP_KINDS: RelationshipEventKind[] = [
  'promise', 'shared_achievement', 'sad_moment', 'argument', 'celebration', 'inside_joke',
]

export async function autoExtractRelationshipEvents(
  config: RefinerConfig,
  text: string
): Promise<void> {
  try {
    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: `你是「关系记忆」提取助手。从对话里找出 AI 助手（Lumina）与用户之间发生过的、有情感分量的叙事性事件，输出 JSON（仅 JSON）：
{"events":[{"kind":"promise|shared_achievement|sad_moment|argument|celebration|inside_joke","title":"不超过30字的事件摘要","detail":"一句补充说明（可空）","emotional_weight":0.0-1.0,"resolved":true|false}]}。

类别说明：
- promise：AI 答应/承诺过用户要做的事（resolved=false 表示还没兑现）
- shared_achievement：两人一起完成/做成的事
- sad_moment：用户流露难过、失落、压力的时刻
- argument：不愉快的争执或误会
- celebration：一起庆祝、开心的时刻
- inside_joke：只有你们俩懂的梗/玩笑

规则：只提取真正发生过、有情感分量的事，不要把普通闲聊硬塞进来；最多 3 条。` },
          { role: 'user', content: `从这段对话里提取关系事件：\n${text.slice(0, 1000)}` },
        ],
        temperature: 0.1,
        max_tokens: 500,
      }),
      signal: AbortSignal.timeout(10000),
    })

    if (!res.ok) {return}
    const data = await res.json()
    const content = data.choices?.[0]?.message?.content || ''
    const jsonMatch = content.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {return}

    const parsed = JSON.parse(jsonMatch[0])
    const store = getMemoryStore()
    let added = 0
    for (const ev of (parsed.events || [])) {
      const kind = RELATIONSHIP_KINDS.includes(ev.kind) ? ev.kind : null
      if (!kind || typeof ev.title !== 'string' || !ev.title.trim()) {continue}
      store.recordRelationshipEvent({
        kind,
        title: ev.title.trim(),
        detail: typeof ev.detail === 'string' ? ev.detail : '',
        emotional_weight: typeof ev.emotional_weight === 'number' ? ev.emotional_weight : undefined,
        resolved: typeof ev.resolved === 'boolean' ? ev.resolved : undefined,
      })
      added++
    }
    if (added > 0) {console.log(`[MemoryRefiner] 记录 ${added} 条关系事件`)}
  } catch { /* 静默降级，不影响主对话 */ }
}

// ═══════════════════════════════════════════════════════════
// Layer 2: 自动反思生成
// ═══════════════════════════════════════════════════════════

export async function autoGenerateReflections(
  config: RefinerConfig,
  text: string
): Promise<void> {
  try {
    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: `你是自我反思助手。基于对话反思助手表现，输出 JSON（仅 JSON）：{"reflections":[{"topic":"主题","insight":"洞察","action":"行动建议"}]}。最多 2 条反思。` },
          { role: 'user', content: `反思以下对话:\n${text.slice(0, 800)}` },
        ],
        temperature: 0.2,
        max_tokens: 400,
      }),
      signal: AbortSignal.timeout(10000),
    })

    if (!res.ok) {return}
    const data = await res.json()
    const content = data.choices?.[0]?.message?.content || ''
    const jsonMatch = content.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {return}

    const parsed = JSON.parse(jsonMatch[0])
    const store = getMemoryStore()
    for (const ref of (parsed.reflections || [])) {
      store.addReflection({
        topic: ref.topic || '未命名',
        insight: ref.insight || '',
        action: ref.action || '',
      })
    }
    console.log(`[MemoryRefiner] 自动生成 ${(parsed.reflections || []).length} 条反思`)
  } catch { /* ignore */ }
}

// ═══════════════════════════════════════════════════════════
// Layer 3: 自动人格更新
// ═══════════════════════════════════════════════════════════

export async function autoUpdatePersona(
  config: RefinerConfig,
  text: string
): Promise<void> {
  try {
    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: `你是人格分析助手。基于对话分析 AI 助手的性格特质变化。输出 JSON（仅 JSON）：{"traits":{"openness":0-1,"conscientiousness":0-1,"extraversion":0-1,"agreeableness":0-1,"playfulness":0-1},"tags":["标签1","标签2"]}。` },
          { role: 'user', content: `分析对话:\n${text.slice(0, 600)}` },
        ],
        temperature: 0.2,
        max_tokens: 300,
      }),
      signal: AbortSignal.timeout(10000),
    })

    if (!res.ok) {return}
    const data = await res.json()
    const content = data.choices?.[0]?.message?.content || ''
    const jsonMatch = content.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {return}

    const parsed = JSON.parse(jsonMatch[0])
    if (parsed.traits) {
      const store = getMemoryStore()
      const persona = store.getPersona()
      // 平滑更新 (30% 新 + 70% 旧)
      const oldTraits = persona?.traits || {}
      const oldOpenness = typeof oldTraits === 'object' && 'openness' in oldTraits ? (oldTraits as any).openness : 0.5
      const oldConscientiousness = typeof oldTraits === 'object' && 'conscientiousness' in oldTraits ? (oldTraits as any).conscientiousness : 0.5
      const oldExtraversion = typeof oldTraits === 'object' && 'extraversion' in oldTraits ? (oldTraits as any).extraversion : 0.5
      const oldAgreeableness = typeof oldTraits === 'object' && 'agreeableness' in oldTraits ? (oldTraits as any).agreeableness : 0.5
      const oldPlayfulness = typeof oldTraits === 'object' && 'playfulness' in oldTraits ? (oldTraits as any).playfulness : 0.5
      const updated = {
        openness: oldOpenness * 0.7 + (parsed.traits.openness ?? 0.5) * 0.3,
        conscientiousness: oldConscientiousness * 0.7 + (parsed.traits.conscientiousness ?? 0.5) * 0.3,
        extraversion: oldExtraversion * 0.7 + (parsed.traits.extraversion ?? 0.5) * 0.3,
        agreeableness: oldAgreeableness * 0.7 + (parsed.traits.agreeableness ?? 0.5) * 0.3,
        playfulness: oldPlayfulness * 0.7 + (parsed.traits.playfulness ?? 0.5) * 0.3,
        traits: parsed.tags || persona?.traits || [],
        evolutionLog: [...(persona?.evolutionLog || []), `v2.5 自动精炼: ${new Date().toISOString()}`],
        timestamp: new Date().toISOString(),
      }
      store.updatePersona(updated)
    }
  } catch { /* ignore */ }
}
