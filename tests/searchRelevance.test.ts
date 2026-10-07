// ============================================================
// tests/searchRelevance.test.ts
//
// 【要防的真实故障】2026-10-07：用户搜「美股 宏观 消息 2026年10月7日 美联储」，
//   BING 返回的第一条是「美（汉语文字）_百度百科 —— 美（拼音：měi）为汉语
//   一级通用字」。它长度 > 20、不含任何错误串，于是通过了 isValidResult()
//   的全部检查，被当成「有效结果」返回并写进缓存 —— **回退链根本没触发**。
//
// 根因：有效性判定只看「有没有内容」，从不看「和查询有没有关系」。
// 本测试锁住相关性过滤与词典条目识别。
// ============================================================

import { describe, it, expect } from 'vitest'
import { relevanceTokens, countOverlap, isDictionaryEntry } from '../electron/tools/impl/search'

describe('isDictionaryEntry — 识别词典/百科单字条目', () => {
  it('识别「美（汉语文字）_百度百科」这类条目', () => {
    expect(isDictionaryEntry('美（汉语文字）_百度百科')).toBe(true)
  })

  it('识别「美（拼音：měi）_百度百科」', () => {
    expect(isDictionaryEntry('美（拼音：měi）_百度百科')).toBe(true)
  })

  it('识别纯单字 + 百科来源', () => {
    expect(isDictionaryEntry('好_百度百科')).toBe(true)
  })

  it('正常搜索结果不误伤', () => {
    expect(isDictionaryEntry('美股行情_新浪财经')).toBe(false)
    expect(isDictionaryEntry('美联储9月会议纪要解读 - 华尔街见闻')).toBe(false)
    expect(isDictionaryEntry('2026年10月美股宏观展望')).toBe(false)
  })
})

describe('relevanceTokens — CJK 2-gram + 字母词', () => {
  it('中文切成 2-gram', () => {
    const t = relevanceTokens('美股宏观')
    expect(t.has('美股')).toBe(true)
    expect(t.has('股宏')).toBe(true)
    expect(t.has('宏观')).toBe(true)
  })

  it('字母词保留、年份级纯数字不制造假相关', () => {
    const t = relevanceTokens('GPT 发布 2026')
    expect(t.has('gpt')).toBe(true)
    // 「2026」是 4 位数字，属于年份噪声 —— 不作为 token
    expect(t.has('2026')).toBe(false)
  })
})

describe('相关性判定 — 复现并锁住 2026-10-07 的故障', () => {
  const QUERY = '美股 宏观 消息 2026年10月7日 美联储'

  it('垃圾结果（单字词典）与查询零重叠', () => {
    const q = relevanceTokens(QUERY)
    const junk = relevanceTokens('美（汉语文字）_百度百科 美（拼音：měi）为汉语一级通用字')
    expect(countOverlap(q, junk)).toBe(0)
  })

  it('真实结果与查询有重叠', () => {
    const q = relevanceTokens(QUERY)
    const real = relevanceTokens('美股宏观消息汇总_新浪财经 美联储最新表态')
    expect(countOverlap(q, real)).toBeGreaterThan(0)
  })

  it('「美联储」这种长词即使被切成 2-gram 仍能命中', () => {
    const q = relevanceTokens('美联储降息')
    const real = relevanceTokens('美联储宣布降息 25 个基点')
    expect(countOverlap(q, real)).toBeGreaterThan(0)
  })
})
