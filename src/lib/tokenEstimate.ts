// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// lib/tokenEstimate.ts — 前端侧的 Token 估算（与主进程同一套系数）
//
// 【为什么需要它】
//   历史预算此前用 `text.length / 4` 估算。中文约 1–1.5 字符/token，
//   `/4` 会**低估 2.5–3 倍** → 中文群聊实际塞进模型的 token 可达预算的 2–3 倍
//   → 超窗、prefill 卡顿、回复断续。
//
//   项目里当时并存三套系数：`/4`（前端）、`/3.5`（agentRunner）、
//   `TokenEstimator`（CJK 1.5 / 英文 4 加权）。本文件对齐**主进程的
//   `electron/tokenEstimator.ts`**，并由 `tests/tokenEstimateParity.test.ts`
//   断言两者在样本集上结果一致 —— 防止将来再次漂移。
//
// 【为什么不在前端直接 import 主进程模块】
//   渲染进程的构建目标是浏览器，直接引 electron/ 下的模块有打包风险。
//   这里做一份等价实现 + 一致性测试，等价性由测试守。
// ============================================================

/** 中文（CJK 统一表意文字 + 扩展 A）字符占比加权后的平均「字符/token」 */
const CJK_CHARS_PER_TOKEN = 1.5
const LATIN_CHARS_PER_TOKEN = 4

/** 估算一段文本的 token 数（与 electron/tokenEstimator.ts 的 TokenEstimator.estimate 等价） */
export function estimateTokens(text: string | null | undefined): number {
  if (!text) {return 0}
  const chars = text.length
  if (chars === 0) {return 0}
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length
  const cjkRatio = cjkCount / chars
  const avgCharsPerToken = cjkRatio * CJK_CHARS_PER_TOKEN + (1 - cjkRatio) * LATIN_CHARS_PER_TOKEN
  return Math.ceil(chars / avgCharsPerToken)
}
