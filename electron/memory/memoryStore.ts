// ============================================================
// memoryStore.ts — 三层记忆系统 (v2.4)
//
// v2.4 新增:
//   - MemoryVectorStore: 向量化语义检索 (P3)
//   - TF-IDF 本地向量化 (零依赖)
//   - 余弦相似度排序
//
// 架构 (借鉴 N.E.K.O 三层模型):
//   Layer 1: Facts (事实记忆) — 用户信息、环境、事件
//   Layer 2: Reflection (反思记忆) — 对话反思、经验教训
//   Layer 3: Persona (人格记忆) — AI 人格演化
//
//   Chat messages → Summarizer(10轮压缩) → Global Refiner
//       → Facts + Reflection + Persona
//       → 注入 System Prompt
// 持久化: SQLite (better-sqlite3) + WAL mode
// ============================================================

import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'
import { getMemoryDbPath } from '../paths'

// ── 三层记忆类型 ────────────────────────────────────────

export interface FactEntry {
  id: number
  category: string  // 'user' | 'environment' | 'event' | 'preference' | 'habit' | 'agent_memory'
  content: string
  confidence: number  // 0-1, 事实确信度
  source: string      // 来源: 'user_said' | 'observed' | 'inferred' | 'agent_tool'
  timestamp: string
}

export interface ReflectionEntry {
  topic: string
  insight: string
  action: string       // 基于反思应采取的行动
  timestamp: string
}

export interface PersonaTraits {
  openness: number       // 0-1 开放度
  conscientiousness: number // 0-1 尽责度
  extraversion: number   // 0-1 外向度
  agreeableness: number  // 0-1 宜人度
  playfulness: number    // 0-1 趣味度
  traits: string[]       // 人格标签: ['活泼', '细心', '偶尔毒舌']
  evolutionLog: string[] // 人格演化日志
  timestamp: string
}

export interface UserProfile {
  name?: string
  preferences: string[]
  habits: string[]
  communicationStyle: string
  personality: string
  timestamp: string
}

export interface MemoryConfig {
  systemInfo: string[]
  toolExperience: string[]
  projectConventions: string[]
  lessons: string[]
  paths: Record<string, string>
  timestamp: string
}

export interface StructuredMemory {
  user: UserProfile
  memory: MemoryConfig
  facts: FactEntry[]
  reflections: ReflectionEntry[]
  persona: PersonaTraits | null
}

/**
 * SQLite 持久化记忆存储 — 支持三层记忆（事实/反思/人格）+ 对话历史 + 结构化记忆
 *
 * 表结构:
 * - memory_fragments: 用户画像 / 记忆配置 / 对话摘要
 * - conversation_history: 完整对话日志
 * - facts: 可检索的事实记忆（含置信度、来源、时间戳）
 * - reflections: 对话后的反思洞察
 * - persona_traits: 人格五维度 + 标签 + 演化日志
 */
export class MemoryStore {
  private db: Database.Database

  /** 获取底层 SQLite 数据库实例（供高级查询使用） */
  getDb(): Database.Database {
    return this.db
  }

  /**
   * 打开/创建 SQLite 数据库，启用 WAL 模式，初始化表结构
   * @param dbPath - 可选数据库路径，默认 `%APPDATA%/lumina-memory.db`
   */
  constructor(dbPath?: string) {
    const isMemory = dbPath === ':memory:'
    // 跨平台规范路径：Electron userData / macOS Application Support / Linux XDG；
    // 旧版散落的 %APPDATA%/lumina-memory.db 会被继续沿用（不丢老用户数据）。
    const targetPath = isMemory ? ':memory:' : (dbPath || getMemoryDbPath())
    if (!isMemory) {
      const dir = path.dirname(targetPath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    }
    this.db = new Database(targetPath)
    this.db.pragma('journal_mode = WAL')
    this.initTables()
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_fragments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL CHECK(type IN ('conversation_summary','user_profile','memory_config','facts','reflection','persona')),
        content TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime')),
        metadata TEXT
      );
      CREATE TABLE IF NOT EXISTS conversation_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
        content TEXT NOT NULL,
        tool_calls TEXT,
        created_at TEXT DEFAULT (datetime('now','localtime'))
      );
      CREATE TABLE IF NOT EXISTS facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL CHECK(category IN ('user','environment','event','preference','habit','agent_memory')),
        content TEXT NOT NULL,
        confidence REAL DEFAULT 1.0,
        source TEXT DEFAULT 'user_said',
        created_at TEXT DEFAULT (datetime('now','localtime'))
      );
      CREATE TABLE IF NOT EXISTS reflections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        topic TEXT NOT NULL,
        insight TEXT NOT NULL,
        action TEXT,
        created_at TEXT DEFAULT (datetime('now','localtime'))
      );
      CREATE TABLE IF NOT EXISTS persona_traits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        traits_json TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now','localtime'))
      );
      CREATE INDEX IF NOT EXISTS idx_memory_type ON memory_fragments(type);
      CREATE INDEX IF NOT EXISTS idx_conv_session ON conversation_history(session_id);
      CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category);
      CREATE INDEX IF NOT EXISTS idx_reflections_created ON reflections(created_at);
      CREATE TABLE IF NOT EXISTS semantic_memories (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        metadata TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now','localtime'))
      );
    `)

    // 迁移：扩展 facts.category 约束以支持 agent_memory
    this.migrateFactsCategory()
  }

  /** 将旧 facts 表（5类）迁移为允许 agent_memory 的新表 */
  private migrateFactsCategory(): void {
    try {
      const row = this.db.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='facts'"
      ).get() as { sql?: string } | undefined
      const sql = row?.sql ?? ''
      // 已包含 agent_memory 则跳过
      if (sql.includes('agent_memory')) return

      console.log('[MemoryStore] 迁移 facts 表：扩展 category 约束...')
      this.db.exec(`
        CREATE TABLE facts_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          category TEXT NOT NULL CHECK(category IN ('user','environment','event','preference','habit','agent_memory')),
          content TEXT NOT NULL,
          confidence REAL DEFAULT 1.0,
          source TEXT DEFAULT 'user_said',
          created_at TEXT DEFAULT (datetime('now','localtime'))
        );
        INSERT INTO facts_new SELECT * FROM facts;
        DROP TABLE facts;
        ALTER TABLE facts_new RENAME TO facts;
        CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category);
      `)
      console.log('[MemoryStore] facts 表迁移完成')
    } catch (err) {
      console.error('[MemoryStore] facts 表迁移失败:', err)
    }
  }

  // ── CRUD ─────────────────────────────────────────────────

  private saveFragment(type: string, content: string, metadata?: string): number {
    const r = this.db.prepare('INSERT INTO memory_fragments (type,content,metadata) VALUES (?,?,?)').run(type, content, metadata || null)
    return r.lastInsertRowid as number
  }

  private updateFragment(id: number, content: string): void {
    this.db.prepare("UPDATE memory_fragments SET content=?, updated_at=datetime('now','localtime') WHERE id=?").run(content, id)
  }

  // ── USER 画像 ───────────────────────────────────────────

  getUserProfile(): UserProfile | null {
    const row = this.db.prepare("SELECT content FROM memory_fragments WHERE type='user_profile' ORDER BY id DESC LIMIT 1").get() as { content: string } | undefined
    if (!row) return null
    try { return { ...JSON.parse(row.content) } } catch { return null }
  }

  saveUserProfile(profile: Partial<UserProfile>): void {
    const existing = this.getUserProfile()
    const merged: UserProfile = {
      name: profile.name || existing?.name,
      preferences: dedupe([...(existing?.preferences || []), ...(profile.preferences || [])]).slice(-30),
      habits: dedupe([...(existing?.habits || []), ...(profile.habits || [])]).slice(-20),
      communicationStyle: profile.communicationStyle || existing?.communicationStyle || 'casual',
      personality: profile.personality || existing?.personality || '',
      timestamp: new Date().toISOString(),
    }
    const row = this.db.prepare("SELECT id FROM memory_fragments WHERE type='user_profile' ORDER BY id DESC LIMIT 1").get() as { id: number } | undefined
    if (row) this.updateFragment(row.id, JSON.stringify(merged))
    else this.saveFragment('user_profile', JSON.stringify(merged))
  }

  // ── MEMORY 环境配置 ─────────────────────────────────────

  getMemoryConfig(): MemoryConfig | null {
    const row = this.db.prepare("SELECT content FROM memory_fragments WHERE type='memory_config' ORDER BY id DESC LIMIT 1").get() as { content: string } | undefined
    if (!row) return null
    try { return JSON.parse(row.content) } catch { return null }
  }

  saveMemoryConfig(config: Partial<MemoryConfig>): void {
    const existing = this.getMemoryConfig()
    const merged: MemoryConfig = {
      systemInfo: dedupe([...(existing?.systemInfo || []), ...(config.systemInfo || [])]).slice(-15),
      toolExperience: dedupe([...(existing?.toolExperience || []), ...(config.toolExperience || [])]).slice(-20),
      projectConventions: dedupe([...(existing?.projectConventions || []), ...(config.projectConventions || [])]).slice(-15),
      lessons: dedupe([...(existing?.lessons || []), ...(config.lessons || [])]).slice(-20),
      paths: { ...(existing?.paths || {}), ...(config.paths || {}) },
      timestamp: new Date().toISOString(),
    }
    const row = this.db.prepare("SELECT id FROM memory_fragments WHERE type='memory_config' ORDER BY id DESC LIMIT 1").get() as { id: number } | undefined
    if (row) this.updateFragment(row.id, JSON.stringify(merged))
    else this.saveFragment('memory_config', JSON.stringify(merged))
  }

  // ── 对话摘要 ────────────────────────────────────────────

  addConversationSummary(content: string): number {
    return this.saveFragment('conversation_summary', content)
  }

  getRecentSummaries(limit = 5): string[] {
    return (this.db.prepare("SELECT content FROM memory_fragments WHERE type='conversation_summary' ORDER BY id DESC LIMIT ?").all(limit) as { content: string }[]).map(r => r.content)
  }

  /** 获取未总结的对话记录数（用于触发摘要） */
  getUnsummarizedCount(): number {
    // 计算 conversation_history 表中最近一次摘要之后的新增对话数
    const lastSummary = this.db.prepare(
      "SELECT id FROM memory_fragments WHERE type='conversation_summary' ORDER BY id DESC LIMIT 1"
    ).get() as { id: number } | undefined

    if (!lastSummary) {
      // 从未总结过，统计所有对话
      const row = this.db.prepare("SELECT COUNT(*) as c FROM conversation_history").get() as { c: number }
      return row?.c ?? 0
    }

    // 统计比最近摘要更晚的对话数（简化：统计总数 - 摘要ID之前）
    const total = (this.db.prepare("SELECT COUNT(*) as c FROM conversation_history").get() as { c: number }).c
    const summarized = (this.db.prepare(
      "SELECT COUNT(*) as c FROM conversation_history WHERE id <= ?"
    ).get(lastSummary.id) as { c: number }).c
    return Math.max(0, total - summarized)
  }

  // ── 对话历史 ────────────────────────────────────────────

  addConversation(sessionId: string, role: string, content: string, toolCalls?: string): void {
    this.db.prepare('INSERT INTO conversation_history (session_id,role,content,tool_calls) VALUES (?,?,?,?)').run(sessionId, role, content, toolCalls || null)
  }

  getConversation(sessionId: string, limit = 50): Array<{ role: string; content: string }> {
    return this.db.prepare('SELECT role,content FROM conversation_history WHERE session_id=? ORDER BY id ASC LIMIT ?').all(sessionId, limit) as Array<{ role: string; content: string }>
  }

  // ── Layer 1: 事实记忆 (Facts) ──────────────────────────

  /**
   * 添加一条事实记忆
   * @param fact - 分类、内容、确信度、来源（不含 id 和 timestamp，由系统自动生成）
   * @returns 新事实的数据库 ID
   */
  addFact(fact: Omit<FactEntry, 'id' | 'timestamp'>): number {
    const ts = new Date().toISOString()
    return this.db.prepare(
      'INSERT INTO facts (category, content, confidence, source, created_at) VALUES (?,?,?,?,?)'
    ).run(fact.category, fact.content, fact.confidence ?? 1.0, fact.source || 'user_said', ts).lastInsertRowid as number
  }

  getFacts(category?: string, limit = 20): FactEntry[] {
    const sql = category
      ? 'SELECT * FROM facts WHERE category=? ORDER BY id DESC LIMIT ?'
      : 'SELECT * FROM facts ORDER BY id DESC LIMIT ?'
    const params = category ? [category, limit] : [limit]
    return (this.db.prepare(sql).all(...params) as any[]).map(r => ({
      id: r.id as number,
      category: r.category,
      content: r.content,
      confidence: r.confidence,
      source: r.source,
      timestamp: r.created_at,
    }))
  }

  /** 删除指定事实 */
  deleteFact(id: number): boolean {
    const result = this.db.prepare('DELETE FROM facts WHERE id=?').run(id)
    return result.changes > 0
  }

  /** 查找相关事实 (模糊搜索) */
  /**
   * 关键词搜索事实记忆（SQL LIKE 匹配）
   * @param query - 搜索关键词
   * @param limit - 返回条数上限（默认 5）
   * @returns 匹配的事实列表，按确信度降序排列
   */
  searchFacts(query: string, limit = 5): FactEntry[] {
    const rows = this.db.prepare(
      `SELECT * FROM facts WHERE content LIKE ? ORDER BY confidence DESC, id DESC LIMIT ?`
    ).all(`%${query}%`, limit) as any[]
    return rows.map(r => ({
      id: r.id as number,
      category: r.category,
      content: r.content,
      confidence: r.confidence,
      source: r.source,
      timestamp: r.created_at,
    }))
  }

  // ── Layer 2: 反思记忆 (Reflections) ────────────────────

  /**
   * 添加一条反思记忆
   * @param reflection - 主题、洞察、行动建议（不含 timestamp，由系统生成）
   * @returns 新反思的数据库 ID
   */
  addReflection(reflection: Omit<ReflectionEntry, 'timestamp'>): number {
    const ts = new Date().toISOString()
    return this.db.prepare(
      'INSERT INTO reflections (topic, insight, action, created_at) VALUES (?,?,?,?)'
    ).run(reflection.topic, reflection.insight, reflection.action || '', ts).lastInsertRowid as number
  }

  getReflections(limit = 10): ReflectionEntry[] {
    return (this.db.prepare('SELECT * FROM reflections ORDER BY id DESC LIMIT ?').all(limit) as any[]).map(r => ({
      topic: r.topic,
      insight: r.insight,
      action: r.action,
      timestamp: r.created_at,
    }))
  }

  // ── Layer 3: 人格记忆 (Persona) ─────────────────────────

  getPersona(): PersonaTraits | null {
    const row = this.db.prepare('SELECT traits_json FROM persona_traits ORDER BY id DESC LIMIT 1').get() as { traits_json: string } | undefined
    if (!row) return null
    try { return JSON.parse(row.traits_json) } catch { return null }
  }

  /**
   * 更新人格特质（合并式更新，未指定字段保留原值）
   * @param updates - 要更新的人格维度或标签
   */
  updatePersona(updates: Partial<PersonaTraits>): void {
    const existing = this.getPersona()
    const now = new Date().toISOString()
    const merged: PersonaTraits = {
      openness: updates.openness ?? existing?.openness ?? 0.7,
      conscientiousness: updates.conscientiousness ?? existing?.conscientiousness ?? 0.8,
      extraversion: updates.extraversion ?? existing?.extraversion ?? 0.6,
      agreeableness: updates.agreeableness ?? existing?.agreeableness ?? 0.8,
      playfulness: updates.playfulness ?? existing?.playfulness ?? 0.7,
      traits: updates.traits || existing?.traits || ['友善', '乐于助人'],
      evolutionLog: [
        ...(existing?.evolutionLog || []),
        ...(updates.evolutionLog || []),
      ].slice(-50),
      timestamp: now,
    }

    if (updates.traits || updates.evolutionLog) {
      const changeDesc = updates.evolutionLog?.[updates.evolutionLog.length - 1] || '人格更新'
      merged.evolutionLog.push(`[${now}] ${changeDesc}`)
      merged.evolutionLog = merged.evolutionLog.slice(-50)
    }

    const json = JSON.stringify(merged)
    this.db.prepare('INSERT INTO persona_traits (traits_json) VALUES (?)').run(json)
  }

  /** 存储 Big Five 人格维度 (summarizer 调用) */
  savePersonaTraits(bigFive: {
    openness: number; conscientiousness: number; extraversion: number
    agreeableness: number; playfulness: number
  }): void {
    this.updatePersona(bigFive)
  }

  /** 追加人格标签 (summarizer 调用) */
  addPersonaTraits(traits: string[]): void {
    const existing = this.getPersona()
    const merged = [...(existing?.traits || []), ...traits]
    this.updatePersona({ traits: [...new Set(merged)].slice(0, 20) })
  }

  /** 记录人格演化 (summarizer 调用) */
  addEvolutionLog(entry: string): void {
    this.updatePersona({ evolutionLog: [entry] })
  }

  // ── 结构化记忆输出 (v2.3: 三层) ──────────────────────────

  /**
   * 获取完整结构化记忆快照（用户画像 + 配置 + 事实 + 反思 + 人格）
   * @returns 结构化记忆对象
   */
  getStructuredMemory(): StructuredMemory {
    return {
      user: this.getUserProfile() || { preferences: [], habits: [], communicationStyle: 'casual', personality: '', timestamp: '' },
      memory: this.getMemoryConfig() || { systemInfo: [], toolExperience: [], projectConventions: [], lessons: [], paths: {}, timestamp: '' },
      facts: this.getFacts(undefined, 20),
      reflections: this.getReflections(10),
      persona: this.getPersona(),
    }
  }

  /** 生成注入到 System Prompt 的记忆文本 (v2.3: 三层) */
  /**
   * 构建用于注入 System Prompt 的记忆摘要文本
   * @returns 紧凑的记忆注入字符串（用户画像、最近事实、经验教训）
   */
  getMemoryInjectionText(): string {
    const mem = this.getStructuredMemory()
    const parts: string[] = []

    // Layer 1: 事实
    const factsByCategory: Record<string, string[]> = {}
    for (const f of mem.facts) {
      if (!factsByCategory[f.category]) factsByCategory[f.category] = []
      factsByCategory[f.category].push(f.content)
    }
    if (Object.keys(factsByCategory).length > 0) {
      const factLines: string[] = []
      for (const [cat, items] of Object.entries(factsByCategory)) {
        const label = { user: '用户', environment: '环境', event: '事件', preference: '偏好', habit: '习惯' }[cat] || cat
        factLines.push(`- ${label}: ${items.join('；')}`)
      }
      parts.push('## 事实记忆\n' + factLines.join('\n'))
    }

    // Layer 2: 反思
    if (mem.reflections.length > 0) {
      const refLines = mem.reflections.slice(0, 5).map(r =>
        `- [${r.topic}] ${r.insight}${r.action ? ` → 行动: ${r.action}` : ''}`
      )
      parts.push('## 反思记忆\n' + refLines.join('\n'))
    }

    // Layer 3: 人格
    if (mem.persona?.traits?.length) {
      parts.push(`## 人格画像\n- 特质: ${mem.persona.traits.join('、')}`)
      parts.push(`- 五维: 开放${scoreBar(mem.persona.openness)} 尽责${scoreBar(mem.persona.conscientiousness)} 外向${scoreBar(mem.persona.extraversion)} 宜人${scoreBar(mem.persona.agreeableness)} 趣味${scoreBar(mem.persona.playfulness)}`)
    }

    // 保留原有双层兼容
    const userLines: string[] = []
    if (mem.user.preferences.length > 0) userLines.push(`偏好: ${mem.user.preferences.join('、')}`)
    if (mem.user.habits.length > 0) userLines.push(`习惯: ${mem.user.habits.join('、')}`)
    if (mem.user.communicationStyle) userLines.push(`沟通风格: ${mem.user.communicationStyle}`)
    if (userLines.length > 0) parts.push('## 用户画像\n' + userLines.map(l => `- ${l}`).join('\n'))

    const memLines: string[] = []
    if (mem.memory.lessons.length > 0) memLines.push(`经验教训: ${mem.memory.lessons.join(' | ')}`)
    if (mem.memory.projectConventions.length > 0) memLines.push(`项目约定: ${mem.memory.projectConventions.join(' | ')}`)
    if (mem.memory.toolExperience.length > 0) memLines.push(`工具经验: ${mem.memory.toolExperience.join(' | ')}`)
    if (memLines.length > 0) parts.push('## 环境配置\n' + memLines.map(l => `- ${l}`).join('\n'))

    const summaries = this.getRecentSummaries(3)
    if (summaries.length > 0) parts.push('## 最近对话摘要\n' + summaries.map((s, i) => `[${i + 1}] ${s}`).join('\n'))

    return parts.join('\n\n')
  }

  /** 每日健康检查：清理旧摘要 */
  cleanup(maxSummaries = 50): void {
    const count = (this.db.prepare("SELECT COUNT(*) as c FROM memory_fragments WHERE type='conversation_summary'").get() as { c: number }).c
    if (count > maxSummaries) {
      this.db.prepare("DELETE FROM memory_fragments WHERE type='conversation_summary' AND id NOT IN (SELECT id FROM memory_fragments WHERE type='conversation_summary' ORDER BY id DESC LIMIT ?)").run(maxSummaries)
    }
  }

  close(): void { this.db.close() }

  // ── v3.0: Semantic memory store interface ──────────────

  /** 添加语义记忆条目（供 StructuredMemory 调用） */
  addMemory(entry: {
    key: string
    value: string
    metadata?: Record<string, string>
  }): void {
    try {
      this.db.prepare(
        `INSERT INTO semantic_memories (key, value, metadata, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, metadata=excluded.metadata`
      ).run(entry.key, entry.value, JSON.stringify(entry.metadata || {}), new Date().toISOString())
    } catch {
      // 语义记忆表不存在时报错但不崩溃
    }
  }

  /** 获取所有语义记忆 */
  getAllMemories(): Array<{ key: string; value: string; metadata: any; type?: string; summarized?: boolean }> {
    try {
      const rows = this.db.prepare('SELECT key, value, metadata FROM semantic_memories ORDER BY created_at DESC').all() as any[]
      return rows.map(r => ({
        key: r.key,
        value: r.value,
        metadata: JSON.parse(r.metadata || '{}'),
      }))
    } catch {
      return []
    }
  }
}

function dedupe(arr: string[]): string[] { return [...new Set(arr)] }
function scoreBar(v: number): string {
  const filled = Math.round(v * 5)
  return '█'.repeat(filled) + '░'.repeat(5 - filled)
}

// ═══════════════════════════════════════════════════════════
// v2.4: MemoryVectorStore — 向量化语义检索 (P3)
//
// 使用 TF-IDF 本地向量化，零外部依赖:
//   1. 分词 (中英文混合)
//   2. 构建词汇表
//   3. TF-IDF 向量化
//   4. 余弦相似度匹配
//
// 也支持可选的外部 embedding 集成 (通过回调)
// ═══════════════════════════════════════════════════════════

/** 向量化条目 */
export interface VectorEntry {
  id: number | string
  text: string
  vector: number[]
  metadata?: Record<string, any>
}

/** 检索结果 */
export interface SearchResult {
  entry: VectorEntry
  score: number  // 0-1 相似度分数
  snippet: string  // 匹配的文本片段
}

/**
 * 向量化记忆存储 — TF-IDF 本地向量 + 可选外部 Embedding 服务
 *
 * 支持三级回退链:
 *   1. Python sentence-transformers Embedding 服务器 (http://127.0.0.1:18923)
 *   2. Ollama 本地 Embedding (nomic-embed-text)
 *   3. 纯本地 TF-IDF（零依赖，始终可用）
 *
 * 能力: 语义搜索、关键词搜索、相似度排序
 */
export class MemoryVectorStore {
  private entries: VectorEntry[] = []
  private vocabulary: Map<string, number> = new Map() // word → index
  private idf: Map<string, number> = new Map() // word → idf value
  private dirty = true // 词汇表是否过期

  /** 外部 embedding 回调 (可选) */
  private externalEmbedder: ((texts: string[]) => Promise<number[][]>) | null = null

  /** 外部 rerank 回调 (可选) */
  private externalReranker: ((query: string, documents: string[], topK?: number) => Promise<{ index: number; score: number }[]>) | null = null

  /** Embedding 配置（支持热更新） */
  private embeddingConfig = {
    mode: 'tfidf' as 'ollama' | 'embedding_server' | 'tfidf' | 'none',
    ollamaUrl: 'http://localhost:11434',
    ollamaModel: 'nomic-embed-text',
    embeddingServerUrl: 'http://127.0.0.1:18923',
  }

  /** Rerank 配置（支持热更新） */
  private rerankConfig = {
    enabled: false,
    url: 'http://localhost:11434', // OpenAI 兼容接口
    model: 'bge-reranker-v2-m3',
    topK: 10,
  }

  /**
   * 启用 Ollama embedding (自动检测可用性，不可用回退 TF-IDF)
   * @param url Ollama 服务地址，默认 http://localhost:11434
   * @param model Embedding 模型名，默认 nomic-embed-text
   * @returns true 如果 Ollama 可用并已启用
   */
  async enableOllamaEmbedding(url = 'http://localhost:11434', model = 'nomic-embed-text'): Promise<boolean> {
    try {
      // 检测 Ollama 是否可用
      const testRes = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(3000) })
      if (!testRes.ok) {
        console.warn(`[VectorStore] Ollama 不可用 (${url}), 使用 TF-IDF`)
        return false
      }

      // 设置 Ollama embedder
      this.externalEmbedder = async (texts: string[]): Promise<number[][]> => {
        const embeddings: number[][] = []
        for (const text of texts) {
          const res = await fetch(`${url}/api/embeddings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, prompt: text }),
            signal: AbortSignal.timeout(10000),
          })
          if (!res.ok) throw new Error(`Ollama embedding 失败: ${res.status}`)
          const data = await res.json()
          embeddings.push(data.embedding as number[])
        }
        return embeddings
      }

      console.log(`[VectorStore] ✅ Ollama embedding 已启用 (${url}, ${model})`)
      return true
    } catch (err) {
      console.warn(`[VectorStore] Ollama 连接失败, 回退 TF-IDF:`, (err as Error).message)
      this.externalEmbedder = null
      return false
    }
  }

  /** 获取当前 embedding 模式 */
  get embeddingMode(): 'ollama' | 'embedding_server' | 'tfidf' | 'none' {
    if (this.externalEmbedder) {
      // 检查方法名来区分 (简单判断)
      return this.externalEmbedder.name.includes('EmbeddingServer') ? 'embedding_server' : 'ollama'
    }
    return 'tfidf'
  }

  /** 获取 Embedding 配置（只读） */
  getEmbeddingConfig(): { mode: string; ollamaUrl: string; ollamaModel: string; embeddingServerUrl: string } {
    return { ...this.embeddingConfig }
  }

  /**
   * 启用本地 Embedding 服务器 (Python sentence-transformers)
   * @param url 服务地址，默认 http://127.0.0.1:18923
   * @returns true 如果服务器可用并已启用
   */
  async enableEmbeddingServer(url = 'http://127.0.0.1:18923'): Promise<boolean> {
    try {
      // 检测服务是否可用
      const testRes = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) })
      if (!testRes.ok) {
        console.warn(`[VectorStore] Embedding 服务不可用 (${url}), 使用 TF-IDF`)
        return false
      }
      const health = await testRes.json()
      console.log(`[VectorStore] Embedding 服务就绪: model=${health.model}, dim=${health.dimension}`)

      // 设置 HTTP embedder
      const EmbeddingServerFn = async (texts: string[]): Promise<number[][]> => {
        const res = await fetch(`${url}/embed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ texts }),
          signal: AbortSignal.timeout(15000),
        })
        if (!res.ok) throw new Error(`Embedding 请求失败: ${res.status}`)
        const data = await res.json()
        return data.embeddings as number[][]
      }
      // 命名函数以便 embeddingMode 区分
      Object.defineProperty(EmbeddingServerFn, 'name', { value: 'EmbeddingServerFn' })

      this.externalEmbedder = EmbeddingServerFn
      this.embeddingConfig.mode = 'embedding_server'
      this.embeddingConfig.embeddingServerUrl = url
      console.log(`[VectorStore] ✅ Embedding 服务已启用 (${url})`)
      return true
    } catch (err) {
      console.warn('[VectorStore] Embedding 服务连接失败, 回退 TF-IDF:', (err as Error).message)
      this.externalEmbedder = null
      return false
    }
  }

  /**
   * 🆕 启用 Rerank 服务（OpenAI 兼容接口）
   * @param url Rerank 服务地址
   * @param model Rerank 模型名
   * @param topK 返回前 K 个结果
   * @returns true 如果服务可用并已启用
   */
  async enableRerank(url = 'http://localhost:11434', model = 'bge-reranker-v2-m3', topK = 10): Promise<boolean> {
    try {
      // 检测服务是否可用
      const testRes = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(3000) })
      if (!testRes.ok) {
        console.warn(`[VectorStore] Rerank 服务不可用 (${url})`)
        return false
      }

      // 设置 reranker（OpenAI 兼容格式）
      this.externalReranker = async (query: string, documents: string[], topK = 10): Promise<{ index: number; score: number }[]> => {
        const res = await fetch(`${url}/api/rerank`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            query,
            documents,
            top_k: topK,
          }),
          signal: AbortSignal.timeout(15000),
        })
        if (!res.ok) throw new Error(`Rerank 请求失败: ${res.status}`)
        const data = await res.json()
        return data.results as { index: number; score: number }[]
      }

      this.rerankConfig.enabled = true
      this.rerankConfig.url = url
      this.rerankConfig.model = model
      this.rerankConfig.topK = topK

      console.log(`[VectorStore] ✅ Rerank 已启用 (${url}, ${model})`)
      return true
    } catch (err) {
      console.warn('[VectorStore] Rerank 服务连接失败, 跳过重排:', (err as Error).message)
      this.externalReranker = null
      this.rerankConfig.enabled = false
      return false
    }
  }

  /**
   * 🆕 设置外部 rerank 函数
   * @param reranker 接受 (query, documents, topK) 返回重排结果的函数
   */
  setExternalReranker(reranker: (query: string, documents: string[], topK?: number) => Promise<{ index: number; score: number }[]>): void {
    this.externalReranker = reranker
    this.rerankConfig.enabled = true
  }

  /**
   * 获取当前 rerank 状态
   */
  get rerankStatus(): { enabled: boolean; url: string; model: string } {
    return {
      enabled: this.rerankConfig.enabled,
      url: this.rerankConfig.url,
      model: this.rerankConfig.model,
    }
  }

  /**
   * 🆕 执行 Rerank 重排序
   * @param query 查询文本
   * @param documents 文档列表
   * @param topK 返回前 K 个结果
   * @returns 重排结果列表
   */
  async rerank(query: string, documents: string[], topK = 10): Promise<{ index: number; score: number }[]> {
    if (!this.externalReranker) {
      // 回退：返回原始顺序
      return documents.slice(0, topK).map((_, i) => ({ index: i, score: 1 - i * 0.01 }))
    }

    try {
      const results = await this.externalReranker(query, documents, topK)
      return results
    } catch (err) {
      console.warn('[VectorStore] Rerank 失败，使用原始顺序:', err)
      return documents.slice(0, topK).map((_, i) => ({ index: i, score: 1 - i * 0.01 }))
    }
  }

  /** 设置外部 embedding 函数 (如 ollama, transformers.js)
   * 设置后将优先使用外部 embedder，回退到 TF-IDF
   */
  setExternalEmbedder(embedder: (texts: string[]) => Promise<number[][]>): void {
    this.externalEmbedder = embedder
  }

  /** 添加记忆条目 */
  /**
   * 添加一条向量记忆条目（自动更新 TF-IDF 词汇表）
   * @param text - 文本内容
   * @param metadata - 可选的附加元数据
   * @returns 新创建的向量条目
   */
  addEntry(text: string, metadata?: Record<string, any>): VectorEntry {
    const entry: VectorEntry = {
      id: this.entries.length + 1,
      text,
      vector: [], // 延迟计算
      metadata,
    }
    this.entries.push(entry)
    this.dirty = true
    return entry
  }

  /** 批量添加 */
  addEntries(items: Array<{ text: string; metadata?: Record<string, any> }>): void {
    for (const item of items) {
      this.addEntry(item.text, item.metadata)
    }
  }

  /** 获取条目数 */
  get size(): number {
    return this.entries.length
  }

  /** 清除所有条目 */
  clear(): void {
    this.entries = []
    this.vocabulary.clear()
    this.idf.clear()
    this.dirty = true
  }

  /**
   * 语义搜索
   * @param query 查询文本
   * @param topK 返回前 K 个结果
   * @param minScore 最低相似度阈值 (0-1)
   */
  async search(query: string, topK = 5, minScore = 0.1): Promise<SearchResult[]> {
    if (this.entries.length === 0) return []

    // 重建向量索引 (如需要)
    if (this.dirty) {
      this.rebuildIndex()
    }

    const queryVec = this.vectorize(query)

    // 如果有外部 embedder，优先使用
    if (this.externalEmbedder) {
      try {
        return await this.searchWithExternal(query, topK, minScore)
      } catch (err) {
        console.warn('[VectorStore] 外部 embedder 失败，回退到 TF-IDF:', err)
      }
    }

    // TF-IDF 余弦相似度搜索
    const results: SearchResult[] = []

    for (const entry of this.entries) {
      if (entry.vector.length === 0) {
        entry.vector = this.vectorize(entry.text)
      }
      const score = this.cosineSimilarity(queryVec, entry.vector)
      if (score >= minScore) {
        results.push({
          entry,
          score,
          snippet: this.extractSnippet(entry.text, query, 80),
        })
      }
    }

    results.sort((a, b) => b.score - a.score)
    let finalResults = results.slice(0, topK)

    // 🆕 Rerank 重排序（如果启用）
    if (this.externalReranker && finalResults.length > 0) {
      try {
        const docs = finalResults.map((r) => r.entry.text)
        const rerankResults = await this.externalReranker(query, docs, this.rerankConfig.topK || topK)

        // 按 rerank 结果重新排序
        const reranked: SearchResult[] = []
        for (const rr of rerankResults) {
          const original = finalResults[rr.index]
          if (original) {
            reranked.push({
              ...original,
              score: rr.score, // 使用 rerank 分数覆盖
            })
          }
        }
        finalResults = reranked.slice(0, topK)
        console.log(`[VectorStore] 🔄 Rerank 完成: ${rerankResults.length} 条结果已重排`)
      } catch (err) {
        console.warn('[VectorStore] Rerank 失败，使用原始排序:', err)
      }
    }

    return finalResults
  }

  /** 快速关键词搜索 (兼容旧 API) */
  /**
   * 关键词/语义搜索（优先 Embedding 服务，回退 TF-IDF 余弦相似度）
   * @param query - 搜索查询文本
   * @param topK - 返回结果数量上限（默认 5）
   * @returns 按相似度降序排列的搜索结果
   */
  searchByKeywords(query: string, topK = 5): VectorEntry[] {
    const keywords = this.tokenize(query)
    if (keywords.length === 0) return this.entries.slice(0, topK)

    const scored = this.entries.map((entry) => {
      const textLower = entry.text.toLowerCase()
      let score = 0
      for (const kw of keywords) {
        if (textLower.includes(kw)) score += 1
      }
      return { entry, score }
    })

    scored.sort((a, b) => b.score - a.score)
    return scored.filter((s) => s.score > 0).slice(0, topK).map((s) => s.entry)
  }

  // ── 内部方法 ──────────────────────────────────────────

  private rebuildIndex(): void {
    this.vocabulary.clear()
    this.idf.clear()

    // 构建词汇表
    for (const entry of this.entries) {
      const tokens = new Set(this.tokenize(entry.text))
      for (const token of tokens) {
        const count = this.idf.get(token) || 0
        this.idf.set(token, count + 1)
      }
    }

    // 计算 IDF
    const N = this.entries.length
    for (const [word, docCount] of this.idf) {
      this.idf.set(word, Math.log((N + 1) / (docCount + 1)) + 1)
    }

    // 分配索引
    let idx = 0
    for (const word of this.idf.keys()) {
      this.vocabulary.set(word, idx++)
    }

    // 更新所有向量
    for (const entry of this.entries) {
      entry.vector = this.vectorize(entry.text)
    }

    this.dirty = false
  }

  /** TF-IDF 向量化 */
  private vectorize(text: string): number[] {
    if (this.vocabulary.size === 0) {
      // 首次调用时立即构建索引
      this.rebuildIndex()
    }

    const vec = new Array(this.vocabulary.size).fill(0)
    const tokens = this.tokenize(text)
    const termFreq = new Map<string, number>()

    for (const token of tokens) {
      termFreq.set(token, (termFreq.get(token) || 0) + 1)
    }

    const maxFreq = Math.max(1, ...termFreq.values())

    for (const [word, freq] of termFreq) {
      const idx = this.vocabulary.get(word)
      if (idx !== undefined) {
        const tf = freq / maxFreq
        const idf = this.idf.get(word) || 1
        vec[idx] = tf * idf
      }
    }

    return vec
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0
    let dotProduct = 0
    let normA = 0
    let normB = 0
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i]
      normA += a[i] * a[i]
      normB += b[i] * b[i]
    }
    if (normA === 0 || normB === 0) return 0
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB))
  }

  /** 中英文混合分词 */
  private tokenize(text: string): string[] {
    const tokens: string[] = []

    // 英文: 按空格和标点分词，统一小写
    const englishWords = text.toLowerCase().match(/[a-z][a-z0-9_]+/g) || []
    tokens.push(...englishWords)

    // 中文: 二元分词 (bigram)，简单但有效
    const chineseChars = text.match(/[\u4e00-\u9fff]+/g) || []
    for (const segment of chineseChars) {
      for (let i = 0; i < segment.length - 1; i++) {
        tokens.push(segment.substring(i, i + 2))
      }
      // 保留单字
      for (const char of segment) {
        tokens.push(char)
      }
    }

    // 过滤停用词
    const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
      '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一', '一个',
      '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好', '来',
      '他', '她', '它', '们', '那', '这', '吗', '吧', '呢', '啊'])
    return tokens.filter((t) => t.length >= 1 && !stopWords.has(t))
  }

  /** 提取匹配片段 */
  private extractSnippet(text: string, query: string, maxLen: number): string {
    const queryTokens = this.tokenize(query)
    if (queryTokens.length === 0) return text.slice(0, maxLen) + (text.length > maxLen ? '...' : '')

    // 找到第一个匹配位置
    let bestPos = 0
    const textLower = text.toLowerCase()
    for (const token of queryTokens) {
      const pos = textLower.indexOf(token)
      if (pos >= 0) {
        bestPos = pos
        break
      }
    }

    const start = Math.max(0, bestPos - Math.floor(maxLen / 3))
    const end = Math.min(text.length, start + maxLen)
    const prefix = start > 0 ? '...' : ''
    const suffix = end < text.length ? '...' : ''
    return prefix + text.slice(start, end) + suffix
  }

  /** 使用外部 embedder 搜索 */
  private async searchWithExternal(query: string, topK: number, minScore: number): Promise<SearchResult[]> {
    if (!this.externalEmbedder) return []

    const queryVecs = await this.externalEmbedder([query])
    const queryVec = queryVecs[0]

    // 批量获取所有 entry vectors
    const texts = this.entries.map((e) => e.text)
    const entryVecs = await this.externalEmbedder(texts)

    const results: SearchResult[] = []
    for (let i = 0; i < this.entries.length; i++) {
      const score = this.cosineSimilarity(queryVec, entryVecs[i])
      if (score >= minScore) {
        results.push({
          entry: this.entries[i],
          score,
          snippet: this.extractSnippet(this.entries[i].text, query, 80),
        })
      }
    }

    results.sort((a, b) => b.score - a.score)
    return results.slice(0, topK)
  }
}

// ── 全局单例 ──────────────────────────────────────────

let _vectorStore: MemoryVectorStore | null = null

export function getMemoryVectorStore(): MemoryVectorStore {
  if (!_vectorStore) _vectorStore = new MemoryVectorStore()
  return _vectorStore
}

let _store: MemoryStore | null = null
export function getMemoryStore(dbPath?: string): MemoryStore {
  if (!_store) _store = new MemoryStore(dbPath)
  return _store
}
