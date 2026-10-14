// ============================================================
// memory/emotionalMemory.ts — 记忆的情绪维度（创新功能 2）
//
// 【要解决的问题：同赛道记忆系统大多只存「事实」】
//
// 扫一遍同赛道的记忆系统，存的全是事实：
//   有形象的 AI 伴侣类：35+ 模块，证据链 / 混合召回 / 人格自修正 —— 评的是「这条信息可不可信」
//   桌面编码工作台类：User/Feedback/Project/Reference 四类型
//             + AutoDream + 新鲜度管理 —— 评的是「这条信息新不新」
//   形象渲染类桌宠：记忆子系统（长期在研）
//   纯执行层工具：纯 Markdown —— 评的是「这条信息在不在这」
//
// **没有一家存「当时的感觉」。**
//
// 于是三个月后你再提起那个项目，她能准确说出「10 月 3 日文件同步失败了」，
// 但说不出「那次弄到挺烦的」——
// 而恰恰是后半句，决定了她下一次该怎么对你说话。
//
// 【本模块做什么：给事实附加情绪权重，而不是新建一套记忆】
//
// 写入时并排记一笔：
//   (事实)  文件同步失败，配置项 key 写错了
//   (情绪)  焦躁 / 强度 0.7 / 2026-10-03 22:14
//
// 三周后再提这个项目，她说的是：
//   「又是这个同步问题……上次弄到挺烦的，这次我换个思路，先备份再改？」
//
// 注意最后那半句 —— 情绪不只是被**读出来**展示的，
// 它还要能**改变策略**。这才是情绪记忆与情绪展示的区别。
//
// 【为什么不 ALTER TABLE facts】
// facts 是 4,692 行记忆系统的核心表，在线用户库里直接加列需要迁移脚本、
// 需要考虑老库、需要在回滚时能干净复原。这里用一张旁挂表按
// content_key 关联：加表是幂等的，删表也不影响 facts。
// 情绪是**可选增强**，不该成为记忆系统的可用性前提。
//
// 【测试友好：db 句柄由构造函数注入】
// 与 relationshipEvents.ts 同一套写法，better-sqlite3 只做 type-only import，
// 单元测试可以用内存 fake 在系统 Node 下跑。
// ============================================================

// type-only import：运行时擦除，不在测试里加载原生 better-sqlite3
import type { Database } from 'better-sqlite3'

/**
 * 本模块实际用到的 SQLite 能力子集。
 *
 * 【为什么不直接写 Database.Database】
 * ① `import type { Database }` 只引入类型名，拿不到 `Database.Database` 命名空间；
 * ② 更重要的是：声明成结构化接口后，单元测试可以传一个内存 fake，
 *    在系统 Node 下直接跑（不必装原生 better-sqlite3 重建），
 *    与 relationshipEvents.ts 同一套思路。
 */
export interface SqlLike {
  exec(sql: string): unknown
  prepare(sql: string): {
    all(...args: unknown[]): unknown[]
    run(...args: unknown[]): { changes: number }
  }
}

// ── 类型 ────────────────────────────────────────────────

/** 情绪标签 —— 刻意用小而稳的封闭集，不要让模型自由发挥生成新标签 */
export type EmotionTag =
  | '焦躁'      // 被反复失败磨掉耐心
  | '沮丧'      // 努力了但没成
  | '安心'      // 终于搞定
  | '兴奋'      // 超出预期
  | '委屈'      // 明明说了却没被理解
  | '感激'      // 用户帮了忙
  | '愧疚'      // 自己的失误连累用户
  | '担忧'      // 预感会出事

/** 一条情绪标注 */
export interface EmotionalTag {
  /** 关联的事实 content_key（见 memoryStore.factContentKey） */
  contentKey: string
  tag: EmotionTag
  /** 强度 0~1 */
  intensity: number
  /** 当时的情绪快照（供「当时你多难受」这类追问） */
  mood: number
  energy: number
  /** ISO 时间 */
  ts: string
  /** 触发这次标注的事件（如 'task_failed' / 'task_success' / 'user_corrected'） */
  trigger?: string
  /** 记录条数（同一件事反复发生时累加，而非覆盖） */
  count: number
}

/** 情绪如何影响后续表达策略 */
export interface EmotionalRecall {
  tag: EmotionalTag
  /** 综合强度：最近一次 intensity × 复现次数的对数加成（避免一次就把权重顶满） */
  weight: number
  /** 给 LLM 的一句话提示；无情绪时不返回（不污染 prompt） */
  hint: string
}

/** 情绪随时间衰减的半衰期（天） */
const HALF_LIFE_DAYS = 21

export interface EmotionalMemoryDeps {
  /** 可注入的「现在」���便测试 */
  now?: () => number
  /** 情绪保留天数；超过即不再注入（但记录仍在） */
  retentionDays?: number
}

// ── 存储 ────────────────────────────────────────────────

export class EmotionalMemoryStore {
  private db: SqlLike
  private readonly now: () => number
  private readonly retentionDays: number

  constructor(db: SqlLike, deps: EmotionalMemoryDeps = {}) {
    this.db = db
    this.now = deps.now ?? (() => Date.now())
    this.retentionDays = deps.retentionDays ?? 90
    this.migrate()
  }

  /** 建表（幂等） */
  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS fact_emotions (
        content_key TEXT NOT NULL,
        tag        TEXT NOT NULL,
        intensity  REAL NOT NULL,
        mood       REAL NOT NULL,
        energy     REAL NOT NULL,
        trigger    TEXT,
        ts         TEXT NOT NULL,
        count      INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (content_key, tag)
      );
      CREATE INDEX IF NOT EXISTS idx_fact_emotions_ts ON fact_emotions(ts DESC);
    `)
  }

  /**
   * 给一条事实附加情绪。
   *
   * 同一 (content_key, tag) 重复发生时**累加 count 而不是覆盖** ——
   * 「这件事让我焦躁过 3 次」和「焦躁过一次」是完全不同的信息。
   */
  attach(input: {
    contentKey: string
    tag: EmotionTag
    intensity: number
    mood: number
    energy: number
    trigger?: string
  }): void {
    if (!input.contentKey) {return}
    const ts = new Date(this.now()).toISOString()
    const intensity = clamp01(input.intensity)
    this.db.prepare(`
      INSERT INTO fact_emotions (content_key, tag, intensity, mood, energy, trigger, ts, count)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(content_key, tag) DO UPDATE SET
        intensity = excluded.intensity,
        mood      = excluded.mood,
        energy    = excluded.energy,
        trigger   = COALESCE(excluded.trigger, fact_emotions.trigger),
        ts        = excluded.ts,
        count     = fact_emotions.count + 1
    `).run(input.contentKey, input.tag, intensity, input.mood, input.energy, input.trigger ?? null, ts)
  }

  /** 取某条事实挂着的全部情绪 */
  get(contentKey: string): EmotionalTag[] {
    return this.db.prepare(
      'SELECT * FROM fact_emotions WHERE content_key=? ORDER BY ts DESC',
    ).all(contentKey) as unknown as EmotionalTag[]
  }

  /** 取某条事实**当前最有效**的情绪（强度 × 时效） */
  strongest(contentKey: string): EmotionalRecall | null {
    const tags = this.get(contentKey).map(t => ({
      tag: t,
      weight: this.weightOf(t),
    }))
    if (tags.length === 0) {return null}
    tags.sort((a, b) => b.weight - a.weight)
    return this.toRecall(tags[0])
  }

  /**
   * 给一批已召回的事实**附加**情绪标注。
   *
   * 【为什么不叫 inject / 为什么不再输出事实正文】
   * 早期版本直接返回拼好的「事实（情绪）」列表，实测不好用：
   *   · 事实正文已经被召回链路拿在手里，这里再输出一遍 = prompt 重复膨胀
   *   · 调用方无法把情绪映射回具体哪条事实，只能靠字符串匹配
   * 所以改成：**只返回标注**，正文由调用方自己拼。
   *
   * @returns byKey 供调用方逐条合并；block 供不想写合并逻辑的调用方直接用
   */
  enrich(hits: Array<{ contentKey: string; factText: string }>): {
    byKey: Map<string, EmotionalRecall>
    block: string
  } {
    const byKey = new Map<string, EmotionalRecall>()
    for (const h of hits) {
      const r = this.strongest(h.contentKey)
      // 低于阈值视为噪声：不注入。宁可少说一句，也不要让模型
      // 编造「我记得你当时很难过」这种根本不存在的共同经历。
      if (!r || r.weight < 0.15) {continue}
      byKey.set(h.contentKey, r)
    }
    if (byKey.size === 0) {return { byKey, block: '' }}

    const lines: string[] = []
    for (const h of hits) {
      const r = byKey.get(h.contentKey)
      if (r) {lines.push(`· ${h.factText}（${r.hint}）`)}
    }
    return { byKey, block: '【与这些事关联的情绪记忆】\n' + lines.join('\n') }
  }

  /** 衰减后的有效权重 */
  private weightOf(t: EmotionalTag): number {
    const ageDays = (this.now() - new Date(t.ts).getTime()) / 86_400_000
    if (ageDays > this.retentionDays) {return 0}
    const decay = Math.pow(0.5, ageDays / HALF_LIFE_DAYS)
    // 复现次数用对数加成：1→1.0, 2→1.35, 3→1.58 … 不会线性顶满
    const repeat = 1 + Math.log2(Math.max(1, t.count)) * 0.35
    return clamp01(t.intensity * decay * repeat)
  }

  private toRecall(x: { tag: EmotionalTag; weight: number }): EmotionalRecall {
    const { tag, weight } = x
    const hint = buildHint(tag.tag, tag.intensity, weight)
    return { tag, weight, hint }
  }

  /** 清理过期记录（保留期内不动） */
  prune(): number {
    const cutoff = new Date(this.now() - this.retentionDays * 86_400_000).toISOString()
    const r = this.db.prepare('DELETE FROM fact_emotions WHERE ts < ?').run(cutoff)
    return r.changes
  }
}

// ── 提示词构造 ───────────────────────────────────────────

/**
 * 构造给 LLM 的一句话提示。
 *
 * ⚠️ 措辞必须让模型知道这是**真实发生过的情绪记录**，
 * 而不是让它去演一个情绪。写成「请表现出焦虑」会诱发角色扮演式表演；
 * 写成「你当时的感觉是 X」才是复述一段既有的经历。
 */
function buildHint(tag: EmotionTag, intensity: number, weight: number): string {
  const s = intensity >= 0.66 ? '强烈' : intensity >= 0.33 ? '中等' : '轻微'
  return `当时你的感觉：${s}${tag}（持续影响 ${(weight * 100).toFixed(0)}%）`
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) {return 0}
  return Math.min(1, Math.max(0, n))
}

// ── 情绪标签推断（给调用方用的小工具）────────────────────

/**
 * 从一次任务结果事件推断该记哪个情绪标签。
 *
 * ⚠️ **保守映射，不做情感分析**：
 * 这里只看「任务成功没 + 是不是被用户纠正过」两个客观信号。
 * 让 LLM 去给每次交互打情感分是不可靠的，而且会把「模型觉得用户应该是什么情绪」
 * 写成用户的记忆 —— 那是污染，不是记忆。
 * 不确定时返回 null（不记），远好过乱记。
 */
export function inferTagFromEvent(evt: {
  success: boolean
  userCorrected?: boolean
  blocked?: boolean
}): EmotionTag | null {
  if (evt.userCorrected) {return '委屈'}
  if (evt.blocked) {return '担忧'}
  if (!evt.success) {return '焦躁'}
  return '安心'
}
