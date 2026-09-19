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

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response | null> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ctrl.signal, method: 'GET' })
    return res.ok ? res : null
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

/** 探测单个候选（网络），失败返回 null */
export async function probeCandidate(c: LocalCandidate, timeoutMs = 1200): Promise<DiscoveredProvider | null> {
  const res = await fetchWithTimeout(c.baseUrl + c.modelsPath, timeoutMs)
  if (!res) {return null}
  let data: any = null
  try { data = await res.json() } catch { return null }
  const models = extractModels(c.format, data)
  if (!models.length) {return null}
  return {
    id: c.id,
    label: c.label,
    baseUrl: c.baseUrl,
    models,
    recommendedModel: pickRecommendedModel(models, c.preferKeywords),
    apiKey: 'local',
  }
}

/** 探测全部本地候选，返回所有可用的（顺序即推荐顺序） */
export async function discoverLocalProviders(timeoutMs = 1200): Promise<DiscoveredProvider[]> {
  const results = await Promise.all(LOCAL_CANDIDATES.map(c => probeCandidate(c, timeoutMs)))
  // 同一 baseUrl 去重（lm-studio 与 local-openai 同地址）
  const seen = new Set<string>()
  const out: DiscoveredProvider[] = []
  for (const r of results) {
    if (r && !seen.has(r.baseUrl)) { seen.add(r.baseUrl); out.push(r) }
  }
  return out
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
