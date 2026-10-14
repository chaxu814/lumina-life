// ============================================================
// decisionDebate.ts — 生活决策「三栏辩论」(决策三栏 v1.0)
//
// 背景：
//   用户面对「买不买 / A 还是 B / 换不换工作」这类生活决策时，单视角回答容易
//   偏科。本模块把一个问题同时交给两位后台成员，并发看：
//     · Yak（工程/务实执行者视角）：这件事可不可行、要花多少、分几步落地
//     · 热茶（只读审查员视角）：最坏会怎样、有什么反对意见、哪条路最难回头
//   最后由 Lumina 综合两方，给一个有立场、不和稀泥的建议。
//
// 铁则遵守（见 AGENTS.md）：
//   · Yak / 热茶的输出永远只是 tool result，用户不直接跟他们对话；
//     三栏最终由 Lumina 组装成结构化结果，UI 呈现时也署名 Lumina。
//   · 全程经现有委托通道（delegationManager.delegate，from 恒为 lumina），
//     rolePolicy 硬隔离、委托深度闸、上下文隔离、预算记账自然生效。
//
// 设计要点：
//   · 纯逻辑：所有外部依赖（委托执行器、Lumina 自己的综合）都从 deps 注入，
//     生产实现见 createDefaultDecisionDeps()，测试注入假执行器即可。
//   · 降级：单角色超时/失败 → 该栏标注「未响应」，其余两栏照常；
//     Lumina 综合不可缺席 —— 失败时用规则模板兜底，并诚实标注 source=template。
//   · 完整性兜底：某栏返回空/过短（视为截断）→ 补请求一次，仍不行就明确标注。
//   · 显式触发：只认 /decide 或句首明确决策指令（parseDecisionInvoke），
//     普通对话不触发，避免过度编排。
// ============================================================

// ── 类型 ────────────────────────────────────────────────────

/** 后台成员（永远不会是 lumina：Lumina 是综合方/呈现方） */
export type DecisionDebator = 'yak' | 'recha'

/** Yak / 热茶栏的状态 */
export type ColumnStatus = 'ok' | 'missing' | 'degraded'

export interface DecisionColumn {
  /** 栏目标题（给 UI 用） */
  title: string
  /** 栏目正文（已从 JSON 提炼为可读文本） */
  body: string
  status: ColumnStatus
  /** 原始输出（调试/审计用，可能为空串） */
  raw: string
}

/** Lumina 综合结果 */
export interface LuminaVerdict {
  /** 对两栏意见的概括 */
  summary: string
  /** 有立场的最终建议（不和稀泥） */
  recommendation: string
  /** ok = 真实 LLM 综合；template = 规则模板兜底 */
  status: 'ok' | 'template'
  /** 来源标注：'llm' | 'template'，遵循项目诚实标注模式 */
  source: 'llm' | 'template'
}

export interface DecisionDebateResult {
  question: string
  options: string[]
  columns: {
    yak: DecisionColumn
    recha: DecisionColumn
  }
  lumina: LuminaVerdict
  meta: {
    durationMs: number
    degradedReasons: string[]
  }
}

/** 一次委托的统一结果形态（与 DelegationResult 的关键字段对齐） */
export interface DelegateOutcome {
  success: boolean
  content: string
  error?: string
}

/**
 * 委托执行器（注入点）。
 * 生产实现 = delegationManager.delegate('lumina', { to, task, taskType, timeout })。
 * 测试注入假实现，断言确实走了 from='lumina' 的委托通道。
 */
export type DecisionDelegate = (
  to: DecisionDebator,
  task: string,
  meta: { taskType: string; timeout?: number },
) => Promise<DelegateOutcome>

/**
 * Lumina 自己的综合调用（注入点，可选）。
 * 生产集成时接统一 LLM 出口；不注入时直接走规则模板（诚实标注 template）。
 */
export type LuminaSynthesizer = (prompt: string) => Promise<DelegateOutcome>

export interface DecisionDebateDeps {
  delegate: DecisionDelegate
  luminaSynthesize?: LuminaSynthesizer
  timeoutMs?: number
}

// ── 提示词（生活决策视角，不是代码审查） ─────────────────────

export function buildYakPrompt(question: string, options: string[]): string {
  const opts = options.length > 0 ? options.map((o, i) => `${i + 1}. ${o}`).join('\n') : '（用户没列具体选项，请你自己先把候选拆出来）'
  return `你是团队里擅长把事情真正落地的执行者。现在帮一个【生活决策】做可行性拆解——不要写代码、不要谈技术架构，就事论事。

【用户的问题】
${question}

【候选选项】
${opts}

请从「可执行性」角度分析：
- 每个选项要落地，第一步先做什么、第二步做什么？
- 大概要花多少钱/多少时间/多少精力？
- 哪个选项最不容易烂尾、最容易真的执行下去？

只输出一个 JSON，不要客套：
{
  "approach": "一句话说你会怎么落地",
  "pros": ["好处1", "好处2"],
  "cons": ["代价/麻烦1", "代价/麻烦2"],
  "steps": ["第一步…", "第二步…"],
  "effort": "低成本|中成本|高成本"
}`
}

export function buildRechaPrompt(question: string, options: string[]): string {
  const opts = options.length > 0 ? options.map((o, i) => `${i + 1}. ${o}`).join('\n') : '（用户没列具体选项，请你自己先把候选拆出来）'
  return `你是团队里专门泼冷水的审查员。现在帮一个【生活决策】做风险扫描——不要写代码，专挑毛病。

【用户的问题】
${question}

【候选选项】
${opts}

请回答：
- 每个选项最坏会发生什么？（具体后果，不是泛泛而谈）
- 有哪些被忽略的反对意见？
- 哪个选项一旦选错最难回头？

只输出一个 JSON，不要客套：
{
  "risks": ["风险1（含触发条件和后果）", "风险2"],
  "worstCase": "最坏情况一句话",
  "objections": ["反对意见1", "反对意见2"],
  "hardToReverse": "最难回头的选项及原因"
}`
}

export function buildLuminaPrompt(
  question: string,
  options: string[],
  yakBody: string,
  rechaBody: string,
): string {
  return `你是 Lumina，正在替用户把两位同伴的意见汇总成一句有立场的建议。

【用户的问题】
${question}

【候选选项】
${options.length > 0 ? options.join(' / ') : '（用户未列）'}

【执行者的可行性拆解】
${yakBody || '（这一栏这次没说上话）'}

【审查员的风险扫描】
${rechaBody || '（这一栏这次没说上话）'}

要求：
- 必须给出明确立场（选哪个 / 不选哪个 / 再等等），不要和稀泥说"都有道理"；
- 语气温暖，像朋友在深夜给建议；
- 如果某一栏缺失，明说哪栏没说上话，不要假装它说过。

只输出一个 JSON：{"summary": "两三句概括两方分歧", "recommendation": "你的明确建议"}`
}

// ── 工具函数 ────────────────────────────────────────────────

/** 从 LLM 自由文本里抠 JSON 对象（容忍 ```json 围栏和前后废话） */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  if (!text) return null
  const cleaned = text.replace(/```json\s*/gi, '').replace(/```/g, '').trim()
  const s = cleaned.indexOf('{')
  const e = cleaned.lastIndexOf('}')
  if (s >= 0 && e > s) {
    try {
      return JSON.parse(cleaned.slice(s, e + 1)) as Record<string, unknown>
    } catch {
      return null
    }
  }
  return null
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.map((x: unknown) => (typeof x === 'string' ? x : JSON.stringify(x))).filter(Boolean)
  }
  if (typeof v === 'string' && v.trim()) {
    return v.split(/\n+/).map(s => s.replace(/^[-*\d.\s、]+/, '').trim()).filter(Boolean)
  }
  return []
}

/** 把 Yak 的 JSON 输出提炼成可读正文 */
export function formatYakBody(text: string): string {
  const j = extractJsonObject(text)
  if (!j) {
    return text.trim().slice(0, 800) || ''
  }
  const lines: string[] = []
  if (typeof j.approach === 'string' && j.approach.trim()) lines.push(`落地思路：${j.approach.trim()}`)
  const pros = asStringArray(j.pros)
  if (pros.length) lines.push(`好处：\n${pros.map(p => `+ ${p}`).join('\n')}`)
  const cons = asStringArray(j.cons)
  if (cons.length) lines.push(`代价：\n${cons.map(c => `- ${c}`).join('\n')}`)
  const steps = asStringArray(j.steps)
  if (steps.length) lines.push(`执行步骤：\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`)
  if (typeof j.effort === 'string' && j.effort.trim()) lines.push(`投入预估：${j.effort.trim()}`)
  return lines.join('\n\n').trim()
}

/** 把热茶的 JSON 输出提炼成可读正文 */
export function formatRechaBody(text: string): string {
  const j = extractJsonObject(text)
  if (!j) {
    return text.trim().slice(0, 800) || ''
  }
  const lines: string[] = []
  const risks = asStringArray(j.risks)
  if (risks.length) lines.push(`风险：\n${risks.map(r => `! ${r}`).join('\n')}`)
  if (typeof j.worstCase === 'string' && j.worstCase.trim()) lines.push(`最坏情况：${j.worstCase.trim()}`)
  const objs = asStringArray(j.objections)
  if (objs.length) lines.push(`反对意见：\n${objs.map(o => `? ${o}`).join('\n')}`)
  if (typeof j.hardToReverse === 'string' && j.hardToReverse.trim()) lines.push(`最难回头：${j.hardToReverse.trim()}`)
  return lines.join('\n\n').trim()
}

/** 正文过短/为空 = 视为截断，需要补一次 */
const MIN_BODY_LENGTH = 30

function looksTruncated(outcome: DelegateOutcome): boolean {
  return !outcome.success || outcome.content.trim().length < MIN_BODY_LENGTH
}

/** 补全请求：告诉对方上次输出有问题，只补正文 */
function buildRetryPrompt(original: string, reason: string): string {
  return `【上次输出有问题：${reason}】
你刚才的返回要么失败了、要么内容太短像被截断了。请重新回答上面的原始问题，这次把内容写完整，仍然只输出要求的那个 JSON。

原始任务：
${original}`
}

// ── 单角色执行（含完整性兜底：失败一次就补一次） ─────────────

interface ColumnOutcome {
  column: DecisionColumn
  degradedReason?: string
}

async function runColumn(
  to: DecisionDebator,
  prompt: string,
  deps: Required<Pick<DecisionDebateDeps, 'delegate'>> & Pick<DecisionDebateDeps, 'timeoutMs'>,
  format: (text: string) => string,
  title: string,
): Promise<ColumnOutcome> {
  const first = await deps.delegate(to, prompt, { taskType: to === 'yak' ? 'logic_check' : 'risk_assess', timeout: deps.timeoutMs })

  // 角色未响应（失败/超时）：其余栏照常，这栏明确标注
  if (!first.success) {
    return {
      column: {
        title,
        status: 'missing',
        body: `（${to === 'yak' ? '执行者' : '审查员'}这一栏这次没说上话）`,
        raw: '',
      },
      degradedReason: `${to}_no_response`,
    }
  }

  let content = first.content
  let retried = false

  // 完整性兜底：空/截断 → 补请求一次
  if (looksTruncated({ success: true, content })) {
    retried = true
    const retry = await deps.delegate(to, buildRetryPrompt(prompt, '输出为空或过短，疑似截断'), {
      taskType: to === 'yak' ? 'logic_check' : 'risk_assess',
      timeout: deps.timeoutMs,
    }).catch((): DelegateOutcome => ({ success: false, content: '', error: '补全请求异常' }))
    if (retry.success && retry.content.trim().length >= MIN_BODY_LENGTH) {
      content = retry.content
    }
  }

  const body = format(content)
  const stillBad = body.trim().length < MIN_BODY_LENGTH

  return {
    column: {
      title,
      status: stillBad ? 'degraded' : 'ok',
      body: stillBad ? `（这一栏返回的内容不完整：${content.trim().slice(0, 120) || '空'}）` : body,
      raw: content,
    },
    degradedReason: stillBad ? `${to}_truncated${retried ? '_after_retry' : ''}` : undefined,
  }
}

// ── Lumina 综合（不可缺席：失败 → 规则模板兜底，标注 template） ──

function buildTemplateVerdict(
  question: string,
  options: string[],
  yak: DecisionColumn,
  recha: DecisionColumn,
): LuminaVerdict {
  const yakPart = yak.status === 'ok' ? '执行者觉得这事能落地' : '执行者这栏没说话'
  const rechaPart = recha.status === 'ok'
    ? recha.raw.includes('不可逆') || recha.raw.includes('血本') || recha.raw.includes('安全') || recha.raw.includes('大病')
      ? '审查员提醒这步选错很难回头'
      : '审查员没发现致命风险'
    : '审查员这栏没说话'

  let recommendation: string
  if (yak.status !== 'ok' && recha.status !== 'ok') {
    recommendation = `这次两边都没说上话，我不敢替你拍板。先把这个问题放一放，等想清楚成本和最坏情况再决定——别在信息不全的时候做选择。`
  } else if (recha.status === 'ok' && /不可逆|血本|大病|安全|负债|倾家/.test(recha.raw)) {
    recommendation = `我的建议是先别急着选。审查员提到这事一旦选错很难回头，先用小钱/小成本试一轮，把最坏情况兜住再放大。`
  } else if (yak.status === 'ok' && options.length > 0) {
    recommendation = `我倾向于选「${options[0]}」：执行者的拆解说明它最容易落地，审查员也没拦着。当然，最终是你的生活——按你最在意的那个标准再掂量一下。`
  } else {
    recommendation = `两边信息都不够完整，我的保守建议是：设一个期限（比如三天），期限内补齐成本和最坏情况的信息，再决定。`
  }

  return {
    summary: `关于「${question}」：${yakPart}，${rechaPart}。`,
    recommendation,
    status: 'template',
    source: 'template',
  }
}

async function runLuminaVerdict(
  question: string,
  options: string[],
  yak: DecisionColumn,
  recha: DecisionColumn,
  synth?: LuminaSynthesizer,
): Promise<{ verdict: LuminaVerdict; degradedReason?: string }> {
  // 没有注入综合器 → 直接规则模板（诚实标注 template）
  if (!synth) {
    return {
      verdict: buildTemplateVerdict(question, options, yak, recha),
      degradedReason: 'lumina_synthesize_unavailable',
    }
  }

  const prompt = buildLuminaPrompt(question, options, yak.body, recha.body)
  let out: DelegateOutcome
  try {
    out = await synth(prompt)
  } catch (e: any) {
    out = { success: false, content: '', error: e?.message || String(e) }
  }

  if (out.success) {
    const j = extractJsonObject(out.content)
    // 拿不到结构化 JSON = 综合不可用（自由文本无法拆成 summary/recommendation），
    // 按"综合失败"走模板兜底，诚实标注，不把一坨散文冒充结构化结论。
    if (j) {
      const summary = (typeof j.summary === 'string' ? j.summary : '').trim()
      const recommendation = (typeof j.recommendation === 'string' ? j.recommendation : '').trim()
      if (summary || recommendation) {
        return {
          verdict: {
            summary: summary || '（综合摘要缺失）',
            recommendation: recommendation || '（建议缺失，请参考上方两栏自行判断）',
            status: 'ok',
            source: 'llm',
          },
        }
      }
    }
  }

  // 综合失败/返回不可用 → 模板兜底，标注 template
  return {
    verdict: buildTemplateVerdict(question, options, yak, recha),
    degradedReason: 'lumina_synthesize_failed',
  }
}

// ── 主入口 ────────────────────────────────────────────────

/**
 * 跑一次「生活决策三栏辩论」。
 *
 * @param question 用户的问题（如「买不买电动车」）
 * @param options  候选选项（可为空，由后台成员自行拆解）
 * @param deps     注入的执行器；不传则用生产默认（走 delegationManager）
 */
export async function runDecisionDebate(
  question: string,
  options: string[] = [],
  deps?: DecisionDebateDeps,
): Promise<DecisionDebateResult> {
  const started = Date.now()
  const effective = deps ?? createDefaultDecisionDeps()
  const timeoutMs = effective.timeoutMs ?? 60_000
  const degradedReasons: string[] = []

  // 三栏里 Yak / 热茶并发（Promise.all，参考对抗评审的并发模式）；
  // Lumina 综合必须等两栏齐了才能做，所以放在后面。
  const [yakRes, rechaRes] = await Promise.all([
    runColumn('yak', buildYakPrompt(question, options), { delegate: effective.delegate, timeoutMs }, formatYakBody, '可行性与利弊'),
    runColumn('recha', buildRechaPrompt(question, options), { delegate: effective.delegate, timeoutMs }, formatRechaBody, '风险与反对'),
  ])

  if (yakRes.degradedReason) degradedReasons.push(yakRes.degradedReason)
  if (rechaRes.degradedReason) degradedReasons.push(rechaRes.degradedReason)

  const lumina = await runLuminaVerdict(question, options, yakRes.column, rechaRes.column, effective.luminaSynthesize)
  if (lumina.degradedReason) degradedReasons.push(lumina.degradedReason)

  return {
    question,
    options,
    columns: { yak: yakRes.column, recha: rechaRes.column },
    lumina: lumina.verdict,
    meta: {
      durationMs: Date.now() - started,
      degradedReasons,
    },
  }
}

// ── 生产默认依赖：走现有委托通道 ─────────────────────────────

/** 委托通道形状（最小接口，与 DelegationManager.delegate 对齐） */
export interface DelegationGateway {
  delegate(from: string, req: {
    to: string
    task: string
    taskType: string
    timeout?: number
    context?: string
  }): Promise<{ success: boolean; content: string; error?: string }>
}

/**
 * 委托网关解析器（可注入测试）。
 * 默认懒加载 require('../delegationManager')；测试用 setDelegationGatewayResolver
 * 换成假网关，避免在 node 环境拉起整个编排依赖图，也避免 require 路径被打
 * 包/测试环境改写。
 */
let _gatewayResolver: (() => DelegationGateway) | null = null

export function setDelegationGatewayResolver(fn: (() => DelegationGateway) | null): void {
  _gatewayResolver = fn
}

function resolveDelegationGateway(): DelegationGateway {
  if (_gatewayResolver) return _gatewayResolver()
  const { getDelegationManager } = require('../delegationManager') as {
    getDelegationManager: () => DelegationGateway
  }
  return getDelegationManager()
}

/**
 * 生产默认执行器。
 * 关键：所有后台调用都走 delegationManager.delegate('lumina', ...)，
 * from 恒为 'lumina'（铁则：用户只跟 Lumina 说话），
 * rolePolicy 硬隔离、委托深度闸、上下文隔离、预算记账在委托层自然生效。
 *
 * luminaSynthesize 故意不在这里接死：集成阶段由 main 把统一 LLM 出口
 * 以 LuminaSynthesizer 形状注入；未注入时诚实地走 template。
 */
export function createDefaultDecisionDeps(): DecisionDebateDeps {
  return {
    delegate: async (to, task, meta) => {
      const dm = resolveDelegationGateway()
      const r = await dm.delegate('lumina', {
        to,
        task,
        taskType: meta.taskType as 'logic_check' | 'risk_assess',
        timeout: meta.timeout,
        context: '生活决策辩论：由 Lumina 发起，Yak/热茶只做分析，不直接对用户说话。',
      })
      return { success: r.success, content: r.content || '', error: r.error }
    },
    // luminaSynthesize 留空 → runLuminaVerdict 走 template 兜底（诚实标注）
  }
}

// ── 触发解析：只认显式指令，普通对话不触发 ───────────────────

export interface DecisionInvoke {
  triggered: boolean
  /** 触发时抽出的问题文本（可能为空串，调用方需追问用户） */
  question: string
}

/**
 * 判断一条用户消息是否显式要求「决策三栏」。
 * 触发条件（严格，避免过度编排）：
 *   1. /decide [问题]            —— 斜杠命令
 *   2. 句首决策动词（帮我决定/选/选择/权衡/挑）+ 句中含「还是」等二选一信号
 * 普通聊天（如「今天天气怎么样」「帮我写个脚本」）一律不触发。
 */
export function parseDecisionInvoke(text: string): DecisionInvoke {
  const trimmed = (text || '').trim()
  if (!trimmed) return { triggered: false, question: '' }

  // 1) 斜杠命令
  const slash = trimmed.match(/^\/decide\b\s*(.*)$/i)
  if (slash) {
    return { triggered: true, question: slash[1].trim() }
  }

  // 2) 自然语言：句首决策动词 + 二选一信号
  //    （动词后允许直接跟宾语，如"帮我决定买电动车还是油车"，不强制空格）
  const startsWithDecisionVerb = /^(?:帮我)?(?:决定|选择|权衡|挑选|选)(?:一下)?[\s:：]*/.test(trimmed)
  const hasChoiceMarker = /还是|或者|\/|vs\.?|VS|对不对|要不要|该不该/.test(trimmed)
  if (startsWithDecisionVerb && hasChoiceMarker) {
    return { triggered: true, question: trimmed }
  }

  return { triggered: false, question: '' }
}
