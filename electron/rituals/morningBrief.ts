// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// rituals/morningBrief.ts — 晨间简报引擎
//
// 聚合：天气（weatherBrief）+ 日历（calendar_list）+ 待办（todo list）
//       + 任务看板未完成（getTaskBoard）。
// 降级：任一源缺失/失败 → notes 诚实记一条，其余源照常；
//       全缺 → 纯问候模板。绝不编造天气。
// ============================================================

import type { RitualDeps, RitualRunRecord, RitualUtterance } from './types'
import { buildMorningTemplate, digestToLLMContext, type MorningDigest } from './templates'
import { presentUtterance } from './present'

export interface MorningRunOptions {
  manual?: boolean
  now?: () => number
  /** 注入素材源（测试用；生产由 productionAdapter 提供） */
  sources?: MorningSources
}

/** 四个素材源，全部可选；返回短文本摘要。生产适配器 lazy-require 对应 impl 函数 */
export interface MorningSources {
  weather?: () => Promise<string>
  calendar?: () => Promise<string>
  todo?: () => Promise<string>
  tasks?: () => Promise<string>
}

const MORNING_SYSTEM_PROMPT = `你是 Lumina，用户的桌面陪伴伙伴。把以下晨间素材组织成一段早安口播：
- 约 30 秒口播量：中文 80-140 字
- 第一人称，温暖自然，像早上打招呼
- 素材里标注「暂不可用」的部分直接省略，绝不要编造天气/日程内容
- 不要报流水账数字，挑最重要的一两句带过
只输出口播文本本身，不要标题、不要引号。`

/** 逐源聚合，失败的源记进 notes，绝不中断 */
export async function collectMorningDigest(sources: MorningSources): Promise<{ digest: MorningDigest; notes: string[] }> {
  const notes: string[] = []
  const digest: MorningDigest = { weather: null, calendar: null, todo: null, tasks: null }

  const pull = async (
    key: keyof MorningDigest,
    label: string,
    fn: (() => Promise<string>) | undefined,
  ): Promise<void> => {
    if (!fn) {
      notes.push(`${label}暂不可用`)
      return
    }
    try {
      const text = (await fn() || '').trim()
      digest[key] = text || null
      if (!text) {notes.push(`${label}暂无内容`)}
    } catch (e: any) {
      console.warn(`[Rituals] 晨间素材 ${label} 拉取失败:`, e?.message || e)
      notes.push(`${label}暂不可用`)
    }
  }

  await pull('weather', '天气', sources.weather)
  await pull('calendar', '日历', sources.calendar)
  await pull('todo', '待办', sources.todo)
  await pull('tasks', '任务看板', sources.tasks)

  return { digest, notes }
}

/** 生成晨间口播（LLM 优先，模板兜底）。永远返回有效文本，不抛错 */
export async function generateMorningUtterance(
  deps: RitualDeps,
  sources?: MorningSources,
): Promise<RitualUtterance> {
  const nowMs = deps.now ? deps.now() : Date.now()
  const { digest, notes } = await collectMorningDigest(sources || {})

  // LLM 路径
  if (deps.llmGenerate) {
    try {
      const prompt = `${MORNING_SYSTEM_PROMPT}\n\n【晨间素材】\n${digestToLLMContext(digest)}`
      const res = await deps.llmGenerate(prompt, { maxTokens: 360 })
      const text = (res?.text || '').trim()
      if (text) {
        return { kind: 'morning', text, source: 'llm', notes, createdAt: nowMs }
      }
    } catch (e) {
      console.warn('[Rituals] 晨间 LLM 失败，回退模板:', (e as any)?.message || e)
    }
  }

  return {
    kind: 'morning',
    text: buildMorningTemplate(digest),
    source: 'template',
    notes,
    createdAt: nowMs,
  }
}

/** 跑一次晨间简报完整流程。永不抛错 */
export async function runMorningBriefing(
  deps: RitualDeps,
  opts: MorningRunOptions = {},
): Promise<RitualRunRecord> {
  const nowMs = deps.now ? deps.now() : Date.now()

  if (!opts.manual && deps.budgetAllows && !deps.budgetAllows()) {
    return {
      kind: 'morning',
      at: nowMs,
      source: 'skipped',
      reason: '预算超限，非必要调用已暂停（95%/100% 档）',
      delivered: 'none',
      manual: false,
    }
  }

  const utterance = await generateMorningUtterance(deps, opts.sources)
  const { delivered } = await presentUtterance(utterance, deps)
  return {
    kind: 'morning',
    at: nowMs,
    source: utterance.source,
    text: utterance.text,
    delivered,
    manual: !!opts.manual,
  }
}
