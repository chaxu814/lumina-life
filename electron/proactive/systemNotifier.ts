// ============================================================
// systemNotifier.ts — Electron 系统 Notification 适配层
//
// 职责边界：
//   notificationPolicy.ts  决定「要不要弹」（纯逻辑，可穷举测试）
//   systemNotifier.ts      负责「怎么安全地弹」（接触 Electron API）
//
// 三条硬性约束：
//   1. 永不抛错 —— 通知是锦上添花，失败绝不能影响新闻主流程
//   2. 生命周期安全 —— main 进程 app.whenReady() 之前不 new Notification
//   3. 依赖可注入 —— 便于在不启动 Electron 的情况下做单测
// ============================================================

import { evaluateNotification, recordNotification, DEFAULT_NOTIFY_POLICY, type NotifyDecision, type NotifyPriority } from './notificationPolicy'

// ── Electron 侧的最小结构（不 import electron 类型，方便单测） ──

export interface NotificationLike {
  show(): void
  on?(event: string, listener: (...args: any[]) => void): void
}

export interface NotificationCtor {
  new (options: { title: string; body: string; silent?: boolean; urgency?: string }): NotificationLike
  isSupported?(): boolean
}

export interface NotifierRuntime {
  /** 取 Notification 构造器；不可用时返回 null */
  getNotificationCtor(): NotificationCtor | null
  isSupported(): boolean
  /** app.isReady() —— main 进程就绪标志 */
  isAppReady(): boolean
  /** 是否有窗口处于聚焦状态（用户正看着屏幕时不该弹） */
  isAppFocused(): boolean
  getPermission(): string
  now(): number
  log(message: string): void
}

export interface SystemNotifierConfig {
  /** 系统弹窗总开关 */
  enabled: boolean
  /** 达到该优先级才弹窗；默认 'high'（普通新闻只走气泡+侧边栏） */
  minPriority: NotifyPriority
  /** 同类最小间隔 */
  categoryCooldownMs: number
  /** 限流窗口 */
  windowMs: number
  /** 窗口内上限 */
  maxPerWindow: number
}

export const DEFAULT_SYSTEM_NOTIFIER_CONFIG: SystemNotifierConfig = {
  enabled: true,
  minPriority: 'high',
  categoryCooldownMs: DEFAULT_NOTIFY_POLICY.categoryCooldownMs,
  windowMs: DEFAULT_NOTIFY_POLICY.windowMs,
  maxPerWindow: DEFAULT_NOTIFY_POLICY.maxPerWindow,
}

export interface NotifyRequest {
  title: string
  body: string
  category: string
  priority: NotifyPriority
}

export interface NotifyOutcome {
  notified: boolean
  code: NotifyDecision['code']
  reason: string
  error?: string
}

// ── 默认 runtime：真接 Electron ──

function createElectronRuntime(): NotifierRuntime {
  return {
    getNotificationCtor() {
      // require 而非 import：单测（node 环境）下不触发 electron 加载
      try {
         
        return require('electron').Notification as NotificationCtor
      } catch {
        return null
      }
    },
    isSupported() {
      try {
        const ctor = require('electron').Notification as NotificationCtor
        return typeof ctor?.isSupported === 'function' ? ctor.isSupported() : false
      } catch {
        return false
      }
    },
    isAppReady() {
      try {
        return require('electron').app.isReady() === true
      } catch {
        return false
      }
    },
    isAppFocused() {
      try {
        const { BrowserWindow } = require('electron')
        if (!BrowserWindow?.getAllWindows) {return false}
        return BrowserWindow.getAllWindows().some((w: any) => {
          try { return !w.isDestroyed() && w.isFocused() } catch { return false }
        })
      } catch {
        return false
      }
    },
    getPermission() {
      try {
        const ctor = require('electron').Notification as NotificationCtor & {
          permission?: string
        }
        return ctor?.permission || 'default'
      } catch {
        return 'default'
      }
    },
    now() { return Date.now() },
    log(message: string) { console.log(`[SystemNotifier] ${message}`) },
  }
}

// ── 主类 ──

export class SystemNotifier {
  private config: SystemNotifierConfig
  private runtime: NotifierRuntime
  /** 分组 → 上次弹窗时间戳（同类合并） */
  private lastNotifiedAt: Map<string, number> = new Map()
  /** 限流用的近期弹窗时间戳 */
  private recent: number[] = []
  /** 供测试/调试读取的最近一次决策 */
  private lastDecision: NotifyDecision | null = null

  constructor(config: Partial<SystemNotifierConfig> = {}, runtime?: NotifierRuntime) {
    this.config = { ...DEFAULT_SYSTEM_NOTIFIER_CONFIG, ...config }
    this.runtime = runtime ?? createElectronRuntime()
  }

  getConfig(): SystemNotifierConfig {
    return { ...this.config }
  }

  updateConfig(partial: Partial<SystemNotifierConfig>): void {
    this.config = { ...this.config, ...partial }
  }

  getLastDecision(): NotifyDecision | null {
    return this.lastDecision
  }

  /** 取构造器也包一层：拿不到就当不支持，而不是抛出去 */
  private safeGetCtor(): NotificationCtor | null {
    try {
      return this.runtime.getNotificationCtor()
    } catch {
      return null
    }
  }

  /**
   * 当前通知权限，供设置页展示。
   * 拿不到时回落到 'default'（UI 会提示「需手动授权」），绝不抛错。
   */
  getPermissionStatus(): string {
    try {
      return this.runtime.getPermission() || 'default'
    } catch {
      return 'default'
    }
  }

  /**
   * 申请通知权限。
   * - 已 granted → 直接返回，不打扰用户
   * - default   → 弹权限框（Electron 内部处理，macOS/Windows/Linux 行为不同）
   * - denied    → 静默返回，绝不抛错、绝不重复申请
   *
   * 注意：requestPermission 在部分平台是回调式、部分是 Promise 式，
   * 这里两种都兼容，并且用 Promise.race 兜住「既不 resolve 也不 reject」。
   */
  async requestPermission(): Promise<string> {
    try {
      const ctor = this.safeGetCtor() as
        | (NotificationCtor & { permission?: string; requestPermission?: (cb: (p: string) => void) => Promise<string> | void })
        | null
      if (!ctor) {return 'unsupported'}

      const current = ctor.permission || 'default'
      if (current === 'granted' || current === 'denied') {return current}
      if (typeof ctor.requestPermission !== 'function') {return current}

      const result = await Promise.race<string>([
        Promise.resolve(
          ctor.requestPermission((p: string) => p) as string | void | Promise<string>,
        ).then((p) => (typeof p === 'string' && p ? p : 'default')),
        // 某些平台 requestPermission 既不 resolve 也不回调，兜底返回 default
        new Promise<string>(resolve => setTimeout(() => resolve('default'), 3000)),
      ])
      this.runtime.log(`权限申请结果: ${result}`)
      return result
    } catch (e: any) {
      this.runtime.log(`权限申请异常，视为未授权: ${e?.message}`)
      return 'default'
    }
  }

  /**
   * 弹一条系统通知。
   * **本方法保证不抛错**：所有异常都被吞掉并写进返回值。
   */
  notify(request: NotifyRequest): NotifyOutcome {
    const now = this.runtime.now()
    const ctor = this.safeGetCtor()

    // 先算决策。整段包 try：runtime 探测（isSupported/getPermission）自身
    // 抛错也不能把异常泄给调用方 —— 通知失败绝不能影响新闻主流程。
    let decision: NotifyDecision
    try {
      decision = evaluateNotification({
        enabled: this.config.enabled,
        supported: ctor ? this.runtime.isSupported() : false,
        appReady: this.runtime.isAppReady(),
        permission: this.runtime.getPermission(),
        appFocused: this.runtime.isAppFocused(),
        priority: request.priority,
        minPriority: this.config.minPriority,
        category: request.category,
        lastNotifiedAt: this.lastNotifiedAt.get(request.category) ?? 0,
        recentTimestamps: this.recent,
        now,
        categoryCooldownMs: this.config.categoryCooldownMs,
        windowMs: this.config.windowMs,
        maxPerWindow: this.config.maxPerWindow,
      })
    } catch (e: any) {
      const message = e?.message || String(e)
      this.runtime.log(`通知策略判定异常（已静默降级）: ${message}`)
      return { notified: false, code: 'skip_unsupported', reason: '通知策略判定异常', error: message }
    }
    this.lastDecision = decision

    if (!decision.notify) {
      // 注意：静默跳过不视为错误，不需要 try/catch
      return { notified: false, code: decision.code, reason: decision.reason }
    }

    try {
      const n = new (ctor as NotificationCtor)({
        title: request.title,
        body: request.body,
        silent: false,
        urgency: request.priority === 'high' ? 'critical' : 'normal',
      })
      n.show()
      this.lastNotifiedAt.set(request.category, now)
      this.recent = recordNotification(this.recent, now, this.config.windowMs)
      this.runtime.log(`已弹窗: ${request.title} (${request.category}/${request.priority})`)
      return { notified: true, code: 'ok', reason: decision.reason }
    } catch (e: any) {
      // 平台差异（Linux 缺 tray、win32 通知服务未启动等）不应影响新闻流程
      const message = e?.message || String(e)
      this.runtime.log(`系统通知失败（已静默降级）: ${message}`)
      return { notified: false, code: 'ok', reason: decision.reason, error: message }
    }
  }

  /** 清空限流/合并状态（用户手动重置冷却时用） */
  reset(): void {
    this.lastNotifiedAt.clear()
    this.recent = []
    this.lastDecision = null
  }
}

// ── 单例 ──

let instance: SystemNotifier | null = null

export function getSystemNotifier(): SystemNotifier {
  if (!instance) {instance = new SystemNotifier()}
  return instance
}

export function setSystemNotifierConfig(config: Partial<SystemNotifierConfig>): void {
  getSystemNotifier().updateConfig(config)
}
