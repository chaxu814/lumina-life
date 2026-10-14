// ============================================================
// moodstats/snapshotStore.ts — 快照存储（纯逻辑 + 存储适配分层）
//
// 【分层】
//   · SnapshotStore 接口：上层（统计 / 导出 / IPC）只认这个接口。
//   · SqliteSnapshotStore：复用项目现有 better-sqlite3 范式
//     （写法参考 electron/moments/momentsStore.ts）。
//   · MemorySnapshotStore：SQLite 不可用时的降级——内存环形数组，
//     可选 JSONL 追加（尽力而为），degraded=true 显式标注。
//
// 【采集钩子的纪律】
//   wrapToolExecutor / wrapAsyncCall 是运行时包裹器：
//     1. 包裹层只「观察」，原方法返回值 / 抛出的异常原样透传；
//     2. 快照写入整体 try/catch —— 存储崩了绝不允许冒泡到委托或工具执行；
//     3. 读取情绪 / 分组 / 门控状态全部走注入的 reader，
//        reader 抛错时记「未知」而不是不记。
//
// 【已知限制（诚实记录）】
//   · 重试次数：ToolResult（tools/types.ts）不暴露内部重试了几轮，
//     snapshot 里的 retries 在工具链路恒为 0；只有包裹外部显式传值时才有。
//   · eventBus 上的 'agent:tool_start' / 'agent:tool_end' 目前只有常量、
//     没有任何地方 emit，所以工具结果采集只能靠包裹 executeToolWithRetry。
// ============================================================

import type {
  MoodSnapshot, SnapshotKind, GroupTag, EmotionReader, GateStateReader, GroupReader,
} from './types'

// ═══════════════════════════════════════════════════════════
// 存储接口
// ═══════════════════════════════════════════════════════════

export interface SnapshotStore {
  /** 写入一条快照；实现必须吞掉所有异常（采集失败不影响主链路） */
  insert(s: MoodSnapshot): void
  /** 最近 N 条（新 → 旧） */
  recent(limit: number): MoodSnapshot[]
  /** 某个时间戳之后的全部快照（旧 → 新），用于统计 */
  since(ts: number): MoodSnapshot[]
  count(): number
  /** true = SQLite 不可用，当前是内存/JSONL 降级 */
  readonly degraded: boolean
  close(): void
}

// ═══════════════════════════════════════════════════════════
// 降级实现：内存 + 可选 JSONL
// ═══════════════════════════════════════════════════════════

export class MemorySnapshotStore implements SnapshotStore {
  public readonly degraded = true
  private rows: MoodSnapshot[] = []
  private readonly jsonlPath: string | null
  private readonly maxInMemory: number

  constructor(opts: { jsonlPath?: string; maxInMemory?: number } = {}) {
    this.jsonlPath = opts.jsonlPath ?? null
    this.maxInMemory = opts.maxInMemory ?? 5000
  }

  insert(s: MoodSnapshot): void {
    try {
      this.rows.push(s)
      if (this.rows.length > this.maxInMemory) {
        this.rows.splice(0, this.rows.length - this.maxInMemory)
      }
      // JSONL 是尽力而为的降级：文件不可写就只是少一点历史，不报错。
      if (this.jsonlPath) {
        try {
          // require 在函数内惰性取用，让本类在没有 fs 的环境也能 new 出来
          const fs = require('fs')
          fs.appendFileSync(this.jsonlPath, JSON.stringify(s) + '\n', 'utf8')
        } catch { /* 降级路径，写不进就只留内存 */ }
      }
    } catch { /* 采集失败绝不影响主链路 */ }
  }

  recent(limit: number): MoodSnapshot[] {
    return [...this.rows].reverse().slice(0, limit)
  }

  since(ts: number): MoodSnapshot[] {
    return this.rows.filter(r => r.ts >= ts)
  }

  count(): number { return this.rows.length }
  close(): void { /* 内存实现无需清理 */ }
}

// ═══════════════════════════════════════════════════════════
// SQLite 实现（lazy require —— 单元测试走内存实现，不加载原生模块）
// ═══════════════════════════════════════════════════════════

export class SqliteSnapshotStore implements SnapshotStore {
  public readonly degraded = false
  private db: any = null
  private insertStmt: any = null
  private readonly dbPath: string

  constructor(dbPath: string) {
    this.dbPath = dbPath
  }

  /** 首次使用时才打开库；打开失败抛错，由工厂决定降级 */
  private ensure(): void {
    if (this.db) {return}
    const fs = require('fs')
    const path = require('path')
    const dir = path.dirname(this.dbPath)
    if (!fs.existsSync(dir)) {fs.mkdirSync(dir, { recursive: true })}
    // 与 momentsStore 同一范式：lazy require，让 better-sqlite3
    // 只在真要用库时才被加载（测试环境可能没有原生模块）。
    const Database = require('better-sqlite3')
    const db = new Database(this.dbPath)
    db.pragma('journal_mode = WAL')
    db.exec(`
      CREATE TABLE IF NOT EXISTS mood_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        target_agent TEXT,
        action TEXT NOT NULL,
        mood REAL,
        energy REAL,
        affinity REAL,
        gate_on INTEGER NOT NULL,
        gate_suppressed TEXT NOT NULL DEFAULT '[]',
        gate_rules TEXT NOT NULL DEFAULT '[]',
        grp TEXT NOT NULL,
        ok INTEGER NOT NULL,
        error_summary TEXT,
        retries INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_mood_snapshots_ts ON mood_snapshots(ts DESC);
      CREATE INDEX IF NOT EXISTS idx_mood_snapshots_kind ON mood_snapshots(kind);
    `)
    this.db = db
    this.insertStmt = db.prepare(`
      INSERT INTO mood_snapshots
        (ts, kind, agent_id, target_agent, action, mood, energy, affinity,
         gate_on, gate_suppressed, gate_rules, grp, ok, error_summary, retries, duration_ms)
      VALUES
        (@ts, @kind, @agentId, @targetAgent, @action, @mood, @energy, @affinity,
         @gateOn, @gateSuppressed, @gateRules, @group, @ok, @errorSummary, @retries, @durationMs)
    `)
  }

  insert(s: MoodSnapshot): void {
    try {
      this.ensure()
      this.insertStmt.run({
        ts: s.ts,
        kind: s.kind,
        agentId: s.agentId,
        targetAgent: s.targetAgent,
        action: s.action,
        mood: s.mood,
        energy: s.energy,
        affinity: s.affinity,
        gateOn: s.gateOn ? 1 : 0,
        gateSuppressed: JSON.stringify(s.gateSuppressed),
        gateRules: JSON.stringify(s.gateRules),
        group: s.group,
        ok: s.ok ? 1 : 0,
        errorSummary: s.errorSummary,
        retries: s.retries,
        durationMs: Math.round(s.durationMs),
      })
    } catch { /* 存储失败绝不影响主链路 */ }
  }

  recent(limit: number): MoodSnapshot[] {
    try {
      this.ensure()
      return (this.db.prepare(
        'SELECT * FROM mood_snapshots ORDER BY id DESC LIMIT ?',
      ).all(limit) as any[]).map(rowFromSql)
    } catch {
      return []
    }
  }

  since(ts: number): MoodSnapshot[] {
    try {
      this.ensure()
      return (this.db.prepare(
        'SELECT * FROM mood_snapshots WHERE ts >= ? ORDER BY id ASC',
      ).all(ts) as any[]).map(rowFromSql)
    } catch {
      return []
    }
  }

  count(): number {
    try {
      this.ensure()
      return (this.db.prepare('SELECT COUNT(*) AS n FROM mood_snapshots').get() as any).n as number
    } catch {
      return 0
    }
  }

  close(): void {
    try { this.db?.close?.() } catch { /* ignore */ }
    this.db = null
    this.insertStmt = null
  }
}

function rowFromSql(r: any): MoodSnapshot {
  return {
    ts: r.ts,
    kind: r.kind as SnapshotKind,
    agentId: r.agent_id,
    targetAgent: r.target_agent,
    action: r.action,
    mood: r.mood,
    energy: r.energy,
    affinity: r.affinity,
    gateOn: !!r.gate_on,
    gateSuppressed: safeJsonArray(r.gate_suppressed),
    gateRules: safeJsonArray(r.gate_rules),
    group: r.grp as GroupTag,
    ok: !!r.ok,
    errorSummary: r.error_summary,
    retries: r.retries,
    durationMs: r.duration_ms,
  }
}

function safeJsonArray(v: unknown): string[] {
  try {
    const p = JSON.parse(String(v ?? '[]'))
    return Array.isArray(p) ? p.map(String) : []
  } catch {
    return []
  }
}

// ═══════════════════════════════════════════════════════════
// 工厂：优先 SQLite，失败自动降级（degraded 标注）
// ═══════════════════════════════════════════════════════════

export function createSnapshotStore(opts: {
  dbPath?: string
  jsonlPath?: string
} = {}): SnapshotStore {
  const dbPath = opts.dbPath ?? defaultDbPath()
  try {
    const store = new SqliteSnapshotStore(dbPath)
    // 立刻试一次，把「库打不开」的问题在工厂阶段暴露出来并降级，
    // 而不是等到第一条快照默默丢掉。
    store.count()
    return store
  } catch {
    return new MemorySnapshotStore({ jsonlPath: opts.jsonlPath ?? dbPath.replace(/\.db$/i, '.jsonl') })
  }
}

function defaultDbPath(): string {
  // 与 momentsStore 同一数据目录约定
  const path = require('path')
  const os = require('os')
  return path.join(
    process.env.LUMINA_DATA_DIR || path.join(os.homedir(), '.lumina'),
    'moodstats.db',
  )
}

// ═══════════════════════════════════════════════════════════
// 采集钩子：快照上下文 + 安全包裹器
// ═══════════════════════════════════════════════════════════

/** 包裹器每次记录快照所需的全部「现状读取」，全部可注入、全部不许抛 */
export interface SnapshotContext {
  emotion: EmotionReader
  gate: GateStateReader
  group: GroupReader
  now?: () => number
}

function readEmotionSafe(emotion: EmotionReader | undefined): {
  mood: number | null; energy: number | null; affinity: number | null
} {
  try {
    const e = emotion?.()
    if (e && typeof e.mood === 'number' && typeof e.energy === 'number') {
      return { mood: e.mood, energy: e.energy, affinity: e.affinity ?? null }
    }
  } catch { /* reader 抛错 → 记未知，不影响主链路 */ }
  return { mood: null, energy: null, affinity: null }
}

function buildBase(
  ctx: SnapshotContext,
  agentId: string,
  targetAgent: string | null,
  action: string,
  kind: SnapshotKind,
): Pick<MoodSnapshot, 'ts' | 'kind' | 'agentId' | 'targetAgent' | 'action' | 'mood' | 'energy' | 'affinity' | 'gateOn' | 'gateSuppressed' | 'gateRules' | 'group'> {
  const now = ctx.now?.() ?? Date.now()
  const { mood, energy, affinity } = readEmotionSafe(ctx.emotion)
  let gateOn = true
  let gateSuppressed: string[] = []
  let gateRules: string[] = []
  try {
    const g = ctx.gate()
    gateOn = g.on
    gateSuppressed = [...g.suppressed]
    gateRules = [...g.rules]
  } catch { /* 门控状态读不到 → 按「开」记录，事后看审计 */ }
  let group: GroupTag = 'off'
  try { group = ctx.group() } catch { group = 'off' }
  return { ts: now, kind, agentId, targetAgent, action, mood, energy, affinity, gateOn, gateSuppressed, gateRules, group }
}

/**
 * 包裹工具执行器（对应 tools/registry.ts 的 executeToolWithRetry）。
 *
 * 契约：
 *   · 原方法返回值原样返回；原方法抛错时原样抛出（绝不吞、绝不改）；
 *   · 无论成功失败抛错，都写一条快照；
 *   · 包裹层自己的任何异常都被吞掉。
 */
export function wrapToolExecutor(
  original: (name: string, args: Record<string, any>, config?: any) => Promise<any>,
  ctx: SnapshotContext,
  store: SnapshotStore,
  agentId: string,
): typeof original {
  return async function wrappedTool(this: unknown, name: string, args: Record<string, any>, config?: any) {
    const started = Date.now()
    let ok = false
    let errorSummary: string | null = null
    let durationMs = 0
    try {
      const res = await original.call(this, name, args, config)
      ok = !!res?.ok
      durationMs = typeof res?.durationMs === 'number' ? res.durationMs : Date.now() - started
      if (!ok) {
        errorSummary = String(res?.error ?? res?.content ?? '').slice(0, 300) || null
      }
      return res
    } catch (e) {
      durationMs = Date.now() - started
      errorSummary = String((e as Error)?.message ?? e).slice(0, 300)
      throw e
    } finally {
      try {
        store.insert({
          ...buildBase(ctx, agentId, null, String(name ?? 'unknown'), 'tool'),
          ok,
          errorSummary,
          retries: 0, // ToolResult 不暴露内部重试次数 —— 见文件头限制
          durationMs,
        })
      } catch { /* 采集失败绝不影响工具执行 */ }
    }
  }
}

/**
 * 通用异步调用包裹器（对应委托链路：delegate / phaseGatedDelegate / parallel）。
 *
 * @param meta 委托元信息：委托方、目标、动作名
 * @param extractResult 从委托返回值里提取 ok/error/retries（返回结构各异，由接线层给）
 */
export function wrapAsyncCall<P extends unknown[], R>(
  original: (...args: P) => Promise<R>,
  ctx: SnapshotContext,
  store: SnapshotStore,
  meta: {
    agentId: string
    targetAgent: string | null
    action: string
    extractResult?: (r: R) => { ok: boolean; errorSummary?: string | null; retries?: number }
  },
): (...args: P) => Promise<R> {
  return async function wrappedCall(this: unknown, ...args: P): Promise<R> {
    const started = Date.now()
    let ok = false
    let errorSummary: string | null = null
    let retries = 0
    try {
      const res = await original.apply(this, args)
      const info = meta.extractResult?.(res)
      ok = info?.ok ?? true
      errorSummary = info?.errorSummary ?? null
      retries = info?.retries ?? 0
      return res
    } catch (e) {
      ok = false
      errorSummary = String((e as Error)?.message ?? e).slice(0, 300)
      throw e
    } finally {
      try {
        store.insert({
          ...buildBase(ctx, meta.agentId, meta.targetAgent, meta.action, 'delegate'),
          ok,
          errorSummary,
          retries,
          durationMs: Date.now() - started,
        })
      } catch { /* 采集失败绝不影响委托 */ }
    }
  }
}
