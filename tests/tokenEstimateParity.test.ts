// ============================================================
// tokenEstimateParity.test.ts — 前端/主进程 token 估算一致性（P1-5）
//
// 【背景】
//   历史预算此前用 `text.length / 4` 估算。中文约 1–1.5 字符/token，
//   `/4` 低估 2.5–3 倍 → 中文群聊实际塞进模型的 token 可达预算的 2–3 倍
//   → 超窗、prefill 卡顿、回复断续。
//   项目里当时并存三套系数：`/4`（前端）、`/3.5`（agentRunner）、
//   `TokenEstimator`（CJK 1.5 / 英文 4 加权）。
//
// 【本文件守住两条】
//   ① `src/lib/tokenEstimate.ts` 的 estimateTokens 与主进程
//      `electron/tokenEstimator.ts` 的 TokenEstimator.estimate **逐样本一致**
//      （防止将来再次漂移成两套系数）；
//   ② 中文样本的估算必须显著高于旧的 `/4`（证明低估问题真的被修掉）。
// ============================================================

import { describe, it, expect } from 'vitest'
import { estimateTokens } from '../src/lib/tokenEstimate'
import { TokenEstimator } from '../electron/tokenEstimator'

const SAMPLES = [
  '你好',
  '帮我看看这个报错',
  '请解释一下这段代码为什么会死循环，我想知道根本原因是什么。',
  'Hello world',
  'The quick brown fox jumps over the lazy dog.',
  '中英混排 mixed content 12345 —— 这是测试',
  '',
  'a',
  '。',
  '🚀🎉',
  '这是一段比较长的中文文本，用来验证估算器在不同长度下的表现是否一致，'
    + '包括标点符号、数字 1234567890 和英文 words 混在一起的情况。',
]

describe('estimateTokens ≡ TokenEstimator.estimate（跨进程系数一致）', () => {
  const est = new TokenEstimator()

  for (const s of SAMPLES) {
    it(`样本一致: ${JSON.stringify(s.slice(0, 24))}${s.length > 24 ? '…' : ''}`, () => {
      expect(estimateTokens(s)).toBe(est.estimate(s))
    })
  }

  it('空串/null/undefined 都返回 0', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens(null)).toBe(0)
    expect(estimateTokens(undefined)).toBe(0)
  })
})

describe('中文不再被低估（对照旧的 /4 估算）', () => {
  const CN = '请帮我把这段中文翻译成英文，注意保持语气和术语的准确性。'

  it('中文估算显著高于 length/4', () => {
    const oldEstimate = Math.ceil(CN.length / 4)
    const newEstimate = estimateTokens(CN)
    // 中文约 1.5 字符/token；/4 会低估到一半以下
    expect(newEstimate).toBeGreaterThan(oldEstimate * 1.8)
  })

  it('同样长度下，中文估算 > 英文估算', () => {
    const cn = '中'.repeat(30)
    const en = 'a'.repeat(30)
    expect(cn.length).toBe(en.length)
    expect(estimateTokens(cn)).toBeGreaterThan(estimateTokens(en))
  })
})
