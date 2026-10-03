// ============================================================
// notificationPolicy.ts — 系统弹窗分级策略（纯函数，零 Electron 依赖）
//
// 设计原则：**任何一条路径都不允许抛错**。
//   通知权限被拒 / 系统不支持 / 应用还没 ready / 用户正在看屏幕
//   ——这四种情况都应该是「安静地不弹」，而不是把新闻功能炸掉。
//
// 判定顺序（短路，先便宜后昂贵）：
//   disabled → unsupported → not_ready → no_permission → focused
//   → below_priority → storm_limited → category_cooldown → ok
//
// 拆成纯函数是为了能穷举所有分支写单测：真去 new Notification()
// 测「未授权时静默降级」是没有意义的。
// ============================================================

export type NotifyPriority = 'normal' | 'high'

/** 跳过原因。前缀 skip_ 统一表示「没有弹」，ok 表示弹了。 */
export type SkipCode =
  | 'ok'
  | 'skip_disabled'
  | 'skip_unsupported'
  | 'skip_not_ready'
  | 'skip_no_permission'
  | 'skip_focused'
  | 'skip_below_priority'
  | 'skip_storm_limited'
  | 'skip_category_cooldown'

export interface NotifyDecision {
  notify: boolean
  code: SkipCode
  reason: string
}

export interface NotificationPolicyInput {
  /** 系统弹窗总开关（用户可在设置页关） */
  enabled: boolean
  /** Notification.isSupported() 的结果 */
  supported: boolean
  /** app.isReady() —— main 进程未 ready 时不能 new Notification */
  appReady: boolean
  /** 通知权限；非 granted 一律静默跳过（不弹权限框、不抛错） */
  permission: string
  /** 主窗口是否聚焦 —— 用户正在看应用时不该再弹系统通知 */
  appFocused: boolean
  /** 本条内容的优先级 */
  priority: NotifyPriority
  /** 达到该优先级及以上才允许弹窗（普通新闻 = 不弹） */
  minPriority: NotifyPriority
  /** 通知分组键（一般用 category），用于同类合并 */
  category: string
  /** 该分组上次弹窗时间戳；0 = 从未弹过 */
  lastNotifiedAt: number
  /** 近期所有弹窗时间戳，用于限流 */
  recentTimestamps: number[]
  now: number
  /** 同类最小间隔 */
  categoryCooldownMs: number
  /** 限流统计窗口 */
  windowMs: number
  /** 窗口内最多几条 */
  maxPerWindow: number
}

const PRIORITY_RANK: Record<NotifyPriority, number> = { normal: 0, high: 1 }

const SKIP_REASONS: Record<Exclude<SkipCode, 'ok'>, string> = {
  skip_disabled: '系统弹窗总开关已关闭',
  skip_unsupported: '当前系统不支持 Electron Notification',
  skip_not_ready: 'app 尚未 ready（生命周期太早）',
  skip_no_permission: '用户未授予通知权限，静默降级',
  skip_focused: '应用正获得焦点，不打扰',
  skip_below_priority: '优先级低于弹窗阈值',
  skip_storm_limited: '限流：窗口内弹窗数已达上限',
  skip_category_cooldown: '同类通知处于合并冷却期',
}

function skip(code: Exclude<SkipCode, 'ok'>): NotifyDecision {
  return { notify: false, code, reason: SKIP_REASONS[code] }
}

/**
 * 决定这一条要不要弹系统通知。**纯函数，无副作用。**
 */
export function evaluateNotification(input: NotificationPolicyInput): NotifyDecision {
  const {
    enabled, supported, appReady, permission, appFocused,
    priority, minPriority, category, lastNotifiedAt,
    recentTimestamps, now, categoryCooldownMs, windowMs, maxPerWindow,
  } = input

  if (!enabled) return skip('skip_disabled')
  if (!supported) return skip('skip_unsupported')
  if (!appReady) return skip('skip_not_ready')
  if (permission !== 'granted') return skip('skip_no_permission')
  if (appFocused) return skip('skip_focused')

  // 分级：只有达到阈值的优先级才允许离开「克制模式」
  if (PRIORITY_RANK[priority] < PRIORITY_RANK[minPriority]) {
    return skip('skip_below_priority')
  }

  // 限流：滑动窗口内超量 → 防通知风暴
  const inWindow = recentTimestamps.filter(ts => now - ts < windowMs).length
  if (inWindow >= maxPerWindow) {
    return skip('skip_storm_limited')
  }

  // 同类合并：同一 category 在冷却期内只弹一条
  if (lastNotifiedAt > 0 && now - lastNotifiedAt < categoryCooldownMs) {
    return skip('skip_category_cooldown')
  }

  return {
    notify: true,
    code: 'ok',
    reason: `允许弹窗（优先级=${priority}, 分组=${category || 'default'}）`,
  }
}

/** 记录一次成功弹窗，返回清理后的时间戳列表（顺手丢掉窗口外的旧记录）。 */
export function recordNotification(
  recentTimestamps: number[],
  now: number,
  windowMs: number,
): number[] {
  return [...recentTimestamps.filter(ts => now - ts < windowMs), now]
}

// ── 默认阈值（保持克制：宁可少弹，不可打扰） ──
export const DEFAULT_NOTIFY_POLICY = {
  /** 同类通知最小间隔：30 分钟 */
  categoryCooldownMs: 30 * 60_000,
  /** 限流窗口：1 小时 */
  windowMs: 60 * 60_000,
  /** 1 小时内最多 3 条 */
  maxPerWindow: 3,
} as const
