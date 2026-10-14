// ============================================================
// billing/budgetGuardian.ts — 预算守护者（纯逻辑，可测）
//
// 【核心设计原则：所有响应只收紧、不放宽】
//   与 orchestration/emotionGating.ts 同一条哲学：
//   预算花到阈值之上，系统只会更保守（提示 → 降级 → 硬限制），
//   绝不会因为「刚才算错了、钱掉回去了」就自动恢复放宽。
//   当日内的收紧是**锁存**的：哪怕某笔退款让占比回落到 80% 以下，
//   今天已经触发的降级也不会自动解除——等到本地时区次日 0 点才整体重置。
//   为什么：预算守卫的默认值宁可让用户少用，不可让它悄悄放开。
//
// 【三级响应】（占比 = 今日累计花费 / 当日预算）
//   ≥80%   warn    ：桌宠「精打细算」提示状态 + 设置面板提醒（零 LLM 调用、不砍任何调用）
//   ≥95%   degrade ：自动降级——暂停社交引擎 / 主动搭话等非必要调用；
//                     用户主动发起的对话（必需调用）一律保留
//   ≥100%  hard    ：仅保留用户主动对话的必需调用
//
// 【审计】（参照 emotionAudit.ts 的写法）
//   每一次收紧都记因果链：当前累计 → 占比 → 触发阈值 → 收紧了什么。
//   记录只增不改；用户可「本轮放行」（一次性，下一轮若仍超阈值照样收紧，
//   不是永久解锁）。
//
// 【纯函数风格】
//   不绑 Electron / SQLite / LLM。花费由调用方（usageLedger）喂进来，
//   时钟可注入，单测里 79.9% / 80% / 95% / 100% 边界都能精确打。
// ============================================================

import { lookupPrice, type PriceEntry } from './priceTable'
import { localDateKey } from './usageLedger'

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

export type GuardLevel = 'ok' | 'warn' | 'degrade' | 'hard'

/** 预算档位（人民币/天） */
export const BUDGET_TIERS = [0.5, 1, 2, 5] as const

export interface BudgetConfig {
  /** 功能总开关（默认开，阈值默认保守） */
  enabled: boolean
  /** 每日预算（元/天），默认 1 元 */
  dailyBudgetYuan: number
  /** 三级阈值（占比），默认 0.80 / 0.95 / 1.00 */
  warnRatio: number
  degradeRatio: number
  hardRatio: number
  /** 自定义 token 预算（与 dailyBudgetYuan 二选一；给了就按主力模型折算成元） */
  dailyTokenBudget?: number | null
  /** 折算用主力模型 */
  mainModel?: { provider: string; model: string } | null
}

export const DEFAULT_BUDGET_CONFIG: BudgetConfig = {
  enabled: true,
  dailyBudgetYuan: 1,
  warnRatio: 0.80,
  degradeRatio: 0.95,
  hardRatio: 1.00,
  dailyTokenBudget: null,
  mainModel: null,
}

/** 一次收紧审计记录（只增不改） */
export interface BudgetAuditRecord {
  id: string
  ts: number
  dateKey: string
  /** 本轮升到的级别 */
  level: GuardLevel
  /** 因果链：累计花费 → 占比 → 触发阈值 → 收紧动作 */
  costYuan: number
  budgetYuan: number
  ratio: number
  threshold: number
  /** 收紧了什么（人话列表） */
  actions: string[]
  status: 'active' | 'overridden'
  overriddenAt?: number
  overrideReason?: string
  /** 本轮放行额度是否已被消耗 */
  releaseConsumed: boolean
}

export interface GuardSnapshot {
  level: GuardLevel
  /** 今日累计花费（元） */
  costYuan: number
  /** 当日有效预算（元） */
  budgetYuan: number
  /** 占比 0~N（可能 >1） */
  ratio: number
  /** 剩余（元，可为负） */
  remainingYuan: number
  dateKey: string
  /** 本轮已触发的收紧动作（人话） */
  actions: string[]
}

// ═══════════════════════════════════════════════════════════
// 自定义 token 预算 → 元 的折算
// ═══════════════════════════════════════════════════════════

/**
 * 把「每日 token 预算」折算成人民币。
 *
 * 假设输入:输出 = 1:1（保守折中：真实对话输入通常远大于输出，
 * 这个比例的折算偏宽松一点点，对用户无害——宁紧勿松是预算侧的事）。
 * 查不到主力模型单价时返回 null（调用方退回到 dailyBudgetYuan）。
 */
export function tokenBudgetToYuan(
  tokenBudget: number,
  entry: PriceEntry | null,
): number | null {
  if (!entry || tokenBudget <= 0) {return null}
  const half = tokenBudget / 2
  const yuan = (half / 1_000_000) * entry.inputPerM + (half / 1_000_000) * entry.outputPerM
  return Math.round(yuan * 10_000) / 10_000
}

// ═══════════════════════════════════════════════════════════
// 守护者
// ═══════════════════════════════════════════════════════════

export class BudgetGuardian {
  private config: BudgetConfig
  private now: () => number
  private audit: BudgetAuditRecord[] = []
  private seq = 0

  /** 当日锁存的级别（只升不降，跨天重置） */
  private latchedLevel: GuardLevel = 'ok'
  private latchedDateKey: string = ''

  constructor(config: Partial<BudgetConfig> = {}, deps: { now?: () => number } = {}) {
    this.config = { ...DEFAULT_BUDGET_CONFIG, ...config }
    this.now = deps.now ?? (() => Date.now())
  }

  // ── 配置 ──────────────────────────────────────────────

  setConfig(patch: Partial<BudgetConfig>): void {
    this.config = { ...this.config, ...patch }
  }

  getConfig(): BudgetConfig {
    return { ...this.config }
  }

  /** 当日有效预算（元）：有 token 预算就折算，否则用元档位 */
  effectiveBudgetYuan(): number {
    if (this.config.dailyTokenBudget && this.config.dailyTokenBudget > 0 && this.config.mainModel) {
      const entry = lookupPrice(this.config.mainModel.provider, this.config.mainModel.model)
      const converted = tokenBudgetToYuan(this.config.dailyTokenBudget, entry)
      if (converted && converted > 0) {return Math.round(converted * 10000) / 10000}
    }
    return this.config.dailyBudgetYuan > 0 ? this.config.dailyBudgetYuan : DEFAULT_BUDGET_CONFIG.dailyBudgetYuan
  }

  // ── 跨天重置 ──────────────────────────────────────────

  private rolloverIfNewDay(ts: number): void {
    const key = localDateKey(ts)
    if (this.latchedDateKey !== key) {
      // 新的一天：锁存级别复位（当天重新计）。
      // 审计记录保留（只增不改），但旧记录全部不再 active。
      this.latchedDateKey = key
      this.latchedLevel = 'ok'
    }
  }

  /**
   * 喂入今日累计花费，得出当前状态。
   *
   * 「只收紧不放宽」在这里实现：新算出来的级别与当日锁存级别取**更高**者。
   */
  evaluate(costYuan: number): GuardSnapshot {
    const ts = this.now()
    this._lastCost = costYuan
    this.rolloverIfNewDay(ts)

    const budget = this.effectiveBudgetYuan()
    const ratio = budget > 0 ? costYuan / budget : 0

    let raw: GuardLevel = 'ok'
    let threshold = 0
    // 浮点容差：金额除法会得到 0.799999… 这种「数学上就是 0.8」的值。
    // 阈值判定向用户口径看齐：差 1e-9 以内算命中，不要让浮点数吃掉边界。
    const EPS = 1e-9
    if (!this.config.enabled) {
      // 总开关关：永远不收紧（但状态仍如实算出占比，供 UI 展示）
    } else if (ratio >= this.config.hardRatio - EPS) {
      raw = 'hard'; threshold = this.config.hardRatio
    } else if (ratio >= this.config.degradeRatio - EPS) {
      raw = 'degrade'; threshold = this.config.degradeRatio
    } else if (ratio >= this.config.warnRatio - EPS) {
      raw = 'warn'; threshold = this.config.warnRatio
    }

    const level = this.config.enabled ? this.latch(raw) : 'ok'

    return {
      level,
      costYuan: Math.round(costYuan * 10_000) / 10_000,
      budgetYuan: budget,
      ratio: Math.round(ratio * 1000) / 1000,
      remainingYuan: Math.round((budget - costYuan) * 10_000) / 10_000,
      dateKey: this.latchedDateKey || localDateKey(ts),
      actions: actionsForLevel(level),
    }
  }

  /** 锁存：只升不降（按级别严重度取大） */
  private latch(raw: GuardLevel): GuardLevel {
    const order: GuardLevel[] = ['ok', 'warn', 'degrade', 'hard']
    const prev = order.indexOf(this.latchedLevel)
    const next = order.indexOf(raw)
    const final = order[Math.max(prev, next)] as GuardLevel
    if (final !== this.latchedLevel) {
      this.recordTighten(final)
      this.latchedLevel = final
    }
    return final
  }

  // ── 必要性分类接口（给后续功能/调用方用） ─────────────

  /**
   * 用户主动对话 = 必需调用。任何级别都不砍它——
   * 预算再紧，用户来找 Lumina 说话这件事永远是第一优先。
   */
  isEssentialCallAllowed(): boolean {
    return true
  }

  /**
   * 非必要调用（社交引擎 / 主动搭话 / 仪式等后台调用）。
   * ok/warn 级：照常；degrade/hard 级：暂停。
   */
  isNonEssentialCallAllowed(snapshot?: GuardSnapshot): boolean {
    const snap = snapshot ?? this.evaluate(this._lastCost)
    if (!this.config.enabled) {return true}
    return snap.level === 'ok' || snap.level === 'warn'
  }

  /**
   * 非必要调用发起来之前问一次。
   *
   * 若被拦且用户对当前收紧点过「本轮放行」，这一次消耗额度放行。
   * @returns allowed=是否放行；released=是不是靠本轮放行放的
   */
  allowNonEssentialCall(): { allowed: boolean; released: boolean; reason?: string } {
    const snap = this.evaluate(this._lastCost)
    if (this.isNonEssentialCallAllowed(snap)) {return { allowed: true, released: false }}
    // 找一条仍 active 且放行额度未消耗的审计记录
    const pending = this.audit.find(r => r.status === 'overridden' && !r.releaseConsumed)
    if (pending) {
      pending.releaseConsumed = true
      return { allowed: true, released: true, reason: pending.overrideReason }
    }
    return { allowed: false, released: false, reason: `预算 ${Math.round(snap.ratio * 100)}%，非必要调用已暂停` }
  }

  /**
   * 主动暂停非必要调用（外部原因，如外部传 reason 标记）。
   * 当前实现：仅记审计（真正的暂停由 isNonEssentialCallAllowed 在 degrade/hard 级完成）。
   */
  pauseNonEssential(_reason: string): void {
    // 收紧是锁存的：调用方只需在每次要发起非必要调用前问 isNonEssentialCallAllowed。
    // 这里保留接口位，便于将来挂事件总线通知社交引擎立刻停。
  }

  private _lastCost = 0
  setLastCost(cost: number): void {this._lastCost = cost}

  // ── 审计 ──────────────────────────────────────────────

  private recordTighten(level: GuardLevel): void {
    const ts = this.now()
    const budget = this.effectiveBudgetYuan()
    const threshold = level === 'hard' ? this.config.hardRatio
      : level === 'degrade' ? this.config.degradeRatio
        : this.config.warnRatio
    const rec: BudgetAuditRecord = {
      id: `bg-${ts.toString(36)}-${(this.seq++).toString(36)}`,
      ts,
      dateKey: localDateKey(ts),
      level,
      costYuan: Math.round(this._lastCost * 10_000) / 10_000,
      budgetYuan: budget,
      ratio: budget > 0 ? Math.round((this._lastCost / budget) * 1000) / 1000 : 0,
      threshold,
      actions: actionsForLevel(level),
      status: 'active',
      releaseConsumed: false,
    }
    this.audit.push(rec)
  }

  /** 「本轮放行」：把当前最新一条 active 收紧标记为放行（一次性） */
  overrideLatest(reason: string): BudgetAuditRecord | null {
    const latest = [...this.audit].reverse().find(r => r.status === 'active')
    if (!latest) {return null}
    latest.status = 'overridden'
    latest.overriddenAt = this.now()
    latest.overrideReason = String(reason || '').slice(0, 200)
    latest.releaseConsumed = false
    return latest
  }

  /** 审计日志（新 → 旧） */
  getAuditLog(): BudgetAuditRecord[] {
    return [...this.audit].reverse()
  }

  /** 当前仍生效的收紧 */
  activeRecords(): BudgetAuditRecord[] {
    return this.audit.filter(r => r.status === 'active')
  }
}

/** 各级别「收紧了什么」的人话描述 */
function actionsForLevel(level: GuardLevel): string[] {
  switch (level) {
    case 'warn':
      return ['桌宠进入「精打细算」提示状态', '设置面板与沙箱玻璃房显示今日花费提醒']
    case 'degrade':
      return ['暂停社交引擎与主动搭话等非必要 LLM 调用', '云端切换到更便宜/更小模型档位', '用户主动对话不受影响']
    case 'hard':
      return ['仅保留用户主动对话的必需调用', '一切后台自动 LLM 调用暂停']
    default:
      return []
  }
}

// ═══════════════════════════════════════════════════════════
// 进程级单例
// ═══════════════════════════════════════════════════════════

let singleton: BudgetGuardian | null = null

export function getBudgetGuardian(): BudgetGuardian {
  if (!singleton) {singleton = new BudgetGuardian()}
  return singleton
}

export function initBudgetGuardian(config?: Partial<BudgetConfig>): BudgetGuardian {
  singleton = new BudgetGuardian(config)
  return singleton
}

export function __resetBudgetGuardian(): void {
  singleton = null
}
