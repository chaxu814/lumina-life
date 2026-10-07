// ============================================================
// tests/rssParserClean.test.ts — RSS/Atom 文本清洗
//
// 【背景】
// 用户邮件里看到的标题长这样：
//   [[CDATA[The AirPods Pro 3 are a fantastic deal at $179]]] ** _The Verge_ …
// 根因是 v1.0 的 parseAtom 漏了 extractCData —— parseRSS 调了，parseAtom 没调。
// The Verge 这类 Atom 源的 <title type="html"><![CDATA[…]]></title> 于是
// 把 CDATA 包裹原样带了出来，混进邮件正文、混进去重指纹。
//
// 这个文件钉住 cleanFeedText 的行为，包括「已损坏成 [[CDATA[…]]]」的兜底。
// ============================================================

import { describe, it, expect, vi } from 'vitest'

// newsDigest / rssParser 的依赖链会摸到 electron，测试里先掐掉
vi.mock('electron', () => ({
  app: { getPath: () => require('os').tmpdir() },
}))

import { cleanFeedText } from '../electron/tools/impl/rssParser'

describe('cleanFeedText', () => {
  it('剥掉标准 CDATA 包裹', () => {
    expect(cleanFeedText('<![CDATA[The AirPods Pro 3 are a fantastic deal at $179]]>'))
      .toBe('The AirPods Pro 3 are a fantastic deal at $179')
  })

  it('剥掉已经损坏成 [[CDATA[…]]] 的残留（用户实际遇到的形态）', () => {
    expect(cleanFeedText('[[CDATA[The AirPods Pro 3 are a fantastic deal at $179]]]'))
      .toBe('The AirPods Pro 3 are a fantastic deal at $179')
  })

  it('去掉残留 HTML 标签', () => {
    expect(cleanFeedText('<b>Apple</b> ships <i>something</i> new')).toBe('Apple ships something new')
  })

  it('解码 HTML 实体（含数字与命名）', () => {
    // 用 \u 转义写期望值：本仓 Windows 控制台是 GBK，直写弯引号会被显示层弄花，
    // 断言失败时看不出到底差哪个码位。
    // &#8216; = U+2018 ‘，&#x2019; = U+2019 ’
    expect(cleanFeedText('GPT&#8216;s turn &amp; OpenAI&#x2019;s'))
      .toBe('GPT\u2018s turn & OpenAI\u2019s')
    expect(cleanFeedText('a &hellip; b &mdash; c')).toBe('a \u2026 b \u2014 c')
  })

  it('<br> 变成空格而不是粘连', () => {
    expect(cleanFeedText('line1<br/>line2<br>line3')).toBe('line1 line2 line3')
  })

  it('折叠多余空白', () => {
    expect(cleanFeedText('  a \n\t b   c  ')).toBe('a b c')
  })

  it('超长截断并加省略号', () => {
    const out = cleanFeedText('x'.repeat(500), 50)
    expect(out).toHaveLength(50)
    expect(out.endsWith('\u2026')).toBe(true)
  })

  it('空输入返回空串，不返回 undefined', () => {
    expect(cleanFeedText('')).toBe('')
  })

  it('CDATA + 实体 + 标签混合的终极形态也能清干净', () => {
    const raw = '[[CDATA[<p>OpenAI&#8217;s <b>GPT</b> is here &amp; it&#x2019;s fast</p>]]]'
    expect(cleanFeedText(raw)).toBe("OpenAI\u2019s GPT is here & it\u2019s fast")
  })
})
