// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// news/recommendSelect.ts — 「为你推荐」快段的选品逻辑（纯函数）
//
// 【为什么要单独抽出来】
//   2026-10-20 加「为你推荐」时，排序/去重/来源分散全写在 systemIpc.ts 的
//   ipcMain.handle 里 —— 那段代码既不能单测（依赖 ipcMain 与 Electron 环境），
//   也没法复用（早晚会有第二个入口要同一套选品规则）。
//   抽成纯函数后：输入 NewsItem[]，输出选中的子集，零副作用、零依赖。
//
// 【规则】
//   1. 过滤掉没有标题或链接的脏数据（RSS 里确实会有）；
//   2. 话题加权：命中当前话题分类的条目 +1000 分，**不做硬过滤**——
//      否则某个话题当天没有对应分类时，整栏会空掉（比「不够精准」更糟）；
//   3. 同来源最多 2 条：避免整屏都是 Hacker News 的英文标题；
//   4. 先按 3 的规则取满 poolSize；不足时再放宽来源限制补齐。
// ============================================================

export interface RecommendCandidate {
  title?: string
  url?: string
  source: string
  category: string
  hotScore?: number
}

export interface SelectOptions {
  /** 当前话题偏好的分类（命中即加权，不排他） */
  categories?: string[]
  /** 最多取多少条（默认 8：给前端留出按 limit 截断的余量） */
  poolSize?: number
  /** 同一来源最多几条（默认 2） */
  perSourceMax?: number
}

const TOPIC_BOOST = 1000

export function selectRecommendations<T extends RecommendCandidate>(
  all: readonly T[],
  opts: SelectOptions = {},
): T[] {
  const poolSize = Math.max(1, opts.poolSize ?? 8)
  const perSourceMax = Math.max(1, opts.perSourceMax ?? 2)
  const catSet = new Set(opts.categories || [])

  const valid = (all || []).filter(i => i && i.title && i.url)
  if (valid.length === 0) {return []}

  const sorted = [...valid].sort((a, b) => {
    const aw = catSet.has(a.category) ? TOPIC_BOOST : 0
    const bw = catSet.has(b.category) ? TOPIC_BOOST : 0
    return (bw + (b.hotScore || 0)) - (aw + (a.hotScore || 0))
  })

  const picked: T[] = []
  const perSource = new Map<string, number>()
  for (const it of sorted) {
    if (picked.length >= poolSize) {break}
    const used = perSource.get(it.source) || 0
    if (used >= perSourceMax) {continue}
    perSource.set(it.source, used + 1)
    picked.push(it)
  }

  // 来源分散导致数量不够（比如只有一个源可用）→ 放宽限制补齐，
  // 宁可同源多几条，也不要整栏只有两条。
  if (picked.length < poolSize) {
    for (const it of sorted) {
      if (picked.length >= poolSize) {break}
      if (!picked.includes(it)) {picked.push(it)}
    }
  }

  return picked
}
