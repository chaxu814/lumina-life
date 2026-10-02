// ============================================================
// utils/linkifyText.ts — 把纯文本里的 http/https 链接解析成可点击 token
//
// 纯函数、无 React / 无 Electron 依赖，方便单测。
// 安全边界：只产出 http/https 的 href；javascript:/data:/file: 等一律不匹配、不链接。
// ============================================================

export interface LinkToken {
  type: 'text' | 'link'
  /** 展示给用户的原文片段 */
  text: string
  /** 仅 link 有；规范化后的 http(s):// 地址 */
  href?: string
}

/**
 * 粗匹配：以 http(s):// 或 www. 开头，到空白/引号/尖括号/反引号/全角标点为止。
 * 全角标点（，。；：！？、（）《》…等）紧随 URL 时无空格，必须在此停下，
 * 否则会把后面的中文一起吞进链接。后面再做尾部标点清理与 scheme 规范化。
 */
const RAW_URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`，。；：！？、「」『』【】《》（）〈〉…—]+/gi

/** 尾部需要从 URL 上剥掉的标点（括号按配对单独处理） */
const TRAILING_PUNCT = new Set([
  '.', ',', ';', ':', '!', '?', '。', '，', '；', '：', '！', '？', '、',
  '"', "'", '`', '”', '’',
])

function countChar(s: string, ch: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) if (s[i] === ch) n++
  return n
}

/**
 * 清理粗匹配结果：剥掉尾随标点。
 * 括号特殊处理：成对的 (...) 里的 ')' 属于 URL（如维基百科链接），保留；
 * 只有当整个片段里 ')' 比 '(' 还多时，多余的尾随 ')' 才当作标点剥掉。
 */
function cleanUrl(raw: string): string {
  let s = raw
  while (s.length > 0) {
    const ch = s[s.length - 1]
    if (ch === ')') {
      const open = countChar(s, '(')
      const close = countChar(s, ')')
      if (close > open) { s = s.slice(0, -1); continue }
      break
    }
    if (TRAILING_PUNCT.has(ch)) { s = s.slice(0, -1); continue }
    break
  }
  return s
}

/** 规范化成 href：www. 补 https://；只保留 http/https。非法 scheme 返回 ''。 */
function toHref(cleaned: string): string {
  if (/^https?:\/\//i.test(cleaned)) return cleaned
  if (/^www\./i.test(cleaned)) return 'https://' + cleaned
  return ''
}

/** 把一段纯文本切分成 text / link token 序列。换行由外层 pre-wrap 保留。 */
export function linkify(input: string): LinkToken[] {
  const text = String(input ?? '')
  const tokens: LinkToken[] = []
  let lastIndex = 0
  RAW_URL_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = RAW_URL_RE.exec(text)) !== null) {
    const raw = m[0]
    const cleaned = cleanUrl(raw)
    const href = cleaned ? toHref(cleaned) : ''
    // 只放行 http/https；javascript:/data: 等根本不会被上面的正则命中，这里再兜一层
    if (/^https?:\/\//i.test(href)) {
      if (m.index > lastIndex) tokens.push({ type: 'text', text: text.slice(lastIndex, m.index) })
      tokens.push({ type: 'link', text: cleaned, href })
      // 用 cleaned 长度推进游标：被剥掉的尾随标点（。,.; 等）回流为后续文本，不丢失
      lastIndex = m.index + cleaned.length
    }
  }
  if (lastIndex < text.length) tokens.push({ type: 'text', text: text.slice(lastIndex) })
  return tokens
}

/** 回复里「主要」的 URL：第一个 http/https 链接；没有则返回 null。 */
export function pickPrimaryUrl(text: string): string | null {
  for (const t of linkify(String(text ?? ''))) {
    if (t.type === 'link' && t.href) return t.href
  }
  return null
}

/**
 * 是否应自动打开浏览器：开关关闭 → null（绝不弹窗）；
 * 开关开启但回复里没有 http/https 链接 → null。
 * 返回值就是要打开的地址。纯函数，便于单测。
 */
export function shouldAutoOpen(text: string, enabled: boolean): string | null {
  if (!enabled) return null
  return pickPrimaryUrl(text)
}
