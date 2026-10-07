// ============================================================
// orchestration/emotionAudit.ts — 情绪收紧的可审计层（创新功能 1）
//
// 【要解决的问题：让「为什么她这次不帮我」可被解释】
//
// 情绪门控（emotionGating）已经能做到「焦虑高就不做不可逆操作」。
// 但一旦情绪能影响安全决策，一个问题就变成了必需品：
//
//     用户：「删掉那个文件。」
//     她  ：「我今天有点不安，这个先放着好吗？」
//     用户：「为什么？」
//
// 答不上来，这套机制就从「体贴」变成了「黑箱」。
// 用户无法判断：是她真的坏了？是规则误伤了？还是我被区别对待了？
// 于是唯一理性的反应是**关掉它**。
//
// 同一时期的所有竞品都缺这一环：
//   openclaw  有完整的 Doctor 修复系统、暴露面手册、安全加固
//              —— 但没有人格，情绪根本不参与决策，无从谈解释
//   cc-haha   有五档权限 + 桌面端审批 UI
//              —— 解释的是「系统为什么不让我做」，不是「她为什么不让我做」
//   MiniMax   权限确认弹窗（并且明确把 IM 入口列为需确认的攻击面）
//              —— 同样是系统视角，不是人格视角
//
// **人格化决策的可解释性目前无人做。谁先做，谁定义这个品类的标准。**
//
// 【三条设计约束（都是从 emotionGating 继承下来的，不能破）】
//
// ① 审计记录**只增不改不删**
//    审计日志一旦可以被篡改，它就不再是审计日志。
//    用户可以「放行这一次」，但不能「删掉那次被拦下的记录」。
//
// ② 放行 ≠ 永久解锁
//    `overrideGate()` 的语义是「**这一轮**按你说的做」，
//    不是「以后都别管我了」。下一轮情绪若仍触发同一条规则，照样收紧。
//    这是 emotionGating「情绪只能收紧不能放开」原则在用户侧的对应物：
//    我们不允许任何人（包括用户）把安全默认值永久改成自动放开。
//
// ③ 放行后仍走常规权限层
//    情绪门控是**基线收紧**，不是权限授权。override 之后
//    shell_exec 依然要过 sandboxRules / permissionTier / rolePolicy。
//    放行情绪，不等于放行安全。
//
// 【纯函数 + 可注入存储】
// 审计器本体不碰 Electron、不碰数据库、不碰 LLM。
// 持久化通过注入的 sink 完成，单测里就是一个数组。
// ============================================================

import type { FrontendThree } from '../pet/life/emotionCore'
import { frontendThreeToCore, anxietyFrom } from '../pet/life/emotionCore'
import { ANXIETY_THRESHOLD, FATIGUE_THRESHOLD, UNSTABLE_VALENCE } from './emotionGating'
import type { ToolRiskClass } from './emotionGating'

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

/** 触发收紧的规则标识——与 emotionGating 的策略编号一一对应 */
export type GateRuleId = 'anxiety_irreversible' | 'fatigue_heavy'

/** 规则的可读元数据。UI 展示与文档都从这里取，不要散落硬编码。 */
export const GATE_RULES: Record<GateRuleId, {
  label: string
  /** 触发条件的人类可读描述 */
  condition: string
  /** 该规则收紧哪一类工具 */
  riskClass: ToolRiskClass
  /** 恢复条件：满足什么就不再收紧 */
  recovery: string
  /** 代码位置——专业用户会想知道去哪儿看实现 */
  source: string
}> = {
  anxiety_irreversible: {
    label: '焦虑偏高 + 情绪不稳',
    condition: `焦虑 ≥ ${ANXIETY_THRESHOLD} 且 效价 ≤ ${UNSTABLE_VALENCE}`,
    riskClass: 'irreversible',
    recovery: `焦虑回落到 ${ANXIETY_THRESHOLD} 以下，或情绪重新稳定`,
    source: 'emotionGating.ts:ANXIETY_THRESHOLD / UNSTABLE_VALENCE',
  },
  fatigue_heavy: {
    label: '疲劳偏高',
    condition: `疲劳 ≥ ${FATIGUE_THRESHOLD}`,
    riskClass: 'heavy',
    recovery: `疲劳回落到 ${FATIGUE_THRESHOLD} 以下（正常情况下休息一轮即可）`,
    source: 'emotionGating.ts:FATIGUE_THRESHOLD',
  },
}

/** 一次收紧的完整快照 */
export interface EmotionGateRecord {
  /** 唯一 id */
  id: string
  /** 发生时间（ms） */
  ts: number
  /** 触发时的三维情绪快照 */
  emotion: {
    mood: number
    energy: number
    /** 焦虑值（valence × arousal 推导，便于直接展示） */
    anxiety: number
    /** 疲劳值 */
    fatigue: number
    /** 效价 */
    valence: number
  }
  /** 命中的规则 */
  rules: GateRuleId[]
  /** 被收紧的工具及其风险类别 */
  suppressed: Array<{ tool: string; riskClass: ToolRiskClass }>
  /** 给用户看的一句话 */
  notice: string

  // ── 生命周期 ──
  /** 记录状态 */
  status: 'active' | 'recovered' | 'overridden'
  /** 恢复时间（仅 status='recovered'） */
  recoveredAt?: number
  /** 放行时间（仅 status='overridden'） */
  overriddenAt?: number
  /** 放行人写下的理由（仅 status='overridden'） */
  overrideReason?: string
  /** 关联的这一轮对话 id（若有），便于在会话里回查 */
  turnId?: string
}

/** 展示用的一行摘要（给面板/气泡用） */
export interface EmotionGateSummary {
  id: string
  ts: number
  status: EmotionGateRecord['status']
  /** 一句话：规则 + 数量 */
  headline: string
  /** 完整原因链，逐行可读 */
  detail: string[]
}

/** 审计器依赖 */
export interface EmotionAuditDeps {
  /** 记录 id 生成器（可注入以便测试确定性） */
  now?: () => number
  /** id 后缀生成（可注入以便测试确定性） */
  makeId?: (ts: number, seq: number) => string
  /**
   * 持久化 sink。默认**不持久化**——只在内存里保留最近 N 条。
   * 传入 sink 后，每次写入都会调用；sink 抛错不影响主流程（审计失败不能阻断对话）。
   */
  sink?: (records: EmotionGateRecord[]) => void
  /** 内存中最多保留多少条 */
  maxRecords?: number
}

// ═══════════════════════════════════════════════════════════
// 审计器
// ═══════════════════════════════════════════════════════════

export class EmotionAuditLog {
  private records: EmotionGateRecord[] = []
  private seq = 0
  private readonly deps: Required<Omit<EmotionAuditDeps, 'sink'>> & Pick<EmotionAuditDeps, 'sink'>

  constructor(deps: EmotionAuditDeps = {}) {
    this.deps = {
      now: deps.now ?? (() => Date.now()),
      makeId: deps.makeId ?? ((ts, seq) => `${ts.toString(36)}-${seq.toString(36)}`),
      maxRecords: deps.maxRecords ?? 200,
      sink: deps.sink,
    }
  }

  /**
   * 记一条收紧。
   *
   * @param decision  emotionGating 的决策结果（只有 gated=true 才值得记）
   * @param emotion   触发时的情绪快照
   * @param turnId    关联对话轮次（可选）
   * @returns          记录 id；未发生收紧时返回 null
   */
  record(
    decision: { gated: boolean; suppressed: string[]; reasons: string[]; notice: string },
    emotion: FrontendThree,
    opts: { turnId?: string; classify?: (t: string) => ToolRiskClass } = {},
  ): string | null {
    // 没收紧就不记 —— 审计日志的价值在于解释「被拦下的」，不是解释「顺利通过的」
    if (!decision.gated || decision.suppressed.length === 0) {return null}

    const ts = this.deps.now()
    const id = this.deps.makeId(ts, this.seq++)
    const rules = inferRules(decision.reasons)

    const record: EmotionGateRecord = {
      id,
      ts,
      emotion: {
        mood: round2(emotion.mood),
        energy: round2(emotion.energy),
        // 阈值判断用的就是这两个值；记下来用户才能自己核对
        anxiety: round2(anxietyOf(emotion)),
        fatigue: round2(fatigueOf(emotion)),
        valence: round2(valenceOf(emotion)),
      },
      rules,
      suppressed: decision.suppressed.map((tool) => ({
        tool,
        riskClass: opts.classify ? opts.classify(tool) : 'safe',
      })),
      notice: decision.notice,
      status: 'active',
      turnId: opts.turnId,
    }

    this.records.push(record)
    // 环形截断：只留最近 N 条。**截断不等于删除审计语义**——
    // 这是内存缓冲上限，不是「可以抹掉记录」的开关。
    if (this.records.length > this.deps.maxRecords) {
      this.records.splice(0, this.records.length - this.deps.maxRecords)
    }
    this.flush()
    return id
  }

  /**
   * 用户放行：**只放行这一轮**。
   *
   * ⚠️ 语义边界（对应文件头约束 ②）：
   *   这不是「永久解锁」。下一轮情绪若仍触发同一条规则，照样收紧。
   *   它也不是权限授权 —— 放行后工具仍要过 sandboxRules / permissionTier。
   *
   * @returns 更新后的记录；id 不存在时返回 null
   */
  override(id: string, reason: string): EmotionGateRecord | null {
    const r = this.records.find(x => x.id === id)
    if (!r) {return null}
    if (r.status === 'recovered') {return r}   // 已自然恢复，无需放行
    if (r.status === 'overridden') {return r}  // 幂等
    r.status = 'overridden'
    r.overriddenAt = this.deps.now()
    r.overrideReason = String(reason ?? '').slice(0, 200)
    this.flush()
    return r
  }

  /**
   * 情绪回落后把记录标记为已恢复。
   *
   * @returns 被标记的记录数
   */
  reconcile(emotion: FrontendThree): number {
    let n = 0
    for (const r of this.records) {
      if (r.status !== 'active') {continue}
      if (!stillGated(r.rules, emotion)) {
        r.status = 'recovered'
        r.recoveredAt = this.deps.now()
        n++
      }
    }
    if (n > 0) {this.flush()}
    return n
  }

  /** 当前仍然生效的收紧（尚未恢复、也未被放行） */
  active(): EmotionGateRecord[] {
    return this.records.filter(r => r.status === 'active')
  }

  /** 全部记录（新 → 旧） */
  all(): EmotionGateRecord[] {
    return [...this.records].reverse()
  }

  get(id: string): EmotionGateRecord | null {
    return this.records.find(x => x.id === id) ?? null
  }

  /** 渲染成人类可读的原因链 */
  explain(id: string): EmotionGateSummary | null {
    const r = this.get(id)
    if (!r) {return null}
    return { id: r.id, ts: r.ts, status: r.status, headline: headlineOf(r), detail: detailOf(r) }
  }

  private flush(): void {
    if (!this.deps.sink) {return}
    try {
      this.deps.sink(this.records)
    } catch {
      // 审计写失败绝不能影响对话 —— 宁可少一条记录，不可崩一轮交互
    }
  }
}

// ═══════════════════════════════════════════════════════════
// 规则推断 / 展示
// ═══════════════════════════════════════════════════════════

/**
 * 从 emotionGating 的中文 reasons 里反推命中的规则。
 *
 * 为什么不改 emotionGating 让它直接返回 ruleId？
 * 因为那份 reasons 是**给用户看的话术**，会随文案打磨调整；
 * 审计需要的是**稳定标识**。但让上游改成结构化输出会牵动现有调用方与文案。
 * 这里做一层从文本到 id 的映射，代价是文案改了要同步 —— 已在下面写死。
 * 如果将来 rules 匹配不上，宁可**不标规则**（rules=[]）也不要标错。
 */
function inferRules(reasons: string[]): GateRuleId[] {
  const out: GateRuleId[] = []
  for (const r of reasons) {
    if (r.includes('焦虑') || r.includes('不可逆')) out.push('anxiety_irreversible')
    else if (r.includes('疲劳') || r.includes('重活') || r.includes('耗时')) out.push('fatigue_heavy')
  }
  return [...new Set(out)]
}

/** 该规则组合在当前情绪下是否仍然成立 */
function stillGated(rules: GateRuleId[], e: FrontendThree): boolean {
  if (rules.length === 0) {return false}   // 不知道规则 → 不假定仍生效
  const anx = anxietyOf(e)
  const fat = fatigueOf(e)
  const val = valenceOf(e)
  return rules.some(r =>
    r === 'anxiety_irreversible'
      ? (anx >= ANXIETY_THRESHOLD && val <= UNSTABLE_VALENCE)
      : fat >= FATIGUE_THRESHOLD,
  )
}

/**
 * 从三维情绪推导焦虑。
 *
 * ⚠️ **必须复用 emotionCore 的权威公式，不能自己重推一遍。**
 * 审计的价值是「让用户能自己核对为什么被收紧」；一旦这里算出来的
 * 数字和门控实际用的不一致，用户拿阈值一对比就会发现对不上，
 * 可解释性当场归零。emotionCore 的 anxietyFrom 已经是 emotionGating
 * 用的那个函数，这里只是转调，不产生第二套公式。
 */
function anxietyOf(e: FrontendThree): number {
  const core = frontendThreeToCore(e)
  return anxietyFrom(core.valence, core.arousal)
}

function fatigueOf(e: FrontendThree): number {
  return round2(frontendThreeToCore(e).fatigue)
}

function valenceOf(e: FrontendThree): number {
  return round2(frontendThreeToCore(e).valence)
}

function headlineOf(r: EmotionGateRecord): string {
  const labels = r.rules.length
    ? r.rules.map(id => GATE_RULES[id]?.label ?? id).join(' + ')
    : '情绪状态'
  return `${labels} → 本轮暂缓 ${r.suppressed.length} 个工具`
}

function detailOf(r: EmotionGateRecord): string[] {
  const lines: string[] = []
  lines.push(`工具 "${r.suppressed[0]?.tool ?? '?'}" 被收紧${r.suppressed.length > 1 ? ` 等 ${r.suppressed.length} 个` : ''}`)

  lines.push(
    `├─ 情绪状态：mood ${fmt(r.emotion.mood)} · energy ${fmt(r.emotion.energy)}`
    + ` · anxiety ${fmt(r.emotion.anxiety)} · fatigue ${fmt(r.emotion.fatigue)}`
    + ` · valence ${fmt(r.emotion.valence)}`,
  )

  if (r.rules.length) {
    for (const id of r.rules) {
      const rule = GATE_RULES[id]
      if (!rule) {continue}
      lines.push(`├─ 命中规则：${rule.label}（条件 ${rule.condition}）`)
      lines.push(`├─ 代码位置：${rule.source}`)
      lines.push(`└─ 恢复条件：${rule.recovery}`)
    }
  } else {
    lines.push('└─ 未识别到具体规则（文案可能已变更），仅记录情绪快照')
  }

  if (r.status === 'overridden') {
    lines.push(`↺ 你已放行本轮${r.overrideReason ? `：「${r.overrideReason}」` : ''}——下一轮若情绪仍触发同一条规则，仍会收紧。`)
  } else if (r.status === 'recovered') {
    lines.push('✓ 情绪已回落，本条自动失效。')
  } else {
    lines.push('⏳ 当前仍然生效。')
  }
  return lines
}

function fmt(n: number): string {
  return n.toFixed(2)
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// ═══════════════════════════════════════════════════════════
// 进程级单例
// ═══════════════════════════════════════════════════════════

let singleton: EmotionAuditLog | null = null

/** 取全局审计器（首次调用时创建） */
export function getEmotionAuditLog(deps?: EmotionAuditDeps): EmotionAuditLog {
  if (!singleton) {singleton = new EmotionAuditLog(deps)}
  return singleton
}

/** 测试钩子：重置单例 */
export function __resetEmotionAuditLog(): void {
  singleton = null
}
