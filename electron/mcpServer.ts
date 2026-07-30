// ============================================================
// mcpServer.ts — MCP (Model Context Protocol) 集成 (v3.11)
//
// 对标：QwenPaw/CoPaw MCP 体系
//
// MCP 是 Anthropic 提出的 Agent 工具协议标准。
// Lumina 作为 MCP Client，连接外部 MCP Server：
//   - 数据库 (PostgreSQL, SQLite)
//   - 文件系统 (本地/远程)
//   - API (GitHub, Jira, Slack)
//   - 浏览器 (Playwright)
//   - 设计工具 (Figma)
//
// 协议：JSON-RPC 2.0 over stdio/SSE/http
// ============================================================

import * as cp from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import http from 'http'
import https from 'https'

// ═══════════════════════════════════════════════════════════
// 命令解析 — 修复 npx/uvx 等工具在 Electron 子进程中找不到的问题
// ═══════════════════════════════════════════════════════════

/** 尝试解析命令的完整路径 */
function resolveCommand(command: string): string {
  // 如果已经是完整路径，直接返回
  if (path.isAbsolute(command) && fs.existsSync(command)) return command

  const isWindows = process.platform === 'win32'
  const cmdExt = isWindows ? '.cmd' : ''

  // 常见 Node.js 工具路径
  const knownTools: Record<string, string[]> = {
    npx: isWindows
      ? [path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'npx.cmd'),
         path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'npx.cmd'),
         path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'nodejs', 'npx.cmd')]
      : ['/usr/local/bin/npx', '/usr/bin/npx', path.join(os.homedir(), '.npm-global', 'bin', 'npx')],
    uvx: isWindows
      ? [path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'uvx.cmd'),
         path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python311',
                   'Scripts', 'uvx.exe')]
      : ['/usr/local/bin/uvx', '/usr/bin/uvx'],
    node: isWindows
      ? [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe')]
      : ['/usr/local/bin/node', '/usr/bin/node'],
  }

  const toolName = path.basename(command, cmdExt)
  const candidates = knownTools[toolName] || []

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }

  // 尝试 which/where
  try {
    const resolved = cp.execSync(
      isWindows ? `where "${command}"` : `which "${command}"`,
      { encoding: 'utf-8', timeout: 3000 },
    ).trim().split('\n')[0].trim()
    if (resolved && fs.existsSync(resolved)) return resolved
  } catch { /* ignore */ }

  // 找不到就返回原命令，让 spawn 去报错
  return command
}

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

export interface MCPServerConfig {
  id: string
  name: string
  command?: string          // stdio 模式：启动命令
  args?: string[]           // 命令参数
  url?: string              // SSE/http 模式：端点 URL
  env?: Record<string, string>  // 环境变量
  autoStart?: boolean
  description?: string
}

export interface MCPTool {
  name: string
  description: string
  inputSchema: Record<string, any>
}

export interface MCPToolResult {
  content: Array<{ type: 'text' | 'image'; text?: string; data?: string }>
  isError?: boolean
}

interface JSONRPCRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: any
}

interface JSONRPCResponse {
  jsonrpc: '2.0'
  id: number
  result?: any
  error?: { code: number; message: string }
}

// ═══════════════════════════════════════════════════════════
// MCP 客户端
// ═══════════════════════════════════════════════════════════

export class MCPClient {
  private servers: Map<string, MCPServerConfig> = new Map()
  private connections: Map<string, cp.ChildProcess> = new Map()
  private tools: Map<string, MCPTool[]> = new Map()
  private requestId = 0
  private configPath: string

  constructor(configDir?: string) {
    this.configPath = path.join(configDir || path.join(os.homedir(), '.lumina'), 'mcp_servers.json')
    this.loadConfig()
  }

  // ═══════════════════════════════════════════════════════
  // 服务器管理
  // ═══════════════════════════════════════════════════════

  getServers(): MCPServerConfig[] {
    return Array.from(this.servers.values())
  }

  addServer(config: MCPServerConfig): void {
    this.servers.set(config.id, config)
    this.saveConfig()
    if (config.autoStart) this.connect(config.id).catch(() => {})
  }

  removeServer(id: string): void {
    this.disconnect(id)
    this.servers.delete(id)
    this.tools.delete(id)
    this.saveConfig()
  }

  // ═══════════════════════════════════════════════════════
  // 连接管理
  // ═══════════════════════════════════════════════════════

  async connect(id: string): Promise<{ success: boolean; tools?: MCPTool[]; error?: string }> {
    const config = this.servers.get(id)
    if (!config) return { success: false, error: '服务器未配置' }

    try {
      if (config.command) {
        return this.connectStdio(id, config)
      } else if (config.url) {
        return this.connectHttp(id, config)
      }
      return { success: false, error: '无连接方式' }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  }

  private async connectStdio(id: string, config: MCPServerConfig): Promise<{ success: boolean; tools?: MCPTool[]; error?: string }> {
    // 解析命令完整路径，修复 Electron 子进程中 npx/uvx ENOENT
    const resolvedCmd = resolveCommand(config.command!)
    if (resolvedCmd !== config.command) {
      console.log(`[MCP] 解析命令 "${config.command}" → "${resolvedCmd}"`)
    }

    let child: cp.ChildProcess
    try {
      // Windows 上路径含空格时必须用 shell 模式
      const needsShell = process.platform === 'win32' && (
        resolvedCmd.includes(' ') || resolvedCmd === config.command
      )
      child = cp.spawn(resolvedCmd, config.args || [], {
        env: { ...process.env, ...config.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: needsShell,
      })
    } catch (err: any) {
      console.warn(`[MCP] Cannot spawn "${config.command}": ${err.message}`)
      return { success: false }
    }

    // ⚠️ cp.spawn does NOT throw on ENOENT — it emits 'error' asynchronously.
    // Without this handler, the unhandled 'error' event crashes the main process.
    let spawnError: string | null = null
    child.on('error', (err) => {
      spawnError = err.message
      console.warn(`[MCP] Spawn error "${config.command}": ${err.message}`)
      // 额外提示 — 引导用户检查 Node.js 安装
      if ((err as any).code === 'ENOENT') {
        console.warn(`[MCP] 提示: 请确认 "${config.command}" 已安装且在 PATH 中`)
        console.warn(`[MCP] Node.js 下载: https://nodejs.org/`)
      }
    })

    this.connections.set(id, child)

    // Give the error event one tick to fire before proceeding
    await new Promise<void>(resolve => setImmediate(resolve))
    if (spawnError) {
      this.connections.delete(id)
      return { success: false, error: spawnError }
    }

    // 初始化握手
    try {
      const initResult = await this.sendStdio(id, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'Lumina', version: '3.11.0' },
      })

      if (!initResult || initResult.error) {
        this.disconnect(id)
        return { success: false }
      }

      // 获取工具列表
      const toolsResult = await this.sendStdio(id, 'tools/list', {})
      const tools: MCPTool[] = toolsResult?.tools || []
      this.tools.set(id, tools)

      return { success: true, tools }
    } catch (err: any) {
      this.disconnect(id)
      return { success: false }
    }
  }

  private async connectHttp(id: string, config: MCPServerConfig): Promise<{ success: boolean; tools?: MCPTool[] }> {
    // SSE 模式：先建立连接获取 session
    const endpoint = config.url!
    const response = await this.httpJsonRpc(endpoint, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'Lumina', version: '3.11.0' },
    })

    if (!response || response.error) return { success: false }

    const toolsResult = await this.httpJsonRpc(endpoint, 'tools/list', {})
    const tools: MCPTool[] = toolsResult?.tools || []
    this.tools.set(id, tools)

    return { success: true, tools }
  }

  disconnect(id: string): void {
    const child = this.connections.get(id)
    if (child) {
      child.kill()
      this.connections.delete(id)
    }
  }

  // ═══════════════════════════════════════════════════════
  // 工具调用
  // ═══════════════════════════════════════════════════════

  async callTool(serverId: string, toolName: string, args: Record<string, any> = {}): Promise<MCPToolResult> {
    const config = this.servers.get(serverId)
    if (!config) return { content: [{ type: 'text', text: `❌ MCP Server "${serverId}" 未配置` }], isError: true }

    try {
      let result: any
      if (config.command) {
        result = await this.sendStdio(serverId, 'tools/call', { name: toolName, arguments: args })
      } else if (config.url) {
        result = await this.httpJsonRpc(config.url, 'tools/call', { name: toolName, arguments: args })
      } else {
        return { content: [{ type: 'text', text: '❌ 无连接' }], isError: true }
      }

      if (result?.error) {
        return { content: [{ type: 'text', text: `❌ ${result.error.message || '调用失败'}` }], isError: true }
      }

      return result as MCPToolResult
    } catch (err: any) {
      return { content: [{ type: 'text', text: `❌ ${err.message}` }], isError: true }
    }
  }

  async getTools(serverId: string): Promise<MCPTool[]> {
    return this.tools.get(serverId) || []
  }

  async getAllTools(): Promise<{ serverId: string; tools: MCPTool[] }[]> {
    const result: { serverId: string; tools: MCPTool[] }[] = []
    for (const [id, tools] of this.tools) {
      result.push({ serverId: id, tools })
    }
    return result
  }

  // ═══════════════════════════════════════════════════════
  // 内置 MCP Server 模板
  // ═══════════════════════════════════════════════════════

  async installBuiltinServer(type: 'filesystem' | 'sqlite' | 'github' | 'playwright' | 'fetch'): Promise<MCPServerConfig> {
    const builtins: Record<string, MCPServerConfig> = {
      filesystem: {
        id: 'builtin-filesystem',
        name: '文件系统',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', os.homedir()],
        description: '安全访问本地文件系统',
        autoStart: true,
      },
      sqlite: {
        id: 'builtin-sqlite',
        name: 'SQLite 数据库',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-sqlite', path.join(os.homedir(), '.lumina', 'data.db')],
        description: 'SQLite 数据库查询',
        autoStart: false,
      },
      github: {
        id: 'builtin-github',
        name: 'GitHub API',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_TOKEN || '' },
        description: 'GitHub 仓库管理、Issue、PR',
        autoStart: false,
      },
      playwright: {
        id: 'builtin-playwright',
        name: 'Playwright 浏览器',
        command: 'npx',
        args: ['-y', '@anthropic-research/mcp-server-playwright'],
        description: '无头浏览器自动化',
        autoStart: false,
      },
      fetch: {
        id: 'builtin-fetch',
        name: 'HTTP 请求',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-fetch'],
        description: 'HTTP GET/POST 请求',
        autoStart: true,
      },
    }

    const config = builtins[type]
    if (config) {
      this.addServer(config)
      if (config.autoStart) {
        await this.connect(config.id)
      }
    }
    return config
  }

  // ═══════════════════════════════════════════════════════
  // 生成 LLM 上下文 (工具列表)
  // ═══════════════════════════════════════════════════════

  generateToolsContext(): string {
    const all = this.getAllToolsSync()
    if (all.length === 0) return ''

    return all.map(({ serverId, tools }) => `
## MCP Server: ${serverId}
${tools.map(t => `- **${t.name}**: ${t.description}
  输入: ${JSON.stringify(t.inputSchema.properties || {})}`).join('\n')}
`).join('\n')
  }

  private getAllToolsSync(): { serverId: string; tools: MCPTool[] }[] {
    const result: { serverId: string; tools: MCPTool[] }[] = []
    for (const [id, tools] of this.tools) {
      result.push({ serverId: id, tools })
    }
    return result
  }

  // ═══════════════════════════════════════════════════════
  // JSON-RPC 传输层
  // ═══════════════════════════════════════════════════════

  private async sendStdio(serverId: string, method: string, params?: any): Promise<any> {
    const child = this.connections.get(serverId)
    if (!child) throw new Error(`Server "${serverId}" 未连接`)

    const request: JSONRPCRequest = {
      jsonrpc: '2.0',
      id: ++this.requestId,
      method,
      params,
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('MCP 响应超时'))
      }, 30000)

      let buffer = ''
      const onData = (data: Buffer) => {
        buffer += data.toString()
        // MCP 使用 \n 分隔消息
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const response: JSONRPCResponse = JSON.parse(line)
            if (response.id === request.id) {
              clearTimeout(timeout)
              child.stdout?.removeListener('data', onData)
              resolve(response.result)
            }
          } catch { /* 不完整的 JSON，继续等待 */ }
        }
      }

      child.stdout?.on('data', onData)
      child.stdin?.write(JSON.stringify(request) + '\n')
    })
  }

  private async httpJsonRpc(url: string, method: string, params?: any): Promise<any> {
    const request: JSONRPCRequest = {
      jsonrpc: '2.0',
      id: ++this.requestId,
      method,
      params,
    }

    const body = JSON.stringify(request)
    const isHttps = url.startsWith('https:')
    const transport = isHttps ? https : http
    const parsed = new URL(url)

    return new Promise((resolve, reject) => {
      const req = transport.request({
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body).toString(),
        },
        timeout: 15000,
      }, (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => {
          try {
            const response: JSONRPCResponse = JSON.parse(data)
            resolve(response.result)
          } catch (e) { reject(e) }
        })
      })
      req.on('error', reject)
      req.on('timeout', () => { req.destroy(); reject(new Error('HTTP timeout')) })
      req.write(body)
      req.end()
    })
  }

  // ═══════════════════════════════════════════════════════
  // 配置持久化
  // ═══════════════════════════════════════════════════════

  private loadConfig(): void {
    try {
      if (fs.existsSync(this.configPath)) {
        const data = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'))
        for (const s of data.servers || []) {
          this.servers.set(s.id, s)
        }
      }
    } catch { /* 首次运行 */ }
  }

  private saveConfig(): void {
    const dir = path.dirname(this.configPath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(this.configPath, JSON.stringify({
      servers: Array.from(this.servers.values()),
      updatedAt: new Date().toISOString(),
    }, null, 2))
  }
}

// ═══════════════════════════════════════════════════════════
// 单例
// ═══════════════════════════════════════════════════════════

let _instance: MCPClient | null = null

export function initMCPClient(configDir?: string): MCPClient {
  _instance = new MCPClient(configDir)
  return _instance
}

export function getMCPClient(): MCPClient {
  if (!_instance) _instance = new MCPClient()
  return _instance
}
