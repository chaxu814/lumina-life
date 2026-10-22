// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ═══════════════════════════════════════════════════════════
// thinkingSanitizer.ts — 思考过程文本清洗
//
// 背景（2026-10-04）
//
// 后端把模型的 reasoning_content 原样回传并直接渲染到「思考过程」面板。
// 推理型模型即使拿到全中文的 system prompt，仍有两个习惯：
//
//   1. 整段用英文推理
//      "I am continuing the conversation. Lumina has just introduced..."
//
//   2. 开头先花一堆篇幅做「身份元推理」
//      "But wait - I need to figure out who I am responding as.
//       Looking at the context, there are three characters..."
//
// 这两类内容会直接糊在用户界面上，看起来像程序 malfunction 了。
//
// 提示词侧（electron/prompts/systemPrompt.ts）已经要求「全程中文思考、
// 不纠结身份」，治本；这里是渲染侧兜底 —— 模型不一定听话。
//
// 设计取舍：
//   · 只删「纯元推理」的整行，不做逐句改写，避免把有用内容改坏。
//   · 整段是英文时**标注出来**而不是静默丢弃 —— 用户有权知道模型用什么语言推理的。
//   · 流式分片不能逐块清洗（行会被截断），所以只在渲染时对「已累积的完整文本」做，
//     收口点选在 ThinkingStepList，一处覆盖流式显示 / 历史回放 / 全部 4 个累积入口。
// ═══════════════════════════════════════════════════════════

/**
 * 身份元推理：整行只是在搞清「我是谁 / 我该回谁 / 我在哪个模式」。
 * 命中即丢弃该行 —— 这类内容对用户零价值。
 */
const META_REASONING_PATTERNS: RegExp[] = [
  // "But wait, I need to figure out who I am responding as..."
  /^\s*(but\s+)?wait[,.!?\-—]?\s*(i\s+)?(need|should|want)\s+to\s+(figure|think|determine|decide|consider)\s+(out\s+)?(who|which|what)\b/i,
  // "I need to figure out who I am..."
  /^\s*i\s+(need|should|have)\s+to\s+(figure|determine|decide|consider)\s+(out\s+)?(who|which|what)\b/i,
  // "Since I'm in group chat mode, I can respond directly."
  /^\s*(since|as)\s+i'?m?\s+(in|part of)\s+(this\s+)?(the\s+)?(group|multi)\s*chat\b/i,
  // "Let me just respond warmly to Lumina's introduction..."
  /^\s*(let\s+me|i'?ll|i\s+will)\s+(just\s+)?(respond|reply|answer)\s+(naturally|warmly|as\s+)/i,
  // "I should respond naturally as part of this group chat. Since I'm 热茶, ..."
  //   真实样本里这句和后面两句挤在同一行（一句三段），开头锚定后整行都该丢。
  /^\s*i\s+should\s+(respond|reply|answer|stay in character)\s+(naturally|warmly|as\s+)/i,
  // "Since I'm 热茶, I should stay in character but also be friendly."
  /^\s*since\s+i'?m\s+\S+,\s*i\s+should\s+stay in character/i,
  // "My role is X" / "As the reviewer, ..." 这类角色自述开头
  /^\s*(my\s+role\s+is|i\s+am\s+(the\s+)?(reviewer|analyst|engineer|assistant))\b/i,
]

/** 中文字符占比（用于判断「这段是不是全英文」） */
export function cjkRatio(text: string): number {
  const cjk = (text.match(/[一-龥]/g) || []).length
  const letters = (text.match(/[A-Za-z]/g) || []).length
  const total = cjk + letters
  return total === 0 ? 1 : cjk / total
}

export interface SanitizedThinking {
  /** 清洗后的文本；整段都是元推理时为空串 */
  text: string
  /** 中文字符占比 < 0.2 —— 判定为「模型用非中文推理」 */
  foreignLang: boolean
  /** 被丢掉多少行（用于调试/测试，不上界面） */
  droppedLines: number
}

export function sanitizeThinkingText(raw: string | undefined | null): SanitizedThinking {
  if (!raw || !raw.trim()) {
    return { text: '', foreignLang: false, droppedLines: 0 }
  }

  let dropped = 0
  const kept = raw
    .split(/\r?\n+/)
    .filter((line) => {
      const bare = line.trim().replace(/^[>*-]\s+/, '')
      if (!bare) {return false}
      if (META_REASONING_PATTERNS.some((re) => re.test(bare))) {
        dropped++
        return false
      }
      return true
    })
    .join('\n')
    .trim()

  return {
    text: kept,
    foreignLang: cjkRatio(kept) < 0.2,
    droppedLines: dropped,
  }
}
