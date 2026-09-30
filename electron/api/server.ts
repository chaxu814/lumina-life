// ============================================================
// api/server.ts — Lumina Life REST API 服务器 (v8.0)
//
// 使用 Node.js 内置 http 模块，零额外依赖。
// 在 Electron 主进程中启动，可选 --api 参数或配置开启。
//
// 端点:
//   GET    /api/health        — 健康检查
//   POST   /api/chat          — 发送消息给 Agent
//   POST   /api/tools/execute — 执行工具
//   GET    /api/agents        — 列出 Agent
//   GET    /api/memory/search — 搜索记忆
//   GET    /api/memory        — 列出记忆
//   GET    /api/skills        — 列出技能
//   GET    /api/config        — 获取配置
//   PUT    /api/config        — 更新配置
//   GET    /api/cron          — 列出定时任务
//   POST   /api/cron          — 创建定时任务
//   DELETE /api/cron/:id      — 删除定时任务
// ============================================================

import * as http from 'http'
import * as url from 'url'
import * as crypto from 'crypto'

import { handleChatRoute } from './routes/chat'
import { handleToolsRoute } from './routes/tools'
import { handleAgentsRoute } from './routes/agents'
import { handleMemoryRoute } from './routes/memory'
import { handleSkillsRoute } from './routes/skills'
import { handleCronRoute } from './routes/cron'
import { handleConfigRoute } from './routes/config'
import { handleHealthRoute } from './routes/health'
// 🆕 Phase C: 深度调研 API
import { handleDeepResearchRoute, handleDeepResearchStatusRoute } from './routes/deepResearch'
// 🆕 Phase C: 渠道 Webhook API
import {
  handleDingTalkWebhook,
  handleSlackWebhook,
  handleTelegramWebhook,
  handleTelegramWebhookGet,
  handleChannelStatusRoute,
  handleWeChatWebhook,       // 🆕 v16.0-fix
  handleWeChatWebhookGet,   // 🆕 v16.0-fix
  handleQQWebhook,           // 🆕 v14.x: QQ 机器人
} from './routes/channel'

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

export interface ApiConfig {
  enabled: boolean
  port: number
  host: string
  apiKey: string | null
  /**
   * 允许的浏览器 Origin 白名单（CORS）。
   * - 缺省：仅本机 http://127.0.0.1:<port> 与 http://localhost:<port>
   * - 传入 '*'：完全放开（仅在你明确知道风险时使用）
   * - 未命中白名单的 Origin 不会回显 ACAO，浏览器侧即被拦截；
   *   无 Origin 的请求（curl / 命令行）不受影响，照常放行。
   */
  allowedOrigins?: string[]
}

export const DEFAULT_API_CONFIG: ApiConfig = {
  enabled: false,
  port: 3456,
  host: '127.0.0.1',
  apiKey: null,
}

// ═══════════════════════════════════════════════════════════
// 路由表
// ═══════════════════════════════════════════════════════════

interface RouteHandler {
  method: string
  path: RegExp
  handler: (req: http.IncomingMessage, res: http.ServerResponse, match: RegExpExecArray, body: any) => Promise<void>
}

const ROUTES: RouteHandler[] = [
  // 健康检查
  { method: 'GET', path: /^\/api\/health$/, handler: handleHealthRoute },
  { method: 'GET', path: /^\/api\/health\/?$/, handler: handleHealthRoute },

  // 聊天
  { method: 'POST', path: /^\/api\/chat$/, handler: handleChatRoute },
  { method: 'POST', path: /^\/api\/chat\/?$/, handler: handleChatRoute },

  // 工具
  { method: 'POST', path: /^\/api\/tools\/execute$/, handler: handleToolsRoute },
  { method: 'POST', path: /^\/api\/tools\/execute\/?$/, handler: handleToolsRoute },

  // Agent
  { method: 'GET', path: /^\/api\/agents$/, handler: handleAgentsRoute },
  { method: 'GET', path: /^\/api\/agents\/?$/, handler: handleAgentsRoute },
  { method: 'GET', path: /^\/api\/agents\/([^/]+)$/, handler: handleAgentsRoute },

  // 记忆
  { method: 'GET', path: /^\/api\/memory\/search$/, handler: handleMemoryRoute },
  { method: 'GET', path: /^\/api\/memory\/search\/?$/, handler: handleMemoryRoute },
  { method: 'GET', path: /^\/api\/memory$/, handler: handleMemoryRoute },
  { method: 'GET', path: /^\/api\/memory\/?$/, handler: handleMemoryRoute },

  // 技能
  { method: 'GET', path: /^\/api\/skills$/, handler: handleSkillsRoute },
  { method: 'GET', path: /^\/api\/skills\/?$/, handler: handleSkillsRoute },

  // 配置
  { method: 'GET', path: /^\/api\/config$/, handler: handleConfigRoute },
  { method: 'GET', path: /^\/api\/config\/?$/, handler: handleConfigRoute },
  { method: 'PUT', path: /^\/api\/config$/, handler: handleConfigRoute },
  { method: 'PUT', path: /^\/api\/config\/?$/, handler: handleConfigRoute },

  // 定时任务
  { method: 'GET', path: /^\/api\/cron$/, handler: handleCronRoute },
  { method: 'GET', path: /^\/api\/cron\/?$/, handler: handleCronRoute },
  { method: 'POST', path: /^\/api\/cron$/, handler: handleCronRoute },
  { method: 'POST', path: /^\/api\/cron\/?$/, handler: handleCronRoute },
  { method: 'DELETE', path: /^\/api\/cron\/([^/]+)$/, handler: handleCronRoute },

  // 🆕 Phase C: 深度调研
  { method: 'POST', path: /^\/api\/deep-research$/, handler: handleDeepResearchRoute },
  { method: 'POST', path: /^\/api\/deep-research\/?$/, handler: handleDeepResearchRoute },
  { method: 'GET', path: /^\/api\/deep-research$/, handler: handleDeepResearchStatusRoute as any },
  { method: 'GET', path: /^\/api\/deep-research\/?$/, handler: handleDeepResearchStatusRoute as any },

  // 🆕 Phase C: 渠道 Webhook
  { method: 'POST', path: /^\/api\/channel\/dingtalk$/, handler: handleDingTalkWebhook as any },
  { method: 'POST', path: /^\/api\/channel\/dingtalk\/?$/, handler: handleDingTalkWebhook as any },
  { method: 'POST', path: /^\/api\/channel\/slack$/, handler: handleSlackWebhook as any },
  { method: 'POST', path: /^\/api\/channel\/slack\/?$/, handler: handleSlackWebhook as any },
  { method: 'GET', path: /^\/api\/channel\/telegram$/, handler: handleTelegramWebhookGet as any },
  { method: 'GET', path: /^\/api\/channel\/telegram\/?$/, handler: handleTelegramWebhookGet as any },
  { method: 'POST', path: /^\/api\/channel\/telegram$/, handler: handleTelegramWebhook as any },
  { method: 'POST', path: /^\/api\/channel\/telegram\/?$/, handler: handleTelegramWebhook as any },
  { method: 'GET', path: /^\/api\/channels$/, handler: handleChannelStatusRoute as any },
  { method: 'GET', path: /^\/api\/channels\/?$/, handler: handleChannelStatusRoute as any },

  // 企业微信 Webhook
  { method: 'GET', path: /^\/api\/channel\/wechat$/, handler: handleWeChatWebhookGet as any },
  { method: 'GET', path: /^\/api\/channel\/wechat\/?$/, handler: handleWeChatWebhookGet as any },
  { method: 'POST', path: /^\/api\/channel\/wechat$/, handler: handleWeChatWebhook as any },
  { method: 'POST', path: /^\/api\/channel\/wechat\/?$/, handler: handleWeChatWebhook as any },

  // .x: QQ 机器人 Webhook
  { method: 'POST', path: /^\/api\/channel\/qq$/, handler: handleQQWebhook as any },
  { method: 'POST', path: /^\/api\/channel\/qq\/?$/, handler: handleQQWebhook as any },
]

// ═══════════════════════════════════════════════════════════
// API Server
// ═══════════════════════════════════════════════════════════

export class ApiServer {
  private server: http.Server | null = null
  private config: ApiConfig

  constructor(config?: Partial<ApiConfig>) {
    this.config = { ...DEFAULT_API_CONFIG, ...config }
    // CORS 白名单解析优先级：显式传入 > 环境变量 LUMINA_API_ALLOWED_ORIGINS > 本机默认
    if (!this.config.allowedOrigins || this.config.allowedOrigins.length === 0) {
      const envOrigins = process.env.LUMINA_API_ALLOWED_ORIGINS
      if (envOrigins && envOrigins.trim()) {
        this.config.allowedOrigins = envOrigins
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      } else {
        this.config.allowedOrigins = [
          `http://127.0.0.1:${this.config.port}`,
          `http://localhost:${this.config.port}`,
        ]
      }
    }
  }

  get port(): number { return this.config.port }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.server) {
        console.log('[api] 服务器已在运行中')
        resolve()
        return
      }

      this.server = http.createServer((req, res) => this.handleRequest(req, res))

      this.server.listen(this.config.port, this.config.host, () => {
        console.log(`[api] 🌐 REST API 已启动: http://${this.config.host}:${this.config.port}`)
        if (this.config.apiKey) {
          console.log(`[api] 🔑 API Key 认证已启用`)
        }
        resolve()
      })

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          console.error(`[api] ❌ 端口 ${this.config.port} 已被占用`)
          reject(new Error(`端口 ${this.config.port} 已被占用`))
        } else {
          reject(err)
        }
      })
    })
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve()
        return
      }
      this.server.close(() => {
        console.log('[api] 🌐 REST API 已停止')
        this.server = null
        resolve()
      })
    })
  }

  // ── 请求处理 ─────────────────────────────────────────

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // CORS 头（按白名单策略生成）
    this.applyCors(req, res)

    // OPTIONS 预检
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    // API Key 认证
    if (this.config.apiKey && !this.authenticate(req)) {
      this.json(res, 401, { error: 'Unauthorized: 无效的 API Key' })
      return
    }

    // 解析路径
    const parsedUrl = url.parse(req.url || '', true)
    const pathname = parsedUrl.pathname || '/'

    // 解析请求体
    let body: any = null
    if (req.method === 'POST' || req.method === 'PUT') {
      body = await this.parseBody(req)
    }

    // 路由匹配
    for (const route of ROUTES) {
      if (req.method !== route.method) {continue}
      const match = route.path.exec(pathname)
      if (match) {
        try {
          await route.handler(req, res, match, body)
        } catch (err: any) {
          console.error(`[api] 路由处理异常: ${err.message}`)
          this.json(res, 500, { error: `内部错误: ${err.message}` })
        }
        return
      }
    }

    // 404
    this.json(res, 404, { error: `未找到路由: ${req.method} ${pathname}` })
  }

  // ── CORS：按白名单回显 Origin，未命中则不回显 ACAO ─────
  private applyCors(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Authorization')

    // 无 Origin（curl / 命令行 / 非浏览器）：不设置 ACAO，请求照常处理
    const origin = req.headers.origin as string | undefined
    if (!origin) {return}

    const allowed = this.config.allowedOrigins || []
    if (allowed.includes('*')) {
      // 仅当用户显式配置 '*' 时才完全放开
      res.setHeader('Access-Control-Allow-Origin', '*')
      return
    }
    if (allowed.includes(origin)) {
      // 命中白名单：回显具体 Origin，并提示缓存方按 Origin 区分
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
    }
    // 未命中：不设置 ACAO，浏览器侧会拦截该跨域响应
  }

  private authenticate(req: http.IncomingMessage): boolean {
    const key = req.headers['x-api-key'] as string || req.headers['authorization'] as string
    if (!key) {return false}
    // 支持 Bearer token
    const actualKey = key.startsWith('Bearer ') ? key.slice(7) : key
    return actualKey === this.config.apiKey
  }

  private parseBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8')
        if (!raw.trim()) {
          resolve({})
          return
        }
        try {
          resolve(JSON.parse(raw))
        } catch {
          resolve({ _raw: raw })
        }
      })
    })
  }

  private json(res: http.ServerResponse, status: number, data: any): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(data, null, 2))
  }
}

// ═══════════════════════════════════════════════════════════
// 全局单例
// ═══════════════════════════════════════════════════════════

let globalApiServer: ApiServer | null = null

export function getApiServer(): ApiServer {
  if (!globalApiServer) {
    globalApiServer = new ApiServer()
  }
  return globalApiServer
}

export function initApiServer(config?: Partial<ApiConfig>): ApiServer {
  globalApiServer = new ApiServer(config)
  return globalApiServer
}
