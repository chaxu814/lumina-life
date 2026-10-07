// ============================================================
// core/modelCapabilities.ts — 模型能力画像（纯函数 · 主动推导）
//
// 【要解决的问题】
// 这个项目之前有**三套互不相干**的模型知识，各写各的：
//
//   1. modelCapabilityCache._defaultCapability()
//      → 硬编码 maxContextTokens: 256_000、supportsTools: true
//        对一个 4B 的本地模型来说这是幻想：它实际 n_ctx 可能只有 8K。
//   2. modelCompat.clampOutputTokens()
//      → 只有一个 MAX_OUTPUT_CAP = 32768 的硬上限
//   3. modelCompat.looksLikeVisionModel()
//      → 几个正则，补一个模型加一条
//
// 结果就是「按模型打补丁」：新模型发布 → 不认识 → 拿 256K 去要输出
// → 小模型直接截断 → 用户看到「模型返回了无法识别的内容」。
// **每修一个模型就多一个特例，而下个月又会有新模型。**
//
// 【本模块的做法：不认识模型也能给出合理画像】
//
// 核心洞察：**几乎所有开源模型的命名里都编码了参数量**。
//   Qwen2.5-7B-Instruct  ·  llama-3.1-8b  ·  gemma-2-9b-it
//   Phi-3.5-mini(3.8B)  ·  Mistral-7B  ·  Yi-1.5-34B-Chat
// 参数量 → 能力档位，这是**统一规则**，不是特例。
// 于是今天没发布、明天发布的模型，只要名字里有 "7B"，
// 不改一行代码也能拿到合理画像。
//
// 三个轴，各自独立推导：
//   参数量档位 → 上下文窗口 / 输出预算 / 建议超时
//   命名家族   → 是否多模态 / 是否推理模型
//   运行时反馈 → 覆盖「预期」（服务端 400 比任何猜测都准）
//
// 【优先级：显式配置 > 运行时反馈 > 家族规则 > 档位表 > 兜底】
// 每一层都可能是错的，所以要能一层层退回去，且**始终知道当前用的是哪一层**（source 字段），
// 这样 UI 才能告诉用户「这个数字是从哪来的」，而不是让他猜。
// ============================================================

// ═══════════════════════════════════════════════════════════
// 档位
// ═══════════════════════════════════════════════════════════

export type ModelTier = 'nano' | 'small' | 'medium' | 'large' | 'xlarge' | 'moe'

export interface TierSpec {
  /** 上下文窗口（能读多少 token） */
  contextWindow: number
  /** 单次输出预算（能写多少 token）—— 始终 ≤ contextWindow 的一半 */
  outputBudget: number
  /** 建议超时（毫秒），随参数量增长 */
  timeoutMs: number
}

/**
 * 档位表 —— **这是整个模块唯一的经验值来源**。
 *
 * 关键约束：outputBudget ≤ contextWindow / 2。
 * 一个 8K 上下文的模型不可能输出 32K —— 这条约束一旦破了，
 * 小模型就会在回答说到一半时被硬截断，而症状是「内容不完整/无法识别」，
 * 极难定位。
 */
const TIER_TABLE: Record<ModelTier, TierSpec> = {
  nano:   { contextWindow:  4_096, outputBudget: 1_024, timeoutMs: 120_000 },
  small:  { contextWindow:  8_192, outputBudget: 2_048, timeoutMs: 180_000 },
  medium: { contextWindow: 32_768, outputBudget: 4_096, timeoutMs: 300_000 },
  large:  { contextWindow: 65_536, outputBudget: 8_192, timeoutMs: 600_000 },
  xlarge: { contextWindow: 131_072, outputBudget: 8_192, timeoutMs: 900_000 },
  moe:    { contextWindow: 32_768, outputBudget: 4_096, timeoutMs: 900_000 },
}

// ═══════════════════════════════════════════════════════════
// 参数量解析
// ═══════════════════════════════════════════════════════════

/**
 * 从模型名里解析参数量（B，十亿）。
 *
 * 处理真实命名里的各种花样：
 *   7B / 7b / 7.5B / 0.5B / 1.7B        → 单体量化
 *   8x7B / 3x8B                            → MoE，按「活跃参数」算一个专家即可
 *   70B-chat / 72B-Instruct                 → 后缀
 *   236B-A22B                               → 总参数在前，取总参数（更保守）
 *
 * 解析不出来返回 null，**不要瞎猜成 7B**（旧实现就是硬编码 7，
 * 那是所有模型都变成 7B 能力的一个隐性 bug）。
 */
export function parseParamSizeB(modelName?: string | null): number | null {
  if (!modelName) {return null}
  const s = String(modelName)

  // MoE 形如 8x7B / Mixtral-8x7B —— 取「专家数 × 专家大小」作为活跃规模
  const moe = s.match(/(\d+)\s*[xX×]\s*(\d+(?:\.\d+)?)\s*B/i)
  if (moe) {
    const n = Number(moe[1]); const d = Number(moe[2])
    if (Number.isFinite(n) && Number.isFinite(d) && d > 0) { return n * d }
  }

  // 常规：B 前必须有数字，支持小数
  const m = s.match(/(\d+(?:\.\d+)?)\s*[bB](?![a-zA-Z])/)
  if (m) {
    const v = Number(m[1])
    if (Number.isFinite(v) && v > 0) { return v }
  }

  return null
}

/** 参数量 → 档位。未知参数量按 small（保守中位）处理。 */
export function tierForParamSize(paramsB: number | null): ModelTier {
  if (paramsB === null) {return 'small'}
  if (paramsB < 1.5) {return 'nano'}
  if (paramsB < 7) {return 'small'}
  if (paramsB < 20) {return 'medium'}
  if (paramsB < 50) {return 'large'}
  return 'xlarge'
}

// ═══════════════════════════════════════════════════════════
// 命名家族（**只管特征，不管大小**）
// ═══════════════════════════════════════════════════════════

/**
 * 家族规则表。
 *
 * 这不是「给某几个模型打补丁」，而是**特征识别**：
 * 一个模型支持不支持图片，看的是它架构命名里的 `vl`/`llava` 标记，
 * 与它是 7B 还是 70B 无关。新出的 Qwen3-VL 会被同一条规则自动覆盖。
 */
const VISION_PATTERNS: RegExp[] = [
  /[-\s]vl[-\s]/i, /qwen\d?[\d.]*-?vl/i, /\bvl\b/i,
  /llava/i, /bakllava/i, /minicpm[-_]?v/i, /internvl/i,
  /pixtral/i, /idefics/i, /mllama/i, /paligemma/i, /molmo/i,
  /gemma-?3/i,          // Gemma 3 原生多模态
  /gpt-4o/i, /claude-3/i, /gemini/i,   // 云端多模态
]

const REASONING_PATTERNS: RegExp[] = [
  /\bqwq\b/i, /deepseek-?r1/i, /-r1\b/i, /\breasoner\b/i, /\bthink(?:ing)?\b/i,
  /magistral/i, /phi-?4-?reasoning/i, /exaone-?deep/i,
  /o1(?:-|mini)?/i, /o3(?:-|mini)?/i, /gpt-5/i,
]

/**
 * 指令微调标记 —— 决定模型能不能可靠地按格式输出。
 * 基础预训练模型（不是 -Instruct / -Chat / -it）往往不遵循格式，
 * 工具调用尤其容易崩。这里是**预期**，运行时 400 仍可推翻。
 */
const INSTRUCT_PATTERNS: RegExp[] = [
  /instruct/i, /\bchat\b/i, /-it\b/i, /\bui\b/,
  /-\d+b(?:-|$)/i, /qwen[\d.]+/i, /gemma-?2/i, /phi-?3/i,
]

/**
 * 工具调用（function calling）**预期**支持。
 *
 * 这里是「预期」不是「保证」：现在的主流指令模型（Qwen2.5+、Llama 3.1+、
 * Hermes、GLM、Mistral-Instruct）普遍带 tool template；基础模型不行。
 * 猜错的后果由运行时 400 → markNoToolSupport() 兜底（见 modelCompat）。
 */
const TOOL_CAPABLE_HINTS: RegExp[] = [
  /hermes/i, /functionary/i, /xlam/i, /toolbench/i, /gorilla/i,
  /qwen2\.5/i, /qwen3/i, /llama-?3\.[1-9]/i, /mistral.*instruct/i,
  /gemma-?2.*it/i, /glm-?4/i, /minicpm/i, /internlm/i, /yi-?1\.[5-9]/i,
  /gpt-4/i, /gpt-5/i, /claude/i, /gemini/i, /deepseek/i,
]

export function looksVision(modelName?: string | null): boolean {
  if (!modelName) {return false}
  return VISION_PATTERNS.some(re => re.test(modelName))
}

export function looksReasoning(modelName?: string | null): boolean {
  if (!modelName) {return false}
  return REASONING_PATTERNS.some(re => re.test(modelName))
}

export function looksInstructTuned(modelName?: string | null): boolean {
  if (!modelName) {return false}
  return INSTRUCT_PATTERNS.some(re => re.test(modelName))
}

export function looksToolCapable(modelName?: string | null): boolean {
  if (!modelName) {return false}
  return TOOL_CAPABLE_HINTS.some(re => re.test(modelName))
}

// ═══════════════════════════════════════════════════════════
// 统一解析入口
// ═══════════════════════════════════════════════════════════

export type CapabilitySource =
  /** 用户在设置里显式填了 */
  | 'explicit'
  /** 运行时 400 反馈推翻过（最高优先级：实测胜过一切猜测） */
  | 'runtime'
  /** 服务端自己报告的（/v1/models 里的上下文长度等） */
  | 'server'
  /** 命名家族规则 */
  | 'family'
  /** 参数量档位表 */
  | 'size'
  /** 什么都认不出来 */
  | 'fallback'

/** 服务端报告的事实（来自 core/modelServerFacts.ts） */
export interface ServerFacts {
  contextWindow?: number | null
  supportsVision?: boolean | null
  supportsTools?: boolean | null
  /** 架构族，如 ['llama','clip'] */
  families?: string[]
  /** 参数量文本，如 '4.1B'（Ollama 报的是这个，比名字可靠） */
  paramSizeText?: string | null
}

export interface ResolvedCapabilities {
  modelName: string
  /** 上下文窗口：能读多少 */
  contextWindow: number
  /** 单次输出预算：能写多少（恒 ≤ contextWindow / 2） */
  outputBudget: number
  /** 建议超时（毫秒） */
  timeoutMs: number
  supportsTools: boolean
  supportsVision: boolean
  isReasoning: boolean
  paramSizeB: number | null
  tier: ModelTier
  /** 每个字段当前的来源，供 UI 解释「这个数字从哪来」 */
  source: {
    contextWindow: CapabilitySource
    outputBudget: CapabilitySource
    tools: CapabilitySource
    vision: CapabilitySource
  }
}

export interface ResolveInput {
  modelName?: string | null
  /** 用户在设置里填的上下文窗口；给了就优先用它 */
  explicitContextWindow?: number | null
  /** 服务端自己报告的事实（权威，胜过名字猜测） */
  server?: ServerFacts | null
  /** 运行时反馈（modelCapabilityCache）；已知的降级结果优先于猜测 */
  runtime?: {
    supportsTools?: boolean
    supportsVision?: boolean
  }
}

/**
 * 解析一个模型的能力画像。
 *
 * **纯函数**：不读文件、不发请求、可单测。这点很重要 ——
 * 能力判断一旦掺进 IO，就没法穷举验证，而「穷举各种模型名」正是
 * 防止回归的唯一办法。
 */
export function resolveCapabilities(input: ResolveInput): ResolvedCapabilities {
  const modelName = String(input.modelName || '').trim()
  // 参数量：服务端报的比名字可靠（Ollama 的 details.parameter_size 是实数）
  const serverParam = input.server?.paramSizeText
    ? parseParamSizeB(input.server.paramSizeText)
    : null
  const paramsB = serverParam ?? parseParamSizeB(modelName)
  const tier = tierForParamSize(paramsB)
  const spec = TIER_TABLE[tier]

  // ── 上下文窗口 ──
  // 优先级：显式配置 > 服务端报告 > 档位表
  // 服务端报告放第二位而不是最后一位，是本次改动的核心：
  // 名字里的参数量只能「估」，而 /v1/models 里的 max_context_length 是「真值」。
  let contextWindow = spec.contextWindow
  let ctxSource: CapabilitySource = 'size'

  const serverCtx = input.server?.contextWindow
  if (typeof serverCtx === 'number' && Number.isFinite(serverCtx) && serverCtx >= 1024) {
    contextWindow = Math.floor(serverCtx)
    ctxSource = 'server'
  }

  const explicit = input.explicitContextWindow
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit >= 1024) {
    // 用户显式配置 —— 但也不能离谱。
    // 有人把 131072 填给了 4B 模型，那正是本次故障的起因：
    // 配置本身可以是错的，所以**上限要受档位表的 4 倍约束**，
    // 既尊重用户输入，又不至于离谱到让小模型彻底没法输出。
    //
    // 但如果**服务端已经报了真实值**，就以服务端为准：
    // 用户填的可能是旧值（比如换过 LM Studio 里的 n_ctx 设置），
    // 而服务端说的是「此刻实际加载的」。
    const ceiling = spec.contextWindow * 4
    const fromExplicit = Math.max(1024, Math.min(Math.floor(explicit), ceiling))
    if (ctxSource !== 'server') {
      contextWindow = fromExplicit
      ctxSource = 'explicit'
    } else {
      // 两者差距超过一倍时认为显式值是过期的，按服务端真值走
      const serverWins = fromExplicit < serverCtx! / 2 || fromExplicit > serverCtx! * 2
      if (serverWins) {
        contextWindow = Math.floor(serverCtx!)
        ctxSource = 'server'
      } else {
        contextWindow = fromExplicit
        ctxSource = 'explicit'
      }
    }
  }

  // ── 输出预算 ──
  // 硬约束：≤ 上下文的一半。这条是本模块存在的核心理由。
  const outputBudget = Math.min(spec.outputBudget, Math.floor(contextWindow / 2))
  const outSource: CapabilitySource = outSourceFor(spec, ctxSource)

  // ── 特征 ──
  const rt = input.runtime
  const sv = input.server
  let supportsTools: boolean
  let toolSource: CapabilitySource
  if (typeof rt?.supportsTools === 'boolean') {
    supportsTools = rt.supportsTools
    toolSource = 'runtime'
  } else if (typeof sv?.supportsTools === 'boolean') {
    supportsTools = sv.supportsTools
    toolSource = 'server'
  } else {
    supportsTools = looksToolCapable(modelName)
    toolSource = toolSourceFor(modelName)
  }

  let supportsVision: boolean
  let visionSource: CapabilitySource
  if (typeof rt?.supportsVision === 'boolean') {
    supportsVision = rt.supportsVision
    visionSource = 'runtime'
  } else if (typeof sv?.supportsVision === 'boolean') {
    // 服务端明确说了（或者从架构族推出来的），比名字正则可靠
    supportsVision = sv.supportsVision
    visionSource = 'server'
  } else {
    supportsVision = looksVision(modelName)
    visionSource = toolSourceFor(modelName)
  }

  return {
    modelName,
    contextWindow,
    outputBudget,
    timeoutMs: spec.timeoutMs,
    supportsTools,
    supportsVision,
    isReasoning: looksReasoning(modelName),
    paramSizeB: paramsB,
    tier,
    source: { contextWindow: ctxSource, outputBudget: outSource, tools: toolSource, vision: visionSource },
  }
}

function outSourceFor(spec: TierSpec, ctxSource: CapabilitySource): CapabilitySource {
  if (ctxSource === 'explicit' || ctxSource === 'server') { return ctxSource }
  return spec.contextWindow > 0 ? 'size' : 'fallback'
}

function toolSourceFor(modelName: string): CapabilitySource {
  // 没有任何模型名 → 什么都认不出来，退到兜底。
  // 认出了名字但没命中任何家族规则 → 仍然算「家族层」（规则跑过了，只是没匹配上）。
  return modelName ? 'family' : 'fallback'
}

/**
 * 给用户看的一句话解释：这个画像是怎么来的。
 * 「不要出现个别的模型的特立独行」——那就让用户看得见规则本身，
 * 而不是只看到一个魔法数字。
 */
export function explainCapabilities(c: ResolvedCapabilities): string {
  const size = c.paramSizeB !== null ? `${c.paramSizeB}B` : '参数量未知'
  const bits: string[] = []
  if (c.source.contextWindow === 'server') {
    bits.push('上下文窗口取自推理服务端的实际报告值')
  } else if (c.source.contextWindow === 'explicit') {
    bits.push('上下文窗口用你在设置里填的值')
  } else {
    bits.push(`上下文窗口按参数量 ${size} 归入 ${c.tier} 档估算`)
  }
  if (c.source.tools === 'runtime') {
    bits.push('工具调用支持与否以运行时实测为准')
  } else if (c.source.tools === 'server') {
    bits.push('工具调用能力由服务端报告')
  } else {
    bits.push('工具调用为按命名规则的预期值，实测不符会自动纠正')
  }
  if (c.source.vision === 'server') {
    bits.push('视觉能力由服务端报告')
  }
  return bits.join('；')
}
