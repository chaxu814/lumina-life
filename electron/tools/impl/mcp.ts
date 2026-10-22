// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tools/impl/mcp.ts — MCP (Model Context Protocol) 客户端
//
// P1 改进: 支持连接外部 MCP 服务器，扩展工具生态
//
// MCP 协议通过 stdio 与服务器通信，支持:
//   - tools/list: 列出服务器提供的工具
//   - tools/call: 调用服务器工具
//   - resources/list: 列出资源
//   - resources/read: 读取资源
// ============================================================

import { spawn, ChildProcess } from 'child_process'
import type { ToolDef, ToolResult } from '../types'
import { mcpInitializeHandshake } from '../../mcpProtocol'

// ═══════════════════════════════════════════════════════════
// MCP 客户端核心
// ═══════════════════════════════════════════════════════════

interface MCPServerConfig {
  name: string
  command: string
  args: string[]
  env?: Record<string, string>
  cwd?: string
}

interface MCPResponse {
  jsonrpc: '2.0'
  id?: number
  result?: any
  error?: { code: number; message: string; data?: any }
}

interface MCPTool {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, any>
    required?: string[]
  }
}

type MCPToolResult = Array<{
  type: 'text' | 'image' | 'resource'
  text?: string
  data?: string
  mimeType?: string
}>

class MCPClient {
  private config: MCPServerConfig
  private process: ChildProcess | null = null
  private buffer = ''
  private resolveMap = new Map<number, (resp: MCPResponse) => void>()
  private idCounter = 0
  private tools: MCPTool[] = []
  private connected = false
  private connectError = ''

  constructor(config: MCPServerConfig) {
    this.config = config
  }

  async connect(): Promise<void> {
    if (this.connected) {return}

    return new Promise((resolve, reject) => {
      try {
        this.process = spawn(this.config.command, this.config.args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, ...this.config.env },
          cwd: this.config.cwd,
        })
      } catch (err: any) {
        // Synchronous spawn failure (invalid args etc.)
        this.connectError = err.message
        return reject(err)
      }

      this.process.stdout?.on('data', (data: Buffer) => {
        this.buffer += data.toString()

        // MCP 使用换行分隔的 JSON-RPC
        const lines = this.buffer.split('\n')
        this.buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.trim()) {continue}
          try {
            const resp: MCPResponse = JSON.parse(line)
            if (resp.id && this.resolveMap.has(resp.id)) {
              this.resolveMap.get(resp.id)!(resp)
              this.resolveMap.delete(resp.id)
            }
          } catch { /* ignore malformed JSON */ }
        }
      })

      this.process.stderr?.on('data', (data: Buffer) => {
        console.error(`[MCP:${this.config.name}] stderr:`, data.toString().trim())
      })

      this.process.on('error', (err) => {
        this.connectError = err.message
        this.connected = false
        reject(err)
      })

      this.process.on('close', (code) => {
        this.connected = false
        console.log(`[MCP:${this.config.name}] 进程退出: ${code}`)
      })

      // 发送 initialize 请求（版本协商 + 降级重试，见 mcpProtocol.ts）
      const timeout = setTimeout(() => {
        reject(new Error(`MCP 服务器 "${this.config.name}" 连接超时`))
      }, 10000)

      mcpInitializeHandshake(this.config.name, (protocolVersion) =>
        this.sendRequest('initialize', {
          protocolVersion,
          capabilities: { tools: {} },
          clientInfo: { name: 'lumina-mcp-client', version: '1.0.0' },
        }),
      ).then((handshake) => {
        clearTimeout(timeout)
        if (!handshake.ok) {
          reject(new Error(`MCP 服务器 "${this.config.name}" 握手失败：协议版本不被接受`))
          return
        }
        this.connected = true
        console.log(`[MCP:${this.config.name}] 已连接`)
        resolve()
      }).catch((err) => {
        clearTimeout(timeout)
        reject(err)
      })
    })
  }

  private async sendRequest(method: string, params?: any): Promise<any> {
    const id = ++this.idCounter
    const request = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'

    return new Promise((resolve, reject) => {
      this.resolveMap.set(id, resolve)

      const timeout = setTimeout(() => {
        this.resolveMap.delete(id)
        reject(new Error(`MCP 请求超时: ${method}`))
      }, 30000)

      this.process?.stdin?.write(request, (err) => {
        if (err) {
          clearTimeout(timeout)
          this.resolveMap.delete(id)
          reject(err)
        }
      })

      // resolve 会在 stdout 数据处理器中触发
      const origResolve = resolve
      this.resolveMap.set(id, (resp: MCPResponse) => {
        clearTimeout(timeout)
        if (resp.error) {reject(new Error(resp.error.message))}
        else {origResolve(resp.result)}
      })
    })
  }

  async listTools(): Promise<MCPTool[]> {
    if (!this.connected) {await this.connect()}
    const result = await this.sendRequest('tools/list')
    this.tools = result?.tools || []
    return this.tools
  }

  async callTool(name: string, args: Record<string, any>): Promise<MCPToolResult> {
    if (!this.connected) {await this.connect()}
    const result = await this.sendRequest('tools/call', { name, arguments: args })
    return result?.content || []
  }

  isConnected(): boolean {
    return this.connected
  }

  getServerName(): string {
    return this.config.name
  }

  disconnect(): void {
    if (this.process && !this.process.killed) {
      this.process.kill()
    }
    this.connected = false
  }
}

// ═══════════════════════════════════════════════════════════
// MCP 服务器管理器 (单例)
// ═══════════════════════════════════════════════════════════

class MCPServerManager {
  private servers = new Map<string, MCPClient>()
  private serverConfigs = new Map<string, MCPServerConfig>()

  /** 注册 MCP 服务器配置 */
  registerServer(config: MCPServerConfig): void {
    this.serverConfigs.set(config.name, config)
  }

  /** 列出已注册的服务器 */
  listServers(): MCPServerConfig[] {
    return Array.from(this.serverConfigs.values())
  }

  /** 连接指定服务器 */
  async connectServer(name: string): Promise<{ ok: boolean; error?: string; tools?: string[] }> {
    const config = this.serverConfigs.get(name)
    if (!config) {return { ok: false, error: `未知 MCP 服务器: ${name}` }}

    try {
      const client = new MCPClient(config)
      await client.connect()
      this.servers.set(name, client)

      const tools = await client.listTools()
      console.log(`[MCP:${name}] 发现 ${tools.length} 个工具:`, tools.map((t) => t.name))

      return {
        ok: true,
        tools: tools.map((t) => t.name),
      }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  }

  /** 断开服务器 */
  disconnectServer(name: string): void {
    const client = this.servers.get(name)
    if (client) {
      client.disconnect()
      this.servers.delete(name)
    }
  }

  /** 获取已连接服务器的工具列表 */
  async getAllTools(): Promise<Array<{ server: string; tool: MCPTool }>> {
    const allTools: Array<{ server: string; tool: MCPTool }> = []
    for (const [name, client] of this.servers) {
      if (client.isConnected()) {
        try {
          const tools = await client.listTools()
          for (const tool of tools) {
            allTools.push({ server: name, tool })
          }
        } catch (err) {
          console.error(`[MCP:${name}] 获取工具失败:`, err)
        }
      }
    }
    return allTools
  }

  /** 调用指定服务器的工具 */
  async callTool(serverName: string, toolName: string, args: Record<string, any>): Promise<{ ok: boolean; content: string; error?: string }> {
    const client = this.servers.get(serverName)
    if (!client) {
      // 尝试自动连接
      const result = await this.connectServer(serverName)
      if (!result.ok) {return { ok: false, content: '', error: `MCP 服务器 "${serverName}" 未连接: ${result.error}` }}
    }

    try {
      const result = await this.servers.get(serverName)!.callTool(toolName, args)
      const text = result
        .filter((item) => item.type === 'text')
        .map((item) => item.text || '')
        .join('\n')
      return { ok: true, content: text || '(空结果)' }
    } catch (err: any) {
      return { ok: false, content: '', error: err.message }
    }
  }

  /** 清理所有连接 */
  disconnectAll(): void {
    for (const [, client] of this.servers) {
      client.disconnect()
    }
    this.servers.clear()
  }
}

export const mcpManager = new MCPServerManager()

// ═══════════════════════════════════════════════════════════
// 工具定义 + 实现
// ═══════════════════════════════════════════════════════════

export const mcpListServersDef: ToolDef = {
  name: 'mcp_list_servers',
  description: '列出所有已配置的 MCP 服务器及其状态。MCP 服务器可以扩展更多工具能力。',
  params: {},
  toolsets: ['mcp'],
}

export async function mcpListServers(_args: Record<string, any>): Promise<ToolResult> {
  const servers = mcpManager.listServers()
  if (servers.length === 0) {
    return {
      callId: '',
      ok: true,
      content: '当前没有配置 MCP 服务器。\n\n使用方法:\n  1. 编辑配置文件添加 MCP 服务器\n  2. 调用 mcp_connect 连接服务器\n  3. 调用 mcp_call_tool 使用其工具',
    }
  }
  const lines = servers.map((s) => `- ${s.name}: ${s.command} ${s.args.join(' ')}`)
  return { callId: '', ok: true, content: `已配置 ${servers.length} 个 MCP 服务器:\n${lines.join('\n')}` }
}

export const mcpConnectDef: ToolDef = {
  name: 'mcp_connect',
  description: '连接到指定的 MCP 服务器。连接后可获取该服务器提供的额外工具。',
  params: {
    server_name: { type: 'string', description: 'MCP 服务器名称', required: true },
  },
  toolsets: ['mcp'],
}

export async function mcpConnect(args: Record<string, any>): Promise<ToolResult> {
  const name = args.server_name || ''
  const result = await mcpManager.connectServer(name)
  if (!result.ok) {
    return { callId: '', ok: false, content: '', error: result.error }
  }
  return {
    callId: '',
    ok: true,
    content: `✅ 已连接到 MCP 服务器 "${name}"\n可用工具: ${(result.tools || []).join(', ') || '无'}`,
  }
}

export const mcpListToolsDef: ToolDef = {
  name: 'mcp_list_tools',
  description: '列出所有已连接 MCP 服务器提供的工具。用于发现可用的扩展能力。',
  params: {
    server_name: { type: 'string', description: '可选: 指定服务器名称，不指定则列出所有' },
  },
  toolsets: ['mcp'],
}

export async function mcpListTools(args: Record<string, any>): Promise<ToolResult> {
  const serverName = args.server_name
  const allTools = await mcpManager.getAllTools()

  let filtered = allTools
  if (serverName) {
    filtered = allTools.filter((t) => t.server === serverName)
  }

  if (filtered.length === 0) {
    return { callId: '', ok: true, content: '没有已连接的 MCP 服务器或其工具列表为空。请先调用 mcp_connect 连接服务器。' }
  }

  const lines = filtered.map(({ server, tool }) =>
    `[${server}] ${tool.name}: ${tool.description || '(无描述)'}`
  )
  return { callId: '', ok: true, content: `已发现 ${filtered.length} 个 MCP 工具:\n${lines.join('\n')}` }
}

export const mcpCallToolDef: ToolDef = {
  name: 'mcp_call_tool',
  description: '调用已连接 MCP 服务器提供的工具。先用 mcp_connect 连接服务器，用 mcp_list_tools 查看可用工具。',
  params: {
    server_name: { type: 'string', description: 'MCP 服务器名称', required: true },
    tool_name: { type: 'string', description: '要调用的工具名称', required: true },
    arguments: { type: 'string', description: '工具参数 (JSON 字符串)', required: true },
  },
  toolsets: ['mcp'],
}

export async function mcpCallTool(args: Record<string, any>): Promise<ToolResult> {
  const { server_name, tool_name, arguments: argsStr } = args

  let parsedArgs: Record<string, any> = {}
  try {
    parsedArgs = JSON.parse(argsStr || '{}')
  } catch {
    return { callId: '', ok: false, content: '', error: 'arguments 参数必须是有效的 JSON 字符串' }
  }

  const result = await mcpManager.callTool(server_name, tool_name, parsedArgs)
  if (!result.ok) {
    return { callId: '', ok: false, content: '', error: result.error }
  }
  return { callId: '', ok: true, content: result.content }
}
