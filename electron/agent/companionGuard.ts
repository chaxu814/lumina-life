// ============================================================
// agent/companionGuard.ts — 铁则一的代码兜底（Companion Guard）
//
// 【要解决的问题：铁则一目前只活在提示词里】
//
// AGENTS.md 第一条写着「用户永远只跟 Lumina 说话，永远不知道 Yak 和热茶的存在」。
// 这条铁则此前**没有任何代码强制**，只靠 system prompt 约束模型自律。
// 而代码里恰好有三个把名字亲手喂给模型的入口：
//   · tools/impl/team.ts 的 delegate_chain 工具结果里写着「### Yak（程序员）输出」
//   · delegate_to 的结果直接透传 worker 的 content
//   · read_notices / load_context 会把 worker id 打印进上下文
// 模型在自己上下文里反复读到「Yak」「热茶」，再被提示词要求「绝不暴露」——
// 这是在赌模型自律。实测中只要上下文里名字足够显眼，名字就会被复述出去。
//
// 【本模块的定位：出口兜底，不是源头治理】
// 源头治理（工具结果匿名化）已同步落地；本模块守的是**最后一出口**：
// 无论上游怎么改、模型怎么跑，只要当前是陪伴模式且不是群聊，
// 送给渲染进程的文本里就不允许出现后台成员的名字。
//
// 【为什么用 visibility 分档来控制，而不是写死】
// `orchestration/visibility.ts` 定义了 companion / collab / audit 三档，
// 但此前它 100% 是摆设：filterByVisibility 只被测试调用，事件出口零过滤，
// 它要过滤的 6 种事件类型甚至不在事件联合类型里 —— 整个模块没有生产者也没有消费者。
// 本模块把它接到真正的出口上：companion 档强制遮蔽（铁则一），
// collab / audit 档放行（专业用户要能查账）。
// 于是「同一个产品吃两类人」这个原本的设计，第一次真的有了执行路径。
//
// 【误伤控制：宁可漏，不可毁】
// 「热茶」在中文里是常用词（喝杯热茶），「Yak」在英文里也可能指牦牛。
// 无差别替换会把正常对话改得莫名其妙 —— 那比漏一次名字糟糕得多。
// 因此分两级：
//   · 拉丁名（Yak / Recha）走词边界匹配，风险低，直接遮蔽；
//   · 中文名（热茶 / 小茶）必须**同句出现 Agent 语境词**才判定为成员名，
//     否则原样保留。宁可漏判，不可误伤。
// ============================================================

import { getVisibilityTier, VISIBILITY_TIERS, type VisibilityTier } from '../orchestration/visibility'
import type { AgentEvent } from '../tools/types'

/** 遮蔽后替换成的角色中性称谓 —— 保住信息（谁干的）又不暴露身份（是谁） */
export const ROLE_LABELS = {
  yak: '工程执行',
  recha: '代码审查',
} as const

/** 判定「这句在谈后台成员」所需的语境词。缺了它们就一律放行。 */
const AGENT_CONTEXT_HINTS = [
  '审查', '审了', '审一遍', '审过', '代码', '委托', '派给', '派了',
  '同事', '队友', '队友们', '他们说', '她说', '他说', '他改', '她改',
  '流水线', '工位', '后台',
]

/**
 * 拉丁成员名 → 词边界匹配 + 大小写不敏感。
 *
 * `i` 标志是必需的：模型照抄工具结果里的写法，大小写完全不定
 * （`Yak` / `yak` / `YAK` 都见过），只匹配首字母大写会直接漏掉一半。
 * `\b` 保证 `yakky` / `rebalance` 这类普通单词不会被误伤。
 */
const LATIN_NAMES: Array<{ re: RegExp; role: string }> = [
  { re: /\byak\b/gi, role: ROLE_LABELS.yak },
  { re: /\brecha\b/gi, role: ROLE_LABELS.recha },
]

/** 中文成员名：必须配合语境判定 */
const CN_NAMES: Array<{ name: string; role: string }> = [
  { name: '热茶', role: ROLE_LABELS.recha },
]

function sentenceOf(text: string, index: number): string {
  // 以中文/英文句读 + 换行为界切句。取当前命中所在的整句做语境判定，
  // 而不是只看命中点前后几个字符 —— 「热茶说我看没问题」里，
  // 语境词在命中点之后，只看前缀会漏判。
  const seps = /[。！？!?\n；;]/
  let start = 0
  for (let i = index - 1; i >= 0; i--) {
    if (seps.test(text[i])) { start = i + 1; break }
  }
  let end = text.length
  for (let i = index; i < text.length; i++) {
    if (seps.test(text[i])) { end = i; break }
  }
  return text.slice(start, end)
}

function hasAgentContext(sentence: string): boolean {
  return AGENT_CONTEXT_HINTS.some(h => sentence.includes(h))
}

export interface CompanionGuardOptions {
  /**
   * 当前可见性档位。省略时读取进程级当前档（默认 companion）。
   * 显式传入是为了可测：单测不该去改全局单例。
   */
  tier?: VisibilityTier
  /**
   * 是否群聊上下文。
   * 群聊是**用户主动进入的多 Agent 场景**，此时成员名字是产品功能而不是泄漏 ——
   * 铁则一约束的是「一对一聊天时不要暴露后台」，不是「不许群聊」。
   */
  isGroupChat?: boolean
  /** 注入以便单测确定化 */
  now?: () => Date
}

export interface CompanionGuardResult {
  /** 处理后的文本 */
  text: string
  /** 是否发生了改写（便于埋点与测试断言） */
  redacted: boolean
  /** 命中的成员名（去重），便于排查是谁漏出去了 */
  leaked: string[]
}

/**
 * 对**送给用户**的文本执行铁则一兜底。
 *
 * 【设计取舍：改写而不是拒绝】
 * 拒绝/吞掉整条回复会造成「模型说了什么」直接消失，用户看到的是一句没头没尾的话，
 * 那比泄露一个名字更让人困惑。这里只做**最小必要改写**：把身份换成角色称谓，
 * 语义完整保留（用户仍然知道「代码是别人写的、被审查过」），只是不知道那个人叫什么。
 */
export function applyCompanionGuard(
  raw: string,
  options: CompanionGuardOptions = {},
): CompanionGuardResult {
  const text = typeof raw === 'string' ? raw : ''
  if (!text) {return { text: '', redacted: false, leaked: [] }}

  const tier = options.tier ?? getVisibilityTier()
  const isGroupChat = options.isGroupChat === true

  // 档位归一化：**非法档位一律按 companion（最严）处理**。
  // 这一步是 fail-closed 的关键 —— 早期实现写的是 `if (tier !== 'companion') 放行`，
  // 于是任何拼错的档位（'godmode'、undefined 之外的脏值、IPC 传进来的任意字符串）
  // 都会变成「无限权」：铁则一被一个拼写错误关掉了。
  // setVisibilityTier 已经是这个口径（非法值回落 companion），这里保持一致。
  const effectiveTier: VisibilityTier = tier in VISIBILITY_TIERS ? tier : 'companion'

  // 两种豁免：① 非陪伴档位（专业用户主动要看协作细节）
  //            ② 群聊（产品本身就以多 Agent 同屏为卖点）
  if (effectiveTier !== 'companion' || isGroupChat) {
    return { text, redacted: false, leaked: [] }
  }

  let out = text
  const leaked = new Set<string>()

  // ① 拉丁名：无条件遮蔽
  for (const { re, role } of LATIN_NAMES) {
    if (re.test(out)) {
      leaked.add(role)
      out = out.replace(re, role)
    }
    // 正则带 g 标志时 lastIndex 会残留，复用前必须归零
    re.lastIndex = 0
  }

  // ② 中文名：同句有 Agent 语境才判定为成员名
  for (const { name, role } of CN_NAMES) {
    let guard = 0
    // 单次 pass 不用 while：遮蔽后名字已被替换成角色词，不会再命中，
    // 但保留上限以防将来加入可替换中文名时无限循环
    while (out.includes(name) && guard < 20) {
      const idx = out.indexOf(name)
      const sentence = sentenceOf(out, idx)
      if (!hasAgentContext(sentence)) { break }
      leaked.add(role)
      out = out.slice(0, idx) + role + out.slice(idx + name.length)
      guard++
    }
  }

  return { text: out, redacted: out !== text, leaked: Array.from(leaked) }
}

/**
 * 判断某条文本在当前档位下**是否会**被遮蔽。
 * 给 UI 用：让「陪伴模式正在隐藏协作细节」这件事对用户可见，而不是静默生效。
 */
export function wouldRedact(raw: string, options: CompanionGuardOptions = {}): boolean {
  return applyCompanionGuard(raw, options).redacted
}

/**
 * 流式文本的陪伴模式过滤器。
 *
 * 【为什么逐 chunk 调用 applyCompanionGuard 不够】
 * 模型是按 token 吐字的，「Yak」完全可能被切成 "Ya" + "k" 两个 chunk。
 * 逐块遮蔽时两块都不含完整名字，于是原样透出，屏幕上就出现了「Ya」然后「k」——
 * 拼起来正好是泄露，且**事后无法回收**（字已经渲染出去了）。
 *
 * ── 实现踩过的坑（写下来免得下次重犯）────────────────────
 * 第一版用「固定压住末尾 N 个字符」的做法，看起来能覆盖最长的名字（Recha = 5），
 * 结果测试直接打脸：
 *     push('结果交给你了，Re') → 可发 '结'
 *     push('cha 说')           → 可发 '果交给'
 *     push('可以。')           → 可发 '你了，Re'   ← 'Re' 被放出去了！
 *     flush()                  → 'cha 说可以。'
 * 拼起来正好是完整的 "Recha"。
 * 根因：**「可发片段」被独立遮蔽，而名字是跨边界存在的**。
 * 固定长度压住只能保证「名字整体在压住区里」，
 * 挡不住「名字前半截恰好落在可发区边界上」——边界本身就是概率问题。
 *
 * ── 现在的做法：压住「仍可能变成名字」的最长前缀 ────────────
 * 不按固定长度压，而是逐位置回看：如果 `held` 的某个**后缀**是任一成员名的
 * **真前缀**（还没写完的名字头），那就从那个位置开始压住不发。
 * 只有当「再往后也不可能拼出名字」时才放行。
 * 这样放行的部分**在数学上不可能**是任何成员名的一部分。
 *
 * ── 词边界消抖 ─────────────────────────────────────────
 * 朴素实现会把 "you're" 结尾的 "re" 也当成 Recha 的名字头而白白压住，
 * 导致英文文本频繁延迟。因此拉丁名额外要求：前缀前一字符必须是词边界
 * （非 \w 或位于开头）。中文「热」没有 \b 概念，不做此限制。
 * 即便如此，最坏情况也只是多压 ≤5 个字符，对逐字显示几乎无感。
 */
export class StreamingCompanionFilter {
  /** 拉丁成员名（大小写两种写法都要） */
  private static readonly ASCII_NAMES = ['Yak', 'yak', 'Recha', 'recha']
  /** 中文成员名：无词边界概念 */
  private static readonly CJK_NAMES = ['热茶']

  /** 所有「真前缀」（不含完整名字本身——完整名字该被遮蔽而不是被压住） */
  private static readonly ASCII_PREFIXES: ReadonlySet<string> = (() => {
    const s = new Set<string>()
    for (const n of StreamingCompanionFilter.ASCII_NAMES) {
      for (let i = 1; i < n.length; i++) { s.add(n.slice(0, i)) }
    }
    return s
  })()

  private static readonly CJK_PREFIXES: ReadonlySet<string> = (() => {
    const s = new Set<string>()
    for (const n of StreamingCompanionFilter.CJK_NAMES) {
      for (let i = 1; i < n.length; i++) { s.add(n.slice(0, i)) }
    }
    return s
  })()

  private static readonly MAX_NAME_LEN = Math.max(
    ...StreamingCompanionFilter.ASCII_NAMES.map(n => n.length),
    ...StreamingCompanionFilter.CJK_NAMES.map(n => n.length),
  )

  private held = ''
  private readonly options: CompanionGuardOptions

  constructor(options: CompanionGuardOptions = {}) {
    this.options = options
  }

  /** 喂入一个 chunk，返回**可以安全显示**的部分（可能为空串） */
  push(chunk: string): string {
    if (typeof chunk !== 'string' || !chunk) {return ''}
    this.held += chunk
    const cut = StreamingCompanionFilter.safeCut(this.held)
    if (cut <= 0) {return ''}
    const ready = this.held.slice(0, cut)
    this.held = this.held.slice(cut)
    return applyCompanionGuard(ready, this.options).text
  }

  /**
   * 算出「可以安全放行」的前缀长度。
   * 返回值之前的内容不可能是任何成员名的一部分；返回值及之后的一律压住。
   */
  private static safeCut(held: string): number {
    const len = held.length
    if (len === 0) {return 0}
    // 只有末尾 (maxNameLen - 1) 个位置内才可能藏着「未写完的名字头」
    const from = Math.max(0, len - StreamingCompanionFilter.MAX_NAME_LEN + 1)
    for (let i = from; i < len; i++) {
      const tail = held.slice(i)
      if (StreamingCompanionFilter.CJK_PREFIXES.has(tail)) {return i}
      if (StreamingCompanionFilter.ASCII_PREFIXES.has(tail)) {
        // 词边界：前缀前面必须是非 \w（拉丁名靠 \b 锚定）
        const prev = i > 0 ? held[i - 1] : ''
        if (!/\w/.test(prev)) {return i}
      }
    }
    return len
  }

  /** 流结束：把压住的尾巴做完遮蔽并交出。此后不可再 push。 */
  flush(): string {
    if (!this.held) {return ''}
    const tail = this.held
    this.held = ''
    return applyCompanionGuard(tail, this.options).text
  }

  /** 当前压住未显示的字符数（测试与诊断用） */
  get pending(): number {
    return this.held.length
  }
}

// ═══════════════════════════════════════════════════════════
// 事件级出口过滤
// ═══════════════════════════════════════════════════════════

/**
 * tool_start 参数里**允许被遮蔽**的散文类键名（小写比较）。
 *
 * 白名单而非黑名单是刻意的：黑名单必须穷举所有标识符字段
 * （to / from / agent / agentId / path / mode / taskType …），
 * 只要将来新增一个没列进去的标识符字段，黑名单就会漏掉它并悄悄改坏数据。
 * 白名单则天然安全：没列进去的键一律不动。
 */
const PROSE_ARG_KEYS: ReadonlySet<string> = new Set([
  'task', 'content', 'message', 'reason', 'summary', 'description',
  'query', 'prompt', 'note', 'notes', 'text', 'comment', 'body',
  'instruction', 'instructions', 'requirement', 'requirements',
])

/**
 * 把一条 Agent 事件改写成「可以安全送到渲染进程」的版本。
 *
 * 【为什么放在这个模块而不是 agentIpc 里】
 * agentIpc 依赖 electron，单测它必须整套 `vi.mock('electron')`。
 * 而这段逻辑是这个项目里最该被钉死的一层（铁则一是产品的核心承诺），
 * 放在这里就能被 `tests/companionGuard.test.ts` 直接 import 并逐类型验证，
 * 不需要任何 mock —— 这正是本项目反复强调的「把纯逻辑抽出来才能锁住」那件事。
 *
 * 【为什么逐类型处理而不是无脑 JSON 序列化再反序列化】
 * tool_end 的 result 是任意结构，序列化会让 getter 提前求值、
 * 丢掉 undefined 字段并改变键顺序 —— 这些都可能影响渲染进程行为。
 * 所以只对**已知携带文本的字段**做定点遮蔽，其余字段原样透传。
 */
export function guardEvent(
  ev: AgentEvent,
  textFilter: StreamingCompanionFilter,
  thinkFilter: StreamingCompanionFilter,
  options: CompanionGuardOptions = { tier: 'companion' },
): { event: AgentEvent; redactedLeak: string[] } {
  const leaked: string[] = []
  const plain = (s: unknown): string => {
    if (typeof s !== 'string' || !s) {return ''}
    const r = applyCompanionGuard(s, options)
    if (r.leaked.length) {leaked.push(...r.leaked)}
    return r.text
  }

  switch (ev.type) {
    case 'text': {
      if (typeof ev.content !== 'string') {break}
      const content = plain(ev.content)
      if (content === ev.content) {break}
      return { event: { ...ev, content }, redactedLeak: leaked }
    }
    case 'text_stream': {
      if (typeof ev.content !== 'string') {break}
      // 流式：走过滤器（带名字前缀压住），本块可能什么都不返回
      const content = textFilter.push(ev.content)
      if (!content) {break}
      return { event: { ...ev, content }, redactedLeak: leaked }
    }
    case 'thinking':
    case 'thinking_stream': {
      if (typeof ev.text !== 'string') {break}
      const text = ev.type === 'thinking'
        ? plain(ev.text)
        : thinkFilter.push(ev.text)
      if (!text || text === ev.text) {break}
      return { event: { ...ev, text } as AgentEvent, redactedLeak: leaked }
    }
    case 'error': {
      const error = plain(ev.error)
      if (error === ev.error) {break}
      return { event: { ...ev, error }, redactedLeak: leaked }
    }
    case 'memory_summary': {
      const summary = plain(ev.summary)
      if (summary === ev.summary) {break}
      return { event: { ...ev, summary }, redactedLeak: leaked }
    }
    case 'tool_start': {
      // ⚠️ 只遮蔽**散文类**参数，绝不碰标识符类参数。
      //   这里踩过一个真坑：最初对所有字符串参数无差别遮蔽，
      //   结果 `delegate_to` 的 `{ to: 'yak' }` 被改写成了 `{ to: '工程执行' }`。
      //   那是**路由标识符**，不是给人看的散文 —— 改掉它等于悄悄破坏了数据结构，
      //   任何按 id 分发/回显/再提交的上层逻辑都会拿到一个不存在的成员。
      //   与其猜哪些值是 id，不如反过来：只处理白名单里的自由文本键，
      //   未知键一律原样透传。漏遮蔽一个冷门字段的代价，
      //   远小于改坏一个主键。
      let changed = false
      const args: Record<string, unknown> = { ...ev.args }
      for (const [k, v] of Object.entries(args)) {
        if (typeof v !== 'string' || !v) {continue}
        if (!PROSE_ARG_KEYS.has(k.toLowerCase())) {continue}
        const g = plain(v)
        if (g !== v) {args[k] = g; changed = true}
      }
      if (changed) {return { event: { ...ev, args: args as Record<string, any> }, redactedLeak: leaked } }
      break
    }
    case 'tool_end': {
      // 委托类工具的 result 里就写着成员名，这是最需要遮蔽的一处
      const r = ev.result as unknown
      if (!r || typeof r !== 'object') {break}
      const rec = r as { content?: unknown }
      if (typeof rec.content !== 'string') {break}
      const content = plain(rec.content)
      if (content === rec.content) {break}
      return {
        event: { ...ev, result: { ...rec, content } as typeof ev.result },
        redactedLeak: leaked,
      }
    }
    default:
      break
  }
  return { event: ev, redactedLeak: leaked }
}
