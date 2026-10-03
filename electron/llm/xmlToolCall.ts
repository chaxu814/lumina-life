// ============================================================
// llm/xmlToolCall.ts — XML 风格工具调用解析器（唯一事实源）
//
// 【为什么把它抽成独立模块】
// 这个解析逻辑在项目里**同时存在两份**，而且两边不一样：
//
//   · reactEngine.ts  → tryExecuteXmlToolCall()：认 7 种格式，
//     有角色闸门、有工具结果注入、写得相当完整
//   · agentRunner.ts  → parseXmlToolCalls()：只认 3 种格式，
//     少认 <invoke> / <function_calls> / 嵌套 JSON 等
//
// 两份不一致的直接后果（真实故障）：
//   某轮模型输出了 agentRunner 认不出的 XML 格式
//   → 解析返回 null
//   → cleanToolNoiseText 把整段 XML 删干净
//   → finalText 变成空串
//   → 触发「连续 3 次空回复」恢复流程
//   → 恢复也失败
//   → 用户看到「抱歉，我暂时无法生成有效回复…」
//
// 这就是用户报的 bug。**根因不是 LLM 不听话，是我们的解析器不认它。**
//
// 【本模块的定位】
// 单一事实源。两边都从这里取，保证「模型输出的任何变体都能被认出来」。
// 宁可多认几种（认错了会走安全闸门被拦），也不能少认（少认 = 静默变空）。
//
// 【解析不出来时的行为：绝不静默丢内容】
// 这是本模块最重要的一条设计。
// 旧实现在解析失败时把 XML 从文本里删干净、返回空串，导致内容凭空消失。
// 现在：**解析失败一律返回 raw，原文一字不改**。
// 宁可让用户看到一段奇怪的 XML，也不要让回复凭空消失——
// 前者用户能截图反馈，后者用户只会觉得「这软件时好时坏」。
// ============================================================

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

export interface XmlToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface XmlParseResult {
  /** 解析出的工具调用；一条都没有时为空数组 */
  calls: XmlToolCall[]
  /**
   * 移除 XML 标签后的剩余正文。
   * ⚠️ 当 calls 为空时，这里**必须等于原文**（不做任何清理），
   *    否则会触发静默空回复。见文件头说明。
   */
  text: string
  /** 是否检测到了「模型想调工具」的意图（哪怕一个都没解析出来） */
  hadToolCallIntent: boolean
  /** 诊断信息：解析失败时说明卡在哪种格式上，便于日志排障 */
  diagnostic: string
}

// ═══════════════════════════════════════════════════════════
// 工具
// ═══════════════════════════════════════════════════════════

let _seq = 0
function nextId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${++_seq}`
}

/** 参数解析：key="v" / key='v' / key=v / key: v */
function parseParams(block: string): Record<string, any> {
  const args: Record<string, any> = {}
  if (!block) {return args}
  const re = /(\w+)\s*[=:]\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g
  let m: RegExpExecArray | null
  while ((m = re.exec(block)) !== null) {
    args[m[1]] = m[2] ?? m[3] ?? m[4] ?? ''
  }
  return args
}

function mkCall(name: string, args: Record<string, any>, prefix: string): XmlToolCall {
  // search_depth 是 LLM 自造的伪参数（搜索深度），真实工具没有这个字段，
  // 传下去会被工具层当成未知参数。历史实现一律剔除，保持一致。
  delete args.search_depth
  return {
    id: nextId(prefix),
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  }
}

/** 从 JSON 字符串解析参数；失败则回退到 key=value 解析 */
function parseArgsLoose(raw: string): Record<string, any> {
  const s = (raw || '').trim()
  if (!s) {return {}}
  try {
    const o = JSON.parse(s)
    if (o && typeof o === 'object' && !Array.isArray(o)) {return o as any}
  } catch { /* 不是 JSON，走兜底 */ }
  return parseParams(s)
}

// ═══════════════════════════════════════════════════════════
// 意图检测
// ═══════════════════════════════════════════════════════════

const INTENT_PATTERNS: RegExp[] = [
  /<tool_call>/i,
  /<tool_call>/i,
  /<function_calls>/i,
  /<invoke>/i,
  /<tool_name>/i,
  /<tool_code>/i,
  // 括号风格（无外层包裹）
  /<\w+\s*\([^)]*\)\s*>/i,
]

/** 模型是否表达了「我要调工具」的意图 */
export function hasToolCallIntent(text: string): boolean {
  if (!text) {return false}
  return INTENT_PATTERNS.some(re => re.test(text))
}

/** 把纯标签包裹的正文剥出来；剥不干净就返回空串（交给上层保留原文） */
function stripTags(text: string): string {
  return text
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .replace(/<function_calls>[\s\S]*?<\/function_calls>/gi, '')
    .replace(/<invoke>[\s\S]*?<\/invoke>/gi, '')
    .replace(/```tool_code[\s\S]*?```/gi, '')
    .replace(/<\w+\s*\([^)]*\)\s*>/gi, '')
    .trim()
}

// ═══════════════════════════════════════════════════════════
// 主解析
// ═══════════════════════════════════════════════════════════

/**
 * 解析 XML 风格工具调用。
 *
 * 覆盖格式（按尝试顺序）：
 *   A. <tool_call><function=name><parameter=k>v</parameter></function></tool_call>
 *   B. <tool_call><tool_name>name</tool_name><tool_args>{JSON}</tool_args></tool_call>
 *   C. <tool_call><name>k="v"</name></tool_call>                （键值对正文）
 *   D. <tool_call><tool_calls>[{"name":..,"arguments":{..}}]</tool_calls></tool_call>
 *   E. <tool_call><invoke name="x">...</invoke></tool_call>
 *   F. <web_search(query="x")>                                     （括号风格，无外层）
 *   G. <function_calls>[{...}]</function_calls>                    （Groq/Mistral）
 *
 * @param text 模型原始输出
 * @param knownTools 已知工具名；传入时会用它做白名单校验，
 *                   避免把 <b>、<br> 这类 HTML 标签误认成工具调用。
 *                   不传则不做白名单（宽容模式）。
 */
export function parseXmlToolCalls(text: string, knownTools?: Set<string>): XmlParseResult {
  const empty: XmlParseResult = {
    calls: [], text: text || '', hadToolCallIntent: false, diagnostic: '',
  }
  if (!text || typeof text !== 'string') {return empty}

  const intent = hasToolCallIntent(text)
  const calls: XmlToolCall[] = []
  let diagnostic = ''

  // 白名单判定：未注册的工具名一律不认（防止 HTML 标签误判）
  const accept = (name: string): boolean => {
    if (!name) {return false}
    if (!knownTools || knownTools.size === 0) {return true}
    return knownTools.has(name)
  }

  // ── A: <function=name> + <parameter=k> ──
  const reA = /<tool_call>\s*<function=(\w+)>([\s\S]*?)<\/function>\s*<\/tool_call>/gi
  let m: RegExpExecArray | null
  while ((m = reA.exec(text)) !== null) {
    if (!accept(m[1])) {diagnostic ||= `A:工具名未注册(${m[1]})`; continue}
    const args: Record<string, any> = {}
    const reP = /<parameter=(\w+)>([\s\S]*?)<\/parameter>/gi
    let pm: RegExpExecArray | null
    while ((pm = reP.exec(m[2])) !== null) {args[pm[1]] = pm[2].trim()}
    if (Object.keys(args).length > 0) {calls.push(mkCall(m[1], args, 'call_xml'))}
    else {diagnostic ||= `A:参数为空(${m[1]})`}
  }

  // ── B: <tool_name> + <tool_args>JSON ──
  const reB = /<tool_call>\s*<tool_name>(\w+)<\/tool_name>\s*<tool_args>([\s\S]*?)<\/tool_args>\s*<\/tool_call>/gi
  while ((m = reB.exec(text)) !== null) {
    if (!accept(m[1])) {diagnostic ||= `B:工具名未注册(${m[1]})`; continue}
    const args = parseArgsLoose(m[2])
    if (Object.keys(args).length > 0) {calls.push(mkCall(m[1], args, 'call_json'))}
    else {diagnostic ||= `B:参数无法解析(${m[1]})`}
  }

  // ── C: <tool_call><tool_name>k="v" ...</tool_call> ──
  const reC = /<tool_call>\s*<(\w+)>\s*([\s\S]*?)\s*<\/\1>\s*<\/tool_call>/gi
  while ((m = reC.exec(text)) !== null) {
    if (!accept(m[1])) {diagnostic ||= `C:工具名未注册(${m[1]})`; continue}
    const args = parseParams(m[2])
    if (Object.keys(args).length > 0) {calls.push(mkCall(m[1], args, 'call_kv'))}
    else {diagnostic ||= `C:参数为空(${m[1]})`}
  }

  // ── D: 嵌套 JSON 数组 ──
  const reD = /<tool_call>\s*<tool_calls>\s*([\s\S]*?)\s*<\/tool_calls>\s*<\/tool_call>/gi
  while ((m = reD.exec(text)) !== null) {
    const raw = m[1].trim()
    let parsed: any = null
    try {
      parsed = JSON.parse(raw)
    } catch {
      // 允许被 ```json 包裹，或前后有杂文
      const obj = raw.match(/\{[\s\S]*\}/)
      if (obj) { try { parsed = JSON.parse(obj[0]) } catch { /* ignore */ } }
    }
    const arr = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : [])
    for (const c of arr) {
      const name = c?.name || c?.function?.name
      if (!name || !accept(name)) {diagnostic ||= 'D:工具名缺失或未注册'; continue}
      const args = c?.arguments || c?.function?.arguments || c?.parameters || c?.args || {}
      const norm = typeof args === 'string' ? parseArgsLoose(args) : (args as any)
      calls.push(mkCall(name, norm || {}, 'call_nested'))
    }
  }

  // ── E: <invoke name="x"> ──
  const reE = /<tool_call>\s*<invoke\s+name=["']?(\w+)["']?\s*>([\s\S]*?)<\/invoke>\s*<\/tool_call>/gi
  while ((m = reE.exec(text)) !== null) {
    if (!accept(m[1])) {diagnostic ||= `E:工具名未注册(${m[1]})`; continue}
    const inner = m[2].trim()
    let args: Record<string, any> = {}
    try {
      const o = JSON.parse(inner)
      if (o && typeof o === 'object') {args = o as any}
    } catch { args = parseParams(inner) }
    if (Object.keys(args).length > 0) {calls.push(mkCall(m[1], args, 'call_invoke'))}
    else {diagnostic ||= `E:参数无法解析(${m[1]})`}
  }

  // ── F: 括号风格 <web_search(query="x")>（无外层包裹） ──
  const reF = /<(\w+)\s*\(([^)]*)\)\s*>/g
  while ((m = reF.exec(text)) !== null) {
    if (!accept(m[1])) {diagnostic ||= `F:工具名未注册(${m[1]})`; continue}
    const args = parseParams(m[2])
    if (Object.keys(args).length > 0) {calls.push(mkCall(m[1], args, 'call_bracket'))}
  }

  // ── G: <function_calls>[{...}]</function_calls> ──
  const reG = /<function_calls>\s*([\s\S]*?)\s*<\/function_calls>/gi
  while ((m = reG.exec(text)) !== null) {
    let parsed: any = null
    try { parsed = JSON.parse(m[1].trim()) } catch { /* ignore */ }
    const arr = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : [])
    for (const c of arr) {
      const name = c?.name || c?.function?.name
      if (!name || !accept(name)) {diagnostic ||= 'G:工具名缺失或未注册'; continue}
      const args = c?.arguments || c?.function?.arguments || c?.parameters || {}
      const norm = typeof args === 'string' ? parseArgsLoose(args) : (args as any)
      calls.push(mkCall(name, norm || {}, 'call_fncalls'))
    }
  }

  // ══════════════════════════════════════════════════════
  // 关键分支：一条都没解析出来时，**原文一字不改地返回**
  // ══════════════════════════════════════════════════════
  if (calls.length === 0) {
    return {
      calls: [],
      // 不做 stripTags！旧实现在这里把 XML 删干净导致回复凭空消失，
      // 进而触发「连续空回复」。宁可让用户看到 XML，也不要内容消失。
      text: text,
      hadToolCallIntent: intent,
      diagnostic: intent
        ? (diagnostic || '检测到工具调用意图但未能解析出任何调用（可能是未知格式或工具名未注册）')
        : '',
    }
  }

  return {
    calls,
    text: stripTags(text),
    hadToolCallIntent: intent,
    diagnostic: diagnostic || '',
  }
}
