// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/browserSearch.test.ts — 内置浏览器地址栏：默认 Bing 搜索
// ============================================================

import { describe, it, expect } from 'vitest'
import { resolveAddressInput, buildSearchUrl, normalizeUrl, SEARCH_ENGINE } from '../electron/browser/browserUrl'

describe('resolveAddressInput', () => {
  it('裸域名 → 补 https', () => {
    expect(resolveAddressInput('example.com')).toBe('https://example.com')
    expect(resolveAddressInput('github.com/user/repo')).toBe('https://github.com/user/repo')
  })

  it('localhost / host:port → 补 https（不当搜索词）', () => {
    expect(resolveAddressInput('localhost:3000')).toBe('https://localhost:3000')
    expect(resolveAddressInput('192.168.1.1:8080')).toBe('https://192.168.1.1:8080')
  })

  it('显式 http(s) 协议 → 原样保留', () => {
    expect(resolveAddressInput('https://a.com/x')).toBe('https://a.com/x')
    expect(resolveAddressInput('http://a.com')).toBe('http://a.com')
  })

  it('危险协议 → 空白页', () => {
    expect(resolveAddressInput('javascript:alert(1)')).toBe('about:blank')
    expect(resolveAddressInput('data:text/html,x')).toBe('about:blank')
  })

  it('空输入 → about:blank', () => {
    expect(resolveAddressInput('')).toBe('about:blank')
    expect(resolveAddressInput('   ')).toBe('about:blank')
  })

  it('普通文字 / 中文 / 带空格 → 走 Bing 搜索', () => {
    expect(resolveAddressInput('天气')).toBe('https://www.bing.com/search?q=%E5%A4%A9%E6%B0%94')
    expect(resolveAddressInput('hello world')).toBe('https://www.bing.com/search?q=hello%20world')
    expect(resolveAddressInput('vitest 用法')).toContain('bing.com/search?q=')
  })

  it('查询词被正确 URL 编码（防注入）', () => {
    expect(resolveAddressInput('a&b=c')).toBe('https://www.bing.com/search?q=a%26b%3Dc')
  })
})

describe('buildSearchUrl / SEARCH_ENGINE', () => {
  it('默认搜索引擎是 Bing', () => {
    expect(SEARCH_ENGINE.id).toBe('bing')
    expect(SEARCH_ENGINE.urlTemplate).toContain('bing.com')
  })
  it('buildSearchUrl 替换 {q} 并编码', () => {
    expect(buildSearchUrl('你好')).toBe('https://www.bing.com/search?q=%E4%BD%A0%E5%A5%BD')
  })
})

describe('normalizeUrl 保持原行为（不引入搜索）', () => {
  it('仍只做补全，不做搜索', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com')
    expect(normalizeUrl('天气')).toBe('https://天气')  // 旧行为：不搜，仅补协议
  })
})
