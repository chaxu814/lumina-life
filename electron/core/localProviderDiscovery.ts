// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// core/localProviderDiscovery.ts — 本地/免费大模型自动探测（降低开箱门槛）
//
// 首次启动时，用户最常卡在「要自己填 Key / 本地模型」。本模块：
//   1) 自动探测本机常见的免费本地推理服务（Ollama / LM Studio / 通用 OpenAI 兼容）；
//   2) 探测到即给出可直接写入 providerManager 的配置（无需 Key）；
//   3) 探测失败给出「免费可用」的清晰建议（本地 Ollama 或在线免费额度）。
//
// 纯逻辑（候选表/归一化）可单测；网络探测用 fetch，带超时与失败兜底。
// ============================================================

import { parseServerFactsFor, rememberServerFacts, type ServerModelFacts } from './modelServerFacts'

export interface LocalCandidate {
  id: string
  label: string
  baseUrl: string
  /** 探测健康用的 HTTP 路径 */
  modelsPath: string
  /** 响应里模型列表的取值方式：'ollama' 用 data.models[].name；'openai' 用 data.data[].id */
  format: 'ollama' | 'openai'
  /** 模型名取哪个优先（中文优先的偏好关键词） */
  preferKeywords: string[]
}

/** 本机常见免费本地推理服务（按常见度排序） */
export const LOCAL_CANDIDATES: LocalCandidate[] = [
  {
    id: 'ollama',
    label: 'Ollama（本地，免费）',
    baseUrl: 'http://127.0.0.1:11434',
    modelsPath: '/api/tags',
    format: 'ollama',
    preferKeywords: ['qwen', 'glm', 'yi', 'deepseek', 'llama', 'gemma'],
  },
  {
    id: 'lm-studio',
    label: 'LM Studio（本地，免费）',
    baseUrl: 'http://127.0.0.1:1234',
    modelsPath: '/v1/models',
    format: 'openai',
    preferKeywords: ['qwen', 'glm', 'yi', 'deepseek', 'llama', 'gpt'],
  },
  {
    id: 'local-openai',
    label: '本地 OpenAI 兼容服务（1234）',
    baseUrl: 'http://127.0.0.1:1234',
    modelsPath: '/v1/models',
    format: 'openai',
    preferKeywords: [],
  },
]

export interface DiscoveredProvider {
  id: string
  label: string
  baseUrl: string
  models: string[]
  /** 推荐选用的具体模型（中文友好优先） */
  recommendedModel: string
  apiKey: string
}

// ═══════════════════════════════════════════════════════════
// 🔧 探测失败的分类（2026-10-05）
//
// 【为什么必须区分】
// 旧实现里 fetchWithTimeout 任何失败都返回 null，probeCandidate 再转成 null，
// discoverLocalProviders 最终得到 found: []，前端据此判定「尚未配置 LLM」。
//
// 于是【三种原因完全不同的故障被压成同一句话】：
//   · 服务根本没启动        → 「尚未配置 LLM」    ← 错，用户会去填配置
//   · 端口不通 / 防火墙     → 「尚未配置 LLM」    ← 错，用户会反复重填
//   · 开了鉴权但 key 不对   → 「尚未配置 LLM」    ← 错，用户根本不知道要去改 key
//   · 服务正常但没加载模型  → 「尚未配置 LLM」    ← 只有这一种是对的
//
// 本项目真实遇到过第三种：用户已正确填入 API 地址与 key、配置已保存、
// 界面却持续报「尚未配置 LLM」。根因是 LM Studio 开了鉴权而存的 key 不对，
// 401 被当成「没配」——用户按提示去反复检查地址，方向完全错了。
//
// 修法不是「让用户更仔细地配」，而是【把失败原因如实说出来】。
// ═══════════════════════════════════════════════════════════

/** 探测失败的原因分类 */
export type ProbeFailureKind =
  /** 连不上：服务没启动 / 端口不通 / 防火墙 */
  | 'unreachable'
  /** 401/403：服务要求鉴权，而当前没有 key 或 key 不对 */
  | 'auth'
  /** 连上了、能鉴权，但模型列表为空（服务正常，只是没加载模型） */
  | 'no-model'
  /** 其它 HTTP 错误 */
  | 'http'

export interface ProbeFailure {
  kind: ProbeFailureKind
  /** 目标 baseUrl */
  baseUrl: string
  /** HTTP 状态码（仅 http/auth 有） */
  status?: number
  /** 面向用户的修复建议 */
  advice: string
}

/** 一次探测的完整结果：有发现就带 found，有失败就带 failures */
export interface LocalDiscoveryResult {
  found: DiscoveredProvider[]
  /** 🔧 新增：失败原因（按尝试顺序） */
  failures: ProbeFailure[]
  /**
   * 汇总结论：让 UI 一句话就能说清「到底该做什么」。
   * 优先级：unreachable > auth > no-model（因为前两者是更根本的原因）
   */
  summary: {
    ok: boolean
    kind: ProbeFailureKind | null
    headline: string
    advice: string
  }
}

/** 从模型列表里按偏好关键词挑一个最适合中文的模型（纯逻辑） */
export function pickRecommendedModel(models: string[], keywords?: string[]): string {
  if (!models.length) {return ''}
  const list = (keywords || []).map(k => k.toLowerCase())
  const lower = models.map(m => m.toLowerCase())
  for (const kw of list) {
    const idx = lower.findIndex(m => m.includes(kw))
    if (idx >= 0) {return models[idx]}
  }
  // 取列表中第一个（通常本地服务把默认模型排在前面）
  return models[0]
}

/** 从探测响应解析模型列表（纯逻辑，便于单测） */
export function extractModels(fmt: 'ollama' | 'openai', data: any): string[] {
  try {
    if (fmt === 'ollama') {
      if (Array.isArray(data?.models)) {
        return data.models.map((m: any) => m?.name || m?.model).filter(Boolean)
      }
      return []
    }
    if (Array.isArray(data?.data)) {
      return data.data.map((m: any) => m?.id || m?.name).filter(Boolean)
    }
    return []
  } catch {
    return []
  }
}

interface ProbeFetchResult {
  /** 成功时是响应，失败时为 null */
  res: Response | null
  /** 失败分类（成功时为 null） */
  failure: ProbeFailure | null
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  apiKey?: string,
): Promise<ProbeFetchResult> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  // 从 url 反推出 baseUrl（去掉末尾的 modelsPath），用于报错误时告诉用户「哪个地址」
  const base = url.replace(/\/(v1\/models|api\/tags|models|tags)$/i, '').replace(/\/+$/, '')
  try {
    // 🔧 2026-10-04：必须带上鉴权头。
    //   LM Studio 从 0.3.x 起可以开启「Require Authentication」，开启后
    //   /v1/models 会返回 401。而探测原先是不带任何 header 的裸 fetch，
    //   于是：探测 401 → 判定「本地没加载模型」→ llmReady=false
    //   → 界面弹出「尚未配置 LLM · 模拟回复模式」黄框。
    //   实际模型服务完全正常，只是探测没鉴权 —— 典型的「失败路径不吭声」。
    const headers: Record<string, string> = {}
    if (apiKey && apiKey && apiKey !== 'local') {
      headers['Authorization'] = `Bearer ${apiKey}`
    }
    const res = await fetch(url, { signal: ctrl.signal, method: 'GET', headers })
    if (res.ok) {return { res, failure: null }}

    // 🔧 2026-10-05：不再把非 2xx 一律当 null。分类报出去。
    if (res.status === 401 || res.status === 403) {
      return {
        res: null,
        failure: {
          kind: 'auth',
          baseUrl: base,
          status: res.status,
          // 🔧 2026-10-05：区分「填错了」与「压根没填」。
          //   两者修复动作完全不同 —— 前者去核对 key，后者【关掉鉴权】即可。
          //   本地推理服务（LM Studio / Ollama）默认是不开鉴权的，
          //   开启它对单机使用毫无收益、只增加配置负担，所以无 key 时首选建议是关掉它。
          advice: apiKey
            ? `服务要求鉴权，但当前保存的 API Key 不被接受（${res.status}）。`
              + '请到 LM Studio → Developer 标签页确认已设置的 API Key，'
              + '然后在 Lumina 的「API 密钥」里填【一模一样的值】；'
              + '或直接关闭 LM Studio 的 Require Authentication（本地推理无需鉴权）。'
            : `服务已开启鉴权（${res.status}），但没有配置 API Key。`
              + `两种处理方式任选其一：`
              + `① 关闭 LM Studio 的 Require Authentication（推荐，本地推理无需鉴权）；`
              + `② 在「设置 → LLM 模型」的「API 密钥」里填入 LM Studio 中设置的 key。`,
        },
      }
    }
    return {
      res: null,
      failure: {
        kind: 'http',
        baseUrl: base,
        status: res.status,
        advice: `服务返回了 HTTP ${res.status}。`
          + '若为 404，请确认 API 地址是否以 /v1 结尾；'
          + '若为 5xx，请查看 LM Studio 的服务端日志。',
      },
    }
  } catch (e: any) {
    const aborted = e?.name === 'AbortError' || /abort/i.test(String(e?.message))
    return {
      res: null,
      failure: {
        kind: 'unreachable',
        baseUrl: base,
        advice: aborted
          ? `连接 ${base} 超时（${timeoutMs}ms）。`
            + '请确认服务已启动、地址端口正确，以及本机能访问该主机（局域网需同一网段）。'
          : `无法连接 ${base}：${e?.message || e}。`
            + '请确认服务已启动、地址端口正确，以及防火墙是否放行。',
      },
    }
  } finally {
    clearTimeout(t)
  }
}

/** 探测单个候选的结果：要么有发现，要么有失败原因（不再把两者混成 null） */
export interface CandidateProbe {
  candidate: LocalCandidate
  provider: DiscoveredProvider | null
  failure: ProbeFailure | null
}

/** 探测单个候选（网络） */
export async function probeCandidateDetailed(
  c: LocalCandidate,
  timeoutMs = 1200,
  apiKey?: string,
): Promise<CandidateProbe> {
  const { res, failure } = await fetchWithTimeout(c.baseUrl + c.modelsPath, timeoutMs, apiKey)
  if (!res) {return { candidate: c, provider: null, failure }}
  let data: any = null
  try { data = await res.json() } catch {
    return {
      candidate: c,
      provider: null,
      failure: {
        kind: 'http',
        baseUrl: c.baseUrl,
        advice: `服务可达但返回的不是合法 JSON —— 该地址可能不是推理服务根路径。`
          + '请确认 API 地址填写正确（LM Studio 应形如 http://host:1234/v1）。',
      },
    }
  }
  const models = extractModels(c.format, data)
  if (!models.length) {
    return {
      candidate: c,
      provider: null,
      failure: {
        kind: 'no-model',
        baseUrl: c.baseUrl,
        advice: `服务已连通，但还没有加载任何模型。`
          + '请在 LM Studio 里加载一个模型（或在 Ollama 执行 pull），加载完成后点「重新检测」。',
      },
    }
  }
  return {
    candidate: c,
    provider: {
      id: c.id,
      label: c.label,
      baseUrl: c.baseUrl,
      models,
      recommendedModel: pickRecommendedModel(models, c.preferKeywords),
      // 🔧 原来固定写死 'local' —— 那是个假占位值。开启鉴权后下游拿它当 Bearer 发出去必然 401。
      // 有真实 key 就用它，没有就留空（让调用方按无鉴权处理）。
      apiKey: apiKey && apiKey !== 'local' ? apiKey : '',
    },
    failure: null,
  }
}

/**
 * 严格探测一个 Agent 实际使用的本地端点与 API Key。
 * 与 discoverLocalProvidersDetailed（发现任意可用本地服务）不同，此函数：
 *   - 只请求传入的 baseUrl；
 *   - 只使用传入的 apiKey；
 *   - 不尝试其它 Agent 的 key，也不回写/切换全局 Provider。
 * 因而它的「就绪」结果可以对应实际发送配置，不会由别的候选/key 假阳性。
 */
export async function probeConfiguredLocalProviderDetailed(
  baseUrl: string,
  providerId: string | undefined,
  apiKey: string | undefined,
  timeoutMs = 3000,
): Promise<CandidateProbe> {
  const normalizedBase = String(baseUrl || '').trim().replace(/\/+$/, '')
  const normalizedProvider = String(providerId || '').toLowerCase()
  const isOllama = normalizedProvider === 'ollama'
    || /\/api\/tags$/i.test(normalizedBase)
    || (!normalizedProvider && /:11434(?:\/|$)/i.test(normalizedBase))

  let candidateBase = normalizedBase
  let modelsPath: string
  if (isOllama) {
    if (/\/api\/tags$/i.test(candidateBase)) {
      candidateBase = candidateBase.replace(/\/api\/tags$/i, '')
    }
    modelsPath = '/api/tags'
  } else if (/\/v1\/models$/i.test(candidateBase)) {
    candidateBase = candidateBase.replace(/\/models$/i, '')
    modelsPath = '/models'
  } else if (/\/models$/i.test(candidateBase)) {
    candidateBase = candidateBase.replace(/\/models$/i, '')
    modelsPath = '/models'
  } else {
    modelsPath = /\/v1$/i.test(candidateBase) ? '/models' : '/v1/models'
  }

  const candidate: LocalCandidate = {
    id: normalizedProvider || 'configured-local',
    label: '当前 Agent 配置的本地服务',
    baseUrl: candidateBase,
    modelsPath,
    format: isOllama ? 'ollama' : 'openai',
    preferKeywords: [],
  }
  if (!candidateBase || !/^https?:\/\//i.test(candidateBase)) {
    return {
      candidate,
      provider: null,
      failure: {
        kind: 'unreachable',
        baseUrl: normalizedBase,
        advice: '当前 Agent 的本地服务地址为空或格式无效，请检查 Lumina Team 供应商配置。',
      },
    }
  }
  return probeCandidateDetailed(candidate, timeoutMs, apiKey)
}

/** 探测单个候选（网络），失败返回 null（向后兼容的薄包装） */
export async function probeCandidate(
  c: LocalCandidate,
  timeoutMs = 1200,
  apiKey?: string,
): Promise<DiscoveredProvider | null> {
  return (await probeCandidateDetailed(c, timeoutMs, apiKey)).provider
}

/**
 * 探测全部本地候选，返回所有可用的（顺序即推荐顺序）。
 *
 * @param configuredApiKey 当前供应商的 apiKey（用于带鉴权探测）
 * @param extraBases        额外要试的 baseUrl。
 *   🔧 2026-10-04：候选表写死了 127.0.0.1，所以 LM Studio 跑在内网另一台机
 *   （如 http://192.168.1.2:1234）时永远探测不到。把当前配置的端点也拿来试一次。
 */
export async function discoverLocalProvidersDetailed(
  timeoutMs = 1200,
  configuredApiKey?: string,
  extraBases: string[] = [],
): Promise<LocalDiscoveryResult> {
  const candidates: LocalCandidate[] = [...LOCAL_CANDIDATES]
  for (const b of extraBases) {
    const base = String(b || '').trim().replace(/\/+$/, '')
    if (!base) {continue}
    if (candidates.some(c => c.baseUrl === base)) {continue}
    candidates.push({
      id: 'configured',
      label: '当前配置的本地服务',
      baseUrl: base,
      // 端点已含 /v1 时不能再拼一次，否则变成 /v1/v1/models
      modelsPath: /\/v1$/i.test(base) ? '/models' : '/v1/models',
      format: 'openai',
      preferKeywords: [],
    })
  }

  const results = await Promise.all(
    candidates.map(c => probeCandidateDetailed(c, timeoutMs, configuredApiKey)),
  )
  // 同一 baseUrl 去重（lm-studio 与 local-openai 同地址）
  const seen = new Set<string>()
  const out: DiscoveredProvider[] = []
  const failures: ProbeFailure[] = []
  for (const r of results) {
    if (r.provider && !seen.has(r.provider.baseUrl)) {
      seen.add(r.provider.baseUrl)
      out.push(r.provider)
    }
    if (!r.provider && r.failure) {failures.push(r.failure)}
  }

  // 🔧 汇总：告诉 UI 到底该怎么改，而不是只丢一个空数组。
  //   优先级：unreachable（服务没开）> auth（key 不对）> no-model（没加载）> http。
  //   原因：前两者是更根本的问题；服务没开时谈「没加载模型」是误导。
  const KIND_PRIORITY: ProbeFailureKind[] = ['unreachable', 'auth', 'no-model', 'http']
  let summary: LocalDiscoveryResult['summary']
  if (out.length > 0) {
    summary = {
      ok: true,
      kind: null,
      headline: `已发现 ${out.length} 个可用的本地服务`,
      advice: '',
    }
  } else {
    // 「当前配置的本地服务」优先于内置候选 —— 它才是用户真正在用的那个
    const configuredFail = failures.find(f => extraBases.some(b => f.baseUrl === b.replace(/\/+$/, '')))
    const primary = configuredFail
      || failures.slice().sort((a, b) => KIND_PRIORITY.indexOf(a.kind) - KIND_PRIORITY.indexOf(b.kind))[0]
    const HEADLINE: Record<ProbeFailureKind, string> = {
      unreachable: '连不上本地模型服务',
      auth: '本地服务要求鉴权，但 API Key 不正确',
      'no-model': '本地服务已启动，但还没有加载模型',
      http: '本地服务返回了错误',
    }
    summary = {
      ok: false,
      kind: primary?.kind ?? 'unreachable',
      headline: primary ? HEADLINE[primary.kind] : HEADLINE.unreachable,
      advice: primary?.advice ?? '未找到可用的本地模型服务。',
    }
  }

  return { found: out, failures, summary }
}

/** 探测全部本地候选（向后兼容的薄包装：只要成功列表） */
export async function discoverLocalProviders(
  timeoutMs = 1200,
  configuredApiKey?: string,
  extraBases: string[] = [],
): Promise<DiscoveredProvider[]> {
  return (await discoverLocalProvidersDetailed(timeoutMs, configuredApiKey, extraBases)).found
}

/** 免费/免 Key 的引导建议（探测为空时展示） */
export const FREE_SETUP_GUIDE = [
  {
    title: '完全免费·本地（推荐，隐私不出本机）',
    body: '安装 Ollama（ollama.com）后运行：ollama pull qwen2.5:7b（或 llama3.1），回到本页点「一键检测本地模型」即可自动接入，无需任何 Key。',
  },
  {
    title: '在线·有免费额度',
    body: '如硅基流动（siliconflow）、Google AI Studio（Gemini 免费 key）、阿里云百炼等均提供免费模型额度，注册后在「LLM 供应商」填入 Base URL 与 Key 即可。',
  },
  {
    title: '先体验离线生命感',
    body: '未配置大模型时，桌宠仍具备内驱力驱动的自主行为、情绪与本地安全护栏，只是对话与主动思考会降级为本地规则。',
  },
]

// ═══════════════════════════════════════════════════════════
// 🩺 接入时的「真实上下文窗口」探测（2026-10-07）
//
// 【为什么需要】「一键接入本地模型」曾经把 maxContextTokens 硬编码成
//   128000 / 256000。对本地小模型这是致命的：
//     runner 以为窗口有 128K → 不裁剪历史 → 每轮全量 prefill
//     → 首字响应从秒级变成分钟级（与主对话 P0-3 完全同一个坑）。
//   用户点「一键检测」本意就是「别让我手填」，结果却被塞了一个与模型
//   毫不相干的巨大窗口。
//
// 【现在】接入时拉一次 /v1/models，读服务端自己报的
//   max_context_length / n_ctx / max_model_len，**不猜、直接问**。
// ═══════════════════════════════════════════════════════════

/**
 * 探测某个本地端点的**完整能力事实**（上下文窗口 / 视觉 / 工具调用）。
 *
 * 【为什么试两个端点】这是 2026-10-07 实测发现的真问题：
 *   · LM Studio 的 **OpenAI 兼容端点 `/v1/models` 什么能力都不报** ——
 *     实测返回的每个模型条目都只有 id/object/owned_by，**没有 max_context_length**，
 *     于是自动检测永远拿不到窗口，VLM 也被误判成「不支持图片」。
 *   · 它真正的元数据在**原生端点 `/api/v0/models`**：会给出
 *     `max_context_length` / `type: 'vlm'` / `capabilities: ['tool_use']`。
 *   所以顺序是「先 OpenAI 兼容（多数服务在这里报），再 LM Studio 原生」。
 *
 * @returns 事实对象；两个端点都没拿到有用信息时返回 null。
 */
export async function probeLocalFacts(
  baseUrl: string,
  model: string,
  timeoutMs = 6_000,
): Promise<ServerModelFacts | null> {
  const root = String(baseUrl || '').trim().replace(/\/+$/, '').replace(/\/v1$/, '')
  if (!/^https?:\/\//.test(root)) {return null}
  const endpoints = [`${root}/v1/models`, `${root}/api/v0/models`]
  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { Authorization: 'Bearer local' },
      })
      if (!res.ok) {continue}
      const data = await res.json()
      const facts = parseServerFactsFor(data, model)
      if (facts && (facts.contextWindow || facts.supportsVision !== null || facts.supportsTools !== null)) {
        rememberServerFacts(model, facts)
        return facts
      }
    } catch {
      // 这个端点不可用，试下一个
    }
  }
  return null
}

/**
 * 探测某个 OpenAI 兼容端点的真实上下文窗口。
 *
 * @returns 真实值（>0）；探测失败 / 服务端未报告 → null。
 *          调用方应把 null 转成 **0（自动检测）**，绝不要填一个猜的大值。
 */
export async function probeContextWindow(
  baseUrl: string,
  model: string,
  timeoutMs = 6_000,
): Promise<number | null> {
  const facts = await probeLocalFacts(baseUrl, model, timeoutMs)
  return facts?.contextWindow && facts.contextWindow > 0 ? facts.contextWindow : null
}
