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
  if (!baseUrl) return false
  const u = String(baseUrl).toLowerCase()
  if (/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|169\.254\.)/.test(u)) return true
  if (/192\.168\.\d+\.\d+/.test(u)) return true
  if (/10\.\d+\.\d+\.\d+/.test(u)) return true
  if (/172\.(1[6-9]|2\d|3[01])\.\d+\.\d+/.test(u)) return true
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
  if (!model) return false
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

  if (status === 401 || status === 403) return 'auth'

  // 流选项（旧 llama.cpp / 部分兼容层不识别）
  if (/stream_options|include_usage/.test(text)) return 'stream_options'

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
  if (!Array.isArray(messages)) return []
  return messages.map((m) => {
    if (!m || !Array.isArray(m.content)) return m
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
      return `模型 ${m} 不支持函数调用（function calling），已自动切换为纯对话重试；工具/桌面操作能力受限，建议换用 Qwen2.5/Qwen3、GLM-4、Llama 3.1 等带工具模板的指令模型。`
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
