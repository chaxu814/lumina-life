// ============================================================
// memoryStore.ts — 三层记忆系统 (v2.4)
//
// v2.4 新增:
//   - MemoryVectorStore: 向量化语义检索 (P3)
//   - TF-IDF 本地向量化 (零依赖)
//   - 余弦相似度排序
//
// 架构 (业界三层记忆模型):
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
import { isEnabled } from '../core/featureFlags'
// 🆕 静态导入 hybridRecall：原先在 searchHybrid() 里写 require('./hybridRecall')，
// 打包后相对路径会相对 chunk 目录解析而失效（与 systemIpc 的
// "Cannot find module" 同一类问题）。静态 import 由 Vite 在构建期解析，最稳。
import { hybridRecall } from './hybridRecall'
import {
  RelationshipEventStore,
  type RelationshipEventInput,
  type RelationshipEventQuery,
  type RelationshipEvent,
} from './relationshipEvents'

// ── 三层记忆类型 ────────────────────────────────────────

// ── 事实来源强度（防幻觉固化）────────────────────────────
//
// 为什么要有这一层：记忆被污染比记不住更危险。
// 旧实现里模型只要调一次 memory_save，就写进 confidence=1.0 / source='user_said'，
// 之后 memory_get 把「(100%)」原样喂回模型，于是这一次编造被当成权威事实反复召回，
// 每轮都在加固，且没有任何纠正路径。
//
// 现在的规矩：
//   1. 事实的权威性只由 source（谁说的）决定，不由调用方随手传的 confidence 决定；
//   2. 外部传入的 confidence 一律按 source 上限 clamp，不允许越界；
//   3. 低置信度（<0.8）条目在展示时必须带「未验证」标注；
//   4. 写入按内容指纹去重，更高置信度的说法覆盖旧记录（唯一的纠正路径）。

/** 事实来源枚举：来源强度 = 置信度上限 */
export type FactSource = 'user_stated' | 'user_confirmed' | 'model_inferred'

/** 各来源的置信度上限与缺省值 */
export const SOURCE_CONFIDENCE: Record<FactSource, { cap: number; default: number; label: string }> = {
  user_confirmed: { cap: 1.0, default: 1.0, label: '用户确认过' },
  user_stated: { cap: 0.95, default: 0.95, label: '用户亲口说过' },
  model_inferred: { cap: 0.6, default: 0.6, label: '模型推断，未验证' },
}

/** 低于此值的记忆视为「未验证」，展示时必须带标注 */
export const UNVERIFIED_CONFIDENCE = 0.8

/** 旧数据（无 source / 老枚举值）一律按 user_said 处理，但置信度上限压到 0.9 —— 不给老数据 100% 的权威 */
export const LEGACY_CONFIDENCE_CAP = 0.9

/** memory_save 未声明来源时的缺省来源：模型自己说的，不确定性最高 */
export const DEFAULT_FACT_SOURCE: FactSource = 'model_inferred'

/** 旧枚举 → 新枚举（用于调用方/LLM 传来的 source 归一化；DB 里的旧行不改写，只降权） */
const LEGACY_SOURCE_ALIAS: Record<string, FactSource> = {
  user_said: 'user_stated',    // 老代码把模型输出也标成 user_said，这里按「用户说的」理解
  observed: 'model_inferred',  // 模型自称观察到，但没有独立验证
  inferred: 'model_inferred',
}

/** 归一化 source：未知/缺失一律降级为 model_inferred（最保守，宁可标未验证也不给权威） */
export function normalizeFactSource(raw?: string | null): FactSource {
  const s = (raw || '').trim()
  if (s in SOURCE_CONFIDENCE) { return s as FactSource }
  return LEGACY_SOURCE_ALIAS[s] || DEFAULT_FACT_SOURCE
}

/** 解析一条（可能是旧数据的）source，返回其置信度上限 */
export function resolveSourceCap(raw?: string | null): number {
  const s = (raw || '').trim()
  return (s in SOURCE_CONFIDENCE) ? SOURCE_CONFIDENCE[s as FactSource].cap : LEGACY_CONFIDENCE_CAP
}

/** 把外部传入的 confidence 压进 [0, cap]：只允许往低调，不允许往高调 */
export function clampConfidence(value: number | null | undefined, cap: number): number {
  const v = typeof value === 'number' && Number.isFinite(value) ? value : cap
  return Math.max(0, Math.min(v, cap))
}

/** 落库前把 confidence 按 source 上限收敛 */
export function resolveConfidence(source: string | null | undefined, requested?: number | null): number {
  return clampConfidence(requested, resolveSourceCap(source))
}

/**
 * 内容归一化（写入去重用的指纹原料）：全角转半角、转小写、去空白与标点。
 * 为什么：同一句幻觉换个标点/大小写再写一遍，不该变成「两条互相印证的事实」。
 */
export function normalizeFactContent(content: string): string {
  return (content || '')
    .replace(/[\uff01-\uff5e]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0)) // 全角 → 半角
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]/gu, '') // 只保留字母与数字（\p{Letter} 含中日韩汉字）
}

/** 内容指纹：category + 归一化内容，作为同一条事实的身份 */
export function factContentKey(category: string, content: string): string {
  return `${category}\u0001${normalizeFactContent(content)}`
}

/**
 * 给事实内容加「未验证」标注（低置信度）或置信度百分比（高置信度）。
 * 为什么要标：模型看到 (60%) 不会当权威，看到一句干净的事实会。
 */
export function markUnverifiedFact(content: string, fact: { confidence?: number | null }): string {
  const conf = typeof fact.confidence === 'number' && Number.isFinite(fact.confidence) ? fact.confidence : 0
  const pct = Math.round(conf * 100)
  if (conf < UNVERIFIED_CONFIDENCE) { return `${content}【未验证·模型推断，置信度 ${pct}%】` }
  return `${content}（${pct}%）`
}

export interface FactEntry {
  id: number
  category: string  // 'user' | 'environment' | 'event' | 'preference' | 'habit' | 'agent_memory'
  content: string
  confidence: number  // 0-1, 事实确信度（写入时已按 source 上限 clamp）
  /** 来源: 'user_stated' | 'user_confirmed' | 'model_inferred'（旧数据可能是 'user_said'/'observed'/'inferred'/'agent_tool' 等历史值） */
  source: string
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
  /** I4: 关系事件记忆（叙事性事件，区别于 facts 的客观事实） */
  private relEvents: RelationshipEventStore

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
      if (!fs.existsSync(dir)) {fs.mkdirSync(dir, { recursive: true })}
    }
    this.db = new Database(targetPath)
    this.db.pragma('journal_mode = WAL')
    this.initTables()
    // I4: 关系事件记忆（建表 IF NOT EXISTS，兼容老库）
    this.relEvents = new RelationshipEventStore(this.db)
    this.relEvents.init()
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
    // 迁移：facts 加上来源可信度策略（新增列 + 旧数据降权）
    this.migrateFactProvenance()
  }

  /**
   * 迁移：facts 事实可信度策略
   *
   * 只用 `ALTER TABLE ... ADD COLUMN`（不删列、不重建表），老库原地升级，不丢任何历史行。
   *   1. content_key / hit_count：内容指纹列，写入去重 + 纠正覆盖靠它
   *   2. source 为空的旧行回填 'user_said'（按用户亲口说的处理，但不因此给 100% 权威）
   *   3. 旧来源（不在新枚举里）的行，置信度一律压到 ≤ 0.9
   *      —— 老版本里模型幻觉被写成 1.0 是普遍现象，迁移后它们至少会带上「未验证」标注
   * 注意：这里不动已经符合新枚举的行（user_confirmed 的 1.0 不受影响）。
   */
  private migrateFactProvenance(): void {
    try {
      const cols = this.db.prepare("PRAGMA table_info(facts)").all() as Array<{ name: string }>
      const names = new Set(cols.map(c => c.name))
      if (!names.has('content_key')) { this.db.exec('ALTER TABLE facts ADD COLUMN content_key TEXT') }
      if (!names.has('hit_count')) { this.db.exec('ALTER TABLE facts ADD COLUMN hit_count INTEGER DEFAULT 0') }
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_facts_content_key ON facts(content_key)')

      // 旧行没有 source → 按 user_said 处理
      this.db.prepare("UPDATE facts SET source='user_said' WHERE source IS NULL OR TRIM(source)=''").run()

      // 旧来源的置信度降权（只压旧来源，新枚举里 user_confirmed 本来就可以是 1.0）
      const legacyList = Object.keys(SOURCE_CONFIDENCE).map(s => `'${s}'`).join(',')
      this.db.prepare(
        `UPDATE facts SET confidence=? WHERE (confidence IS NULL OR confidence > ?)
         AND (source IS NULL OR TRIM(source)='' OR source NOT IN (${legacyList}))`
      ).run(LEGACY_CONFIDENCE_CAP, LEGACY_CONFIDENCE_CAP)

      // 回填内容指纹（限量 5000 条，避免大库一次性全表扫）
      const rows = this.db.prepare(
        'SELECT id, category, content FROM facts WHERE content_key IS NULL LIMIT 5000'
      ).all() as Array<{ id: number; category: string; content: string }>
      if (rows.length > 0) {
        const upd = this.db.prepare('UPDATE facts SET content_key=? WHERE id=?')
        for (const r of rows) { upd.run(factContentKey(r.category, r.content), r.id) }
        console.log(`[MemoryStore] facts 迁移：回填 ${rows.length} 条内容指纹`)
      }

      const capped = (this.db.prepare('SELECT COUNT(*) as c FROM facts WHERE confidence > ?').get(LEGACY_CONFIDENCE_CAP) as { c: number }).c
      if (capped > 0) { console.log(`[MemoryStore] facts 迁移：${capped} 条旧数据的置信度已压到 ≤ ${LEGACY_CONFIDENCE_CAP}`) }
    } catch (err) {
      // 迁移失败不能拖垮记忆系统：退化到「读时 clamp」，仍能防止 100% 幻觉
      console.error('[MemoryStore] facts 来源/置信度迁移失败:', err)
    }
  }

  /** 将旧 facts 表（5类）迁移为允许 agent_memory 的新表 */
  private migrateFactsCategory(): void {
    try {
      const row = this.db.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='facts'"
      ).get() as { sql?: string } | undefined
      const sql = row?.sql ?? ''
      // 已包含 agent_memory 则跳过
      if (sql.includes('agent_memory')) {return}

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
    if (!row) {return null}
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
    if (row) {this.updateFragment(row.id, JSON.stringify(merged))}
    else {this.saveFragment('user_profile', JSON.stringify(merged))}
  }

  // ── MEMORY 环境配置 ─────────────────────────────────────

  getMemoryConfig(): MemoryConfig | null {
    const row = this.db.prepare("SELECT content FROM memory_fragments WHERE type='memory_config' ORDER BY id DESC LIMIT 1").get() as { content: string } | undefined
    if (!row) {return null}
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
    if (row) {this.updateFragment(row.id, JSON.stringify(merged))}
    else {this.saveFragment('memory_config', JSON.stringify(merged))}
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
   * 添加一条事实记忆（带来源可信度策略：去重 + 纠正覆盖 + confidence clamp）
   *
   * 规则：
   *   - confidence 一律按 source 上限 clamp，调用方传 1.0 也只能往下压
   *   - 同内容（归一化后）重复写入不产生新行，只累加 hit_count：重复调用不等于多一次验证
   *   - 同内容但 confidence 更高 → 覆盖旧记录（这是唯一的纠正路径，不让两条矛盾事实并存）
   * @param fact - 分类、内容、来源（可选，默认 model_inferred）、确信度（可选，会被 clamp）
   * @returns 该事实的数据库 ID（新建或被复用/覆盖的那条）
   */
  addFact(fact: { category: string; content: string; confidence?: number; source?: string }): number {
    const ts = new Date().toISOString()
    const source = (fact.source || '').trim() || DEFAULT_FACT_SOURCE
    const confidence = resolveConfidence(source, fact.confidence)
    const contentKey = factContentKey(fact.category, fact.content)

    // 去重：同 category + 同归一化内容视为同一条事实
    const existing = this.db.prepare(
      'SELECT id, confidence FROM facts WHERE content_key=? ORDER BY confidence DESC, id DESC LIMIT 1'
    ).get(contentKey) as { id: number; confidence: number } | undefined

    if (existing) {
      const oldConfidence = typeof existing.confidence === 'number' ? existing.confidence : 0
      if (confidence > oldConfidence + 1e-9) {
        // 纠正路径：更强的说法覆盖旧记录
        this.db.prepare(
          'UPDATE facts SET content=?, confidence=?, source=?, created_at=?, content_key=? WHERE id=?'
        ).run(fact.content, confidence, source, ts, contentKey, existing.id)
      } else {
        // 同样强或更弱：只记一次命中，不改内容（避免同一幻觉被反复加固）
        this.db.prepare('UPDATE facts SET hit_count=COALESCE(hit_count,0)+1 WHERE id=?').run(existing.id)
      }
      return existing.id
    }

    const r = this.db.prepare(
      'INSERT INTO facts (category, content, confidence, source, created_at, content_key, hit_count) VALUES (?,?,?,?,?,?,0)'
    ).run(fact.category, fact.content, confidence, source, ts, contentKey)
    return r.lastInsertRowid as number
  }

  /** 读取时再 clamp 一次：即使有绕过 addFact 的裸写入，也不会把 100% 的幻觉放出去 */
  private static toFactEntry(r: any): FactEntry {
    const source = (r.source as string) || 'user_said'
    return {
      id: r.id as number,
      category: r.category,
      content: r.content,
      confidence: resolveConfidence(source, r.confidence),
      source,
      timestamp: r.created_at,
    }
  }

  /**
   * 读取事实。
   *
   * 排序必须是 confidence DESC 优先、id DESC 次之：
   * 上一轮加了置信度分级（模型推断 ≤60%、用户亲口 95%），但排序还停在 id DESC，
   * 结果是「越新的越权威」——上周模型编的一条（id 大、confidence 0.6）
   * 永远压过用户今天亲口确认的那条（id 小、confidence 0.95），
   * 分级只体现在展示文案上，根本没参与召回顺序，等于白做。
   *
   * COALESCE(confidence, LEGACY_CONFIDENCE_CAP)：旧行可能是 NULL，
   * SQLite 里 DESC 会把 NULL 排在最前面（正好是最不该被召回的位置），
   * 兜底值取 LEGACY_CONFIDENCE_CAP，与 toFactEntry 里的读取归一化保持一致。
   */
  getFacts(category?: string, limit = 20): FactEntry[] {
    const order = `ORDER BY COALESCE(confidence, ${LEGACY_CONFIDENCE_CAP}) DESC, id DESC`
    const sql = category
      ? `SELECT * FROM facts WHERE category=? ${order} LIMIT ?`
      : `SELECT * FROM facts ${order} LIMIT ?`
    const params = category ? [category, limit] : [limit]
    return (this.db.prepare(sql).all(...params) as any[]).map(r => MemoryStore.toFactEntry(r))
  }

  /**
   * 纠正一条事实：写新说法 + 把被纠正的旧条目降权。
   *
   * 为什么必须有纠正入口：memory_save 只有「新增」，没有「这条是错的」。
   * 于是模型上周编的结论会一直躺在库里，用户今天当面纠正之后，
   * 旧条目不但还在，还因为 id 更大而排在前面被反复召回 —— 越纠正越错。
   *
   * 降权而不是物理删除：删了就查不到「当初为什么记了这条」，
   * 而且用户哪天重新认可旧说法时（source 足够强）还能通过 addFact 升回来。
   * 旧的 content 不动，只把置信度压到底、来源标成已被取代，
   * 展示时就会自动落到「未验证」档（见 markUnverifiedFact）并排在最后。
   */
  correctFact(
    id: number,
    fact: { category: string; content: string; source?: string; confidence?: number },
  ): { ok: boolean; newId: number; demoted: number[]; reason?: string } {
    const old = this.db.prepare('SELECT id FROM facts WHERE id=?').get(id) as { id: number } | undefined
    if (!old) {
      // 找不到就退化成新增：纠正失败不该让这次保存整个丢掉
      const newId = this.addFact(fact)
      return { ok: false, newId, demoted: [], reason: `未找到 id=${id} 的事实，已作为新记忆保存` }
    }

    const newId = this.addFact(fact)

    const demoted: number[] = []
    // 新旧内容相同 → addFact 已在原条目上升级置信度，不需要降权
    if (newId !== id) {
      this.db.prepare(
        "UPDATE facts SET confidence=0.05, source='superseded', created_at=? WHERE id=?",
      ).run(new Date().toISOString(), id)
      demoted.push(id)
    }
    return { ok: true, newId, demoted }
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
    return rows.map(r => MemoryStore.toFactEntry(r))
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
    if (!row) {return null}
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

  // ── I4: 关系事件记忆（叙事性，区别于 facts 的事实 CRUD） ──

  /**
   * 记录一条「你和用户之间」的关系事件。
   * 例如：答应过的事、一起完成的事、用户上次难过的原因。
   */
  recordRelationshipEvent(event: RelationshipEventInput): number {
    if (!isEnabled('memory.relationshipEvents')) {return -1}
    return this.relEvents.record(event)
  }

  /** 查询关系事件（按类别 / 时间过滤） */
  getRelationshipEvents(query: RelationshipEventQuery = {}): RelationshipEvent[] {
    if (!isEnabled('memory.relationshipEvents')) {return []}
    return this.relEvents.list(query)
  }

  /** 未了结的承诺 / 未和解的争执 / 未抚慰的难过时刻（按情绪权重降序） */
  getUnresolvedPromises(limit = 5): RelationshipEvent[] {
    if (!isEnabled('memory.relationshipEvents')) {return []}
    return this.relEvents.getUnresolvedPromises(limit)
  }

  /** 记录一次「主动提起」某条关系事件 */
  incrementRelationshipReferenced(id: number): void {
    if (!isEnabled('memory.relationshipEvents')) {return}
    this.relEvents.incrementReferenced(id)
  }

  /** 把一条关系事件标记为已了结 */
  markRelationshipResolved(id: number): void {
    if (!isEnabled('memory.relationshipEvents')) {return}
    this.relEvents.markResolved(id)
  }

  /** 最近 N 条关系事件的可读摘要（供梦境/上下文注入） */
  getRelationshipEventDigest(limit = 3): string {
    if (!isEnabled('memory.relationshipEvents')) {return ''}
    return this.relEvents.digest(limit)
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

    // Layer 1: 事实（低置信度必须带「未验证」标注，否则每轮注入都会被当成权威事实）
    const factsByCategory: Record<string, string[]> = {}
    for (const f of mem.facts) {
      if (!factsByCategory[f.category]) {factsByCategory[f.category] = []}
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
    if (mem.user.preferences.length > 0) {userLines.push(`偏好: ${mem.user.preferences.join('、')}`)}
    if (mem.user.habits.length > 0) {userLines.push(`习惯: ${mem.user.habits.join('、')}`)}
    if (mem.user.communicationStyle) {userLines.push(`沟通风格: ${mem.user.communicationStyle}`)}
    if (userLines.length > 0) {parts.push('## 用户画像\n' + userLines.map(l => `- ${l}`).join('\n'))}

    const memLines: string[] = []
    if (mem.memory.lessons.length > 0) {memLines.push(`经验教训: ${mem.memory.lessons.join(' | ')}`)}
    if (mem.memory.projectConventions.length > 0) {memLines.push(`项目约定: ${mem.memory.projectConventions.join(' | ')}`)}
    if (mem.memory.toolExperience.length > 0) {memLines.push(`工具经验: ${mem.memory.toolExperience.join(' | ')}`)}
    if (memLines.length > 0) {parts.push('## 环境配置\n' + memLines.map(l => `- ${l}`).join('\n'))}

    const summaries = this.getRecentSummaries(3)
    if (summaries.length > 0) {parts.push('## 最近对话摘要\n' + summaries.map((s, i) => `[${i + 1}] ${s}`).join('\n'))}

    // I4: 未了结的关系事件主动注入（哪怕 TF-IDF 没命中，也要让 Lumina 主动提起）
    if (isEnabled('memory.relationshipEvents')) {
      try {
        const unresolved = this.relEvents.getUnresolvedPromises(3)
        if (unresolved.length > 0) {
          const lines = unresolved.map(e => {
            const kindMap: Record<string, string> = {
              promise: '答应过', sad_moment: '上次难过', argument: '闹过别扭',
            }
            const label = kindMap[e.kind] || e.kind
            return `- ${label}：${e.title}（还没了结，找个合适时机轻轻提起）`
          })
          parts.push('## 我们之间还没翻篇的事\n' + lines.join('\n'))
        }
      } catch { /* 注入失败不影响主记忆 */ }
    }

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
    } catch (e) {
      // 🔧 P0 修复（假成功）
      // 旧实现：catch 后**什么都不做**，不重抛。
      // 而调用方 electron/memory/unified.ts:102 是：
      //     try { store.addMemory(...); return { ok: true, id } } catch { ... }
      // addMemory 永远不抛 → 那个 catch 永远进不去 →
      // **数据库写失败时，Agent 仍被告知「记忆已保存」**。
      //
      // 记忆是 Lumina 的核心卖点。Agent 以为记住了、于是依赖那段记忆
      // 推理，而实际库里没有——这是最难察觉的一类数据丢失，
      // 而且会随对话推进变得越来越明显。
      //
      // 现在：记日志并重抛，让上层如实回报失败。
      console.error('[MemoryStore] 写入语义记忆失败（已上抛，让调用方如实回报）:', e)
      throw e
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
 * 把 RRF 分数归一到 0-1。
 *
 * RRF 原始分数的量级很怪：k=60、只进了一路时，rank1≈0.0164、rank20≈0.0125；
 * 两路都进则翻倍。直接当百分比展示会永远是「1%」或「2%」，完全没法看。
 *
 * 这里按理论上下界线性拉伸：
 *   min = 1/(k+perRoute)   （两路都进且刚好掉出预取窗口的最差情况）
 *   max = 2/(k+1)          （两路都是第一名的最好情况）
 * 超出区间的一律裁剪到 [0,1]，不抛错。
 */
function normalizeRrfScore(raw: number, k = 60, perRoute = 20): number {
  const min = 1 / (k + Math.max(1, perRoute))
  const max = 2 / (k + 1)
  if (!Number.isFinite(raw)) {return 0}
  if (max <= min) {return 0}
  const norm = (raw - min) / (max - min)
  return Math.max(0, Math.min(1, norm))
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
          if (!res.ok) {throw new Error(`Ollama embedding 失败: ${res.status}`)}
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
        if (!res.ok) {throw new Error(`Embedding 请求失败: ${res.status}`)}
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
        if (!res.ok) {throw new Error(`Rerank 请求失败: ${res.status}`)}
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
   * 🆕 混合检索：BM25 词法 + 余弦语义 → RRF 融合
   *
   * 【为什么要新增而不是改 search()】
   * `search()` 是纯 TF-IDF 余弦：同一批查询下，「关键词精确命中」和
   * 「语义相近」只能二选一。中文尤其明显——用户问「赏樱旅行」，
   * 记忆里写的是「去看樱花」，余弦勉强能救，纯词法完全无能为力；
   * 反过来用户搜「樱花 签证」这种含具体关键词的，余弦容易被高频泛词带偏。
   *
   * 保留 `search()` 不动（向后兼容 + rerank 链路不变），
   * 新增本方法作为「语义 + 词法」双路的融合入口，由调用方按配置选用。
   *
   * @param query  查询文本
   * @param topK   返回条数
   * @param options.minCosine 余弦路最低相似度（滤噪声）
   * @returns 与 `search()` 同构的 SearchResult[]，score 已归一到 0-1 便于沿用既有展示逻辑
   */
  async searchHybrid(
    query: string,
    topK = 5,
    options: { minCosine?: number; perRoute?: number } = {},
  ): Promise<SearchResult[]> {
    if (this.entries.length === 0) { return [] }
    if (this.dirty) { this.rebuildIndex() }

    // 入参转换成 hybridRecall 认识的结构
    const docs = this.entries.map((e, i) => ({
      id: e.id,
      text: e.text,
      vector: e.vector && e.vector.length > 0 ? e.vector : undefined,
      metadata: { ...e.metadata, __index: i },
    }))

    const hits = hybridRecall(query, docs, {
      topK,
      perRoute: options.perRoute ?? 20,
      minCosine: options.minCosine ?? 0.05,
    })

    return hits.map(h => {
      const idx = (h.metadata?.__index as number) ?? 0
      const entry = this.entries[idx] ?? { id: h.id, text: h.text, vector: [], metadata: h.metadata }
      return {
        entry,
        // RRF 分数很小（1/(k+rank) 量级），归一到 0-1 以便调用方照旧用百分比展示。
        // 正常情况下 topK 条里分数会落在 0.016~0.033，归一后集中在 0.4~1.0。
        score: normalizeRrfScore(h.score),
        snippet: this.extractSnippet(entry.text, query, 80),
      }
    })
  }

  /**
   * 语义搜索
   * @param query 查询文本
   * @param topK 返回前 K 个结果
   * @param minScore 最低相似度阈值 (0-1)
   */
  async search(query: string, topK = 5, minScore = 0.1): Promise<SearchResult[]> {
    if (this.entries.length === 0) {return []}

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
    if (keywords.length === 0) {return this.entries.slice(0, topK)}

    const scored = this.entries.map((entry) => {
      const textLower = entry.text.toLowerCase()
      let score = 0
      for (const kw of keywords) {
        if (textLower.includes(kw)) {score += 1}
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
    if (a.length !== b.length) {return 0}
    let dotProduct = 0
    let normA = 0
    let normB = 0
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i]
      normA += a[i] * a[i]
      normB += b[i] * b[i]
    }
    if (normA === 0 || normB === 0) {return 0}
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
    if (queryTokens.length === 0) {return text.slice(0, maxLen) + (text.length > maxLen ? '...' : '')}

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
    if (!this.externalEmbedder) {return []}

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
  if (!_vectorStore) {_vectorStore = new MemoryVectorStore()}
  return _vectorStore
}

let _store: MemoryStore | null = null
/**
 * 获取记忆存储单例。
 *
 * 🔒 韧性设计：better-sqlite3 是原生模块，须与目标运行时 ABI 严格匹配。
 * 一旦 Electron/Node 升级导致 ABI 漂移，原生模块加载会抛错。此时不再让
 * 记忆系统整体崩溃，而是**自动降级到 JsonMemoryStore**（纯文件持久化），
 * 保证 Lumina 在任何环境下都能记住用户，绝不静默丢记忆。
 * 生产环境（ABI 匹配）仍走 SQLite 主存储，行为不受影响。
 */
export function getMemoryStore(dbPath?: string): MemoryStore {
  if (!_store) {
    try {
      _store = new MemoryStore(dbPath)
    } catch (err) {
      console.error(
        '[MemoryStore] 原生 SQLite 存储不可用（ABI 不匹配？），降级到 JSON 文件兜底存储：',
        (err as Error)?.message || err,
      )
      try {
        // 延迟引入，避免原生模块加载失败时连 JSON 兜底都 import 不到
        const { JsonMemoryStore } = require('./jsonMemoryStore') as typeof import('./jsonMemoryStore')
        _store = new JsonMemoryStore(dbPath) as unknown as MemoryStore
      } catch (fallbackErr) {
        console.error('[MemoryStore] JSON 兜底存储也初始化失败，记忆将不可用：', fallbackErr)
        throw fallbackErr
      }
    }
  }
  return _store
}
