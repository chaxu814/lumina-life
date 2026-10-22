// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/htmlToTextCjk.test.ts
//
// 【要防的真实故障】2026-10-12：用户搜「尼古喵喵」，搜索结果里显示的是
//   「【官方中字】迷你 尼 古喵喵 第1集」—— 中文词被**空格切开**。
//
// 根因：搜索引擎把命中词高亮成 `<strong>尼古喵喵</strong>`（Bing 还会按自己的
//   分词切成多个 strong），而 stripHtml 把**所有**标签一律替换成空格：
//     `迷你<strong>尼古喵喵</strong>第1集` → `迷你 尼 古喵喵 第1集`
//   后果有两个：
//     ① 用户/模型看到的中文是碎的，难读；
//     ② 相关性匹配被削弱 —— `尼古` 这个 2-gram 直接消失，
//        只剩 `古喵`/`喵喵` 能命中（本次故障里恰好靠这两个才没漏掉 B 站结果）。
//
// 修法：内联格式标签在**两侧都是中日韩文字**时直接删除（不留空格）；
//   其余情况（英文相邻、块级标签）仍替换成空格 —— 保持原有行为。
// ============================================================

import { describe, it, expect } from 'vitest'
import zlib from 'zlib'
import { stripHtml, decodeResponseBody } from '../electron/tools/utils/httpClient'

describe('stripHtml — 中文不再被高亮标签切碎', () => {
  it('内联标签夹在中文之间 → 直接删除，不留空格', () => {
    expect(stripHtml('迷你<strong>尼古喵喵</strong>第1集')).toBe('迷你尼古喵喵第1集')
  })

  it('Bing 按分词给出多个 strong 也不会切碎', () => {
    expect(stripHtml('迷你<strong>尼</strong><strong>古喵喵</strong>第1集')).toBe('迷你尼古喵喵第1集')
  })

  it('链接标签同理', () => {
    expect(stripHtml('参考<a href="https://x.com">尼古喵喵</a>条目')).toBe('参考尼古喵喵条目')
  })

  it('英文相邻时仍保留空格（否则单词会粘在一起）', () => {
    expect(stripHtml('hello<strong>world</strong>foo')).toBe('hello world foo')
  })

  it('块级标签仍换成空格（否则段落会被粘成一坨）', () => {
    expect(stripHtml('<p>第一段</p><p>第二段</p>')).toBe('第一段 第二段')
    expect(stripHtml('第一行<br>第二行')).toBe('第一行 第二行')
  })

  it('script / style 内容仍被整体丢弃', () => {
    expect(stripHtml('<script>var a=1</script>正文')).toBe('正文')
    expect(stripHtml('<style>.a{}</style>正文')).toBe('正文')
  })

  it('实体解码不受影响', () => {
    expect(stripHtml('A&amp;B')).toBe('A&B')
    expect(stripHtml('x&nbsp;y')).toBe('x y')
  })
})

// ============================================================
// 2026-10-12 故障：抓网页抓到的是**压缩字节的乱码**
//
// 实证：自动抓取 bilibili 页面时，「网页正文」段是这样的：
//   `📄 ****` + `�y��6���S�6T�K�L-)���R…`
// 根因：httpClient 完全没有解压逻辑，把 gzip 字节当 UTF-8 文本拼接。
//   后果：模型吃到 2000 字乱码（比"没抓到"更糟），web_fetch 也整体失效。
// ============================================================
describe('decodeResponseBody — 解压 gzip / deflate / brotli', () => {
  const text = '尼古喵喵 是一部日本 TV 动画，全 12 集。'

  it('gzip', () => {
    expect(decodeResponseBody(zlib.gzipSync(Buffer.from(text)), 'gzip')).toBe(text)
  })

  it('deflate', () => {
    expect(decodeResponseBody(zlib.deflateSync(Buffer.from(text)), 'deflate')).toBe(text)
  })

  it('brotli', () => {
    expect(decodeResponseBody(zlib.brotliCompressSync(Buffer.from(text)), 'br')).toBe(text)
  })

  it('未压缩时原样解码', () => {
    expect(decodeResponseBody(Buffer.from(text), undefined)).toBe(text)
    expect(decodeResponseBody(Buffer.from(text), 'identity')).toBe(text)
  })

  it('头部缺失但内容是 gzip（按魔数兜底）', () => {
    expect(decodeResponseBody(zlib.gzipSync(Buffer.from(text)), undefined)).toBe(text)
  })

  it('解压失败不抛异常，退化为原样解码', () => {
    const junk = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe])
    expect(() => decodeResponseBody(junk, 'gzip')).not.toThrow()
  })
})
