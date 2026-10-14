// ============================================================
// orchestration/routingDecider.ts — 任务路由决策（规则预筛 + LLM 仲裁）v1.0
//
// 【要解决的问题】
// 旧路由 `shouldDelegateToYak()` / `shouldDelegateToRecha()` 是纯正则：
//   /写.*代码/ /审查.*逻辑/ /重构|优化.*代码/ ...
// 正则的本质是「字面命中」，于是两类任务必然出错：
//
//   ① 漏派（false negative）——「这玩意跑起来就崩，你帮我看看」没有任何
//      代码关键词，正则一个都不匹配 → 留在 Lumina 自己硬扛。
//   ② 错派（false positive）——「解释一下这段 JSON 配置里的 algorithm 字段」
//      命中「解释…代码」类词，但这是纯答疑，根本不需要 Yak 写代码。
//
// 用户诉求是「问什么就解决什么」，而纯正则在**歧义任务**上必然失手。
//
// 【设计：规则先行，LLM 只仲裁歧义】
// 不做成「每条消息都问一次 LLM」——那会给每轮对话加一次模型调用，
// 延迟和成本都不可接受，而且模型抖动会让行为不可预测。
//
// 采用三档策略：
//   ① 规则**高置信**（命中明确信号且无冲突）→ 直接决定，零延迟零成本
//   ② 规则**明确自答**（Lumina 自己就能做）→ 不委派
//   ③ 规则**歧义** → 才调用 LLM 仲裁一次
// ④ LLM 不可用/超时/返回垃圾 → 回退到安全的规则默认，**绝不因路由失败而卡住用户**
//
// 整体是个纯函数 + 依赖注入，与 verifyLoop 同一套写法（可单测、不绑 LLM）。
// ============================================================

import type { TeamMemberId } from '../agentTeamTypes'
import { analyzeClarity } from './clarifyScope'
// 🎯 任务类型识别：纯推理 / 知识 / 闲聊类问题，Lumina 自己就能答，
//   不必外派，也不必为此多调一次 LLM 仲裁（省一次调用 + 避免误派）。
import { profileTask } from './taskProfiler'

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

/** 路由目标 */
export type RouteTarget = TeamMemberId

// ═══════════════════════════════════════════════════════════
// 异步路由仲裁接线（v1.1）
// ═══════════════════════════════════════════════════════════
//
// 【背景】decideRoute() 写好了「规则高置信直接定 / 歧义调 LLM 仲裁」的三档策略，
//   但一直没有调用方 —— 实际生效的只有 classifyByRules() 往 prompt 里加一句提醒。
//   于是整个「LLM 路由仲裁」能力等于不存在，文档与代码对不上。
//
// 【为什么不能直接放进 buildSystemPrompt】
//   buildSystemPrompt 是**同步**函数（渲染进程与多处同步调用都依赖它），
//   而 LLM 仲裁必须 await。所以真正的接法是：
//     ① 本模块提供异步仲裁 + 短超时（默认 1.2s，远小于首字响应预算）
//     ② 调用方（agentRunner）在发起 LLM 请求前 fire-and-forget 预热
//     ③ 仲裁结果写进一个极小的缓存，buildSystemPrompt 同步读取
//   拿不到缓存时退回纯规则，**绝不阻塞首字响应**。
//
// 【收益】真正解决 README 里写的失败模式：
//   「这玩意跑起来就崩，你帮我看看」—— 无任何代码关键词，正则一个都不命中，
//   模型若自己硬揽就会给出外行答案；仲裁一次就能把它派给 Yak。

/** 仲裁结果缓存：userText 摘要 → 路由提示语（空串 = 不注入） */
const _routeHintCache = new Map<string, { hint: string; at: number }>()
const ROUTE_HINT_TTL = 30_000
const ROUTE_HINT_MAX = 50

/** 读取已缓存的路由提示（供同步的 buildSystemPrompt 调用） */
export function peekRouteHint(userText: string): string {
  const key = (userText || '').trim().slice(0, 200)
  if (!key) {return ''}
  const hit = _routeHintCache.get(key)
  if (!hit) {return ''}
  if (Date.now() - hit.at > ROUTE_HINT_TTL) {
    _routeHintCache.delete(key)
    return ''
  }
  return hit.hint
}

/** 测试辅助：清空缓存 */
export function __clearRouteHintCache(): void {  _routeHintCache.clear()
}

function setRouteHint(userText: string, hint: string): void {
  const key = (userText || '').trim().slice(0, 200)
  // 简单的容量控制：超出就清最早的（Map 保持插入序）
  if (_routeHintCache.size >= ROUTE_HINT_MAX) {
    const oldest = _routeHintCache.keys().next().value
    if (oldest) {_routeHintCache.delete(oldest)}
  }
  _routeHintCache.set(key, { hint, at: Date.now() })
}

export interface RouteHintDeps {
  /** LLM 仲裁：回 'lumina' / 'yak' / 'recha'（非法值当不确定），空/异常均视为不确定 */
  llmClassify?: (text: string) => Promise<TeamMemberId | null>
}

function formatRouteHint(target: TeamMemberId, reason: string, via: 'rules' | 'llm'): string {
  const who = target === 'yak' ? 'Yak 💻（代码工程师）' : '热茶 🍵（审查员）'
  const src = via === 'llm' ? '经语义分析判断' : '命中明确信号'
  return `这条请求${src}（${reason}）。如果需要动手，请调用 delegate_to 委派给 ${who}；如果你能直接高质量答完，也可以自己答。`
}

/**
 * 预热路由提示（fire-and-forget，**调用方不要 await**）。
 *
 * 规则能定的零成本直接写缓存；只有歧义才调一次 LLM，且带硬超时，
 * 失败/超时/返回垃圾一律静默退回「不注入」——绝不阻塞首字响应。
 */
export function warmRouteHint(
  userText: string,
  available?: TeamMemberId[],
  deps: RouteHintDeps = {},
  timeoutMs = 1_200,
): void {
  const text = (userText || '').trim()
  if (!text) {return}

  // 🆕 先判「这句话是不是没头没尾」。这一步**优先于路由**：
  // 模糊任务就算路由判得再准，派人过去也只是让 Yak 猜一个方向闷头做。
  // 所以先把澄清提示写进同一个缓存槽 —— buildSystemPrompt 只需要读 peekRouteHint，
  // 不用再改签名。
  const clarity = analyzeClarity(text)
  if (clarity.kind === 'vague') {
    setRouteHint(text, `${clarity.hint}\n\n可以这样问：\n${clarity.questions.map(q => `- ${q}`).join('\n')}`)
    return
  }

  // 纯规则已经能定的，直接写缓存，不做 LLM 调用
  try {
    const verdict = classifyByRules({ text, available })
    if (verdict.confidence === 'high') {
      setRouteHint(
        text,
        verdict.target && verdict.target !== 'lumina'
          ? formatRouteHint(verdict.target, verdict.reason, 'rules')
          : '',
      )
      return
    }
  } catch { /* 规则出错就继续走仲裁 */ }

  if (!deps.llmClassify) {return}

  // 歧义 → 仲裁一次（带硬超时，失败不阻塞）
  void (async () => {
    try {
      const decision = await decideRoute(
        { text, available },
        {
          llmClassify: async (t) => (await deps.llmClassify!(t)) || null,
          timeoutMs,
        },
      )
      setRouteHint(
        text,
        decision.via === 'llm' && decision.target && decision.target !== 'lumina'
          ? formatRouteHint(decision.target, decision.reason, 'llm')
          : '',
      )
    } catch { /* 仲裁失败静默：不注入 */ }
  })()
}

export interface RouteDecision {
  /** 最终决定交给谁 */
  target: RouteTarget
  /** 决策依据（会写进日志 / 提示，便于事后复盘为什么这么派） */
  reason: string
  /** 'rules-high' | 'rules-self' | 'llm' | 'fallback' */
  via: 'rules-high' | 'rules-self' | 'llm' | 'fallback'
  /** 规则阶段的置信度：high=直接定，low=需要仲裁 */
  ruleConfidence: 'high' | 'low'
  /** 命中的规则标签（调试用） */
  signals: string[]
}

export interface RouteInput {
  /** 用户原话 */
  text: string
  /** 已配置的团队成员（未配置的不能派给它，否则任务石沉大海） */
  available?: RouteTarget[]
  /** 任务类型（若上游已识别） */
  taskType?: string
  /** 涉及文件数（若上游已知） */
  fileCount?: number
}

export interface RouteDeps {
  /**
   * LLM 仲裁函数。返回目标 id 或 null（表示「我也不确定」）。
   * 不传或抛错 → 走 fallback。
   */
  llmClassify?: (text: string) => Promise<RouteTarget | null>
  /** 仲裁超时（默认 6000ms）——路由是前置判断，不能拖慢首字响应 */
  timeoutMs?: number
  /** fallback 时选谁 */
  fallbackTarget?: RouteTarget
}

// ═══════════════════════════════════════════════════════════
// 规则表
// ═══════════════════════════════════════════════════════════

/** 明确该给 Yak（写代码/调试/改文件/跑命令） */
const YAK_STRONG = [
  // 允许「实现**一个**登录接口」这种中间夹了修饰语的写法：
  // 动词与产物之间可以隔少量中文，而不是必须紧邻。
  { re: /(写|生成|产出|实现|开发|编写|建个?|加个?)\s*(一个|个|份|套|段)?\s*[\u4e00-\u9fa5]{0,6}?(代码|脚本|函数|类|组件|页面|程序|爬虫|接口|API|服务|模块|插件|命令行|工具|方法|字段|表)/i, tag: '写代码' },
  // 「修 bug」和「bug 帮我修」两种语序都要认，否则排障类请求会整片漏派
  { re: /(修|改|调|排|解决|处理)(一下|个|好|掉)?\s*(bug|BUG|Bug|错误|报错|异常|崩溃|闪退|卡死|问题)/i, tag: '调试' },
  { re: /(bug|BUG|错误|报错|异常|崩溃|闪退|卡死)\s*(啊|呀|了|了呀)?\s*(帮我)?\s*(修|改|调|排|看看|查|解决)/i, tag: '调试' },
  { re: /跑不起来|跑不通|起不来|启动不了|不生效|报错|死机/i, tag: '运行异常' },
  { re: /重构|重写|重做|优化\s*(代码|性能|结构|逻辑|实现)/i, tag: '重构优化' },
  { re: /(加|补|写|加个)\s*(单元测试|测试用例|test|jest|vitest)/i, tag: '写测试' },
  { re: /(跑|运行|执行|启动)\s*(一下)?\s*(测试|test|build|构建|编译|服务|项目)/i, tag: '执行构建' },
  { re: /git\s*(commit|push|pull|rebase|merge|分支|提交)/i, tag: 'git操作' },
  { re: /(配置|安装|部署)(好|一下)?\s*(依赖|包|环境|项目|服务|docker|nginx)/i, tag: '环境配置' },
  { re: /数据库.*(建表|建库|迁移|schema)|(建表|建库)\s*(语句|表)/i, tag: '数据库变更' },
]

/** 明确该给热茶（审查/挑错/风险评估/对比方案） */
const RECHA_STRONG = [
  { re: /(审查|review|评审|复核|code\s*review)/i, tag: '代码审查' },
  { re: /(挑|找|查|排)(出)?\s*(错|bug|漏洞|问题|隐患|毛病)/i, tag: '挑错' },
  { re: /(风险|隐患|安全性|漏洞|威胁|合规)/i, tag: '风险评估' },
  { re: /(利弊|优缺点|取舍|值不值得|该不该|要不要)/i, tag: '方案权衡' },
  { re: /(对比|比较).*(方案|架构|框架|技术栈|选型)/i, tag: '方案对比' },
  { re: /(从反面|反向|换个角度).*(思考|论证|考虑)/i, tag: '反面论证' },
  { re: /我的\s*(代码|设计|方案).*(怎么样|如何|好吗|行不行)/i, tag: '求评价' },
]

/** 明确 Lumina 自己就能做（不该外派，白白多一跳） */
const LUMINA_SELF = [
  { re: /^(你好|hi|hello|在吗|在不在|早|早上好|晚安|谢谢|哈哈+|呵呵+|嗯+|哦)[\s!！。.~？?]*$/i, tag: '寒暄' },
  { re: /(讲个|说个|来一个|来点)(笑话|故事|段子)/i, tag: '闲聊素材' },
  { re: /(你是谁|你叫什么|你是什么|介绍一下你)/i, tag: '自我介绍' },
  { re: /(翻译|译成|translate)/i, tag: '翻译' },
  { re: /(今天|现在).*(天气|日期|几点|星期)/i, tag: '查询实时信息' },
]

/** 正则引擎的 `g` 标志会带 lastIndex 状态，复用同一 RegExp 会导致结果飘。
 *  这里用无状态匹配：每次都新建正则。 */
function matchAll(text: string, rules: Array<{ re: RegExp; tag: string }>): string[] {
  const out: string[] = []
  for (const r of rules) {
    // 用 match 而非 test，避开 lastIndex 粘连
    if (text.match(r.re)) {out.push(r.tag)}
  }
  return out
}

// ═══════════════════════════════════════════════════════════
// 规则判定
// ═══════════════════════════════════════════════════════════

export interface RuleVerdict {
  /** 规则认为的目标；歧义时为 null */
  target: RouteTarget | null
  confidence: 'high' | 'low'
  signals: string[]
  reason: string
}

/**
 * 纯规则判定。**不发起任何 LLM 调用**，可独立单测。
 *
 * 置信度定义：
 *   high —— 命中某一方≥1 条强信号，且对方 0 条（无冲突）→ 可直接决定
 *   low  —— 双方都命中（冲突）、或一条都没命中（无信号）→ 需要 LLM 仲裁
 */
export function classifyByRules(input: RouteInput): RuleVerdict {
  const text = (input.text || '').trim()
  if (!text) {
    return { target: 'lumina', confidence: 'high', signals: ['空输入'], reason: '空输入，直接由 Lumina 应答' }
  }

  const available = new Set<RouteTarget>(input.available && input.available.length > 0
    ? input.available
    : ['lumina', 'yak', 'recha'])

  // ── ① Lumina 自答：优先级最高，派出去纯属浪费一跳 ──
  const selfHits = matchAll(text, LUMINA_SELF)
  if (selfHits.length > 0) {
    return {
      target: 'lumina',
      confidence: 'high',
      signals: selfHits,
      reason: `Lumina 自己就能处理（${selfHits.join('、')}），不外派`,
    }
  }

  // ── ①.5 任务类型先行：纯推理 / 闲聊 → Lumina 自己答 ──
  //   这些类型的答案是「推导出来的」或「随口聊的」，既不该派给 Yak/热茶，
  //   也不该触发 LLM 仲裁（仲裁只为「该谁干」服务，对这类问题纯属多余的一次调用）。
  //   例：「集合 C={...} 子集 N 个元素 不含五个连续整数 概率」——
  //   判为 reasoning → 直接 lumina/high，零额外 LLM 调用，也杜绝了误派。
  //   ⚠️ 只放 reasoning/chat：knowledge 里含「是什么」，会让「优缺点是什么」
  //      这类本该给热茶的审查请求被误抢，所以 knowledge 放到 yak/recha 之后判。
  const profile = profileTask(text)
  if (profile.kind === 'reasoning' || profile.kind === 'chat') {
    return {
      target: 'lumina',
      confidence: 'high',
      signals: [profile.kind, ...profile.signals.slice(0, 2)],
      reason: `任务类型为「${profile.kind}」（${profile.signals.slice(0, 3).join('、') || '自含问题'}），Lumina 直接作答`,
    }
  }

  const yakHits = matchAll(text, YAK_STRONG)
  const rechaHits = matchAll(text, RECHA_STRONG)

  const yakOk = yakHits.length > 0 && available.has('yak')
  const rechaOk = rechaHits.length > 0 && available.has('recha')

  // ── ② 单边高置信：只有一方命中，且命中数≥1 ──
  if (yakOk && !rechaOk) {
    return {
      target: 'yak',
      confidence: 'high',
      signals: yakHits,
      reason: `规则命中代码类任务（${yakHits.join('、')}）`,
    }
  }
  if (rechaOk && !yakOk) {
    return {
      target: 'recha',
      confidence: 'high',
      signals: rechaHits,
      reason: `规则命中审查类任务（${rechaHits.join('、')}）`,
    }
  }

  // ── ③ 双方都命中：真冲突，交给 LLM 仲裁 ──
  if (yakOk && rechaOk) {
    return {
      target: null,
      confidence: 'low',
      signals: [...yakHits.map(t => `yak:${t}`), ...rechaHits.map(t => `recha:${t}`)],
      reason: `代码类(${yakHits.join('、')}) 与审查类(${rechaHits.join('、')}) 信号同时命中，需要仲裁`,
    }
  }

  // ── ④ 一个都没命中：先看是不是「知识解释」类 ──
  //   放到这里（yak/recha 之后）是为了让明确的代码/审查请求优先；
  //   只有确实没人接的知识类问题，才由 Lumina 直接用自身知识作答。
  if (profile.kind === 'knowledge') {
    return {
      target: 'lumina',
      confidence: 'high',
      signals: [profile.kind, ...profile.signals.slice(0, 2)],
      reason: `知识解释类问题（${profile.signals.slice(0, 3).join('、')}），Lumina 直接用自身知识作答`,
    }
  }

  // ── ⑤ 一个都没命中：歧义，交给 LLM 仲裁 ──
  //   这正是旧正则的盲区：「这玩意跑起来就崩，你帮我看看」之类。
  return {
    target: null,
    confidence: 'low',
    signals: [],
    reason: '无明确规则命中，任务描述含糊',
  }
}

// ═══════════════════════════════════════════════════════════
// 仲裁提示词
// ═══════════════════════════════════════════════════════════

const ARBITER_PROMPT = `你是任务路由器。根据用户请求，把任务分给下面一个角色。只输出一个角色的名字，不要任何解释。

角色：
- yak：写代码、改文件、跑命令、调试、重构、装依赖、跑测试、git 操作
- recha：代码审查、挑错、风险评估、方案对比与权衡、反面论证
- lumina：日常对话、翻译、闲聊、查天气时间、情感陪伴

判断要点：
- 需要**动手改东西**→ yak
- 需要**评价/挑毛病/权衡**→ recha
- 两者都要（如「写完顺便审一下」）→ 先 yak
- 其余日常对话 → lumina

用户请求：`

// ═══════════════════════════════════════════════════════════
// 主入口
// ═══════════════════════════════════════════════════════════

const VALID_TARGETS: RouteTarget[] = ['lumina', 'yak', 'recha']

/** 从 LLM 自由文本里抽出一个合法 target，抽不出返回 null */
export function parseArbiterAnswer(raw: string): RouteTarget | null {
  if (!raw) {return null}
  const s = raw.toLowerCase().trim()
  // 优先匹配完整词，避免 recha 里的 'a' 之类误命中
  for (const t of ['recha', 'yak', 'lumina']) {
    if (new RegExp(`\\b${t}\\b`).test(s)) {return t as RouteTarget}
  }
  return null
}

/** 构造给 LLM 的仲裁提示词（导出便于测试与复用） */
export function buildArbiterPrompt(text: string): string {
  return ARBITER_PROMPT + text
}

/**
 * 决定任务交给谁。
 *
 * 降级链（**任何一环失败都不能让用户卡住**）：
 *   规则高置信 → 直接返回
 *   规则歧义 → LLM 仲裁（带超时）
 *   LLM 失败/超时/输出无法解析 → fallback（默认 yak，理由：宁可多派也不要用户自己扛）
 */
export async function decideRoute(input: RouteInput, deps: RouteDeps = {}): Promise<RouteDecision> {
  const verdict = classifyByRules(input)
  const available = new Set<RouteTarget>(input.available && input.available.length > 0
    ? input.available
    : VALID_TARGETS)

  // 规则已给出高置信答案
  if (verdict.target && verdict.confidence === 'high') {
    return {
      target: verdict.target,
      reason: verdict.reason,
      via: verdict.target === 'lumina' ? 'rules-self' : 'rules-high',
      ruleConfidence: 'high',
      signals: verdict.signals,
    }
  }

  // 歧义：尝试 LLM 仲裁
  if (deps.llmClassify) {
    const timeoutMs = deps.timeoutMs ?? 6000
    let answer: string | null = null
    let timedOut = false

    try {
      // 用 Promise.race 做超时保护 —— 不能因为路由把首字响应拖住
      answer = await Promise.race([
        deps.llmClassify(input.text),
        new Promise<null>(r => setTimeout(() => { timedOut = true; r(null) }, timeoutMs)),
      ])
    } catch (err) {
      console.warn('[RoutingDecider] LLM 仲裁失败，回退规则默认:', err)
      answer = null
    }

    const parsed = parseArbiterAnswer(answer || '')
    if (parsed && available.has(parsed)) {
      return {
        target: parsed,
        reason: timedOut ? '仲裁超时前的结果' : `LLM 仲裁结果：${parsed}`,
        via: 'llm',
        ruleConfidence: 'low',
        signals: verdict.signals,
      }
    }
  }

  // ── 兜底 ──
  // 注意：兜底目标**也必须从 available 里选**。早期版本直接写死 'yak'，
  // 结果在只配了 lumina+recha 的场景下，会把任务派给一个不存在的成员，
  // 任务直接石沉大海——这比「派错人」更严重的故障。
  let fallback: RouteTarget
  if (deps.fallbackTarget && available.has(deps.fallbackTarget)) {
    fallback = deps.fallbackTarget
  } else if (available.has('yak')) {
    fallback = 'yak'
  } else if (available.has('recha')) {
    fallback = 'recha'
  } else {
    fallback = 'lumina'
  }
  return {
    target: fallback,
    reason: `规则歧义（${verdict.reason}）且仲裁未果，按默认派给 ${fallback}`,
    via: 'fallback',
    ruleConfidence: 'low',
    signals: verdict.signals,
  }
}
