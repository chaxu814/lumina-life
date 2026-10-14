// ============================================================
// proactive/resolveProactiveLLM.ts — 🔌 主动管线 LLM 配置 + 纯文本对话
//
// 旧 proactiveEngine.getLLMConfig() 的问题：检测到 127.0.0.1:1234 就直接 return null，
// 把 LM Studio 一刀切——本地模型其实是最适合主动管线的（免费、无墙、想加载就加载）。
// 这里改成：
//   - 本地端点（127.0.0.1:1234 / localhost:1234 / lmstudio）允许调用，超时拉长到 60s
//     （本地冷启动加载模型慢，2s 连通性检测会误杀）；
//   - 连通性失败 / 模型未加载 → 静默跳过单次（只 console.warn 一次，不抛到上层）；
//   - 云端端点保留快速连通性检测；
//   - 统一提供 chatComplete() 纯文本对话封装（复用 callVisionLLM 的 https/http 写法）。
// ============================================================

import https from 'https'
import http from 'http'
import { getAgentConfig } from '../agentConfig'

export interface ProactiveLLMConfig {
  baseUrl: string
  apiKey: string
  model: string
  /** 是否本地端点（本地模型冷启动慢，连通性检测更宽容） */
  isLocal: boolean
}

const LOCAL_HOSTS = ['127.0.0.1:1234', 'localhost:1234', 'lmstudio', '127.0.0.1', 'localhost']

function isLocalEndpoint(endpoint: string): boolean {
  const e = (endpoint || '').toLowerCase()
  return LOCAL_HOSTS.some(h => e.includes(h))
}

/** 连通性失败只 warn 一次，避免刷屏 */
let _connectWarned = false

/**
 * 解析主动管线该用哪个 LLM：
 * 优先 agentConfig 的 lumina 独立配置；其次环境变量兜底；都没有返回 null。
 * 本地 LM Studio 不再一刀切。
 */
export function resolveProactiveLLM(): ProactiveLLMConfig | null {
  // 1. agentConfig 里的 lumina 配置
  try {
    const config = getAgentConfig()
    if (config.isConfigured('lumina')) {
      const lumina = config.get('lumina')
      if (lumina.endpoint && lumina.model) {
        const isLocal = isLocalEndpoint(lumina.endpoint)
        return {
          baseUrl: lumina.endpoint,
          apiKey: lumina.apiKey || '',
          model: lumina.model,
          isLocal,
        }
      }
    }
  } catch { /* AgentConfig 不可用，继续降级 */ }

  // 2. 环境变量兜底
  const envBase = process.env.LUMINA_VLM_BASE_URL || process.env.LLM_BASE_URL
  if (envBase) {
    return {
      baseUrl: envBase,
      apiKey: process.env.LUMINA_VLM_API_KEY || process.env.LLM_API_KEY || '',
      model: process.env.LLM_SMALL_MODEL || process.env.LLM_MODEL || 'gpt-4o-mini',
      isLocal: isLocalEndpoint(envBase),
    }
  }

  return null
}

/** 连通性检测：本地端点宽容（不做 HEAD 探测，交给 60s 超时兜底），云端 2s 快速探测 */
async function probeReachable(cfg: ProactiveLLMConfig): Promise<boolean> {
  if (cfg.isLocal) {return true} // 本地模型未加载会在请求阶段返回 500，静默跳过即可
  try {
    const url = new URL(cfg.baseUrl.replace(/\/+$/, ''))
    const isHttps = url.protocol === 'https:'
    const transport = isHttps ? https : http
    await new Promise<void>((resolve, reject) => {
      const req = transport.request({
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname || '/',
        method: 'HEAD',
        timeout: 2000,
      }, () => { req.destroy(); resolve() })
      req.on('error', reject)
      req.on('timeout', () => { req.destroy(); reject(new Error('connect timeout')) })
      req.end()
    })
    return true
  } catch {
    return false
  }
}

export interface ChatCompleteOptions {
  system: string
  user: string
  maxTokens?: number
  temperature?: number
  /** 要求模型输出 JSON 对象 */
  json?: boolean
  /** 覆盖默认 60s 超时（毫秒） */
  timeoutMs?: number
}

/**
 * 纯文本 chat/completions 调用。失败返回空串（不抛错），
 * 让上层走模板 fallback。
 */
export async function chatComplete(opts: ChatCompleteOptions): Promise<string> {
  const cfg = resolveProactiveLLM()
  if (!cfg) {return ''}

  if (!(await probeReachable(cfg))) {
    if (!_connectWarned) {
      console.warn('[proactiveLLM] LLM 端点不可达，本次主动生成静默跳过 —', cfg.baseUrl)
      _connectWarned = true
    }
    return ''
  }

  const url = new URL(cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions')
  const isHttps = url.protocol === 'https:'
  const transport = isHttps ? https : http
  const timeoutMs = opts.timeoutMs ?? 60_000 // 本地模型加载慢，60s

  const bodyObj: Record<string, any> = {
    model: process.env.LLM_SMALL_MODEL || cfg.model,
    messages: [
      { role: 'system', content: opts.system },
      { role: 'user', content: opts.user },
    ],
    max_tokens: opts.maxTokens ?? 200,
    temperature: opts.temperature ?? 0.8,
  }
  // ⚠️ `response_format.type='json_object'` 并非所有 OpenAI 兼容服务端都支持：
  //   实测 LM Studio 直接 400 `'response_format.type' must be 'json_schema' or 'text'`
  //   （同类问题在 tools/impl/cuCore.ts 的视觉调用上也让截图识别 100% 失败）。
  //   这里先按需带上；若服务端明确拒绝，则**去掉该字段重试一次** —— 提示词里
  //   已经要求输出 JSON，上层解析也容错，所以降级安全。
  if (opts.json) {bodyObj.response_format = { type: 'json_object' }}

  /** 发一次请求；返回 { content } 或 { error }（不抛错，失败由调用方决定） */
  const sendOnce = (bodyStr: string): Promise<{ content: string; error: string }> =>
    new Promise((resolve) => {
      const req = transport.request({
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
          'Content-Length': Buffer.byteLength(bodyStr).toString(),
        },
        timeout: timeoutMs,
      }, (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => {
          try {
            const json = JSON.parse(data)
            if (json?.error) {
              resolve({ content: '', error: String(json.error.message || json.error) })
              return
            }
            resolve({ content: json.choices?.[0]?.message?.content || '', error: '' })
          } catch {
            resolve({ content: '', error: `bad_json:${String(data).slice(0, 120)}` })
          }
        })
      })
      req.on('error', (e: any) => resolve({ content: '', error: String(e?.message || e) }))
      req.on('timeout', () => { req.destroy(); resolve({ content: '', error: 'timeout' }) })
      req.write(bodyStr)
      req.end()
    })

  const first = await sendOnce(JSON.stringify(bodyObj))
  if (first.content || !opts.json) {return first.content}

  // 仅在「明确因 response_format 被拒」时降级重试，其余错误照旧返回空串
  if (/response_format|json_schema|json_object/i.test(first.error)) {
    console.warn('[proactiveLLM] 服务端不支持 response_format=json_object，已去掉该字段重试')
    const retryBodyObj: Record<string, any> = { ...bodyObj }
    delete retryBodyObj.response_format
    const second = await sendOnce(JSON.stringify(retryBodyObj))
    return second.content
  }
  return ''
}
