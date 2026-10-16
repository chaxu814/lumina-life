// ============================================================
// tests/reviewVerdict.test.ts — 审查裁决解析
//
// 这个测试存在的理由不是「覆盖率」，而是**钉死一个真实事故**：
// 原实现用 /✅|通过|批准|认可|没问题|可以合并|同意|LGTM|approved/i 判定审查是否通过，
// 于是「这里没问题，但第 40 行有竞态条件」会被判为通过，
// 有竞态的代码直接交付给用户。下面每一个回归用例都对应这一类漏检。
// ============================================================

import { describe, it, expect } from 'vitest'
import { parseReviewVerdict, REVIEW_VERDICT_PROTOCOL } from '../electron/tools/impl/reviewVerdict'

describe('parseReviewVerdict — 正常裁决', () => {

  it('单�� PASS 标记 → pass', () => {
    const r = parseReviewVerdict('整体没问题，边界也处理了。\n\n[VERDICT:PASS]')
    expect(r.verdict).toBe('pass')
    expect(r.structured).toBe(true)
  })

  it('单个 FAIL 标记 → fail', () => {
    const r = parseReviewVerdict('第 40 行有竞态。\n[VERDICT:FAIL]')
    expect(r.verdict).toBe('fail')
  })

  it('显式 UNCERTAIN → uncertain', () => {
    const r = parseReviewVerdict('缺少上下文，判断不了。\n[VERDICT:UNCERTAIN]')
    expect(r.verdict).toBe('uncertain')
  })

  it('大小写与全角冒号都能解析', () => {
    expect(parseReviewVerdict('[verdict:pass]').verdict).toBe('pass')
    expect(parseReviewVerdict('[VERDICT：FAIL]').verdict).toBe('fail')
  })

})

describe('parseReviewVerdict — 回归：原来正则会漏检的输入', () => {

  // ⚠️ 这一组每一条在旧实现下都会返回 true（判定通过）
  const OLD_REGEX = /✅|通过|批准|认可|没问题|可以合并|同意|LGTM|approved/i

  it('「没问题，但第 40 行有竞态」不得判通过', () => {
    const text = '这里没问题，但第 40 行有竞态条件。\n[VERDICT:FAIL]'
    // 先证明旧正则确实会漏检 —— 这才是这个用例的价值所在
    expect(OLD_REGEX.test(text)).toBe(true)
    // 新实现必须拒绝
    expect(parseReviewVerdict(text).verdict).toBe('fail')
  })

  it('「通过不了，缺少测试」不得判通过', () => {
    const text = '这版根本通过不了测试，缺少回归用例。\n[VERDICT:FAIL]'
    expect(OLD_REGEX.test(text)).toBe(true)
    expect(parseReviewVerdict(text).verdict).toBe('fail')
  })

  it('自然语言里提到「同意合并某分支」但裁决是 FAIL 时，取 FAIL', () => {
    const text = '我同意合并策略，但这里的错误处理有 bug。\n[VERDICT:FAIL]'
    expect(OLD_REGEX.test(text)).toBe(true)
    expect(parseReviewVerdict(text).verdict).toBe('fail')
  })

})

describe('parseReviewVerdict — fail-closed', () => {

  it('完全没有标记 → uncertain（不算通过），且 structured=false', () => {
    const r = parseReviewVerdict('看起来还行，建议再测测。')
    expect(r.verdict).toBe('uncertain')
    expect(r.structured).toBe(false)
    expect(r.reason).toContain('fail-closed')
  })

  it('只有一个孤立的括号 → uncertain', () => {
    expect(parseReviewVerdict('[VERDICT:]').verdict).toBe('uncertain')
    expect(parseReviewVerdict('[VERDICT:MAYBE]').verdict).toBe('uncertain')
  })

  it('矛盾裁决（既有 PASS 又有 FAIL）→ uncertain', () => {
    const r = parseReviewVerdict('[VERDICT:PASS]\n[VERDICT:FAIL]')
    expect(r.verdict).toBe('uncertain')
    expect(r.structured).toBe(false)
    expect(r.reason).toContain('矛盾')
  })

  it('多个相同裁决 → 取该裁决，不算矛盾', () => {
    const r = parseReviewVerdict('[VERDICT:FAIL]\n中途想了想，还是不行。\n[VERDICT:FAIL]')
    expect(r.verdict).toBe('fail')
    expect(r.structured).toBe(true)
  })

  it('PASS 与 UNCERTAIN 并存也算矛盾（取更保守）', () => {
    expect(parseReviewVerdict('[VERDICT:PASS][VERDICT:UNCERTAIN]').verdict).toBe('uncertain')
  })

})

describe('parseReviewVerdict — 正文清洗', () => {

  it('标记不会流到用户眼前', () => {
    const r = parseReviewVerdict('结论如上。\n\n[VERDICT:PASS]\n')
    expect(r.cleanText).not.toContain('VERDICT')
    expect(r.cleanText).toContain('结论如上')
  })

  it('纯标记回复清洗后为空串（而不是残留括号）', () => {
    expect(parseReviewVerdict('[VERDICT:PASS]').cleanText).toBe('')
  })

  it('不会留下连续三行以上的空行', () => {
    const r = parseReviewVerdict('说明。\n\n\n\n[VERDICT:FAIL]')
    expect(r.cleanText).not.toMatch(/\n{3,}/)
  })

})

describe('parseReviewVerdict — 健壮性', () => {

  it('空串 / 非字符串不抛异常', () => {
    expect(parseReviewVerdict('').verdict).toBe('uncertain')
    expect(parseReviewVerdict(undefined as unknown as string).verdict).toBe('uncertain')
    expect(parseReviewVerdict(null as unknown as string).verdict).toBe('uncertain')
  })

  it('连续多次调用不因 lastIndex 残留而漏解析（正则 g 标志回归）', () => {
    const text = '[VERDICT:FAIL]'
    for (let i = 0; i < 5; i++) {
      expect(parseReviewVerdict(text).verdict).toBe('fail')
    }
  })

})

describe('REVIEW_VERDICT_PROTOCOL — 协议本身', () => {

  it('明确要求三种标记都写出来', () => {
    expect(REVIEW_VERDICT_PROTOCOL).toContain('[VERDICT:PASS]')
    expect(REVIEW_VERDICT_PROTOCOL).toContain('[VERDICT:FAIL]')
    expect(REVIEW_VERDICT_PROTOCOL).toContain('[VERDICT:UNCERTAIN]')
  })

  it('明确禁止用自然语言代替标记（这正是旧正则漏检的入口）', () => {
    expect(REVIEW_VERDICT_PROTOCOL).toContain('不要用')
  })

})
