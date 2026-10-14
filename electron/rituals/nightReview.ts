// ============================================================
// rituals/nightReview.ts — 睡前复盘引擎
//
// 流程：
//   1. 预算守卫：budgetAllows()=false → 跳过，写原因记录，不碰 LLM
//   2. 取当天 Day Replay（注入；模块未就绪/抛错 → 空素材兜底模板）
//   3. LLM 口播（第一人称、陪伴感、100-150字）；失败/未配置 → 模板填空
//   4. 呈现链：TTS → 气泡 → 静默
// ============================================================

import type { DailyReplayLike, RitualDeps, RitualRunRecord, RitualUtterance } from './types'
import { buildNightNoDataTemplate, buildNightTemplate } from './templates'
import { presentUtterance } from './present'

export interface NightRunOptions {
  /** 手动触发（IPC）：视为用户主动发起，不查预算守卫 */
  manual?: boolean
  now?: () => number
}

export function emptyReplay(date: string): DailyReplayLike {
  return {
    date,
    items: [],
    stats: {
      commands: 0, filesChanged: 0, turns: 0, delegates: 0,
      llmCalls: 0, costYuan: 0, promptTokens: 0, completionTokens: 0,
      byAgent: {}, byPurpose: {},
    },
  }
}

const NIGHT_SYSTEM_PROMPT = `你是 Lumina，用户的桌面陪伴伙伴。根据用户今天的 Day Replay 时间线，写一段睡前口播：
- 约 30 秒口播量：中文 100-150 字
- 第一人称，像朋友一样轻声说话，温暖陪伴感，不要说教
- 挑 2-3 个今天的高光时刻带过，再轻轻提一个小小的遗憾
- 不要堆数据（不要说"你今天执行了 12 条命令"这种话），数字只在心里参考
- 结尾轻轻道晚安
只输出口播文本本身，不要标题、不要引号、不要解释。`

/** 生成口播文本（LLM 优先，模板兜底）。永远返回有效文本，不抛错 */
export async function generateNightUtterance(deps: RitualDeps): Promise<RitualUtterance> {
  const nowMs = deps.now ? deps.now() : Date.now()
  const date = new Date(nowMs).toISOString().slice(0, 10)

  // 1. 取 Day Replay（并行功能未就绪时任何失败都安全降级）
  let replay: DailyReplayLike
  let noData = false
  try {
    replay = deps.buildDailyReplay()
    if (!replay || !Array.isArray(replay.items)) {
      replay = emptyReplay(date)
      noData = true
    }
  } catch {
    replay = emptyReplay(date)
    noData = true
  }

  // 2. LLM 路径
  if (deps.llmGenerate) {
    try {
      const prompt = `${NIGHT_SYSTEM_PROMPT}\n\n【今天的时间线（JSON，仅供参考）】\n${JSON.stringify({
        items: replay.items.slice(-40).map(i => ({ kind: i.kind, title: i.title, detail: i.detail, actor: i.actor })),
        stats: replay.stats,
      })}`
      const res = await deps.llmGenerate(prompt, { maxTokens: 420 })
      const text = (res?.text || '').trim()
      if (text) {
        return { kind: 'night', text, source: 'llm', notes: noData ? ['Day Replay 暂无数据'] : [], createdAt: nowMs }
      }
    } catch (e) {
      console.warn('[Rituals] 睡前 LLM 失败，回退模板:', (e as any)?.message || e)
    }
  }

  // 3. 模板兜底
  return {
    kind: 'night',
    text: noData ? buildNightNoDataTemplate() : buildNightTemplate(replay),
    source: 'template',
    notes: noData ? ['Day Replay 暂无数据'] : [],
    createdAt: nowMs,
  }
}

/**
 * 跑一次睡前复盘完整流程。
 * @returns 运行记录（含跳过原因），永不抛错
 */
export async function runNightReview(
  deps: RitualDeps,
  opts: NightRunOptions = {},
): Promise<RitualRunRecord> {
  const nowMs = deps.now ? deps.now() : Date.now()

  // 预算守卫：非必要调用被暂停 → 跳过并写原因，不打断用户
  if (!opts.manual && deps.budgetAllows && !deps.budgetAllows()) {
    return {
      kind: 'night',
      at: nowMs,
      source: 'skipped',
      reason: '预算超限，非必要调用已暂停（95%/100% 档）',
      delivered: 'none',
      manual: false,
    }
  }

  const utterance = await generateNightUtterance(deps)
  const { delivered } = await presentUtterance(utterance, deps)
  return {
    kind: 'night',
    at: nowMs,
    source: utterance.source,
    text: utterance.text,
    delivered,
    manual: !!opts.manual,
  }
}
