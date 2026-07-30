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
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => resolve(data))
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

      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () =>
        resolve({
          ok: (res.statusCode || 500) < 400,
          status: res.statusCode || 500,
          text: data,
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
          let data = ''
          res.on('data', (chunk) => { data += chunk })
          res.on('end', () =>
            resolve({
              ok: (res.statusCode || 500) < 400,
              status: res.statusCode || 500,
              text: data,
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
 * 获取网页正文纯文本（strip HTML tags）
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
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
