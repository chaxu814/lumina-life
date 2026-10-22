// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
//
// 方案二：DNS 拦截（预留，覆盖裸 TCP 连接）
//   不在白名单的域名解析到 127.0.0.1
//   覆盖 nc / telnet / 自定义二进制 等不支持代理的工具
//
// 设计原则：
//   - 零额外依赖，纯 Node.js 内置模块
//   - 惰性启动：第一次 shell 执行时才启动代理
//   - 单例 + 自动端口分配，不冲突
//   - 白名单可热更新
// ============================================================
// shellNetCage.ts — 🌐 C. 网络铁笼
//
// 第三层 → ② 网络铁笼
//   HTTP_PROXY 劫持 + 白名单检查
//   在 spawn 环境中注入 HTTP_PROXY → 命令的网络请求
//   经由本地代理 → 白名单检查 → 放行/拦截
//
// 姊妹模块（第三层纵深防御）:
//   A | processSandbox.ts — 进程树隔离
//   B | shellMonitor.ts   — 资源配额监控
//   D | shellFileWall.ts  — 文件围墙
//
// 集成入口: shell.ts → executeSandboxed()
//
// 方案二：DNS 拦截（预留，覆盖裸 TCP 连接）
//   不在白名单的域名解析到 127.0.0.1
//   覆盖 nc / telnet / 自定义二进制 等不支持代理的工具
//
// 设计原则：
//   - 零额外依赖，纯 Node.js 内置模块
//   - 惰性启动：第一次 shell 执行时才启动代理
//   - 单例 + 自动端口分配，不冲突
//   - 白名单可热更新
// ============================================================

import * as http from 'http'
import * as net from 'net'
import * as url from 'url'
import { Duplex } from 'stream'

// ═══════════════════════════════════════════════════════════
// 白名单
// ═══════════════════════════════════════════════════════════

/**
 * 默认网络白名单
 *
 * 原则：
 *   - 只放行「Lumina Agent 自动化使用」必要的域名
 *   - 包管理器：npm / pip / cargo 等需要下载依赖
 *   - AI API：各模型 API 地址
 *   - 代码仓库：git clone / pull 必经域名
 *
 * 注意：*. 通配符只支持 *.example.com → example.com 下所有子域
 */
const DEFAULT_WHITELIST: string[] = [
  // ── 包管理器 ──
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'pypi.org',
  '*.pypi.org',
  'files.pythonhosted.org',
  'rubygems.org',
  'crates.io',
  'static.crates.io',
  'packagist.org',
  'repo1.maven.org',
  'dl.google.com',
  'storage.googleapis.com',
  'github-production-release-asset-2e65be.s3.amazonaws.com',

  // ── 代码托管 ──
  'github.com',
  '*.github.com',
  'raw.githubusercontent.com',
  'assets-cdn.github.com',
  'gitlab.com',
  '*.gitlab.com',
  'bitbucket.org',
  '*.bitbucket.org',
  'gitee.com',
  '*.gitee.com',

  // ── AI/ML 模型 & API ──
  'api.openai.com',
  'api.deepseek.com',
  'api.anthropic.com',
  'api.cloudflare.com',
  'api.groq.com',
  'api.together.xyz',
  'api.mistral.ai',
  'api.cohere.ai',
  'huggingface.co',
  '*.huggingface.co',
  'modelscope.cn',
  '*.modelscope.cn',

  // ── Docker ──
  'docker.com',
  '*.docker.com',
  'docker.io',
  '*.docker.io',

  // ── 其他基础设施 ──
  'googleapis.com',
  '*.googleapis.com',
  'git-scm.com',
  'nodejs.org',
  '*.nodejs.org',
  'python.org',
  '*.python.org',
  'go.dev',
  'proxy.golang.org',
  'sum.golang.org',
  'cpan.org',
  '*.cpan.org',

  // ── 常用开发 ──
  'unpkg.com',
  'cdn.jsdelivr.net',
  'cdnjs.cloudflare.com',
  'fonts.googleapis.com',
  'code.visualstudio.com',
  'aka.ms',
  'go.microsoft.com',
  'download.visualstudio.microsoft.com',
]

// ═══════════════════════════════════════════════════════════
// 域名匹配工具
// ═══════════════════════════════════════════════════════════

/**
 * 检查 hostname 是否匹配白名单模式
 *
 * 支持两种模式：
 *   - 精确匹配：hostname === pattern
 *   - 通配：pattern 以 *. 开头时，hostname 以剩余部分结尾
 *
 * 不区分大小写。
 */
export function matchDomainPattern(hostname: string, pattern: string): boolean {
  const h = hostname.toLowerCase()
  const p = pattern.toLowerCase()

  if (p === h) {return true}
  if (p.startsWith('*.') && h.endsWith(p.slice(1))) {return true}
  // 处理 "*.github.com" 也匹配 "github.com" 本身
  if (p.startsWith('*.') && h === p.slice(2)) {return true}
  return false
}

/**
 * 检查 hostname 是否在允许列表中
 */
export function isDomainAllowed(hostname: string, whitelist: string[]): boolean {
  const clean = hostname.replace(/:\d+$/, '').toLowerCase()
  if (!clean) {return false}

  // localhost / 内网地址始终放行（避免打断内部通信）
  if (clean === 'localhost' || clean === '127.0.0.1' || clean === '::1' || clean === '0.0.0.0') {return true}
  // 10.x.x.x / 172.16-31.x.x / 192.168.x.x 内网地址放行
  if (/^(10\.\d+\.\d+\.\d+)$/.test(clean)) {return true}
  if (/^(172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(clean)) {return true}
  if (/^(192\.168\.\d+\.\d+)$/.test(clean)) {return true}

  for (const pattern of whitelist) {
    if (matchDomainPattern(clean, pattern)) {return true}
  }
  return false
}

// ═══════════════════════════════════════════════════════════
// 方案一：HTTP CONNECT 正向代理
// ═══════════════════════════════════════════════════════════

export class NetCageProxy {
  private server: http.Server | null = null
  private port: number = 0
  private _whitelist: string[]
  private started: boolean = false
  private startPromise: Promise<number> | null = null  // 🛡️ 防并发竞态

  constructor(whitelist?: string[]) {
    this._whitelist = whitelist || [...DEFAULT_WHITELIST]
  }

  // ─── 公共 API ────────────────────────────────────────────

  /** 启动代理服务器（自动分配端口），返回监听端口号 */
  async start(): Promise<number> {
    if (this.started) {return this.port}
    if (this.startPromise) {return this.startPromise}  // 已有启动中的请求，复用

    this.startPromise = new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.onHttpRequest(req, res))

      // 处理 HTTPS CONNECT 隧道
      this.server.on('connect', (req, clientSocket, head) => this.onConnect(req, clientSocket, head))

      // 错误时清理 startPromise 以便后续重试
      this.server.on('error', (err: Error) => {
        this.startPromise = null
        console.error(`[NetCage] ❌ 代理服务器错误: ${err.message}`)
        reject(err)
      })

      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address()
        if (addr && typeof addr === 'object') {
          this.port = addr.port
        } else {
          this.port = 0
        }
        this.started = true
        this.startPromise = null
        console.log(`[NetCage] 🌐 代理服务器已启动 → 127.0.0.1:${this.port} (${this._whitelist.length} 个白名单域名)`)
        resolve(this.port)
      })
    })

    return this.startPromise
  }

  /** 停止代理服务器 */
  stop(): void {
    this.startPromise = null
    if (this.server) {
      this.server.close()
      this.server = null
    }
    this.started = false
    this.port = 0
    console.log('[NetCage] 🛑 代理服务器已停止')
  }

  /** 获取当前端口（0 = 未启动） */
  getPort(): number {
    return this.port
  }

  /** 获取白名单副本 */
  getWhitelist(): string[] {
    return [...this._whitelist]
  }

  /** 替换整个白名单（热更新） */
  setWhitelist(list: string[]): void {
    this._whitelist = [...list]
    console.log(`[NetCage] 📝 白名单已更新: ${this._whitelist.length} 个域名`)
  }

  /** 添加域名到白名单 */
  addToWhitelist(domain: string): void {
    if (!this._whitelist.includes(domain)) {
      this._whitelist.push(domain)
      console.log(`[NetCage] ➕ 白名单新增: ${domain}`)
    }
  }

  /** 检查端口是否已被占用（用于启动前快速判断） */
  get isActive(): boolean {
    return this.started && this.server !== null
  }

  // ─── 内部处理 ────────────────────────────────────────────

  /**
   * HTTP 正向代理处理
   *
   * 客户端发来形如：
   *   GET http://example.com/path HTTP/1.1
   * 我们需要提取 hostname、转发请求。
   */
  private onHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const reqUrl = req.url || ''
    const parsed = url.parse(reqUrl)

    const hostname = parsed.hostname || ''
    const port = parsed.port || 80
    const path = parsed.path || '/'

    // 白名单检查
    if (!isDomainAllowed(hostname, this._whitelist)) {
      this.blockRequest(res, hostname)
      return
    }

    // 代理转发 HTTP 请求
    const proxyReq = http.request(
      {
        hostname,
        port: typeof port === 'string' ? parseInt(port, 10) : port,
        path,
        method: req.method || 'GET',
        headers: { ...req.headers },
        // 移除代理相关 header 防止上游出问题
      },
      (proxyRes) => {
        // 过滤掉 hop-by-hop headers
        const filteredHeaders = { ...proxyRes.headers }
        delete filteredHeaders['proxy-connection']
        delete filteredHeaders['keep-alive']
        delete filteredHeaders['transfer-encoding']
        delete filteredHeaders['te']
        delete filteredHeaders['connection']
        delete filteredHeaders['upgrade']

        res.writeHead(proxyRes.statusCode || 200, filteredHeaders)
        proxyRes.pipe(res)
      }
    )

    proxyReq.on('error', (err) => {
      console.warn(`[NetCage] ⚠️ HTTP 代理转发失败 ${hostname}: ${err.message}`)
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' })
        res.end(`Proxy Error: ${err.message}`)
      }
    })

    req.pipe(proxyReq)
  }

  /**
   * HTTPS CONNECT 隧道处理
   *
   * 客户端发来：
   *   CONNECT example.com:443 HTTP/1.1
   * 我们验证域名后建立 TCP 隧道。
   */
  private onConnect(req: http.IncomingMessage, clientSocket: Duplex, head: Buffer): void {
    const [hostname, portStr] = (req.url || '').split(':')
    const port = parseInt(portStr, 10) || 443

    // 白名单检查
    if (!isDomainAllowed(hostname, this._whitelist)) {
      clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      clientSocket.end()
      console.log(`[NetCage] 🚫 CONNECT 拦截: ${hostname}:${port}`)
      return
    }

    // 建立到目标服务器的 TCP 连接
    const targetSocket = net.createConnection(port, hostname, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      // 如果有初始数据（head），发送过去
      if (head.length > 0) {targetSocket.write(head)}
      // 双向管道：两边数据互相转发
      targetSocket.pipe(clientSocket, { end: true })
      clientSocket.pipe(targetSocket, { end: true })
    })

    targetSocket.on('error', (err) => {
      console.warn(`[NetCage] ⚠️ CONNECT 隧道失败 ${hostname}:${port}: ${err.message}`)
      clientSocket.end()
    })

    clientSocket.on('error', () => {
      targetSocket.end()
    })

    // 超时保护：长时间无活动则关闭
    ;(clientSocket as net.Socket).setTimeout(30000, () => {
      clientSocket.end()
      targetSocket.end()
    })
  }

  /** 返回 403 拦截响应 */
  private blockRequest(res: http.ServerResponse, hostname: string): void {
    const msg =
      `🚫 被 Lumina 网络铁笼拦截\n\n` +
      `请求目标: ${hostname}\n` +
      `原因: 不在网络白名单中\n\n` +
      `如需放行，请在 Lumina 安全配置中添加 "${hostname}" 到网络白名单。`

    console.log(`[NetCage] 🚫 HTTP 拦截: ${hostname}`)

    res.writeHead(403, {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Lumina-Blocked': 'netcage',
      'X-Lumina-Reason': `domain ${hostname} not in whitelist`,
    })
    res.end(msg)
  }
}

// ═══════════════════════════════════════════════════════════
// 全局单例
// ═══════════════════════════════════════════════════════════

let _globalNetCage: NetCageProxy | null = null

/**
 * 获取全局 NetCageProxy 单例（惰性启动代理服务器）
 *
 * 首次调用时自动分配端口并启动代理。
 * 后续调用复用已启动的实例。
 */
export async function getNetCage(): Promise<NetCageProxy> {
  if (!_globalNetCage) {
    _globalNetCage = new NetCageProxy()
    // 注册进程退出清理
    process.once('exit', () => {
      if (_globalNetCage) {
        _globalNetCage.stop()
        _globalNetCage = null
      }
    })
  }
  if (!_globalNetCage.isActive) {
    await _globalNetCage.start()
  }
  return _globalNetCage
}

/**
 * 重置全局单例（测试用、或配置变更时重建）
 */
export function resetNetCage(): void {
  if (_globalNetCage) {
    _globalNetCage.stop()
    _globalNetCage = null
  }
}

/**
 * 获取当前 NetCage 端口（0 = 未启动）
 * 不触发启动，只查询现有实例的端口
 */
export function getNetCagePort(): number {
  return _globalNetCage?.getPort() || 0
}

// ═══════════════════════════════════════════════════════════
// 方案二：DNS 拦截（预留骨架）
// ═══════════════════════════════════════════════════════════

export class NetCageDns {
  private originalHosts: string = ''
  private active: boolean = false

  /**
   * 在 Windows hosts 文件中注入拦截条目
   *
   * 原理：
   *   将不在白名单的域名写入 %SystemRoot%\System32\drivers\etc\hosts
   *   → 127.0.0.1 <domain>
   *
   * 限制（当前版本跳过）：
   *   1. 需要管理员权限才能修改 hosts 文件
   *   2. 无法处理通配符（*.example.com），需要逐个域名添加
   *   3. 对已缓存的 DNS 无效（需要 ipconfig /flushdns）
   *   4. 可能被安全软件拦截
   *
   * 替代方案（未来）：
   *   启动本地 DNS 服务器（dnsd / dnsmasq），修改系统 DNS 指向自己
   *   但 Windows 上修改系统 DNS 需要管理员权限或手动配置
   */
  async install(_whitelist: string[]): Promise<boolean> {
    console.warn('[NetCage] ⚠️ DNS 拦截方案当前版本未启用（需要管理员权限）')
    return false
  }

  async uninstall(): Promise<void> {
    // 恢复原始 hosts 文件
  }

  get isActive(): boolean {
    return this.active
  }
}
