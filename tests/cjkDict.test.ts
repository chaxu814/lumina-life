// ============================================================
// tests/cjkDict.test.ts
//
// 【要防的问题】
//   中文词表分词增强必须是**严格增量**：加了词表后，召回只增不减。
//   若不小心把 unigram/bigram 换掉，会造成既有召回能力回退 —— 那是负优化。
//   本测试同时锁「词表命中」与「原有 unigram/bigram 仍在」。
// ============================================================

import { describe, it, expect } from 'vitest'
import { dictMatch, dictSize } from '../electron/memory/cjkDict'
import { tokenize, setCjkDictEnabled } from '../electron/memory/layeredMemory'

describe('cjkDict 最长匹配', () => {
  it('命中常用词并跳过已匹配长度', () => {
    const t = dictMatch('苹果手机')
    expect(t).toContain('手机')
    // 命中「手机」后不应再产出重叠的「手」「机」单字
    expect(t).not.toContain('手')
  })

  it('优先长词（人工智能 > 人工）', () => {
    const t = dictMatch('人工智能')
    expect(t).toContain('人工智能')
    expect(t).not.toContain('人工')
  })

  it('未命中词表的句子返回空（不误伤）', () => {
    expect(dictMatch('魑魅魍魉')).toEqual([])
  })

  it('词表有规模但不臃肿', () => {
    expect(dictSize()).toBeGreaterThan(100)
    expect(dictSize()).toBeLessThan(1000)
  })
})

describe('tokenize 是严格增量（不会降低召回）', () => {
  it('开启词表后仍保留 unigram + bigram', () => {
    setCjkDictEnabled(true)
    const toks = tokenize('苹果手机')
    // unigram
    expect(toks).toContain('苹')
    expect(toks).toContain('果')
    // bigram
    expect(toks).toContain('苹果')
    // 词表补充
    expect(toks).toContain('手机')
  })

  it('关闭词表后回到纯 unigram+bigram（不含完整词）', () => {
    setCjkDictEnabled(false)
    const toks = tokenize('计算机')
    // unigram + bigram 都在
    expect(toks).toContain('计')
    expect(toks).toContain('计算')
    // 但 3 字完整词「计算机」只有词表能给出 —— 关闭后不应存在
    expect(toks).not.toContain('计算机')
    setCjkDictEnabled(true) // 复原，避免影响其它用例
  })

  it('拉丁词不受影响', () => {
    setCjkDictEnabled(true)
    expect(tokenize('hello world 123')).toEqual(['hello', 'world', '123'])
  })
})
