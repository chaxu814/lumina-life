// ============================================================
// memoryManager.ts — 低风险常驻内存/CPU 治理（Electron 多进程结构下限之上）
//
// 说明：Electron 应用（主进程 + 主窗渲染器 + 桌宠渲染器 + GPU + utility）的
// 基线内存约 700MB 是结构性下限，这里不承诺「大幅下降」，只做安全的膨胀治理：
//   1) Chromium HTTP 缓存：本地应用主要是 file:// 资源，定期清缓存可回收十几~几十 MB；
//   2) 主窗最小化/隐藏后延迟清理，避免和用户操作抢资源；
//   3) 全程 try/catch，任何失败都不影响应用。
// V8 渲染器堆上限在 main.ts 用 --max-old-space-size 约束（防止长跑膨胀）。
// ============================================================

import { app, BrowserWindow, session, type Session } from 'electron'

let trimmedAtStartup = false
let hideTimer: NodeJS.Timeout | null = null
let trimming = false

/** 清理指定会话的 HTTP 缓存（安全、幂等、不影响本地 file:// 资源） */
export async function trimCaches(targetSession?: Session): Promise<void> {
  if (trimming) return
  trimming = true
  try {
    const sess = targetSession || session.defaultSession
    await sess.clearCache()
    // 仅清过期的网络/存储（不碰 cookie / 本地数据库）
    try {
      await sess.clearStorageData({
        storages: ['shadercache', 'serviceworkers'],
        origin: 'file://',
      } as any)
    } catch { /* 某些 Electron 版本 origin 与 storages 组合不支持，忽略 */ }
  } catch (e) {
    console.warn('[MemoryManager] 清理缓存失败（忽略）:', (e as Error)?.message || e)
  } finally {
    trimming = false
  }
}

/**
 * 调度内存治理：
 *   - 启动 90s 后做一次（避开冷启动高峰）；
 *   - 主窗 minimize/hide 后延迟 60s 清理；
 *   - 桌宠始终可见，不在桌宠上做任何破坏性操作。
 */
export function scheduleMemoryTrims(getMainWindow: () => BrowserWindow | null): void {
  // 启动后一次性清理
  setTimeout(() => {
    if (!trimmedAtStartup) {
      trimmedAtStartup = true
      void trimCaches()
    }
  }, 90_000)

  // 每 30 分钟，在主窗不可见时再清理一次（idle 友好）
  const periodic = setInterval(() => {
    const win = getMainWindow()
    if (!win || win.isDestroyed() || !win.isVisible()) {
      void trimCaches()
    }
  }, 30 * 60_000)
  periodic.unref?.()

  const onHidden = () => {
    if (hideTimer) clearTimeout(hideTimer)
    hideTimer = setTimeout(() => { void trimCaches() }, 60_000)
    if (hideTimer.unref) hideTimer.unref()
  }

  app.on('browser-window-created', (_e, win) => {
    win.on('minimize', onHidden)
    win.on('hide', onHidden)
  })
}

/** 打印当前进程内存快照（诊断用，不改变行为） */
export function logMemorySnapshot(label = 'mem'): void {
  try {
    const m = app.getAppMetrics()
    const totalMB = m.reduce((acc, p) => acc + (p.memory?.workingSetSize || 0) / 1024, 0)
    const byType: Record<string, number> = {}
    for (const p of m) byType[p.type] = (byType[p.type] || 0) + (p.memory?.workingSetSize || 0) / 1024
    console.log(`[MemoryManager] ${label}: 总常驻 ~${Math.round(totalMB)}MB, 进程 ${m.length}`,
      Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, Math.round(v)])))
  } catch { /* 诊断失败忽略 */ }
}
