// ============================================================
// electron/sync/webdavClient.ts — WebDAV 协议客户端（提案4）
//
// 用全局 fetch 手写 PROPFIND / PUT / GET / DELETE / MKCOL，
// 不依赖任何第三方 webdav 库。兼容坚果云 / Nextcloud / 任意标准 WebDAV 服务。
//
// 设计要点：
//   - fetchImpl 可注入，方便单测 mock（见 tests/webdavClient.test.ts）。
//   - PROPFIND 响应 XML 用极简正则解析（命名空间前缀 D:/d:/webdav: 都兼容），
//     避免引入 xml2js。
// ============================================================

export interface WebDavEntry {
  /** 相对同步根的路径，以 / 开头，正斜杠分隔，如 "/memory/2026-09-21.md" */
  path: string
  isDir: boolean
  size: number
  /** getlastmodified 解析后的 ms 时间戳；解析失败为 0 */
  lastModified: number
}

export interface WebDavClientOptions {
  baseUrl: string
  username: string
  password: string
  /** 可注入 fetch（测试用）；默认全局 fetch */
  fetchImpl?: typeof fetch
  /** 自定义请求头 */
  extraHeaders?: Record<string, string>
}

export class WebDavError extends Error {
  status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'WebDavError'
    this.status = status
  }
}

export class WebDavClient {
  private baseUrl: string
  private username: string
  private password: string
  private fetchImpl: typeof fetch
  private extraHeaders: Record<string, string>

  constructor(opts: WebDavClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.username = opts.username
    this.password = opts.password
    this.fetchImpl = opts.fetchImpl || fetch
    this.extraHeaders = opts.extraHeaders || {}
  }

  // ── 内部工具 ────────────────────────────────────────

  private authHeader(): string {
    const cred = Buffer.from(`${this.username}:${this.password}`, 'utf-8').toString('base64')
    return `Basic ${cred}`
  }

  /** 拼接绝对 URL（path 以 / 开头），并做 URL 编码（保留目录分隔）。 */
  private urlFor(path: string): string {
    const p = path.startsWith('/') ? path : '/' + path
    // 逐段编码，保留 /
    const encoded = p.split('/').map((seg) => encodeURIComponent(seg)).join('/')
    return this.baseUrl + encoded
  }

  private async request(
    method: string,
    path: string,
    body?: Buffer | string,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: this.authHeader(),
      ...this.extraHeaders,
      ...extraHeaders,
    }
    const res = await this.fetchImpl(this.urlFor(path), {
      method,
      headers,
      body: body === undefined ? undefined : body,
    } as any)
    return res
  }

  // ── 公开方法 ─────────────────────────────────────────

  /** 连接测试：对根目录做一次 Depth 0 PROPFIND。 */
  async testConnection(): Promise<{ ok: boolean; status?: number; error?: string }> {
    try {
      const res = await this.request('PROPFIND', '/', undefined, { Depth: '0' })
      if (res.ok || res.status === 207) {
        return { ok: true, status: res.status }
      }
      return { ok: false, status: res.status, error: `HTTP ${res.status}` }
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  }

  /** 列目录（递归到给定深度）。depth 默认 1。 */
  async list(path = '/', depth = 1): Promise<WebDavEntry[]> {
    const res = await this.request('PROPFIND', path, undefined, { Depth: String(depth) })
    if (res.status !== 207 && !res.ok) {
      throw new WebDavError(`PROPFIND 失败: HTTP ${res.status}`, res.status)
    }
    const xml = await res.text()
    return parseMultiStatus(xml, this.baseUrl)
  }

  /** 上传文件。 */
  async put(path: string, body: Buffer | string): Promise<{ ok: boolean; status: number }> {
    const res = await this.request('PUT', path, body, {
      'Content-Type': 'application/octet-stream',
    })
    if (!res.ok && res.status >= 300) {
      throw new WebDavError(`PUT 失败: HTTP ${res.status}`, res.status)
    }
    return { ok: res.ok, status: res.status }
  }

  /** 下载文件，返回 Buffer；不存在返回 null。 */
  async get(path: string): Promise<Buffer | null> {
    const res = await this.request('GET', path)
    if (res.status === 404) {return null}
    if (!res.ok) {throw new WebDavError(`GET 失败: HTTP ${res.status}`, res.status)}
    const ab = await res.arrayBuffer()
    return Buffer.from(ab)
  }

  /** 删除文件或目录。 */
  async delete(path: string): Promise<{ ok: boolean; status: number }> {
    const res = await this.request('DELETE', path)
    if (res.status === 404) {return { ok: true, status: 404 }}
    if (!res.ok) {throw new WebDavError(`DELETE 失败: HTTP ${res.status}`, res.status)}
    return { ok: true, status: res.status }
  }

  /** 创建目录（递归：自动逐级 MKCOL）。 */
  async mkcol(path: string): Promise<{ ok: boolean; status: number }> {
    // 先逐级确保父目录存在
    const parts = path.split('/').filter(Boolean)
    let acc = ''
    for (const part of parts) {
      acc += '/' + part
      try {
        const res = await this.request('MKCOL', acc)
        // 405/409 表示已存在或父目录问题，405 在已存在时常见，忽略
        if (res.status !== 405 && !res.ok && res.status !== 409) {
          throw new WebDavError(`MKCOL ${acc} 失败: HTTP ${res.status}`, res.status)
        }
      } catch (e: any) {
        if (e instanceof WebDavError) {throw e}
        throw new WebDavError(`MKCOL ${acc} 异常: ${e?.message || e}`)
      }
    }
    return { ok: true, status: 200 }
  }
}

// ── PROPFIND XML 极简解析 ────────────────────────────────────

/** 去掉 XML 标签的命名空间前缀，方便正则匹配。 */
function stripNs(xml: string): string {
  return xml.replace(/<(\/?)[\w]+:/g, '<$1')
}

/** 从单条 <response> 块里取字段。 */
function parseResponseBlock(block: string, baseUrl: string): WebDavEntry | null {
  const hrefMatch = block.match(/<href>([\s\S]*?)<\/href>/i)
  if (!hrefMatch) {return null}
  let href = decodeURIComponent(hrefMatch[1].trim())

  // 判定 collection
  const isCollection = /<collection\s*\/?>/i.test(block)

  // size（collection 可能没有）
  const sizeMatch = block.match(/<size>([\s\S]*?)<\/size>/i)
  const size = sizeMatch ? parseInt(sizeMatch[1].trim(), 10) || 0 : 0

  // getlastmodified
  let lastModified = 0
  const lmMatch = block.match(/<getlastmodified>([\s\S]*?)<\/getlastmodified>/i)
  if (lmMatch) {
    const t = Date.parse(lmMatch[1].trim())
    if (!Number.isNaN(t)) {lastModified = t}
  }

  // href 可能是绝对 URL 或相对路径；统一成相对同步根的路径
  let rel = href
  if (rel.startsWith('http')) {
    try {
      rel = new URL(rel).pathname
    } catch {
      /* keep */
    }
  }
  if (!rel.startsWith('/')) {rel = '/' + rel}
  // 去掉 baseUrl 路径前缀（坚果云等可能在子路径下）
  try {
    const basePath = new URL(baseUrl).pathname.replace(/\/+$/, '')
    if (basePath && rel.startsWith(basePath)) {
      rel = rel.slice(basePath.length) || '/'
    }
  } catch {}

  return { path: rel, isDir: isCollection, size, lastModified }
}

export function parseMultiStatus(xml: string, baseUrl: string): WebDavEntry[] {
  const stripped = stripNs(xml)
  const blocks = stripped.match(/<response>[\s\S]*?<\/response>/gi) || []
  const out: WebDavEntry[] = []
  for (const b of blocks) {
    const entry = parseResponseBlock(b, baseUrl)
    if (!entry) {continue}
    // 跳过「集合自身」那一条（path 与请求目录相同的目录项在调用方过滤）
    out.push(entry)
  }
  return out
}
