// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// rituals/templates.ts — 离线模板口播（纯函数，零依赖）
//
// 这是 LLM 不可用时的回退路径，产物 source 恒为 'template'。
// 模板必须用真实统计数字填空——不许编造「今天很努力」这种空话，
// 数字是 Day Replay 喂进来的真数据。
// ============================================================

import type { DailyReplayLike } from './types'

/** 从时间线里挑高光：优先非 error/skip 的条目，最多 3 条 */
export function pickHighlights(replay: DailyReplayLike, max = 3): string[] {
  const out: string[] = []
  for (const it of replay.items) {
    if (out.length >= max) {break}
    const kind = (it.kind || '').toLowerCase()
    if (kind === 'error' || kind === 'skip') {continue}
    const title = (it.title || '').trim()
    if (!title) {continue}
    out.push(title.length > 24 ? title.slice(0, 24) + '…' : title)
  }
  return out
}

/** 找一个小遗憾：时间线里的 error；没有就从统计里找最弱的一环 */
export function pickSmallRegret(replay: DailyReplayLike): string | null {
  const err = replay.items.find(it => (it.kind || '').toLowerCase() === 'error')
  if (err && err.title) {return err.title.length > 20 ? err.title.slice(0, 20) + '…' : err.title}
  if (replay.stats.turns > 0 && replay.stats.llmCalls === 0) {return '一整天没让我帮你动嘴，都是你自己在敲'}
  return null
}

/** 睡前复盘模板口播（100-150 字，第一人称陪伴感，真实数字） */
export function buildNightTemplate(replay: DailyReplayLike): string {
  const highlights = pickHighlights(replay)
  const regret = pickSmallRegret(replay)
  const s = replay.stats

  const highlightPart = highlights.length
    ? `今天你${highlights.slice(0, 2).join('、')}${highlights.length >= 2 ? '，还有别的零碎活' : ''}都收拾了。`
    : '今天的时间线安安静静，像是给自己留了一天。'

  const statPart = s.turns > 0
    ? `一共聊了 ${s.turns} 轮、跑了 ${s.commands} 条命令，${s.filesChanged} 个文件动过。`
    : ''

  const regretPart = regret ? `就是「${regret}」那一下，明天顺手补一下就好。` : ''

  return `嘿，该睡啦。${highlightPart}${statPart}${regretPart}钱花了 ${s.costYuan.toFixed(2)} 块，不贵，安心。把今天合上吧，明天我在这儿等你。晚安。`
}

/** Day Replay 完全没有数据时的兜底口播（不是「模板兜底」，是「素材缺失」兜底） */
export function buildNightNoDataTemplate(): string {
  return '今晚的复盘数据还没攒起来，可能是 Day Replay 还没跑起来。没关系，今天先好好休息，我在这儿陪你。晚安。'
}

// ── 晨间简报 ──────────────────────────────────────────────

/** 聚合后的晨间素材（每段都是已格式化好的短文本，失败的源为 null） */
export interface MorningDigest {
  weather: string | null
  calendar: string | null
  todo: string | null
  tasks: string | null
}

/** 晨间模板口播：有什么报什么，缺的诚实省略，绝不编造天气 */
export function buildMorningTemplate(digest: MorningDigest): string {
  const parts: string[] = ['早上好呀，新的一天开始了。']

  if (digest.weather) {parts.push(`今天${digest.weather}。`)}
  if (digest.calendar) {parts.push(`日程上：${digest.calendar}。`)}
  if (digest.todo) {parts.push(`待办里还挂着${digest.todo}。`)}
  if (digest.tasks) {parts.push(`任务看板上${digest.tasks}没收尾。`)}

  const missingCount = [digest.weather, digest.calendar, digest.todo, digest.tasks].filter(x => x === null).length
  if (missingCount === 4) {
    return '早上好呀。今天的天气、日程、待办我暂时都没拉到数据，不过没关系——先从一件小事开始就好。我在这儿。'
  }

  parts.push('慢慢来，一件一件来。')
  return parts.join('')
}

/**
 * 把晨间素材压成给 LLM 的上下文（纯拼接，失败的源标注「暂不可用」）。
 * LLM prompt 里必须显式告诉模型哪些源缺了，不许它编天气。
 */
export function digestToLLMContext(digest: MorningDigest): string {
  const lines: string[] = []
  lines.push(digest.weather ? `【天气】${digest.weather}` : '【天气】暂不可用（不要编造任何天气信息）')
  lines.push(digest.calendar ? `【今日日程】${digest.calendar}` : '【今日日程】暂不可用')
  lines.push(digest.todo ? `【待办】${digest.todo}` : '【待办】暂不可用')
  lines.push(digest.tasks ? `【任务看板未完成】${digest.tasks}` : '【任务看板】暂不可用')
  return lines.join('\n')
}
