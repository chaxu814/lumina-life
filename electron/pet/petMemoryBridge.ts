// ============================================================
// pet/petMemoryBridge.ts — 🧠 记忆 → 桌宠大脑 桥接 (v0.2)
//
// 桌宠原本「不记得你」：自主心跳只拿到最近几个事件类型。本桥把 MemoryStore 里的
// 用户画像 / 事实 / 近期对话摘要 / 人格，提炼成一段简短、第一人称、可直接注入
// system prompt 的「你对用户的记忆」，并提供把看到/经历的情节写回记忆的能力。
//
// 依赖以结构化接口注入（不直接 import MemoryStore，避免单测加载 better-sqlite3）；
// 任何方法缺失或抛错都安全降级为空记忆，绝不影响主链路。
// ============================================================

export interface PetFact {
  category?: string
  content: string
  confidence?: number
  source?: string
}
export interface PetUserProfile {
  name?: string
  preferences?: string[]
  habits?: string[]
}
export interface PetPersona {
  traits?: string[]
}

/** MemoryStore 的最小结构化视图（真实 MemoryStore 结构兼容） */
export interface PetMemorySource {
  getMemoryInjectionText?(): string
  getFacts?(category?: string, limit?: number): PetFact[]
  getRecentSummaries?(limit?: number): string[]
  getUserProfile?(): PetUserProfile | null
  getPersona?(): PetPersona | null
  searchFacts?(query: string, limit?: number): PetFact[]
  addFact?(fact: { category: string; content: string; confidence: number; source: string }): unknown
  addConversationSummary?(content: string): unknown
}

export interface PetMemoryContext {
  userName: string | null
  lines: string[]
  /** 可直接拼进 system prompt 的段落；无记忆时为空串 */
  snippet: string
  factCount: number
}

export interface BuildOptions {
  maxFacts?: number
  maxSummaries?: number
  maxLineLen?: number
  /** 是否附带桌宠自我人格标签 */
  includePersona?: boolean
}

const FACT_CATEGORIES = new Set(['user', 'preference', 'habit', 'event', 'environment'])

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

function safe<T>(fn: () => T, fallback: T): T {
  try { return fn() } catch { return fallback }
}

/** 从记忆存储提炼桌宠上下文 */
export function buildPetMemoryContext(src: PetMemorySource | null | undefined, opts: BuildOptions = {}): PetMemoryContext {
  const maxFacts = opts.maxFacts ?? 6
  const maxSummaries = opts.maxSummaries ?? 2
  const maxLineLen = opts.maxLineLen ?? 60
  const includePersona = opts.includePersona ?? true
  const empty: PetMemoryContext = { userName: null, lines: [], snippet: '', factCount: 0 }
  if (!src) {return empty}

  const lines: string[] = []
  const seen = new Set<string>()
  const push = (text: string) => { const c = clip(text, maxLineLen); if (c && !seen.has(c)) { seen.add(c); lines.push(c) } }

  // 用户画像
  const profile = safe(() => src.getUserProfile?.() ?? null, null)
  let userName: string | null = null
  if (profile) {
    if (profile.name) { userName = profile.name; push(`用户叫 ${profile.name}`) }
    for (const p of (profile.preferences ?? []).slice(0, 3)) {push(`喜欢 ${p}`)}
    for (const h of (profile.habits ?? []).slice(0, 2)) {push(`习惯 ${h}`)}
  }

  // 事实（按置信度优先，聚焦用户/偏好/事件/环境）
  const facts = safe(() => src.getFacts?.(undefined, 40) ?? [], [])
  const picked = facts
    .filter(f => f && typeof f.content === 'string' && (!f.category || FACT_CATEGORIES.has(f.category)))
    .sort((a, b) => (b.confidence ?? 0.5) - (a.confidence ?? 0.5))
    .slice(0, maxFacts)
  for (const f of picked) {push(f.content)}

  // 近期对话摘要（让它知道最近发生过什么）
  const summaries = safe(() => src.getRecentSummaries?.(maxSummaries) ?? [], [])
  for (const s of summaries.slice(0, maxSummaries)) {push(`最近：${s}`)}

  // 自我人格（轻量一句）
  if (includePersona) {
    const persona = safe(() => src.getPersona?.() ?? null, null)
    if (persona?.traits?.length) {push(`你的性格：${persona.traits.slice(0, 3).join('、')}`)}
  }

  const snippet = lines.length
    ? '【你对用户的记忆，请自然地运用，不要逐条念出来】\n' + lines.map(l => `- ${l}`).join('\n')
    : ''
  return { userName, lines, snippet, factCount: picked.length }
}

/** 把一次「看到/经历」的情节写入记忆（视觉情节记忆闭环） */
export function recordObservedEpisode(src: PetMemorySource | null | undefined, text: string, confidence = 0.6): boolean {
  const content = clip(text ?? '', 120)
  if (!src?.addFact || !content) {return false}
  return safe(() => {
    src.addFact!({ category: 'event', content: `看到：${content}`, confidence, source: 'observed' })
    return true
  }, false)
}

/** 记住一条关于用户的事实（用户亲口说的，置信度高） */
export function rememberUserFact(src: PetMemorySource | null | undefined, content: string, confidence = 0.85): boolean {
  const c = clip(content ?? '', 120)
  if (!src?.addFact || !c) {return false}
  return safe(() => {
    src.addFact!({ category: 'user', content: c, confidence, source: 'user_said' })
    return true
  }, false)
}
