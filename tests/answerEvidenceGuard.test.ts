// ============================================================
// tests/answerEvidenceGuard.test.ts
//
// 【这是行为级验证】直接把 2026-10-11 截图里的真实故障喂进去，
//   证明「代码层兜底」确实能拦住"查不到就编"。
//
//   故障原文（Yak 的回答）：
//     「使命召唤 23（Call of Duty: Modern III）是 2010 年发布的，
//       发行日期是 **2010 年 11 月 9 日**。」
//   —— 产品名是编的、日期也是错的，用户无从察觉。
// ============================================================

import { describe, it, expect } from 'vitest'
import {
  assessQuestionEvidenceNeed,
  containsSpecificClaims,
  decideEvidenceGuard,
  applyEvidenceGuard,
  UNVERIFIED_WARNING,
} from '../electron/agent/answerEvidenceGuard'

describe('★ 回归场景：截图里那次幻觉必须被兜住', () => {
  const question = '使命召唤 23 的发布日期是什么时候？'
  const hallucinatedAnswer =
    '根据我现有的知识，使命召唤 23（Call of Duty: Modern III）是 2010 年发布的，发行日期是 2010 年 11 月 9 日。'

  it('该问题被识别为「需要外部证据」', () => {
    expect(assessQuestionEvidenceNeed(question).needsEvidence).toBe(true)
  })

  it('该答案被识别为「含具体事实断言」', () => {
    expect(containsSpecificClaims(hallucinatedAnswer)).toBe(true)
  })

  it('检索未成功时 → 介入并加"未经核实"警示', () => {
    const d = decideEvidenceGuard({
      question,
      retrievalAttempted: true,
      retrievalSucceeded: false,
      answer: hallucinatedAnswer,
    })
    expect(d.intervene).toBe(true)
    expect(d.warning).toBe(UNVERIFIED_WARNING)
  })

  it('应用后：警示在答案最前面，答案原文一字不改', () => {
    const out = applyEvidenceGuard({
      question,
      retrievalAttempted: true,
      retrievalSucceeded: false,
      answer: hallucinatedAnswer,
    })
    expect(out.startsWith('⚠️')).toBe(true)
    expect(out).toContain(hallucinatedAnswer)
  })

  it('若真的检索成功 → 不介入（有证据就不需要免责）', () => {
    const d = decideEvidenceGuard({
      question,
      retrievalAttempted: true,
      retrievalSucceeded: true,
      answer: hallucinatedAnswer,
    })
    expect(d.intervene).toBe(false)
  })
})

describe('不该误伤的（避免给正常回答乱加警示）', () => {
  it('本地任务（写代码）不介入', () => {
    const q = '帮我写一个 Python 爬虫脚本'
    expect(assessQuestionEvidenceNeed(q).needsEvidence).toBe(false)
  })

  it('翻译 / 润色 / 算题不介入', () => {
    expect(assessQuestionEvidenceNeed('把这段话翻译成英文').needsEvidence).toBe(false)
    expect(assessQuestionEvidenceNeed('帮我润色一下这段文字').needsEvidence).toBe(false)
    expect(assessQuestionEvidenceNeed('算一下 1234 × 5678 等于多少').needsEvidence).toBe(false)
  })

  it('闲聊不介入', () => {
    expect(assessQuestionEvidenceNeed('你好呀').needsEvidence).toBe(false)
    expect(assessQuestionEvidenceNeed('谢谢你').needsEvidence).toBe(false)
  })

  it('问题不需要证据时，即使答案有具体数字也不介入', () => {
    const d = decideEvidenceGuard({
      question: '帮我写个脚本',
      retrievalAttempted: false,
      retrievalSucceeded: false,
      answer: '这是脚本，需要 Node 18 以上版本，跑 3 次即可。',
    })
    expect(d.intervene).toBe(false)
  })

  it('答案没有具体断言时不介入（只是闲聊式回答）', () => {
    const d = decideEvidenceGuard({
      question: '使命召唤 23 的发布日期是什么时候？',
      retrievalAttempted: true,
      retrievalSucceeded: false,
      answer: '我这边现在查不到这条信息，建议以官方公告为准。',
    })
    expect(d.intervene).toBe(false)
  })

  it('答案是空的 → 不介入（交给上层兜底流程）', () => {
    const d = decideEvidenceGuard({
      question: '最新 iPhone 价格',
      retrievalAttempted: false,
      retrievalSucceeded: false,
      answer: '',
    })
    expect(d.intervene).toBe(false)
  })
})

describe('问题识别信号', () => {
  it('实时/会变的信息 → 需要证据', () => {
    for (const q of [
      '最新的 iPhone 是哪一款',
      '今年 A 股涨了多少',
      '现在美元汇率是多少',
      '这个项目的 GitHub 星标数排名',
      '使命召唤新作什么时候发布',
    ]) {
      expect(assessQuestionEvidenceNeed(q).needsEvidence, q).toBe(true)
    }
  })

  it('给出可读的原因', () => {
    const v = assessQuestionEvidenceNeed('最新价格是多少')
    expect(v.reasons.length).toBeGreaterThan(0)
    expect(v.reasons.join(',')).toMatch(/实时信息|需查证/)
  })

  it('空输入不误报', () => {
    expect(assessQuestionEvidenceNeed('').needsEvidence).toBe(false)
    expect(assessQuestionEvidenceNeed(null as never).needsEvidence).toBe(false)
  })
})

describe('具体断言识别', () => {
  it('年份 / 完整日期 / 月日 / 版本号 / 价格 / 规模数字都能识别', () => {
    for (const a of [
      '2010 年发布的',
      '发行日期是 2010-11-09',
      '定在 11 月 9 日',
      '需要 v2.1.3 以上',
      '售价 ¥4999',
      '销量约 3.2 亿台',
    ]) {
      expect(containsSpecificClaims(a), a).toBe(true)
    }
  })

  it('纯文字回答不含断言', () => {
    expect(containsSpecificClaims('我建议你先看看官方文档。')).toBe(false)
    expect(containsSpecificClaims('')).toBe(false)
  })
})

describe('决策原因可读（便于排查为什么介入/没介入）', () => {
  it('介入时给出完整原因链', () => {
    const d = decideEvidenceGuard({
      question: '最新 iPhone 价格',
      retrievalAttempted: true,
      retrievalSucceeded: false,
      answer: '售价 ¥5999。',
    })
    expect(d.intervene).toBe(true)
    expect(d.reasons.join(',')).toMatch(/实时信息|需查证/)
    expect(d.reasons.join(',')).toContain('检索未取得有效结果')
    expect(d.reasons.join(',')).toContain('答案含具体事实断言')
  })

  it('未介入时也说明原因', () => {
    const d = decideEvidenceGuard({
      question: '写个函数',
      retrievalAttempted: false,
      retrievalSucceeded: false,
      answer: '好的。',
    })
    expect(d.intervene).toBe(false)
    expect(d.reasons.length).toBeGreaterThan(0)
  })
})
