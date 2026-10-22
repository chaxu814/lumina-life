// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// core/agentUtils.ts — Agent 工具函数集 (v9.2)
//
// 从 agentRunner.ts 拆出的独立工具函数，不依赖 AgentRunner 实例状态。
// 包含：文本后处理（去填充/去元注释/去泄露/去重等）、模型上下文窗口数据。
// ============================================================

// ═══════════════════════════════════════════════════════════
// 填充文本过滤器
// ═══════════════════════════════════════════════════════════

/** 匹配结尾的填充性反问/自我确认废话 */
export const FILLER_PATTERNS: RegExp[] = [
  // 结尾反问
  /[。！!~～]*\s*(还有什么想问的吗[？?]?)\s*$/,
  /[。！!~～]*\s*(还有什么需要帮忙的吗[？?]?)\s*$/,
  /[。！!~～]*\s*(还有什么问题吗[？?]?)\s*$/,
  /[。！!~～]*\s*(还有什么想聊的吗[？?]?)\s*$/,
  /[。！!~～]*\s*(还有什么可以帮你的吗[？?]?)\s*$/,
  /[。！!~～]*\s*(有其他问题吗[？?]?)\s*$/,
  /[。！!~～]*\s*(有任何问题随时问我(哦|哟|呀|嘛|呢)?[！!。.？?]?)\s*$/,
  /[。！!~～]*\s*(随时可以问我(哦|哟|呀|嘛|呢)?[！!。.？?]?)\s*$/,
  /[。！!~～]*\s*(希望这(能|可以)?(帮到|对你有)你[！!。.？?]?)\s*$/,
  // 自我确认式废话
  /^刚才的回答没问题[~～！!。.]*\s*/m,
  /^希望这能解决你的问题[~～！!。.]*\s*/m,
  /^希望对你有帮助[~～！!。.]*\s*/m,
  // 英文填充
  /[.!]*\s*(Is there anything else I can help (you )?with[?]?)\s*$/i,
  /[.!]*\s*(Let me know if you (need|have) anything else[.]?)\s*$/i,
  /[.!]*\s*(Hope this helps[!]?)\s*$/i,
]

/**
 * 剥离模型回复末尾的填充性废话
 */
export function stripFillerText(text: string): string {
  if (!text || text.length < 5) {return text}
  let cleaned = text
  for (const pattern of FILLER_PATTERNS) {
    cleaned = cleaned.replace(pattern, '')
  }
  cleaned = cleaned.replace(/\s*[。！!~～]{2,}\s*$/, '').trimEnd()
  return cleaned.length < 3 ? text : cleaned
}

// ═══════════════════════════════════════════════════════════
// 过滤 meta-commentary
// ═══════════════════════════════════════════════════════════

/** agent 解说自己的系统指令/工具/行为逻辑的元注释 */
export const META_COMMENTARY_PATTERNS: RegExp[] = [
  /这条系统提示[是在]*.*/g,
  /系统指令[是在]*.*/g,
  /提示词[是在告]*.*/g,
  /根据(我的)?工具列表.*/g,
  /我(需要|不需要)(调用|使用)工具.*/g,
  /上一轮对话已经.*完成了.*/g,
  /所以我用.*是正确的做法.*/g,
  /我的(角色|身份|设定)是.*/g,
]

export function stripMetaCommentary(text: string): string {
  if (!text) {return text}
  // 🆕 fix-稳定生成: 先把合法的团队身份声明保护起来，避免被误杀
  const identityPlaceholders: string[] = []
  const LEGACY_IDENTITY_PATTERNS: RegExp[] = [
    /^你是 Yak[，,] 代码工程师[。.]\s*/gm,
    /^你是热茶[，,] 审查员[。.]\s*/gm,
  ]
  let cleaned = text
  for (const pattern of LEGACY_IDENTITY_PATTERNS) {
    cleaned = cleaned.replace(pattern, (match) => {
      const placeholder = `\x00IDENTITY_${identityPlaceholders.length}\x00`
      identityPlaceholders.push(match)
      return placeholder
    })
  }
  for (const pattern of META_COMMENTARY_PATTERNS) {
    cleaned = cleaned.replace(pattern, '').trim()
  }
  // 还原身份声明
  cleaned = cleaned.replace(/\x00IDENTITY_(\d+)\x00/g, (_, idx) => identityPlaceholders[parseInt(idx)] || '')
  return cleaned.length < 5 ? text : cleaned
}

// ═══════════════════════════════════════════════════════════
// 清洗 tool 输出泄漏 / cross-agent 前缀 / 错误话术
// ═══════════════════════════════════════════════════════════

export const LEAKED_PATTERNS: RegExp[] = [
  // 🔍 搜索 tool 输出（带 emoji 和标头）
  /🔍\s*搜索.*?(?:\n.*?){0,40}(?=\n\n|\n[🔍🎯💡]|$)/gi,
  // 整段 tool 结果（以新闻/头条/热点/搜索结果/实时行情/财经网站开头）
  /(?:^|\n)(?:今天[是多]?条[大]?新闻|头条|热点|搜索结果|实时行情|财经网站|新闻列表).*(?:\n.*){0,30}/gi,
  // cross-agent 前缀被复述
  /\[(?:Yak|热茶|Lumina|系统)\]:/g,
  // 错误话术
  /让我换个方式[试试，看]/gi,
  /Bing[搜索]*[没]?[找到]*结果/gi,
  /没找到结果[，:]?让我/gi,
  /已收住[，,]不用工具了/gi,
  /工具[调用执行]*失败/gi,
  /搜索[引擎]*[没]?返回结果/gi,
]

export function stripLeakedOutput(text: string): string {
  if (!text || text.length < 5) {return text}
  let cleaned = text
  for (const pattern of LEAKED_PATTERNS) {
    cleaned = cleaned.replace(pattern, '')
  }
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim()
  return cleaned.length < 3 ? text : cleaned
}

// ═══════════════════════════════════════════════════════════
// 去重模型回复中的重复/近义块
// ═══════════════════════════════════════════════════════════

export function normalizeDedupeKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u200b-\u200f\ufeff]/g, '')
    .replace(/[^\u4e00-\u9fa5A-Za-z0-9]+/g, '')
    .slice(0, 180)
}

export function similarityRatio(a: string, b: string): number {
  const A = new Set([...a])
  const B = new Set([...b])
  if (A.size === 0 || B.size === 0) {return 0}
  let overlap = 0
  for (const ch of A) {
    if (B.has(ch)) {overlap++}
  }
  return overlap / Math.max(A.size, B.size)
}

// ═══════════════════════════════════════════════════════════
// 安全 strip 链 — 防止各 strip 函数组合使用时过度剥离内容
//
// 用法：
//   const cleaned = safeStripChain(
//     rawText,
//     stripFillerText,
//     stripMetaCommentary,
//     stripLeakedOutput,
//   )
//
// 保护规则：
//   1. Strip 后完全为空 → 返回原始内容（仅 trim）
//   2. Strip 后长度 < 15 且原始 >= 30 → 说明剥离过度，回退
//   3. Strip 后长度 < 原始 30% → 同样回退
//   4. 原始内容本来就很短 (< 30) → 基本不动
// ═══════════════════════════════════════════════════════════

/**
 * 安全执行 strip 链：当剥离过度时自动回退原始内容，
 * 确保模型回复不会被 strip 链完全清空。
 *
 * @param text     原始文本
 * @param fns      按顺序应用的 strip 函数列表
 * @returns        清洗后的文本，或剥离过度时返回原始内容（trimmed）
 */
export function safeStripChain(
  text: string,
  ...fns: Array<(t: string) => string>
): string {
  if (!text) {return text}
  const original = text
  let current = text
  for (const fn of fns) {
    current = fn(current)
  }
  const cleaned = current.trim()
  const origTrimmed = original.trim()
  const origLen = origTrimmed.length

  // 规则 1: strip 后完全为空 → 恢复
  if (!cleaned) {
    console.warn(`[safeStripChain] ⚠️ strip 链将内容完全清空（原始 ${origLen} 字），已回退原始文本`)
    return origTrimmed
  }

  // 规则 2: 原始内容 >= 30 字，strip 后 < 15 字 → 剥离过度，恢复
  if (origLen >= 30 && cleaned.length < 15) {
    console.warn(`[safeStripChain] ⚠️ strip 链剥离过度（${origLen}→${cleaned.length} 字），已回退原始文本`)
    return origTrimmed
  }

  // 规则 3: 原始内容 >= 30 字，strip 后 < 原始 30% → 剥离过度，恢复
  if (origLen >= 30 && cleaned.length < origLen * 0.3) {
    console.warn(`[safeStripChain] ⚠️ strip 链剥离过度（${origLen}→${cleaned.length} 字，${(cleaned.length/origLen*100).toFixed(0)}%），已回退原始文本`)
    return origTrimmed
  }

  return cleaned
}

export function stripRepeatedBlocks(text: string): string {
  if (!text || text.length < 30) {return text}

  const normalized = text.replace(/\r\n/g, '\n')
  const blocks = normalized.split(/\n{1,}/).map(b => b.trim()).filter(Boolean)
  const seen: Array<{ key: string; text: string }> = []
  const result: string[] = []
  let dropped = 0

  for (const block of blocks) {
    const key = normalizeDedupeKey(block)
    if (key.length >= 18) {
      const duplicate = seen.some(item => {
        const ratio = similarityRatio(key, item.key)
        return ratio > 0.78 && Math.abs(key.length - item.key.length) / Math.max(key.length, item.key.length) < 0.25
      })
      if (duplicate) {
        dropped++
        continue
      }
      seen.push({ key, text: block })
    }
    result.push(block)
  }

  const cleaned = result.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  if (dropped === 0) {return text}
  return cleaned.length >= text.length * 0.35 ? cleaned : text
}

// ═══════════════════════════════════════════════════════════
// 检测 emoji-only 回复
// ═══════════════════════════════════════════════════════════

export function isEmojiOnly(text: string): boolean {
  if (!text) {return false}
  const trimmed = text.trim()
  const withoutEmoji = trimmed
    .replace(/[\u{1F300}-\u{1F9FF}]/gu, '')  // Misc Symbols, Emoticons, etc.
    .replace(/[\u{2600}-\u{27BF}]/gu, '')     // Misc symbols
    .replace(/[\u{FE00}-\u{FE0F}]/gu, '')     // Variation selectors
    .replace(/[\u{200D}]/gu, '')              // ZWJ
    .replace(/\s+/g, '')
  return withoutEmoji.length === 0
}

// ═══════════════════════════════════════════════════════════
// 模型上下文窗口缓存
// ═══════════════════════════════════════════════════════════

/** 🔧 v2.16: 从 API 动态检测上下文窗口大小（替代硬编码推测） */
export const detectedContextCache = new Map<string, number | null>()

/** 已知模型的上下文窗口（仅用于 API 不返回 max_context_length 时的兜底） */
export const KNOWN_MODEL_WINDOWS: Record<string, number> = {
  // ── OpenAI ──
  'gpt-5': 128000, 'gpt-5-mini': 128000, 'gpt-5-nano': 128000,
  'gpt-4.1': 1000000, 'gpt-4.1-mini': 1000000, 'gpt-4.1-nano': 1000000,
  'gpt-4o': 128000, 'gpt-4o-mini': 128000,
  'gpt-4-turbo': 128000, 'gpt-4': 8192, 'gpt-4-32k': 32768,
  'gpt-3.5-turbo': 16384,
  'o1': 200000, 'o1-mini': 128000, 'o1-pro': 200000,
  'o3': 200000, 'o3-mini': 200000, 'o4-mini': 200000,
  // ── Anthropic ──
  'claude-4': 200000, 'claude-4-sonnet': 200000,
  'claude-3.7-sonnet': 200000, 'claude-3.5-sonnet': 200000,
  'claude-3-opus': 200000, 'claude-3-haiku': 200000,
  // ── DeepSeek (官方 API) ──
  'deepseek-chat': 1000000,
  'deepseek-reasoner': 1000000,
  'deepseek-v3.2': 131072, 'deepseek-v3.1': 131072,
  'deepseek-v3': 65536, 'deepseek-r1': 65536,
  'deepseek-coder': 65536,
  // ── 通义千问 (DashScope / Bailian) ──
  'qwen3.7-max': 1000000, 'qwen3.7-max-preview': 1000000,
  'qwen3.6-plus': 1000000, 'qwen3.6-flash': 1000000,
  'qwen3.6-max': 262144, 'qwen3.6-max-preview': 262144,
  'qwen3.5-plus': 1000000, 'qwen3.5-flash': 1000000,
  'qwen3.5-397b': 262144, 'qwen3.5-122b': 262144,
  'qwen3.5-27b': 262144, 'qwen3.5-35b': 262144,
  'qwen3-max': 32768, 'qwen3-plus': 131072, 'qwen3-turbo': 131072,
  'qwen-max': 32768, 'qwen-plus': 131072, 'qwen-turbo': 131072,
  'qwen2.5-72b': 131072, 'qwen2.5-32b': 131072,
  'qwen2.5-14b': 131072, 'qwen2.5-7b': 131072,
  'qwen2.5-coder': 131072, 'qwen2.5-vl': 131072,
  'qwq-32b': 131072, 'qwen-long': 10000000,
  // ── 智谱 GLM ──
  'glm-5.1': 198000, 'glm-5': 198000,
  'glm-4.7': 131072, 'glm-4.5': 131072, 'glm-4.5-air': 131072,
  'glm-4.5v': 131072,
  'glm-4-plus': 131072, 'glm-4v': 131072,
  'glm-4': 131072, 'glm-4-flash': 131072, 'glm-4-air': 131072,
  'glm-4-9b': 131072,
  'glm-3-turbo': 128000,
  // ── Kimi (Moonshot) ──
  'kimi-k2.6': 262144, 'kimi-k2.5': 262144, 'kimi-k2': 131072,
  // ── MiniMax ──
  'minimax-m2.5': 196608, 'minimax-m2': 196608, 'minimax-m1': 245760,
  // ── 硅基流动 (SiliconFlow) ──
  'deepseek-ai/deepseek-v4': 1000000,
  'deepseek-ai/deepseek-v3.2': 131072,
  'deepseek-ai/deepseek-v3.1': 131072,
  'deepseek-ai/deepseek-v3': 65536,
  'deepseek-ai/deepseek-r1': 65536,
  'pro/deepseek': 1000000,
  'qwen/qwen3.6': 262144, 'qwen/qwen3.5': 262144,
  'qwen/qwen2.5': 131072, 'qwen/qwq': 131072,
  'qwen/qwen3': 131072,
  'moonshotai/kimi': 262144,
  'zai-org/glm-5.1': 198000, 'zai-org/glm-5': 198000,
  'zai-org/glm-4.7': 131072, 'zai-org/glm-4.5': 131072,
  'thudm/glm-4': 131072, 'thudm/glm-4-9b': 131072,
  'minimaxai/minimax': 196608,
  'meta-llama/llama-4': 131072, 'meta-llama/llama-3.1': 131072,
  'meta-llama/llama-3': 8192,
  'internlm/internlm3': 131072, 'internlm/internlm2': 32768,
  '01-ai/yi': 32768,
  'mistralai/mistral-large': 131072, 'mistralai/mistral': 32768,
  'mistralai/mixtral': 32768, 'mistralai/codestral': 32768,
  'google/gemma-3': 131072, 'google/gemma-2': 8192,
  'microsoft/phi-4': 16384, 'microsoft/phi-3': 4096,
  'bytedance-seed/seed': 131072, 'stepfun-ai/step': 131072,
  // ── 开源模型通用 ──
  'mistral-large': 131072, 'mistral': 32768,
  'mixtral': 32768, 'codestral': 32768,
  'phi-4': 16384, 'phi-3': 4096,
  'gemma-3': 131072, 'gemma-2': 8192,
  'yi-34b': 200000, 'yi-1.5': 4096,
  'command-r': 131072, 'command-r-plus': 131072,
  'dbrx': 32768, 'falcon': 8192,
  // ── LM Studio / Ollama 常见本地模型 ──
  'llama-4': 131072, 'llama-3.1': 131072,
  'llama-3': 8192, 'llama-2': 4096,
  'hermes': 131072, 'nous': 32768,
  'dolphin': 16384, 'wizardlm': 4096,
}
