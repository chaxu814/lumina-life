// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tools/impl/reviewVerdict.ts — 审查裁决的结构化解析
//
// 【要修复的缺陷：正则判定会放行有问题的代码】
//
// 原实现是：
//   /✅|通过|批准|认可|没问题|可以合并|同意|LGTM|approved/i.test(rechaResult.content)
//
// 它有两个方向都致命的错误：
//   ① 假阳性（漏检）：审查员写「这里**没问题**，但第 40 行有竞态条件」——
//      「没问题」命中 → 判定通过 → 流水线终止 → 有竞态的代码直接交付给用户。
//   ② 假阴性（误伤）：审查员写「**通过**不了，缺少测试」——
//      「通过」命中 → 判定通过 → 明明该返工却放行。
// 换句话说，这行正则几乎只匹配「语义中立词」，对真实语义**不敏感**。
// 它唯一稳定复现的行为是：只要审查员开口说了中文，就大概率判通过。
//
// 【新方案：结构化标记 + fail-closed】
//
// 沿用项目已有的 [QUESTION]...[/QUESTION] 标记约定（见 delegationManager._parseQuestions），
// 要求审查员在结论末尾输出结构化裁决：
//   [VERDICT:PASS] / [VERDICT:FAIL] / [VERDICT:UNCERTAIN]
//
// 判定规则（**全部 fail-closed**）：
//   · 只有一个标记 → 取它
//   · 同时出现多个且冲突（既有 PASS 又有 FAIL）→ UNCERTAIN
//   · 完全没有标记 → UNCERTAIN
// UNCERTAIN 一律**不算通过**，并作为显式状态上抛给上层，
// 由上层决定是继续迭代还是如实告诉用户「审查未给出明确结论」。
//
// 【为什么不保留正则当兜底】
// 因为正则兜底会把「模型没按格式输出」重新变回「大概率判通过」，
// 恰好复现原缺陷。用「格式没遵守 = 不算通过」把问题暴露出来，
// 开发者才能在日志里看见有多少次裁决是不合规的。
// ============================================================

export type ReviewVerdict = 'pass' | 'fail' | 'uncertain'

/** 标记本身的匹配。宽松匹配大小写与空白，语义判定在下面做。 */
const MARKER_RE = /\[VERDICT\s*[:：]\s*(PASS|FAIL|UNCERTAIN)\s*\]/gi

const TOKEN_TO_VERDICT: Record<string, ReviewVerdict> = {
  PASS: 'pass',
  FAIL: 'fail',
  UNCERTAIN: 'uncertain',
}

export interface ReviewVerdictResult {
  verdict: ReviewVerdict
  /** 是否存在结构化标记（false = 审查员没按格式输出，属于不合规） */
  structured: boolean
  /** 抽出来的原始裁决（去重、保持出现顺序），便于日志排查 */
  found: string[]
  /** 去掉标记后的正文（交给用户看时不带协议噪音） */
  cleanText: string
  /** 给开发者看的人话解释 */
  reason: string
}

/**
 * 解析审查员回复里的结构化裁决。
 *
 * 纯函数，不引 electron、不碰 IO，因此能被单测直接锁住每一档判定。
 */
export function parseReviewVerdict(raw: string): ReviewVerdictResult {
  const text = typeof raw === 'string' ? raw : ''
  const found: string[] = []
  const seen = new Set<string>()

  MARKER_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = MARKER_RE.exec(text)) !== null) {
    const key = m[1].toUpperCase()
    if (!seen.has(key)) { seen.add(key); found.push(key) }
  }

  // 无论是否命中都要把标记从正文里摘掉：
  // 否则这段协议文本会一路流到用户眼前。
  const cleanText = text.replace(MARKER_RE, '').replace(/\n{3,}/g, '\n\n').trim()

  if (found.length === 0) {
    return {
      verdict: 'uncertain',
      structured: false,
      found,
      cleanText,
      reason: '审查回复中没有 [VERDICT:...] 结构化裁决标记 —— 不按 fail-closed 视为未通过',
    }
  }

  if (found.length > 1) {
    // 多个标记：只有「全都相同」才算有效，否则是自相矛盾
    const distinct = new Set(found.map(k => TOKEN_TO_VERDICT[k]))
    if (distinct.size === 1) {
      const only = found[0]
      return {
        verdict: TOKEN_TO_VERDICT[only],
        structured: true,
        found,
        cleanText,
        reason: `审查给出多个一致裁决（${found.join(', ')}）`,
      }
    }
    return {
      verdict: 'uncertain',
      structured: false,
      found,
      cleanText,
      reason: `审查给出相互矛盾的裁决（${found.join(', ')}）—— 视为未通过`,
    }
  }

  const only = found[0]
  return {
    verdict: TOKEN_TO_VERDICT[only],
    structured: true,
    found,
    cleanText,
    reason: `审查裁决：${only}`,
  }
}

/**
 * 要求审查员使用的裁决协议说明。
 *
 * 【为什么要显式写进任务里】
 * 只在 AGENTS.md 里教模型输出格式是不够的：
// delegate_chain 派给审查员的是一个**临时 task 字符串**，
 * 走的是 worker 自己的 system prompt，chain 这边的约定不会自动带过去。
 * 所以必须把协议直接拼进 task，否则模型没有任何理由知道要输出标记。
 */
export const REVIEW_VERDICT_PROTOCOL = `

─────────────────────────────
【审查结论协议（必须遵守）】
读完代码后，你的回复**末尾**必须包含且只包含一个结构化裁决标记：
  [VERDICT:PASS]       —— 代码可以交付，没有任何阻塞问题
  [VERDICT:FAIL]       —— 存在必须修掉的问题（逻辑错误 / 安全漏洞 / 边界崩溃）
  [VERDICT:UNCERTAIN]  —— 信息不足，或你无法判断是否可以交付

要求：
  · 标记必须独占一行，前后不要加别的符号
  · 只输出一个标记。给出多个相互矛盾的标记会被判为 UNCERTAIN（等于没通过）
  · **不要用「没问题」「通过」「可以合并」这类自然语言代替标记** ——
    自然语言会被下游当作「无法判定」，白写一遍。理由请写在标记之前的正文里。
  · 只要你发现了任何一处会导致错误结果的问题，就判 FAIL，不要因为整体看着不错就放行
─────────────────────────────`
