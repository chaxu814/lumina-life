// ============================================================
// newsOrganizer.ts — 改造 3：让团队 agent 参与新闻整理
//
// 定位：在「采集 → 规则过滤/LLM 筛选 → 去重」之后，再加一层 agent 整理：
//   ① 归类打标签  ② 生成 2-3 句中文摘要与观点  ③ 去掉重复/低价值条目
//
// 三条设计红线：
//   1. **默认关闭**。每轮整理都是一次真实的 LLM 调用，有 token 成本，
//      且在无人值守的后台调度里不该默认烧钱。需用户在设置页显式开启。
//   2. **复用现有 agent 调用机制**。走 delegationManager.delegate()，
//      与 electron/team/adversarialReview.ts 同一套约定：
//        from 恒为 'lumina'（编排者），to 为目标成员（默认热茶 recha 做筛选挑错）
//   3. **失败必须优雅降级**。agent 未配置/超时/输出不可解析 → 原样返回
//      未整理的列表，绝不让新闻功能整体挂掉。
// ============================================================

import type { FilteredItem } from './newsFilter'
import type { TeamMemberId } from '../../agentTeamTypes'

export interface NewsOrganizerOptions {
  /** 交给 agent 整理的最大条数（控制 token 成本；越大越贵） */
  maxItems: number
  /** 目标成员；默认热茶 recha（筛选挑错） */
  agentId: TeamMemberId
  /** 委托超时（毫秒） */
  timeoutMs: number
  /** 用户兴趣，用于让 agent 判断相关性 */
  interests: string
  /** 委��失败后的重试次数；0 = 不重试（省 token） */
  maxRetries: number
}

export const DEFAULT_ORGANIZER_OPTIONS: NewsOrganizerOptions = {
  maxItems: 12,
  agentId: 'recha',
  timeoutMs: 120_000,
  interests: '',
  maxRetries: 0,
}

export interface OrganizerEntry {
  id: string
  tags: string[]
  summary: string
  opinion?: string
  keep: boolean
}

export interface OrganizeResult {
  /** 整理后的列表；失败时等于入参（原样） */
  items: FilteredItem[]
  /** 是否真的被 agent 整理过 */
  organized: boolean
  /** 是否走了降级路径 */
  degraded: boolean
  reason?: string
  agentId?: TeamMemberId
  elapsedMs: number
}

// ═══════════════════════════════════════════════════════════
// 纯函数：构建提示词
// ═══════════════════════════════════════════════════════════

/** 裁剪长文本，避免把整篇原文塞进提示词烧 token */
function clip(text: string | undefined | null, max: number): string {
  const s = (text || '').replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

export function buildOrganizerPrompt(
  items: FilteredItem[],
  interests: string,
): { systemPrompt: string; userContent: string } {
  const systemPrompt = [
    '你是 Lumina 团队的新闻整理助手。你的任务是整理一批已筛选的新闻，而不是复述它们。',
    '',
    '对每一条新闻，你要做三件事：',
    '1. 归类打标签：1-3 个中文标签（如 AI大模型 / 芯片 / 资本市场 / 开源项目）',
    '2. 写摘要与观点：summary 用 2-3 句中文说明「发生了什么 + 为什么重要」，',
    '   opinion 用 1 句给出你的判断（可为空字符串）。要具体，不要空话套话。',
    '3. 价值判断：keep=false 表示这条是重复报道、营销软文或无信息量的噪音，应当剔除。',
    '',
    '严格只输出一个 JSON 数组，不要任何解释文字、不要 markdown 代码块以外的包装。',
    '数组每项形如：',
    '{"id":"<原样回填的 id>","tags":["标签1"],"summary":"2-3句中文摘要","opinion":"一句判断","keep":true}',
  ].join('\n')

  const payload = items.map((it, idx) => {
    const n = it.item
    return [
      `【${idx}】id: ${n.id}`,
      `标题：${clip(n.title, 120)}`,
      `来源：${clip(n.source, 40)} | 分类：${n.category} | 热度：${n.hotScore}`,
      `摘要：${clip(n.summary || it.oneLiner || it.digest, 300)}`,
    ].join('\n')
  }).join('\n\n')

  const userContent = [
    interests ? `用户关注的话题：${interests}\n` : '',
    `以下是 ${items.length} 条新闻，请整理后按「重要性从高到低」排序输出：`,
    '',
    payload,
    '',
    `必须输出 ${items.length} 个对象，id 与上面完全一致。`,
  ].filter(Boolean).join('\n')

  return { systemPrompt, userContent }
}

// ═══════════════════════════════════════════════════════════
// 纯函数：解析 agent 输出
// ═══════════════════════════════════════════════════════════

/**
 * 从 agent 回复里抠出 JSON 数组。
 *
 * agent 经常在 JSON 外面裹一层解释或 ```json 围栏，直接 JSON.parse 会炸。
 * 这里做三层兜底：代码块 → 首个 [ 到末个 ] → 整段就是数组。
 * 全失败返回 null（调用方据此降级）。
 */
export function extractJsonArray(raw: string): unknown[] | null {
  if (!raw) {return null}
  const text = raw.trim()

  // ① ```json ... ``` 围栏
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidates = [fence?.[1], text].filter(Boolean) as string[]

  for (const candidate of candidates) {
    // ② 首个 [ 到末个 ]
    const start = candidate.indexOf('[')
    const end = candidate.lastIndexOf(']')
    if (start !== -1 && end > start) {
      const slice = candidate.slice(start, end + 1)
      try {
        const parsed = JSON.parse(slice)
        if (Array.isArray(parsed)) {return parsed}
      } catch { /* 继续尝试下一个候选 */ }
      // 退化：数组尾部可能带尾随逗号
      try {
        const fixed = slice.replace(/,\s*([\]}])/g, '$1')
        const parsed = JSON.parse(fixed)
        if (Array.isArray(parsed)) {return parsed}
      } catch { /* 继续 */ }
    }

    // ③ 整段就是数组
    try {
      const parsed = JSON.parse(candidate)
      if (Array.isArray(parsed)) {return parsed}
    } catch { /* 继续 */ }
  }
  return null
}

/** 校验并归一化单条 agent 输出 */
function normalizeEntry(raw: unknown): OrganizerEntry | null {
  if (!raw || typeof raw !== 'object') {return null}
  const o = raw as Record<string, unknown>
  const id = typeof o.id === 'string' ? o.id : typeof o.id === 'number' ? String(o.id) : ''
  if (!id) {return null}

  const tags = Array.isArray(o.tags)
    ? o.tags.filter((t): t is string => typeof t === 'string').slice(0, 5)
    : []

  const summary = typeof o.summary === 'string' ? o.summary.trim() : ''
  const opinion = typeof o.opinion === 'string' ? o.opinion.trim() : undefined

  return {
    id,
    tags,
    summary,
    opinion,
    // 默认保留：只有显式 false 才剔除（防止 agent 漏字段导致误删）
    keep: o.keep !== false,
  }
}

/**
 * 把 agent 输出应用到原始列表上。
 *
 * 关键取舍：**只信任 agent 的排序与文案，不信任它的删除**。
 * agent 说 keep=false 的条目只是被降权排到末尾，不会真的消失——
 * 因为误删新闻比多留一条噪音更糟。只有当 agent 明确返回了至少一条
 * keep=true 且整体解析成功时，才把 keep=false 的裁掉（见 applyDrops 参数）。
 *
 * @returns 整理后的列表；解析完全失败时返回 null
 */
export function applyOrganizerOutput(
  items: FilteredItem[],
  rawOutput: string,
  options: { applyDrops?: boolean } = {},
): { items: FilteredItem[]; keptCount: number; matched: number } | null {
  const parsed = extractJsonArray(rawOutput)
  if (!parsed) {return null}

  const byId = new Map(items.map(it => [it.item.id, it]))
  const entries: OrganizerEntry[] = []
  for (const p of parsed) {
    const e = normalizeEntry(p)
    if (e && byId.has(e.id)) {entries.push(e)}
  }
  if (entries.length === 0) {return null}

  const applyDrops = options.applyDrops ?? false
  const kept = entries.filter(e => e.keep)
  const dropped = entries.filter(e => !e.keep)

  const result: FilteredItem[] = []

  // keep=true：按 agent 给的顺序（importance 排序），并覆盖文案
  for (const e of kept) {
    const original = byId.get(e.id)!
    result.push({
      ...original,
      tags: e.tags.length > 0 ? e.tags : original.tags,
      oneLiner: e.summary || original.oneLiner,
      digest: e.summary || original.digest,
      reason: e.opinion || original.reason,
    })
  }

  // keep=false：默认仅降权排后；applyDrops=true 时直接剔除
  const droppedItems = dropped.map(e => ({ ...byId.get(e.id)!, reason: byId.get(e.id)!.reason }))
  if (applyDrops) {
    // 只在至少留下 1 条时才允许裁剪，避免 agent 误判导致空列表
    if (result.length > 0) {return { items: result, keptCount: result.length, matched: entries.length }}
  }
  result.push(...droppedItems)

  // agent 没提到的条目补回末尾（保证不丢新闻）
  const covered = new Set(entries.map(e => e.id))
  for (const it of items) {
    if (!covered.has(it.item.id)) {result.push(it)}
  }

  return { items: result, keptCount: kept.length, matched: entries.length }
}

// ═══════════════════════════════════════════════════════════
// 主流程：走 delegationManager
// ═══════════════════════════════════════════════════════════

/**
 * 交给团队 agent 整理新闻。**本函数保证不抛错。**
 *
 * @param items  已完成规则过滤/LLM 筛选的列表
 * @param enabled 用户开关（false 直接原样返回，不产生任何 LLM 调用）
 */
export async function organizeNewsWithAgent(
  items: FilteredItem[],
  options: Partial<NewsOrganizerOptions> = {},
  enabled = true,
): Promise<OrganizeResult> {
  const started = Date.now()
  const opts: NewsOrganizerOptions = { ...DEFAULT_ORGANIZER_OPTIONS, ...options }

  const degrade = (reason: string, agentId?: TeamMemberId): OrganizeResult => ({
    items,
    organized: false,
    degraded: true,
    reason,
    agentId,
    elapsedMs: Date.now() - started,
  })

  // 开关关闭 → 零调用、零成本
  if (!enabled) {return degrade('用户未开启 agent 整理（省电模式）')}

  if (!Array.isArray(items) || items.length === 0) {
    return degrade('无待整理内容')
  }

  // 省 token：只整理前 N 条
  const slice = items.slice(0, Math.max(1, opts.maxItems))
  const rest = items.slice(slice.length)

  let dm: { isConfigured: (id: string) => boolean; delegate: (from: string, req: any) => Promise<any> }
  try {
    // 动态 import 而非 require：既保持惰性加载（不把整条 agent 依赖链
    // 拽进调度器启动路径），又能在 ESM / vitest 下正确解析。
    const mod = await import('../../delegationManager')
    dm = mod.getDelegationManager()
  } catch (e: any) {
    return degrade(`委托管理器不可用: ${e?.message || e}`)
  }

  if (!dm || typeof dm.delegate !== 'function') {
    return degrade('委托管理器不可用')
  }

  // 未配置该成员 → 降级（不要去跑一个必然失败的委托）
  if (!dm.isConfigured(opts.agentId)) {
    return degrade(`${opts.agentId} 未配置（Agent 未就绪）`, opts.agentId)
  }

  const { systemPrompt, userContent } = buildOrganizerPrompt(slice, opts.interests)
  const task = [
    userContent,
    '',
    '---',
    `输出要求：严格只返回一个 JSON 数组，每个元素的 summary 用 2-3 句中文。`,
    systemPrompt,
  ].join('\n')

  let content = ''
  try {
    const res = await dm.delegate('lumina', {
      to: opts.agentId,
      task,
      // 'logic_check'：让 worker 以「挑错/判断是否值得留」的视角工作，
      // 语义上最贴近「归类 + 摘要 + 去低价值」三合一
      taskType: 'logic_check',
      context: `新闻整理任务，共 ${slice.length} 条；用户关注：${opts.interests || '(未设置)'}`,
      timeout: opts.timeoutMs,
      maxRetries: opts.maxRetries,
    })
    if (!res || res.success === false) {
      return degrade(`agent 整理失败: ${res?.error || '未知错误'}`, opts.agentId)
    }
    content = res.content || ''
  } catch (e: any) {
    return degrade(`agent 整理异常: ${e?.message || e}`, opts.agentId)
  }

  // applyDrops=true：产品需求明确要求「去掉重复/低价值条目」，
  // 所以这里允许 agent 真的裁掉 keep=false 的条目。
  // 安全兜底在 applyOrganizerOutput 内部：至少保留 1 条才会真的裁。
  const applied = applyOrganizerOutput(slice, content, { applyDrops: true })
  if (!applied) {
    return degrade('agent 输出无法解析为 JSON 数组，原样保留', opts.agentId)
  }

  const dropped = slice.length - applied.keptCount
  const finalItems = [...applied.items, ...rest]

  return {
    items: finalItems,
    organized: true,
    degraded: false,
    reason: `整理 ${applied.matched}/${slice.length} 条，保留 ${applied.keptCount} 条，剔除 ${dropped} 条`,
    agentId: opts.agentId,
    elapsedMs: Date.now() - started,
  }
}
