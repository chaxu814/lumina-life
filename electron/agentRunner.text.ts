// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// agentRunner.text.ts — 文本/错误格式化辅助 (v1.0)
//
// 【为什么抽出来】
//   agentRunner.ts 长期是一个 4000+ 行的单体，职责过载。项目已有先例
//   （agentRunner.preprocess.ts / agent/toolNoise.ts / llm/xmlToolCall.ts），
//   本文件沿用同一约定，把**纯函数**辅助块搬出来 —— 不改任何逻辑，
//   只降低单文件体积、提升外部贡献者可读性。
//
// 【为什么是安全的】
//   这些都是无副作用、无实例状态的纯函数（输入→输出），
//   agentRunner.ts 通过 import + re-export 保持既有调用点与测试不变。
// ============================================================

import type { AgentMessage } from './tools/types'

// ── 辅助函数 ──────────────────────────────────────────────

/** 将 AgentMessage content 安全转为字符串 */
export function toText(content: AgentMessage['content']): string {
  if (typeof content === 'string') {return content}
  if (Array.isArray(content)) {
    return content.map(part => part.text || '').join('')
  }
  return ''
}

// 借鉴 QwenPaw — 去掉全局黑名单，改为实例级单次跳过
//   QwenPaw 从不黑名单工具：每次请求都带 tools，模型自行处理。
//   只在当前实例中记录"本次请求因工具失败→下次不带工具"的临时标记。
//   新 AgentRunner 实例不受影响，旧实例可通过 reset() 清除。
const _globalToolBlacklistCount = 0  // 仅用于统计日志

/** 🆕 v3.9: 向后兼容存根 — 全局黑名单已移除，此函数为空操作 */
export function clearModelToolBlacklist(_model?: string): void {
  // 不再需要清除全局黑名单（黑名单已移除）
  // 保留此导出以避免现有调用报错
  void _globalToolBlacklistCount
}

// ───────────────────────────────────────────────────────────
// 失败原因分类
//
// 早前所有失败都回同一句"抱歉，出了点问题，请稍后重试"。问题有两层：
//   1. 用户分不清是模型超时、鉴权失败还是网络断了，没法采取任何行动
//   2. Agent 自己拿不到可据以调整策略的信号，只能原样失败
//
// 这里的取舍：**透出可行动的原因分类，但不透出原始错误串**——
// 原始串里常有 URL、本地路径、堆栈、密钥片段，直接回显既没用也不安全。
// ───────────────────────────────────────────────────────────
export type RunFailureKind =
  | 'timeout'        // 模型响应超时
  | 'auth'           // 鉴权 / 额度
  | 'rate_limit'     // 触发限流
  | 'network'        // 网络不可达
  | 'context_length' // 上下文超长
  | 'content_filter' // 被内容安全拦截
  | 'cancelled'      // 用户主动中止
  /** 🔧 2026-10-07 新增：团队成员没配 LLM —— 委托在第一步就失败 */
  | 'teammate_unconfigured'
  /** 🔧 2026-10-07 新增：工具被权限档位拦下（不是模型的问题，是等你批准） */
  | 'tool_permission'
  /** 🔧 2026-10-07 新增：工具执行失败（参数非法 / 目标不可用等） */
  | 'tool_failed'
  /** 🔧 2026-10-16 新增：服务端没有这个模型（模型名不是服务端的模型 ID） */
  | 'model_not_found'
  | 'unknown'

const FAILURE_PATTERNS: Array<[RunFailureKind, RegExp, string]> = [
  ['auth', /api[\s_-]?key|unauthorized|401|403|forbidden|invalid.*token|鉴权|密钥|额度|余额|quota/i,
    '模型服务的鉴权或额度有问题，请检查 API Key / 账户余额后重试。'],
  ['rate_limit', /rate[\s_-]?limit|429|too many requests|限流|频率/i,
    '触发了模型服务的频率限制，等几十秒后重试即可。'],
  ['timeout', /timeout|timed[\s_-]?out|超时|etimedout|aborted by timeout/i,
    '模型响应超时，这次没能在时限内完成。可以把问题拆小一点再问一次。'],
  ['context_length', /context[\s_-]?length|maximum context|too many tokens|上下文.*(超|长)/i,
    '这次对话的内容超出了模型的上下文容量。建议新开一轮对话，或先让我总结一下再继续。'],
  ['content_filter', /content[\s_-]?filter|content_policy|safety|敏感词|审核不通过/i,
    '请求被模型服务的内容安全策略拦截了，换一种问法通常就能通过。'],

  // 🔧 2026-10-16 新增：模型名对不上。
  // 【为什么必须单列】LM Studio 在「模型 ID 不存在」时返回的是
  //   400 + "No models loaded. Please load a model in the developer page…" ——
  //   这句话把人指向「你还没加载模型」，而真实原因是**名字写错了**：
  //   用户在 LM Studio 界面看到的是显示名（QwenPaw Flash 4B Q4），
  //   而 API 要的是模型 ID（qwenpaw-flash-4b@q4_k_m）。
  //   照 LM Studio 的原文去「加载模型」永远修不好，必须直接点出「用 ID 不要用显示名」。
  ['model_not_found', /no models? loaded|model[\s\S]{0,60}?(not[\s_-]*found|does not exist|unavailable)|unknown model|invalid model|模型(不存在|未找到|不可用)/i,
    '模型服务里找不到这个名字的模型。请到「设置 → LLM 模型」核对 Model 一栏，'
    + '必须填服务端给出的**模型 ID**，而不是界面上显示的友好名称 —— '
    + '例如 LM Studio 的 ID 形如 `qwenpaw-flash-4b@q4_k_m`（带 @量化后缀），'
    + '用「QwenPaw Flash 4B Q4」这样的显示名会被拒。'
    + '最快的办法是在该页点「获取模型列表」，从列表里直接选。'],
  ['network', /econnrefused|enotfound|econnreset|network|fetch failed|getaddrinfo|网络|连接/i,
    '连不上模型服务，请检查网络或代理设置。'],

  // 🔧 2026-10-07 新增：工具层的失败。
  // 【为什么要单列】实测 T3（「帮我写个爬虫，然后让团队审一下」）时，
  //   真实原因是 delegate_to 报「Yak 未配置 LLM」+ file_write 参数非法，
  //   但兜底文案说的是「模型服务返回了一个无法识别的错误」——
  //   **把「团队没配好」和「工具被拦」伪装成了「模型出问题」**，
  //   用户照着提示换一种问法、重试一百次也没用。
  //   这些失败**根本不在模型侧**，必须单列并给出能行动的建议。
  ['teammate_unconfigured', /未配置\s*LLM|not configured|未配置大模型|尚未配置/i,
    '团队里有成员还没配置大模型，这次没能派活出去。到「设置 → LLM 模型」给 Yak / 热茶各配一个模型就好了。'],
  ['tool_permission', /权限档位要求确认|需要用户批准|未获批准|requiresApproval|需要审批/i,
    '这次的操作被权限档位拦下了，需要你批准才能执行。回复 /approve 批准，或到发送栏右侧的权限选择器调高档位。'],
  ['tool_failed', /未执行成功|参数不是合法\s*JSON|不是合法\s*JSON|不在本轮可用|本轮未加载|工具\s*".*?"\s*不存在/i,
    '这次是工具没能执行成功（比如参数格式不对、或该能力本轮没加载），不是模型出错。换个更明确的说法通常就能走通。'],
]

/**
 * 所有"没有真的执行"的路径统一用它拼提示。
 *
 * 为什么要统一：模型拿到一段"⛔ 被拦截"的文字时，如果不知道这件事**根本没发生**，
 * 就很容易把它当成一次失败的结果继续推理（甚至当成事实写进答案）。
 * 明确写"这不是结果 + 禁止据此作答"是消除这类幻觉最有效的一句。
 *
 * 🆕 2026-10-11 追加两条纪律（实测踩过的坑）：
 *   ① **不要向用户复述内部机制** —— 旧版注入文案里的"封禁"被模型原样说给用户
 *      （"搜索工具被临时封禁了"）。这些 reason 串里都带工具名/审查/审批字样，
 *      模型必须知道"这是给我看的，不是给用户看的"。
 *   ② **不要因为查不到就凭记忆编** —— 检索类工具失败时，模型倾向于用参数记忆
 *      硬答，实测编出过错误的产品名与发行日期。这里明确压住。
 */
export function notExecutedNote(reason: string): string {
  return `⛔ 未执行成功（原因：${reason}）。以下是失败说明，**不是结果**。`
    + `禁止把这段内容当作事实依据继续推理，也禁止写进最终回答。`
    + `请改用其他可行方式重试；若确实做不到，就直接告诉用户"做不到 + 为什么"。`
    + `【内部说明·不要复述给用户】不要向用户提到工具名，也不要提"封禁/暂停/审查/审批/限额"这类机制。`
    + `更不要因为这次没查到就凭记忆猜事实（日期、数字、版本、价格等）——查不到就如实说"我现在查不到这条信息"。`
}

/** 工具返回 ok:false 时的回灌文本（ok:true 时原样返回 content） */
export function toolResultText(result: { ok: boolean; content?: string; error?: string }): string {
  return result.ok
    ? (result.content || '')
    : notExecutedNote(result.error || '未知错误')
}

/**
 * 把裁剪后的历史整理成"API 协议合法"的形态。
 *
 * 为什么需要：OpenAI 兼容协议要求 `role:'tool'` 消息必须**紧跟**一条带 `tool_calls`
 * 的 assistant 消息，且 tool_call_id 要能对上。直接 `slice(-N)` 很容易从半截开始，
 * 留下一堆没有父消息的孤儿 tool 消息 → 请求直接 400。
 * 早前恢复轮只留 `[system, user]`，协议上安全但会丢全部上下文；现在要保留上下文，
 * 就必须自己把协议补齐。
 *
 * 处理方式：孤儿 tool 消息降级成 user 角色的历史说明 —— 既不丢信息，也不违反协议。
 */
export function sanitizeHistoryForApi<T extends { role: string; content?: unknown; tool_calls?: unknown[]; tool_call_id?: string }>(
  msgs: T[],
): T[] {
  const out: T[] = []
  for (const m of msgs) {
    if (m.role !== 'tool') { out.push(m); continue }

    // 往前跳过已保留的连续 tool 消息，找到最近的一条**非 tool** 消息作为父。
    // 一条 assistant 可以带多个 tool_calls，后面会跟多条 tool 消息，
    // 只看紧邻的上一条会把第二条误判成孤儿。
    let j = out.length - 1
    while (j >= 0 && out[j].role === 'tool') { j-- }
    const parent = j >= 0 ? out[j] : undefined

    const parentHasCall =
      !!parent && parent.role === 'assistant' &&
      Array.isArray(parent.tool_calls) &&
      parent.tool_calls.some((tc) => (tc as { id?: string } | null)?.id === m.tool_call_id)

    if (parentHasCall) {
      out.push(m)
    } else {
      // 孤儿：降级为普通历史说明，保留内容但不假装它是一次合法的工具返回
      out.push({
        ...m,
        role: 'user',
        tool_calls: undefined,
        tool_call_id: undefined,
        content: `[历史工具结果·仅供参考] ${String(m.content ?? '')}`,
      } as T)
    }
  }
  return out
}

/** 把上述失败原因映射成一句用户能据此行动的说明；未知情况给通用但诚实的话术 */
export function describeRunFailure(raw?: string, opts?: { isLocal?: boolean }): string {  const s = String(raw || '')
  const isLocal = !!opts?.isLocal
  if (/abort|cancel|用户.*(中止|取消)/i.test(s)) {
    return '这次回答被中止了。'
  }
  for (const [kind, re, text] of FAILURE_PATTERNS) {
    if (re.test(s)) {
      // 🔧 2026-10-10：本地推理（LM Studio / Ollama）没有「账户余额」概念，
      //   把云端的「请检查 API Key / 账户余额」原样回给本地用户，会把人往错方向引
      //   （用户真的会去翻 OpenAI/DeepSeek 后台找余额）。本地鉴权失败通常是
      //   LM Studio 开了 Require Authentication、或误填了占位 key。
      if (kind === 'auth' && isLocal) {
        return '本地推理服务返回了鉴权失败（401/403）。本地 LM Studio / Ollama 默认不需要 API Key，'
          + '两种修法任选其一：'
          + '① 到 LM Studio 的 Developer 面板里关闭「Require Authentication」（推荐）；'
          + '② 在「设置 → LLM」里把对应供应商的 API Key 留空后保存。'
      }
      return text
    }
  }
  // 🔧 2026-10-07：原文案一口咬定「是模型服务返回的错误」。
  //   实测证明这个断言不成立 —— 工具被权限拦下、队友没配 LLM、参数非法，
  //   都会走到这个兜底。谎报成因会让用户朝错误方向排查（反复重装模型服务），
  //   而不去检查真正的问题。现在如实说「原因未归类」并列出几种可能。
  return '这次没能完成，原因没能自动归类 —— 可能是模型服务返回了异常，也可能是某个工具没执行成功' +
    '（权限拦截、参数异常、或依赖的成员没配置好）。换一种说法、或把任务拆小一点通常能解决；' +
    '如果反复出现，到「更多设置 → 诊断工具」看一眼具体报错。'
}

// ═══════════════════════════════════════════════════════════
// 历史形态修正 — 保证「第一条非 system 消息是 user」
// ═══════════════════════════════════════════════════════════

export interface EnsureUserFirstResult<T> {
  messages: T[]
  /** 丢弃了几条开头的孤立消息 */
  droppedLeading: number
  /** 是否插入了中性占位（仅当整段历史没有 user 时） */
  insertedPlaceholder: boolean
}

/**
 * 保证「第一条非 system 消息是 user」—— Qwen 等模型的 Jinja 模板硬要求。
 *
 * 【为什么不是"插入一条伪造的 user 消息"】
 *   历史实现会往 user 位置插入伪造消息（先是字面量「（继续）」，
 *   后来改成「【系统占位·不是用户发言】…不要把它当成新指令」）。
 *   但实测证明：**任何**伪造的 user 消息都可能被模型当成真消息来回应 ——
 *     · 「（继续）」       → 模型问「"（继续）"这个指示是什么意思？」
 *     · 「【系统占位…】」  → 模型回「明白了，收到。不会把这条系统消息当作新的指令。」
 *                            （这条回复把用户的真实问题整个吞掉了）
 *   只要往 user 位置塞东西，就有概率被"回应"。
 *
 * 【正确做法】优先**丢弃**开头的孤立 assistant/tool 消息 —— 它们没有对应的
 *   user，本身就是半截上下文。只有整段历史一条 user 都没有时（极罕见），
 *   才退化为最短的中性占位（'你好'）。
 *
 * 纯函数：返回新数组，不修改入参。
 */
export function ensureUserFirst<T extends { role: string }>(messages: T[]): EnsureUserFirstResult<T> {
  const out = [...(messages || [])]

  let firstNonSystem = out.findIndex(m => m.role !== 'system')
  if (firstNonSystem >= 0 && out[firstNonSystem]?.role !== 'user') {
    const firstUser = out.findIndex((m, i) => i > firstNonSystem && m.role === 'user')
    if (firstUser > firstNonSystem) {
      const droppedLeading = firstUser - firstNonSystem
      out.splice(firstNonSystem, droppedLeading)
      return {
        messages: out,
        droppedLeading,
        insertedPlaceholder: false,
      }
    }
  }

  const hasUser = out.some(m => m.role === 'user')
  firstNonSystem = out.findIndex(m => m.role !== 'system')
  const firstIsUser = firstNonSystem >= 0 && out[firstNonSystem]?.role === 'user'
  if (!hasUser || !firstIsUser) {
    const insertIdx = firstNonSystem >= 0 ? firstNonSystem : 1
    out.splice(insertIdx, 0, { role: 'user', content: '你好' } as unknown as T)
    return { messages: out, droppedLeading: 0, insertedPlaceholder: true }
  }

  return { messages: out, droppedLeading: 0, insertedPlaceholder: false }
}
