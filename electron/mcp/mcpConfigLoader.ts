// ============================================================
// mcpConfigLoader.ts — MCP 声明式配置加载器 (v14.0, QwenPaw 风格)
//
// QwenPaw 的做法：在 config.json 的 mcp.clients 下定义 MCP 服务器列表。
// 每个条目声明 transport/command/args/env/cwd，运行时自动连接。
//
// Lumina v14.0: 从 WORKING_DIR/config.json 读取 MCP 服务器配置，
//   与 tools/registry.ts 的 TOOLSETS['mcp'] 联动。
// ============================================================

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

/** MCP 客户端配置格式（兼容 QwenPaw config.json > mcp.clients） */
export interface MCPClientConfig {
  name: string
  description?: string
  enabled?: boolean
  /** 传输协议: stdio | sse | http */
  transport: 'stdio' | 'sse' | 'http'
  /** SSE/http 模式：端点 URL */
  url?: string
  /** HTTP 头部 */
  headers?: Record<string, string>
  /** stdio 模式：启动命令 */
  command?: string
  /** 命令参数 */
  args?: string[]
  /** 环境变量 */
  env?: Record<string, string>
  /** 工作目录 */
  cwd?: string
  /** 工具白名单（null = 全部可用） */
  tools?: string[] | null
  /** OAuth 配置 */
  oauth?: {
    clientId?: string
    clientSecret?: string
    scopes?: string[]
    tokenEndpoint?: string
  } | null
}

/** 聚合配置来源 */
export interface MCPConfigSources {
  /** 全局配置: WORKING_DIR/config.json 中的 mcp.clients */
  global: Record<string, MCPClientConfig>
  /** Agent 级配置: WORKING_DIR/workspaces/<agent_id>/agent.json 中的 mcp */
  agent: Record<string, MCPClientConfig>
}

/** 查找数据根目录 */
function findDataDir(): string {
  // 优先环境变量
  const envDir = process.env.QWENPAW_WORKING_DIR || process.env.COPAW_WORKING_DIR
  if (envDir) {return envDir}

  // 传统 .lumina 目录
  const legacyDir = path.join(os.homedir(), '.lumina')
  if (fs.existsSync(legacyDir)) {return legacyDir}

  // QwenPaw 兼容
  const qpDir = path.join(os.homedir(), '.qwenpaw')
  if (fs.existsSync(qpDir)) {return qpDir}

  const cpDir = path.join(os.homedir(), '.copaw')
  if (fs.existsSync(cpDir)) {return cpDir}

  // 默认
  return legacyDir
}

/** 加载 MCP 配置 */
export function loadMCPConfig(): MCPConfigSources {
  const sources: MCPConfigSources = { global: {}, agent: {} }
  const baseDir = findDataDir()

  // 1. 全局配置
  const globalConfigPath = path.join(baseDir, 'config.json')
  if (fs.existsSync(globalConfigPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(globalConfigPath, 'utf-8'))
      if (raw.mcp?.clients) {
        sources.global = raw.mcp.clients
      }
    } catch { /* 静默 */ }
  }

  // 2. Agent 级配置
  const currentAgentId = process.env.LUMINA_AGENT_ID || 'lumina'
  const agentConfigPath = path.join(baseDir, 'workspaces', currentAgentId, 'agent.json')
  if (fs.existsSync(agentConfigPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(agentConfigPath, 'utf-8'))
      if (raw.mcp?.clients) {
        sources.agent = raw.mcp.clients
      }
    } catch { /* 静默 */ }
  }

  return sources
}

/** 将所有已启用的 MCP 配置转为 mcpServer.ts 可用的连接列表 */
export function getEnabledMCPConnections(): Array<{
  id: string
  name: string
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
}> {
  const sources = loadMCPConfig()
  const result: Array<any> = []

  // Agent 级优先
  for (const [id, cfg] of Object.entries(sources.agent)) {
    if (cfg.enabled !== false) {
      result.push({
        id,
        name: cfg.name || id,
        command: cfg.command,
        args: cfg.args,
        url: cfg.url,
        env: cfg.env,
      })
    }
  }

  // 全局级补充（Agent 级覆盖同名）
  for (const [id, cfg] of Object.entries(sources.global)) {
    if (cfg.enabled !== false && !sources.agent[id]) {
      result.push({
        id,
        name: cfg.name || id,
        command: cfg.command,
        args: cfg.args,
        url: cfg.url,
        env: cfg.env,
      })
    }
  }

  return result
}

/** 检查是否有可用的 MCP 配置 */
export function hasMCPConfig(): boolean {
  return getEnabledMCPConnections().length > 0
}
