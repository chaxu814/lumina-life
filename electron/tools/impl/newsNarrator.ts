// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// impl/newsNarrator.ts — 新闻「人性化叙述」层 (v1.0)
//
// 解决什么问题：
//   原来推送邮件是把 RSS 标题原样堆成一列链接（还夹着 [[CDATA[...]]] 这类
//   解析残留），用户要自己点进去才知道发生了什么 —— 「只发网站，不要总结」。
//   这里在**已接入 LLM** 时额外跑一次调用，把当天的新闻写成一段人话：
//     1) lead      —— 今日导读（2~4 句，把一天的事串起来）
//     2) takeaway  —— 值得关注/不必在意的判断
//     3) items[]   —— 每条一句话点评（挂在原标题与链接上）
//   **没接 LLM 就不调** —— 走 assembleDigestBody 的 plain 模式，
//   只给标题 + 网址，不烧 token、不假装自己能总结。
//
// 设计约束（与 newsFilter 一致）：
//   - llmCall 由调用方注入，本模块不碰 providerManager，便于单测。
//   - LLM 返回必须能被容错解析；解析失败返回 null，调用方回退到 plain，
//     绝不让「模型抽风」导致整轮推送失败。
// ============================================================

import type { FilteredItem, LLMCallFn } from './newsFilter'

export interface NarratedItem {
  /** 对应传入 items 的下标 */
  index: number
  /** 一句话点评（人话，不是标题复读） */
  comment: string
}

export interface DigestNarrative {
  /** 今日导读 */
  lead: string
  /** 值得关注 / 提醒 */
  takeaway: string
  items: NarratedItem[]
}

export interface NarrateOptions {
  interests?: string
  /** 最多叙述多少条（其余条目在邮件里退化为纯链接行） */
  maxItems?: number
}

const DEFAULT_INTERESTS = 'AI 大模型、编程工具、开源项目、芯片、财经行情'

function buildPrompt(items: FilteredItem[], interests: string): string {
  const list = items
    .map((f, i) => {
      const summary = (f.item.summary || '').replace(/\s+/g, ' ').slice(0, 160)
      return `[${i + 1}] 标题：${f.item.title}
    来源：${f.item.source}
    摘要原文：${summary || '（无）'}`
    })
    .join('\n')

  return `# 任务：把今天的科技新闻写成一份"人话晚报"

你是一位科技主编。用户关注：${interests}

下面是从多个来源采集到的新闻（标题可能是外文，也可能有机器翻译腔）。请输出 JSON。

## 要求
1. **lead**：2~4 句"今日导读"。要有观点、有串联，不要写成条目罗列。
   例：「今天 AI 圈的重心明显从发模型转向打价格战……」；不要写「今天有 5 条新闻」。
2. **takeaway**：1 句，给用户一个**可执行的判断**（该关注什么 / 可以忽略什么 / 有什么风险）。
3. **items**：为**每一条**新闻写 1 句中文点评，30~60 字。
   - 说清"发生了什么 + 为什么值得看"，不要复读标题。
   - 允许把外文新闻的实质讲出来，不要留外文。
   - 语气：对朋友说话，不端着，不用"综上所述"这类公文腔。

## 输出格式（纯 JSON，不要 markdown 代码块）
{"lead": "...", "takeaway": "...", "items": [{"index": 1, "comment": "..."}, ...]}

## 新闻列表
${list}`
}

/** LLM 输出的期望形状（只取我们认的字段，其余忽略） */
interface RawNarrative {
  lead?: unknown
  takeaway?: unknown
  items?: unknown
}

/** 容错解析：LLM 经常给 markdown 包裹 / 前后废话 */
export function parseNarrativeJson(raw: string): DigestNarrative | null {
  if (!raw) {return null}
  let cleaned = raw.trim()
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()

  // 直接解析
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    // 抠出最外层 {...}
    const m = cleaned.match(/\{[\s\S]*\}/)
    if (!m) {return null}
    try { parsed = JSON.parse(m[0]) } catch { return null }
  }
  if (!parsed || typeof parsed !== 'object') {return null}
  const obj = parsed as RawNarrative

  const lead = typeof obj.lead === 'string' ? obj.lead.trim() : ''
  const takeaway = typeof obj.takeaway === 'string' ? obj.takeaway.trim() : ''
  const rawItems: unknown[] = Array.isArray(obj.items) ? obj.items : []

  const items: NarratedItem[] = []
  for (const it of rawItems) {
    if (!it || typeof it !== 'object') {continue}
    const { index, comment } = it as { index?: unknown; comment?: unknown }
    const idx = Number(index)
    const c = typeof comment === 'string' ? comment.trim() : ''
    if (!Number.isFinite(idx) || !c) {continue}
    items.push({ index: idx, comment: c })
  }

  // 一条都没写出来 = 等同于没总结，返回 null 让调用方走 plain
  if (!lead && items.length === 0) {return null}
  return { lead, takeaway, items }
}

/**
 * 生成新闻叙述。
 *
 * @returns 成功返回 narrative；LLM 不可用/超时/输出无法解析时返回 null，
 *          调用方据此回退到「只有标题和网址」的简报。
 */
export async function narrateDigest(
  filtered: FilteredItem[],
  llmCall: LLMCallFn,
  options?: NarrateOptions,
): Promise<DigestNarrative | null> {
  const { interests = DEFAULT_INTERESTS, maxItems = 20 } = options || {}
  if (filtered.length === 0) {return null}

  const sliced = filtered.slice(0, maxItems)

  try {
    const raw = await llmCall(
      '你是一位科技主编，擅长把枯燥的新闻写成有人味的中文导读。你只输出 JSON，不写任何解释。',
      buildPrompt(sliced, interests),
    )
    return parseNarrativeJson(raw)
  } catch (e) {
    // 失败不静默也不报错：调用方会退回 plain 模式，日志只留最短的标记。
    // 不打错误详情 —— 错误信息可能含 endpoint / key 片段。
    console.warn('[NewsNarrator] LLM 叙述失败，回退到简报模式')
    return null
  }
}
