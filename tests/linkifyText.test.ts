// ============================================================
// tests/linkifyText.test.ts
//
// 覆盖两块可测纯逻辑（均在 src/utils/linkifyText.ts，无 Electron/React 依赖）：
//   1. linkify：把回复正文里的 http/https（含 www.）解析成可点击 token，
//      只放行 http/https，拒绝 javascript:/data:，剥掉尾随标点且不丢原文。
//   2. shouldAutoOpen / pickPrimaryUrl：自动打开浏览器的判定与「打开哪个 URL」。
// ============================================================

import { describe, it, expect } from 'vitest'
import { linkify, pickPrimaryUrl, shouldAutoOpen } from '../src/utils/linkifyText'

describe('linkifyText: URL 链接化解析', () => {
  it('纯文本无链接 → 单个 text token', () => {
    const r = linkify('你好，今天天气不错')
    expect(r).toHaveLength(1)
    expect(r[0]).toEqual({ type: 'text', text: '你好，今天天气不错' })
  })

  it('http:// 链接被识别为 link token', () => {
    const r = linkify('看这个 http://example.com 详情')
    expect(r.map((t) => t.type)).toEqual(['text', 'link', 'text'])
    expect(r[1]).toMatchObject({
      type: 'link', text: 'http://example.com', href: 'http://example.com',
    })
  })

  it('https:// 链接（含路径/查询串）href 原样保留', () => {
    const r = linkify('https://example.com/a/b?x=1&y=2')
    expect(r).toHaveLength(1)
    expect(r[0].href).toBe('https://example.com/a/b?x=1&y=2')
  })

  it('www. 裸域名补成 https://', () => {
    const r = linkify('去 www.example.com 看看')
    expect(r[1]).toMatchObject({ text: 'www.example.com', href: 'https://www.example.com' })
  })

  it('英文句尾句点不进链接，且回流为文本不丢失', () => {
    const r = linkify('打开 https://example.com. 结束')
    const link = r.find((t) => t.type === 'link')!
    expect(link.href).toBe('https://example.com')
    expect(r.map((t) => t.text).join('')).toBe('打开 https://example.com. 结束')
  })

  it('中文逗号/句号从链接尾部剥掉，但仍保留在文本里', () => {
    const r = linkify('详见 https://example.com，以及 https://a.com。')
    expect(r[1].href).toBe('https://example.com')
    expect(r[3].href).toBe('https://a.com')
    expect(r.map((t) => t.text).join('')).toBe('详见 https://example.com，以及 https://a.com。')
  })

  it('成对括号里的 URL（维基百科式）保留尾随 )', () => {
    const r = linkify('参考 https://zh.wikipedia.org/wiki/Foo_(bar) 条目')
    const link = r.find((t) => t.type === 'link')!
    expect(link.href).toBe('https://zh.wikipedia.org/wiki/Foo_(bar)')
  })

  it('不成对的尾随 ) 当作标点剥掉', () => {
    const r = linkify('(见 https://example.com)')
    const link = r.find((t) => t.type === 'link')!
    expect(link.href).toBe('https://example.com')
    expect(r.map((t) => t.text).join('')).toBe('(见 https://example.com)')
  })

  it('javascript: 不被链接', () => {
    const r = linkify('点击 javascript:alert(1) 这里')
    expect(r.some((t) => t.type === 'link')).toBe(false)
    expect(r.map((t) => t.text).join('')).toContain('javascript:alert(1)')
  })

  it('data: 不被链接', () => {
    const r = linkify('data:text/html,<b>x</b>')
    expect(r.some((t) => t.type === 'link')).toBe(false)
  })

  it('保留换行（交由外层 pre-wrap 渲染）', () => {
    const r = linkify('第一行\n第二行 https://example.com\n第三行')
    expect(r.map((t) => t.text).join('')).toBe('第一行\n第二行 https://example.com\n第三行')
  })

  it('空字符串 / null 安全返回空数组，不抛错', () => {
    expect(linkify('')).toEqual([])
    expect(linkify(null as any)).toEqual([])
    expect(linkify(undefined as any)).toEqual([])
  })
})

describe('pickPrimaryUrl: 取回复里的主要 URL', () => {
  it('返回第一个 http/https 链接', () => {
    expect(pickPrimaryUrl('先看 https://a.com 再看 https://b.com')).toBe('https://a.com')
  })
  it('没有链接返回 null', () => {
    expect(pickPrimaryUrl('这里没有任何链接')).toBeNull()
  })
  it('www. 链接也能取到（补成 https）', () => {
    expect(pickPrimaryUrl('见 www.example.com/x')).toBe('https://www.example.com/x')
  })
})

describe('shouldAutoOpen: 自动打开判定（默认关）', () => {
  it('开关关闭 → 即使有链接也返回 null（绝不弹窗）', () => {
    expect(shouldAutoOpen('看看 https://example.com', false)).toBeNull()
    expect(shouldAutoOpen('看看 https://example.com', undefined as any)).toBeNull()
  })
  it('开关开启且有链接 → 返回该 URL 供 openBrowser', () => {
    expect(shouldAutoOpen('结果见 https://example.com/result', true))
      .toBe('https://example.com/result')
  })
  it('开关开启但回复里没有链接 → null', () => {
    expect(shouldAutoOpen('这是一条纯文本回复', true)).toBeNull()
  })
})
