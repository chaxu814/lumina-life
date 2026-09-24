// ============================================================
// onboarding/localModelDetector.ts — 引导向导本地模型探测 (Setup Wizard)
//
// 首次启动引导（C2）：
//   - detectLMStudio(): 探测 http://127.0.0.1:1234/v1/models（OpenAI 兼容）
//   - detectOllama():   探测 http://127.0.0.1:11434/api/tags（Ollama 原生）
//   - recommendLocalModel(): 优先 LM Studio（有 GUI），其次 Ollama；都不可用给出下载链接
//
// 设计：纯逻辑（解析/挑模型）与网络探测分离，fetcher 可注入，便于单测。
// ============================================================

/** 单个服务的探测结果 */
export interface LocalDetectResult {
  available: boolean
  models: string[]
  /** 从模型列表中推荐的具体模型名（中文友好优先） */
  recommended: string
  /** 不可用时的原因/提示 */
  error?: string
}

/** 推荐结果（含无可用服务时的下载引导） */
export interface LocalRecommendation {
  /** 命中的本地服务 id：'lmstudio' | 'ollama' | null */
  provider: 'lmstudio' | 'ollama' | null
  baseUrl: string
  models: string[]
  recommended: string
  /** 无可用服务时的下载指引 */
  downloadGuide?: Array<{ title: string; body: string; url: string }>
}

/**
 * 可注入的 HTTP GET：返回解析后的 JSON 对象，失败抛错。
 * 默认实现走全局 fetch（带 AbortController 超时）。
 */
export type HttpGet = (url: string, timeoutMs: number) => Promise<unknown>

/** 默认 fetcher：用全局 fetch，AbortSignal 控制超时 */
export const defaultHttpGet: HttpGet = async (url, timeoutMs) => {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { method: 'GET', signal: ctrl.signal })
    if (!res.ok) {throw new Error(`HTTP ${res.status}`)}
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

export const LMSTUDIO_URL = 'http://127.0.0.1:1234/v1/models'
export const OLLAMA_URL = 'http://127.0.0.1:11434/api/tags'

/** 中文友好的模型偏好关键词（越靠前优先级越高） */
const PREFER_KEYWORDS = ['qwen', 'glm', 'yi', 'deepseek', 'llama', 'gemma', 'gpt']

/**
 * 从 OpenAI 兼容响应（{ data: [{ id }] }）提取模型 id 列表。纯逻辑。
 */
export function extractModelsFromOpenAI(data: unknown): string[] {
  if (!data || typeof data !== 'object') {return []}
  const arr = (data as { data?: unknown[] }).data
  if (!Array.isArray(arr)) {return []}
  return arr
    .map((m) => {
      const o = m as { id?: string; name?: string }
      return (o?.id || o?.name || '').trim()
    })
    .filter(Boolean)
}

/**
 * 从 Ollama 响应（{ models: [{ name }] }）提取模型名列表。纯逻辑。
 */
export function extractModelsFromOllama(data: unknown): string[] {
  if (!data || typeof data !== 'object') {return []}
  const arr = (data as { models?: unknown[] }).models
  if (!Array.isArray(arr)) {return []}
  return arr
    .map((m) => {
      const o = m as { name?: string; model?: string }
      return (o?.name || o?.model || '').trim()
    })
    .filter(Boolean)
}

/**
 * 按偏好关键词挑一个最适合中文的模型；都不命中则取第一个。纯逻辑。
 */
export function pickRecommendedModel(models: string[], keywords: string[] = PREFER_KEYWORDS): string {
  if (models.length === 0) {return ''}
  const lower = models.map((m) => m.toLowerCase())
  for (const kw of keywords) {
    const idx = lower.findIndex((m) => m.includes(kw))
    if (idx >= 0) {return models[idx]}
  }
  return models[0]
}

/**
 * 探测 LM Studio（1234 端口，OpenAI 兼容）。
 * @param timeoutMs 默认 3000ms（引导页用户等待容忍度）
 */
export async function detectLMStudio(timeoutMs = 3000, fetcher: HttpGet = defaultHttpGet): Promise<LocalDetectResult> {
  try {
    const data = await fetcher(LMSTUDIO_URL, timeoutMs)
    const models = extractModelsFromOpenAI(data)
    if (models.length === 0) {
      return { available: true, models: [], recommended: '', error: 'LM Studio 在线，但还没有下载模型' }
    }
    return { available: true, models, recommended: pickRecommendedModel(models) }
  } catch (err: any) {
    const msg = err?.message || ''
    // LM Studio 开启了 API Key 认证：端口通但 /v1/models 返回 401
    if (msg.includes('401') || msg.includes('Unauthorized')) {
      return {
        available: false,
        models: [],
        recommended: '',
        error: 'LM Studio 已启动但开启了 API Key 认证。请在 LM Studio → 服务器(Server) 标签页中删除 API Key（留空即关闭认证），或在下一步填入你的 Key。',
      }
    }
    return {
      available: false,
      models: [],
      recommended: '',
      error: err?.name === 'AbortError' ? '连接超时（LM Studio 未启动）' : (err?.message || 'LM Studio 不可达'),
    }
  }
}

/**
 * 探测 Ollama（11434 端口，原生 /api/tags）。
 */
export async function detectOllama(timeoutMs = 3000, fetcher: HttpGet = defaultHttpGet): Promise<LocalDetectResult> {
  try {
    const data = await fetcher(OLLAMA_URL, timeoutMs)
    const models = extractModelsFromOllama(data)
    if (models.length === 0) {
      return { available: true, models: [], recommended: '', error: 'Ollama 在线，但还没有拉取模型（ollama pull）' }
    }
    return { available: true, models, recommended: pickRecommendedModel(models) }
  } catch (err: any) {
    return {
      available: false,
      models: [],
      recommended: '',
      error: err?.name === 'AbortError' ? '连接超时（Ollama 未启动）' : (err?.message || 'Ollama 不可达'),
    }
  }
}

/** 无可用服务时的下载引导（纯数据，便于单测与前端展示） */
export const LOCAL_DOWNLOAD_GUIDE: Array<{ title: string; body: string; url: string }> = [
  {
    title: 'LM Studio（推荐，有图形界面）',
    body: '下载安装后，在界面里搜一个中文模型（如 Qwen3）下载，打开 Local Server（默认端口 1234），回到本页点「重新检测」即可。',
    url: 'https://lmstudio.ai/',
  },
  {
    title: 'Ollama（轻量命令行）',
    body: '安装后在终端运行：ollama pull qwen3:14b，再回到本页点「重新检测」。',
    url: 'https://ollama.com/',
  },
  {
    title: '或者用云端（免费额度）',
    body: 'DeepSeek 新用户有额度，硅基流动也提供免费模型，下一步选择云端并填 Key 即可。',
    url: 'https://platform.deepseek.com/',
  },
]

/**
 * 推荐本地模型：LM Studio 优先（有 GUI、对新手友好），其次 Ollama。
 * 两者都不可用时返回 downloadGuide。
 */
export async function recommendLocalModel(timeoutMs = 3000, fetcher: HttpGet = defaultHttpGet): Promise<LocalRecommendation> {
  const [lm, ollama] = await Promise.all([
    detectLMStudio(timeoutMs, fetcher),
    detectOllama(timeoutMs, fetcher),
  ])

  // LM Studio 优先（有 GUI）
  if (lm.available && lm.models.length > 0) {
    return { provider: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1', models: lm.models, recommended: lm.recommended }
  }
  if (ollama.available && ollama.models.length > 0) {
    return { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', models: ollama.models, recommended: ollama.recommended }
  }

  // 服务在线但无模型：仍标记该 provider，前端提示先下模型
  if (lm.available) {
    return { provider: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1', models: [], recommended: '', downloadGuide: LOCAL_DOWNLOAD_GUIDE }
  }
  if (ollama.available) {
    return { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', models: [], recommended: '', downloadGuide: LOCAL_DOWNLOAD_GUIDE }
  }

  return { provider: null, baseUrl: '', models: [], recommended: '', downloadGuide: LOCAL_DOWNLOAD_GUIDE }
}
