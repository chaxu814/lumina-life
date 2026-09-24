// ============================================================
// pushScheduler.ts — 主动推送调度器
// 每5分钟检查一次，用户活跃时暂停，空闲时才可能推送
// ============================================================

import { decidePush } from './pushDecider'
import { executePush } from './pushExecutor'
import {
  loadPushState, savePushState, loadPushSettings,
  recordUserActivity, tickState, type PushState, type PushSettings,
} from './pushState'
import type { PushExecutorDeps } from './pushExecutor'

const CHECK_INTERVAL_MS = 5 * 60 * 1000 // 5分钟

export class PushScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private state: PushState
  private settings: PushSettings
  private deps: PushExecutorDeps
  private running = false

  constructor(deps: PushExecutorDeps = {}) {
    this.deps = deps
    this.state = loadPushState()
    this.settings = loadPushSettings()
  }

  start(): void {
    if (this.timer) return
    this.running = true
    this.timer = setInterval(() => this.tick(), CHECK_INTERVAL_MS)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.running = false
  }

  /** 用户活跃时调用，暂停推送并更新状态 */
  notifyUserActivity(): void {
    this.state = recordUserActivity(this.state)
    savePushState(this.state)
  }

  /** 立即触发一次决策（用于测试/手动触发） */
  triggerNow(): { should_speak: boolean; reason: string } {
    this.state = tickState(this.state)
    const decision = decidePush(this.state, this.settings)
    if (decision.should_speak) {
      const result = executePush(decision, this.state, this.deps)
      this.state = result.state
      savePushState(this.state)
    }
    return { should_speak: decision.should_speak, reason: decision.reason }
  }

  /** 获取当前状态（用于 UI 展示） */
  getState(): PushState {
    return tickState(this.state)
  }

  getSettings(): PushSettings {
    return this.settings
  }

  updateSettings(settings: Partial<PushSettings>): void {
    this.settings = { ...this.settings, ...settings }
    // 保存到磁盘
    const { savePushSettings } = require('./pushState')
    savePushSettings(this.settings)
  }

  private tick(): void {
    if (!this.running) return
    this.state = tickState(this.state)
    const decision = decidePush(this.state, this.settings)
    if (decision.should_speak) {
      const result = executePush(decision, this.state, this.deps)
      this.state = result.state
      savePushState(this.state)
    }
  }
}

/** 单例（主进程用） */
let _scheduler: PushScheduler | null = null
export function getPushScheduler(deps?: PushExecutorDeps): PushScheduler {
  if (!_scheduler) _scheduler = new PushScheduler(deps)
  return _scheduler
}
