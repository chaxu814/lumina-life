// ============================================================
// exposeMcpServer.ts — 把 Lumina 工具注册表对外暴露为 MCP Server (v1.0)
//
// 方向与 electron/mcpServer.ts 相反：那边是 Lumina 作为 Client 连接外部
// MCP Server；这里是把 Lumina 自己的 139 个工具通过 stdio JSON-RPC 暴露给
// 外部 MCP 客户端（Claude Desktop / 任意 MCP host）。
//
// 协议：手写「\n 分隔的 JSON-RPC 2.0」，与 mcpServer.ts 客户端同款，
//   因此不引入 @modelcontextprotocol/sdk（项目未依赖，且约束禁止新增依赖）。
//
// 门控：仅在 --mcp-server 或 LUMINA_MCP_SERVER=1 时由 main.ts 拉起；
//   默认不启动，不建窗口。无 key 也能起——工具本身不依赖付费额度。
//
// 安全：ToolDef.dangerous 的工具默认不暴露；设 LUMINA_MCP_ALLOW_DANGEROUS=1
//   才放开。只读/权限语义沿用 registry 已有标注。
// ============================================================

import { registerAllTools } from '../tools'
import { getAllToolDefs, executeTool } from '../tools/registry'
import type { ToolDef } from '../tools/types'

const SERVER_INFO = { name: 'lumina', version: '0.1.0' }
const PROTOCOL_VERSION = '2024-11-05'

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: number | string | null
  method: string
  /** 外部 JSON 输入，静态无法确定形状；使用处按需收窄 */
  params?: unknown
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id?: number | string | null
  result?: unknown
  error?: { code: number; message: string }
}

/** tools/call 的参数形状（对 JSON.parse 结果做收窄） */
interface ToolsCallParams {
  name?: string
  arguments?: Record<string, unknown>
}

let started = false

/** 把 ToolParamSchema 转成 JSON Schema（def.parameters 缺失时的兜底） */
function paramsToSchema(def: ToolDef): Record<string, unknown> {
  if (def.parameters && Object.keys(def.parameters).length > 0) {
    return def.parameters
  }
  const properties: Record<string, { type: string; description: string; enum?: string[] }> = {}
  const required: string[] = []
  const params = def.params || {}
  for (const [name, p] of Object.entries(params)) {
    properties[name] = { type: p.type || 'string', description: p.description || '' }
    if (p.enum) {properties[name].enum = p.enum}
    if (p.required) {required.push(name)}
  }
  const schema: Record<string, unknown> = { type: 'object', properties }
  if (required.length > 0) {schema.required = required}
  return schema
}

/** 计算本 server 暴露的工具清单（默认排除 dangerous） */
function exposedToolDefs(): ToolDef[] {
  const allowDangerous = process.env.LUMINA_MCP_ALLOW_DANGEROUS === '1'
  return getAllToolDefs().filter(def => allowDangerous || !def.dangerous)
}

function send(res: JsonRpcResponse): void {
  process.stdout.write(JSON.stringify(res) + '\n')
}

function reply(id: JsonRpcRequest['id'], result: unknown): void {
  send({ jsonrpc: '2.0', id, result })
}

function replyError(id: JsonRpcRequest['id'], code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

async function handleRequest(req: JsonRpcRequest): Promise<void> {
  const { id, method, params } = req

  switch (method) {
    case 'initialize': {
      reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      })
      return
    }
    case 'notifications/initialized':
    case 'initialized': {
      // 通知类，无需回包
      return
    }
    case 'ping': {
      reply(id, {})
      return
    }
    case 'tools/list': {
      const tools = exposedToolDefs().map(def => ({
        name: def.name,
        description: def.description,
        inputSchema: paramsToSchema(def),
      }))
      reply(id, { tools })
      return
    }
    case 'tools/call': {
      const callParams = (params ?? {}) as ToolsCallParams
      const name = callParams.name
      const args: Record<string, unknown> = callParams.arguments ?? {}
      if (!name) {
        replyError(id ?? null, -32602, '缺少 name 参数')
        return
      }
      const def = exposedToolDefs().find(d => d.name === name)
      if (!def) {
        reply(id, { content: [{ type: 'text', text: `工具未暴露或不存在: ${name}` }], isError: true })
        return
      }
      try {
        const result = await executeTool(name, args)
        reply(id, {
          content: [{ type: 'text', text: result.ok ? (result.content || '(无输出)') : `❌ ${result.error || result.content || '执行失败'}` }],
          isError: !result.ok,
        })
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        reply(id, { content: [{ type: 'text', text: `❌ ${msg}` }], isError: true })
      }
      return
    }
    case 'shutdown':
    case 'exit': {
      reply(id, { ok: true })
      setTimeout(() => process.exit(0), 50)
      return
    }
    default: {
      // 未知方法：MCP host 会探测，回 method not found，不崩
      replyError(id ?? null, -32601, `未知方法: ${method}`)
    }
  }
}

/**
 * 启动 MCP stdio server。幂等；重复调用直接返回。
 * 在 main.ts 的 --mcp-server / LUMINA_MCP_SERVER=1 分支里调用。
 */
export function startExposedMcpServer(): void {
  if (started) {return}
  started = true

  // stdout 是 JSON-RPC 通道，必须纯净：所有日志/工具打印改走 stderr
  const toStderr = (level: 'log' | 'warn' | 'error') => (...args: unknown[]) => {
    process.stderr.write(`[${level}] ` + args.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n')
  }
  console.log = toStderr('log')
  console.warn = toStderr('warn')
  console.error = toStderr('error')

  // 注册全部工具（幂等）
  registerAllTools()

  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) {continue}
      let req: JsonRpcRequest
      try {
        req = JSON.parse(trimmed)
      } catch {
        continue
      }
      // 通知类请求（无 id）不回包，但仍要执行；用 .catch 防止未处理 rejection
      handleRequest(req).catch((err: unknown) => {
        if (req.id !== undefined && req.id !== null) {
          const msg = err instanceof Error ? err.message : String(err)
          replyError(req.id, -32000, msg)
        }
      })
    }
  })
  process.stdin.on('end', () => process.exit(0))

  // 启动完成提示走 stderr（host 一般不读）
  process.stderr.write(`[lumina-mcp] stdio server ready, exposing ${exposedToolDefs().length} tools\n`)
}
