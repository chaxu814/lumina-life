// ============================================================
// channels/openclaw/openclawClient.ts — 🔌 OpenClaw 桥接客户端 (v0.1)
//
// 定位：OpenClaw 是「本地通用 Agent 网关 / 执行后端」（手脚与渠道总线），
//       Lumina 不重复造执行层，而是通过本客户端把「硬任务 / 渠道外发」
//       委托给本机或局域网的 OpenClaw Gateway（A2A / MCP 风格 HTTP）。
//
// 设计原则：
//   - 纯 TS、fetch 可注入，便于单测，不直接依赖 Electron；
//   - 未配置 / 连不上 / 超时一律返回 { ok:false, error }，不向上抛穿，
//     调用方据此安全回退到 Lumina 自带实现（可选后端，绝不硬依赖）；
//   - token 只走 Authorization 头，不写日志、不落错误信息。
// ============================================================

/** 最小 fetch 抽象（避免依赖特定 DOM/Node 类型，也便于注入 mock） */
export type FetchLike = (url: string, init?: {
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
}) => Promise<{ ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<any> }>

export interface OpenClawConfig {
  /** Gateway 地址，如 http://127.0.0.1:18789 */
  baseUrl: string
  /** 可选配对 token（pairing），仅放请求头 */
  token?: string
  /** A2A 目标 agent id，可空（用网关默认） */
  agentId?: string
  /** 单次请求超时 ms，默认 15000 */
  timeoutMs?: number
}

export interface OpenClawResult<T = any> {
  ok: boolean
  status?: number
  data?: T
  error?: string
}

export interface OpenClawToolInfo {
  name: string
  description?: string
}

export interface SendTaskInput {
  /** 要 OpenClaw 执行的任务文本 */
  text: string
  /** 回送目标渠道/会话（可选） */
  targetId?: string
  /** 附带上下文（可选） */
  context?: Record<string, any>
}

export class OpenClawClient {
  readonly cfg: Required<Pick<OpenClawConfig, 'baseUrl' | 'timeoutMs'>> & Pick<OpenClawConfig, 'token' | 'agentId'>
  private readonly fetchImpl: FetchLike

  constructor(config: OpenClawConfig, fetchImpl?: FetchLike) {
    this.cfg = {
      baseUrl: (config.baseUrl || '').replace(/\/+$/, ''),
      token: config.token,
      agentId: config.agentId,
      timeoutMs: config.timeoutMs ?? 15000,
    }
    this.fetchImpl = fetchImpl || ((globalThis as any).fetch as FetchLike)
  }

  /** 是否具备最小可用配置（有地址且有可用 fetch） */
  isConfigured(): boolean {
    return !!this.cfg.baseUrl && typeof this.fetchImpl === 'function'
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.cfg.token) h['Authorization'] = `Bearer ${this.cfg.token}`
    return h
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<OpenClawResult<T>> {
    if (!this.isConfigured()) return { ok: false, error: 'openclaw-not-configured' }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs)
    try {
      const res = await this.fetchImpl(`${this.cfg.baseUrl}${path}`, {
        method,
        headers: this.headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
      const raw = await res.text()
      let parsed: any = null
      if (raw) {
        try { parsed = JSON.parse(raw) } catch { parsed = raw }
      }
      if (!res.ok) {
        return { ok: false, status: res.status, error: `openclaw-http-${res.status}` }
      }
      return { ok: true, status: res.status, data: parsed as T }
    } catch (err: any) {
      if (err?.name === 'AbortError') return { ok: false, error: 'openclaw-timeout' }
      return { ok: false, error: 'openclaw-unreachable' }
    } finally {
      clearTimeout(timer)
    }
  }

  /** 健康检查 / 探活 */
  ping(): Promise<OpenClawResult<{ status?: string; version?: string }>> {
    return this.request('GET', '/health')
  }

  /** MCP tools/list：列出 OpenClaw 暴露的工具 */
  listTools(): Promise<OpenClawResult<{ tools: OpenClawToolInfo[] }>> {
    return this.request('POST', '/mcp/tools/list', { jsonrpc: '2.0', id: 1, method: 'tools/list' })
  }

  /** MCP tools/call：调用一个 OpenClaw 工具 */
  callTool(name: string, args: Record<string, any>): Promise<OpenClawResult> {
    return this.request('POST', '/mcp/tools/call', {
      jsonrpc: '2.0', id: Date.now(), method: 'tools/call',
      params: { name, arguments: args || {} },
    })
  }

  /**
   * A2A：把一个任务发给 OpenClaw 执行（Lumina 出大脑、OpenClaw 出手脚）。
   * 失败时返回 ok:false，由调用方回退本地实现。
   */
  sendTask(input: SendTaskInput): Promise<OpenClawResult<{ text?: string; result?: any }>> {
    return this.request('POST', '/a2a/message/send', {
      agentId: this.cfg.agentId,
      message: { role: 'user', text: input.text },
      targetId: input.targetId,
      context: input.context,
    })
  }
}

let _default: OpenClawClient | null = null

/** 配置并设置进程级默认客户端（未配置则传空 baseUrl，调用都会安全返回 not-configured） */
export function configureOpenClaw(config: OpenClawConfig | null, fetchImpl?: FetchLike): OpenClawClient {
  _default = new OpenClawClient(config || { baseUrl: '' }, fetchImpl)
  return _default
}

export function getOpenClaw(): OpenClawClient {
  if (!_default) _default = new OpenClawClient({ baseUrl: '' })
  return _default
}
