// ============================================================
// decisionService.ts — Agent 主动向用户征询决策 (v1.0)
//
// 【这是什么，和 approvalService 有什么区别】
// 这两件事**必须分开**，混在一起是设计错误：
//
//   approvalService（已有） = 「我可以做这件事吗？」
//     · 目的：安全闸门，防止 agent 做危险操作
//     · 形态：二值（同意 / 拒绝）
//     · 谁触发：系统检测到高风险工具调用时
//     · 不回答的后果：操作被拦截
//
//   decisionService（本文件） = 「你想走哪条路？」
//     · 目的：协作对齐，把选择权交还用户
//     · 形态：N 个选项 + 自由输入（图1 的形态）
//     · 谁触发：agent 遇到真正需要用户拍板的**分叉点**
//     · 不回答的后果：agent 按默认值继续，**不卡住**
//
// 一句话：审批是「刹车」，决策是「问路」。刹车坏了会撞人，问路坏了只是走错路。
//
// 【什么时候 agent 该问】
// 判据是「不同选择会导致显著不同的结果，且用户意图不可从上下文推断」：
//   ✓ 数据库选型、要不要破坏性操作、用哪个方案、是否继续某方向
//   ✗ 工具怎么调、先读哪个文件（这类自己定就行，问了反而烦人）
//
// 【绝不阻塞】
// 任何异常路径都必须让 agent 继续跑：没窗口、超时、用户没看、解析失败，
// 一律返回 timeout/cancelled 结果，由 agent 按预设默认值推进。
// ============================================================

import type { TeamMemberId } from './agentTeamTypes'

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

export interface DecisionOption {
  /** 选项 ID（agent 侧引用用，如 'option_a'） */
  id: string
  /** 简短标签，卡片主文案 */
  label: string
  /** 补充说明，卡片副文案 */
  description?: string
  /** 是否为推荐项（UI 会标注，排在前面） */
  recommended?: boolean
}

export type DecisionStatus = 'pending' | 'answered' | 'timeout' | 'cancelled'

export interface DecisionRequest {
  id: string
  /** 谁在问（lumina / yak / recha） */
  askedBy: TeamMemberId
  sessionId?: string
  /** 问题正文 */
  question: string
  /** 背景说明：为什么要问这个 */
  context?: string
  options: DecisionOption[]
  /** 是否允许多选 */
  multiSelect: boolean
  /** 是否允许用户自由输入（不选选项，直接打字） */
  allowCustomAnswer: boolean
  /** 用户的自由输入占位提示 */
  customPlaceholder?: string
  /** 超时毫秒；到期后 agent 按默认推进 */
  timeoutMs: number
  createdAt: number
  status: DecisionStatus
  /** 用户的回答 */
  answer?: DecisionAnswer
  resolvedAt?: number
}

export interface DecisionAnswer {
  /** 选中的选项 id 列表（多选时 >1） */
  selectedIds: string[]
  /** 选中的选项 label（冗余存一份，方便 agent 直接读，不用来回映射） */
  selectedLabels: string[]
  /** 用户自定义输入（与选项并存时表示"都要，但补充要求"） */
  customText?: string
  /** 用户主动取消 */
  cancelled?: boolean
}

export interface DecisionConfig {
  /** 总开关 */
  enabled: boolean
  /** 单个决策超时（默认 5 分钟；与审批一致） */
  defaultTimeoutMs: number
  /** 最多同时挂起的决策数，超出直接拒绝（防止 agent 疯狂提问） */
  maxPending: number
  /** 没回答时 agent 拿到的默认选项 id；为空表示「按第一项走」 */
  defaultOptionId?: string
  /** 无 UI 窗口时是否直接返回 timeout（true）还是假装已回答（false） */
  timeoutWhenNoWindow: boolean
}

export const DEFAULT_DECISION_CONFIG: DecisionConfig = {
  enabled: true,
  defaultTimeoutMs: 300_000,
  maxPending: 5,
  defaultOptionId: undefined,
  timeoutWhenNoWindow: true,
}

// ═══════════════════════════════════════════════════════════
// 内部状态
// ═══════════════════════════════════════════════════════════

interface PendingEntry {
  request: DecisionRequest
  resolve: (answer: DecisionAnswer) => void
  timer: ReturnType<typeof setTimeout> | null
}

let seq = 0
function genId(): string {
  seq += 1
  return `decision-${Date.now()}-${seq}-${Math.random().toString(36).slice(2, 6)}`
}

let config: DecisionConfig = { ...DEFAULT_DECISION_CONFIG }
const pending = new Map<string, PendingEntry>()

/** 订阅者：主进程 IPC 层注册，转发给渲染进程 */
type DecisionListener = (ev: DecisionEvent) => void
const listeners = new Set<DecisionListener>()

export type DecisionEvent =
  | { type: 'requested'; request: DecisionRequest }
  | { type: 'resolved'; id: string; status: DecisionStatus; answer?: DecisionAnswer }

export function onDecisionEvent(listener: DecisionListener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function emit(ev: DecisionEvent): void {
  for (const cb of listeners) {
    // 订阅者异常必须隔离——UI 挂了不能连带决策系统挂掉
    try { cb(ev) } catch { /* ignore */ }
  }
}

// ═══════════════════════════════════════════════════════════
// 配置
// ═══════════════════════════════════════════════════════════

export function getDecisionConfig(): DecisionConfig { return { ...config } }

export function setDecisionConfig(patch: Partial<DecisionConfig>): DecisionConfig {
  const rawMax = Number(patch.maxPending)
  const nextMax = Number.isFinite(rawMax) ? Math.max(1, Math.floor(rawMax)) : config.maxPending
  config = {
    ...config,
    ...patch,
    // 防御：负数/NaN 会让 setTimeout 立刻触发或永不触发
    defaultTimeoutMs: sanitizeTimeout(patch.defaultTimeoutMs, config.defaultTimeoutMs),
    // 注意：这里不能用 `x || 5`——那会把 0 当成「未设置」而兜底到 5，
    // 绕过掉「0 应该夹到 1」的语义。必须用 Number.isFinite 显式区分。
    maxPending: nextMax,
  }
  return { ...config }
}

function sanitizeTimeout(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : NaN
  if (!Number.isFinite(n) || n <= 0) {return fallback}
  return Math.floor(n)
}

// ═══════════════════════════════════════════════════════════
// 校验
// ═══════════════════════════════════════════════════════════

export interface DecisionValidation {
  ok: boolean
  errors: string[]
  /** 规整后的选项（去重、去空、推荐项唯一） */
  options: DecisionOption[]
}

export function validateDecisionInput(raw: {
  question?: unknown
  context?: unknown
  options?: unknown
  multiSelect?: unknown
  allowCustomAnswer?: unknown
  customPlaceholder?: unknown
  timeoutMs?: unknown
}): DecisionValidation {
  const errors: string[] = []

  const question = typeof raw.question === 'string' ? raw.question.trim() : ''
  if (!question) {errors.push('question 不能为空')}
  if (question.length > 500) {errors.push('question 超过 500 字上限')}

  // ── 选项规整 ──
  const out: DecisionOption[] = []
  const seenIds = new Set<string>()
  let recommendedCount = 0

  if (raw.options === undefined || raw.options === null) {
    errors.push('options 必填：决策必须至少给出可选项，否则用户无从选择')
  } else if (!Array.isArray(raw.options)) {
    errors.push('options 必须是数组')
  } else {
    if (raw.options.length === 0) {errors.push('options 不能为空数组')}
    if (raw.options.length > 8) {errors.push('options 最多 8 项（超过会让卡片过长，反而没人选）')}

    for (const o of raw.options as any[]) {
      if (!o || typeof o !== 'object') { errors.push('options 中存在非对象项'); continue }
      const label = typeof o.label === 'string' ? o.label.trim() : ''
      if (!label) { errors.push('options 中存在缺少 label 的项'); continue }
      if (label.length > 60) {errors.push(`选项 label 过长: ${label.slice(0, 20)}…`)}

      // id 缺省时用 label 派生（保证 UI 与 agent 侧引用稳定）
      const id = typeof o.id === 'string' && o.id.trim() ? o.id.trim() : `opt_${label}`
      if (seenIds.has(id)) { errors.push(`选项 id 重复: ${id}`); continue }
      seenIds.add(id)

      if (o.recommended) {recommendedCount++}
      out.push({
        id,
        label,
        description: typeof o.description === 'string' ? o.description.trim().slice(0, 200) : undefined,
        recommended: !!o.recommended,
      })
    }
  }

  // 推荐项最多一个——两个"推荐"等于没有推荐
  if (recommendedCount > 1) {
    errors.push('recommended 只能有一个；已自动保留第一个')
    let kept = false
    for (const o of out) {
      if (o.recommended && !kept) { kept = true } else { o.recommended = false }
    }
  }

  return { ok: errors.length === 0, errors, options: out }
}

// ═══════════════════════════════════════════════════════════
// 核心：发起决策
// ═══════════════════════════════════════════════════════════

export interface AskDecisionParams {
  askedBy: TeamMemberId
  sessionId?: string
  question: string
  context?: string
  options: DecisionOption[]
  multiSelect?: boolean
  allowCustomAnswer?: boolean
  customPlaceholder?: string
  timeoutMs?: number
}

export interface AskDecisionResult {
  status: DecisionStatus
  answer?: DecisionAnswer
  /** 直接给 agent 的一句话结论，省得它再去解析结构 */
  summary: string
}

/**
 * 发起一次决策并等待用户回答。
 *
 * **这个函数理论上可能挂住整条 agent 循环**，所以每条出口都必须存在：
 *  · 开关关闭        → 立即返回默认
 *  · 参数不合法      → 立即返回，让 agent 看到错误自己改
 *  · 挂起数超上限    → 立即返回
 *  · 无窗口          → 立即返回 timeout
 *  · 超时            → 定时器兜底
 *  · 异常            → resolve 永不被调用也不会泄露到调用方
 */
export function askDecision(params: AskDecisionParams): Promise<AskDecisionResult> {
  // ① 开关关闭
  if (!config.enabled) {
    return Promise.resolve(pickDefault(params.options, config.defaultOptionId, '决策功能已关闭'))
  }

  // ② 参数不合法 —— 不抛给调用方，让 agent 看到结构化错误后自行纠正
  const v = validateDecisionInput({
    question: params.question,
    options: params.options,
    allowCustomAnswer: params.allowCustomAnswer,
  })
  if (!v.ok) {
    return Promise.resolve({
      status: 'cancelled',
      summary: `决策请求无效：${v.errors.join('；')}。请修正后重试。`,
    })
  }

  // ③ 并发上限 —— agent 疯狂提问是真实风险，不能让 UI 被刷屏
  if (pending.size >= config.maxPending) {
    return Promise.resolve(pickDefault(params.options, config.defaultOptionId, `已有 ${pending.size} 个决策待回答，已达上限`))
  }

  // ④ 没有任何 UI 消费者时直接超时，别让 agent 白等
  if (listeners.size === 0) {
    return Promise.resolve(pickDefault(params.options, config.defaultOptionId, '当前没有可显示决策的界面'))
  }

  const timeoutMs = sanitizeTimeout(params.timeoutMs, config.defaultTimeoutMs)
  const request: DecisionRequest = {
    id: genId(),
    askedBy: params.askedBy,
    sessionId: params.sessionId,
    question: params.question.trim(),
    context: typeof params.context === 'string' ? params.context.trim().slice(0, 500) : undefined,
    options: v.options,
    multiSelect: !!params.multiSelect,
    allowCustomAnswer: params.allowCustomAnswer !== false,
    customPlaceholder: typeof params.customPlaceholder === 'string'
      ? params.customPlaceholder.slice(0, 60)
      : '补充你的想法，或输入其他答案',
    timeoutMs,
    createdAt: Date.now(),
    status: 'pending',
  }

  return new Promise<AskDecisionResult>((resolve) => {
    const entry: PendingEntry = { request, resolve: () => {}, timer: null }

    entry.resolve = (answer) => {
      const e = pending.get(request.id)
      if (!e) {return} // 已被超时/取消解决过，忽略迟到的回答
      if (e.timer) {clearTimeout(e.timer)}
      pending.delete(request.id)
      request.status = answer.cancelled ? 'cancelled' : 'answered'
      request.answer = answer
      request.resolvedAt = Date.now()
      emit({ type: 'resolved', id: request.id, status: request.status, answer })
      resolve({ status: request.status, answer, summary: buildSummary(request, answer) })
    }

    // ⑤ 超时兜底 —— agent 不会永远等下去
    entry.timer = setTimeout(() => {
      const e = pending.get(request.id)
      if (!e) {return}
      if (e.timer) {clearTimeout(e.timer)}
      pending.delete(request.id)
      request.status = 'timeout'
      request.resolvedAt = Date.now()
      emit({ type: 'resolved', id: request.id, status: 'timeout' })
      const d = pickDefault(request.options, config.defaultOptionId, `等待超时（${Math.round(timeoutMs / 1000)}s）`)
      // pickDefault 返回的是 summary 形态，这里补齐成完整结果
      const fallback = d.answer!
      request.answer = fallback
      resolve({ status: 'timeout', answer: fallback, summary: d.summary })
    }, timeoutMs)
    // Node 端不要因为一个挂起的决策而阻止进程退出
    if (typeof entry.timer.unref === 'function') {entry.timer.unref()}

    pending.set(request.id, entry)
    emit({ type: 'requested', request })
  })
}

/** 超时/拒绝/关闭时给 agent 的默认答案 */
function pickDefault(
  options: DecisionOption[],
  preferredId: string | undefined,
  reason: string,
): AskDecisionResult {
  const chosen = (preferredId && options.find(o => o.id === preferredId))
    || options.find(o => o.recommended)
    || options[0]

  if (!chosen) {
    return { status: 'timeout', summary: `${reason}；且没有可用的默认选项，请自行决定` }
  }
  const answer: DecisionAnswer = {
    selectedIds: [chosen.id],
    selectedLabels: [chosen.label],
  }
  return {
    status: 'timeout',
    answer,
    summary: `${reason}，已按默认选项「${chosen.label}」继续。如需改变请告知。`,
  }
}

/** 把回答压成一句话，agent 直接读这个就能继续干 */
function buildSummary(request: DecisionRequest, answer: DecisionAnswer): string {
  if (answer.cancelled) {return '用户取消了这次决策，请不要继续原方案，或改问其他方案。'}

  const labels = answer.selectedLabels.join('、')
  const custom = answer.customText?.trim()

  if (custom && answer.selectedIds.length > 0) {
    return `用户选择了：${labels}；并补充要求：${custom}`
  }
  if (custom) {return `用户没有选择预设选项，直接回答：${custom}`}
  if (request.multiSelect) {return `用户选择了：${labels}`}
  return `用户选择了：${labels}`
}

// ═══════════════════════════════════════════════════════════
// 回答 / 查询 / 取消
// ═══════════════════════════════════════════════════════════

export interface SubmitAnswerParams {
  id: string
  selectedIds: string[]
  customText?: string
  cancelled?: boolean
}

/** UI 提交回答。无效的 id 或选项会被拒绝，不会污染 pending 表。 */
export function submitDecisionAnswer(params: SubmitAnswerParams): { ok: boolean; error?: string } {
  const entry = pending.get(params.id)
  if (!entry) {return { ok: false, error: '决策已超时或不存在' }}

  if (params.cancelled) {
    entry.resolve({ selectedIds: [], selectedLabels: [], cancelled: true })
    return { ok: true }
  }

  const validIds = new Set(entry.request.options.map(o => o.id))
  const selected = (params.selectedIds || []).filter(id => validIds.has(id))

  if (selected.length === 0 && !params.customText?.trim()) {
    return { ok: false, error: '请至少选择一个选项，或输入自定义回答' }
  }
  if (selected.length > 1 && !entry.request.multiSelect) {
    return { ok: false, error: '该决策只允许单选' }
  }

  const labels = entry.request.options.filter(o => selected.includes(o.id)).map(o => o.label)
  entry.resolve({
    selectedIds: selected,
    selectedLabels: labels,
    customText: params.customText?.trim() || undefined,
  })
  return { ok: true }
}

/** 主动取消（用户点了 ×） */
export function cancelDecision(id: string): boolean {
  const entry = pending.get(id)
  if (!entry) {return false}
  entry.resolve({ selectedIds: [], selectedLabels: [], cancelled: true })
  return true
}

export function getPendingDecisions(): DecisionRequest[] {
  return [...pending.values()].map(e => e.request)
}

export function getDecisionById(id: string): DecisionRequest | undefined {
  return pending.get(id)?.request
}

/** 清空所有挂起决策（应用退出 / 用户点「全部取消」时用） */
export function cancelAllDecisions(): number {
  const n = pending.size
  for (const e of [...pending.values()]) {
    e.resolve({ selectedIds: [], selectedLabels: [], cancelled: true })
  }
  return n
}
