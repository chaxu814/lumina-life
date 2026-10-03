// ============================================================
// tests/notificationPolicy.test.ts
// 覆盖「改造 2」：分级弹窗策略 + SystemNotifier 的静默降级路径
// ============================================================
import { describe, it, expect, vi } from 'vitest'
import { evaluateNotification, recordNotification, DEFAULT_NOTIFY_POLICY, type NotificationPolicyInput } from '../electron/proactive/notificationPolicy'
import { SystemNotifier, type NotifierRuntime, type NotificationCtor } from '../electron/proactive/systemNotifier'

const NOW = 1_700_000_000_000

function baseInput(over: Partial<NotificationPolicyInput> = {}): NotificationPolicyInput {
  return {
    enabled: true,
    supported: true,
    appReady: true,
    permission: 'granted',
    appFocused: false,
    priority: 'high',
    minPriority: 'high',
    category: 'news',
    lastNotifiedAt: 0,
    recentTimestamps: [],
    now: NOW,
    categoryCooldownMs: 30 * 60_000,
    windowMs: 60 * 60_000,
    maxPerWindow: 3,
    ...over,
  }
}

// ═══ 纯策略 ═══

describe('evaluateNotification — 静默降级（全部不得抛错）', () => {
  it('默认配置下高优先级放行', () => {
    const d = evaluateNotification(baseInput())
    expect(d.notify).toBe(true)
    expect(d.code).toBe('ok')
  })

  it('总开关关闭 → 不弹', () => {
    const d = evaluateNotification(baseInput({ enabled: false }))
    expect(d.notify).toBe(false)
    expect(d.code).toBe('skip_disabled')
  })

  it('系统不支持 → 不弹', () => {
    const d = evaluateNotification(baseInput({ supported: false }))
    expect(d.code).toBe('skip_unsupported')
  })

  it('app 未 ready → 不弹（生命周期保护）', () => {
    const d = evaluateNotification(baseInput({ appReady: false }))
    expect(d.code).toBe('skip_not_ready')
  })

  it('权限为 denied → 静默跳过，不抛错', () => {
    const d = evaluateNotification(baseInput({ permission: 'denied' }))
    expect(d.notify).toBe(false)
    expect(d.code).toBe('skip_no_permission')
  })

  it('权限为 default（未询问）→ 同样静默跳过', () => {
    const d = evaluateNotification(baseInput({ permission: 'default' }))
    expect(d.code).toBe('skip_no_permission')
  })

  it('应用聚焦中 → 不打扰', () => {
    const d = evaluateNotification(baseInput({ appFocused: true }))
    expect(d.code).toBe('skip_focused')
  })

  it('每个跳过原因都带可读 reason', () => {
    for (const over of [
      { enabled: false }, { supported: false }, { appReady: false },
      { permission: 'denied' }, { appFocused: true },
    ]) {
      const d = evaluateNotification(baseInput(over))
      expect(d.notify).toBe(false)
      expect(d.reason.length).toBeGreaterThan(0)
    }
  })
})

describe('evaluateNotification — 分级', () => {
  it('普通优先级 + 门槛 high → 不弹（改造 2 的核心：不做逐条骚扰）', () => {
    const d = evaluateNotification(baseInput({ priority: 'normal', minPriority: 'high' }))
    expect(d.notify).toBe(false)
    expect(d.code).toBe('skip_below_priority')
  })

  it('普通优先级 + 门槛 normal → 放行', () => {
    const d = evaluateNotification(baseInput({ priority: 'normal', minPriority: 'normal' }))
    expect(d.notify).toBe(true)
  })

  it('高优先级 + 门槛 high → 放行', () => {
    expect(evaluateNotification(baseInput({ priority: 'high', minPriority: 'high' })).notify).toBe(true)
  })
})

describe('evaluateNotification — 限流与同类合并', () => {
  it('窗口内超量 → 拦截（防通知风暴）', () => {
    const recent = [NOW - 10 * 60_000, NOW - 5 * 60_000, NOW - 60_000]
    const d = evaluateNotification(baseInput({ recentTimestamps: recent, maxPerWindow: 3 }))
    expect(d.code).toBe('skip_storm_limited')
  })

  it('刚好未超量 → 放行', () => {
    const recent = [NOW - 20 * 60_000, NOW - 10 * 60_000]
    const d = evaluateNotification(baseInput({ recentTimestamps: recent, maxPerWindow: 3 }))
    expect(d.notify).toBe(true)
  })

  it('窗口外的旧记录不计入（滑动窗口会自然过期）', () => {
    const recent = [NOW - 3 * 3600_000, NOW - 2 * 3600_000, NOW - 90 * 60_000]
    const d = evaluateNotification(baseInput({ recentTimestamps: recent, maxPerWindow: 3 }))
    expect(d.notify).toBe(true)
  })

  it('同类冷却期内 → 合并为不弹', () => {
    const d = evaluateNotification(baseInput({ lastNotifiedAt: NOW - 5 * 60_000 }))
    expect(d.code).toBe('skip_category_cooldown')
  })

  it('冷却期已过 → 放行', () => {
    const d = evaluateNotification(baseInput({ lastNotifiedAt: NOW - 31 * 60_000 }))
    expect(d.notify).toBe(true)
  })
})

describe('recordNotification', () => {
  it('追加并清理窗口外记录', () => {
    const out = recordNotification([NOW - 3 * 3600_000, NOW - 60_000], NOW, 60 * 60_000)
    expect(out).toEqual([NOW - 60_000, NOW])
  })

  it('冷启动空数组', () => {
    expect(recordNotification([], NOW, 1000)).toEqual([NOW])
  })
})

// ═══ SystemNotifier（注入 fake runtime，不依赖真实 Electron） ═══

function makeRuntime(over: Partial<NotifierRuntime> = {}) {
  const show = vi.fn()
  const Ctor = vi.fn(function (this: any, _opts: any) { this.show = show }) as unknown as NotificationCtor
  const runtime: NotifierRuntime = {
    getNotificationCtor: () => Ctor,
    isSupported: () => true,
    isAppReady: () => true,
    isAppFocused: () => false,
    getPermission: () => 'granted',
    now: () => NOW,
    log: () => {},
    ...over,
  }
  return { runtime, show, Ctor }
}

describe('SystemNotifier — 正常路径', () => {
  it('授权 + 未聚焦 + 高优先级 → 调用 show()', () => {
    const { runtime, show } = makeRuntime()
    const n = new SystemNotifier({}, runtime)
    const r = n.notify({ title: 'T', body: 'B', category: 'news', priority: 'high' })
    expect(r.notified).toBe(true)
    expect(r.code).toBe('ok')
    expect(show).toHaveBeenCalledTimes(1)
  })

  it('普通优先级默认不弹（保持克制）', () => {
    const { runtime, show } = makeRuntime()
    const n = new SystemNotifier({}, runtime)
    const r = n.notify({ title: 'T', body: 'B', category: 'news', priority: 'normal' })
    expect(r.notified).toBe(false)
    expect(r.code).toBe('skip_below_priority')
    expect(show).not.toHaveBeenCalled()
  })

  it('同批第二次同类通知被合并（限流生效）', () => {
    const { runtime, show } = makeRuntime()
    const n = new SystemNotifier({}, runtime)
    n.notify({ title: 'A', body: 'B', category: 'news', priority: 'high' })
    const second = n.notify({ title: 'C', body: 'D', category: 'news', priority: 'high' })
    expect(second.notified).toBe(false)
    expect(second.code).toBe('skip_category_cooldown')
    expect(show).toHaveBeenCalledTimes(1)
  })
})

describe('SystemNotifier — 降级路径（核心验收项）', () => {
  it('未授权 → 静默降级，不抛错、不调用 show()', () => {
    const { runtime, show } = makeRuntime({ getPermission: () => 'denied' })
    const n = new SystemNotifier({}, runtime)
    const r = n.notify({ title: 'T', body: 'B', category: 'news', priority: 'high' })
    expect(r.notified).toBe(false)
    expect(r.code).toBe('skip_no_permission')
    expect(show).not.toHaveBeenCalled()
  })

  it('app 未 ready → 静默降级（不 new Notification）', () => {
    const { runtime, show } = makeRuntime({ isAppReady: () => false })
    const n = new SystemNotifier({}, runtime)
    expect(n.notify({ title: 'T', body: 'B', category: 'news', priority: 'high' }).code)
      .toBe('skip_not_ready')
    expect(show).not.toHaveBeenCalled()
  })

  it('应用聚焦 → 不打扰', () => {
    const { runtime, show } = makeRuntime({ isAppFocused: () => true })
    const n = new SystemNotifier({}, runtime)
    expect(n.notify({ title: 'T', body: 'B', category: 'news', priority: 'high' }).code)
      .toBe('skip_focused')
    expect(show).not.toHaveBeenCalled()
  })

  it('Notification 构造器为 null（Electron 不可用）→ 静默降级', () => {
    const { runtime, show } = makeRuntime({ getNotificationCtor: () => null })
    const n = new SystemNotifier({}, runtime)
    const r = n.notify({ title: 'T', body: 'B', category: 'news', priority: 'high' })
    expect(r.notified).toBe(false)
    expect(show).not.toHaveBeenCalled()
  })

  it('show() 抛异常 → 捕获并降级，**不向调用方抛出**', () => {
    const boom = vi.fn(() => { throw new Error('通知服务未启动') })
    const Ctor = vi.fn(function (this: any) { this.show = boom }) as unknown as NotificationCtor
    const { runtime } = makeRuntime({ getNotificationCtor: () => Ctor })
    const n = new SystemNotifier({}, runtime)
    const r = n.notify({ title: 'T', body: 'B', category: 'news', priority: 'high' })
    expect(r.notified).toBe(false)
    expect(r.error).toContain('通知服务未启动')
  })

  it('isSupported() 自身抛错也不影响（getPermission 兜底）', () => {
    const { runtime } = makeRuntime({
      isSupported: () => { throw new Error('boom') },
      getPermission: () => { throw new Error('boom2') },
    })
    const n = new SystemNotifier({}, runtime)
    expect(() => n.notify({ title: 'T', body: 'B', category: 'news', priority: 'high' })).not.toThrow()
  })

  it('getPermissionStatus 拿不到时回落到 default', () => {
    const { runtime } = makeRuntime({ getPermission: () => { throw new Error('x') } })
    expect(new SystemNotifier({}, runtime).getPermissionStatus()).toBe('default')
  })
})

describe('SystemNotifier — 权限申请不抛错', () => {
  it('已 granted → 直接返回，不重复申请', async () => {
    const req = vi.fn()
    const Ctor = Object.assign(vi.fn(), { permission: 'granted', requestPermission: req })
    const { runtime } = makeRuntime({ getNotificationCtor: () => Ctor as any })
    expect(await new SystemNotifier({}, runtime).requestPermission()).toBe('granted')
    expect(req).not.toHaveBeenCalled()
  })

  it('已 denied → 直接返回，不再骚扰用户', async () => {
    const req = vi.fn()
    const Ctor = Object.assign(vi.fn(), { permission: 'denied', requestPermission: req })
    const { runtime } = makeRuntime({ getNotificationCtor: () => Ctor as any })
    expect(await new SystemNotifier({}, runtime).requestPermission()).toBe('denied')
    expect(req).not.toHaveBeenCalled()
  })

  it('default → 调用 requestPermission 并返回结果', async () => {
    const Ctor = Object.assign(vi.fn(), {
      permission: 'default',
      requestPermission: vi.fn(async () => 'granted'),
    })
    const { runtime } = makeRuntime({ getNotificationCtor: () => Ctor as any })
    expect(await new SystemNotifier({}, runtime).requestPermission()).toBe('granted')
  })

  it('requestPermission 抛异常 → 吞掉并回落到 default', async () => {
    const Ctor = Object.assign(vi.fn(), {
      permission: 'default',
      requestPermission: vi.fn(() => { throw new Error('nope') }),
    })
    const { runtime } = makeRuntime({ getNotificationCtor: () => Ctor as any })
    expect(await new SystemNotifier({}, runtime).requestPermission()).toBe('default')
  })

  it('Notification 构造器不可用 → 返回 unsupported', async () => {
    const { runtime } = makeRuntime({ getNotificationCtor: () => null })
    expect(await new SystemNotifier({}, runtime).requestPermission()).toBe('unsupported')
  })
})

describe('SystemNotifier — 限流与 reset', () => {
  it('不同 category 各自计费，但共享全局窗口上限（上限 3 → 第 4 条被拦）', () => {
    const t = [NOW]
    const { runtime, show } = makeRuntime({ now: () => t[0] })
    const n = new SystemNotifier({ categoryCooldownMs: 0 }, runtime)
    // 默认 maxPerWindow=3 → 前三条不同 category 都应放行
    n.notify({ title: '1', body: '', category: 'a', priority: 'high' })
    t[0] = NOW + 1000
    n.notify({ title: '2', body: '', category: 'b', priority: 'high' })
    t[0] = NOW + 2000
    n.notify({ title: '3', body: '', category: 'c', priority: 'high' })
    t[0] = NOW + 3000
    const fourth = n.notify({ title: '4', body: '', category: 'd', priority: 'high' })
    expect(show).toHaveBeenCalledTimes(3)
    expect(fourth.code).toBe('skip_storm_limited')
  })

  it('reset() 清空限流与合并状态', () => {
    const t = [NOW]
    const { runtime, show } = makeRuntime({ now: () => t[0] })
    const n = new SystemNotifier({}, runtime)
    n.notify({ title: '1', body: '', category: 'news', priority: 'high' })
    n.reset()
    t[0] = NOW + 1000
    const r = n.notify({ title: '2', body: '', category: 'news', priority: 'high' })
    expect(r.notified).toBe(true)
    expect(show).toHaveBeenCalledTimes(2)
  })

  it('默认阈值来自 DEFAULT_NOTIFY_POLICY（保持克制）', () => {
    expect(DEFAULT_NOTIFY_POLICY.maxPerWindow).toBe(3)
    expect(DEFAULT_NOTIFY_POLICY.categoryCooldownMs).toBe(30 * 60_000)
  })
})
