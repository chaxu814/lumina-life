// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// onboarding/llmReachability.ts — 运行时 LLM 端点可达性预检
//
// 解决问题：用户配置了本地端点（如 LM Studio 1234），但模型服务没启动时，
// 发消息会静默失败/返回空。这里在发消息前实际探测端点，不可达时返回
// 明确的二选一引导（启动本地模型 / 改用云端 Key）。
//
// 设计：网络探测（probeEndpoint）与结果分类（classifyFetchError）、
// 引导文案（buildUnreachableGuidance）分离，fetcher 可注入，便于单测。
// ============================================================

import { isLocalEndpoint } from '../core/modelCompat'

export type ReachabilityErrorKind = 'refused' | 'timeout' | 'auth' | 'http' | 'unknown'

export interface ReachabilityResult {
  reachable: boolean
  /** HTTP 状态码（拿到响应时） */
  status?: number
  errorKind?: ReachabilityErrorKind
  message?: string
}

/** 可注入的探测函数：返回 HTTP 状态码，失败抛错 */
export type Probe = (url: string, timeoutMs: number, apiKey?: string) => Promise<number>

/** 拼接 /models 探测 URL（避免重复后缀） */
export function modelsProbeUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (/\/models$/i.test(trimmed)) {return trimmed}
  return `${trimmed}/models`
}

/** 默认探测实现：GET /models，带 Authorization 与超时 */
export const defaultProbe: Probe = async (url, timeoutMs, apiKey) => {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const headers: Record<string, string> = {}
    if (apiKey) {headers['Authorization'] = `Bearer ${apiKey}`}
    const res = await fetch(url, { method: 'GET', headers, signal: ctrl.signal })
    return res.status
  } finally {
    clearTimeout(timer)
  }
}

/** 把底层错误分类为标准 errorKind（纯逻辑） */
export function classifyFetchError(err: unknown): ReachabilityErrorKind {
  const e = err as { name?: string; message?: string; cause?: { code?: string } }
  if (e?.name === 'AbortError') {return 'timeout'}
  const raw = `${e?.message || ''} ${e?.cause?.code || ''}`.toLowerCase()
  if (/401|403|unauthorized|forbidden/.test(raw)) {return 'auth'}
  if (/econnrefused|enotfound|econnreset|fetch failed|getaddrinfo|network|connect|连接|拒绝/.test(raw)) {
    return 'refused'
  }
  return 'unknown'
}

/**
 * 探测端点可达性。
 * @param baseUrl OpenAI 兼容端点（…/v1）
 * @param apiKey  可选 API Key
 * @param timeoutMs 默认 2000ms（发消息路径，不能等太久）
 * @param probe 可注入探测实现
 */
export async function probeEndpoint(
  baseUrl: string,
  apiKey?: string,
  timeoutMs = 2000,
  probe: Probe = defaultProbe,
): Promise<ReachabilityResult> {
  if (!baseUrl || !/^https?:\/\//i.test(baseUrl.trim())) {
    return { reachable: false, errorKind: 'unknown', message: '端点地址无效' }
  }
  const url = modelsProbeUrl(baseUrl)
  try {
    const status = await probe(url, timeoutMs, apiKey)
    // 401/403：服务在线但鉴权失败
    if (status === 401 || status === 403) {
      return { reachable: false, status, errorKind: 'auth', message: `HTTP ${status}` }
    }
    // 其余状态（含 404/500）都说明"服务在监听"，视为可达；真正的问题会在调用时暴露
    return { reachable: true, status }
  } catch (err) {
    const kind = classifyFetchError(err)
    return {
      reachable: false,
      errorKind: kind,
      message: kind === 'timeout' ? '连接超时' : (err as { message?: string })?.message || kind,
    }
  }
}

/**
 * 端点不可达时的二选一引导文案。
 */
export function buildUnreachableGuidance(baseUrl: string, kind: ReachabilityErrorKind): string {
  const local = isLocalEndpoint(baseUrl)

  if (kind === 'auth') {
    return `唔…我能连到模型服务，但它拒绝了我的身份（鉴权失败）🔐

**🔧 二选一：**

1️⃣ 如果你在 LM Studio 里设置了 API Key —— 打开 **设置 → Lumina Team 供应商配置**，
   在对应 Agent 栏填入相同的 Key；或在 LM Studio 的 Server 标签里清空 Key 关闭认证。
2️⃣ 或者改用云端服务 —— 在设置里选一个云端供应商并填入有效 API Key。

> 填好后重新发一次消息就好。`
  }

  if (local) {
    return `我连不上本地模型服务（${baseUrl}）${kind === 'timeout' ? '，连接超时' : '，看起来它还没有启动'}🥲

**🔧 二选一：**

1️⃣ **启动本地模型**
   • LM Studio：打开 LM Studio → 进入 Local Server 标签 → 点 Start Server（默认端口 1234）
   • Ollama：确认已运行，并且已拉取模型（如 ollama pull qwen3:14b）
   启动后重新发一次消息即可。

2️⃣ **改用云端 API（不想等本地模型时）**
   打开 **设置 → Lumina Team 供应商配置**，选一个云端供应商（DeepSeek / 硅基流动 / 通义等），
   填入 API Key 保存。新用户通常有免费额度。

> 我不会在模型没连上时假装回答你——先把大脑叫醒，我才能好好说话。`
  }

  return `我连不上模型服务（${baseUrl}）🌐

**🔧 检查一下：**
• 网络是否正常、该地址是否可访问
• 如果是云端服务，确认 API Key 是否有效、服务是否可用
• 或者在 **设置** 里换一个供应商 / 端点

> 配置好后重新发一次消息。`
}
