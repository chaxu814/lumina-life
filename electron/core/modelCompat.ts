// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// modelCompat.ts — 本地 / 异构 LLM 端点请求容错与能力自适应
//
// 背景：
//   Lumina 全链路只讲 OpenAI 兼容协议。绝大多数本地推理服务
//   （LM Studio / Ollama /v1 / llama.cpp / vLLM / KoboldCpp …）都能跑，
//   但「能连」不等于「能用上全部能力」：
//     - 不是每个 GGUF 的 chat template 都带 function calling（tools）
//     - 不是每个模型都支持图片输入（vision）
//     - 旧服务不认识 stream_options / include_usage
//     - 各服务对 max_tokens / 上下文长度的校验严格程度不同
//   这些不匹配通常以 HTTP 400/422 + 一段错误文本返回。
//
// 本模块是纯函数、零外部依赖（不 import fs/electron），便于单元测试：
//   - classifyModelError：把错误文本归类为 tools / vision / stream_options /
//     max_tokens / context / auth / unknown
//   - degradeForKind：按类别从请求体里移除问题字段，构造可重试的降级请求
//   - clampOutputTokens：把「输出上限」和「上下文窗口」分开，避免把 256k
//     上下文当成 max_tokens 发出去触发严格服务 400
//   - looksLikeVisionModel：按模型名启发式判断是否为视觉模型
//
// 调用方（agentRunner / llmProvider / cuCore）在收到 400/422 时据此自动
// 降级重试一次，并把「该模型不支持某能力」写入 modelCapabilityCache，
// 之后不再重复踩同一个坑。
// ============================================================

/** 默认输出 token 上限（与上下文窗口无关；本地模型足够安全） */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192
/** 输出 token 硬封顶（防止误把上下文窗口值当成输出上限） */
export const MAX_OUTPUT_CAP = 32768

/** 模型请求错误类别 */
export type ModelErrorKind =
  | 'tools'
  | 'vision'
  | 'stream_options'
  | 'max_tokens'
  | 'context'
  | 'auth'
  | 'unknown'

// ═══════════════════════════════════════════════════════════
// 端点判定
// ═══════════════════════════════════════════════════════════

/**
 * 判断是否为本地 / 局域网推理端点（免密、弱校验、可能需要去鉴权重试）。
 * 覆盖 localhost、127.x、0.0.0.0、IPv6 ::1、192.168.*、10.*、172.16-31.*、
 * 以及链路本地 169.254.*。
 */
export function isLocalEndpoint(baseUrl?: string | null): boolean {
  if (!baseUrl) {return false}
  const u = String(baseUrl).toLowerCase()
  if (/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|169\.254\.)/.test(u)) {return true}
  if (/192\.168\.\d+\.\d+/.test(u)) {return true}
  if (/10\.\d+\.\d+\.\d+/.test(u)) {return true}
  if (/172\.(1[6-9]|2\d|3[01])\.\d+\.\d+/.test(u)) {return true}
  return false
}

// ═══════════════════════════════════════════════════════════
// 视觉模型名启发式
// ═══════════════════════════════════════════════════════════

/**
 * 常见多模态 / 视觉模型命名特征（命中任一即视为视觉模型）。
 * 宁可漏判（false negative 由运行时 400 降级兜底），不可把纯文本误判为视觉。
 */
const VISION_NAME_PATTERNS: RegExp[] = [
  /qwen[\d.]*[-\s]?vl/i,        // Qwen2-VL / Qwen2.5-VL / Qwen3-VL
  /qwen[-\s]?omni/i,
  /llava/i,                    // LLaVA 系列
  /minicpm[-\s]?[vo]/i,        // MiniCPM-V / MiniCPM-o
  /moondream/i,
  /internvl/i,
  /cogvlm/i,
  /glm[-\s]?\d+(\.\d+)?v/i,    // GLM-4V / GLM-4.5V
  /glm[-\s]?v/i,
  /llama[\d.]*[-\s]?vision/i,  // Llama 3.2 Vision
  /llama[-\s]?\d+\.\d+[-\s]?\d+b[-\s]?vision/i,
  /pixtral/i,                  // Mistral Pixtral
  /molmo/i,
  /florence/i,
  /deepseek[-\s]?vl/i,
  /kimi[-\s]?[\w]*[-\s]?vl/i,  // Kimi-VL
  /moonshot[-\s]?[\w]*[-\s]?vl/i,
  /smolvlm/i,
  /yi[-\s]?vl/i,
  /ovis/i,
  /nvila/i,
  /gemini/i,                   // Gemini 1.5/2.x 多模态
  /gpt[-\s]?4o/i,              // gpt-4o
  /gpt[-\s]?4\.\d/i,           // gpt-4.1
  /gpt[-\s]?4[-\s]?turbo/i,
  /gpt[-\s]?5/i,
  /claude[-\s]?3/i,            // Claude 3 系（含 Haiku/Sonnet/Opus）支持视觉
  /claude[-\s]?[45]/i,
]

/** 按模型名启发式判断是否为视觉（多模态）模型 */
export function looksLikeVisionModel(model?: string | null): boolean {
  if (!model) {return false}
  const m = String(model).toLowerCase()
  return VISION_NAME_PATTERNS.some((re) => re.test(m))
}

// ═══════════════════════════════════════════════════════════
// 错误分类
// ═══════════════════════════════════════════════════════════

/**
 * 依据 HTTP 状态码 + 错误文本，把一次失败归类为可识别的能力不匹配。
 * 返回 unknown 表示无法在通信层安全降级（应原样把错误交给用户）。
 */
export function classifyModelError(status: number, rawText?: string | null): ModelErrorKind {
  const text = String(rawText || '').toLowerCase()

  if (status === 401 || status === 403) {return 'auth'}

  // 流选项（旧 llama.cpp / 部分兼容层不识别）
  if (/stream_options|include_usage/.test(text)) {return 'stream_options'}

  const anyOf = (patterns: RegExp[]) => patterns.some((re) => re.test(text))

  // 上下文超长（先于 max_tokens，避免被 "maximum" 之类词误抢）
  if (anyOf([
    /context[_\s-]?length/, /n_ctx/, /max_model_len/, /context window/, /maximum context/,
    /max position|position embedding/, /input is too long|prompt is too long/,
    /too many tokens|reduce the length|tokens for the input|prompt tokens/,
  ])) {
    return 'context'
  }

  // 输出上限过大
  if (anyOf([
    /max_tokens|max_new_tokens|num_predict/,
    /maximum number of output/,
    /completion tokens.*(at most|exceed)/,
    /max_tokens.*(at most|too large|larger|exceed)/,
  ])) {
    return 'max_tokens'
  }

  // 视觉 / 图片输入不支持
  if (anyOf([
    /image_url|does not support image/,
    /not support.*(vision|image|multimodal|multi-modal|visual)/,
    /multimodal|multi-modal|visual content|pixel/,
    /only supports text|text-?only/,
    /invalid.*image|unsupported content (type|part)/,
    /content.*(image|part).*not/,
  ])) {
    return 'vision'
  }

  // 函数调用 / tools 不支持
  if (anyOf([
    /tool_choice|tool_calls|function.?call/,
    /unknown arguments?:?\s*'?tools?|unknown field '?tools?/,
    /not support.*tools?|tools?.*not support|tools? are not supported/,
    /does not support tools|chat template.*tool|tool.*template/,
    /\btools?\b/,
  ])) {
    return 'tools'
  }

  return 'unknown'
}

// ═══════════════════════════════════════════════════════════
// 请求体降级
// ═══════════════════════════════════════════════════════════

/** 从消息里移除图片 part（保留文本），用于纯文本模型降级 */
function stripImageMessages(messages: any[] | undefined): any[] {
  if (!Array.isArray(messages)) {return []}
  return messages.map((m) => {
    if (!m || !Array.isArray(m.content)) {return m}
    const text = m.content
      .filter((p: any) => p && p.type === 'text')
      .map((p: any) => p.text || '')
      .join('\n')
      .trim()
    return { ...m, content: text || '（图片内容已忽略：当前模型不支持视觉输入）' }
  })
}

/**
 * 按错误类别，从请求体移除问题字段，返回新的可重试请求体（不修改入参）。
 * context 类无法在通信层修复（应靠上层裁剪历史），原样返回。
 *
 * ⚠️ 关于 `tools` 降级的致命细节（2026-10-04 新发现）
 * ---------------------------------------------
 * 删掉 `tools` 字段之后，**模型就再也不知道有哪些工具可用**。
 * 而 XML 工具调用兜底（`llm/xmlToolCall.ts` → `reactEngine.tryExecuteXmlToolCall`）
 * 依赖模型输出 `<tool_name>` 这类标记 —— 模型得先被告知有哪些工具，才可能输出。
 *
 * 也就是说：**只删 tools 而不补提示词，等于把一个能干活但用不了原生协议的模型，
 * 降级成了一个纯聊天机器人**，而且是静默降级 —— 用户只会觉得「Lumina 变傻了」，
 * 不会知道原因是它的模型不带工具模板。
 *
 * 修法：调用方在拿到 `kind === 'tools'` 时，除了跑 degradeForKind，
 * **必须**再用 `injectXmlToolInstructions()` 把工具清单以纯文本形式注入 system prompt。
 * `needsXmlToolInstructions()` 就是这条契约的判定入口。
 */
export function degradeForKind(
  body: Record<string, any>,
  kind: ModelErrorKind,
): Record<string, any> {
  const next: Record<string, any> = { ...body }
  switch (kind) {
    case 'tools':
      delete next.tools
      delete next.tool_choice
      break
    case 'stream_options':
      delete next.stream_options
      break
    case 'vision':
      next.messages = stripImageMessages(next.messages)
      break
    case 'max_tokens': {
      const cur = typeof next.max_tokens === 'number' ? next.max_tokens : DEFAULT_MAX_OUTPUT_TOKENS
      next.max_tokens = Math.min(cur, 4096)
      break
    }
    case 'context':
    case 'auth':
    case 'unknown':
    default:
      break
  }
  return next
}

/**
 * 把输出 token 上限收敛到安全区间：
 * 与「上下文窗口」解耦，缺省给 DEFAULT_MAX_OUTPUT_TOKENS，并封顶 MAX_OUTPUT_CAP。
 */
export function clampOutputTokens(value?: number | null): number {
  const n = typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_MAX_OUTPUT_TOKENS
  return Math.min(Math.floor(n), MAX_OUTPUT_CAP)
}

/**
 * 给用户 / 日志的中文降级说明（stream_options / max_tokens 属静默修复，返回空串）。
 */
export function describeLimitation(kind: ModelErrorKind, model?: string | null): string {
  const m = model ? `「${model}」` : '当前模型'
  switch (kind) {
    case 'tools':
      return `模型 ${m} 不支持原生函数调用，已自动切换为「XML 工具调用」兼容模式（能力不降级，只是慢一点）；若仍不生效，请换用带工具模板的指令模型（Qwen2.5/Qwen3、GLM-4、Llama 3.1 等）。`
    case 'vision':
      return `模型 ${m} 不支持图片/视觉输入，无法查看屏幕或图片；请在设置里为视觉 / Computer Use 单独配置视觉模型（如 Qwen2.5-VL、GPT-4o、GLM-4V）。`
    case 'context':
      return `对话已超出模型 ${m} 的上下文长度，请缩短对话、开新会话，或换用更大上下文的模型。`
    case 'stream_options':
    case 'max_tokens':
    default:
      return ''
  }
}

// ═══════════════════════════════════════════════════════════
// 无原生工具协议时的 XML 兼容层
//
// 【要解决什么】
// 2026-10-04 发布前评测实测到：1.4B 与 35B 的差距里，「工具选择正确率」是 2/3 vs 3/3 的一项。
// 而大量本地部署的模型（尤其是量化小模型、老版本 GGUF）的 chat template
// 根本不带 function calling，provider 只能报 400。
//
// 现状是：degradeForKind('tools') 删掉 tools → 模型变纯聊天 → 能力归零。
// 本模块提供补偿：**用纯文本告诉模型有哪些工具、怎么用 XML 格式调它们**。
// 于是「不支持原生协议」从「能力降级为 0」变成「能力保持，只是慢一点」。
//
// 【为什么不常驻在 prompt 里】
// 因为绝大多数模型（尤其 35B+）原生支持 tools，常驻这段提示词是纯 token 浪费，
// 而且会诱发支持原生协议的模型也去写 XML。只在检测到 tools 不支持时才注入。
// ═══════════════════════════════════════════════════════════

/** 判定：这种错误是否需要补 XML 工具说明（与 degradeForKind 的契约入口） */
export function needsXmlToolInstructions(kind: ModelErrorKind): boolean {
  return kind === 'tools'
}

/** 单个工具的精简描述 */
export interface XmlToolSpec {
  name: string
  description?: string
  /** 形如 { path: 'string', content: 'string' } */
  params?: Record<string, unknown>
}

/** 把描述压到一句话。模型名里常有换行与冗余，直接塞进 prompt 会污染 XML 结构。 */
function condense(text: string | undefined, max = 60): string {
  if (!text) {return ''}
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/**
 * 参数类型推断：JSON Schema 的 type 字段不一定存在，按名字猜。
 * 猜错的后果很小（模型写错参数会被工具层报「缺参数」），比完全不写好。
 */
function inferType(spec: unknown): string {
  if (!spec || typeof spec !== 'object') {return 'string'}
  const s = spec as Record<string, unknown>
  if (Array.isArray(s.enum) && s.enum.length > 0) {
    return s.enum.map(v => JSON.stringify(v)).join(' | ')
  }
  if (typeof s.type === 'string') {
    if (s.type === 'array') {return 'string[]'}
    if (s.type === 'integer' || s.type === 'number') {return 'number'}
    if (s.type === 'boolean') {return 'boolean'}
    return s.type
  }
  return 'string'
}

/**
 * 生成 XML 工具调用的提示词块。
 *
 * 【格式为什么选 XML 而不是 JSON】
 * 量化小模型写 JSON 时极易漏引号、多逗号、括号不配对（项目此前的实测里就有）。
 * XML 容错性更好，且项目已有解析器认它 —— 不新增第二套协议。
 *
 * @param tools    工具清单（来自 ToolDef）
 * @param maxTools 最多列几个。工具太多时模型会选不过来（实测 1.4B 在 3 个工具里选对 2 个，
 *                 48 个工具里几乎必然选错）。**宁可少列，不可全列。**
 */
export function buildXmlToolInstructions(tools: XmlToolSpec[], maxTools = 12): string {
  if (!Array.isArray(tools) || tools.length === 0) {return ''}
  const shown = tools.slice(0, maxTools)
  const lines = shown.map(t => {
    const desc = condense(t.description)
    const params = t.params && typeof t.params === 'object' ? t.params : {}
    const keys = Object.keys(params)
    const argHint = keys.length > 0
      ? `参数：${keys.map(k => `${k}(${inferType(params[k])})`).join(', ')}`
      : '参数：无'
    return `  - ${t.name} — ${desc || '（无描述）'}｜${argHint}`
  })
  const omitted = tools.length - shown.length
  return [
    '## 工具调用格式（当前模型不支持原生函数调用，请用下面的 XML 格式）',
    '',
    '当你需要执行动作时，输出一行：',
    ' <tool_call>{"tool_name": "工具名", "args": {"参数名": "值"}}</tool_call>',
    '',
    '当前可用工具：',
    ...lines,
    omitted > 0 ? `  …（另有 ${omitted} 个工具未列出，需要时请先询问用户）` : '',
    '',
    '规则：',
    '1. 一次只调用一个工具，调用后等待结果，不要凭空假设结果。',
    '2. 不需要工具时，正常回答，不要输出 <tool_call>。',
    '3. args 必须是合法 JSON，字符串用双引号。',
    '4. 工具执行结果会作为用户消息回传给你，届时继续判断是否需要下一步。',
  ].filter(l => l !== '').join('\n')
}

/** 注入标记，用于幂等检测 */
const XML_BLOCK_MARKER = '工具调用格式（当前模型不支持原生函数调用'

/**
 * 把 XML 工具说明注入到 system prompt 末尾（不修改入参）。
 * 已注入过则不重复 —— 降级重试可能走多次，重复注入会浪费大量 token。
 */
export function injectXmlToolInstructions<T extends { role: string; content: any }>(
  messages: T[] | undefined,
  tools: XmlToolSpec[],
  maxTools?: number,
): T[] | undefined {
  const block = buildXmlToolInstructions(tools, maxTools)
  if (!block || !Array.isArray(messages) || messages.length === 0) {return messages}
  if (typeof messages[0]?.content === 'string' && messages[0].content.includes(XML_BLOCK_MARKER)) {
    return messages
  }
  const out = messages.map(m => ({ ...m }))
  out[0] = { ...out[0], content: `${String(out[0]?.content ?? '')}\n\n${block}` }
  return out
}
