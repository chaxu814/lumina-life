// ============================================================
// tests/contentExtractor.test.ts
//
// 【要解决的真实问题】2026-10-12：抓回的网页正文里模板噪音占了大半 ——
//   导航条、弹幕列表、相关推荐、备案号、页脚、客服链接……
//   实测 B 站视频页抓回来 375 字符，真正的信息只有一两句。
//   噪音不只是"看着乱"：它会**挤掉上下文预算**，让模型把注意力
//   花在「沪ICP备2022032900号」这类内容上。
//
// 本测试用**贴近真实站点的 HTML 结构**验证：正文留得住、模板噪音被剔掉。
// ============================================================

import { describe, it, expect } from 'vitest'
import {
  extractMainContent,
  cleanTitle,
  extractSiteName,
  decodeEntities,
  scanHtml,
} from '../electron/tools/utils/contentExtractor'

/** B 站视频页的典型结构：导航 + 标题/简介 + 弹幕/相关推荐 + 备案页脚 */
const BILI_LIKE = `
<html><head>
  <title>【官方中字】迷你尼古喵喵 第1集_哔哩哔哩_bilibili</title>
  <meta property="og:site_name" content="哔哩哔哩">
  <script>var c="/captcha/verify"; if(code===429){}</script>
  <style>.a{color:red}</style>
</head><body>
  <nav class="nav-menu"><a href="/">首页</a><a href="/anime">番剧</a><a href="/live">直播</a><a href="/game">游戏中心</a></nav>
  <header class="top-header"><a href="/v/popular">全站排行榜最高第70名</a></header>
  <div class="video-info">
    <h1 class="video-title">【官方中字】迷你尼古喵喵 第1集</h1>
    <div class="video-desc">迷你尼古喵喵#1 全集已公开，欢迎大家观看并支持Nya～🚬 动画尼古喵喵官方</div>
    <div class="video-stats">126.7万播放 · 350弹幕 · 2026-10-05 21:00:00</div>
  </div>
  <div class="danmaku-list"><span>弹幕列表</span><span>哈哈哈哈</span><span>喵喵喵</span></div>
  <div class="recommend-list">
    <a href="/video/1">【官方中字】尼古喵喵 第2集</a>
    <a href="/video/2">【官方中字】尼古喵喵 第3集</a>
    <a href="/video/3">【官方中字】尼古喵喵 第4集</a>
  </div>
  <div class="comment-area"><div class="comment">这个动画真好看</div></div>
  <footer class="footer">
    <a href="/about">关于我们</a><a href="/contact">联系客服</a><a href="/sitemap">站点地图</a>
    <span>沪公网安备31011802006086号</span><span>增值电信业务经营许可证 沪B2-20250623</span>
    <span>Copyright © 2020-2026 上海喵御宅网络科技有限公司 保留所有权利</span>
  </footer>
</body></html>`

/** 文章页：正文段落 + 侧栏相关阅读 + 页脚 */
const ARTICLE_LIKE = `
<html><head><title>量子纠缠是什么？一篇讲清楚 - 科普中国</title></head><body>
  <div class="site-nav"><a href="/">首页</a><a href="/news">新闻</a><a href="/about">关于</a></div>
  <div class="main-wrap">
    <article class="article-content">
      <h1>量子纠缠是什么？</h1>
      <p>量子纠缠是指两个或多个粒子在相互作用后形成的整体状态。此时单独描述某一个粒子的状态是没有意义的，只能描述整体系统。</p>
      <p>爱因斯坦曾把这种现象称为"幽灵般的超距作用"。后来的实验（如贝尔不等式检验）证实了量子力学的预言，这也成为量子信息科学的基础。</p>
      <p>需要强调的是：纠缠并不能用来超光速传递信息。测量结果的相关性必须通过经典信道比对才能被观察到。</p>
    </article>
    <aside class="sidebar">
      <div class="related"><h3>相关阅读</h3>
        <a href="/a1">什么是量子计算</a><a href="/a2">薛定谔的猫</a><a href="/a3">贝尔不等式</a>
      </div>
    </aside>
  </div>
  <div class="footer-bar">版权所有 © 科普中国 | 京ICP备12345678号</div>
</body></html>`

describe('extractMainContent — 正文留得住，模板噪音被剔掉', () => {
  it('B 站式页面：保住标题与简介，剔掉弹幕/推荐/备案', () => {
    const r = extractMainContent(BILI_LIKE)
    expect(r.text).toContain('迷你尼古喵喵#1')
    expect(r.text).toContain('全集已公开')
    // 模板噪音
    expect(r.text).not.toContain('沪公网安备')
    expect(r.text).not.toContain('增值电信业务')
    expect(r.text).not.toContain('站点地图')
    expect(r.text).not.toContain('弹幕列表')
    expect(r.text).not.toContain('保留所有权利')
    // script/style 内容永远不该出现
    expect(r.text).not.toContain('captcha')
    expect(r.text).not.toContain('color:red')
  })

  it('文章页：正文段落完整保留，侧栏与页脚剔除', () => {
    const r = extractMainContent(ARTICLE_LIKE)
    expect(r.text).toContain('幽灵般的超距作用')
    expect(r.text).toContain('不能用来超光速传递信息')
    expect(r.text).not.toContain('京ICP备')
    expect(r.text).not.toContain('版权所有')
    // 侧栏是纯链接列表，链接密度高 → 落选
    expect(r.text).not.toContain('薛定谔的猫')
  })

  it('提取标题并去掉站点后缀', () => {
    expect(extractMainContent(BILI_LIKE).title).toBe('【官方中字】迷你尼古喵喵 第1集')
    expect(extractMainContent(ARTICLE_LIKE).title).toBe('量子纠缠是什么？一篇讲清楚')
  })

  it('站点名可用于标注来源', () => {
    expect(extractMainContent(BILI_LIKE).siteName).toBe('哔哩哔哩')
    expect(extractMainContent(ARTICLE_LIKE).siteName).toBe('科普中国')
  })

  it('标记是否成功挑出正文块', () => {
    expect(extractMainContent(ARTICLE_LIKE).selected).toBe(true)
  })
})

describe('extractMainContent — 边界与容错', () => {
  it('空 HTML 安全返回', () => {
    expect(extractMainContent('')).toEqual({ title: '', text: '', siteName: '', selected: false })
    expect(extractMainContent('   ').text).toBe('')
  })

  it('没有任何合格块时退化为全文（不返回空）', () => {
    const r = extractMainContent('<html><body><div>短</div><div>也很短</div></body></html>')
    expect(r.selected).toBe(false)
    expect(r.text).toContain('短')
  })

  it('标签不闭合 / 错位不影响整体（真实网页常有瑕疵）', () => {
    const broken = '<html><body><div class="article-content">'
      + '<p>第一段完整的话，应当被保留下来，因为它是这篇正文的开头部分。'
      + '<p>第二段也没有闭合标签，同样应该保留，因为它是正文的延续内容。</p></body></html>'
    const r = extractMainContent(broken)
    expect(r.text).toContain('第一段完整的话')
    expect(r.text).toContain('第二段也没有闭合标签')
  })

  it('自闭合标签不会让标签栈错位（<br>/<img> 不入栈）', () => {
    const html = '<div class="content"><p>第一句，很长很长的正文句子用来通过长度门槛。</p>'
      + '<br><img src="x.png"><p>第二句，同样需要足够长才能被算作正文块的一部分。</p></div>'
    const r = extractMainContent(html)
    expect(r.text).toContain('第一句')
    expect(r.text).toContain('第二句')
  })

  it('script 里的 JS 含 `<` 不会污染标签栈（实测新浪首页因此提取到 0 字）', () => {
    // JS 里的 `i<arr.length`、`document.write('<div')` 会被朴素分词当成标签，
    // 把标签栈搅乱 → 外层 script 永远不闭合 → 整个 body 被判为"要丢弃的子树"。
    const html = '<html><head><script>'
      + 'for(var i=0;i<arr.length;i++){document.write(\'<div class="x">\')}'
      + '</script></head><body>'
      + '<div class="content"><p>这段正文必须被提取出来，不能因为脚本里的尖括号而整篇丢失。</p></div>'
      + '</body></html>'
    const r = extractMainContent(html)
    expect(r.text).toContain('这段正文必须被提取出来')
    expect(r.text).not.toContain('arr.length')
  })

  it('style 里的 CSS 含 `<` 同样安全', () => {
    const html = '<html><head><style>@media (max-width:600px){.a{color:red}}</style></head>'
      + '<body><div class="content"><p>样式表里的尖括号也不该影响正文提取，这段文字要保留。</p></div></body></html>'
    const r = extractMainContent(html)
    expect(r.text).toContain('样式表里的尖括号也不该影响正文提取')
  })

  it('class 值带引号时噪音词仍能匹配（`class="danmaku-list"` 曾被漏掉）', () => {
    const html = '<div class="danmaku-list"><span>弹幕列表</span><span>哈哈哈哈哈哈</span></div>'
      + '<div class="content"><p>这里是真正的正文内容，应当被保留下来供模型使用。</p></div>'
    const r = extractMainContent(html)
    expect(r.text).not.toContain('弹幕列表')
    expect(r.text).toContain('真正的正文内容')
  })

  it('`video-info` 这类"正文容器"不被噪音词表误杀', () => {
    // `info` 曾是噪音词，会把装着标题与简介的 `video-info` 整块剔掉
    const html = '<div class="video-info"><h1>视频标题在这里</h1>'
      + '<div class="video-desc">这是视频简介，属于真正的页面内容，必须保留。</div></div>'
    const r = extractMainContent(html)
    expect(r.text).toContain('这是视频简介')
  })

  it('按 maxChars 截断', () => {
    const long = `<div class="content"><p>${'这是一段很长的正文。'.repeat(500)}</p></div>`
    const r = extractMainContent(long, { maxChars: 200 })
    expect(r.text.length).toBeLessThan(300)
    expect(r.text).toContain('已截断')
  })

  it('去重：同一句话重复贴多遍只留一份', () => {
    const dup = '<div class="content">'
      + '<p>重复的正文句子，长度足够通过块级门槛，应该只保留一份。</p>'
      + '<p>重复的正文句子，长度足够通过块级门槛，应该只保留一份。</p></div>'
    const r = extractMainContent(dup)
    expect(r.text.split('重复的正文句子').length - 1).toBe(1)
  })
})

describe('辅助函数', () => {
  it('cleanTitle 去掉站点后缀', () => {
    expect(cleanTitle('标题正文_哔哩哔哩_bilibili')).toBe('标题正文')
    expect(cleanTitle('量子纠缠 - 科普中国')).toBe('量子纠缠')
    expect(cleanTitle('没有分隔符的标题')).toBe('没有分隔符的标题')
  })

  it('cleanTitle 在无标题时退回首个 h1', () => {
    expect(cleanTitle('', ['一级标题'])).toBe('一级标题')
  })

  it('extractSiteName 优先 og:site_name', () => {
    expect(extractSiteName('<meta property="og:site_name" content="喵御宅">', 'x_y')).toBe('喵御宅')
  })

  it('decodeEntities 解常见实体', () => {
    expect(decodeEntities('A&amp;B&nbsp;C&lt;D&gt;E&ensp;F')).toBe('A&B C<D>E F')
    expect(decodeEntities('&#39;引号&#39;')).toBe("'引号'")
  })

  it('scanHtml 收集 h1-h3 作为标题候选', () => {
    const { headings } = scanHtml('<h1>主标题在这里</h1><h2>副标题也不短</h2>')
    expect(headings).toContain('主标题在这里')
    expect(headings).toContain('副标题也不短')
  })
})
