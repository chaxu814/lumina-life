/* ============================================================
   pet/pet-md.js — 桌宠聊天窗的轻量 Markdown 渲染（零依赖）

   【为什么需要】
   桌宠聊天窗原来把回复当纯文本塞进气泡（`span.textContent = text`），
   而 .cp-msg 没有 white-space:pre-wrap —— 于是模型输出的换行被**全部折叠**
   成一段，`**加粗**`、`- 列表`、`### 标题` 的标记原样露出来。
   一段几百字的长回答挤成一坨，用户读起来非常吃力。

   【为什么不用第三方库】
   pet-chat.html 是 extraResources 里独立投递的静态页，没有打包器；
   引 CDN 又要求离线可用（桌宠可能全程无网）。所以自己写一个够用的子集。

   【安全】
   LLM 输出是不可信内容。这里**先整体 HTML 转义**，再在转义后的文本上
   插入我们自己生成的标签 —— 模型输出里的 <script> / onerror 都会变成
   可见的普通字符，不可能执行。
   链接只认 http(s)，`javascript:` / `data:` 一律不生成 <a>。

   【覆盖范围】（按模型实际输出频率排）
   代码块、标题、有序/无序列表、表格、引用、分割线、
   行内代码、粗体、斜体、删除线、链接、裸 URL、换行
   ============================================================ */
;(function (global) {
  'use strict'

  /** HTML 转义 —— 必须最先做，之后所有插入的标签都是我们自己生成的 */
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  /** 只放行 http(s) —— 挡住 javascript: / data: / file: */
  function safeUrl(u) {
    var s = String(u || '').trim()
    if (/^https?:\/\//i.test(s)) {return s}
    return ''
  }

  /* ── 行内元素 ───────────────────────────────────────────────
     行内代码先被替换成占位符，避免里面的 `*` `_` `[` 被当成标记解析；
     全部处理完再换回来。占位符用 \u0000 包裹，正常文本不会出现。 */
  function renderInline(escaped) {
    var codes = []
    var s = String(escaped)

    // 1) 行内代码 `x`（先抽走）
    s = s.replace(/`([^`\n]+)`/g, function (_m, code) {
      codes.push(code)
      return '\u0000C' + (codes.length - 1) + '\u0000'
    })

    // 2) 链接 [文字](url)
    s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/gi, function (_m, label, url) {
      var href = safeUrl(url.replace(/&amp;/g, '&'))
      if (!href) {return label}
      return '<a href="' + escapeHtml(href) + '" data-ext="1">' + label + '</a>'
    })

    // 3) 裸 URL（不含已生成的 <a ...> 里的 href —— 上面那步已经把 URL 吃进属性了，
    //    这里只处理剩余的、前面不是 = " > 的 http 开头串）
    s = s.replace(/(^|[\s(（])(https?:\/\/[^\s<)）]+)/gi, function (_m, pre, url) {
      var href = safeUrl(url.replace(/&amp;/g, '&'))
      if (!href) {return pre + url}
      return pre + '<a href="' + escapeHtml(href) + '" data-ext="1">' + url + '</a>'
    })

    // 4) 粗体 / 斜体 / 删除线
    s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
    s = s.replace(/__([^_\n]+?)__/g, '<strong>$1</strong>')
    s = s.replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>')
    s = s.replace(/(^|[^_\w])_([^_\n]+?)_(?!_)/g, '$1<em>$2</em>')
    s = s.replace(/~~([^~\n]+?)~~/g, '<del>$1</del>')

    // 5) 换回行内代码
    s = s.replace(/\u0000C(\d+)\u0000/g, function (_m, i) {
      return '<code>' + codes[Number(i)] + '</code>'
    })
    return s
  }

  var RE_HEADING = /^(#{1,6})\s+(.+)$/
  var RE_HR = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/
  // 注意：解析发生在**转义之后**，所以引用标记的 `>` 已经变成 `&gt;`
  var RE_QUOTE = /^\s{0,3}(?:&gt;|>)\s?(.*)$/
  var RE_UL = /^\s{0,3}[-*+]\s+(.+)$/
  var RE_OL = /^\s{0,3}\d{1,3}[.)]\s+(.+)$/
  var RE_FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+-]*)\s*$/
  var RE_TABLE_SEP = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/

  /** 把表格行拆成单元格（去掉首尾的空 |） */
  function splitRow(line) {
    var t = String(line).trim()
    if (t.charAt(0) === '|') {t = t.slice(1)}
    if (t.charAt(t.length - 1) === '|') {t = t.slice(0, -1)}
    return t.split('|').map(function (c) { return c.trim() })
  }

  /** 主渲染：Markdown → HTML 字符串 */
  function render(src) {
    var text = String(src == null ? '' : src).replace(/\r\n?/g, '\n').replace(/\t/g, '  ')
    if (!text.trim()) {return ''}

    // 先整体转义，之后逐行解析
    var lines = escapeHtml(text).split('\n')
    var out = []
    var i = 0

    function flushParagraph(buf) {
      if (!buf.length) {return}
      // 段落内部单个换行 → <br>（模型常把一句话折成两行）
      out.push('<p>' + buf.map(renderInline).join('<br>') + '</p>')
      buf.length = 0
    }

    var para = []

    while (i < lines.length) {
      var line = lines[i]

      // ── 围栏代码块 ──
      var fence = line.match(RE_FENCE)
      if (fence) {
        flushParagraph(para)
        var marker = fence[1].charAt(0)
        var lang = fence[2] || ''
        var body = []
        i++
        while (i < lines.length) {
          var close = lines[i].match(/^\s{0,3}(`{3,}|~{3,})\s*$/)
          if (close && close[1].charAt(0) === marker) {i++; break}
          body.push(lines[i])
          i++
        }
        out.push(
          '<pre class="cp-pre"' + (lang ? ' data-lang="' + lang + '"' : '') + '>' +
          '<code>' + body.join('\n') + '</code></pre>',
        )
        continue
      }

      // ── 空行：段落结束 ──
      if (!line.trim()) { flushParagraph(para); i++; continue }

      // ── 分割线 ──
      if (RE_HR.test(line)) { flushParagraph(para); out.push('<hr>'); i++; continue }

      // ── 标题 ──
      var h = line.match(RE_HEADING)
      if (h) {
        flushParagraph(para)
        var lvl = Math.min(h[1].length + 2, 6) // # → h3，#及以上最大到 h6
        out.push('<h' + lvl + '>' + renderInline(h[2].trim()) + '</h' + lvl + '>')
        i++
        continue
      }

      // ── 表格：当前行有 |，下一行是分隔行 ──
      if (line.indexOf('|') !== -1 && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1])) {
        flushParagraph(para)
        var head = splitRow(line)
        i += 2 // 跳过表头与分隔行
        var rows = []
        while (i < lines.length && lines[i].indexOf('|') !== -1 && lines[i].trim()) {
          rows.push(splitRow(lines[i]))
          i++
        }
        var html = '<div class="cp-table-wrap"><table><thead><tr>'
        head.forEach(function (c) { html += '<th>' + renderInline(c) + '</th>' })
        html += '</tr></thead><tbody>'
        rows.forEach(function (r) {
          html += '<tr>'
          for (var k = 0; k < head.length; k++) {
            html += '<td>' + renderInline(r[k] == null ? '' : r[k]) + '</td>'
          }
          html += '</tr>'
        })
        html += '</tbody></table></div>'
        out.push(html)
        continue
      }

      // ── 引用（连续多行合并） ──
      if (RE_QUOTE.test(line)) {
        flushParagraph(para)
        var qbuf = []
        while (i < lines.length && RE_QUOTE.test(lines[i])) {
          qbuf.push(lines[i].match(RE_QUOTE)[1])
          i++
        }
        out.push('<blockquote>' + qbuf.map(renderInline).join('<br>') + '</blockquote>')
        continue
      }

      // ── 无序列表 ──
      if (RE_UL.test(line)) {
        flushParagraph(para)
        var ul = []
        while (i < lines.length && RE_UL.test(lines[i])) {
          ul.push('<li>' + renderInline(lines[i].match(RE_UL)[1]) + '</li>')
          i++
        }
        out.push('<ul>' + ul.join('') + '</ul>')
        continue
      }

      // ── 有序列表（起始序号按原文，避免全被重排成 1 开始） ──
      if (RE_OL.test(line)) {
        flushParagraph(para)
        var start = parseInt(line.match(/^\s{0,3}(\d{1,3})/)[1], 10)
        var ol = []
        while (i < lines.length && RE_OL.test(lines[i])) {
          ol.push('<li>' + renderInline(lines[i].match(RE_OL)[1]) + '</li>')
          i++
        }
        out.push('<ol' + (start > 1 ? ' start="' + start + '"' : '') + '>' + ol.join('') + '</ol>')
        continue
      }

      para.push(line)
      i++
    }
    flushParagraph(para)

    return out.join('')
  }

  var PetMD = { render: render, escapeHtml: escapeHtml, safeUrl: safeUrl }

  if (typeof module !== 'undefined' && module.exports) {module.exports = PetMD}
  global.PetMD = PetMD
})(typeof window !== 'undefined' ? window : globalThis)
