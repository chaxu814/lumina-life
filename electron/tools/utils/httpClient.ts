// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// utils/httpClient.ts — 统一 HTTP 客户端 (安全版)
//
// 🔐 安全设计:
//   默认启用 SSL 证书验证 (rejectUnauthorized = true)
//   通过环境变量 LUMINA_ALLOW_INSECURE_SSL=1 可全局关闭
//   （仅用于自签名证书的内部服务、调试场景）
//   关闭时会在 stderr 打印安全警告
// ============================================================

import https from 'https'
import http from 'http'
import zlib from 'zlib'

// ═══════════════════════════════════════════════════════════
// 响应体解压（gzip / deflate / brotli）
// ═══════════════════════════════════════════════════════════

/**
 * 按 Content-Encoding 解压响应体。
 *
 * 🐛 2026-10-12 修复（真实故障）：原先这两个请求函数**完全没有处理压缩**，
 *   把响应字节直接当 UTF-8 文本拼接。而部分站点（实测 bilibili）
 *   **即使客户端没声明 Accept-Encoding 也会返回 `Content-Encoding: gzip`**，
 *   于是抓到的"网页正文"是一坨乱码：
 *     `📄 ****` + `�y��6���S�6T�K�L-)���R…`
 *   后果有两层：
 *     ① 模型吃到 2000 字乱码 → 不但没帮上忙，反而污染上下文；
 *     ② `web_fetch` 工具整体失效（用户想要的「收集网页 → 整理总结」根本走不通）。
 *
 * 兜底策略：即使 Content-Encoding 缺失，也按 gzip 魔数（1f 8b）识别一次；
 *   解压失败则原样解码返回 —— 绝不因为压缩格式问题让整次请求失败。
 */
export function decodeResponseBody(buf: Buffer, contentEncoding?: string): string {
  const enc = String(contentEncoding || '').toLowerCase()
  try {
    if (enc.includes('br')) {return zlib.brotliDecompressSync(buf).toString('utf-8')}
    if (enc.includes('gzip')) {return zlib.gunzipSync(buf).toString('utf-8')}
    if (enc.includes('deflate')) {
      try { return zlib.inflateSync(buf).toString('utf-8') }
      catch { return zlib.inflateRawSync(buf).toString('utf-8') }  // 少数服务器发裸 deflate
    }
    // 头部缺失但内容是 gzip（实测存在）→ 按魔数兜底
    if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
      return zlib.gunzipSync(buf).toString('utf-8')
    }
  } catch { /* 解压失败 → 退化为原样解码 */ }
  return buf.toString('utf-8')
}

// ═══════════════════════════════════════════════════════════
// SSL 验证策略（全局单次计算）
// ═══════════════════════════════════════════════════════════

let _insecureWarned = false

/**
 * 是否允许不验证 SSL 证书。
 * 生产环境务必保持 false（默认）。
 * 仅在调试内部服务时通过 LUMINA_ALLOW_INSECURE_SSL=1 开启。
 */
export function allowInsecureSSL(): boolean {
  const val = process.env.LUMINA_ALLOW_INSECURE_SSL
  if (val === '1' || val === 'true' || val === 'yes') {
    if (!_insecureWarned) {
      console.warn(
        '⚠️ [安全警告] LUMINA_ALLOW_INSECURE_SSL=1 已设置！',
        'SSL 证书验证已禁用，仅建议在调试内部服务时使用。',
        '生产环境请取消该环境变量。',
      )
      _insecureWarned = true
    }
    return true
  }
  return false
}

/** 获取 https.request 的通用 Options（含 SSL 策略） */
export function httpsRequestOptions(
  url: string,
  extraHeaders: Record<string, string> = {},
  timeoutMs = 12000,
): https.RequestOptions {
  const parsed = new URL(url)
  return {
    hostname: parsed.hostname,
    path: parsed.pathname + parsed.search,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      // 🆕 2026-10-12: 主动声明可接受压缩（省带宽、提速大页面）。
      //   前提是 decodeResponseBody 已能正确解压 —— 此前没有解压能力，
      //   所以从不敢声明；现在声明了，服务端行为才是确定的。
      'Accept-Encoding': 'gzip, deflate, br',
      ...extraHeaders,
    },
    timeout: timeoutMs,
    rejectUnauthorized: !allowInsecureSSL(),
  }
}

/**
 * HTTP GET 请求 — 返回纯文本（兼容旧接口）
 *
 * 与 httpGet() 的区别：返回 string 而非对象。
 * 用于 search.ts 等需要直接操作 HTML 文本的模块。
 *
 * SSL 验证策略同 httpGet()：默认开启。
 */
export function httpGetText(
  url: string,
  extraHeaders: Record<string, string> = {},
  timeoutMs = 12000,
  hardDeadline?: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http
    const options = httpsRequestOptions(url, extraHeaders, timeoutMs)

    // 对已知搜索引擎域名（bing.com, duckduckgo.com, baidu.com）默认放行 SSL
    // 这些是可信公网服务，不存在中间人攻击的常见场景
    try {
      const parsed = new URL(url)
      const trustedDomains = [
        'bing.com', 'cn.bing.com', 'www.bing.com',
        'duckduckgo.com', 'html.duckduckgo.com', 'lite.duckduckgo.com',
        'baidu.com', 'www.baidu.com',
        'google.com', 'www.google.com',
        'search.brave.com',
      ]
      if (trustedDomains.some(d => parsed.hostname === d || parsed.hostname.endsWith('.' + d))) {
        // 可信公网搜索服务 — 严格验证
        options.rejectUnauthorized = true
      }
    } catch { /* URL 解析失败则保持默认策略 */ }

    const req = lib.request(options, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(httpGetText(new URL(res.headers.location, url).href, extraHeaders, timeoutMs, hardDeadline))
        return
      }
      // 🐛 2026-10-12: 必须按 **Buffer** 累积再解压。
      //   旧写法 `data += chunk` 会把 chunk 隐式转成 UTF-8 字符串 ——
      //   压缩响应（gzip/br）在此刻就已被破坏，之后再也解不回来。
      const chunks: Buffer[] = []
      res.on('data', (chunk) => { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)) })
      res.on('end', () => resolve(decodeResponseBody(
        Buffer.concat(chunks),
        res.headers['content-encoding'] as string | undefined,
      )))
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error(`请求超时 (${timeoutMs}ms): ${url.slice(0, 100)}`)) })

    if (hardDeadline && hardDeadline > Date.now()) {
      const remain = hardDeadline - Date.now()
      setTimeout(() => { req.destroy(); reject(new Error(`硬截止超时 (${remain}ms 剩余)`)) }, Math.min(remain, timeoutMs))
    }
    req.end()
  })
}

/**
 * HTTP GET 请求（统一版 + SSL 错误自动降级）
 *
 * 自动处理 HTTPS/HTTP，支持重定向跟踪、超时。
 * SSL 验证策略：默认开启；若因证书问题失败则自动重试一次（带警告）。
 * 可通过 LUMINA_ALLOW_INSECURE_SSL=1 强制关闭验证。
 * 返回 { ok, status, text, contentType }
 */
export function httpGet(
  url: string,
  extraHeaders: Record<string, string> = {},
  timeoutMs = 12000,
  hardDeadline?: number,
): Promise<{ ok: boolean; status: number; text: string; contentType: string }> {
  return _httpGetImpl(url, extraHeaders, timeoutMs, hardDeadline, false)
}

async function _httpGetImpl(
  url: string,
  extraHeaders: Record<string, string> = {},
  timeoutMs = 12000,
  hardDeadline?: number,
  isRetry = false,
): Promise<{ ok: boolean; status: number; text: string; contentType: string }> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http
    const options = httpsRequestOptions(url, extraHeaders, timeoutMs)

    const req = lib.request(options, (res) => {
      // 跟随重定向（最多一层）
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, url).href
        resolve(httpGet(redirectUrl, extraHeaders, timeoutMs, hardDeadline))
        return
      }

      // 🐛 2026-10-12: 按 Buffer 累积后解压（同 httpGetText，详见 decodeResponseBody 注释）
      const chunks: Buffer[] = []
      res.on('data', (chunk) => { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)) })
      res.on('end', () =>
        resolve({
          ok: (res.statusCode || 500) < 400,
          status: res.statusCode || 500,
          text: decodeResponseBody(Buffer.concat(chunks), res.headers['content-encoding'] as string | undefined),
          contentType: res.headers['content-type'] || '',
        }),
      )
    })

    req.on('timeout', () => {
      req.destroy()
      reject(new Error(`HTTP 请求超时 (${timeoutMs}ms): ${url.slice(0, 100)}`))
    })
    req.on('error', (err: any) => {
      // SSL 证书错误自动降级重试一次
      if (!isRetry && err.message && (
        err.message.includes('certificate') ||
        err.message.includes('CERT_') ||
        err.message.includes('SSL')
      )) {
        console.warn(`[httpClient] SSL 验证失败，自动降级重试: ${url.slice(0, 80)}`)
        // 设置宽松模式重试
        const relaxedOptions = httpsRequestOptions(url, extraHeaders, timeoutMs)
        relaxedOptions.rejectUnauthorized = false
        const relaxedLib = url.startsWith('https') ? https : http
        const retryReq = relaxedLib.request(relaxedOptions, (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk) => { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)) })
          res.on('end', () =>
            resolve({
              ok: (res.statusCode || 500) < 400,
              status: res.statusCode || 500,
              text: decodeResponseBody(Buffer.concat(chunks), res.headers['content-encoding'] as string | undefined),
              contentType: res.headers['content-type'] || '',
            }),
          )
        })
        retryReq.on('timeout', () => { retryReq.destroy(); reject(err) })
        retryReq.on('error', () => reject(err))
        retryReq.end()
        return
      }
      reject(err)
    })

    // 外部硬截止：防止单请求挂起太久
    if (hardDeadline && hardDeadline > Date.now()) {
      const remain = hardDeadline - Date.now()
      setTimeout(() => {
        req.destroy()
        reject(new Error(`硬截止超时 (${remain}ms 剩余)`))
      }, Math.min(remain, timeoutMs))
    }

    req.end()
  })
}

/**
 * 内联格式标签（不含 <br>/<p>/<div> 这类块级标签）。
 * 块级标签必须换成空格，否则段落会被粘成一坨；内联标签在中文里则应**直接去掉**。
 */
const INLINE_TAG = /^<\/?(?:strong|b|em|i|u|s|span|font|mark|small|sub|sup|a|code)\b[^>]*>$/i
const CJK_CHAR = /[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff\uac00-\ud7af]/

/**
 * 获取网页正文纯文本（strip HTML tags）
 *
 * 🆕 2026-10-12 修复（中文被空格切碎）：
 *   搜索引擎会把命中词高亮成 `<strong>…</strong>`。旧实现把**所有**标签
 *   一律替换成空格，于是 B 站标题
 *     `迷你<strong>尼古喵喵</strong>第1集`
 *   变成 `迷你 尼 古喵喵 第1集` —— 中文词被切开，既难读，
 *   也削弱了相关性匹配（`尼古` 这个 2-gram 直接消失）。
 *   现在：内联标签在**两侧都是中日韩文字**时直接删除（不留空格），
 *   其余情况（含英文、块级标签）仍替换为空格，保持原有行为。
 */
export function stripHtml(html: string): string {
  // 用哨兵字符占位内联标签，等所有标签都换成占位符后再统一判定 ——
  // 这样「</strong><strong>」这种**相邻标签**也能被正确识别为"夹在中文中间"
  // （若一边一边地判，相邻标签之间看到的是 `<` `>` 而不是中文字，会误插空格）。
  const MARK = '\u0000'
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, (tag: string) => (INLINE_TAG.test(tag) ? MARK : ' '))

  s = s.replace(/\u0000+/g, (run: string, offset: number, whole: string) => {
    // 左右各跳过连续的占位符/空格，找到最近的**文字**字符
    let l = offset - 1
    while (l >= 0 && (whole[l] === MARK || whole[l] === ' ')) {l--}
    let r = offset + run.length
    while (r < whole.length && (whole[r] === MARK || whole[r] === ' ')) {r++}
    const before = whole[l] || ''
    const after = whole[r] || ''
    return (CJK_CHAR.test(before) && CJK_CHAR.test(after)) ? '' : ' '
  })

  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
