// ============================================================
// providerAdapter.ts — 多 Provider 差异化适配层 (v1.0)
//
// 目标：让 Lumina 像 QwenPaw 一样，每个 Provider 有独立的行为适配，
// 而不是所有 Provider 共用一套 OpenAI 兼容 API 调用。
//
// 适配内容：
//   1. 请求体格式差异（OpenAI / Anthropic / DeepSeek / Ollama）
//   2. 工具调用格式差异（native vs XML vs JSON mode）
//   3. 流式解析差异（SSE / JSONL / 纯文本流）
//   4. 错误响应差异（不同 Provider 的错误格式不同）
//   5. Rate Limit 策略差异（各 Provider 的限流数据不同）
//   6. 模型能力检测（哪些模型支持 vision / tools / function calling）
// ============================================================

import { matchProfile, type MatchedProfile, PROVIDER_PROFILES } from '../providerProfiles'

// ═══════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════

export type ProviderKind = 'openai' | 'anthropic' | 'deepseek' | 'ollama' | 'lmstudio' | 'dashscope' | 'siliconflow' | 'zhipu' | 'unknown'

/** Provider 能力表 */
export interface ProviderCapabilities {
  /** 原生支持 function calling */
  nativeFunctionCalling: boolean
  /** 需要 JSON mode 代替 tool calling */
  jsonModeOnly: boolean
  /** 支持 streaming function calling */
  streamFunctionCalling: boolean
  /** 最大工具数量 */
  maxTools: number
  /** 支持 Vision */
  supportsVision: boolean
  /** 支持 system prompt */
  supportsSystemPrompt: boolean
  /** 最大 system prompt tokens */
  maxSystemTokens: number
  /** Rate limit 信息（每分钟请求数 / 每分钟 token 数） */
  rateLimit: { rpm: number; tpm: number }
  /** 是否需要 base64 编码图片 */
  imageEncoding: 'base64' | 'url' | 'none'
  /** 推理 token 路径（用于 thinking/reasoning 面板） */
  reasoningPath: string[]
  /** 超时建议 */
  recommendedTimeout: number
}

/** 请求体转换结果 */
export interface AdaptedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: any
}

/** 工具调用格式转换结果 */
export interface AdaptedToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

// ═══════════════════════════════════════════════════════════
// Provider 能力注册表
// ═══════════════════════════════════════════════════════════

const PROVIDER_CAPABILITIES: Record<ProviderKind, ProviderCapabilities> = {
  openai: {
    nativeFunctionCalling: true,
    jsonModeOnly: false,
    streamFunctionCalling: true,
    maxTools: 128,
    supportsVision: true,
    supportsSystemPrompt: true,
    maxSystemTokens: 4000,
    rateLimit: { rpm: 500, tpm: 200000 },
    imageEncoding: 'base64',
    reasoningPath: ['choices', '0', 'delta', 'reasoning_content'],
    recommendedTimeout: 90,
  },
  anthropic: {
    nativeFunctionCalling: true,
    jsonModeOnly: false,
    streamFunctionCalling: false,
    maxTools: 64,
    supportsVision: true,
    supportsSystemPrompt: true,
    maxSystemTokens: 8000,
    rateLimit: { rpm: 50, tpm: 100000 },
    imageEncoding: 'base64',
    reasoningPath: ['content', '0', 'thinking'],
    recommendedTimeout: 300,
  },
  deepseek: {
    nativeFunctionCalling: true,
    jsonModeOnly: false,
    streamFunctionCalling: true,
    maxTools: 64,
    supportsVision: false,
    supportsSystemPrompt: true,
    maxSystemTokens: 4000,
    rateLimit: { rpm: 500, tpm: 1000000 },
    imageEncoding: 'none',
    reasoningPath: ['choices', '0', 'delta', 'reasoning_content'],
    recommendedTimeout: 120,
  },
  ollama: {
    nativeFunctionCalling: false,
    jsonModeOnly: true,
    streamFunctionCalling: false,
    maxTools: 0,
    supportsVision: true,
    supportsSystemPrompt: true,
    maxSystemTokens: 2000,
    rateLimit: { rpm: 9999, tpm: 999999 },
    imageEncoding: 'base64',
    reasoningPath: [],
    recommendedTimeout: 600,
  },
  lmstudio: {
    nativeFunctionCalling: true,
    jsonModeOnly: false,
    streamFunctionCalling: true,
    maxTools: 32,
    supportsVision: true,
    supportsSystemPrompt: true,
    maxSystemTokens: 4000,
    rateLimit: { rpm: 9999, tpm: 999999 },
    imageEncoding: 'base64',
    reasoningPath: ['choices', '0', 'delta', 'reasoning_content'],
    recommendedTimeout: 600,
  },
  dashscope: {
    nativeFunctionCalling: true,
    jsonModeOnly: false,
    streamFunctionCalling: true,
    maxTools: 128,
    supportsVision: true,
    supportsSystemPrompt: true,
    maxSystemTokens: 6000,
    rateLimit: { rpm: 200, tpm: 500000 },
    imageEncoding: 'url',
    reasoningPath: [],
    recommendedTimeout: 120,
  },
  siliconflow: {
    nativeFunctionCalling: true,
    jsonModeOnly: false,
    streamFunctionCalling: true,
    maxTools: 64,
    supportsVision: true,
    supportsSystemPrompt: true,
    maxSystemTokens: 4000,
    rateLimit: { rpm: 100, tpm: 50000 },
    imageEncoding: 'base64',
    reasoningPath: ['choices', '0', 'delta', 'reasoning_content'],
    recommendedTimeout: 300,
  },
  zhipu: {
    nativeFunctionCalling: true,
    jsonModeOnly: false,
    streamFunctionCalling: true,
    maxTools: 64,
    supportsVision: true,
    supportsSystemPrompt: true,
    maxSystemTokens: 4000,
    rateLimit: { rpm: 100, tpm: 100000 },
    imageEncoding: 'base64',
    reasoningPath: [],
    recommendedTimeout: 120,
  },
  unknown: {
    nativeFunctionCalling: true,
    jsonModeOnly: false,
    streamFunctionCalling: true,
    maxTools: 64,
    supportsVision: false,
    supportsSystemPrompt: true,
    maxSystemTokens: 4000,
    rateLimit: { rpm: 100, tpm: 100000 },
    imageEncoding: 'base64',
    reasoningPath: [],
    recommendedTimeout: 300,
  },
}

// ═══════════════════════════════════════════════════════════
// Provider 识别
// ═══════════════════════════════════════════════════════════

/**
 * 根据 baseUrl 识别 Provider 类型
 */
export function identifyProvider(baseUrl: string): ProviderKind {
  const url = baseUrl.toLowerCase()
  if (url.includes('api.openai') || url.includes('openai.com')) return 'openai'
  if (url.includes('anthropic') || url.includes('claude')) return 'anthropic'
  if (url.includes('deepseek')) return 'deepseek'
  if (url.includes('ollama') || url.includes(':11434')) return 'ollama' // 兼容 127.0.0.1:11434 等等价写法
  if (url.includes('localhost') || url.includes('127.0.0.1')) return 'lmstudio'
  if (url.includes('dashscope')) return 'dashscope'
  if (url.includes('siliconflow')) return 'siliconflow'
  if (url.includes('bigmodel') || url.includes('zhipu')) return 'zhipu'
  return 'unknown'
}

/**
 * 获取 Provider 能力表
 */
export function getProviderCapabilities(baseUrl: string): ProviderCapabilities {
  const kind = identifyProvider(baseUrl)
  return PROVIDER_CAPABILITIES[kind]
}

/**
 * 检查模型是否支持某能力
 */
export function modelSupports(
  baseUrl: string,
  capability: keyof ProviderCapabilities,
): boolean {
  const caps = getProviderCapabilities(baseUrl)
  const value = caps[capability]
  if (typeof value === 'boolean') return value
  return true // 默认安全
}

// ═══════════════════════════════════════════════════════════
// 请求体适配
// ═══════════════════════════════════════════════════════════

export interface RequestAdapterInput {
  baseUrl: string
  apiKey: string
  model: string
  messages: Array<{ role: string; content: string; name?: string; tool_calls?: any[]; tool_call_id?: string }>
  tools?: any[]
  maxTokens?: number
  temperature?: number
  stream?: boolean
}

/**
 * 将通用请求转换为 Provider 特定格式
 */
export function adaptRequestBody(input: RequestAdapterInput): AdaptedRequest {
  const kind = identifyProvider(input.baseUrl)
  const caps = PROVIDER_CAPABILITIES[kind]
  const baseUrl = input.baseUrl.replace(/\/+$/, '')

  // 公共头部
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  if (input.apiKey) {
    // Anthropic 使用 x-api-key，其他使用 Bearer
    if (kind === 'anthropic') {
      headers['x-api-key'] = input.apiKey
      headers['anthropic-version'] = '2023-06-01'
    } else {
      headers['Authorization'] = `Bearer ${input.apiKey}`
    }
  }

  switch (kind) {
    case 'anthropic': {
      // Anthropic 使用 /v1/messages 端点，独立格式
      return {
        url: `${baseUrl}/v1/messages`,
        method: 'POST',
        headers,
        body: {
          model: input.model,
          max_tokens: input.maxTokens || 4096,
          temperature: input.temperature ?? 0.7,
          stream: input.stream ?? true,
          system: input.messages.find(m => m.role === 'system')?.content || '',
          messages: input.messages
            .filter(m => m.role !== 'system')
            .map(m => ({
              role: m.role === 'assistant' ? 'assistant' : 'user',
              content: m.content,
            })),
          tools: input.tools?.map(t => ({
            name: t.function?.name || t.name,
            description: t.function?.description || '',
            input_schema: t.function?.parameters || t.parameters || {},
          })),
        },
      }
    }

    case 'ollama': {
      // Ollama 使用 /api/chat 端点，独立格式
      return {
        url: `${baseUrl}/api/chat`,
        method: 'POST',
        headers,
        body: {
          model: input.model,
          messages: input.messages,
          stream: input.stream ?? true,
          options: {
            temperature: input.temperature ?? 0.7,
            num_predict: input.maxTokens || 4096,
          },
        },
      }
    }

    default: {
      // OpenAI 兼容格式（LM Studio / DeepSeek / DashScope / SiliconFlow / 智谱）
      const body: Record<string, any> = {
        model: input.model,
        messages: input.messages,
        max_tokens: input.maxTokens || 4096,
        temperature: input.temperature ?? 0.7,
        stream: input.stream ?? true,
      }

      // 仅支持 function calling 的 Provider 才传 tools
      if (input.tools && input.tools.length > 0 && caps.nativeFunctionCalling) {
        body.tools = input.tools
        body.tool_choice = 'auto'
      }

      // DashScope 需要额外的参数
      if (kind === 'dashscope') {
        body.stream_options = { include_usage: true }
      }

      return {
        url: `${baseUrl}/chat/completions`,
        method: 'POST',
        headers,
        body,
      }
    }
  }
}

/**
 * 从 Provider 特定格式的流式 chunk 中提取 token 用量
 */
export function extractUsage(chunk: any, kind: ProviderKind): { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null {
  if (!chunk) return null

  switch (kind) {
    case 'anthropic': {
      if (chunk.type === 'message_delta' && chunk.usage) {
        return {
          prompt_tokens: chunk.usage.input_tokens,
          completion_tokens: chunk.usage.output_tokens,
          total_tokens: chunk.usage.input_tokens + chunk.usage.output_tokens,
        }
      }
      return null
    }
    default: {
      return chunk.usage || null
    }
  }
}

/**
 * 提供 Rate Limit 推荐等待时间
 */
export function getRetryAfterFromProvider(kind: ProviderKind, statusCode: number): number {
  if (statusCode === 429) {
    switch (kind) {
      case 'deepseek': return 30_000  // DeepSeek 限流较严格
      case 'openai': return 20_000
      case 'siliconflow': return 60_000
      case 'dashscope': return 10_000
      default: return 5_000
    }
  }
  return 5_000
}

// ═══════════════════════════════════════════════════════════
// 导出
// ═══════════════════════════════════════════════════════════

export const ProviderAdapter = {
  identify: identifyProvider,
  getCapabilities: getProviderCapabilities,
  supports: modelSupports,
  adaptRequest: adaptRequestBody,
  extractUsage,
  getRetryAfter: getRetryAfterFromProvider,
}
