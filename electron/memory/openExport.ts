// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// memory/openExport.ts — 跨 Agent 记忆互通的开放格式（创新功能 5）
//
// 【行业正在发生的事】
//
// N.E.K.O v0.9.0 已经做了「从 OpenClaw / Hermes 导入记忆」，
// 并明确把记忆定位成**跨 Agent 可迁移资产**。方向已经定了。
//
// 但现有的搬运方案搬的是**裸事实**，不搬可信度。
// 问题在于：同一条「用户用 Rust 写工具链」，
//   在 A 那里可能是用户亲口确认的（confidence 1.0），
//   在 B 那里可能只是模型猜的（cap 0.5），
//   在 C 那里是三个月前的过期信息。
// 搬过去之后三者长得一模一样，导入方无从分辨。
//
// 【我们做什么：不是搬运记忆，是搬运「带可信度标注的记忆」】
//
// 导出的每一条都带三样东西：
//   authority    这条是谁说的、上限是多少（我们写入期就锁死的，不是事后补的）
//   provenance   什么时候第一次/最后一次出现、被命中过几次
//   emotion      如果有，当时的感觉是什么、现在还剩多少权重
//
// 导入方拿到就能判断「这条能不能直接用」。
// 相比裸事实搬运，这是高一个维度的能力，
// 而且天然契合 Lumina「安全是默认值」的定位。
//
// 【为什么不跟 N.E.K.O 抢「搬运工」的角色】
// 我们的记忆是 SQLite + 结构化事件，导出格式完全可控，
// 但我们**故意不追求搬运量**。搬运量越大，格式越容易被别人砍掉
// 那些「不属于核心」的部分，只留下好抄的那部分，然后可信度就丢了。
// 宁可小而完整。
//
// 【纯函数，零 Electron 依赖】
// ============================================================

// ── 格式定义 ──────────────────────────────────────────────

export const OPEN_MEMORY_FORMAT = 'lumina-memory' as const
export const OPEN_MEMORY_VERSION = 1 as const

/** 可信度分档 —— 给导入方一个不需要理解数字的判断依据 */
export type TrustLevel = 'high' | 'medium' | 'low'

export interface Authority {
  /**
   * 事实来源。沿用 memoryStore 的 FactSource 词表：
   *   user_confirmed  用户明确确认
   *   user_stated     用户自己说的
   *   model_inferred  模型推断
   *   observed        工具观测到
   */
  source: string
  /** 写入时按 source 封顶后的置信度（0~1） */
  confidence: number
  /** 该来源的置信度天花板 —— 用来告诉导入方「这条最多能有多可信」 */
  cap: number
}

export interface Provenance {
  firstSeen: string
  lastSeen: string
  /** 被召回命中的次数 */
  hits: number
}

export interface EmotionalAnnotation {
  tag: string
  intensity: number
  /** 经过时间衰减后的有效权重 0~1 */
  weight: number
}

export interface OpenMemoryItem {
  /** 稳定 id（content_key 的哈希，跨设备可比对） */
  id: string
  text: string
  category: string
  authority: Authority
  provenance: Provenance
  /** 有情绪记录时才存在 */
  emotion?: EmotionalAnnotation
  /** 冗余字段：不用理解上面的数字也能判断 */
  trust: TrustLevel
}

export interface OpenMemoryBundle {
  format: typeof OPEN_MEMORY_FORMAT
  version: typeof OPEN_MEMORY_VERSION
  exportedAt: string
  producer: { app: string; version: string }
  /** 导入方应当如何对待本包 */
  notice: string
  items: OpenMemoryItem[]
}

// ── 导出 ──────────────────────────────────────────────────

/** 导出时需要的最小输入（调用方从 memoryStore 拉） */
export interface ExportInput {
  category: string
  content: string
  source: string
  confidence: number
  cap: number
  createdAt: string
  lastSeen?: string
  hits?: number
  emotion?: { tag: string; intensity: number; weight: number }
}

export interface ExportOptions {
  producer?: { app: string; version: string }
  /** 低于此 trust 的条目直接不导出（默认 low；宁可少也不送垃圾） */
  minTrust?: TrustLevel
  now?: () => Date
}

const TRUST_ORDER: Record<TrustLevel, number> = { low: 0, medium: 1, high: 2 }

/**
 * 可信度分档规则。
 *
 * 【关键：取 confidence 与 cap 的较小值】
 * 一条 `model_inferred` 的记忆就算模型自己写了 0.95 也不能算高可信 ——
 * 因为它的天花板就是 0.5。这类「自封高置信」的记忆一旦被导出，
 * 就是在把模型的幻觉当成用户的陈述传播出去。
 */
export function trustLevelOf(confidence: number, cap: number): TrustLevel {
  const effective = Math.min(confidence, cap)
  if (effective >= 0.85) {return 'high'}
  if (effective >= 0.5) {return 'medium'}
  return 'low'
}

export function buildOpenMemoryBundle(
  rows: ExportInput[],
  opts: ExportOptions = {},
): OpenMemoryBundle {
  const min = opts.minTrust ?? 'low'
  const now = opts.now ? opts.now() : new Date()

  const items: OpenMemoryItem[] = []
  for (const r of rows) {
    const text = String(r.content ?? '').trim()
    if (!text) {continue}
    const trust = trustLevelOf(r.confidence, r.cap)
    if (TRUST_ORDER[trust] < TRUST_ORDER[min]) {continue}
    items.push({
      id: stableId(r.category, text),
      text,
      category: r.category,
      authority: {
        source: r.source,
        confidence: round2(r.confidence),
        cap: round2(r.cap),
      },
      provenance: {
        firstSeen: r.createdAt,
        lastSeen: r.lastSeen ?? r.createdAt,
        hits: r.hits ?? 0,
      },
      ...(r.emotion
        ? {
            emotion: {
              tag: r.emotion.tag,
              intensity: round2(r.emotion.intensity),
              weight: round2(r.emotion.weight),
            },
          }
        : {}),
      trust,
    })
  }

  return {
    format: OPEN_MEMORY_FORMAT,
    version: OPEN_MEMORY_VERSION,
    exportedAt: now.toISOString(),
    producer: opts.producer ?? { app: 'Lumina Life', version: '0.1.0' },
    notice: '每条都带 authority（来源与置信度上限）。请按 trust 分档采信：'
      + 'high 可直接使用，medium 建议向用户确认，low 仅作线索，不要当作用户的陈述。',
    items,
  }
}

// ── 校验（导入方用）────────────────────────────────────────

export interface ValidationIssue {
  level: 'error' | 'warn'
  path: string
  message: string
}

export interface ValidationResult {
  ok: boolean
  bundle?: OpenMemoryBundle
  issues: ValidationIssue[]
  /** 统计：供导入方决定要不要全收 */
  stats: { total: number; high: number; medium: number; low: number; withEmotion: number }
}

/**
 * 校验并解析一个外部记忆包。
 *
 * 【为什么要认真校验】
 * 记忆包本质是**外部输入**——和 IM 消息、网页内容同级。
 * 一个宽松的解析器加上「这里信任一下那里的 confidence」，
 * 等于给攻击者开了一扇把伪造记忆注入上下文的门：
 *   攻击者构造 confidence: 1.0, source: 'user_confirmed' 的条目
 *   → 被当作用户亲口说过的事实注入 → 后续行为全部被带偏
 * 所以：**字段缺失即降级，格式不符即报错，绝不"善意修复"**。
 */
export function validateOpenMemoryBundle(input: unknown): ValidationResult {
  const issues: ValidationIssue[] = []

  if (!input || typeof input !== 'object') {
    return { ok: false, issues: [{ level: 'error', path: '$', message: '不是一个对象' }], stats: zeroStats() }
  }
  const b = input as Record<string, unknown>

  if (b.format !== OPEN_MEMORY_FORMAT) {
    issues.push({ level: 'error', path: 'format', message: `格式标识不匹配，期望 ${OPEN_MEMORY_FORMAT}` })
  }
  if (b.version !== OPEN_MEMORY_VERSION) {
    issues.push({ level: 'error', path: 'version', message: `版本不支持，期望 ${OPEN_MEMORY_VERSION}，收到 ${String(b.version)}` })
  }
  if (!Array.isArray(b.items)) {
    issues.push({ level: 'error', path: 'items', message: 'items 必须是数组' })
    return { ok: false, issues, stats: zeroStats() }
  }

  const items: OpenMemoryItem[] = []
  const stats = { total: 0, high: 0, medium: 0, low: 0, withEmotion: 0 }

  b.items.forEach((raw, i) => {
    const p = `items[${i}]`
    if (!raw || typeof raw !== 'object') {
      issues.push({ level: 'error', path: p, message: '不是对象' }); return
    }
    const it = raw as Record<string, unknown>

    if (typeof it.text !== 'string' || !it.text.trim()) {
      issues.push({ level: 'error', path: `${p}.text`, message: '正文缺失或为空' }); return
    }

    // authority 缺失 = 不可信来源
    // 【不能默认给高可信】—— 缺字段就降级到 low，而不是「看起来还行就当中可信」
    let trust: TrustLevel = 'low'
    const a = it.authority as Record<string, unknown> | undefined
    if (a && typeof a === 'object' && typeof a.confidence === 'number' && typeof a.cap === 'number') {
      trust = trustLevelOf(a.confidence, a.cap)
    } else {
      issues.push({
        level: 'warn',
        path: `${p}.authority`,
        message: '缺少可信度标注，已降级为 low（不按用户陈述采信）',
      })
    }

    // trust 字段与 authority 对不上时，以**重算结果**为准
    if (it.trust !== trust) {
      issues.push({
        level: 'warn',
        path: `${p}.trust`,
        message: `声明的 trust(${String(it.trust)}) 与 authority 推算(${trust}) 不一致，以推算为准`,
      })
    }

    const emo = it.emotion as Record<string, unknown> | undefined
    if (emo && typeof emo === 'object' && typeof emo.tag === 'string') {
      stats.withEmotion++
    }

    stats[trust]++
    items.push({
      id: typeof it.id === 'string' && it.id ? it.id : stableId(String(it.category ?? 'other'), String(it.text)),
      text: String(it.text).trim(),
      category: typeof it.category === 'string' ? it.category : 'other',
      authority: a && typeof a.source === 'string'
        ? { source: a.source, confidence: round2(Number(a.confidence)), cap: round2(Number(a.cap)) }
        : { source: 'unknown', confidence: 0, cap: 0 },
      provenance: (it.provenance && typeof it.provenance === 'object'
        ? it.provenance as Record<string, unknown>
        : {}) as never,
      ...(emo && typeof emo.tag === 'string'
        ? { emotion: { tag: emo.tag, intensity: round2(Number(emo.intensity)), weight: round2(Number(emo.weight)) } }
        : {}),
      trust,
    })
  })

  stats.total = items.length
  const hasError = issues.some(i => i.level === 'error')
  return {
    ok: !hasError,
    issues,
    stats,
    ...(hasError ? {} : {
      bundle: {
        format: OPEN_MEMORY_FORMAT,
        version: OPEN_MEMORY_VERSION,
        exportedAt: typeof b.exportedAt === 'string' ? b.exportedAt : new Date(0).toISOString(),
        producer: (b.producer && typeof b.producer === 'object' ? b.producer : { app: 'unknown', version: '0' }) as { app: string; version: string },
        notice: typeof b.notice === 'string' ? b.notice : '',
        items,
      },
    }),
  }
}

/** 序列化为 JSON 字符串（供 CLI / 导出文件用） */
export function serializeBundle(b: OpenMemoryBundle, pretty = true): string {
  return JSON.stringify(b, null, pretty ? 2 : 0)
}

// ── 工具 ──────────────────────────────────────────────────

/** 跨设备可比的稳定 id：category + 正文，不含时间戳与来源 */
function stableId(category: string, text: string): string {
  const s = `${category} ${text}`
  // FNV-1a 32 位：够用且无依赖；不用于安全场景（仅做去重/比对）
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

function round2(n: number): number {
  const v = Number(n)
  if (!Number.isFinite(v)) {return 0}
  return Math.round(v * 100) / 100
}

function zeroStats(): ValidationResult['stats'] {
  return { total: 0, high: 0, medium: 0, low: 0, withEmotion: 0 }
}
