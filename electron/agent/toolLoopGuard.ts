// ============================================================
// agent/toolLoopGuard.ts — 工具死循环检测（纯函数，可单测）
//
// 【为什么单独抽出来】
//   这段逻辑原先内联在 agentRunner.ts 的 ReAct 主循环里，**无法单测** ——
//   只能靠「读源码文本断言」来防回归，而那正是最脆弱的一种测试。
//   抽成纯函数后，可以直接跑真实场景验证阈值行为。
//
// 【它解决的问题（2026-10-11 实测）】
//   旧判据是「同一工具名在最近 30 次调用里出现 ≥5 次 → 封禁」。
//   但复杂问答**本来就可能连续搜索 5 次**（每次换关键词），于是搜索工具被误封，
//   模型只能凭记忆硬答 → 直接导致事实幻觉（实测编出过错误的产品名与发行日期）。
//   **越难的题越容易被封工具、越容易编** —— 这是个正反馈的坑。
//
// 【新判据：两级】
//   ① 同名 + **同参数** 重复 ≥3 次 → 真死循环（正常使用不会重复一模一样的调用）
//   ② 同名出现 ≥10 次             → 兜底上限（只有病态循环才会到）
// ============================================================

/** 同签名重复多少次判定为死循环 */
export const IDENTICAL_LOOP_THRESHOLD = 3
/** 同名调用多少次触发兜底上限 */
export const TOOL_OVERUSE_THRESHOLD = 10
/** 滑动窗口大小（保留最近多少次调用） */
export const TOOL_WINDOW = 30

export type ToolLoopReason = 'identical-loop' | 'overuse'

export interface ToolLoopVerdict {
  /** 需要封禁的工具名；无需封禁时为 null */
  tool: string | null
  /** 触发原因；无则 null */
  reason: ToolLoopReason | null
  /** 命中的重复/调用次数 */
  count: number
}

/** 安全序列化工具参数（循环引用/不可序列化时退化为空串，不抛错） */
function safeStringify(args: unknown): string {
  // 显式写两个比较，避免 eqeqeq 规则（`== null` 语义上等价但会被 lint 拦下）
  if (args === null || args === undefined) {return ''}
  if (typeof args === 'string') {return args}
  try { return JSON.stringify(args) } catch { return '' }
}

/** 构造「工具名 + 参数」签名 —— 用来区分「真死循环」与「合理的多次调用」 */
export function buildToolSignature(name: string, args: unknown): string {
  return `${name}|${safeStringify(args)}`
}

function countBy(list: string[]): Record<string, number> {
  return list.reduce<Record<string, number>>((acc, s) => {
    acc[s] = (acc[s] || 0) + 1
    return acc
  }, {})
}

/**
 * 判定是否存在工具死循环。
 *
 * @param toolNames  最近调用的工具名（扁平列表，可含重复）
 * @param signatures 最近调用的「名字+参数」签名（与 toolNames 一一对应）
 */
export function detectToolLoop(toolNames: string[], signatures: string[]): ToolLoopVerdict {
  // ① 同签名（同名 + 同参数）重复 → 真死循环
  const sigFreq = countBy(signatures || [])
  const loop = Object.entries(sigFreq).find(([, c]) => c >= IDENTICAL_LOOP_THRESHOLD)
  if (loop) {
    return { tool: loop[0].split('|')[0], reason: 'identical-loop', count: loop[1] }
  }

  // ② 同名出现次数过多 → 兜底上限
  const nameFreq = countBy(toolNames || [])
  const hot = Object.entries(nameFreq).find(([, c]) => c >= TOOL_OVERUSE_THRESHOLD)
  if (hot) {
    return { tool: hot[0], reason: 'overuse', count: hot[1] }
  }

  return { tool: null, reason: null, count: 0 }
}

/** 给思考面板/日志用的一句话原因 */
export function describeLoopTrigger(reason: ToolLoopReason): string {
  return reason === 'identical-loop' ? '以完全相同的参数重复调用' : '调用次数过多'
}

/**
 * 构造注入给模型的「停止提示」。
 *
 * ⚠️ 这段是**给模型看的内部状态**，绝不能原样出现在给用户的话里。
 *    历史教训：旧文案写「请用已有信息直接回复」，等于推着模型凭记忆硬答 ——
 *    实测出现「搜索被封 → 编造错误产品名与发行日期」的严重幻觉；
 *    而「封禁」一词也被模型原样复述给用户（"搜索工具被临时封禁了"）。
 *    所以这里同时做三件事：① 标注内部状态、不得提及；
 *    ② 不鼓励"用已有信息回答"；③ 禁止对事实性问题凭记忆猜测。
 */
export function buildLoopStopMessage(count: number, reason: ToolLoopReason): string {
  const head = reason === 'identical-loop'
    ? `本轮有一个工具以完全相同的参数被重复调用 ${count} 次却未推进任务，现已暂停使用。`
    : `本轮有一个工具被调用 ${count} 次，已超过单轮上限，现已暂停使用。`
  return (
    `【内部状态·禁止向用户提及】${head}请不要再调用它。\n` +
    `接下来请遵守：\n` +
    `· 不要向用户提到任何工具名称，也不要提"封禁/暂停/限额"这类内部机制；用自然语言说明即可。\n` +
    `· **不要凭记忆猜测事实性问题**（日期、数字、版本号、价格、新闻、产品参数等）。` +
    `如果这类信息需要检索才能确认而现在查不到，就如实说"我现在查不到这条信息"，并说明可以稍后再试或请用户提供资料。\n` +
    `· 宁可承认不知道，也**绝不**给出一个看起来合理的答案。`
  )
}
