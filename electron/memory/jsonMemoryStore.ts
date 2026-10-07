// ============================================================
// jsonMemoryStore.ts — MemoryStore 的纯 JSON 兜底实现
//
// 【为什么存在】
// MemoryStore 依赖 better-sqlite3 原生模块。该模块须与目标运行时
// （Electron / Node）的 NODE_MODULE_VERSION 严格匹配。一旦 Electron/Node
// 升级、ABI 漂移，原生模块加载会抛错，导致记忆系统整体不可用——
// 这正是开发期用 Node 22 跑测试桩时 memory_save 报错的根因。
//
// 本类在「原生模块加载失败」时顶上：用一份 JSON 文件提供等价的内存
// 持久化能力，保证 Lumina 在任何环境下都能"记住"用户，绝不静默丢记忆。
//
// 【设计】
// - 复用 memoryStore.ts 的类型与纯函数（置信度收敛、内容指纹、未验证标注），
//   行为与主存储一致，避免两套逻辑分叉。
// - 关键表（facts / semantic / fragments / conversations / reflections /
//   persona / 关系事件）全部落盘到同一个 JSON 文件，每次写入即同步落盘。
// - 仅作为兜底；生产环境 better-sqlite3 可用时不会走到这里。
// ============================================================

import fs from 'fs'
import path from 'path'
import { getMemoryDbPath } from '../paths'
import { isEnabled } from '../core/featureFlags'
import {
  type RelationshipEventInput,
  type RelationshipEventQuery,
  type RelationshipEvent,
} from './relationshipEvents'
import {
  type FactEntry,
  type ReflectionEntry,
  type PersonaTraits,
  type UserProfile,
  type MemoryConfig,
  type StructuredMemory,
  type FactSource,
  normalizeFactContent,
  factContentKey,
  resolveConfidence,
  markUnverifiedFact,
  DEFAULT_FACT_SOURCE,
  LEGACY_CONFIDENCE_CAP,
} from './memoryStore'

interface FragmentRow { id: number; type: string; content: string; created_at: string; updated_at: string; metadata?: string }
interface ConversationRow { id: number; session_id: string; role: string; content: string; tool_calls?: string; created_at: string }
interface FactRow { id: number; category: string; content: string; confidence: number; source: string; created_at: string; content_key?: string; hit_count: number }
interface ReflectionRow { id: number; topic: string; insight: string; action: string; created_at: string }
interface PersonaRow { id: number; traits_json: string; created_at: string }
interface SemanticRow { key: string; value: string; metadata: string; created_at: string }

interface JsonModel {
  fragments: FragmentRow[]
  conversations: ConversationRow[]
  facts: FactRow[]
  reflections: ReflectionRow[]
  persona: PersonaRow[]
  semantic: SemanticRow[]
  relEvents: RelationshipEvent[]
  seq: Record<string, number>
}

function emptyModel(): JsonModel {
  return { fragments: [], conversations: [], facts: [], reflections: [], persona: [], semantic: [], relEvents: [], seq: {} }
}

function nowStr(): string { return new Date().toISOString() }

/**
 * 纯 JSON 兜底记忆存储。完整镜像 MemoryStore 公共接口，
 * 仅在 better-sqlite3 不可用时由 getMemoryStore() 选用。
 */
export class JsonMemoryStore {
  private model: JsonModel
  private filePath: string
  private relSeq = 1

  // getDb() 主存储返回原生句柄；兜底无句柄，返回 null（调用方在兜底场景不依赖高级 SQL）。
  getDb(): any { return null }

  constructor(dbPath?: string) {
    const target = dbPath && dbPath !== ':memory:'
      ? dbPath.replace(/\.db(\.wal)?$/i, '.json')
      : getMemoryDbPath().replace(/\.db(\.wal)?$/i, '.json')
    this.filePath = target
    const dir = path.dirname(target)
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }) }
    this.model = this.load()
    // 关系事件自增序号接续
    this.relSeq = (this.model.relEvents.reduce((m, e) => Math.max(m, e.id || 0), 0)) + 1
  }

  private load(): JsonModel {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8')
        const parsed = JSON.parse(raw) as Partial<JsonModel>
        return { ...emptyModel(), ...parsed, seq: parsed.seq || {} }
      }
    } catch (e) {
      console.error('[JsonMemoryStore] 读取兜底记忆失败，使用空库:', e)
    }
    return emptyModel()
  }

  private save(): void {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.model), 'utf8')
    } catch (e) {
      console.error('[JsonMemoryStore] 写入兜底记忆失败（已上抛，让调用方如实回报）:', e)
      throw e
    }
  }

  private nextId(key: string): number {
    const n = (this.model.seq[key] || 0) + 1
    this.model.seq[key] = n
    return n
  }

  // ── USER 画像 ───────────────────────────────────────────
  getUserProfile(): UserProfile | null {
    const row = [...this.model.fragments].reverse().find(f => f.type === 'user_profile')
    if (!row) { return null }
    try { return { ...JSON.parse(row.content) } } catch { return null }
  }

  saveUserProfile(profile: Partial<UserProfile>): void {
    const existing = this.getUserProfile()
    const merged: UserProfile = {
      name: profile.name || existing?.name,
      preferences: [...new Set([...(existing?.preferences || []), ...(profile.preferences || [])])].slice(-30),
      habits: [...new Set([...(existing?.habits || []), ...(profile.habits || [])])].slice(-20),
      communicationStyle: profile.communicationStyle || existing?.communicationStyle || 'casual',
      personality: profile.personality || existing?.personality || '',
      timestamp: nowStr(),
    }
    this.upsertFragment('user_profile', JSON.stringify(merged))
    this.save()
  }

  // ── MEMORY 环境配置 ─────────────────────────────────────
  getMemoryConfig(): MemoryConfig | null {
    const row = [...this.model.fragments].reverse().find(f => f.type === 'memory_config')
    if (!row) { return null }
    try { return JSON.parse(row.content) } catch { return null }
  }

  saveMemoryConfig(config: Partial<MemoryConfig>): void {
    const existing = this.getMemoryConfig()
    const merged: MemoryConfig = {
      systemInfo: [...new Set([...(existing?.systemInfo || []), ...(config.systemInfo || [])])].slice(-15),
      toolExperience: [...new Set([...(existing?.toolExperience || []), ...(config.toolExperience || [])])].slice(-20),
      projectConventions: [...new Set([...(existing?.projectConventions || []), ...(config.projectConventions || [])])].slice(-15),
      lessons: [...new Set([...(existing?.lessons || []), ...(config.lessons || [])])].slice(-20),
      paths: { ...(existing?.paths || {}), ...(config.paths || {}) },
      timestamp: nowStr(),
    }
    this.upsertFragment('memory_config', JSON.stringify(merged))
    this.save()
  }

  // ── 对话摘要 ────────────────────────────────────────────
  private upsertFragment(type: string, content: string): void {
    const existing = [...this.model.fragments].reverse().find(f => f.type === type)
    const ts = nowStr()
    if (existing) {
      existing.content = content
      existing.updated_at = ts
    } else {
      this.model.fragments.push({ id: this.nextId('fragment'), type, content, created_at: ts, updated_at: ts })
    }
  }

  addConversationSummary(content: string): number {
    const id = this.nextId('fragment')
    this.model.fragments.push({ id, type: 'conversation_summary', content, created_at: nowStr(), updated_at: nowStr() })
    this.save()
    return id
  }

  getRecentSummaries(limit = 5): string[] {
    return this.model.fragments
      .filter(f => f.type === 'conversation_summary')
      .slice(-limit)
      .map(f => f.content)
  }

  getUnsummarizedCount(): number {
    return this.model.conversations.length
  }

  // ── 对话历史 ────────────────────────────────────────────
  addConversation(sessionId: string, role: string, content: string, toolCalls?: string): void {
    this.model.conversations.push({ id: this.nextId('conv'), session_id: sessionId, role, content, tool_calls: toolCalls || undefined, created_at: nowStr() })
    this.save()
  }

  getConversation(sessionId: string, limit = 50): Array<{ role: string; content: string }> {
    return this.model.conversations
      .filter(c => c.session_id === sessionId)
      .slice(-limit)
      .map(c => ({ role: c.role, content: c.content }))
  }

  // ── Layer 1: 事实记忆 ──────────────────────────────────
  private toFactEntry(r: FactRow): FactEntry {
    return {
      id: r.id,
      category: r.category,
      content: r.content,
      confidence: r.confidence,
      source: r.source,
      timestamp: r.created_at,
    }
  }

  addFact(fact: { category: string; content: string; confidence?: number; source?: string }): number {
    const ts = nowStr()
    const source: FactSource = ((fact.source || '').trim() || DEFAULT_FACT_SOURCE) as FactSource
    const confidence = resolveConfidence(source, fact.confidence)
    const contentKey = factContentKey(fact.category, fact.content)

    const existing = [...this.model.facts].reverse().find(f => f.content_key === contentKey)
    if (existing) {
      if (confidence > (existing.confidence || 0) + 1e-9) {
        existing.content = fact.content
        existing.confidence = confidence
        existing.source = source
        existing.created_at = ts
        existing.content_key = contentKey
      } else {
        existing.hit_count = (existing.hit_count || 0) + 1
      }
      this.save()
      return existing.id
    }
    const id = this.nextId('fact')
    this.model.facts.push({ id, category: fact.category, content: fact.content, confidence, source, created_at: ts, content_key: contentKey, hit_count: 0 })
    this.save()
    return id
  }

  getFacts(category?: string, limit = 20): FactEntry[] {
    const list = this.model.facts
      .filter(f => !category || f.category === category)
      .sort((a, b) => (b.confidence - a.confidence) || (b.id - a.id))
      .slice(0, limit)
    return list.map(r => this.toFactEntry(r))
  }

  correctFact(
    id: number,
    fact: { category: string; content: string; source?: string; confidence?: number },
  ): { ok: boolean; newId: number; demoted: number[]; reason?: string } {
    const old = this.model.facts.find(f => f.id === id)
    if (!old) {
      const newId = this.addFact(fact)
      return { ok: false, newId, demoted: [], reason: `未找到 id=${id} 的事实，已作为新记忆保存` }
    }
    const newId = this.addFact(fact)
    const demoted: number[] = []
    if (newId !== id) {
      old.confidence = 0.05
      old.source = 'superseded'
      old.created_at = nowStr()
      demoted.push(id)
      this.save()
    }
    return { ok: true, newId, demoted }
  }

  deleteFact(id: number): boolean {
    const before = this.model.facts.length
    this.model.facts = this.model.facts.filter(f => f.id !== id)
    const changed = this.model.facts.length !== before
    if (changed) { this.save() }
    return changed
  }

  searchFacts(query: string, limit = 5): FactEntry[] {
    const q = query.toLowerCase()
    return this.model.facts
      .filter(f => f.content.toLowerCase().includes(q))
      .sort((a, b) => (b.confidence - a.confidence) || (b.id - a.id))
      .slice(0, limit)
      .map(r => this.toFactEntry(r))
  }

  // ── Layer 2: 反思记忆 ──────────────────────────────────
  addReflection(reflection: Omit<ReflectionEntry, 'timestamp'>): number {
    const id = this.nextId('reflection')
    this.model.reflections.push({ id, topic: reflection.topic, insight: reflection.insight, action: reflection.action || '', created_at: nowStr() })
    this.save()
    return id
  }

  getReflections(limit = 10): ReflectionEntry[] {
    return [...this.model.reflections].reverse().slice(0, limit).map(r => ({ topic: r.topic, insight: r.insight, action: r.action, timestamp: r.created_at }))
  }

  // ── Layer 3: 人格记忆 ─────────────────────────────────
  getPersona(): PersonaTraits | null {
    const row = [...this.model.persona].reverse()[0]
    if (!row) { return null }
    try { return JSON.parse(row.traits_json) } catch { return null }
  }

  updatePersona(updates: Partial<PersonaTraits>): void {
    const existing = this.getPersona()
    const ts = nowStr()
    const merged: PersonaTraits = {
      openness: updates.openness ?? existing?.openness ?? 0.7,
      conscientiousness: updates.conscientiousness ?? existing?.conscientiousness ?? 0.8,
      extraversion: updates.extraversion ?? existing?.extraversion ?? 0.6,
      agreeableness: updates.agreeableness ?? existing?.agreeableness ?? 0.8,
      playfulness: updates.playfulness ?? existing?.playfulness ?? 0.7,
      traits: updates.traits || existing?.traits || ['友善', '乐于助人'],
      evolutionLog: [...(existing?.evolutionLog || []), ...(updates.evolutionLog || [])].slice(-50),
      timestamp: ts,
    }
    if (updates.traits || updates.evolutionLog) {
      const changeDesc = updates.evolutionLog?.[updates.evolutionLog.length - 1] || '人格更新'
      merged.evolutionLog.push(`[${ts}] ${changeDesc}`)
      merged.evolutionLog = merged.evolutionLog.slice(-50)
    }
    this.model.persona.push({ id: this.nextId('persona'), traits_json: JSON.stringify(merged), created_at: ts })
    this.save()
  }

  savePersonaTraits(bigFive: { openness: number; conscientiousness: number; extraversion: number; agreeableness: number; playfulness: number }): void {
    this.updatePersona(bigFive)
  }

  addPersonaTraits(traits: string[]): void {
    const existing = this.getPersona()
    const merged = [...(existing?.traits || []), ...traits]
    this.updatePersona({ traits: [...new Set(merged)].slice(0, 20) })
  }

  addEvolutionLog(entry: string): void {
    this.updatePersona({ evolutionLog: [entry] })
  }

  // ── I4: 关系事件记忆 ──────────────────────────────────
  recordRelationshipEvent(event: RelationshipEventInput): number {
    if (!isEnabled('memory.relationshipEvents')) { return -1 }
    const id = this.relSeq++
    const full: RelationshipEvent = {
      id,
      kind: event.kind,
      title: event.title,
      detail: event.detail || '',
      timestamp: nowStr(),
      emotional_weight: event.emotional_weight ?? 1,
      resolved: false,
      referenced_count: 0,
    }
    this.model.relEvents.push(full)
    this.save()
    return id
  }

  getRelationshipEvents(query: RelationshipEventQuery = {}): RelationshipEvent[] {
    if (!isEnabled('memory.relationshipEvents')) { return [] }
    let list = [...this.model.relEvents]
    if (query.kind) { list = list.filter(e => e.kind === query.kind) }
    if (query.since) { list = list.filter(e => e.timestamp >= query.since!) }
    if (query.limit) { list = list.slice(-query.limit) }
    return list
  }

  getUnresolvedPromises(limit = 5): RelationshipEvent[] {
    if (!isEnabled('memory.relationshipEvents')) { return [] }
    return this.model.relEvents
      .filter(e => !e.resolved)
      .sort((a, b) => (b.emotional_weight || 1) - (a.emotional_weight || 1))
      .slice(0, limit)
  }

  incrementRelationshipReferenced(id: number): void {
    if (!isEnabled('memory.relationshipEvents')) { return }
    const e = this.model.relEvents.find(x => x.id === id)
    if (e) { e.referenced_count = (e.referenced_count || 0) + 1; this.save() }
  }

  markRelationshipResolved(id: number): void {
    if (!isEnabled('memory.relationshipEvents')) { return }
    const e = this.model.relEvents.find(x => x.id === id)
    if (e) { e.resolved = true; this.save() }
  }

  getRelationshipEventDigest(limit = 3): string {
    if (!isEnabled('memory.relationshipEvents')) { return '' }
    const items = this.getUnresolvedPromises(limit)
    if (items.length === 0) { return '' }
    const kindMap: Record<string, string> = { promise: '答应过', sad_moment: '上次难过', argument: '闹过别扭' }
    return items.map(e => `- ${kindMap[e.kind] || e.kind}：${e.title}`).join('\n')
  }

  // ── 结构化记忆输出 ─────────────────────────────────────
  getStructuredMemory(): StructuredMemory {
    return {
      user: this.getUserProfile() || { preferences: [], habits: [], communicationStyle: 'casual', personality: '', timestamp: '' },
      memory: this.getMemoryConfig() || { systemInfo: [], toolExperience: [], projectConventions: [], lessons: [], paths: {}, timestamp: '' },
      facts: this.getFacts(undefined, 20),
      reflections: this.getReflections(10),
      persona: this.getPersona(),
    }
  }

  getMemoryInjectionText(): string {
    const mem = this.getStructuredMemory()
    const parts: string[] = []

    const factsByCategory: Record<string, string[]> = {}
    for (const f of mem.facts) {
      if (!factsByCategory[f.category]) { factsByCategory[f.category] = [] }
      factsByCategory[f.category].push(markUnverifiedFact(f.content, f))
    }
    if (Object.keys(factsByCategory).length > 0) {
      const factLines: string[] = []
      for (const [cat, items] of Object.entries(factsByCategory)) {
        const label = { user: '用户', environment: '环境', event: '事件', preference: '偏好', habit: '习惯' }[cat] || cat
        factLines.push(`- ${label}: ${items.join('；')}`)
      }
      parts.push('## 事实记忆\n' + factLines.join('\n'))
    }

    if (mem.reflections.length > 0) {
      const refLines = mem.reflections.slice(0, 5).map(r => `- [${r.topic}] ${r.insight}${r.action ? ` → 行动: ${r.action}` : ''}`)
      parts.push('## 反思记忆\n' + refLines.join('\n'))
    }

    if (mem.persona?.traits?.length) {
      parts.push(`## 人格画像\n- 特质: ${mem.persona.traits.join('、')}`)
    }

    const userLines: string[] = []
    if (mem.user.preferences.length > 0) { userLines.push(`偏好: ${mem.user.preferences.join('、')}`) }
    if (mem.user.habits.length > 0) { userLines.push(`习惯: ${mem.user.habits.join('、')}`) }
    if (mem.user.communicationStyle) { userLines.push(`沟通风格: ${mem.user.communicationStyle}`) }
    if (userLines.length > 0) { parts.push('## 用户画像\n' + userLines.map(l => `- ${l}`).join('\n')) }

    const memLines: string[] = []
    if (mem.memory.lessons.length > 0) { memLines.push(`经验教训: ${mem.memory.lessons.join(' | ')}`) }
    if (mem.memory.projectConventions.length > 0) { memLines.push(`项目约定: ${mem.memory.projectConventions.join(' | ')}`) }
    if (mem.memory.toolExperience.length > 0) { memLines.push(`工具经验: ${mem.memory.toolExperience.join(' | ')}`) }
    if (memLines.length > 0) { parts.push('## 环境配置\n' + memLines.map(l => `- ${l}`).join('\n')) }

    const summaries = this.getRecentSummaries(3)
    if (summaries.length > 0) { parts.push('## 最近对话摘要\n' + summaries.map((s, i) => `[${i + 1}] ${s}`).join('\n')) }

    if (isEnabled('memory.relationshipEvents')) {
      const digest = this.getRelationshipEventDigest(3)
      if (digest) { parts.push('## 我们之间还没翻篇的事\n' + digest) }
    }

    return parts.join('\n\n')
  }

  // ── v3.0: Semantic memory ─────────────────────────────
  addMemory(entry: { key: string; value: string; metadata?: Record<string, string> }): void {
    const existing = this.model.semantic.find(s => s.key === entry.key)
    const ts = nowStr()
    if (existing) {
      existing.value = entry.value
      existing.metadata = JSON.stringify(entry.metadata || {})
      existing.created_at = ts
    } else {
      this.model.semantic.push({ key: entry.key, value: entry.value, metadata: JSON.stringify(entry.metadata || {}), created_at: ts })
    }
    this.save()
  }

  getAllMemories(): Array<{ key: string; value: string; metadata: any }> {
    return this.model.semantic.map(s => ({ key: s.key, value: s.value, metadata: JSON.parse(s.metadata || '{}') }))
  }

  cleanup(maxSummaries = 50): void {
    const summaries = this.model.fragments.filter(f => f.type === 'conversation_summary')
    if (summaries.length > maxSummaries) {
      const keep = new Set(summaries.slice(-maxSummaries).map(f => f.id))
      this.model.fragments = this.model.fragments.filter(f => f.type !== 'conversation_summary' || keep.has(f.id))
      this.save()
    }
  }

  close(): void { /* JSON 已每次写入，无需关闭 */ }
}
