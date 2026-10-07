// ============================================================
// core/modelServerFacts.ts — 问服务端要答案（纯解析，零 IO）
//
// 【为什么单独做这个】
// 上一版能力画像有个诚实的短板：上下文窗口是**按参数量猜的**。
// 7B 模型可以是 8K 也可以是 128K 上下文，名字里看不出来。
//
// 但服务端知道 —— 而且 Lumina **本来就在请求** /v1/models，
// 只是把服务端返回的上下文长度直接扔了，只取了 id / multimodal / vision。
// 「已经在问、却没听答案」是比「没问」更糟的状态：它让人误以为已经适配过了。
//
// 【各服务商的字段差异很大，这就是不能硬编码一个字段名的原因】
//
//   LM Studio  /v1/models      → data[].max_context_length
//                              （/api/v0/models 里是 maxContextLength）
//   llama.cpp server           → data[].meta.n_ctx
//   vLLM       /v1/models      → data[].max_model_len
//   Ollama     /api/tags       → models[].model_info["<arch>.context_length"]
//                              models[].details.families  ← 架构族，比名字可靠
//   通用 OpenAI 兼容            → 多数只给 id，其余靠上层兜底
//
// 所以这里的做法是**遍历候选路径**而不是判断「是不是 LM Studio」——
// 判断服务商要维护一张表，而服务商在增加、字段在变；遍历候选路径则
// 新服务商接上就自动生效。
//
// 【Ollama 的 families 为什么特别有用】
// 名字里没有 'vl' 不代表不是视觉模型：ollama 会把视觉模型的基础架构
// 标成 llava / clip / mllama。靠这一项能覆盖一批「名字看不出来」的模型，
// 而正则做不到。
// ============================================================

/** 从服务端响应里解出来的权威事实 */
export interface ServerModelFacts {
  /** 服务端报告的上下文窗口；没有就 null */
  contextWindow: number | null
  /** 服务端明确说支持视觉 */
  supportsVision: boolean | null
  /** 服务端明确说支持工具/函数调用 */
  supportsTools: boolean | null
  /** 架构族（Ollama 的 details.families），如 ['llama','clip'] */
  families: string[]
  /** 参数量（Ollama 的 details.parameter_size，如 '4.1B'） */
  paramSizeText: string | null
  /** 服务端是否显式报了「仅加载未就绪」之类的状态（供 UI 提示） */
  loaded?: boolean
}

export type ServerFormat = 'openai' | 'ollama' | 'unknown'

// ═══════════════════════════════════════════════════════════
// 记忆层：把「已经拿到的服务端事实」存下来给运行时同步读取
// ═══════════════════════════════════════════════════════════

/**
 * 内存里的「服务端事实」表。
 *
 * 【为什么不每次现拉】
 * · 上下文窗口在一次推理会话里是**不变**的，没必要每轮请求
 * · agentRunner 读配置是**同步**的，而 fetch 是异步的 —— 现拉会逼出 callback 或阻塞
 * · 更重要的：Lumina **本来就已经在请求** /v1/models 了（探测本地模型时），
 *   那次响应里的上下文长度被白白扔掉。再发一次纯属浪费。
 *
 * 所以：探测时顺手记下来（rememberServerFacts），运行时同步读（recallServerFacts）。
 * 零额外网络开销，且 agentRunner 不需要知道任何 IO 细节。
 *
 * 只存内存不落盘：服务端改了 n_ctx 重启就会重新探测，
 * 落一份过期的上下文窗口反而比没有更危险。
 */
const _factsCache = new Map<string, ServerModelFacts>()

function cacheKey(modelName: string): string {
  return String(modelName || '').trim().toLowerCase()
}

/**
 * 归一化：把分隔符全去掉，只留字母数字。
 *   Qwen2.5-7B-Instruct → qwen257binstruct
 *   qwen2.5:7b          → qwen257b
 *   qwen2_5-7b-GGUF/q4  → qwen257bggufq4
 * 同一个模型在不同推理服务里叫法差异极大（`-` / `_` / `:` / `/` / 量化后缀），
 * 纯字符串包含匹配不到，而**认错模型的后果是拿到别人的上下文窗口**，
 * 比拿不到更危险。所以只接受「归一化后互为前缀」这种保守匹配。
 */
function normalizedKey(modelName: string): string {
  return String(modelName || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/** 探测阶段调用：把从响应里解出的事实存起来 */
export function rememberServerFacts(modelName: string, facts: ServerModelFacts | null): void {
  if (!modelName || !facts) {return}
  _factsCache.set(cacheKey(modelName), facts)
  // 防止长期运行后无限增长：上限 200 条，超了丢最旧的
  if (_factsCache.size > 200) {
    const oldest = _factsCache.keys().next().value
    if (oldest) {_factsCache.delete(oldest)}
  }
}

/** 运行时调用：同步读回事实；没探测过就返回 null，调用方回退到命名规则 */
export function recallServerFacts(modelName: string | null | undefined): ServerModelFacts | null {
  if (!modelName) {return null}
  const k = cacheKey(modelName)
  const exact = _factsCache.get(k)
  if (exact) {return exact}
  // 模型名在各家推理服务里写法差异极大，先试归一化后的前缀匹配。
  // 保守要求：归一化后一方是另一方的前缀 —— 宁可匹配不到，也不认错模型。
  const nk = normalizedKey(modelName)
  if (nk.length >= 4) {
    for (const [key, val] of _factsCache) {
      const nkey = normalizedKey(key)
      if (nk === nkey || nk.startsWith(nkey) || nkey.startsWith(nk)) {return val}
    }
  }
  return null
}

/** 测试钩子 */
export function __clearServerFactsCache(): void {
  _factsCache.clear()
}

// ── 上下文长度的候选路径 ──
// 顺序有意义：越「具体」的字段越可信，泛用字段放后面兜底。
const CONTEXT_KEYS = [
  'max_context_length',
  'maxContextLength',
  'max_model_len',
  'maxModelLen',
  'context_length',
  'contextLength',
  'n_ctx',
  'nCtx',
  'num_ctx',
  'max_seq_len',
  'max_position_embeddings',
]

/** 视觉/工具能力可能出现的「真值字段」，只认布尔与明确的字符串 */
const TRUEY = new Set(['true', 'yes', '1', 'supported', 'available'])
const FALSEY = new Set(['false', 'no', '0', 'unsupported', 'unavailable'])

function toBool(v: unknown): boolean | null {
  if (typeof v === 'boolean') {return v}
  if (typeof v === 'number') {return v !== 0}
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase()
    if (TRUEY.has(s)) {return true}
    if (FALSEY.has(s)) {return false}
  }
  return null
}

function toContext(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 512 && v <= 10_000_000) {
    return Math.floor(v)
  }
  if (typeof v === 'string') {
    const n = Number(v)
    if (Number.isFinite(n) && n >= 512 && n <= 10_000_000) {return Math.floor(n)}
  }
  return null
}

/** 在对象里按候选键名逐个找上下文长度（含一层嵌套，如 meta / details） */
function findContext(obj: Record<string, unknown>, depth = 0): number | null {
  if (!obj || typeof obj !== 'object' || depth > 2) {return null}
  for (const k of CONTEXT_KEYS) {
    const hit = toContext(obj[k])
    if (hit !== null) {return hit}
  }
  // meta / details / model_info 这类容器再往下一层
  for (const k of ['meta', 'details', 'model_info', 'modelInfo', 'config', 'config', 'info']) {
    const sub = obj[k]
    if (sub && typeof sub === 'object') {
      const hit = findContext(sub as Record<string, unknown>, depth + 1)
      if (hit !== null) {return hit}
    }
  }
  // Ollama：model_info 的键是 "<arch>.context_length"，键名带后缀
  for (const k of Object.keys(obj)) {
    if (/\.context_length$/.test(k)) {
      const hit = toContext(obj[k])
      if (hit !== null) {return hit}
    }
  }
  return null
}

function findVision(obj: Record<string, unknown>, depth = 0): boolean | null {
  if (!obj || typeof obj !== 'object' || depth > 2) {return null}
  for (const k of ['supportsVision', 'vision', 'multimodal', 'is_multimodal', 'capabilities', 'input_modalities', 'modalities']) {
    if (k in obj) {
      const b = toBool(obj[k])
      if (b !== null) {return b}
      // input_modalities 之类是数组：含 image/vision 就算支持
      if (Array.isArray(obj[k])) {
        const arr = (obj[k] as unknown[]).map(x => String(x).toLowerCase())
        if (arr.some(x => x.includes('image') || x.includes('vision') || x.includes('multimodal'))) {return true}
        if (arr.length > 0) {return false}
      }
    }
  }
  for (const k of ['meta', 'details', 'capabilities', 'config']) {
    const sub = obj[k]
    if (sub && typeof sub === 'object') {
      const hit = findVision(sub as Record<string, unknown>, depth + 1)
      if (hit !== null) {return hit}
    }
  }
  return null
}

function findTools(obj: Record<string, unknown>, depth = 0): boolean | null {
  if (!obj || typeof obj !== 'object' || depth > 2) {return null}
  for (const k of ['supportsTools', 'supports_tools', 'tools', 'function_calling', 'functionCalling', 'tool_use', 'capabilities']) {
    if (k in obj) {
      const b = toBool(obj[k])
      if (b !== null) {return b}
    }
  }
  for (const k of ['meta', 'details', 'capabilities', 'config']) {
    const sub = obj[k]
    if (sub && typeof sub === 'object') {
      const hit = findTools(sub as Record<string, unknown>, depth + 1)
      if (hit !== null) {return hit}
    }
  }
  return null
}

/** 从架构族判断是否视觉模型：Ollama 会把视觉模型标成 llava/clip/mllama */
const VISION_FAMILIES = new Set(['clip', 'llava', 'mllama', 'paligemma', 'minicpmv', 'moondream', 'idefics2', 'internvl'])

export function familiesImplyVision(families: string[]): boolean | null {
  if (!families.length) {return null}
  return families.some(f => VISION_FAMILIES.has(String(f).toLowerCase()))
}

function readFamilies(obj: Record<string, unknown>): string[] {
  const d = obj.details as Record<string, unknown> | undefined
  const raw = d?.families ?? obj.families
  if (Array.isArray(raw)) {return raw.map(x => String(x))}
  if (typeof raw === 'string') {return [raw]}
  return []
}

function readParamSizeText(obj: Record<string, unknown>): string | null {
  const d = obj.details as Record<string, unknown> | undefined
  const v = d?.parameter_size ?? obj.parameter_size
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

function readLoaded(obj: Record<string, unknown>): boolean | null {
  const v = obj.state ?? obj.loaded
  const b = toBool(v)
  if (b !== null) {return b}
  if (typeof v === 'string') {
    const s = v.toLowerCase()
    if (s === 'loaded') {return true}
    if (s === 'not-loaded' || s === 'unloaded') {return false}
  }
  return null
}

/**
 * 从 /v1/models 或 /api/tags 的**原始 JSON** 里抽取模型事实。
 *
 * 纯函数：不吃 fetch、不碰 fs，所以能拿几十种真实响应样本穷举验证 ——
 * 而这正是防止「某天接了个新服务商就崩」的唯一办法。
 */
export function parseServerFacts(
  payload: unknown,
  format: ServerFormat = 'unknown',
): ServerModelFacts | null {
  if (!payload || typeof payload !== 'object') {return null}

  const root = payload as Record<string, unknown>

  // 取出模型条目数组：OpenAI 用 data[]，Ollama 用 models[]
  let entries: Record<string, unknown>[] = []
  if (Array.isArray(root.data)) {
    entries = root.data.filter(e => e && typeof e === 'object') as Record<string, unknown>[]
  } else if (Array.isArray(root.models)) {
    entries = root.models.filter(e => e && typeof e === 'object') as Record<string, unknown>[]
  } else if (Array.isArray(payload)) {
    entries = (payload as unknown[]).filter(e => e && typeof e === 'object') as Record<string, unknown>[]
  }
  if (entries.length === 0) {return null}

  const e = entries[0]
  const families = readFamilies(e)
  const contextWindow = findContext(e)
  let supportsVision = findVision(e)
  if (supportsVision === null) { supportsVision = familiesImplyVision(families) }

  return {
    contextWindow,
    supportsVision,
    supportsTools: findTools(e),
    families,
    paramSizeText: readParamSizeText(e),
    loaded: readLoaded(e) ?? undefined,
    ...(format ? {} : {}),
  }
}

/**
 * 从一批模型条目里找出**指定模型**的事实。
 * 不用 entries[0] 是因为 /v1/models 可能一次返回十几个模型，
 * 拿第一个的上下文窗口去套到用户实际用的那个上，是典型的张冠李戴。
 */
export function parseServerFactsFor(
  payload: unknown,
  modelName: string,
): ServerModelFacts | null {
  if (!payload || typeof payload !== 'object') {return null}
  const root = payload as Record<string, unknown>
  let entries: Record<string, unknown>[] = []
  if (Array.isArray(root.data)) {entries = root.data as Record<string, unknown>[]}
  else if (Array.isArray(root.models)) {entries = root.models as Record<string, unknown>[]}
  else if (Array.isArray(payload)) {entries = payload as Record<string, unknown>[]}
  if (!entries.length) {return null}

  const target = String(modelName || '').trim().toLowerCase()
  const idOf = (o: Record<string, unknown>) => String(o.id || o.name || o.model || '').toLowerCase()
  const hit = entries.find(e => idOf(e) === target)
    || entries.find(e => target && idOf(e).includes(target))
    || entries.find(e => target && target.includes(idOf(e)) && idOf(e).length > 0)

  if (!hit) {return null}
  const families = readFamilies(hit)
  let supportsVision = findVision(hit)
  if (supportsVision === null) { supportsVision = familiesImplyVision(families) }
  return {
    contextWindow: findContext(hit),
    supportsVision,
    supportsTools: findTools(hit),
    families,
    paramSizeText: readParamSizeText(hit),
    loaded: readLoaded(hit) ?? undefined,
  }
}
