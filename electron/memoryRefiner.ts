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

import { getMemoryStore } from './memory/memoryStore'
import { globalEventBus, BusEvents } from './eventBus'
import type { AgentEvent } from './tools/types'

// ═══════════════════════════════════════════════════════════
// MemoryRefiner 配置
// ═══════════════════════════════════════════════════════════

export interface RefinerConfig {
  baseUrl: string
  apiKey: string
  model: string
}

export const AUTO_REFINE_EVERY_N_TURNS = 8
export let globalTurnCount = 0

/**
 * 自动三层精炼 — 从对话摘要中提取事实、反思、更新人格
 */
export async function autoRefine(
  config: RefinerConfig,
  emit?: ((event: AgentEvent) => void) | null
): Promise<void> {
  const store = getMemoryStore()
  if (!store) return

  try {
    const summaries = store.getRecentSummaries?.(2) ?? []
    if (summaries.length === 0) return

    const combinedSummary = summaries.join('\n')

    // Layer 1: 事实提取
    await autoExtractFacts(config, combinedSummary)

    // Layer 2: 反思生成
    await autoGenerateReflections(config, combinedSummary)

    // Layer 3: 人格演化
    await autoUpdatePersona(config, combinedSummary)

    emit?.({ type: 'thinking', text: '🧠 三层记忆已自动精炼' })
    globalEventBus.emit(BusEvents.MEMORY_SUMMARIZED, { summary: '三层记忆精炼完成' })
  } catch (err) {
    console.error('[MemoryRefiner] 自动精炼失败:', err)
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
          { role: 'system', content: `你是信息提取助手。从对话中提取客观事实，输出 JSON（仅 JSON，不要其他文本）：{"facts":[{"category":"user|environment|event|preference|habit","content":"事实描述","confidence":0.0-1.0,"source":"user_said|observed|inferred"}]}。最多 3 条事实。` },
          { role: 'user', content: `提取事实:\n${text.slice(0, 1000)}` },
        ],
        temperature: 0.1,
        max_tokens: 500,
      }),
      signal: AbortSignal.timeout(10000),
    })

    if (!res.ok) return
    const data = await res.json()
    const content = data.choices?.[0]?.message?.content || ''
    const jsonMatch = content.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return

    const parsed = JSON.parse(jsonMatch[0])
    const store = getMemoryStore()
    for (const fact of (parsed.facts || [])) {
      store.addFact({
        category: fact.category || 'event',
        content: fact.content,
        confidence: fact.confidence || 0.7,
        source: fact.source || 'observed',
      })
    }
    console.log(`[MemoryRefiner] 自动提取 ${(parsed.facts || []).length} 条事实`)
  } catch { /* ignore */ }
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

    if (!res.ok) return
    const data = await res.json()
    const content = data.choices?.[0]?.message?.content || ''
    const jsonMatch = content.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return

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

    if (!res.ok) return
    const data = await res.json()
    const content = data.choices?.[0]?.message?.content || ''
    const jsonMatch = content.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return

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
