// ============================================================
// agentRunner.ts — Agent 执行引擎 (v3.8 重构)
//
// v3.8:  借鉴 QwenPaw — 去掉自定义首token超时 / 推理模型检测 / 连接心跳
// v3.5:  集成 Hook 系统 / Mission Mode / LSP 工具 / Model Cache
// v2.5:  提示词构建 → prompts/systemPrompt.ts
//        记忆精炼   → memoryRefiner.ts
//        本文件只保留核心运行循环
//
// v2.4:  工具超时+重试 + 并行执行 + 多 Agent 协作
// ============================================================

import type { AgentEvent, AgentRunConfig, AgentMessage, LLMToolCall } from './tools/types'
import { SEARCH_INTENT_PATTERNS, SEARCH_EXCLUDE_PATTERNS, COMPANION_CHAT_PATTERNS, COLLECT_INTENT_PATTERNS } from './agentRunner.constants'
import {
  getToolsetTools, toOpenAIFunctions, resolveToolset, getToolDef,
  executeTool, executeToolWithRetry, executeToolsParallel,
  groupParallelBatches,
  getToolNames,
} from './tools/registry'
import { registerAllTools } from './tools/index'
import { isToolAllowedForRole } from './rolePolicy'
import { parseXmlToolCalls as parseXmlToolCallsShared } from './llm/xmlToolCall'
import { applyEmotionGate, renderGateNotice } from './orchestration/emotionGating'
import { enterAgentContext } from './tools/agentRunContext'
import { getMemoryStore } from './memory/memoryStore'
import { getAgentChatsManager } from './agentChatsManager'
import { getAgentDialogManager } from './agentDialogManager'
import { ConversationSummarizer } from './memory/summarizer'
import { globalEventBus, BusEvents } from './eventBus'
import { buildSystemPrompt, recoverUnsummarizedHistory, CHAT_MODE_TOOLS } from './prompts/systemPrompt'
import { autoRefine, globalTurnCount } from './memoryRefiner'
import { getInjectionGuard } from './injectionGuard'
import { getManualSystem } from './manualSystem'
import { getSecurityGuard, GuardSeverity } from './securityGuard'
import { getApprovalService } from './approvalService'
import { ApprovalDecision } from './approvalTypes'
import { getSessionManager } from './sessionManager'
import { TokenEstimator } from './tokenEstimator'
import { needsCompaction, compactMessages } from './agentCompactor'

/**
 * 🧭 路由仲裁系统提示（只给「歧义任务」用）
 *
 * 纯正则路由对无代码关键词的请求必然失手（「这玩意跑起来就崩，帮我看看」），
 * 这种时候才花一次 token 让模型判一下该不该派活。输出必须极短（16 token 上限），
 * 答不出就静默退回纯规则，绝不阻塞首字响应。
 */
const ROUTE_ARBITER_SYSTEM = `你是任务路由器。只回答一个词，不要解释。
规则：
- lumina：闲聊、情感、查资料、写邮件、做计划、整理笔记、翻译、查天气 —— Lumina 自己能高质量答完
- yak：需要真正动手写/改代码、调试、重构、跑命令、装环境 —— 派给代码工程师
- recha：需要自我否定、挑逻辑漏洞、风险评估、方案对比 —— 派给审查员
用户请求：`
// Hook 系统
import { getHookManager } from './hooks/hookManager'
import type { HookContext, BeforeReasoningInput } from './hooks/types'
// P0: Scroll Context + ReMe Light
import { ScrollContext } from './memory/scrollContext'
import { ReMeLight } from './memory/remeLight'
// 模型能力缓存
import { getModelCapabilityCache } from './modelCapabilityCache'
// 本地 / 异构模型请求容错（400 自动降级：去 tools / 图片 / stream_options）
import {
  classifyModelError,
  degradeForKind,
  describeLimitation,
  isLocalEndpoint,
} from './core/modelCompat'
// 工具审批 UI
import { classifyApproval, formatDenyFeedback } from './tools/impl/approvalUI'
// 情绪 ↔ 游戏化桥接（静态导入，打包后动态 require 解析不到）
import { updateEmotion } from './gamification/emotionBridge'
// 诊断埋点
import { getDiagnosticsStore } from './ipc/diagnosticsIpc'
// Provider 档案 + 连接心跳
import { matchProfile, isReasoningModel, getRecommendedTimeout } from './providerProfiles'
import { checkConnectionAlive, isSlowModeActive, getSlowModeTimeout } from './llmRetry'
// 搜索预处理 — 在 LLM 调用前检测搜索意图并执行 web_search
import { webSearch } from './tools/impl/search'
// 内容收集预处理 — URL 抓取 + 批量收集
import { extractUrls, collectUrls, saveCollected } from './tools/impl/contentCollector'
// v6.0: Agent 独立 LLM 配置
import { getAgentConfig } from './agentConfig'
import { getDelegationManager } from './delegationManager'
// 🆕 Lucky 模式深度集成
import { checkLuckyModeForReAct, setState as setLuckyState, getConfig as getLuckyConfig, getState as getLuckyState } from './luckyModeIntegration'
// ═══════════════════════════════════════════════════════════
// v9.3: 独立 LLM 通信 + ReAct 循环模块
// ═══════════════════════════════════════════════════════════
import { LLMProvider } from './core/llmProvider'
import { ReActEngine } from './core/reactEngine'
import { getTeamRegistry } from './core/teamRegistry'
// ═══════════════════════════════════════════════════════════
// v9.2: 从 core/agentUtils 导入独立工具函数
// ═══════════════════════════════════════════════════════════
import {
  stripRepeatedBlocks as _stripRepeatedBlocks,
  stripFillerText as _stripFillerText,
  stripMetaCommentary as _stripMetaCommentary,
  stripLeakedOutput as _stripLeakedOutput,
  safeStripChain as _safeStripChain,
  normalizeDedupeKey as _normalizeDedupeKey,
  similarityRatio as _similarityRatio,
  isEmojiOnly as _isEmojiOnly,
  detectedContextCache as _detectedContextCache,
  KNOWN_MODEL_WINDOWS as _KNOWN_MODEL_WINDOWS,
} from './core/agentUtils'
import { cleanToolNoiseText } from './agent/toolNoise'

// ⚠️ 工具注册已从模块顶层移除（v3.34 断环修复）
//
// 旧代码在这里直接 `registerAllTools()`，但本文件的依赖链是环的：
//     tools/index.ts ──import──> impl/* ──> asyncTaskManager.ts
//                    ──import──> agentRunner.ts ──> registerAllTools()
//                                              │
//                     读 tools/index.ts 的模块级绑定 ──> 回到 TDZ
// 只要 agentRunner 先于 tools/index 完成求值（任何从 agentRunner 入口
// import 的测试、任何一次 import 顺序调整），就会抛
//     ReferenceError: Cannot access '_registered' before initialization
// 生产环境靠 main.ts 的 import 顺序侥幸没炸，属于「随时会被外部 PR 踩爆」
// 的定时炸弹。详见 electron/tools/registrationFlag.ts 的完整说明。
//
// 现在改为：main.ts 显式调用 + AgentRunner 构造函数兜底 + cli/index.ts 兜底，
// 三处都是幂等的（claimToolsRegistration 用 CAS 语义）。
// 行为不变，但不再依赖 import 顺序。

// ── 辅助函数 ──────────────────────────────────────────────

/** 将 AgentMessage content 安全转为字符串 */
function toText(content: AgentMessage['content']): string {
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
  ['network', /econnrefused|enotfound|econnreset|network|fetch failed|getaddrinfo|网络|连接/i,
    '连不上模型服务，请检查网络或代理设置。'],
]

/**
 * 所有"没有真的执行"的路径统一用它拼提示。
 *
 * 为什么要统一：模型拿到一段"⛔ 被拦截"的文字时，如果不知道这件事**根本没发生**，
 * 就很容易把它当成一次失败的结果继续推理（甚至当成事实写进答案）。
 * 明确写"这不是结果 + 禁止据此作答"是消除这类幻觉最有效的一句。
 */
export function notExecutedNote(reason: string): string {
  return `⛔ 未执行成功（原因：${reason}）。以下是失败说明，**不是结果**。`
    + `禁止把这段内容当作事实依据继续推理，也禁止写进最终回答。`
    + `请改用其他可行方式重试；若确实做不到，就直接告诉用户"做不到 + 为什么"。`
}

/** 工具返回 ok:false 时的回灌文本（ok:true 时原样返回 content） */
function toolResultText(result: { ok: boolean; content?: string; error?: string }): string {
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
export function sanitizeHistoryForApi<T extends { role: string; content?: any; tool_calls?: any[]; tool_call_id?: string }>(
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
      parent.tool_calls.some((tc: any) => tc?.id === m.tool_call_id)

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
export function describeRunFailure(raw?: string): string {
  const s = String(raw || '')
  if (/abort|cancel|用户.*(中止|取消)/i.test(s)) {
    return '这次回答被中止了。'
  }
  for (const [kind, re, text] of FAILURE_PATTERNS) {
    if (re.test(s)) {return text}
  }
  return '这次没能完成，是模型服务返回了一个无法识别的错误。换个说法或稍后重试通常能解决。'
}
// 工具调用噪声过滤器已抽取到 ./agent/toolNoise（cleanToolNoiseText，行为保持不变）

// ═══════════════════════════════════════════════════════════
// XML 格式 Tool Call 解析器
//
// ⚠️ 本函数已委托给 llm/xmlToolCall.ts（唯一事实源）。
// 历史上本文件有一份独立实现，只认 3 种格式，而 reactEngine 那份认 7 种。
// 两边不一致的直接后果：模型输出了本文件认不出的格式 → 解析返回 null
//   → XML 被删干净 → 回复凭空变空 → 用户看到「暂时无法生成有效回复」。
// 现在统一到一处，agentRunner 与 reactEngine 认得一样多。
//
// 保留本函数名是为了不破坏既有调用点与测试。
export function parseXmlToolCalls(text: string, knownTools?: Set<string>): LLMToolCall[] | null {
  const r = parseXmlToolCallsShared(text, knownTools)
  return r.calls.length > 0 ? r.calls : null
}

// ═══════════════════════════════════════════════════════════
// 搜索预处理 — 检测搜索意图并执行 web_search
//   解决本地 LLM 不支持 function calling 导致搜索工具无法触发的问题。
//   在用户消息发给 LLM 之前就完成搜索，将结果注入 system 消息。
//
//   v5.0.2: 扩展为三层检测 — 显式搜索 + 实时信息需求 + 事实型问题，
//   覆盖"没说搜但需要搜"的场景（如"最近A股怎么样"）
// ═══════════════════════════════════════════════════════════

/** 搜索意图检测模式 — 三层递进 */

/** 一条消息是否属于"不该自动联网"的自我指涉/陪伴闲聊 */
function isCompanionChat(text: string): boolean {
  return COMPANION_CHAT_PATTERNS.some(re => re.test(text))
}

async function preExecuteSearch(text: string, skipAutoSearch = false): Promise<string | null> {
  const trimmed = text.trim()

  // 显式关闭自动搜索（桌宠陪伴会话），或命中自我指涉/陪伴闲聊 → 直接不搜；模型之后仍可自行调用 web_search
  if (skipAutoSearch || isCompanionChat(trimmed)) {
    console.log(`[PreSearch] 🚫 跳过自动搜索（${skipAutoSearch ? '会话关闭自动搜索' : '自我指涉/陪伴闲聊'}）: "${trimmed.slice(0, 40)}"`)
    return null
  }

  // 获取当前日期，用于时效性查询注入
  const _now = new Date()
  const _dateStr = `${_now.getFullYear()}-${String(_now.getMonth()+1).padStart(2,'0')}-${String(_now.getDate()).padStart(2,'0')}`
  // ── 时效性判断（v12.0 重写：三层递进，更加灵活） ──
  //
  // 策略：不依赖穷举关键词，而是从"用户怎么说"来判断时效性。
  //
  // Layer 1: 时间词触发
  //   只要消息含"今天/最近/最新/现在/当前/实时/本月/本周/今日/这两天"等时间词，
  //   说明用户关心的是当下 → 直接视为时效性。无论问的是股票还是电影还是天气。
  //   例："今天北京天气" → ✅ | "最近有什么好电影" → ✅ | "现在黄金多少钱" → ✅
  //
  // Layer 2: 时效领域触发
  //   虽然没有时间词，但问的是天生有时效性的领域 → 也视为时效性。
  //   金融、新闻、天气、体育、科技、娱乐、政治、灾害…这些领域的数据每天变化。
  //   例："比特币怎么样" → ✅ | "湖人队比赛" → ✅ | "iOS 19 发布" → ✅
  //
  // Layer 3: 历史数据排除
  //   如果用户明确提到了往年日期（"2024年""去年""上个月"），不覆盖。
  //   例："2024年A股表现" → ❌ 不加日期 | "去年黄金价格" → ❌ 不加日期
  // ────────────────────────────────────────────────────────

  // Layer 1: 时间词（只要有，任何话题都变时效）
  const _HAS_TIME_WORD = /今天|今日|最近|最新|现在|当前|实时|本月|本周|这两天|眼下|这会儿|昨晚|今早|凌晨|刚刚|新(的)?[闻问]/

  // Layer 2: 时效领域（覆盖九大类）
  const _TIME_SENSITIVE_DOMAIN =
    // 金融投资
    /股票|股价|行情|走势|涨了|跌了|涨停|跌停|A股|美股|港股|基金|大盘|指数|期货|原油|黄金|白银|汇率|美元|人民币|比特币|加密货币|以太坊|区块[链连]|市值|成交量|资金|北向|南向|板块|概念股|估值|泡沫|回调|反弹|牛市|熊市|仓位|减持|增持|回购|分红|送股/
    // 公司财务
    .source + // 分开写避免超长 regex 可读性差，用 + 连接
    /|财报|业绩|营收|利润|净利润|毛利率|净利率|资产负债|现金流|评级|目标价|研报|公告|披露|上市|IPO|退市|ST/
    .source +
    // 新闻热点
    /|新闻|热点|头条|热搜|资讯|报道|消息|传闻|爆料|辟谣|声明|回应|抗议|示威|冲突|战争|停火|制裁|关税|贸易战/
    .source +
    // 科技数码
    /|科技|数码|手机|芯片|AI|人工智能|大模型|GPT|发布|上市|新品|销量|价格|降价|涨价|评测|跑分|系统|更新|升级|补丁|漏洞|破解/
    .source +
    // 体育娱乐
    /|体育|比赛|比分|赛果|联赛|NBA|CBA|英超|欧冠|世界杯|奥运|金牌|冠军|亚军|娱乐|票房|电影|电视剧|综艺|收视率|番位|热搜/
    .source +
    // 天气灾害
    /|天气|温度|降雨|降雪|台风|地震|海啸|洪水|干旱|高温|寒潮|预警|空气质量|雾霾|PM2[.]?5/
    .source +
    // 政治社会
    /|选举|投票|民调|总统|首相|总理|当选|就职|辞职|下台|政策|法规|立法|禁令|开放|限制|签证|移民|人口|GDP|通胀|CPI|失业率/
    .source +
    // 交通生活
    /|路况|航班|高铁|地铁|公交|油价|电价|水价|放假|假期|节日|春运|国庆|春节|五一|中秋/
    .source +
    // 医疗卫生
    /|疫情|病例|感染|疫苗|药物|获批|临床|试验|医保|集采|医院|挂号|健康/
  const _TIME_SENSITIVE_REGEX = new RegExp(_TIME_SENSITIVE_DOMAIN)

  // Layer 3: 历史数据排除（提到往年 → 不加今日日期）
  const _HISTORICAL_REF = /(?:去年|前年|上年|\d{4}\s*年|\d{4}\s*[–\-]\s*\d{4})/

  // ── 排除不搜的消息 ──
  for (const ex of SEARCH_EXCLUDE_PATTERNS) {
    if (ex.test(trimmed)) {
      // 🔧 2026-08-14: Rescue — 如果消息包含明显搜索意图关键词，不排除
      //   解决"打开看看最新的AI新闻"等混合指令被误拦截的问题
      const rescueSignals = /今天|今日|最近|最新|现在|当前|实时|本月|本周|[？?]|股票|新闻|天气|AI|人工智能|分析|对比|推荐|介绍|价格|行情|走势|发布|上市|销量|票房|比分|赛果|地震|台风|预警|汇率|比特币|加密货币|以太坊|区块[链连]|市值|成交量|资金|板块|概念股|估值|泡沫|回调|反弹|牛市|熊市|仓位|减持|增持|回购|分红|送股|财报|业绩|营收|利润|净利润|毛利率|净率|资产负债|现金流|评级|目标价|研报|公告|披露|上市|IPO|退市|ST|科技|数码|手机|芯片|大模型|GPT|评测|跑分|系统|更新|升级|补丁|漏洞|破解|体育|比赛|联赛|NBA|英超|欧冠|世界杯|奥运|金牌|冠军|亚军|娱乐|电影|电视剧|综艺|番位|热搜|路况|航班|高铁|地铁|公交|油价|电价|水价|放假|假期|节日|春运|国庆|春节|五一|中秋|疫情|病例|感染|疫苗|药物|获批|临床|试验|医保|集采|医院|挂号|健康|选举|投票|民调|总统|首相|总理|当选|就职|辞职|下台|政策|法规|立法|禁令|开放|限制|签证|移民|人口|GDP|通胀|CPI|失业率/
      if (rescueSignals.test(trimmed)) {
        console.log('[PreSearch] 🚪 排除模式命中但 Rescue 放行（含搜索意图关键词）')
        break
      }
      return null
    }
  }

  for (const pattern of SEARCH_INTENT_PATTERNS) {
    const match = trimmed.match(pattern.regex)
    if (!match) {continue}

    // 提取搜索查询词
    let query = (match[1] || trimmed)
      .replace(/[:：]\s*$/, '')   // 去冒号
      .replace(/[，,；;]\s*$/, '') // 去逗号
      .trim()
      .slice(0, 200)

    if (query.length < 2) {continue}

    // 🔧 2026-07-12: 清理 query 首部的"最近""今天"等时间词（防止搜索引擎把时间词当核心关键词）
    query = query.replace(/^(?:最近|今天|今日|现在|当前|眼下|这会儿|这两天|本周|本月)\s*(?:的|有|是)?\s*/i, '').trim()

    // 过滤无意义的查询词
    const noise = /^(一下|一下吗|看看|搜一搜|搜索|查查|查一下|搜一下|帮我|帮我搜|帮我查|这个|那个|这些|那些|它|他|她|我|你|怎么|什么|为什么|谁|多少|几|哪|吗|呢|吧|啊)$/i
    if (noise.test(query)) {continue}

    // ── v12.0 改进：三层时效性判断 ──
    //   Layer 1: 用户消息含时间词 → 必时效
    //   Layer 2: 属时效领域 → 时效
    //   Layer 3: 提到往年 → 排除
    //
    //   ✅ 覆盖场景：
    //     "今天北京天气" "最近有什么好电影" "比特币怎么样" "湖人比赛"
    //     "iOS 19 发布了？" "查一下五一放假安排" "油价又涨了？"
    //   ❌ 不追加日期：
    //     "2024年A股走势" "去年黄金价格" "巴菲特投资理念"
    const hasTimeWord = _HAS_TIME_WORD.test(trimmed)
    const inTimeDomain = _TIME_SENSITIVE_REGEX.test(query) || _TIME_SENSITIVE_REGEX.test(trimmed)
    const isHistorical = _HISTORICAL_REF.test(trimmed)

    const isTimeSensitive = (hasTimeWord || inTimeDomain) && !isHistorical
    if (isTimeSensitive && !query.includes(String(_now.getFullYear()))) {
      query = `${query} ${_dateStr}`
      console.log(`[PreSearch] 📅 时效性查询，追加日期后: "[${query}]" (时间词=${hasTimeWord}, 时效领域=${inTimeDomain})`)
    }

    // .x: 保护专有名词 — 对「汉字+数字」混合词（如"科创50"）加引号，防止百度拆词
    //   也处理数字在前的场景（如"50ETF"被拆成"50"+"ETF"）
    const _MIXED_NOUN = /[\u4e00-\u9fff]+(?:[\d]+(?:[\u4e00-\u9fff]+)?)|(?:[\d]+[\u4e00-\u9fff]+)/g
    const mixedMatches = query.match(_MIXED_NOUN)
    if (mixedMatches) {
      let protectedQuery = query
      for (const noun of mixedMatches) {
        // 跳过表年份/月份的结构（"2026年"、"7月"等）
        if (/^(?:\d+年|\d+月|\d+日)$/.test(noun)) {continue}
        // 跳过纯数字或纯汉字的
        if (/^\d+$/.test(noun) || /^[\u4e00-\u9fff]+$/.test(noun)) {continue}
        if (noun.length >= 3 && !protectedQuery.includes(`"${noun}"`)) {
          protectedQuery = protectedQuery.replace(noun, `"${noun}"`)
        }
      }
      if (protectedQuery !== query) {
        console.log(`[PreSearch] 🔒 专有名词加引号: "${query}" → "${protectedQuery}"`)
        query = protectedQuery
      }
    }

    try {
      console.log(`[PreSearch] 检测到意图 ["${pattern.description}": "${query}"]，执行搜索...`)
      // 时效性查询获取更多结果（10条），非时效性保持5条
      const searchCount = isTimeSensitive
        ? 10
        : Math.min(5, Math.max(3, Math.floor(query.length / 10)))
      // 🔧 2026-07-12: 默认引擎改为 baidu（中文搜索最准，之前 Bing 对时间词过度匹配）
      // .x: 方案 3 — 首次用 baidu；结果质量差时自动 fallback 到 bing
      const result = await webSearch({ query, engine: 'baidu', count: searchCount })
      const content = typeof result === 'string' ? result : (result.content || '')
      if (content && !content.includes('未找到结果') && !content.includes('搜索出错') && !content.includes('搜索超时')) {
        // .x: 质量检查 — 对混合词查询，百度结果过短或出现歧义时补查 Bing
        const hadMixedNoun = mixedMatches && mixedMatches.some(m => !/^(?:\d+年|\d+月|\d+日)$/.test(m) && m.length >= 3)
        const isBaiduQualityLow = hadMixedNoun && (
          content.length < 200 ||
          content.includes('（未找到有效结果）') ||
          content.split('\n\n').filter(l => /^\d+\./.test(l.trim())).length <= 1
        )
        if (isBaiduQualityLow) {
          console.log(`[PreSearch] ⚠️ 百度结果质量不佳（${content.length} 字符，${content.split('\n\n').filter(l => /^\d+\./.test(l.trim())).length} 条），尝试 Bing 补充...`)
          const bingResult = await webSearch({ query, engine: 'bing', count: searchCount })
          const bingContent = typeof bingResult === 'string' ? bingResult : (bingResult.content || '')
          if (bingContent && !bingContent.includes('未找到结果') && !bingContent.includes('搜索出错') && !bingContent.includes('搜索超时')) {
            console.log(`[PreSearch] ✅ Bing 补充成功，${bingContent.length} 字符`)
            return `【百度搜索】\n${content}\n\n【Bing 搜索补充】\n${bingContent}`
          }
        }
        console.log(`[PreSearch] 搜索完成，${content.length} 字符`)
        return content
      }
      console.log(`[PreSearch] 无结果: ${content?.slice(0, 80)}`)
    } catch (err: any) {
      console.warn(`[PreSearch] 搜索失败: ${err.message}`)
    }
    // 只匹配第一个命中的模式
    break
  }
  return null
}

/**
 * 🆕 v5.0.1: 收集预处理 — 检测 URL 或"收集"意图
 *
 * 两种触发方式：
 *   1. 用户消息直接包含 URL → 自动抓取
 *   2. 用户说"收集/汇总/爬这几个网页" → 提取 URL 后批量抓取
 *
 * 效果：抓取到的内容以 Markdown 格式注入系统消息，
 *   LLM 看到后直接总结/分析，无需调用工具。
 */

async function preExecuteCollect(text: string): Promise<string | null> {
  // Step 1: 检测是否有明确的"收集"意图（含 URL）
  const hasCollectIntent = COLLECT_INTENT_PATTERNS.some(p => p.test(text))
  const urls = extractUrls(text)

  if (urls.length === 0) {return null}

  // Step 2: 如果有收集意图或多于 1 个 URL，执行批量收集
  if (hasCollectIntent || urls.length >= 2) {
    try {
      console.log(`[PreCollect] 检测到收集意图，${urls.length} 个 URL，执行批量抓取...`)
      const result = await collectUrls(urls, 5000, 40000)
      
      // 尝试保存到文件
      let savedPath = ''
      try { savedPath = await saveCollected(result) } catch {}
      
      const successCount = result.items.filter(i => i.success).length
      console.log(`[PreCollect] 收集完成: ${successCount}/${urls.length} 成功`)
      
      let output = result.summary
      if (savedPath) {
        output += `\n\n📁 已保存到: ${savedPath}`
      }
      return output
    } catch (err: any) {
      console.warn(`[PreCollect] 收集失败: ${err.message}`)
    }
  }

  // Step 3: 单个 URL — 直接抓取注入
  if (urls.length === 1) {
    try {
      console.log(`[PreCollect] 检测到 URL: ${urls[0]}，自动抓取...`)
      const result = await collectUrls(urls, 8000, 30000)
      if (result.items.length > 0 && result.items[0].success) {
        const item = result.items[0]
        return `📄 网页内容 (${item.charCount} 字符)\n🔗 ${item.url}\n📌 ${item.title}\n\n---\n${item.content}`
      }
    } catch (err: any) {
      console.warn(`[PreCollect] URL 抓取失败: ${err.message}`)
    }
  }

  return null
}

// ═══════════════════════════════════════════════════════════
// 🆕 FIX-2: 统一预处理 — 合并 URL 收集 + 搜索预检查
//
// 之前: sendMessage 中分别调用 preExecuteSearch 和 preExecuteCollect，
//   两次 URL 提取、两次结果注入，逻辑分散，难以统一控制。
//
// 现在: 一次调用，按"先 URL 后搜索"的顺序执行，返回统一结果对象。
//   调用方只需处理 preprocessResult 即可同时获得两种预处理结果。
// ═══════════════════════════════════════════════════════════

/**
 * 统一预处理入口：按序执行 URL 收集 → 搜索预检查，返回合并结果。
 *
 * 执行顺序保证：
 *   1. URL/收集预处理优先 — 如果用户发了 URL，先抓取内容
 *   2. 搜索预检查次之 — 再判断搜索意图并搜索
 *
 * 返回 { collectResult, searchResult }，字段为 null 表示无需/无结果。
 */
export async function preProcessMessage(text: string, opts: { skipAutoSearch?: boolean } = {}): Promise<{
  collectResult: string | null;
  searchResult: string | null;
}> {
  // Step 1: URL/收集预处理（优先级高 — 用户明确给了 URL 就先抓取）
  const collectResult = await preExecuteCollect(text)

  // Step 2: 搜索预处理（普通搜索意图检查）
  const searchResult = await preExecuteSearch(text, opts.skipAutoSearch === true)

  return { collectResult, searchResult }
}

// ═══════════════════════════════════════════════════════════
// AgentRunner
// ═══════════════════════════════════════════════════════════

export class AgentRunner {
  private config: AgentRunConfig
  private messages: AgentMessage[] = []
  private onEvent: ((event: AgentEvent) => void) | null = null
  private abortController: AbortController | null = null
  private totalTokens = 0
  private turnCount = 0
  /** 🆕 v7.1: 跟踪 setHistory 注入的历史轮次，防止二重计数 */
  
  /** 🔧 P0: 获取当前压缩摘要 */
  getCompactedSummary(): string | null {
    return this._compressedSummary
  }

  /** 🔧 P0: 设置压缩摘要 */
  setCompactedSummary(summary: string): void {
    this._compressedSummary = summary
  }

private summarizer: ConversationSummarizer | null = null
  private sessionId: string
  /** 跟踪已持久化到 SQLite 的最后一条消息索引 */
  private lastPersistedIndex = -1
  /** P3-2: 跟踪已同步到 chats.json 的最后一条消息索引 */
  private _lastChatsPersistIndex = -1
  /** P4-1: 跟踪已同步到 dialog/ 的最后一条消息索引 */
  private _lastDialogPersistIndex = -1
  /** 崩溃恢复标记 */
  private isRecovering = false
  /** 🔧 v2.16: 健康检查缓存 — 同一 Agent 实例只检查一次 */
  private _healthChecked = false
  /** 🔧 v3.0: 首次调用标记 — 首次调用可能有模型冷启动延迟 */
  private _firstCallDone = false
  /** 🔧 v3.7: 模型 Ping 缓存 — 避免每次 callLLM 都发 Ping */
  private _modelPinged = false
  // P1: _autoContinueCount 已移除
  /** 🆕 v16.0-fix: 自动继续计数 — 防 isIntentOnly 死循环 */
  private _autoContinueCount = 0
  /** 🆕 v16.0-fix: 上一轮意图句式 hash — 检测重复循环 */
  private _lastIntentHash = ''
  /** 🆕 v3.9: 本轮 ReAct 是否已用过工具 */
  private _toolsUsedThisRun = false
  /** 🆕 v6.7: 本轮对话起点，恢复/去重只处理本轮内容 */
  private _runStartIndex = 0
  /** 🆕 v4.0: 社交模式 — ChatTrack 纯文本对话，不使用工具 */
  private _socialMode = false

  /** 🆕 v9.0: QwenPaw 风格压缩摘要缓存 — 跨轮次保留 */
  private _compressedSummary: string | null = null

  /** 🆕 v9.0: 情绪状态 — 由前端通过 IPC 设置，注入 system prompt */
  private _currentEmotion: { mood: number; energy: number; affinity: number; label?: string } | null = null

  /** 🆕 Lucky: 当前场景模式（由 modeManager 设置） */
  private _currentMode: string | undefined = undefined
  /** 🆕 Lucky: 当前 Agent 情绪（由 socialEngine 设置） */
  private _currentMood: string | undefined = undefined

  /** 🆕 v9.3: 独立 LLM Provider */
  private _llmProvider: LLMProvider | null = null
  /** 🆕 v9.3: 独立 ReAct Engine（保留供备用引用，不再用于主循环） */
  private _reactEngine: ReActEngine | null = null
  /** 🆕 v9.3: 是否使用新模块（已弃用 — FIX-3 统一走 runReActLoop） */
  private _useNewModules = true

  /** 🆕 P0: Scroll Context — 索引化历史记忆 */
  private _scrollContext: any = null
  /** 🆕 P0: ReMe Light — Markdown 知识库记忆 */
  private _remeLight: any = null

  /** 启用/禁用新模块（已弃用 — 保留 API 兼容） */
  setUseNewModules(enabled: boolean): void {
    this._useNewModules = enabled
    console.log(`[AgentRunner] 🔄 setUseNewModules 已弃用（FIX-3 后统一走 runReActLoop）: ${enabled}`)
  }

  /** 设置当前情绪状态（由前端IPC调用） */
  setEmotion(emotion: { mood: number; energy: number; affinity: number; label?: string }): void {
    this._currentEmotion = emotion
    // 同步到游戏化桥接（情绪 × XP 联动）
    try {
      updateEmotion(emotion)
    } catch (_) { /* gamification 模块未加载时静默 */ }
    // 更新 system prompt 中的情绪状态
    this.initSystemPrompt()
  }

  /** 🆕 Lucky: 设置当前场景模式（由 modeManager 调用） */
  setCurrentMode(mode: string): void {
    this._currentMode = mode
  }

  /** 🆕 Lucky: 设置当前 Agent 情绪（由 socialEngine 调用） */
  setCurrentMood(mood: string): void {
    this._currentMood = mood
  }

  /** 🆕 v5.2: 推理跟踪 — 用于思考过程展示 */
  private _reasoningStarted = false
  private _reasoningAccum = ''

  /** 🆕 v6.0: 委托管理器引用（由外部注入） */
  private _delegationManager: any = null

  /** 🆕 v4.0: 设置社交模式 */
  setSocialMode(enabled: boolean): void {
    this._socialMode = enabled
  }

  /** 🆕 v3.5: 构建 HookContext */
  private _buildHookContext(): HookContext {
    return {
      config: this.config,
      sessionId: this.sessionId,
      turnCount: this.turnCount,
      messages: this.messages.map(m => ({ role: m.role, content: m.content })),
    }
  }

  /**
   * 创建 Agent 执行器实例
   * @param config - 运行配置（模式、模型、API 密钥等），`mode` 默认为 `'agent'`
   */
  constructor(config: AgentRunConfig, options?: { sessionId?: string }) {
    // v3.34 断环修复：工具注册改为惰性兜底（main.ts / cli 也会显式调用，三处幂等）
    // 在这里而不是模块顶层调用，是因为构造时依赖图已 100% 求值，不会再落进 TDZ。
    registerAllTools()

    this.config = {
      temperature: 0.7,
      maxTokens: 8192,    // 输出 token 上限（非上下文窗口），8192 足够长回答+代码
      ...config,
      mode: config.mode || 'agent',
    }
    this.sessionId = options?.sessionId || `session-1786780079226`
    // this._sessionId = this.sessionId  // 移除：_sessionId 未定义

    // v6.0: Per-agent LLM — 从 TEAM_MEMBERS 读取独立配置
    this._applyAgentLlmConfig()

    // v6.0: 注入委托管理器
    if (getDelegationManager) {
      this._delegationManager = getDelegationManager()
    }

    // v5.0: 重新匹配 profile — 独立 LLM 可能有不同的能力（context/tools）
    //  必须在 _applyAgentLlmConfig() 之后，用实际使用的 baseUrl/model 匹配
    const profile = matchProfile(this.config.baseUrl, this.config.model)
    if (profile) {
      const ctx = profile.model.maxContextTokens || 256_000
      ;(this.config as any).contextWindow = ctx
      // 🔧 FIX: maxTokens 是「输出 token 上限」，不是上下文窗口大小。
      //   之前把 maxTokens 设成 ctx（如 256000），部分 API 会直接 400 报错，
      //   部分会静默截断。输出上限用合理默认值 8192，足够长回答+代码。
      //   仅当用户未配置或配置值异常大（>32768，误把上下文窗口当输出）时修正。
      if (!this.config.maxTokens || this.config.maxTokens > 32768) {
        ;(this.config as any).maxTokens = 8192
      }
      console.log(`[AgentRunner] 📐 profile 匹配: ${profile.model.category || 'unknown'}, context=${ctx}, maxOutput=${this.config.maxTokens}`)
    }

    // v3.0: 委托配置注入（setDelegateConfig 未实现，跳过）
    // 原 require('./tools/impl/team') 的 setDelegateConfig 不存在

    try {
      this.summarizer = new ConversationSummarizer(this.sessionId)
    } catch (err) {
      console.error('[AgentRunner] ConversationSummarizer 初始化失败:', err)
      this.summarizer = null
    }

    // 🆕 P0: 初始化 Scroll Context + ReMe Light
    try {
      this._scrollContext = new ScrollContext()
      this._scrollContext.init()
      this._remeLight = new ReMeLight()
      this._remeLight.init()
      console.log('[AgentRunner] ✅ Scroll Context + ReMe Light 初始化完成')
    } catch (err) {
      console.warn('[AgentRunner] ⚠️ Scroll/ReMe 初始化失败（不影响主流程）:', err)
    }

    const pending = recoverUnsummarizedHistory()
    if (pending.length > 0) {
      console.log(`[AgentRunner] 上次有未总结消息，将自动处理: ${pending.slice(0, 80)}...`)
    }

    // 初始化 LLM Provider + ReAct Engine
    // 🔧 FIX-3: LLMProvider 仍被创建，供 runReActLoop 内部的 callLLM 降级非流式使用
    //   ReActEngine 不再用于主循环，保留仅作为备选工具调用解析器的引用
    try {
      this._llmProvider = new LLMProvider({
        baseUrl: this.config.baseUrl || '',
        apiKey: this.config.apiKey || '',
        model: this.config.model || '',
        maxContextTokens: (this.config as any).contextWindow || 256_000,
        socialMode: !!this.config.socialMode,
        personaId: this.config.personaId,
      })
      this._reactEngine = new ReActEngine(
        {
          maxToolCalls: this.config.maxToolCalls ?? 30,
          personaId: this.config.personaId,
          sessionId: this.sessionId,
          socialMode: !!this.config.socialMode,
          skipApproval: !!this.config.skipApproval,
          model: this.config.model,
          baseUrl: this.config.baseUrl,
          apiKey: this.config.apiKey,
          mode: this.config.mode,
        },
        // LLM caller 包装 — 直接透传消息给 LLMProvider
        async (msgs, tools) => {
          if (!this._llmProvider) {
            return { error: 'LLMProvider 未初始化' }
          }
          return this._llmProvider.call(
            { messages: msgs, tools, trackReasoning: this.config.trackReasoning ?? true },
            {
              onThinking: (text) => this.emit({ type: 'thinking', text }),
              onThinkingStream: (text, isFirst, isLast) =>
                this.emit({ type: 'thinking_stream', text, isFirst, isLast }),
              onToolStart: (tool, args) => this.emit({ type: 'tool_start', tool, args }),
              onToolEnd: (tool, result) => this.emit({ type: 'tool_end', tool, result }),
            },
          )
        },
        {
          onThinking: (text) => this.emit({ type: 'thinking', text }),
          onThinkingStream: (text, isFirst, isLast) =>
            this.emit({ type: 'thinking_stream', text, isFirst, isLast }),
          onToolStart: (tool, args) => this.emit({ type: 'tool_start', tool, args }),
          onToolEnd: (tool, result) => this.emit({ type: 'tool_end', tool, result }),
          onError: (error) => this.emit({ type: 'error', error }),
          onTokenUpdate: (total, usage, delta) => {
            this.totalTokens = total
            this.emit({ type: 'token_update', totalTokens: total, usage, delta })
            globalEventBus.emit(BusEvents.AGENT_TOKEN_UPDATE, {
              totalTokens: total,
              promptTokens: usage.prompt_tokens,
              completionTokens: usage.completion_tokens,
            })
          },
        },
      )
    } catch (err) {
      console.error('[AgentRunner] v9.3 模块初始化失败:', err)
    }
  }

  // ── 桌面宠物状态更新 (v2.9 stub) ────────────────────

  updateAvatarState(_state: {
    currentExpression?: string
    expressionMix?: Array<{ expression: string; weight: number }>
    params?: Record<string, number>
  }): void {
    // 转发给全局事件总线（Live2D 已移除，保留接口兼容）
    globalEventBus.emit(BusEvents.AGENT_THINKING, { type: 'avatar', state: _state })
  }

  /**
   * v8.0: 应用 per-agent LLM 配置（所有 Agent 都生效）
   *
   * 从 AgentConfig 读取独立 LLM 配置，覆盖到当前 Runner 的 config。
   * v8.0: 不再区分「Lumina 保留外部配置 / Yak/Recha 使用独立配置」。
   *   每个 Agent 创建独立的 Runner，各自加载自己的 LLM 配置。
   */
  private _applyAgentLlmConfig(): void {
    const personaId = this.config.personaId
    if (!personaId) {return}

    try {
      const config = getAgentConfig()
      const agentId = personaId as string

      // ── 通用修复：自动跟随 .env，地址换了也能直接用 ──
      try {
        config.autoRefreshFromEnv(agentId as any)
      } catch (e) {
        console.warn(`[AgentRunner] autoRefreshFromEnv failed:`, e)
      }

      const llm = config.get(agentId as any)

      if (!llm.endpoint) {
        console.warn(
          `[AgentRunner] ⚠️ ${personaId} 未配置 endpoint → ` +
          `无法运行。请先在 .env 或 Lumina 设置中配置 LLM endpoint。`,
        )
        return
      }

      console.log(
        `[AgentRunner] 🔀 ${personaId} 使用独立 LLM: ` +
        `${llm.provider}/${llm.model} @ ${llm.endpoint}`,
      )

      // v8.0: 所有 Agent 都应用独立 LLM 配置
      if (llm.endpoint) {this.config.baseUrl = llm.endpoint}
      if (llm.model) {this.config.model = llm.model}
      if (llm.apiKey) {this.config.apiKey = llm.apiKey}
      if (llm.timeout) {(this.config as any).timeout = llm.timeout}
      if (llm.maxContextTokens) {
        (this.config as any).contextWindow = llm.maxContextTokens
        ;(this.config as any).maxTokens = llm.maxContextTokens
      }
    } catch (err) {
      console.warn(`[AgentRunner] 无法加载 AgentConfig:`, err)
    }
  }

  // ═════════════════════════════════════════════════════════
  // 公共 API
  // ═════════════════════════════════════════════════════════

  /**
   * 注册事件回调 — 每次 Agent 事件（thinking/tool_call/tool_result/response/error）通过此回调通知调用方
   */
  setEventCallback(cb: (event: AgentEvent) => void): void {
    this.onEvent = cb
  }

  /** 设置 Agent 运行模式 */
  setMode(mode: 'chat' | 'agent' | 'developer'): void {
    this.config.mode = mode
  }

  /** 中止当前运行的请求 */
  abort(): void {
    this.abortController?.abort()
  }

  /** v3.0: 公开的 run() 别名（供 AgentDelegationManager 调用） */
  async run(text: string): Promise<string> {
    return this.sendMessage(text)
  }

  /**
   * 🆕 v8.0: delegate() — 当前 Agent 委托任务给后台工作者
   * 
   * v8.0: 路由到目标 Agent 的独立 Runner，不再污染当前上下文。
   * 
   * @param to - 目标成员 ID ('yak' | 'recha')
   * @param task - 任务描述
   * @param taskType - 任务类型
   * @returns 委托结果
   */
  async delegate(
    to: 'yak' | 'recha',
    task: string,
    taskType: string,
    context?: string,
  ): Promise<{ success: boolean; content: string; error?: string }> {
    const dm = this._delegationManager
    if (!dm) {
      return { success: false, content: '', error: '委托管理器不可用' }
    }

    try {
      // v8.0: 传入 from 参数（当前 Agent 的 ID），DM 路由到目标 Runner
      const fromId = (this.config.personaId || 'lumina') as any
      // fix: 传最近 3 轮对话上下文（user + assistant），
      // 让 Worker 了解对话来龙去脉。仍过滤掉 system/tool 消息，
      // 避免泄漏 system prompt / 社交引擎注入 / 群聊标记。
      const defaultContext = this.messages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .slice(-6)  // 最后 3 轮 (user+assistant) × 3 = 6 条
        .map(m => {
          const prefix = m.role === 'user' ? '【用户】' : '【Lumina】'
          // v10.9: 多模态内容提取纯文本
          const text = Array.isArray(m.content)
            ? (m.content as any[]).filter(c => c.type === 'text').map(c => c.text || '').join(' ')
            : (m.content || '')
          return `${prefix}: ${text.slice(0, 1200)}`
        })
        .join('\n')
      // v02(问题 D): 同时传结构化对话历史 + 任务目标 + 项目上下文，
      //   Worker 不再只收到一段摘要文字。
      const history: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = this.messages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .slice(-12)
        .map(m => {
          const text = Array.isArray(m.content)
            ? (m.content as any[]).filter(x => x.type === 'text').map(x => x.text || '').join(' ')
            : (m.content || '')
          return { role: m.role as 'user' | 'assistant', content: String(text).slice(0, 1500) }
        })
      const result = await dm.delegate(fromId, {
        to,
        task,
        taskType: taskType as any,
        context: context || defaultContext || this._compressedSummary || undefined,
        taskGoal: task,
        conversationHistory: history,
        projectContext: { cwd: process.cwd() },
      } as any)

      return {
        success: result.success,
        content: result.content,
        error: result.error,
      }
    } catch (err: any) {
      return { success: false, content: '', error: err.message }
    }
  }

  /**
   * 🆕 v3.8: chat() — 供 AgentPool 向已有 Agent 发送消息
   * 
   * 与 sendMessage() 的区别：
   *   - sendMessage: 完整 ReAct 循环，重置一些状态
   *   - chat: 轻量追加消息，不重置上下文，适合 Agent 间频繁通信
   * 
   * @param text   - 消息文本
   * @param options - { maxToolCalls, timeoutMs }
   */
  async chat(
    text: string,
    options?: { maxToolCalls?: number; timeoutMs?: number; socialMode?: boolean },
  ): Promise<{ text?: string; toolCallsCount: number; error?: string }> {
    // 社交模式 — 忽略工具限制
    if (options?.socialMode) {
      this._socialMode = true
      this.config = { ...this.config, socialMode: true } // 🆕 v17.0-fix: 同步 config.socialMode，让所有下游检查一致生效
    }

    // 设置工具轮次上限
    if (options?.maxToolCalls !== undefined) {
      this.config.maxToolCalls = options.maxToolCalls
    }

    try {
      const result = await this.sendMessage(text)
      return {
        text: result,
        toolCallsCount: this.turnCount,
      }
    } catch (err: any) {
      return {
        text: undefined,
        toolCallsCount: 0,
        error: err.message,
      }
    } finally {
      // 恢复社交模式
      if (options?.socialMode) {
        this._socialMode = false
        this.config = { ...this.config, socialMode: false } // 🆕 v17.0-fix: 同步清除 config.socialMode
      }
    }
  }

  /**
   * compactContext() — QwenPaw 风格上下文压缩
   * 
   * 委托给 agentCompactor.ts 执行（已从本文件拆分出去）
   * 
   * 调用者：postProcess（每轮对话后）+ callLLM（LLM 调用前主动压缩）
   * 
   * P0: 支持 Scroll 模式 — 不压缩，仅索引化历史消息
   */
  compactContext(): void {
    try {
      const estimator = new TokenEstimator()
      const estimatedTokens = estimator.estimateMessages(this.messages)
      // 🔧 动态预算：使用模型实际上下文窗口，而非硬编码 128K
      const ctxWindow = (this.config as any).contextWindow || 0

      // 无需压缩 & 无已有摘要 → 跳过
      if (
        !needsCompaction(estimatedTokens, this.messages.length, ctxWindow) &&
        !this._compressedSummary
      ) {
        return
      }

      // 🆕 P0: Scroll 模式 — 不压缩，仅索引化
      const scrollModeEnabled = (this.config as any)?.scrollMode === true
      if (scrollModeEnabled && this._scrollContext) {
        const agentId = this.config.personaId as string | undefined
        const scrollResult = (this._scrollContext as any).evictToIndex(
          this.sessionId,
          agentId,
          this.messages,
        )
        if (scrollResult && scrollResult.evictedCount > 0) {
          this.messages = this.messages.slice(-scrollResult.retainedCount)
          this._compressedSummary = scrollResult.indexedSummary
          console.log(
            `[AgentRunner] 📚 Scroll 模式: 索引化 ${scrollResult.evictedCount} 条历史, ` +
            `保留 ${scrollResult.retainedCount} 条最近消息`
          )
          this.emit({
            type: 'thinking',
            text: `📚 已索引 ${scrollResult.evictedCount} 条历史对话（Scroll Context）`,
          })
        }
        return
      }

      // 传统压缩模式
      const result = compactMessages(this.messages, this._compressedSummary)
      if (!result) {return}

      this.messages = result.messages
      this._compressedSummary = result.summary.text

      console.log(
        `[AgentRunner] 🗜️ QwenPaw 风格压缩: ` +
        `压缩掉 ${result.summary.compressedCount} 条中间消息, ` +
        `保留 ${result.summary.retainedCount} 条最近消息, ` +
        `${result.summary.isIncremental ? '增量更新摘要' : '新建摘要'}`
      )
      this.emit({ type: 'thinking', text: `🗜️ 上下文已自动压缩（结构化摘要），保留最近对话` })
    } catch (err) {
      console.warn('[AgentRunner] 上下文压缩失败:', err)
    }
  }

  /**
   * 清除对话历史（保留系统提示词初始消息）
   */
  clearHistory(): void {
    this.messages = []
    this.initSystemPrompt()
    this.turnCount = 0
    this.totalTokens = 0
    this._healthChecked = false   // 🔧 v3.0: 清除后重新检查健康状态
    this._firstCallDone = false   // 🔧 v3.0: 首次调用标记重置
    this._modelPinged = false     // 🔧 v3.7: 重置 Ping 标记
    // P1: _autoContinueCount 重置已移除
    this._toolsUsedThisRun = false // 🆕 v3.9: 重置工具追踪
    // P1: _searchExecutedThisTurn 已移除
    this._runStartIndex = 0        // 🆕 v6.7: 重置本轮起点
    this._reasoningStarted = false // 🆕 v5.2: 重置推理跟踪
    this._reasoningAccum = ''     // 🆕 v5.2: 重置推理跟踪
    // 全局黑名单已移除 — 不再需要 clear
  }

  /** 从持久化历史恢复对话上下文（应用重启/切换对话时调用） */
  setHistory(history: Array<{ role: string; content: string }>, compactedContext?: string): void {
    this.messages = []
    // > v10.0 -> v14.0 -> v17.0: 动态放宽历史截断。
    //   v17.0: 群聊/协作模式下需要更多上下文（Yak → 热茶 → Lumina 多阶段协作）。
    //   改为检测是否有协作标记（user 消息中有 [Yak 输出]/[热茶 审阅] 等），自动翻倍。
    const hasCollabMarkers = history.some(m =>
      m.role === 'user' && /\[(Yak|热茶|Lumina).*(输出|审阅|测试|修复|需求)\]/.test(m.content || '')
    )
    const MAX_MSG_PAIRS = hasCollabMarkers ? 50 : 25
    const MAX_MSG_CHARS = hasCollabMarkers ? 16_000 : 8000
    const recentMsgs: Array<{ role: string; content: string }> = []
    let userPairCount = 0
    // 从后往前收集，收集到足够 user-assistant 对后停止
    for (let i = history.length - 1; i >= 0 && userPairCount < MAX_MSG_PAIRS; i--) {
      const msg = history[i]
      if (msg.role === 'user') {userPairCount++}
      recentMsgs.unshift(msg)  // 倒序插入保持正序
    }
    for (const msg of recentMsgs) {
      const truncated = msg.content.length > MAX_MSG_CHARS 
        ? msg.content.slice(0, MAX_MSG_CHARS) + '...[截断]' 
        : msg.content
      this.messages.push({ role: msg.role as AgentMessage['role'], content: truncated })
    }
    this.turnCount = recentMsgs.filter(m => m.role === 'user').length
    if (history.length > recentMsgs.length) {
      console.log(`[AgentRunner] 📜 历史截断: ${history.length}条 → ${recentMsgs.length}条 (${userPairCount}轮, 协作模式=${hasCollabMarkers})`)
    }
  }

  /** 将未持久化的消息写入 SQLite conversation_history */
  private persistConversationHistory(): void {
    try {
      const store = getMemoryStore()
      if (!store) {return}
      for (let i = this.lastPersistedIndex + 1; i < this.messages.length; i++) {
        const msg = this.messages[i]
        const toolCalls = (msg as any).tool_calls
          ? JSON.stringify((msg as any).tool_calls)
          : undefined
        // v10.9: 多模态内容持久化 — 数组格式转为纯文本存储
        const contentForStorage = Array.isArray(msg.content)
          ? (msg.content as any[]).filter(c => c.type === 'text').map(c => c.text || '').join('\n')
          : (msg.content || '')
        store.addConversation(this.sessionId, msg.role, contentForStorage, toolCalls)
      }
      this.lastPersistedIndex = this.messages.length - 1
    } catch {
      // 持久化失败不影响对话
    }
  }

  /** P3-2: 同步新增消息到目标 Agent 的独立 chats.json */
  private persistToChatsJson(): void {
    try {
      const agentId = this.config.personaId || 'lumina'
      const chatsManager = getAgentChatsManager()
      for (let i = this._lastChatsPersistIndex + 1; i < this.messages.length; i++) {
        const msg = this.messages[i]
        const contentForStorage = Array.isArray(msg.content)
          ? (msg.content as any[]).filter(c => c.type === 'text').map(c => c.text || '').join('\n')
          : (msg.content || '')
        chatsManager.addMessage(agentId, this.sessionId, {
          role: msg.role,
          content: contentForStorage,
          metadata: (msg as any).tool_calls ? { toolCalls: (msg as any).tool_calls } : undefined,
        })
      }
      this._lastChatsPersistIndex = this.messages.length - 1
    } catch (e) {
      console.warn('[AgentRunner] 同步 chats.json 失败:', e)
    }
  }

  /** P4-1: 同步原始消息到 dialog/YYYY-MM-DD.jsonl（用于精确回溯） */
  private persistToDialog(): void {
    try {
      const agentId = this.config.personaId || 'lumina'
      const dialogManager = getAgentDialogManager()
      for (let i = this._lastDialogPersistIndex + 1; i < this.messages.length; i++) {
        const msg = this.messages[i]
        dialogManager.appendMessage(agentId, this.sessionId, {
          role: msg.role,
          content: msg.content,
          agentId,
          sessionId: this.sessionId,
          metadata: (msg as any).tool_calls ? { toolCalls: (msg as any).tool_calls } : undefined,
        })
      }
      this._lastDialogPersistIndex = this.messages.length - 1
    } catch (e) {
      console.warn('[AgentRunner] 同步 dialog 失败:', e)
    }
  }

  getTotalTokens(): number {
    return this.totalTokens
  }

  /** 🆕 v9.1: Token 估算回退 — 当 LLM API 不返回 usage 时，从实际文本估算
   *  许多本地模型（LM Studio / Ollama 等）不返回 usage.token 计数，
   *  导致 TokenChart 永远为 0。此方法按 ~3.5 字符/token 估算。
   */
  private estimateTokenUsage(response: { text?: string; usage?: any }): { prompt_tokens: number; completion_tokens: number; total_tokens: number } {
    // 如果 API 返回了有效用量，直接使用
    if (response.usage?.total_tokens > 0) {
      return response.usage
    }
    // 估算 completion tokens
    const completionText = response.text || ''
    const completionTokens = Math.max(1, Math.ceil(completionText.length / 3.5))
    // 估算 prompt tokens（从本轮 messages 推算）
    // v10.9: 支持多模态 — 提取纯文本进行估算
    const promptText = this.messages.map(m => {
      const c = Array.isArray(m.content)
        ? (m.content as any[]).filter(c => c.type === 'text').map(c => c.text || '').join(' ')
        : (m.content || '')
      return c + (m.name || '')
    }).join(' ')
    const promptTokens = Math.max(1, Math.ceil(promptText.length / 3.5))
    return {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    }
  }

  /** v6.0: 获取当前轮工具调用次数 */
  getTurnCount(): number {
    return this.turnCount
  }

  /** 🆕 P0: Scroll 召回 — 从索引中检索历史对话 */
  recallScroll(query: string, limit = 10): string {
    if (!this._scrollContext) {return ''}
    try {
      const agentId = this.config.personaId as string | undefined
      const results = (this._scrollContext as any).recall({
        sessionId: this.sessionId,
        agentId,
        query,
        limit,
      })
      if (!results || results.length === 0) {return ''}
      return (this._scrollContext as any).formatForContext(results, 3000)
    } catch (e) {
      console.warn('[AgentRunner] Scroll 召回失败:', e)
      return ''
    }
  }

  /**
   * 发送用户消息并执行完整的 ReAct 循环直到完成
   * @param text - 用户消息文本
   * @returns Agent 最终响应文本
   */
  /** 🆕 v10.0 fix: 收紧代码题检测，去掉宽泛的「解释一下/分析一下」等误触发词 */
  private isCodeTask(text: string): boolean {
    const codePatterns = [
      /代码|函数|bug|debug|实现|算法|api|接口|class\b|def\b|function\b|方法|报错|异常|crash|组件|组件化|重构/i,
      /import\s|require\s|const\s|let\s|var\s|public\s|private\s|static\s|async\s|await\s|return\s/i,
      /\.py$|\.js$|\.ts$|\.java$|\.cpp$|\.go$/i,
      /写个|写一个|帮我写|帮我修|修一下|改一下|实现一个|封装/i,
    ]
    // 短句且包含代码关键词 → 大概率是代码题
    if (text.length < 30 && codePatterns[0].test(text)) {return true}
    // 长句必须有明确代码关键词才路由
    const matchCount = codePatterns.filter(p => p.test(text)).length
    return matchCount >= 2
  }

  async sendMessage(text: string): Promise<string> {
    this.abortController = new AbortController()
    // P1: _autoContinueCount 重置已移除
    this._autoContinueCount = 0  // 🆕 v16.0-fix: 每次 sendMessage 重置
    this._lastIntentHash = ''    // 🆕 v16.0-fix: 重置意图句式追踪
    this._toolsUsedThisRun = false // 🆕 v3.9: 每次 sendMessage 重置
    // P1: _searchExecutedThisTurn 已移除

    // 去重 — 如果 history 最后一条 user 消息刚好和本次 text 一样，
    //   说明 frontend 已经把用户消息放进了 conversationHistory，sendMessage 又 push 一次。
    //   去掉重复的最后一条 user，避免 LLM 看到同一问题两次。
    // v10.9: 支持多模态 — 比较时提取纯文本
    if (this.messages.length >= 2) {
      const last = this.messages[this.messages.length - 1]
      const lastText = Array.isArray(last.content)
        ? (last.content as any[]).find(c => c.type === 'text')?.text || ''
        : (last.content || '')
      const newText = Array.isArray(text)
        ? (text as any[]).find(c => c.type === 'text')?.text || ''
        : (text || '')
      if (last.role === 'user' && lastText === newText) {
        this.messages.pop()
        this.turnCount = Math.max(0, this.turnCount - 1)
        console.log(`[AgentRunner] 🔧 去重: history 末尾 user 消息与 sendMessage 重复，已移除`)
      }
    }

    // v2.5: 防注入净化
    try {
      const guard = getInjectionGuard()
      const { sanitized } = guard.sanitizeUserInput(text)
      if (sanitized !== text) {
        this.emit({ type: 'thinking', text: '⚠️ 检测到潜在注入，已净化' })
        text = sanitized
      }
    } catch { /* ignore */ }

    // v2.5: 操作知识库匹配
    try {
      const manual = getManualSystem()
      const ctx = manual.getKnowledgeContext(text)
      if (ctx) {
        this.messages.push({ role: 'system', content: ctx })
      }
    } catch { /* ignore */ }

    // 🧭 路由预热（fire-and-forget，**不阻塞**）
    //   真实委派由 LLM 自主决定，但模型有时会忘记委派、自己硬揽本该 Yak 干的活。
    //   纯正则路由对「这玩意跑起来就崩，帮我看看」这类无代码关键词的歧义请求必然失手，
    //   所以这里对**歧义任务**提前起一次后台仲裁（1.2s 硬超时），结果写进缓存，
    //   随后的 initSystemPrompt() 同步读取。规则能直接定的不调 LLM，零成本。
    //   仲裁失败/超时一律静默退回纯规则，绝不影响首字响应。
    if (this.config.personaId === 'lumina' && text && text.trim()) {
      try {
        const { warmRouteHint } = require('./orchestration/routingDecider')
        const arbiter = async (q: string): Promise<string | null> => {
          // 独立 provider 实例：绝不复用 this._llmProvider（它会改写 this.messages）
          try {
            const { LLMProvider } = require('./core/llmProvider')
            const p = new LLMProvider({
              baseUrl: this.config.baseUrl || '',
              apiKey: this.config.apiKey || '',
              model: this.config.model || '',
              maxContextTokens: 4_096,
              personaId: this.config.personaId,
            })
            const r: any = await p.call({
              messages: [
                { role: 'system', content: ROUTE_ARBITER_SYSTEM },
                { role: 'user', content: q },
              ],
              maxTokens: 16,
              temperature: 0,
            })
            const raw = String(r?.text || r?.content || '').trim()
            const m = /lumina|yak|recha/i.exec(raw)
            return m ? m[0].toLowerCase() : null
          } catch { return null }
        }
        warmRouteHint(text, undefined, { llmClassify: arbiter })
      } catch { /* 路由预热失败绝不影响主流程 */ }
    }

    // 🔧 FIX-1: 确保 system prompt（人格+指令+工具说明）始终在消息最开头
    //   必须在 PreSearch 之前执行，否则 PreSearch 插入的 system 消息会
    //   让后续的 initSystemPrompt() 条件判断跳过执行
    // 🔧 2026-07-31: 群聊主回复修复 — 历史第一条是 system 欢迎消息时会误跳过注入，
    //   导致身份/工具说明/群聊覆盖指令全部丢失（搜索不行 + 失忆开场白）。
    //   现在：只要 messages[0] 不是"我们自己注入的 system prompt"（含 ## 自定义指令 /
    //   ## 📢 群聊模式指令 标记），就强制 initSystemPrompt() —— 它内部会替换 messages[0]，
    //   不会重复叠加。
    const firstIsOurSystem = this.messages[0]?.role === 'system'
      && typeof this.messages[0]?.content === 'string'
      && (this.messages[0].content.includes('## 自定义指令')
        || this.messages[0].content.includes('## 📢 群聊模式指令'))
    if (this.messages.length === 0 || !firstIsOurSystem) {
      this.initSystemPrompt()
    }

    // 🆕 P1: Loop Engineering — 应用 Loop 模板
    const loopMode = (this.config as any)?.loopMode as string | undefined
    if (loopMode) {
      try {
        const loopEngineering = new (require('./loopEngineering').getLoopEngineering)()
        const template = loopEngineering.getTemplate(loopMode)
        if (template?.systemPrompt) {
          // 将模板的 system prompt 注入到消息中
          this.messages.unshift({
            role: 'system',
            content: template.systemPrompt,
          })
          console.log(`[AgentRunner] 🔄 Loop 模板已应用: ${template.name}`)
          this.emit({
            type: 'thinking',
            text: `🔄 已启用 ${template.name} 模式`,
          })
        }
      } catch (e) {
        console.warn('[AgentRunner] Loop 模板应用失败:', e)
      }
    }

    // 🆕 FIX-2: 统一预处理 — 合并搜索 + URL 收集
    //   之前: preExecuteSearch 和 preExecuteCollect 各自独立调用两次，
    //   结果以不同格式注入消息，逻辑分散。
    //   现在: preProcessMessage 一次调用，同时处理 URL 抓取和搜索预检查，
    //   非 socialMode 路径统一走 preProcessMessage。
    //   详见 preProcessMessage() 上方注释。
    //
    // 重大改进（被 FIX-2 继承）：
    //   ❌ 不再使用 system message 注入（LLM 不重视 system 消息，继续说"我来查"）。
    //   ✅ 改为模拟 tool_call + tool_result 对话模式。
    //      LLM 训练数据中大量包含"assistant调工具→tool返回结果→assistant归纳"的交互，
    //      模型看到这种模式会自动归纳总结，不会说"让我查一下"。
    // 声明提升到 try 外部，供后续 collectResult 注入使用
    let searchResult: string | null = null
    let collectResult: string | null = null

    try {
      // socialMode 不再一刀切跳过 preExecuteSearch
      //   之前: 完全跳过 → LLM 自己调 web_search，但缺失日期注入
      //   新方案: socialMode 下只做日期注入，不执行实际搜索和结果注入
      //   （避免 preExecuteSearch 搜一次 + LLM 又搜一次的双重超时）

      if (this.config.socialMode) {
        // ── socialMode 精简版：只做日期注入提示 ──
        const trimmed = text.trim()
        const _now = new Date()
        const _dateStr = `${_now.getFullYear()}-${String(_now.getMonth()+1).padStart(2,'0')}-${String(_now.getDate()).padStart(2,'0')}`
        const _HAS_TIME_WORD = /今天|今日|最近|最新|现在|当前|实时|本月|本周|这两天|眼下|这会儿|昨晚|今早|凌晨|刚刚|新(的)?[闻问]/
        const _TIME_SENSITIVE_DOMAIN =
          /股票|股价|行情|走势|涨了|跌了|涨停|跌停|A股|美股|港股|基金|大盘|指数|期货|原油|黄金|白银|汇率|美元|人民币|比特币|加密货币|以太坊|区块[链连]|市值|成交量|资金|北向|南向|板块|概念股|估值|泡沫|回调|反弹|牛市|熊市|仓位|减持|增持|回购|分红|送股/.source +
          /|财报|业绩|营收|利润|净利润|毛利率|净利率|资产负债|现金流|评级|目标价|研报|公告|披露|上市|IPO|退市|ST/.source +
          /|新闻|热点|头条|热搜|资讯|报道|消息|传闻|爆料|辟谣|声明|回应|抗议|示威|冲突|战争|停火|制裁|关税|贸易战/.source +
          /|科技|数码|手机|芯片|AI|人工智能|大模型|GPT|发布|上市|新品|销量|价格|降价|涨价|评测|跑分|系统|更新|升级|补丁|漏洞|破解/.source +
          /|体育|比赛|比分|赛果|联赛|NBA|CBA|英超|欧冠|世界杯|奥运|金牌|冠军|亚军|娱乐|票房|电影|电视剧|综艺|收视率|番位|热搜/.source +
          /|天气|温度|降雨|降雪|台风|地震|海啸|洪水|干旱|高温|寒潮|预警|空气质量|雾霾|PM2[.]?5/.source +
          /|选举|投票|民调|总统|首相|总理|当选|就职|辞职|下台|政策|法规|立法|禁令|开放|限制|签证|移民|人口|GDP|通胀|CPI|失业率/.source +
          /|路况|航班|高铁|地铁|公交|油价|电价|水价|放假|假期|节日|春运|国庆|春节|五一|中秋/.source +
          /|疫情|病例|感染|疫苗|药物|获批|临床|试验|医保|集采|医院|挂号|健康/
        const _HISTORICAL_REF = /(?:去年|前年|上年|\d{4}\s*年|\d{4}\s*[–\-]\s*\d{4})/

        const hasTimeWord = _HAS_TIME_WORD.test(trimmed)
        const inTimeDomain = new RegExp(_TIME_SENSITIVE_DOMAIN).test(trimmed)
        const isHistorical = _HISTORICAL_REF.test(trimmed)
        const isTimeSensitive = (hasTimeWord || inTimeDomain) && !isHistorical

        if (isTimeSensitive && !trimmed.includes(String(_now.getFullYear()))) {
          // 注入 system 消息让 LLM 在调用 web_search 时带上日期
          const alreadyHasDateMsg = (this.messages as any[]).some((m: any) =>
            m.role === 'system' && typeof m.content === 'string' && m.content.includes('[内部日期提示]')
          )
          if (!alreadyHasDateMsg) {
            (this.messages as any[]).push({
              role: 'system',
              content: `[内部日期提示] 当前日期: ${_dateStr}。用户问了时效性问题，请在搜索时直接追加日期到 query 中。`,
            })
            console.log(`[AgentRunner] 📅 socialMode 时效性提示注入完成`)
          }
        }
        // socialMode 走 preProcessMessage 统一搜索路径
        //   之前: 弱 _SEARCH_INTENT 正则只匹配"搜索/查一下/百度"等命令式搜索词，
        //   "今天天气怎么样""帮我看看AI新闻"等自然语言问句全部漏过。
        //   现在: 同非 socialMode 完整三层匹配（显式搜索指令/时效信息/事实型问题）
        try {
          const preprocess = await preProcessMessage(text, { skipAutoSearch: this.config.noAutoSearch === true })
          searchResult = preprocess.searchResult
          collectResult = preprocess.collectResult
          if (searchResult) {
            this.emit({ type: 'thinking', text: '🔍 socialMode 已执行搜索...' })
          }
        } catch (e: any) {
          console.warn(`[AgentRunner] socialMode 搜索预处理失败: ${e.message}`)
        }
      } else {
        // 🆕 FIX-2: 非 socialMode — 统一预处理（URL 收集 + 搜索）
        const preprocess = await preProcessMessage(text, { skipAutoSearch: this.config.noAutoSearch === true })
        searchResult = preprocess.searchResult
        collectResult = preprocess.collectResult
      }
      if (searchResult) {
        this.emit({ type: 'thinking', text: '🔍 正在搜索...' })
        // 保存完整结果到文件（备用）
        const now = new Date()
        const dateStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`
        const ts = `${dateStr}-${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}${String(now.getSeconds()).padStart(2,'0')}`
        const filename = `collected/search-${ts}.md`
        try {
          const fs = require('fs')
          const path = require('path')
          const root = process.cwd()
          const dir = path.join(root, 'collected')
          if (!fs.existsSync(dir)) {fs.mkdirSync(dir, { recursive: true })}
          const filePath = path.join(root, filename)
          fs.writeFileSync(filePath, `# 搜索结果 (${dateStr})\n\n查询: ${text.slice(0, 80)}...\n\n---\n\n${searchResult}`, 'utf-8')
        } catch { /* ignore file save errors */ }

        // 改用 system 消息注入搜索结果
        //   v12.1 的模拟 tool_call + tool_result 格式导致本地模型（不支持 function calling）
        //   返回空回复（模型无法处理 tool 角色消息）。
        //   system 消息虽然"权重低"，但至少模型能理解并回答。
        //
        // 群聊模式（socialMode）增强注入
        //   system 消息权重低，群聊中 LLM 可能忽略后继续说"我来查"。
        //   改为在搜索结果后追加一条强引导 user 消息（在用户原消息之后），
        //   让 LLM 看到搜索结果后直接归纳，不再触发 isIntentOnly。
        //
        // 根据模型类型选择注入方式
        //   云端模型（非 localhost）→ 使用 tool_call + tool role（标准 OpenAI 函数调用格式）
        //   本地模型（localhost）→ 继续使用 assistant + user（避免 tool role 导致空回复）
        const searchQuery = text.slice(0, 200)
        const resultContent = searchResult.length > 5000
          ? searchResult.slice(0, 5000) + `\n\n...（完整结果 ${searchResult.length} 字符已保存到 ${filename}）`
          : searchResult

        const searchSummary = resultContent.length > 3000
          ? resultContent.slice(0, 3000) + `\n\n...（完整结果 ${resultContent.length} 字符已保存到 ${filename}）`
          : resultContent

        // 判断本地/云端模型
        //   本地模型（Ollama/LM Studio/GGUF）不支持 function calling 的 tool role，
        //   使用 tool role 会导致空回复。云端模型（OpenAI/Claude/GLM/DeepSeek等）支持。
        const baseUrl_ = (this.config.baseUrl || '').toLowerCase()
        // 🔧 2026-07-31: 必须与 callLLM 的 isLocalModel 判断保持完全一致！
        //   之前这里缺 192.168. 网段判断 → LM Studio 局域网地址被误判为"云端"，
        //   走 tool_call+tool role 注入；而 callLLM 又把 192.168. 判为"本地"把 tool 转 user，
        //   导致发给模型的序列变成「伪造的未闭合 tool_calls + user 工具结果」畸形结构，
        //   Qwen 等模型无法理解 → 空回复 → "无法生成有效回复"（搜索时必现）。
        const isLocalModel = baseUrl_.includes('localhost') || baseUrl_.includes('127.0.0.1') || baseUrl_.includes('0.0.0.0') || baseUrl_.includes('192.168.')

        if (!isLocalModel) {
          // ── 云端模型：tool_call + tool role（标准函数调用格式） ──
          //   这是 LLM 训练中最常见的"工具调用→结果"模式，模型会自然归纳结果。
          const searchToolId = `call_search_${Date.now()}`
          this.messages.push({
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: searchToolId,
              type: 'function' as const,
              function: {
                name: 'web_search',
                arguments: JSON.stringify({ query: searchQuery }),
              },
            }],
          })
          this.messages.push({
            role: 'tool',
            content: `【搜索结果摘要】\n查询: ${searchQuery}\n日期: ${dateStr}\n\n${searchSummary}`,
            tool_call_id: searchToolId,
          })
          console.log(`[PreSearch] ✅ 搜索结果注入 tool role: "${searchQuery.slice(0, 60)}" → ${searchSummary.length} 字符`)
        } else {
          // ── 本地模型：assistant + user 格式（回退方案） ──
          //   tool role 导致本地模型空回复，改用 assistant 模拟模型自己产出结果，
          //   再追加 user 引导消息，权重最高。
          this.messages.push({
            role: 'assistant',
            content: `【搜索结果摘要】\n查询: ${searchQuery}\n日期: ${dateStr}\n\n${searchSummary}`,
          })
          console.log(`[PreSearch] ✅ 搜索结果注入 assistant+user: "${searchQuery.slice(0, 60)}" → ${searchSummary.length} 字符 (localModel)`)

          // 说出来模式 — 搜索结果注入时引导 agent 说出思考过程
          // 🔧 2026-07-13: 增强引导 — 明确告知 LLM 搜索已完成、结果已在上下文中，
          //   不要再说"我去查一下"，直接基于结果回答。
          //   新格式：先标记搜索已完成（防止 isIntentOnly 误判），再要求直接回答
          const verbalizeEnabled = !!(this.config as AgentRunConfig)?.verbalizeThinking
          const searchHasResults = searchSummary.length > 100
          const baseFollowUp = searchHasResults
            ? `【搜索结果已就绪】以上是实时搜索返回的结果。请直接基于这些结果回答用户的问题，不要再说"我来查/让我搜一下"——搜索已经完成了，结果就在你面前。
要求：
1. 数字必须精确（股价、涨跌幅、成交量、金额等），不用"大概""左右"
2. 优先采信官方公告/权威媒体
3. 只报告搜索结果中明确出现的信息，不编造不延伸
4. 如果搜索结果与用户的问题无关，如实说明"
5. 直接给出回答，不要额外输出 <tool_call> 等 XML 标记`
            : `搜索未返回有效结果。请如实告知用户当前搜索没有找到相关信息，并建议用户换个关键词试试。`
          const followUpContent = verbalizeEnabled
            ? `${baseFollowUp}\n\n请先简要说出你从搜索结果中查到的关键信息，再给出完整回答。`
            : baseFollowUp
          // socialMode 下搜索结果引导也用 system 角色，防止群聊中被称为用户发言
          this.messages.push({
            role: this.config?.socialMode ? 'system' : 'user',
            content: this.config?.socialMode ? '[内部续话指令·非用户发言] ' + followUpContent : followUpContent,
          })
        }
        // P1: _searchExecutedThisTurn 已移除
      }
    } catch { /* ignore */ }

    // 🆕 FIX-2: URL/收集预处理 — 由 preProcessMessage 统一处理
    //   非 socialMode: collectResult 已在 preProcessMessage 中计算并注入
    //   socialMode: 仍需单独调用 preExecuteCollect 兜底
    try {
      if (collectResult === null) {
        collectResult = await preExecuteCollect(text)
      }
      if (collectResult) {
        this.emit({ type: 'thinking', text: '📥 正在收集网页内容...' })
        const now = new Date()
        const ts = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}-${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}${String(now.getSeconds()).padStart(2,'0')}`
        const filename = `collected/collect-${ts}.md`
        try {
          const fs = require('fs')
          const path = require('path')
          const root = process.cwd()
          const dir = path.join(root, 'collected')
          if (!fs.existsSync(dir)) {fs.mkdirSync(dir, { recursive: true })}
          const filePath = path.join(root, filename)
          fs.writeFileSync(filePath, `# 网页内容收集 (${ts})\n\n查询: ${text.slice(0, 80)}...\n\n---\n\n${collectResult}`, 'utf-8')
          this.messages.push({
            role: 'system',
            content: `📁 网页内容已保存到 ${filename} (${collectResult.length}字符)。请调用 file_read 读取该文件，然后在回复中总结要点。`,
          })
          console.log(`[PreCollect] 已保存: ${filename} (${collectResult.length} 字符)`)
        } catch (saveErr) {
          this.messages.push({
            role: 'system',
            content: `【网页收集结果】\n${collectResult.slice(0, 400)}...`,
          })
        }
      }
    } catch { /* ignore */ }

    // v10.9: 支持多模态 — text 可以是字符串或 OpenAI Vision 格式的数组
    this.messages.push({ role: 'user', content: text as any })
    this.turnCount++
    this.persistConversationHistory()  // 用户消息立即持久化
    this.persistToDialog()  // P4-1: 用户消息立即归档到 dialog/

    // 🆕 P0: Scroll Context — 超出活跃窗口时索引化历史
    if (this._scrollContext) {
      try {
        const agentId = this.config.personaId as string | undefined
        const scrollResult = (this._scrollContext as any).evictToIndex(
          this.sessionId,
          agentId,
          this.messages,
        )
        if (scrollResult && scrollResult.evictedCount > 0) {
          // 从 messages 中移除已索引的消息
          const keepRecent = (this._scrollContext as any).constructor?.name === 'ScrollContext'
            ? 20  // 默认保留最近20条
            : this.messages.length - scrollResult.evictedCount
          this.messages = this.messages.slice(-Math.max(5, this.messages.length - scrollResult.evictedCount))
          console.log(`[AgentRunner] 📚 Scroll 索引化: 驱逐 ${scrollResult.evictedCount} 条历史到索引`)
          this.emit({
            type: 'thinking',
            text: `📚 已索引 ${scrollResult.evictedCount} 条历史对话（Scroll Context）`,
          })
        }
      } catch (e) {
        console.warn('[AgentRunner] Scroll 索引化失败:', e)
      }
    }

    // 🆕 P0: ReMe Light — 注入相关记忆到上下文
    if (this._remeLight) {
      try {
        const agentId = this.config.personaId as string | undefined
        const memoryContext = (this._remeLight as any).getMemoryContext(agentId, 1500)
        if (memoryContext) {
          this.messages.push({ role: 'system', content: memoryContext })
          console.log('[AgentRunner] 🧠 ReMe 记忆上下文已注入')
        }
      } catch (e) {
        console.warn('[AgentRunner] ReMe 记忆注入失败:', e)
      }
    }

    // system prompt 已由上方的 PreSearch 前置检查处理
    //   initSystemPrompt() 不会被跳过（FIX-1 已确保它在 PreSearch 前执行）
    //   此处不再重复调用，避免被搜索结果 system 消息干扰判断
    this._runStartIndex = this.messages.length

    // ═══ 统一路径: 所有模式走 ReAct 循环 ═══
    // （v9.2: 移除已废弃的 chat shortcut 路径 — 该路径在 agent:chat IPC 中
    //  被 mode:'agent' 覆盖，从未实际执行。现在所有模式统一走 ReAct 循环）
    
    // 🔧 QwenPaw 风格：在调用 LLM 前主动检查并压缩上下文
    this.compactContext()

    let result: string

    // 🔧 FIX-3: 统一代码路径 — 移除 _useNewModules 双路径 toggle
    //   旧架构（v9.3）：新路径（reactEngine.run）失败后降级到旧路径（runReActLoop），
    //   但两条路径都是完整的 ReAct 循环，维护两套相同的逻辑导致：
    //     a) reactEngine 缺少 agentRunner 中积累的多轮修复逻辑
    //     b) 空回复 recovery 在两套循环中行为不一致
    //     c) 搜索结果 system 消息注入在 reactEngine 内无法正确处理
    //   统一后：只走 agentRunner.runReActLoop()，所有修复逻辑集中维护
    {
      const { tools, toolsetName } = this.getToolsForMode()

      // 🆕 情绪门控说明注入（创新功能 1）
      //   时序很关键：getToolsForMode() 刚跑完，_emotionGateNotice 才有值；
      //   紧接着 initSystemPrompt() 会被 runReActLoop 内部再调一次，
      //   那里也会带上最新一轮的 notice。
      if (this._emotionGateNotice) {
        this.initSystemPrompt()
        const sysIdx = this.messages.findIndex(m => m.role === 'system')
        if (sysIdx >= 0) {
          this.messages[sysIdx] = {
            ...this.messages[sysIdx],
            content: (this.messages[sysIdx].content || '') + '\n\n' + this._emotionGateNotice,
          }
        }
      }

      const openaiTools = tools
        .map(t => toOpenAIFunctions([getToolDef(t)!]))
        .flat()
        .filter(Boolean)

      console.log(`[AgentRunner] mode=${this.config.mode} toolset=${toolsetName} tools=${tools.length} openaiTools=${openaiTools.length} disabled=${(this.config.disabledTools || []).length}`)
      if (openaiTools.length === 0 && this.config.mode !== 'chat') {
        console.warn(`[AgentRunner] ⚠️ ${this.config.mode} 模式下未加载到任何工具定义，请检查 registry`)
      }

      try {
        result = await this.runReActLoop(openaiTools)
      } catch (err: any) {
        console.error('[AgentRunner] ReAct 循环异常:', err)
        this.emit({ type: 'error', error: `💀 Agent 循环异常: ${err.message || err}` })
        result = `抱歉，我刚才思考时遇到了点问题。请重试一下？`
        this.messages = this.messages.slice(0, Math.max(1, this.messages.length - 1))
      }
    }

    // ── v12.0: 统一空结果兜底 — 新/旧路径都可能返回空字符串 ──
    //   新路径 (ReActEngine): 5+ 次空回复后返回 ''
    //   旧路径 (runReActLoop): 经过 safeStripChain + 重试后仍可能返回 ''
    //   统一在这里做最后兜底，避免前端显示空消息或旧 fallback
    if (!result || result.trim().length === 0) {
      console.warn(`[AgentRunner] ⚠️ sendMessage 最终结果为空，启动全路径恢复`)
      // 尝试最后一次重试：用极简上下文
      try {
        const lastUserMsg = [...this.messages].reverse().find(m => m.role === 'user')
        if (lastUserMsg?.content) {
          // socialMode 下不清除所有 system 消息（会丢失群聊上下文），只保留核心 system 块
          if (this.config?.socialMode) {
            // socialMode: 在末尾追加引导，不清除已有上下文
            this.messages.push({
              role: 'system',
              content: '[内部续话指令·非用户发言] 请直接回答用户的问题，不要继续搜索或等待。',
            })
          } else {
            // v10.9: 多模态内容提取纯文本
            const lastUserText = Array.isArray(lastUserMsg.content)
              ? (lastUserMsg.content as any[]).filter(c => c.type === 'text').map(c => c.text || '').join(' ')
              : (lastUserMsg.content || '')
            // 🔧 修复：之前这里把 messages 砍到只剩 [system, user(原问题)]，
            //   丢掉了**全部工具结果和上文**。后果是模型在恢复轮里"失忆"，
            //   会根据一句孤立的问题重新编一遍答案——用户看到的是完全不同的、
            //   看似合理实则没依据的回答，而且察觉不到异常。
            // 现在：保留 system + 最近 12 条（含工具结果）+ 原问题重述，
            // 并显式告诉模型"你已经失败过一次，不要凭空重写"。
            // ⚠️ slice 很容易从半截开始，切出没有父 assistant 的孤儿 tool 消息，
            //    OpenAI 兼容协议会直接 400 —— 必须先 sanitize 成协议合法形态。
            const sysBlocks = this.messages.filter(m => m.role === 'system')
            const recentTail = sanitizeHistoryForApi(
              this.messages.filter(m => m.role !== 'system').slice(-12),
            )
            this.messages = [
              ...sysBlocks.slice(0, 1),
              {
                role: 'system',
                content: '[内部续话指令·非用户发言] 上一次回答失败了，这是第二次尝试。'
                  + '请只依据下面保留下来的对话与工具结果作答。'
                  + '⛔ 禁止凭空编造你没有依据的结论；如果所需信息确实缺失，'
                  + '就直接告诉用户"缺少什么信息、为什么无法回答"，而不是猜一个答案。',
              },
              ...recentTail,
              {
                role: 'user',
                content: `请自然、直接地回答用户的问题：「${lastUserText}」`,
              },
            ]
          }
          const recoveryResult = await this.runReActLoop([])
          if (recoveryResult && recoveryResult.trim().length > 0) {
            result = recoveryResult
            console.log(`[AgentRunner] ✅ 全路径恢复成功: ${result.length} 字`)
          }
        }
      } catch (err) {
        console.warn('[AgentRunner] 全路径恢复失败:', err)
      }
      // 最终兜底：可操作提示
      //
      // 🔧 文案重写（真实故障反馈）
      //   旧文案：「请试试说"继续"让我重新尝试，或检查 LLM 服务是否正常运行。」
      //   问题：它把用户引向错误的方向——「检查 LLM 服务」暗示 API 挂了，
      //   用户会去折腾 baseUrl / API Key / 网络，而实际根因往往是
      //   模型这轮输出没被正确解析（见 llm/xmlToolCall.ts）。
      //   误导性报错比没有报错更糟糕。
      //
      //   新文案原则：
      //   ① 说清楚是「我这边没能生成」而不是「你的服务坏了」
      //   ② 给一个真正有用的下一步（重说一次 / 换个说法 / 换模型）
      //   ③ 带一句可排查的线索，��便用户反馈时能提供
      if (!result || result.trim().length === 0) {
        result = '这轮我没能给出有效回复（模型返回了无法识别的内容，不一定是你的问题）。\n' +
          '可以试试：① 让我再说一次；② 换个说法或补充点上下文；③ 如果反复出现，换一个模型试试。'
        console.error(
          '[AgentRunner] ❌ 全部恢复路径失败。诊断信息：' +
          `mode=${this.config.mode} model=${this.config.model || 'n/a'} ` +
          `messages=${this.messages.length} roundLimit=${this.config.maxToolCalls ?? 30}`,
        )
      }
    }

    await this.postProcess()
    return result
  }

  // ═════════════════════════════════════════════════════════
  // ReAct 循环
  // ═════════════════════════════════════════════════════════

  /**
   * 核心 ReAct 循环：LLM 推理 → 工具调用 → 结果反馈 → 继续推理，直到 LLM 返回最终响应
   * @param tools - OpenAI function calling 格式的工具定义列表
   * @returns 最终响应文本
   */
  async runReActLoop(tools: any[]): Promise<string> {
    // 🆕 v3.0: 注入当前 persona 到 AsyncLocalStorage，工具（如 run_subagents）
    // 即可读到"是谁在调用"，无需改 executeTool 签名。
    enterAgentContext(this.config.personaId)
    const maxRounds = this.config.maxToolCalls ?? 30
    //                    ↑ 从 200 降为 30 — 正常对话 3-8 轮足矣，防止工具循环空转
    let finalText = ''
    let consecutiveEmptyCount = 0  // 🔧 v2.11: 连续空回复计数，防止空回复消耗所有轮次
    let slowThinkingRetries = 0    // 🆕 v5.3: 慢速思考重试计数，防止无限 retry
    let lastToolNames: string[] = []    // 🆕 v14.2: 最近 N 轮调用的工具名，用于检测重复
    let totalToolCallsThisRun = 0       // 🆕 v14.2: 本轮总计工具调用次数
    let converged = false               // 🆕 v15: 是否已触发过强制收敛（防重复触发）
    const blockedTools = new Map<string, number>()  // 🆕 v14.3: 被安全门临时封禁的工具 → 解封轮次

    for (let round = 0; round < maxRounds; round++) {
      if (this.abortController?.signal.aborted) {break}

      // ── 🛡️ P1: 两道安全门（精简自原四道） ──

      // 门 1: 同一工具重复 5 次以上 → 注入停止提示 + 临时封禁该工具 2 轮
      const toolFreq = lastToolNames.reduce<Record<string, number>>((acc, n) => {
        acc[n] = (acc[n] || 0) + 1; return acc
      }, {})
      const repeatedTool = Object.entries(toolFreq).find(([, count]) => count >= 5)
      if (repeatedTool) {
        this.emit({ type: 'thinking', text: `🛡️ "${repeatedTool[0]}" 重复 ${repeatedTool[1]} 次，已临时封禁 2 轮` })
        this.messages.push({
          role: 'system',
          content: `"${repeatedTool[0]}" 已重复调用 ${repeatedTool[1]} 次但未推进任务。该工具已被临时封禁，请用已有信息直接回复，不要再重复调用此工具。`,
        })
        blockedTools.set(repeatedTool[0], round + 2)
        lastToolNames = []
      }

      // 清理已过期的封禁
      for (const name of [...blockedTools.keys()]) {
        if (round >= blockedTools.get(name)!) {blockedTools.delete(name)}
      }

      // 门 2: 总计工具调用超 30 次 → 强制收敛
      // 🔧 这里必须用独立标记，不能只把计数钉回 30。
      //    计数在下一轮还会 `+=`，33 > 30 会**再次**触发 → 每轮重复 emit 收敛提示、
      //    重复往 messages 里塞 system 消息，上限依旧形同虚设。
      if (!converged && totalToolCallsThisRun > 30) {
        converged = true
        this.emit({ type: 'thinking', text: `🛡️ 工具调用已达 ${totalToolCallsThisRun} 次，强制收敛` })
        this.messages.push({
          role: 'system',
          content: `已调用工具 ${totalToolCallsThisRun} 次。请立即停止，使用已有信息回复用户。`,
        })
      }

      // 🧠 轮次标记 —— 说清楚这是"开始第 N 轮处理"，而不是假装模型在思考。
      //   之前每轮无条件发"思考中... (第 N 轮)"，与模型是否真的在推理无关，
      //   在没有 reasoning_content 的模型上就成了唯一的思考展示（看起来像假思考）。
      this.emit({
        type: 'thinking',
        text: round === 0
          ? `开始处理（第 1 轮）`
          : `第 ${round + 1} 轮处理中`,
      })

      try {
        const response = await this.callLLM(tools)

        // 回退估算 — 当 API 不返回 usage 时从文本长度估算
        const tokenUsage3 = this.estimateTokenUsage(response)
        if (tokenUsage3.total_tokens > 0) {
          this.totalTokens += tokenUsage3.total_tokens
          this.emit({
            type: 'token_update',
            totalTokens: this.totalTokens,
            usage: tokenUsage3,
            delta: tokenUsage3.total_tokens,
            // 🆕 上下文用量指示器：当前 prompt tokens + 上下文窗口
            promptTokens: tokenUsage3.prompt_tokens,
            contextWindow: (this.config as any).contextWindow || 0,
          })
          globalEventBus.emit(BusEvents.AGENT_TOKEN_UPDATE, {
            totalTokens: this.totalTokens,
            promptTokens: tokenUsage3.prompt_tokens,
            completionTokens: tokenUsage3.completion_tokens,
          })
        }

        if (response.error) {
          // 用户主动中止 → 立即退出
          if ((response as any).aborted) {
            this.emit({ type: 'error', error: '用户中止' })
            break
          }

          this.emit({ type: 'error', error: response.error })
          globalEventBus.emit(BusEvents.AGENT_ERROR, { error: response.error })

          // ═══════════════════════════════════════════════════
          // P0 简化：超时 → 1 次重试，不再灌注"请继续"提示或总结模式
          //   如果 1 次重试后仍超时，直接报错退出循环
          // ═══════════════════════════════════════════════════
          const isTimeoutError = response.error.includes('超时')
            || response.error.includes('AbortError')
            || response.error.includes('ETIMEDOUT')

          if (isTimeoutError && this.messages.length > 1) {
            slowThinkingRetries++
            if (slowThinkingRetries <= 1) {
              this.emit({
                type: 'thinking',
                text: `🐢 响应超时，自动重试 (1/1)...`
              })
              continue
            }

            // 已重试 1 次仍超时 → 报错退出
            finalText = '模型响应超时，请稍后重试。'
            break
          }

          // 🔧 P3 重做: 不再所有错误都套同一句话。
          //   统一话术的最大问题是——用户和开发者都分不清"模型超时"和"工具挂了"，
          //   出问题后无从排查，Agent 也拿不到可据以调整的信号。
          //   这里只隐藏真正的技术细节（堆栈、URL、密钥），保留**可行动的原因分类**。
          finalText = describeRunFailure(response.error)
          break
        }

        // 工具调用
        if (response.toolCalls && response.toolCalls.length > 0) {
          totalToolCallsThisRun += response.toolCalls.length
          const toolNames = response.toolCalls.map(tc => tc.function.name)
          lastToolNames.push(...toolNames)
          // 只保留最近 30 轮的工具名
          if (lastToolNames.length > 30) {lastToolNames.splice(0, lastToolNames.length - 30)}

          this._toolsUsedThisRun = true  // 🆕 v3.9: 标记已用过工具
          const assistantMsg: AgentMessage = {
            role: 'assistant',
            content: response.text || '',
            tool_calls: response.toolCalls,
          }
          this.messages.push(assistantMsg)
          this.turnCount++

          if (response.toolCalls.length === 1) {
            const tc = response.toolCalls[0]
            const fn = tc.function
            let args: Record<string, any> = {}
            let argsParseFailed = false
            try {
              args = JSON.parse(fn.arguments)
            } catch {
              // 🔧 原来这里是 catch {} —— 参数解析失败就拿 {} 继续跑工具。
              //   但 securityGuard 的判定是基于真实参数做的，参数丢了等于
              //   「危险工具的参数检查被整个跳过」，直接放行最坏情况。
              //   正确做法：解析失败就不执行，如实告诉模型参数写坏了。
              argsParseFailed = true
              args = {}
            }
            if (argsParseFailed) {
              this.emit({ type: 'tool_start', tool: fn.name, args: {} })
              this.emit({
                type: 'tool_end',
                tool: fn.name,
                result: {
                  callId: tc.id, ok: false, content: '', durationMs: 0,
                  error: notExecutedNote(`工具 "${fn.name}" 的参数不是合法 JSON，无法解析，未执行`),
                },
              })
              this.messages.push({
                role: 'tool',
                content: notExecutedNote(`工具 "${fn.name}" 的参数不是合法 JSON，无法解析，未执行。`
                  + `请重新调用并给出严格的 JSON 参数（字符串用双引号、不要尾随逗号、不要注释）`),
                tool_call_id: tc.id,
              })
              continue
            }

            // 安全检查
            const guardResult = getSecurityGuard().checkToolCall(tc)
            if (!guardResult.allowed) {
              this.messages.push({
                role: 'tool',
                content: notExecutedNote(`安全审查阻止了 ${fn.name} — ${guardResult.summary}`),
                tool_call_id: tc.id,
              })
              continue
            }
            if (guardResult.requiresApproval && !this.config.skipApproval) {
              // 创建审批请求
              const approvalReq = getApprovalService().requestApproval({
                sessionId: this.sessionId,
                agentId: this.config.personaId || 'default',
                toolName: fn.name,
                toolArgs: args,
                description: `${fn.name}: ${JSON.stringify(args).slice(0, 100)}`,
                riskLevel: guardResult.severity === GuardSeverity.CRITICAL ? 'critical' :
                           guardResult.severity === GuardSeverity.HIGH ? 'high' : 'medium',
                threatCategories: guardResult.findings.map(f => f.category),
                securityFindings: guardResult.findings.map(f => f.title),
              })

              if (approvalReq) {
                this.emit({ type: 'tool_start', tool: fn.name, args })
                this.messages.push({
                  role: 'tool',
                  content: `🔐 需要审批才能执行 "${fn.name}"。审批ID: \`${approvalReq.id}\`\n请通过弹出的审批窗口批准/拒绝。\n\n风险: ${guardResult.summary}`,
                  tool_call_id: tc.id,
                })
                // 真正等待用户决策
                this.emit({ type: 'approval:pending', requestId: approvalReq.id, toolName: fn.name, args, summary: guardResult.summary } as any)
                const decision = await getApprovalService().waitForDecision(approvalReq.id)
                if (decision === ApprovalDecision.APPROVED) {
                  // 用户批准 → 真正执行
                  this.emit({ type: 'approval:resolved', requestId: approvalReq.id, decision: 'approved' })
                } else {
                  const reason = decision === ApprovalDecision.TIMEOUT ? '审批超时' : '用户拒绝'
                  this.messages.push({
                    role: 'tool',
                    content: notExecutedNote(`"${fn.name}" 已被${reason}，未执行`),
                    tool_call_id: tc.id,
                  })
                  this.emit({ type: 'tool_end', tool: fn.name, result: { callId: tc.id, ok: false, content: `审批${reason}` } })
                  continue
                }
              }
            }

            this.emit({ type: 'tool_start', tool: fn.name, args })
            // Hook — beforeToolCall (可 veto 或要求审批)
            const hookCtx = this._buildHookContext()
            const hookResult = await getHookManager().runBeforeToolCall({
              ctx: hookCtx,
              toolName: fn.name,
              toolArgs: args,
            })
            if (hookResult.vetoed) {
              this.messages.push({
                role: 'tool',
                content: `⛔ Hook 阻止: ${hookResult.reason || fn.name}`,
                tool_call_id: tc.id,
              })
              continue
            }
            // 自动审批分类
            const approvalLevel = (hookResult as any).requireApproval || classifyApproval(fn.name, args)
            if (approvalLevel && !this.config.skipApproval) {
              const approvalReq = getApprovalService().requestApproval({
                sessionId: this.sessionId,
                agentId: (this.config as any).agentId || 'default',
                toolName: fn.name,
                toolArgs: args,
                description: `${fn.name}: ${JSON.stringify(args).slice(0, 100)}`,
                riskLevel: approvalLevel === 'critical' ? 'critical' :
                           approvalLevel === 'high' ? 'high' : 'medium',
              })
              if (approvalReq) {
                this.emit({ type: 'tool_start', tool: fn.name, args })
                this.messages.push({
                  role: 'tool',
                  content: `🔐 需要审批才能执行 "${fn.name}"。审批ID: \`${approvalReq.id}\`\n请通过弹出的审批窗口批准/拒绝。\n\n级别: ${approvalLevel}`,
                  tool_call_id: tc.id,
                })
                // 真正等待用户决策
                this.emit({ type: 'approval:pending', requestId: approvalReq.id, toolName: fn.name, args } as any)
                const decision = await getApprovalService().waitForDecision(approvalReq.id)
                if (decision === ApprovalDecision.APPROVED) {
                  this.emit({ type: 'approval:resolved', requestId: approvalReq.id, decision: 'approved' })
                } else {
                  const reason = decision === ApprovalDecision.TIMEOUT ? '审批超时' : '用户拒绝'
                  this.messages.push({
                    role: 'tool',
                    content: notExecutedNote(`"${fn.name}" 已被${reason}，未执行`),
                    tool_call_id: tc.id,
                  })
                  this.emit({ type: 'tool_end', tool: fn.name, result: { callId: tc.id, ok: false, content: `审批${reason}` } })
                  continue
                }
              }
            }

            // 安全门封禁检查 — 被封禁的工具直接返回阻止结果
            if (blockedTools.has(fn.name)) {
              const unblockRound = blockedTools.get(fn.name)!
              const blockedResult = {
                callId: tc.id, ok: false, content: '', durationMs: 0,
                error: notExecutedNote(`工具 "${fn.name}" 已被安全门临时封禁（至第 ${unblockRound} 轮）`),
              }
              this.emit({ type: 'tool_end', tool: fn.name, result: blockedResult })
              this.messages.push({
                role: 'tool',
                content: blockedResult.error,
                tool_call_id: tc.id,
              })
              continue
            }

            const toolStartTime = Date.now()

            // 增量流式预执行 — 检查是否有缓存结果
            const earlyCache = (response as any).earlyResults?.[tc.id]
            let result: Awaited<ReturnType<typeof executeToolWithRetry>>
            if (earlyCache) {
              const content = earlyCache.content || ''
              const error = earlyCache.error
              result = { callId: tc.id, ok: !error, content, error, durationMs: 0 }
              console.log(`[AgentRunner] ⚡ 使用增量预执行结果: ${fn.name} (${tc.id}) — ${content.length} 字符`)
            } else {
              result = await executeToolWithRetry(fn.name, args)
            }
            const toolDuration = Date.now() - toolStartTime

            // 诊断埋点 — 工具调用
            getDiagnosticsStore().addToolCall({
              timestamp: new Date().toISOString(),
              toolName: fn.name,
              args: JSON.stringify(args).slice(0, 200),
              result: result.ok ? result.content.slice(0, 200) : '',
              ok: result.ok,
              error: result.ok ? undefined : result.error,
              durationMs: toolDuration,
            })
            // Hook — afterToolCall
            getHookManager().runAfterToolCall({
              ctx: hookCtx, toolName: fn.name, toolArgs: args,
              result: result.ok ? result.content : '',
              error: result.ok ? undefined : result.error,
              durationMs: toolDuration,
            }).catch(() => {})
            this.emit({ type: 'tool_end', tool: fn.name, result })
            this.messages.push({
              role: 'tool',
              content: toolResultText(result),
              tool_call_id: tc.id,
            })
          } else {
            // 多工具并行 — 先过安全审查
            const allowedCalls: typeof response.toolCalls = []
            for (const tc of response.toolCalls) {
              // 安全门封禁检查
              if (blockedTools.has(tc.function.name)) {
                const unblockRound = blockedTools.get(tc.function.name)!
                this.messages.push({
                  role: 'tool',
                  content: notExecutedNote(`工具 "${tc.function.name}" 已被安全门临时封禁（至第 ${unblockRound} 轮）`),
                  tool_call_id: tc.id,
                })
                continue
              }
              const guardResult = getSecurityGuard().checkToolCall(tc)
              if (!guardResult.allowed) {
                this.messages.push({
                  role: 'tool',
                  content: notExecutedNote(`安全审查阻止了 ${tc.function.name} — ${guardResult.summary}`),
                  tool_call_id: tc.id,
                })
                continue
              }
              if (guardResult.requiresApproval && !this.config.skipApproval) {
                this.messages.push({
                  role: 'tool',
                  content: notExecutedNote(`${tc.function.name} 需要审批但未获批准 — ${guardResult.summary}`),
                  tool_call_id: tc.id,
                })
                continue
              }
              allowedCalls.push(tc)
            }
            if (allowedCalls.length === 0) {continue}

            const batches = groupParallelBatches(allowedCalls)
            for (const batch of batches) {
              const batchResults = await executeToolsParallel(batch)
              for (const item of batchResults) {
                // 🔧 模型偶尔会吐出畸形 JSON 参数。这里原来直接 JSON.parse，
                //   一次解析失败就会把整个 ReAct 轮抛出去 → 整轮回答直接崩掉，
                //   用户看到的是"莫名其妙失败"。参数解析失败不该影响其余工具。
                let parsedArgs: any = {}
                try {
                  parsedArgs = JSON.parse(item.call.function.arguments || '{}')
                } catch {
                  parsedArgs = { __unparsable: String(item.call.function.arguments || '').slice(0, 200) }
                }
                this.emit({ type: 'tool_start', tool: item.call.function.name, args: parsedArgs })
                this.emit({ type: 'tool_end', tool: item.call.function.name, result: item.result })
                this.messages.push({
                  role: 'tool',
                  content: toolResultText(item.result),
                  tool_call_id: item.call.id,
                })
              }
            }
          }

          // 🆕 Lucky 模式检测：工具调用后检查
          const luckyConfig = getLuckyConfig()
          if (luckyConfig.preset !== 'off') {
            const toolNames = response.toolCalls.map(tc => tc.function.name)
            const tokenEstimate = Math.ceil((response.text?.length || 0) / 2)

            const { decision, stateUpdates } = checkLuckyModeForReAct({
              outputText: response.text || '',
              toolCallsInThisTurn: response.toolCalls.length,
              tokensUsedInThisTurn: tokenEstimate,
              toolNames,
              currentMode: this._currentMode,
              currentMood: this._currentMood,
            })

            // 应用状态更新
            if (Object.keys(stateUpdates).length > 0) {
              setLuckyState(stateUpdates)
            }

            if (decision.shouldPause) {
              console.log(`[LuckyMode] ⏸ ReAct 循环暂停: ${decision.remindMessage}`)
              this.emit({ type: 'thinking', text: `⏸ ${decision.remindMessage}` })
              finalText = decision.remindMessage || 'Lucky 模式暂停循环'
              break
            }

            if (decision.shouldRemind && decision.remindMessage) {
              console.log(`[LuckyMode] 💡 注入提醒: ${decision.remindMessage}`)
              this.messages.push({
                role: 'system',
                content: `[Lucky 模式提醒] ${decision.remindMessage}`,
              })
              continue  // 提醒后继续下一轮
            }

            if (!decision.shouldContinue) {
              console.log(`[LuckyMode] ⏹ Lucky 模式决定停止循环`)
              break
            }
          }
          continue
        }

        // 纯文本回复
        finalText = cleanToolNoiseText((response.text || '').trim())
        if (!finalText) {
          consecutiveEmptyCount++
          console.warn(`[AgentRunner] LLM 返回空回复且无工具调用 (连续 ${consecutiveEmptyCount} 次)`)

          // ── P0b 简化：空回复只尝试 2 次 ← 原来是 4 次+清上下文 ═══
          if (consecutiveEmptyCount === 1) {
            // 第 1 次：简单提示继续
            if (this.config?.socialMode) {
              const others = this.messages.filter((m: any) => !(m.role === 'system' && typeof m.content === 'string' && m.content.includes('[内部续话指令')))
              this.messages = [...others, { role: 'system' as const, content: '[内部续话指令·非用户发言] 请继续你的回复，给出你的实际回答。' }]
            } else {
              this.messages.push({ role: 'user', content: '请继续你的回复，给出你的实际回答。' })
            }
            continue
          }

          if (consecutiveEmptyCount === 2) {
            // 第 2 次：给更明确的提示
            if (this.config?.socialMode) {
              const others = this.messages.filter((m: any) => !(m.role === 'system' && typeof m.content === 'string' && m.content.includes('[内部续话指令')))
              this.messages = [...others, { role: 'system' as const, content: '[内部续话指令·非用户发言] 请用自然语言给出实际回答，不要输出工具调用或系统指令。' }]
            } else {
              this.messages.push({ role: 'user', content: '请用自然语言给出实际回答，不要输出工具调用或系统指令。' })
            }
            continue
          }

          // 第 3+ 次：放弃，交给 L1/L2/L3 恢复流程
          console.error(`[AgentRunner] 连续 ${consecutiveEmptyCount} 次空回复，中断循环启动恢复流程`)
          break
        }
        consecutiveEmptyCount = 0  // 重置计数
        this.messages.push({ role: 'assistant', content: finalText })

        // ═══════════════════════════════════════════════════════
        // 🆕 P1: 精简 auto-continue — 只处理"无实质内容"场景，最多续 1 次
        // ═══════════════════════════════════════════════════════
        const hasSubstantiveContent =
          finalText.includes('```') ||
          (finalText.match(/[。！？.!?]/g)?.length ?? 0) >= 2 ||
          (finalText.length >= 150 && /^(第一步|首先|总结|综上所述|因此|所以)/.test(finalText.trim()))

        // 意图句式检测 + 防循环
        //   模型说"我去查"但没实际调工具或输出结果，进入自动继续。
        //   新增强：同句重复2次 → 强制打断；autoContinue上限3次。
        //   同时检测上下文中是否已有搜索结果（由 preProcessMessage 注入）
        const isIntentOnly = /^(我来|让我|我先|我去|让我来|我帮你|我给大家|我给你|我这就|马上|这就去|现在我来|现在让我)/.test(finalText.trim()) &&
          /查[一一下]?|看[一一看]?|搜索|检查|确认|问问|核实|研究|分析|查查|看看|搜一搜|探索|调查|测试|试试|验证|确认一下/.test(finalText) &&
          !/\b(结果|结论|答案|资料|信息|数据|如下|找到|发现|查到|搜索到|获取到|根据|显示|如下|是的|好的|已经)\b/.test(finalText)

        // 检查上下文中是否已有搜索结果（由 preProcessMessage 注入）
        const hasSearchResult = (this.messages as AgentMessage[]).some(m =>
          (m.role === 'tool' || m.role === 'system' || m.role === 'assistant') &&
          (toText(m.content).includes('实时搜索') || toText(m.content).includes('搜索结果') || toText(m.content).includes('【实时搜索结果】'))
        )

        const needsContinue = !hasSubstantiveContent && (
          isIntentOnly ||
          (finalText.length < 200 && /下一步|接下来|还需要|你要|我需要|请告诉我/.test(finalText))
        )

        if (needsContinue && this._autoContinueCount < 3 && round < maxRounds - 2) {
          this._autoContinueCount++

          // 检测意图句式重复循环
          //   同一 intent 句式连续出现2次→说明陷入循环，强制打断
          let isIntentRepeating = false
          if (isIntentOnly) {
            const currentHash = finalText.trim().slice(0, 60)
            if (currentHash === this._lastIntentHash) {
              isIntentRepeating = true
            }
            this._lastIntentHash = currentHash
          } else {
            this._lastIntentHash = '' // 非意图句式时清除
          }

          // 根据不同场景注入不同强度的继续指令
          // 三处 role 污染修复 — socialMode 下必须用 'system' + 前缀，防止群聊中被当成用户发言
          if (isIntentRepeating) {
            // 同一句式重复 → 强制打断
            const forceHint = '⚠️ 你已经在多轮中重复说同一句话。请直接给出明确回答，不要再说"我来查"之类的话。'
            this.messages.push({
              role: this.config?.socialMode ? 'system' : 'user',
              content: this.config?.socialMode ? '[内部续话指令·非用户发言] ' + forceHint : forceHint,
            })
            this.emit({ type: 'thinking', text: `🔄 检测到意图句式重复循环，已强制打断 (${this._autoContinueCount}/3)` })
          } else if (isIntentOnly && hasSearchResult) {
            // 搜索结果已在上下文但 LLM 还在说"我来查"→ 直接要求归纳
            const hint = '搜索结果已经提供了。请直接根据搜索结果归纳回答用户问题，不要再说"我去查"，也不要输出 <tool_call> 等 XML 标记。'
            this.messages.push({
              role: this.config?.socialMode ? 'system' : 'user',
              content: this.config?.socialMode ? '[内部续话指令·非用户发言] ' + hint : hint,
            })
            this.emit({ type: 'thinking', text: `🔄 检测到意图句式+已有搜索结果，已注入"直接归纳" (${this._autoContinueCount}/3)` })
          } else if (isIntentOnly) {
            // 没有搜索结果但 LLM 说"我去查"→ 引导输出 XML 工具调用
            const hint = '请直接输出 <web_search(query="你的搜索词")> 这样的 XML 标签来执行搜索，系统会自动搜索并返回结果给你。不要只是口头上说"我去查"，要实际输出 XML 工具调用标签。'
            this.messages.push({
              role: this.config?.socialMode ? 'system' : 'user',
              content: this.config?.socialMode ? '[内部续话指令·非用户发言] ' + hint : hint,
            })
            this.emit({ type: 'thinking', text: `🔄 检测到意图句式，已注入引导 (${this._autoContinueCount}/3)` })
          } else {
            // 普通自动继续
            const hint = this._autoContinueCount <= 1
              ? '请继续你的回答，给出实质内容。'
              : '请继续你的回答，不要重复之前的内容，给出最终答案。'
            this.messages.push({
              role: this.config?.socialMode ? 'system' : 'user',
              content: this.config?.socialMode
                ? '[内部续话指令·非用户发言] ' + hint
                : hint,
            })
            this.emit({ type: 'thinking', text: `🔄 自动继续 (${this._autoContinueCount}/3)` })
          }
          finalText = ''
          continue
        }

        // 🆕 Lucky 模式检测：文本回复后 — 检查完成度 / 死循环
        if (getLuckyConfig().preset !== 'off') {
          const { decision, stateUpdates } = checkLuckyModeForReAct({
            outputText: finalText,
            toolCallsInThisTurn: 0,
            tokensUsedInThisTurn: 0,
            toolNames: [],
            currentMode: this._currentMode,
            currentMood: this._currentMood,
          })
          if (Object.keys(stateUpdates).length > 0) {
            setLuckyState(stateUpdates)
          }
          if (decision.shouldContinue && !decision.shouldPause) {
            console.log(`[LuckyMode] 🔄 Lucky 模式继续循环（完成度不足）`)
            this.emit({ type: 'thinking', text: `🔄 ${decision.remindMessage || '继续循环...'}` })
            this.messages.push({
              role: 'system',
              content: `[Lucky 模式] ${decision.remindMessage || '继续推进任务。'}`,
            })
            finalText = ''
            continue
          }
          if (decision.shouldPause) {
            console.log(`[LuckyMode] ⏸ 文本回复后暂停: ${decision.remindMessage}`)
            this.emit({ type: 'thinking', text: `⏸ ${decision.remindMessage}` })
            finalText = decision.remindMessage || 'Lucky 模式暂停循环'
            break
          }
        }

        break

      } catch (err: any) {
        if (err.name === 'AbortError') {
          // 被中止时保留已生成的思考内容
          const partialContent = this.messages
            .filter(m => m.role === 'assistant' && toText(m.content).trim())
            .map(m => toText(m.content).trim())
            .filter(Boolean)
            .join('\n\n')
          if (partialContent) {
            finalText = partialContent
            console.log(`[AgentRunner] ⏹ 已中止，但保留了 ${partialContent.length} 字已有内容`)
          } else {
            finalText = '⏰ 生成超时。长对话上下文积累较多，建议追问具体问题。'
          }
          break
        }
        this.emit({ type: 'error', error: err.message })
        globalEventBus.emit(BusEvents.AGENT_ERROR, { error: err.message })
        if (!this.isRecovering) {
          this.isRecovering = true
          // 🔧 P3 重做: 同样给分类文案，但只透出**用户能理解的部分**。
          //   原始 err.message 可能含 URL / 路径 / 堆栈 / 密钥片段，不直接回显。
          finalText = describeRunFailure(err?.message || '未知错误')
          try { this.messages = this.messages.slice(-10) } catch {}
          this.isRecovering = false
        }
        break
      }
    }

    // ═══════════════════════════════════════════════════════
    // P1: 精简恢复流程 — 聚合→LLM总结→兜底，2 级即可
    // ═══════════════════════════════════════════════════════
    let finalText_ = (finalText || '').trim()

    if (!finalText_ && !this.abortController?.signal.aborted) {
      console.warn(`[AgentRunner] ReAct 循环耗尽，启动恢复`)

      // 第 1 级：聚合本轮 assistant 回复（去重）
      // 🔧 P0: 尝试从 compactedSummary 恢复
      if (this._compressedSummary && this._compressedSummary.length > 10) {
        finalText_ = this._compressedSummary + '\n\n' + (finalText_ || '')
        console.log(`[AgentRunner] ✅ compactedSummary 恢复: ${this._compressedSummary.length} 字`)
      }

      const seen = new Set<string>()
      const assistantTexts = this.messages
        .slice(this._runStartIndex)
        .filter(m => m.role === 'assistant' && toText(m.content).trim())
        .map(m => toText(m.content).trim())
        .filter(t => {
          const key = _normalizeDedupeKey(t)
          if (!key || seen.has(key)) {return false}
          seen.add(key)
          return true
        })
      const aggregated = _stripRepeatedBlocks(assistantTexts.join('\n\n').trim())
      // 对聚合内容清洗工具调用噪声，防止 raw XML 泄漏到回复气泡
      const cleanedAggregated = cleanToolNoiseText(aggregated)

      if (cleanedAggregated.trim().length > 5) {
        finalText_ = cleanedAggregated
        console.log(`[AgentRunner] ✅ 聚合恢复(清洗后): ${assistantTexts.length} 条, ${finalText_.length} 字`)
      } else if (aggregated.length > 5) {
        finalText_ = aggregated
        console.log(`[AgentRunner] ✅ 聚合恢复(原文): ${assistantTexts.length} 条, ${finalText_.length} 字`)
      } else {
        // 第 2 级：请求 LLM 无工具总结（仅一次）
        try {
          const runMsgs = this.messages.slice(this._runStartIndex)
          const sys = this.messages[0]
          this.messages = runMsgs.length > 24
            ? [sys, ...runMsgs.slice(-24)]
            : [sys, ...runMsgs]
          this.messages.push({
            role: 'user',
            content: '请根据本轮对话给出一个简洁的自然语言回复。不要调用工具，不要输出代码块。',
          })
          const resp = await this.callLLM([], { timeoutOverride: 300 })
          const raw = (resp.text || '').trim()
          if (raw) {
            finalText_ = _stripRepeatedBlocks(raw)
            this.messages.push({ role: 'assistant', content: finalText_ })
            console.log(`[AgentRunner] ✅ LLM 总结恢复: ${finalText_.length} 字`)
          }
        } catch {
          // 静默降级
        }
      }
    }

    finalText = (finalText_ || '').trim()

    // 兜底：无内容 → 留给 sendMessage 的外层恢复（Level B）
    //    v16.3: 改为返回空而非"超时了"文案，让 sendMessage 的全路径恢复
    //    （简化上下文 + 无工具 ReAct）有机会执行，成功率更高
    if (!finalText) {
      finalText = ''
    }

    // 安全 strip 链 — 防止内容被过度剥离
    finalText = _safeStripChain(finalText, _stripFillerText, _stripMetaCommentary, _stripLeakedOutput)

    // 重复结构化块截断（同一段新闻/列表/搜索输出最多出现 1 次）
    finalText = _stripRepeatedBlocks(finalText)

    return finalText
  }

  // ═════════════════════════════════════════════════════════
  // Worker 模式
  // ═════════════════════════════════════════════════════════

  /**
   * 创建一次性 Worker Agent 执行独立子任务（无对话上下文）
   * @param config - 运行配置
   * @param task - 任务描述
   * @param allowedTools - 允许使用的工具列表（可选，默认使用 chat 工具集）
   * @returns Worker 的执行结果文本
   */
  static async createWorker(
    config: AgentRunConfig,
    task: string,
    allowedTools?: string[]
  ): Promise<string> {
    const workerConfig: AgentRunConfig = {
      ...config,
      mode: 'agent',
      systemPrompt: `你是 Lumina Worker，高效执行单个子任务。只输出结果，不闲聊。`,
      maxToolCalls: 3,
    }
    const runner = new AgentRunner(workerConfig)
    return runner.sendMessage(task)
  }

  // ═════════════════════════════════════════════════════════
  // LLM 调用
  // ═════════════════════════════════════════════════════════

  /**
   * 🔧 v2.16: 从 API 动态检测上下文窗口大小（替代硬编码推测）
   *
   * 策略：
   *   1. 查询 /models 端点获取 max_context_length (LM Studio / Ollama / vLLM)
   *   2. 若 API 不返回此字段，根据已知模型数据库匹配
   *   3. 都不行则用保守默认值 32K
   *
   * 检测结果按 baseUrl+model 缓存。
   */

  private async detectContextLimit(): Promise<number> {
    // 用户手动指定 > 自动检测
    if (this.config.contextWindow && this.config.contextWindow > 0) {
      return this.config.contextWindow
    }

    const model = this.config.model
    const cacheKey = `${this.config.baseUrl}::${model}`

    // 已缓存
    const cached = _detectedContextCache.get(cacheKey)
    if (cached != null) {return cached}

    // ── Step 1: 查询 API /models 端点 ──
    try {
      const res = await fetch(`${this.config.baseUrl}/models`, {
        headers: { 'Authorization': `Bearer ${this.config.apiKey}` },
        signal: AbortSignal.timeout(5000),
      })

      if (res.ok) {
        const data = await res.json()
        const models: any[] = data.data || []

        // vLLM 可能返回 max_model_len
        const match = models.find((m: any) => m.id === model)
        if (match) {
          const limit = match.max_context_length
            || match.context_length
            || match.context_window
            || match.max_model_len     // vLLM
            || match.max_tokens

          if (limit && limit > 0) {
            console.log(`[AgentRunner] ✅ API 检测: ${model} = ${TokenEstimator.format(limit)} tokens`)
            _detectedContextCache.set(cacheKey, limit)
            return limit
          }
        }

        // 模糊匹配：模型名不在列表，用第一个模型的数据
        if (!match && models.length > 0) {
          const first = models[0]
          const limit = first.max_context_length || first.context_length
            || first.context_window || first.max_model_len
          if (limit) {
            console.log(`[AgentRunner] ⚠️ "${model}" 不在列表，使用首个模型窗口: ${TokenEstimator.format(limit)}`)
            _detectedContextCache.set(cacheKey, limit)
            return limit
          }
        }
      }
    } catch (e: any) {
      // /models 端点不可用，继续下一步
    }

    // ── Step 2: 已知模型数据库匹配 ──
    const modelLower = model.toLowerCase()
    for (const [key, limit] of Object.entries(_KNOWN_MODEL_WINDOWS)) {
      if (modelLower.includes(key)) {
        console.log(`[AgentRunner] 📚 数据库匹配: "${model}" → ${key} = ${TokenEstimator.format(limit)} tokens`)
        _detectedContextCache.set(cacheKey, limit)
        return limit
      }
    }

    // ── Step 3: 解析模型名中的参数大小推测 ──
    // 例如 "qwen2.5-72b" → 72B → 128K
    const sizeMatch = modelLower.match(/(\d+)b/)
    if (sizeMatch) {
      const size = parseInt(sizeMatch[1])
      let limit = 262_144  // 默认 256K（现代模型普遍支持大上下文）
      if (size >= 70) {limit = 1_048_576}      // 70B+ 普遍支持 1M
      else if (size >= 30) {limit = 524_288}   // 30-70B 普遍支持 512K
      else if (size >= 13) {limit = 262_144}   // 13-30B 普遍支持 256K
      else if (size >= 7) {limit = 131_072}    // 7-13B 普遍支持 128K
      console.log(`[AgentRunner] 🔮 参数推测: ${size}B → ${TokenEstimator.format(limit)} tokens`)
      _detectedContextCache.set(cacheKey, limit)
      return limit
    }

    // ── Step 4: 完全未知 → 256K 保守默认 ──
    const fallback = 262_144
    console.log(`[AgentRunner] ❓ "${model}" 未知模型，使用默认 ${TokenEstimator.format(fallback)} tokens`)
    _detectedContextCache.set(cacheKey, fallback)
    return fallback
  }

  /** 裁剪消息历史以适应上下文窗口（保留 system 消息 + 最近的消息） */
  private trimContext(messages: AgentMessage[], contextLimit: number): AgentMessage[] {
    // 安全阈值：使用窗口的 85%，留 15% 给生成
    const safeLimit = Math.floor(contextLimit * 0.85)

    // 分离 system 消息和非 system 消息
    const sysMsgs = messages.filter(m => m.role === 'system')
    const otherMsgs = messages.filter(m => m.role !== 'system')

    // 估算 system 消息的 token 数
    const estimator = new TokenEstimator()
    const sysTokens = estimator.estimateMessages(sysMsgs as any[])

    // 剩余空间给对话历史
    const historyBudget = safeLimit - sysTokens
    if (historyBudget <= 0) {
      // 连 system 消息都超了，只能保留最后一条 system
      console.warn(`[AgentRunner] ⚠️ 系统提示词 (${TokenEstimator.format(sysTokens)}) 超出上下文预算!`)
      return [...sysMsgs.slice(-1), ...otherMsgs.slice(-3)]
    }

    // 从后往前保留对话消息，直到接近历史预算
    const kept: AgentMessage[] = []
    let usedTokens = 0
    for (let i = otherMsgs.length - 1; i >= 0; i--) {
      const est = estimator.estimate(toText(otherMsgs[i].content))
      if (usedTokens + est > historyBudget * 0.9 && kept.length >= 2) {break}
      kept.unshift(otherMsgs[i])
      usedTokens += est
    }

    if (otherMsgs.length - kept.length > 0) {
      console.log(
        `[AgentRunner] 📐 上下文裁剪: ${otherMsgs.length}→${kept.length} 条对话消息 ` +
        `(sys:${TokenEstimator.format(sysTokens)}, hist:${TokenEstimator.format(usedTokens)}, ` +
        `limit:${TokenEstimator.format(contextLimit)})`
      )
    }

    return [...sysMsgs, ...kept]
  }

  private async callLLM(tools: any[], options?: { timeoutOverride?: number }): Promise<{
    text?: string
    toolCalls?: LLMToolCall[]
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
    error?: string
    aborted?: boolean
    earlyResults?: Record<string, { content: string; error?: string }>
  }> {
    // 从 API 动态检测上下文窗口（替代硬编码推测）
    const contextLimit = await this.detectContextLimit()
    const messages = this.trimContext([...this.messages], contextLimit)

    // 合并连续同角色消息 — 某些 API (LM Studio, deepseek, 等) 要求 user/assistant 严格交替
    const mergedMessages: AgentMessage[] = []
    for (const m of messages) {
      const last = mergedMessages[mergedMessages.length - 1]
      if (last && last.role === m.role && m.role !== 'tool') {
        // v10.9: 合并内容 — 支持多模态数组
        if (Array.isArray(last.content) || Array.isArray(m.content)) {
          // 多模态：将两者都转为数组格式合并
          const lastArr = Array.isArray(last.content) ? last.content : [{ type: 'text', text: last.content || '' }]
          const mArr = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content || '' }]
          last.content = [...lastArr, ...mArr]
        } else {
          last.content = (last.content || '') + '\n\n' + (m.content || '')
        }
        // 🔧 合并相邻 assistant 时必须把 tool_calls 也带过来。
        //   模型一轮同时返回 content 和 tool_calls 是常见情况（DeepSeek/Qwen），
        //   callLLM 里先 push 了一条"只有文本"的 assistant，循环里又 push 一条
        //   "文本 + tool_calls" 的 —— 合并时 last 是**第一条（没有 tool_calls）**，
        //   tool_calls 被静默丢掉，紧跟其后的 role:'tool' 就成了孤儿，
        //   OpenAI/vLLM 直接 400，用户只看到"无法识别的错误"。
        if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
          last.tool_calls = [...(last.tool_calls || []), ...m.tool_calls]
        }
      } else {
        mergedMessages.push({ ...m })
      }
    }

    // 防御性检查 — 确保第一条非 system 消息是 user 角色
    //   Qwen 等模型的 Jinja 模板要求 system 后面紧跟 user，不能是 tool/assistant
    const hasUserMessage = mergedMessages.some(m => m.role === 'user')
    const firstNonSystemIdx = mergedMessages.findIndex(m => m.role !== 'system')
    const firstNonSystemIsUser = firstNonSystemIdx >= 0 && mergedMessages[firstNonSystemIdx]?.role === 'user'

    if (!hasUserMessage || !firstNonSystemIsUser) {
      const insertIdx = firstNonSystemIdx >= 0 ? firstNonSystemIdx : 1
      mergedMessages.splice(insertIdx, 0, {
        role: 'user',
        content: hasUserMessage ? '（继续）' : '你好',
      })
    }

    // 🔧 协议清洗 — 合并相邻 assistant 之后，可能出现 tool_call_id 对不上的
    //   孤儿 tool 消息（合并丢 tool_calls 造成的历史遗留也在这一步兜住）。
    //   OpenAI 兼容网关会直接 400，所以主路径这里也要走一遍 sanitize。
    {
      const cleaned = sanitizeHistoryForApi(mergedMessages)
      mergedMessages.length = 0
      mergedMessages.push(...cleaned)
    }

    // LM Studio / 本地模型兼容 — tool 角色转 user
    //   很多本地模型（Qwen、Llama 等）的 Jinja 模板不支持 "tool" 角色
    //   将其转为 user 消息带 [工具结果] 前缀
    const isLocalModel = this.config.baseUrl?.includes('localhost')
      || this.config.baseUrl?.includes('127.0.0.1')
      || this.config.baseUrl?.includes('192.168.')
    const fixedMessages = mergedMessages.map(m => {
      if (m.role === 'tool' && isLocalModel) {
        return {
          ...m,
          role: 'user' as const,
          content: `[工具返回: ${m.tool_call_id?.slice(0, 8) || '?'}] ${m.content || ''}`,
        }
      }
      return m
    })

    // 🔧 QwenPaw 风格：在 LLM 调用前主动检查并压缩上下文
    //   避免上下文过大导致模型处理缓慢而超时
    this.compactContext()

    const requestBody: any = {
      model: this.config.model,
      messages: fixedMessages as any[],
      temperature: this.config.temperature || 0.7,
      // 🔧 FIX: max_tokens 是输出上限，封顶 32768 防止误传上下文窗口值导致 API 400
      max_tokens: Math.min(this.config.maxTokens || 4096, 32768),
    }

    // 注意：tools 是否随请求发送，统一由下方「工具路由」根据 provider 档案
    //   + 模型能力缓存（曾因 tools 被拒则不再发）决定，此处不再无条件预设，
    //   否则会把「该模型不支持工具」的判断架空。

    // ── v3.8 超时配置（借鉴 QwenPaw）───────────────────
    // ❌ 删除：自定义首token超时（推理模型必然超30s）
    // ✅ 改为：HTTP 层总超时 + 连接心跳检测
    //   推理模型自动获得更长超时（providerProfiles）
    //   连接活跃 → 继续等；连接断开 → 判死
    //
    const isSocialMode = !!this.config.socialMode
    const profile = matchProfile(this.config.baseUrl, this.config.model)
    const isReasoning = profile?.model.category === 'reasoning'

    // 超时优先级：环境变量 > provider档案 > 默认值
    const envTimeout = parseInt(process.env.LUMINA_LLM_TIMEOUT || '0', 10)
    const profileTimeout = profile?.model.recommendedHttpTimeout || 300
    // 社交模式（团队群聊/委托）使用无限超时
    //   团队群聊需要长时间推理和多轮工具调用，600s 不够
    //   子 Agent 委托也需要足够时间处理复杂任务
    const httpTimeoutSeconds = isSocialMode ? 0 : (envTimeout || profileTimeout)

    // 最大上下文 tokens
    const maxContextTokens = parseInt(
      process.env.LUMINA_LLM_MAX_CONTEXT_TOKENS ||
        String(profile?.model.maxContextTokens || 256_000),
      10,
    )

    // 工具路由：仅跳过档案明确标记不支持 tool-calling 的模型
    //   去掉全局黑名单 — QwenPaw 风格：每次请求都带 tools
    //     问题: 一次 400 就永久封禁模型 → 模型切换后也受影响
    //     修复: 只看 profile.model.supportsTools（精确标记），不做运行时封禁
    // 能力缓存：该模型此前因 tools 被服务端拒绝（400）→ 本会话起不再发 tools，
    //   改走纯对话 / XML 工具路径，避免每次请求都报错。
    let cachedNoTools = false
    try {
      cachedNoTools = getModelCapabilityCache().get(this.config.model)?.supportsTools === false
    } catch { /* 缓存不可用则忽略 */ }
    const modelLacksTools = (profile && !profile.model.supportsTools) || cachedNoTools
    const shouldSendTools = tools.length > 0 && !modelLacksTools

    if (shouldSendTools) {
      requestBody.tools = tools
      requestBody.tool_choice = 'auto'
    } else if (tools.length > 0) {
      const reason = modelLacksTools
        ? (cachedNoTools ? '能力缓存标记不支持工具(自动降级)' : '档案标记不支持tool-calling')
        : '未知原因'
      console.log(`[AgentRunner] 跳过工具 (${reason}: ${this.config.model})`)
    }

    console.log(
      `[AgentRunner] ${isSocialMode ? '⚡社交 ' : ''}` +
      `📡 ${isReasoning ? '推理模型' : '标准模型'} ` +
      `超时:${httpTimeoutSeconds}s 上下文:${TokenEstimator.format(maxContextTokens)} ` +
      `模型:${this.config.model}`,
    )

    // ── 健康检查：验证模型已加载 ──
    if (!this._healthChecked) {
      this._healthChecked = true
      try {
        const checkRes = await fetch(`${this.config.baseUrl}/models`, {
          signal: AbortSignal.timeout(10_000),
          headers: { 'Authorization': `Bearer ${this.config.apiKey}` },
        })
        if (checkRes.ok) {
          const modelList = await checkRes.json().catch(() => null)
          const loadedModels: string[] = modelList?.data?.map((m: any) => m.id) || []
          const modelShortName = this.config.model.replace(/[:/\\]/g, '_').split('_').pop() || this.config.model
          const modelFound = loadedModels.some((m: string) =>
            m.includes(modelShortName) || m.includes(this.config.model) ||
            this.config.model.includes(m))
          if (modelFound) {
            console.log(`[AgentRunner] ✅ 模型就绪: ${this.config.model}`)
          } else if (loadedModels.length > 0) {
            console.warn(`[AgentRunner] ⚠️ 模型未在列表中: ${loadedModels.join(', ')}`)
          }
        }
      } catch (e: any) {
        if (e.name === 'TimeoutError') {
          this._healthChecked = false
          return { error: `无法连接 ${this.config.baseUrl}（10s 无响应）\n请确认 LLM 服务是否运行` }
        }
      }
    }

    // ── 上下文大小估算 ──
    const estimator2 = new TokenEstimator()
    const estTokens = estimator2.estimateMessages(requestBody.messages) +
      estimator2.estimate(JSON.stringify(requestBody.tools || {}))
    if (estTokens > maxContextTokens * 0.85) {
      console.warn(
        `[AgentRunner] ⚠️ 上下文 ${TokenEstimator.format(estTokens)} > ` +
        `${TokenEstimator.format(maxContextTokens)} 的 85%，可能触发截断`,
      )
    }

    // ═══════════════════════════════════════════════════════
    // P0 简化：QwenPaw 风格 — 一个 timeout 参数贯穿所有
    //   - 无看门狗（不需要每 10s 轮询）
    //   - 无心跳检测（TCP 断连让 fetch 自己报错）
    //   - 无流式→非流式降级（模型不支持流式直接报错）
    //   - 无慢速模式全局切换
    // ═══════════════════════════════════════════════════════

    // 超时优先级：外部覆盖 > 环境变量 > provider档案 > 默认值 (300s)
    const effectiveTimeout = options?.timeoutOverride
      || parseInt(process.env.LUMINA_LLM_TIMEOUT || '0', 10)
      || httpTimeoutSeconds
      || 300

    // 用户中止信号（非超时）
    const abortSignal = this.abortController?.signal

    // ═══ 流式调用（P0 简化：无看门狗、无心跳、无降级） ═══
    let streamText = ''
    let streamToolCalls: LLMToolCall[] | undefined
    let streamUsage: any
    /** 🆕 v8.1: 增量流式预执行结果缓存（需在 try 内外均可访问） */
    const earlyResults = new Map<string, { content: string; error?: string }>()

    try {
      // 用 AbortSignal.timeout() 统一管理超时
      const timeoutMs = effectiveTimeout * 1000
      const timeoutSignal = AbortSignal.timeout(timeoutMs)
      // 如果用户中止 + 超时，取最近的
      const fetchSignal = abortSignal
        ? (abortSignal.aborted ? abortSignal : timeoutSignal)
        : timeoutSignal

      const streamRes = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({ ...requestBody, stream: true }),
        signal: fetchSignal,
      })

      if (!streamRes.ok) {
        const errBody = await streamRes.text().catch(() => '')
        if (streamRes.status === 404) {
          console.log(`[AgentRunner] 模型不支持流式 → 执行非流式请求`)
          const nonStreamRes = await fetch(`${this.config.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${this.config.apiKey}`,
            },
            body: JSON.stringify({ ...requestBody, stream: false }),
            signal: fetchSignal,
          })
          if (!nonStreamRes.ok) {return { error: `LLM 错误 (${nonStreamRes.status}): ${(await nonStreamRes.text().catch(() => '')).slice(0, 200)}` }}
          const data = await nonStreamRes.json()
          const choice = data.choices?.[0]
          if (!choice) {return { error: 'LLM 返回为空' }}
          const msg = choice.message
          // 🔧 顺序修正：content 优先、reasoning_content 兜底。
          //   注意这里必须判「非空字符串」而不是单纯真值 —— 工具调用轮 content
          //   常常是 '' 或 null，用真值判断会掉进 else if，把**思维链当成正式回答**
          //   直接显示给用户。只有在没有工具调用时才允许用 reasoning 兜底。
          const hasContent = typeof msg.content === 'string' && msg.content.length > 0
          if (hasContent) {streamText = msg.content}
          else if (!msg.tool_calls?.length && typeof msg.reasoning_content === 'string' && msg.reasoning_content.length > 0) {
            streamText = msg.reasoning_content
          }
          if (msg.tool_calls?.length) {
            if (streamText) {this.messages.push({ role: 'assistant', content: streamText })}
            return { toolCalls: msg.tool_calls, text: streamText || undefined, usage: data.usage }
          }
          streamUsage = data.usage
          streamToolCalls = undefined
        } else {
          // 400/422/500 能力不匹配：自动降级（去 tools / 图片 / stream_options，或降 max_tokens）后重试
          const degraded = await this._degradedCompletionOnce(
            requestBody, streamRes.status, errBody, fetchSignal,
          )
          if (degraded) {
            const { data, kind } = degraded
            const choice = data.choices?.[0]
            if (!choice) {return { error: 'LLM 返回为空' }}
            const msg = choice.message
            if (msg?.content) {streamText = msg.content}
            if (msg?.tool_calls?.length) {
              if (streamText) {this.messages.push({ role: 'assistant', content: streamText })}
              return { toolCalls: msg.tool_calls, text: streamText || undefined, usage: data.usage }
            }
            streamUsage = data.usage
            streamToolCalls = undefined
            if (kind === 'tools' || kind === 'vision' || kind === 'context') {
              this.emit({ type: 'thinking_stream', text: '', isFirst: false, isLast: true })
            }
          } else {
            return { error: `LLM 流式错误 (${streamRes.status}): ${errBody.slice(0, 200)}` }
          }
        }
      } else {
        // ── 流式读取 ──
        const reader = streamRes.body?.getReader()
        if (!reader) {throw new Error('无响应体')}

        const decoder = new TextDecoder()
        const toolCallAccum = new Map<number, { id?: string; name?: string; args: string }>()
        let buffer = ''

        // 增量流式 — 完整工具检测与执行
        /** 已提示过的工具 id —— 仅用于避免重复 emit UI 事件，不参与最终工具列表构建 */
        const announcedToolIds = new Set<string>()
        // 🔧 v15: 原先这里还有一个 READONLY_EARLY_TOOLS 白名单 + earlyResults 预执行缓存，
        //   用来在参数流还没收完时抢先跑只读工具。但参数中途 JSON.parse 成功 ≠ 参数完整，
        //   抢先跑会用半截参数得到错结果，再被缓存当成最终结果使用。已整体移除，
        //   正确性优先于几百毫秒的延迟。

        this.emit({ type: 'thinking_stream', text: '', isFirst: true, isLast: false })

        while (true) {
          const { done, value } = await reader.read()
          if (done) {break}

          buffer += decoder.decode(value, { stream: true })

          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            if (!line.startsWith('data: ')) {continue}
            const data = line.slice(6).trim()
            if (data === '[DONE]') {continue}

            try {
              const chunk = JSON.parse(data)
              const delta = chunk.choices?.[0]?.delta
              if (!delta) {continue}

              if (delta.reasoning_content) {
                const isFirst = !this._reasoningStarted
                this._reasoningStarted = true
                this._reasoningAccum += delta.reasoning_content
                this.emit({ type: 'thinking_stream', text: delta.reasoning_content, isFirst, isLast: false })
              }

              if (delta.content) {
                if (this._reasoningStarted) {
                  this.emit({ type: 'thinking_stream', text: '', isFirst: false, isLast: true })
                  this._reasoningStarted = false
                  this._reasoningAccum = ''
                }
                streamText += delta.content
                if (!this._firstCallDone) {
                  this._firstCallDone = true
                  console.log(`[AgentRunner] 📝 首 token 到达 (耗时 ${Math.round((Date.now() - (this as any)._callStartTime || 0) / 1000)}s)`)
                }
              }

              if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index ?? 0
                  if (!toolCallAccum.has(idx)) {toolCallAccum.set(idx, { args: '' })}
                  const acc = toolCallAccum.get(idx)!
                  if (tc.id) {acc.id = tc.id}
                  if (tc.function?.name) {acc.name = tc.function.name}
                  if (tc.function?.arguments) {acc.args += tc.function.arguments}
                }

                // 检测完整的工具调用 — 有 id + name + 可解析的参数
                for (const [idx, acc] of toolCallAccum) {
                  if (!acc.id || !acc.name) {continue}
                  // 检查是否已经标记为完成
                  if (announcedToolIds.has(acc.id)) {continue}
                  // 尝试解析参数 — 解析成功才算完整
                  try {
                    JSON.parse(acc.args)
                    const completeCall: LLMToolCall = {
                      id: acc.id!,
                      type: 'function' as const,
                      function: { name: acc.name!, arguments: acc.args },
                    }
                    // 🔧 这里**只做 UI 提示**，不推入 completedToolCalls、不预执行。
                    //   原因：JSON.parse 在参数流中途就可能成功（例如已收到 {"query":"x"}，
                    //   后面还会补 ,"limit":3}），此时判定"完整"会让后续参数字段被去重丢弃，
                    //   工具就会以**残缺参数**执行完 —— 模型拿到的还是错的结果。
                    //   正确性优先：真正的工具调用统一在流结束后用完整 toolCallAccum 构建。
                    if (!announcedToolIds.has(acc.id)) {
                      announcedToolIds.add(acc.id)
                      console.log(`[AgentRunner] 🔎 收到工具调用: ${acc.name}（参数仍在累积）`)
                      this.emit({ type: 'incremental_tool', toolCall: completeCall })
                    }
                  } catch {
                    // 参数还不完整，继续积累
                  }
                }
              }

              if (chunk.usage) {streamUsage = chunk.usage}
            } catch { /* skip malformed chunk */ }
          }
        }

        // 🔧 工具调用只在这里统一构建一次，用的是**流结束时的完整参数**。
        //   早前会把"中途判定完整"的快照一起并进来，后续补齐的字段就被覆盖/丢弃了。
        const tcs: LLMToolCall[] = []
        let malformedToolArgs = 0
        for (const [, tc] of toolCallAccum) {
          if (!tc.name) {continue}
          const args = tc.args || '{}'
          try {
            JSON.parse(args)
          } catch {
            // 参数到流结束仍不合法 → 如实计数。
            // ⚠️ 关键：**不要**在这里把 args 洗成 '{}'。
            //    洗白之后下游的 JSON.parse 必然成功 → 解析失败保护形同虚设 →
            //    工具会带着空参数真的执行，参数级安全检查也就被跳过了。
            //    保留原始坏参数，让下游的保护自然接住并阻断执行。
            malformedToolArgs++
            console.warn(`[AgentRunner] ⚠️ 工具 ${tc.name} 的参数不是合法 JSON，将阻断执行`)
          }
          tcs.push({
            id: tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            type: 'function',
            function: { name: tc.name, arguments: args },
          })
        }
        if (malformedToolArgs > 0) {
          this.emit({
            type: 'thinking',
            text: `⚠️ 有 ${malformedToolArgs} 个工具调用的参数格式异常，已阻断执行`,
          })
        }
        streamToolCalls = tcs.length > 0 ? tcs : undefined
        this.emit({ type: 'thinking_stream', text: '', isFirst: false, isLast: true })
        this._reasoningStarted = false
        this._reasoningAccum = ''
      }
    } catch (err: any) {
      if (err.name === 'AbortError' || String(err.message).includes('abort')) {
        if (this.abortController?.signal.aborted) {
          console.log(`[AgentRunner] ⏹ 用户中止请求`)
          return { error: '用户中止', aborted: true }
        }
        // 超时，但有部分内容就返回
        const partialText = (streamText || '').trim()
        if (partialText.length > 20) {
          console.warn(`[AgentRunner] 🐢 超时 (${effectiveTimeout}s) 但已有 ${partialText.length} 字 → 返回部分内容`)
          this.emit({ type: 'thinking_stream', text: '', isFirst: false, isLast: true })
          this._reasoningStarted = false
          this._reasoningAccum = ''
          return { text: partialText, usage: streamUsage }
        }
        return { error: `模型响应超时，请稍后重试或简化问题` }
      }
      console.error(`[AgentRunner] 流式异常:`, err.message)
      return { error: `LLM 请求失败: ${err.message?.slice(0, 150) || err}` }
    }

    // ── 返回结果 ──
    this._firstCallDone = true
    getModelCapabilityCache().recordSuccess(this.config.model)
    getDiagnosticsStore().addToken({
      timestamp: new Date().toISOString(),
      promptTokens: streamUsage?.prompt_tokens || 0,
      completionTokens: streamUsage?.completion_tokens || 0,
      totalTokens: streamUsage?.total_tokens || 0,
      model: this.config.model,
      durationMs: 0,
    })

    // 附加增量预执行结果
    const earlyResultsObj: Record<string, { content: string; error?: string }> = {}
    for (const [id, result] of earlyResults) {
      earlyResultsObj[id] = result
    }

    if (streamToolCalls?.length) {
      if (streamText) {this.messages.push({ role: 'assistant', content: streamText })}
      return { toolCalls: streamToolCalls, text: streamText || undefined, usage: streamUsage, earlyResults: earlyResultsObj }
    }
    // ══════════════════════════════════════════════════════
    // XML 工具调用（统一走 llm/xmlToolCall 单一事实源）
    // ══════════════════════════════════════════════════════
    // 白名单用已注册的完整工具名：防止 <b>、<br> 这类 HTML 标签被误当成工具。
    const xmlResult = parseXmlToolCallsShared(streamText, getToolNames())

    if (xmlResult.calls.length > 0) {
      if (tools.length === 0) {
        // 🔧 P0 修复（真实故障）
        //   旧实现：剥掉 XML → cleanText 为空 → `cleanText || streamText`
        //   仍然把整段 XML 当成回复返回 → 上游 cleanToolNoiseText 再删一遍
        //   → finalText 变空串 → 连续空回复 → 用户看到「暂时无法生成有效回复」。
        //
        //   触发条件：chat 纯对话模式，或情绪门控把工具收紧到 0。
        //   模型此时仍然输出了工具调用，是合理的（它不知道没工具可用）。
        //
        //   现在：保留正文 + 追加一句诚实的说明，让用户知道发生了什么。
        //   **绝不能返回空串** —— 内容凭空消失是最糟的失败方式。
        const leftover = xmlResult.text.trim()
        const hint = leftover
          ? `${leftover}\n\n（本轮没有可用的工具，所以这个操作暂时没法执行。你可以换个说法，或到设置里检查工具是否被关闭了。）`
          : '（我本来想调用一个工具，但这轮没有可用的工具，所以没能执行。你可以换个说法，或到设置里检查工具是否被关闭了。）'
        console.warn(
          `[AgentRunner] ⚠️ 模型输出了 XML 工具调用，但本轮可用工具数为 0（已保留内容不丢弃）。` +
          `parsed=${xmlResult.calls.length} diag=${xmlResult.diagnostic || 'n/a'}`,
        )
        return { text: hint, usage: streamUsage, earlyResults: earlyResultsObj }
      }
      return { toolCalls: xmlResult.calls, text: xmlResult.text || undefined, usage: streamUsage, earlyResults: earlyResultsObj }
    }

    // 🔧 P0 修复：解析不出工具调用时，**原文一字不改**地返回。
    //   只有在模型确实表达了调用意图时才记一条警告——
    //   普通的 Markdown / HTML 回答不应该被误判为「解析失败」。
    if (xmlResult.hadToolCallIntent) {
      console.warn(
        `[AgentRunner] ⚠️ 检测到工具调用意图但未能解析（保留原文，不丢弃内容）。` +
        `diag=${xmlResult.diagnostic}`,
      )
    }
    return { text: streamText, usage: streamUsage, earlyResults: earlyResultsObj }

  }

  /**
   * 本地 / 异构模型能力不匹配时的非流式降级重试（最多 2 轮）。
   * 依据错误文本依次移除问题字段（tools / stream_options / 图片 / 降 max_tokens），
   * 并把能力短板写入模型能力缓存；context / unknown / auth 无法在通信层修复时返回 null。
   */
  private async _degradedCompletionOnce(
    body: Record<string, any>,
    initialStatus: number,
    initialErr: string,
    signal: AbortSignal,
  ): Promise<{ data: any; kind: string } | null> {
    let status = initialStatus
    let lastErr = initialErr || ''
    const tried = new Set<string>()
    let cur: Record<string, any> = { ...body, stream: false }
    const local = isLocalEndpoint(this.config.baseUrl)

    const headersFor = (withAuth: boolean): Record<string, string> => {
      const h: Record<string, string> = { 'Content-Type': 'application/json' }
      if (withAuth && this.config.apiKey) {h.Authorization = `Bearer ${this.config.apiKey}`}
      return h
    }

    for (let round = 0; round < 2; round++) {
      const kind = classifyModelError(status, lastErr)
      if (!kind || kind === 'unknown' || kind === 'context' || kind === 'auth' || tried.has(kind)) {
        return null
      }
      tried.add(kind)

      try {
        if (kind === 'tools') {getModelCapabilityCache().markNoToolSupport(this.config.model)}
        else if (kind === 'vision') {getModelCapabilityCache().update(this.config.model, { supportsVision: false })}
      } catch { /* 缓存不可用忽略 */ }

      const note = describeLimitation(kind, this.config.model)
      if (note) {console.warn(`[AgentRunner] 🔧 ${status} ${kind} → 自动降级：${note}`)}
      cur = degradeForKind(cur, kind)

      let res = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: headersFor(true),
        body: JSON.stringify(cur),
        signal,
      })

      // 本地端点误填 key 导致 401 → 去鉴权再试一次
      if (res.status === 401 && local && this.config.apiKey) {
        try { await res.body?.cancel() } catch { /* ignore */ }
        res = await fetch(`${this.config.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: headersFor(false),
          body: JSON.stringify(cur),
          signal,
        })
      }

      if (res.ok) {
        const data = await res.json().catch(() => null)
        if (data?.choices?.[0]) {return { data, kind }}
        return null
      }
      lastErr = await res.text().catch(() => '')
      status = res.status
    }
    return null
  }

  // ═════════════════════════════════════════════════════════
  // 模式与工具
  // ═════════════════════════════════════════════════════════

  private getToolsForMode(): { tools: string[]; toolsetName: string } {
    let tools: string[]
    let toolsetName: string
    // 子 Agent 过滤 blockedInChild 工具
    const isChild = this.config.isChildAgent === true || this.config.skipApproval === true
    switch (this.config.mode) {
      case 'developer':
        tools = resolveToolset('developer', new Set(), isChild); toolsetName = 'Developer'; break
      case 'chat':
        tools = CHAT_MODE_TOOLS; toolsetName = 'Chat'; break
      case 'agent':
      default:
        tools = resolveToolset('agent', new Set(), isChild); toolsetName = 'Agent'; break
    }

    const disabled = this.config.disabledTools
    if (disabled && disabled.length > 0) {
      const disabledSet = new Set(disabled)
      tools = tools.filter(t => !disabledSet.has(t))
    }

    // 每轮重置：上一轮的收紧说明不能泄漏到下一轮
    this._emotionGateNotice = ''

    // 角色硬闸门（广告层）：在 disabledTools 之上，再按 rolePolicy 过滤一遍，
    // 确保向 LLM 广告的工具都在当前角色白名单内。
    // personaId 缺省按 lumina（全放行）处理，不影响 Lumina 主聊天。
    const personaId = this.config.personaId
    tools = tools.filter(t => isToolAllowedForRole(personaId, t).allowed)

    // 🆕 情绪驱动的工具收紧（创新功能 1）
    //   放在最后：只有前面所有硬性过滤都放行的工具，才有资格被情绪收紧。
    //   顺序很重要——情绪**永远不能**放宽 rolePolicy 的角色边界。
    //   读 features.emotionGating 开关：用户可关（键缺失 = 默认开）。
    let emotionGatingOn = true
    try {
      const { getConfig } = require('./agentConfig')
      emotionGatingOn = (getConfig() as any)?.features?.emotionGating !== false
    } catch { /* 读不到就用默认 */ }

    const gate = emotionGatingOn
      ? applyEmotionGate(tools, this._currentEmotion)
      : { tools, suppressed: [], reasons: [], gated: false, notice: '' }
    if (gate.gated) {
      tools = gate.tools
      toolsetName += '+情绪收紧'
      this._emotionGateNotice = renderGateNotice(gate)
      console.log(
        `[getToolsForMode] 😶 情绪收紧：暂缓 ${gate.suppressed.length} 个工具（${gate.reasons.join('；')}）`,
      )
    }

    return { tools, toolsetName }
  }

  /** 🆕 情绪门控产生的说明（供注入 prompt）；无收紧时为空串 */
  private _emotionGateNotice = ''

  private initSystemPrompt(): void {
    // 群聊场景已由前端（getAgentSystemPromptLite）提供精准 prompt，
    // 启用 skipSoul 防止 SOUL_*.md 中的角色设定污染思考过程。
    // 🔧 FIX: 只有 socialMode（群聊）才跳过 SOUL，普通角色自定义提示词
    //   应该追加在完整人格（AGENTS.md + SOUL.md）之上，而不是替换掉人格。
    //   之前 isCustomPrompt=true 会跳过 SOUL.md，导致"正经问题认真回答"等
    //   关键指令丢失，LLM 回答变得敷衍。
    const isCustomPrompt = !!this.config.systemPrompt
    const skipSoul = !!this.config.socialMode
    let prompt = buildSystemPrompt(
      { config: this.config },
      undefined,
      {
        emotion: this._currentEmotion || undefined,
        skipSoul,
      },
    )
    
    // 如果 config 提供了自定义 systemPrompt，追加到基础提示词后面
    // 这样 persona 和群聊的自定义提示词才能真正生效
    // Worker 的 systemPrompt 已内置在 buildYakPrompt/buildRechaPrompt 中，
    // 不追加「自定义指令」避免提示词重复
    if (this.config.systemPrompt) {
      prompt += '\n\n## 自定义指令\n' + this.config.systemPrompt
    }
    
    // 群聊模式覆盖 — 如果 socialMode 开启，追加「群聊直接对话」覆盖指令
    //   解决 SOUL_YAK.md/SOUL_RECHA.md 中"不能主动跟用户说话"与群聊场景的冲突。
    //   这些覆盖指令在群聊中覆盖掉原始 persona 的「后台工作者」约束。
    if (this.config.socialMode) {
      prompt += `

## 📢 群聊模式指令（覆盖上方冲突规则）
你现在处于**团队群聊模式**，所有团队成员都在同一个聊天室中。
- ✅ **你可以直接回复用户**，不需要经过 Lumina 中转
- ✅ **用户可以直接对你说话**，你直接回答
- ✅ **你可以主动接话**，不一定要等 Lumina 委托
- ✅ **你可以跟其他团队成员讨论**（如果话题相关）
- ⚠️ 如果用户问的是你专业领域外的问题，请友好说明"这个我不太擅长，让 XX 来帮你吧"
- ⚠️ 保持专业和友好，群聊中也注意回答质量

## 🛠 工具使用说明（标准模式 + XML 回退兼容）
你有两种方式调用工具：

### 方式一（首选，推荐）：直接通过 API 标准 tool_calls
系统已为你注册了可用的工具列表，当你需要搜索、读文件、执行命令时：
1. 思考：我需要用什么工具、传什么参数
2. 系统会自动处理工具调用，你不需要在文本中描述"我准备用什么工具"
3. 工具执行结果会以 system 消息的形式返回给你

### 方式二（回退，兼容）：XML 标签格式
如果你无法通过 API 标准 tool_calls 调用工具，也可以在文本中输出：
- \`<web_search(query="搜索词")>\`
- \`<web_fetch(url="网页地址")>\`

系统会自动检测并执行这些标签，结果返回给你。

注意：
- 如果你已经收到搜索结果，直接归纳回答即可，不要再说"我去查"
- 在同一轮中，不要既输出 XML 标签又输出文字回答（二者选其一）
- 如果你有用到工具，下一轮你会看到结果，届时再根据结果回复`
    }

    // 说出来模式 — 追加「先说出来再回答」风格指引
    if ((this.config as AgentRunConfig)?.verbalizeThinking) {
      prompt += `

## 🎙️ 说出来模式指令
你现在处于**说出来模式**。这意味着你在使用工具（搜索、读文件等）之前和之后，应该**把思考过程说出来**，而不仅仅是安静地给出答案。

规则：
1. **先思考再行动**：在每次工具调用前，可以说"我需要查一下……"或"让我先搜索……"
2. **拿到结果先说发现**：工具返回结果后，先归纳你查到了什么关键信息
3. **再回答问题**：在你做完思考和分析后，给出最终的完整回答
4. **自然表达**：像跟朋友讨论问题一样自然，不需要刻意标注"我要说出来了"`
    }

    // 替换已有的 system 消息或插入到最前面，不能覆盖整个 messages 数组
    if (this.messages[0]?.role === 'system') {
      this.messages[0] = { role: 'system', content: prompt }
    } else {
      this.messages.unshift({ role: 'system', content: prompt })
    }
  }

  private emit(event: AgentEvent): void {
    this.onEvent?.(event)
  }

  // ═════════════════════════════════════════════════════════
  // 后处理 (v2.7 升级: 结构化压缩 + Session 持久化)
  // ═════════════════════════════════════════════════════════

  private async postProcess(): Promise<void> {
    // 每轮对话后自动检测上下文是否过大，若需要则自动压缩
    this.compactContext()

    // 持久化所有新增消息到 SQLite
    this.persistConversationHistory()
    // 🆕 P3-2: 同步新增消息到目标 Agent 的独立 chats.json
    this.persistToChatsJson()
    // 🆕 P4-1: 同步原始消息到 dialog/YYYY-MM-DD.jsonl（用于精确回溯）
    this.persistToDialog()
    // 🔧 P0: 保存压缩上下文到 sessionManager
    if (this._compressedSummary) {
      try {
        const sm = getSessionManager()
        sm.saveCompactedContext(this.sessionId, this._compressedSummary)
      } catch (e) {
        console.warn('[AgentRunner] 保存压缩上下文失败:', e)
      }
    }


    try {
      // 使用新的结构化压缩
      if (this.summarizer?.needsCompaction?.()) {
        // 发送压缩请求（由 LLM 调用执行，这里只是标记）
        const urgency = this.summarizer.compactionUrgency()
        if (urgency > 0.8) {
          // 高紧迫度：立即在下一轮对话中触发压缩
          this.messages.push({
            role: 'system',
            content: '[系统] 上下文即将达到上限，下一轮对话将自动压缩。你可以使用 /compact 手动触发。',
          })
        }
      }

      // Session 持久化
      try {
        const sm = getSessionManager()
        // 更新 session token 统计
        sm.addTokens(this.sessionId, this.totalTokens)
        // 如果有压缩上下文，保存
        const compacted = this.summarizer?.getCompactedContext?.()
        if (compacted) {
          const formatted = this.summarizer?.formatCompactedForSystemPrompt?.()
          if (formatted) {
            sm.saveCompactedContext(this.sessionId, formatted)
          }
        }
      } catch { /* session manager 未初始化 */ }

      // 兼容旧的 summarizer（检测 getBufferLength 代替已删除的 shouldSummarize）
      if (this.summarizer && this.summarizer.getBufferLength() >= 10) {
        const lastAssistant = [...this.messages].reverse().find(m => m.role === 'assistant')
        if (lastAssistant) {
          const snippet = toText(lastAssistant.content).slice(0, 150)
          await this.summarizer.summarize(snippet)
          this.emit({ type: 'memory_summary', summary: snippet })
          globalEventBus.emit(BusEvents.MEMORY_SUMMARIZED, {
            summary: snippet,
          })

          // autoRefine 放入微任务，不阻塞主对话
          autoRefine(
            {
              baseUrl: this.config.baseUrl,
              apiKey: this.config.apiKey,
              model: this.config.model,
            },
            this.onEvent,
          ).catch(err => console.warn('[AgentRunner] autoRefine 静默失败:', err?.message))
        }
      }
    } catch { /* ignore */ }
  }
}
