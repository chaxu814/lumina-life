// ============================================================
// toolExecutor.ts — 工具执行编排 (v7.0)
//
// 从 agentRunner.ts 提取的工具执行编排逻辑：
//   - 工具集选择与解析
//   - 工具调用执行与结果收集
//   - 搜索预处理与内容收集
//
// 保持独立可测试。
// ============================================================

import type { AgentRunConfig, AgentMessage } from './tools/types'
import type { ToolDef } from './tools/types'
import { getToolsetTools, toOpenAIFunctions, getToolDef, executeToolWithRetry } from './tools/registry'
import { webSearch } from './tools/impl/search'
import { extractUrls, collectUrls, saveCollected } from './tools/impl/contentCollector'
import { getAsyncTaskManager, type AsyncTask } from './asyncTaskManager'

// ═══════════════════════════════════════════════════════════
// 工具集解析
// ═══════════════════════════════════════════════════════════

export interface ToolsetInfo {
  /** 工具定义列表 */
  toolDefs: ToolDef[]
  toolsetName: string
}

/**
 * 根据配置解析可用的工具集
 */
export function resolveToolsets(config: AgentRunConfig): ToolsetInfo {
  let toolDefs: ToolDef[] = []
  let toolsetName = config.mode || 'agent'

  // 按 mode 选择
  switch (config.mode) {
    case 'chat':
      toolDefs = getToolsetTools('chat')
      break
    case 'developer':
      toolsetName = 'developer'
      toolDefs = getToolsetTools('developer')
      if (toolDefs.length === 0) {
        toolDefs = getToolsetTools('agent')
      }
      break
    default:
      toolDefs = getToolsetTools('agent')
      break
  }

  return { toolDefs, toolsetName }
}

/**
 * 将工具定义列表转换为 OpenAI 函数格式
 */
export function buildOpenAITools(tools: ToolDef[]): any[] {
  return tools
    .map(t => toOpenAIFunctions([t]))
    .flat()
    .filter(Boolean)
}

// ═══════════════════════════════════════════════════════════
// 工具执行
// ═══════════════════════════════════════════════════════════

export interface ToolCallResult {
  name: string
  args: Record<string, any>
  result: { ok: boolean; content?: string; error?: string }
  durationMs: number
  id: string
}

/**
 * 执行单个工具调用并返回结构化结果
 */
export async function executeToolCall(
  name: string,
  args: Record<string, any>,
  timeoutMs?: number,
): Promise<ToolCallResult> {
  const start = Date.now()
  const result = await executeToolWithRetry(name, args, timeoutMs ? { timeoutMs } : undefined)
  return {
    name,
    args,
    result: { ok: result.ok, content: result.content, error: result.error },
    durationMs: Date.now() - start,
    id: result.callId || '',
  }
}

/**
 * 🆕 将工具调用包装为异步后台任务提交到 AsyncTaskManager
 * 
 * 适用于长耗时工具（如 deep research、批量文件处理、长时间渲染等）。
 * 返回任务 ID，调用方可通过 taskManager 查询进度/取消。
 */
export async function executeToolCallAsync(
  name: string,
  args: Record<string, any>,
  options: {
    title?: string
    tags?: string[]
    timeoutMs?: number
    workspacePath?: string
  } = {},
): Promise<{ taskId: string; task: AsyncTask }> {
  const taskManager = getAsyncTaskManager()
  
  // 构建一个简单的 prompt，让 AgentRunner 执行该工具
  // 注意：这里构造的是"执行单个工具"的任务描述
  const prompt = `请执行工具 ${name}，参数：${JSON.stringify(args)}`
  
  const config: AgentRunConfig = {
    mode: 'agent',
    personaId: 'lumina',
    model: '',
    baseUrl: '',
    apiKey: '',
    skipApproval: true,
    isChildAgent: true,
    disabledTools: [], // 允许执行该工具
  } as any

  const taskId = taskManager.submit(prompt, config, {
    title: options.title || `工具: ${name}`,
    tags: options.tags || [name, 'tool-async'],
    workspacePath: options.workspacePath,
  })

  const task = taskManager.get(taskId)!
  
  return {
    taskId,
    task,
  }
}

// ═══════════════════════════════════════════════════════════
// 搜索预处理
// ═══════════════════════════════════════════════════════════

/**
 * 检测搜索意图并执行搜索预处理
 * 返回搜索结果文本，或 null（无需搜索）
 */
export async function preExecuteSearch(text: string): Promise<string | null> {
  const searchPatterns = [
    /^(搜|搜索|查|查找|找|百度|谷歌|bing|查一下|搜索一下|帮我搜|帮我查)/,
    /^(search|find|look up|google|bing|what is|who is|how to|tell me about)/i,
    /[？?]/.test(text) && text.length < 100 ? /.*/ : null,
  ]

  const shouldSearch = searchPatterns.some(p => p && p.test(text.trim()))
  if (!shouldSearch) return null

  const query = text.trim()
    .replace(/^(搜|搜索|查|查找|找|百度|谷歌|bing|查一下|搜索一下|帮我搜|帮我查)\s*/i, '')
    .replace(/^(search|find|look up|google|bing|what is|who is|how to|tell me about)\s*/i, '')
    .trim()

  if (!query || query.length < 2) return null

  const searchCount = 5
  const result: any = await webSearch({ query, engine: 'bing', count: searchCount })
  // webSearch 返回 ToolResult，取 content 字段
  return typeof result === 'string' ? result : (result?.content || null)
}

/**
 * 检测 URL 并执行内容收集预处理
 */
export async function preExecuteCollect(text: string): Promise<string | null> {
  const urls = extractUrls(text)
  if (urls.length === 0) return null

  const result: any = await collectUrls(urls, 5000, 40000)
  if (!result) return null

  try {
    return await saveCollected(result)
  } catch {
    return String(result).slice(0, 2000) || null
  }
}
