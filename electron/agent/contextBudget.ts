/**
 * 上下文预算裁剪 —— 纯函数，可单测。
 *
 * ────────────────────────────────────────────────────────────
 * 【为什么要单独抽出来】
 *
 * 这段逻辑原来内联在 `agentRunner.trimContext()` 里，只能靠「读源码文本断言」
 * 防回归 —— 而那正是本项目最脆弱的测试形态（重构一次就失效一次）。
 *
 * 更关键的是它有一个**静默的致命失败**，实测于 2026-10-12：
 *
 *   用户问「尼古喵喵是什么」→ 模型连续搜索 5 次 → ReAct 循环耗尽 →
 *   走「总结轮」兜底 → 但总结轮的上下文里**没有用户的问题**（见下）→
 *   模型对着一条「请根据本轮对话给出一个简洁的自然语言回复」作答，
 *   回复：「抱歉，这是我们的第一次对话，还没有之前的对话内容可以参考。」
 *
 *   用户看到的是「AI 突然失忆」，真实原因是**问题在裁剪中被丢掉了**。
 *
 * 【两条必须守住的铁律】
 *
 *   1. **用户本轮的问题（mustKeep）绝不能被裁掉。**
 *      它是整轮对话唯一的锚点：丢了它，模型再怎么答都是错的 ——
 *      而且不会报错，只会输出一段看似合理却完全跑偏的话。
 *
 *   2. **裁剪结果必须以 user 消息开头。**
 *      裁剪时 system 会被提到最前（`[...sysMsgs, ...kept]`），如果 kept 的第一条
 *      是 assistant/tool，就凭空制造出「没有 user 锚点的半截上下文」。
 *      下游的 `ensureUserFirst()` 会把它整段删掉 —— 两个函数各自"看起来合理"，
 *      合起来却能把整段对话清空。**这里是本次故障的放大器。**
 * ────────────────────────────────────────────────────────────
 */

/** 参与裁剪的最小消息形状 */
export interface BudgetMessage {
  role: string
  content?: unknown
  tool_calls?: unknown[]
}

export interface TrimOptions<T> {
  /**
   * 必须保留的消息 —— 传**用户本轮问题的对象引用**。
   * 裁剪绝不会把它丢掉；万一被预算挤出，会被强制插回。
   * （允许传 null：调用方可能还没有本轮用户消息。）
   */
  mustKeep?: T | null
  /** 每条消息的固定开销（角色标记 / 分隔符），默认 4 token */
  perMessageOverhead?: number
  /** 预算被 system 占满时，问题之后最多再保留几条（用来保住工具结果） */
  maxTailWhenOverBudget?: number
}

export interface TrimResult<T> {
  messages: T[]
  /** 被裁掉的对话消息条数 */
  droppedHistory: number
  /** system 提示词自己就超出预算（此时会丢弃可选 system 块） */
  overBudget: boolean
  /** mustKeep 本来会被挤出，被强制救回 */
  mustKeepRescued: boolean
  /** 需要向上层提示的告警（例如 system 超预算） */
  warning?: string
}

/** 把消息 content 取成纯文本（多模态数组取其中的 text 部分） */
function toText(content: unknown): string {
  if (content === null || content === undefined) {return ''}
  if (typeof content === 'string') {return content}
  if (Array.isArray(content)) {
    return content
      .map(c => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string'
        ? String((c as { text: string }).text)
        : ''))
      .join('\n')
  }
  try { return JSON.stringify(content) } catch { return '' }
}

/** 缺省上下文窗口（探测失败时的保守值，与项目其它处保持一致） */
export const DEFAULT_CONTEXT_LIMIT = 32768
/** 预算安全系数：只用窗口的 85%，留 15% 给生成 */
const SAFE_RATIO = 0.85
/** 历史只占剩余预算的 90%，留一点余量给临时注入 */
const HISTORY_RATIO = 0.9
/** 至少保留的对话消息条数（避免只剩一条而失去上下文） */
const MIN_KEPT = 2

/**
 * 按上下文预算裁剪消息数组。
 *
 * @param messages  原始消息（含 system 与对话）
 * @param contextLimit 上下文窗口（token）；<=0 时用保守缺省
 * @param estimate  文本 → token 估算函数（注入以便单测，无需真实分词器）
 */
export function trimToBudget<T extends BudgetMessage>(
  messages: T[],
  contextLimit: number,
  estimate: (text: string) => number,
  opts?: TrimOptions<T>,
): TrimResult<T> {
  const per = opts?.perMessageOverhead ?? 4
  const maxTail = opts?.maxTailWhenOverBudget ?? 6
  const mustKeep = opts?.mustKeep ?? undefined

  const limit = contextLimit > 0 ? contextLimit : DEFAULT_CONTEXT_LIMIT
  const safeLimit = Math.floor(limit * SAFE_RATIO)

  const sysMsgs = messages.filter(m => m.role === 'system')
  const otherMsgs = messages.filter(m => m.role !== 'system')

  const estMsg = (m: BudgetMessage): number => estimate(toText(m.content)) + per
  const sysTokens = sysMsgs.reduce((sum, m) => sum + estMsg(m), 0)
  const historyBudget = safeLimit - sysTokens

  // ── 情况 A：system 提示词自己就吃满了预算 ──
  //
  //   此时必须做取舍。取舍顺序（按重要性）：
  //     ① 身份/工具说明（首条 system）—— 丢了模型就不知道自己是"谁"、能用什么工具
  //     ② 用户本轮的问题（mustKeep）  —— 丢了模型就是在答一道没有题面的题
  //     ③ 问题之后的少量消息（工具结果）—— 丢了模型没有素材，但至少知道被问什么
  //     ④ 其余注入的 system 块（知识库/搜索结果/日期…）—— 最该被牺牲的就是它们
  //
  //   旧实现保留「首条 + 末条 system + 最后 3 条非 system」，看起来克制，
  //   但「最后 3 条」往往是 tool/assistant 的尾巴，**问题并不在其中**。
  if (historyBudget <= 0) {
    const keepSys = sysMsgs.length > 0 ? [sysMsgs[0]] : []
    const startIdx = mustKeep ? otherMsgs.indexOf(mustKeep) : -1
    const tail = startIdx >= 0
      ? otherMsgs.slice(startIdx, startIdx + 1 + maxTail)
      : otherMsgs.slice(-(1 + maxTail))

    return {
      messages: [...keepSys, ...tail],
      droppedHistory: otherMsgs.length - tail.length,
      overBudget: true,
      mustKeepRescued: false,
      warning:
        `系统提示词 (${sysTokens} token) 已超出上下文预算 (${safeLimit} token)，` +
        '仅保留身份提示 + 本轮问题与最近工具结果。' +
        '请调大「设置 → LLM 模型 → 上下文窗口」，或精简自定义指令 / 关闭不必要的注入块。',
    }
  }

  // ── 情况 B：正常裁剪 —— 从后往前保留，直到接近历史预算 ──
  const kept: T[] = []
  let usedTokens = 0
  for (let i = otherMsgs.length - 1; i >= 0; i--) {
    const est = estMsg(otherMsgs[i])
    if (usedTokens + est > historyBudget * HISTORY_RATIO && kept.length >= MIN_KEPT) {break}
    kept.unshift(otherMsgs[i])
    usedTokens += est
  }

  // 铁律 1：本轮问题必须在场。被预算挤出去就强制插回最前
  //   （问题在"本轮"里是最早的一条，所以放最前不会打乱时序）
  let mustKeepRescued = false
  if (mustKeep && otherMsgs.includes(mustKeep) && !kept.includes(mustKeep)) {
    kept.unshift(mustKeep)
    usedTokens += estMsg(mustKeep)
    mustKeepRescued = true
  }

  // 铁律 2：结果必须以 user 开头，否则会制造出"孤立开头"，
  //   被下游 ensureUserFirst() 整段删除（本次故障的放大器）。
  //   仅在有 user 可保底时才裁，避免把历史清空。
  if (kept.some(m => m.role === 'user')) {
    while (kept.length > 0 && kept[0].role !== 'user') {kept.shift()}
  }

  return {
    messages: [...sysMsgs, ...kept],
    droppedHistory: otherMsgs.length - kept.length,
    overBudget: false,
    mustKeepRescued,
  }
}
