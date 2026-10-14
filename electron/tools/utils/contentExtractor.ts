/**
 * contentExtractor.ts —— 零依赖的「正文提取」（Readability-lite）
 *
 * ────────────────────────────────────────────────────────────
 * 【要解决的真实问题】2026-10-12：抓回的网页正文里模板噪音占了大半 ——
 *   导航条、弹幕列表、相关推荐、备案号、页脚、客服链接……
 *   实测 B 站视频页抓回来的 375 字符里，真正的信息只有一两句。
 *   这些噪音不只是"看着乱"：它们会**挤掉上下文预算**，
 *   让模型把注意力花在"沪ICP备2022032900号"这类内容上。
 *
 * 【为什么不装 jsdom / @mozilla/readability】
 *   本项目刻意保持零依赖（19 个运行时依赖，无任何 HTML 解析库），
 *   工具链里的分词器、HTML 清洗都是自研的。为此引入 jsdom（≈10MB + 一堆传递依赖）
 *   不划算，也会影响打包体积与启动时间。所以这里自研一个**够用的**版本：
 *   只做两件事 —— ① 按标签栈剥离子树；② 给块级文本打分挑正文。
 *
 * 【设计取舍：为什么是"打分"而不是"找容器"】
 *   真正的 Readability 会构建 DOM 树、找最可能的正文容器。
 *   这里没有 DOM，改用等价效果的打分法：
 *   把文本切成"块"（按最近的块级祖先分组），给每块打分
 *   （长度、标点密度、链接密度、祖先 class 暗示），取分数达标者。
 *   对"正文 + 模板噪音"这种典型结构，效果与找容器接近，但实现小一个量级。
 * ────────────────────────────────────────────────────────────
 */

// ═══════════════════════════════════════════════════════════
// 标签分类
// ═══════════════════════════════════════════════════════════

/** 自闭合标签：解析时**不入栈**（否则栈会错位，后续全部文本归错父节点） */
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
  'meta', 'param', 'source', 'track', 'wbr',
])

/** 直接整棵丢弃的标签：这些内容永远不是正文 */
const DROP_TAGS = new Set([
  'script', 'style', 'noscript', 'iframe', 'svg', 'canvas', 'template',
  'form', 'button', 'select', 'option', 'input', 'textarea',
  'nav', 'footer', 'header', 'aside', 'head', 'dialog', 'audio', 'video',
])

/** 块级标签：文本按「最近的块级祖先」分组，一个组 = 一个候选块 */
const BLOCK_TAGS = new Set([
  'p', 'div', 'li', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'section', 'article', 'blockquote', 'pre', 'dd', 'dt', 'figcaption',
  'caption', 'tr', 'ul', 'ol', 'table', 'main', 'summary', 'details',
])

/**
 * 模板噪音的 class/id 暗示（**只用于"剔除明确噪音"**）。
 *
 * 两个坑（都踩过）：
 *   ① 边界必须用 `[^a-z0-9]`，不能只用 `[-_\s]` ——
 *      class 值外面是引号（`class="danmaku-list"`），引号不在 `[-_\s]` 里，
 *      结果 `danmaku` 匹配不上、弹幕区整块留了下来。
 *   ② 词表必须**只放明确的噪音词**。`info` / `meta` / `extra` / `notice` / `tip`
 *      这类词太笼统：`class="video-info"` 恰恰是**装着标题和简介的正文容器**，
 *      放进噪音词表会把正文一起剔掉。
 */
const NEGATIVE_ATTR = /(^|[^a-z0-9])(nav|menu|sidebar|footer|header|comment|comments|recommend|related|danmaku|barrage|banner|advert|ads?|promo|copyright|breadcrumb|toolbar|share|social|login|signup|subscribe|search|pagination|pager|tags?|widget|popup|modal|dropdown|hot|rank|topbar|footbar)([^a-z0-9]|$)/i

/** 正文容器的 class/id 暗示（加分） */
const POSITIVE_ATTR = /(article|content|main|post|entry|body|text|detail|desc|read|story|markdown|rich|wiki|lemma|abstract|paragraph|正文|内容|简介|简介)/i

/** 文本自身的噪音特征（页脚/客服/备案这类固定话术） */
const NEGATIVE_TEXT = /(版权所有|备案号|增值电信业务|营业执照|不良信息举报|举报中心|客服中心|联系客服|站点地图|友情链接|关于我们|隐私协议|用户协议|审核规范|创作中心|开通会员|免广告|扫码下载|关注公众号|沪ICP备|京ICP备|粤ICP备|公网安备)/

// ═══════════════════════════════════════════════════════════
// 极简标签栈解析
// ═══════════════════════════════════════════════════════════

interface OpenElement {
  /** 唯一 id —— 作为"块分组键" */
  id: number
  /** 父元素 id（0 = 无）—— 用于"按父容器成组" */
  parentId: number
  tag: string
  /** 该元素或其祖先是否命中噪音暗示（用于扣分） */
  neg: boolean
  /** 该元素或其祖先是否命中正文暗示（用于加分） */
  pos: boolean
  /** 是否在 <a> 内部（用于算链接密度） */
  inLink: boolean
  /** 是否处于被丢弃的子树里 */
  drop: boolean
}

interface TextSegment {
  text: string
  /** 最近的块级祖先 id（没有块级祖先时为 0） */
  blockId: number
  /** 该块级祖先的父元素 id —— 成组用的键 */
  groupId: number
  inLink: boolean
  neg: boolean
  pos: boolean
  order: number
}

function parseAttrs(tagText: string): string {
  // 只要 class / id 两个属性就够打分用了
  const m = tagText.match(/\s(?:class|id)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi) || []
  return m.join(' ')
}

/**
 * 清空「原始文本元素」的内容（script / style / textarea / svg）。
 *
 * 【为什么必须先做这一步】实测故障（新浪新闻首页，2026-10-12）：
 *   `<script>` 里的 JS 代码含有 `<`，例如 `for(var i=0;i<arr.length;i++)`、
 *   `document.write('<div ...')`。朴素的按 `<...>` 分词会把它们当成**标签**，
 *   于是标签栈被污染成 `html>body>script>arr>script>f>div…`，
 *   而 `</script>` 只会弹到**最近一个** script —— 外层 script 永远留在栈上，
 *   整个 body 被判成"要丢弃的子树" → **提取结果 0 字**。
 *
 *   真实 HTML 解析器对此有专门规则：script/style 是「raw text element」，
 *   其内容不参与标签解析。这里用等价的预处理实现。
 */
function stripRawTextElements(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '<script></script>')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '<style></style>')
    .replace(/<textarea\b[^>]*>[\s\S]*?<\/textarea\s*>/gi, '<textarea></textarea>')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg\s*>/gi, '<svg></svg>')
}

/**
 * 扫描 HTML，产出文本片段（带上下文）与标题候选。
 *
 * 容错策略：只对**块级标签**维护栈的准确性；遇到不匹配的闭合标签就向下找，
 * 找不到就忽略 —— 真实网页的 HTML 常有瑕疵，不能因为一处错位就整篇报废。
 */
export function scanHtml(html: string): {
  segments: TextSegment[]
  headings: string[]
  title: string
} {
  const segments: TextSegment[] = []
  const headings: string[] = []
  const stack: OpenElement[] = []
  let idSeq = 0
  let order = 0

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = titleMatch ? decodeEntities(titleMatch[1]).trim() : ''

  // ⚠️ 必须在分词前清空 script/style 的内容（原因见函数注释）
  const tokens = stripRawTextElements(html).match(/<!--[\s\S]*?-->|<[^>]+>|[^<]+/g) || []
  for (const tok of tokens) {
    if (tok.startsWith('<!--')) {continue}

    if (tok.startsWith('<')) {
      const close = /^<\s*\//.test(tok)
      const nameMatch = tok.match(/^<\s*\/?\s*([a-zA-Z][a-zA-Z0-9:-]*)/)
      if (!nameMatch) {continue}
      const tag = nameMatch[1].toLowerCase()

      if (close) {
        // 从栈顶往下找同名元素；找到则连同其上一起弹出（容错）
        let idx = -1
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i].tag === tag) {idx = i; break}
        }
        if (idx >= 0) {stack.length = idx}
        continue
      }

      const selfClose = /\/\s*>$/.test(tok)
      if (VOID_TAGS.has(tag) || selfClose) {continue}

      const attr = parseAttrs(tok)
      const parentDrop = stack.length > 0 ? stack[stack.length - 1].drop : false
      const parentNeg = stack.length > 0 ? stack[stack.length - 1].neg : false
      const parentPos = stack.length > 0 ? stack[stack.length - 1].pos : false
      const parentInLink = stack.length > 0 ? stack[stack.length - 1].inLink : false

      stack.push({
        id: ++idSeq,
        parentId: stack.length > 0 ? stack[stack.length - 1].id : 0,
        tag,
        drop: parentDrop || DROP_TAGS.has(tag),
        neg: parentNeg || (!!attr && NEGATIVE_ATTR.test(attr)),
        pos: parentPos || (!!attr && POSITIVE_ATTR.test(attr)),
        inLink: parentInLink || tag === 'a',
      })
      continue
    }

    // 文本节点
    const top = stack.length > 0 ? stack[stack.length - 1] : null
    if (top?.drop) {continue}
    const text = decodeEntities(tok).replace(/\s+/g, ' ').trim()
    if (!text) {continue}

    // 最近的块级祖先（同时记下它的父元素，作为"成组键"）
    let blockId = 0
    let groupId = 0
    for (let i = stack.length - 1; i >= 0; i--) {
      if (BLOCK_TAGS.has(stack[i].tag)) {
        blockId = stack[i].id
        groupId = stack[i].parentId
        break
      }
    }

    if (top && /^h[1-3]$/.test(top.tag) && text.length >= 4) {headings.push(text)}

    segments.push({
      text,
      blockId,
      groupId,
      inLink: !!top?.inLink,
      neg: !!top?.neg,
      pos: !!top?.pos,
      order: order++,
    })
  }

  return { segments, headings, title }
}

/** 解码常见 HTML 实体（够用即可，不追求完整 HTML5 实体表） */
export function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&ensp;|&emsp;|&thinsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeFromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeFromCodePoint(parseInt(d, 10)))
}

function safeFromCodePoint(code: number): string {
  try { return String.fromCodePoint(code) } catch { return '' }
}

// ═══════════════════════════════════════════════════════════
// 块级打分与正文选取
// ═══════════════════════════════════════════════════════════

export interface ExtractedContent {
  /** 清洗后的标题（已去掉站点后缀） */
  title: string
  /** 正文纯文本（段落以 \n 分隔） */
  text: string
  /** 站点名（来自 og:site_name 或标题后缀），用于给出来源 */
  siteName: string
  /** 是否成功挑出了正文块（false = 退化为全文） */
  selected: boolean
}

export interface ExtractOptions {
  /** 正文最大字符数，默认 6000 */
  maxChars?: number
}

/**
 * 从 HTML 提取正文。
 *
 * 打分维度：
 *   + 文本长度（正文通常长）
 *   + 标点密度（正文有句子，导航没有）
 *   + 中文内容加成
 *   + 祖先 class/id 命中正文暗示
 *   − 链接密度（导航/列表/推荐位几乎全是链接）
 *   − 祖先 class/id 命中噪音暗示
 *   − 文本自身是页脚/客服/备案话术
 */
/**
 * 从 HTML 提取正文。
 *
 * ── 为什么是"减法"而不是"打分选优" ──
 *   第一版实现照搬 Readability 的打分法（长度/标点/链接密度/class 暗示），
 *   实测**严重误伤**：
 *     · mfuns 视频页逐块打分时最高分是 **-54**（全部为负）→ 只剩 42 字；
 *     · 新浪新闻首页 **0 字**（首页内容本身就是一串链接，全被判为"导航"）。
 *   根因：把「链接密度高」等同于噪音，而**列表类页面（视频站/论坛/新闻首页）
 *   的内容本身就是链接**。
 *
 *   而这里的目标是"给模型喂材料"——**偏好应该是宁可多留，不可丢**：
 *   噪音模型自己能筛掉，丢掉的正文它拿不回来。
 *   所以改成减法：只剔除**明确的**噪音单元，其余按文档顺序保留。
 *
 * ── 剔除规则（三条，都很保守）──
 *   ① 文本自身是页脚/备案/客服话术（`NEGATIVE_TEXT`）
 *   ② class/id 明确是导航/推荐/弹幕/广告等噪音，**且没有正文暗示**（`neg && !pos`）
 *      —— 加 `!pos` 是为了不误杀 `class="content-info"` 这类"正文+修饰"的容器
 *   ③ 极短（< 8 字）或纯数字/符号的碎片
 *   （script/style/nav/footer/header/aside/form 等整棵子树在解析阶段就丢了）
 */
export function extractMainContent(html: string, opts?: ExtractOptions): ExtractedContent {
  const maxChars = opts?.maxChars ?? 6000
  if (!html || !html.trim()) {return { title: '', text: '', siteName: '', selected: false}}

  const { segments, headings, title: rawTitle } = scanHtml(html)

  // 单元块：按最近的块级祖先分组（一个块 = 一段连续文本）
  const units = new Map<number, {
    parts: string[]; linkChars: number; neg: boolean; pos: boolean; order: number
  }>()
  for (const seg of segments) {
    let u = units.get(seg.blockId)
    if (!u) {
      u = { parts: [], linkChars: 0, neg: false, pos: false, order: seg.order }
      units.set(seg.blockId, u)
    }
    u.parts.push(seg.text)
    if (seg.inLink) {u.linkChars += seg.text.length}
    u.neg = u.neg || seg.neg
    u.pos = u.pos || seg.pos
  }

  const kept: Array<{ text: string; order: number }> = []
  let removed = 0
  for (const u of units.values()) {
    const text = u.parts.join(' ').replace(/\s+/g, ' ').trim()
    if (!text) {continue}
    // ③ 碎片
    if (text.length < 8) {removed++; continue}
    if (!/[\u4e00-\u9fff\u3040-\u30ffa-zA-Z]/.test(text)) {removed++; continue}
    // ① 页脚/备案/客服话术
    if (NEGATIVE_TEXT.test(text)) {removed++; continue}
    // ② class/id 明确是噪音且无正文暗示
    if (u.neg && !u.pos) {removed++; continue}
    kept.push({ text, order: u.order })
  }

  kept.sort((a, b) => a.order - b.order)   // 还原文档顺序
  const text = kept.map(k => k.text).join('\n')

  if (!text.trim()) {
    // 全被剔除（极简页面/纯图片页）→ 退化为"把能拿到的文本都拿上"
    const all = segments.map(s => s.text).join('\n').replace(/\n+/g, '\n').trim()
    return {
      title: cleanTitle(rawTitle, headings),
      text: capText(dedupeLines(all), maxChars),
      siteName: extractSiteName(html, rawTitle),
      selected: false,
    }
  }

  return {
    title: cleanTitle(rawTitle, headings),
    text: capText(dedupeLines(text), maxChars),
    siteName: extractSiteName(html, rawTitle),
    selected: removed > 0,
  }
}

/** 去掉连续重复行（模板页常把同一句话重复贴） */
function dedupeLines(text: string): string {
  const seen = new Set<string>()
  return text
    .split('\n')
    .map(l => l.trim())
    .filter(l => {
      if (!l) {return false}
      const key = l.slice(0, 60)
      if (seen.has(key)) {return false}
      seen.add(key)
      return true
    })
    .join('\n')
}

function capText(text: string, maxChars: number): string {
  const t = (text || '').trim()
  return t.length > maxChars ? `${t.slice(0, maxChars)}\n…（已截断）` : t
}

/**
 * 清洗标题：去掉站点后缀。
 * `【官方中字】迷你尼古喵喵 第1集_哔哩哔哩_bilibili` → `【官方中字】迷你尼古喵喵 第1集`
 *
 * 规则（宁可少削，不可削错）：
 *   · 只削**尾部**片段，且每段 ≤ 14 字；
 *   · 纯数字段不削（那是日期/编号，如 `2026-10-12`）；
 *   · 主体必须是"真标题"（含中日韩文字或字母），否则停手 ——
 *     避免把 `2026-10-12 新闻` 削成 `2026 10`。
 */
export function cleanTitle(rawTitle: string, headings: string[] = []): string {
  const t = (rawTitle || '').trim()
  if (!t) {return headings[0] || ''}

  const parts = t.split(/\s*[|｜_\-–—]\s*/).filter(Boolean)
  while (parts.length > 1) {
    const head = parts[0]
    const tail = parts[parts.length - 1]
    if (tail.length > 14) {break}
    if (/^[\d.\s]+$/.test(tail)) {break}
    // 主体不是"真标题"（纯数字/符号）就不再削
    if (!/[\u4e00-\u9fff\u3040-\u30ffa-zA-Z]/.test(head)) {break}
    if (head.replace(/\s/g, '').length < 2) {break}
    parts.pop()
  }
  return parts.join(' ').trim() || t
}

/** 站点名：优先 og:site_name，其次标题尾部 */
export function extractSiteName(html: string, rawTitle: string): string {
  const og = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["']/i)
  if (og) {return decodeEntities(og[1]).trim()}
  const parts = (rawTitle || '').split(/\s*[|｜_\-–—]\s*/).filter(Boolean)
  const tail = parts.length > 1 ? parts[parts.length - 1].trim() : ''
  return tail.length <= 14 ? tail : ''
}
