// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// llmCoordinator.ts — 智能 LLM 调用协调器
//
// 解决问题：5 路独立后台 LLM 调用互相竞争，浪费 token
// 当用户正在活跃对话时自动暂停后台任务，
// 用户空闲后再恢复，形成智能优先级管理。
//
// 设计：
//   - 优先级: MainAgent > Proactive > Social > Memory > Moments
//   - 用户活跃期（最后交互 < 30s）→ 暂停低优先级任务
//   - 用户空闲期 → 逐级恢复
// ============================================================

const DEFAULT_COOLDOWN = 30_000 // 30 秒冷却

export interface LLMRequestToken {
  /** 请求者标识 */
  source: string
  /** 优先级: 0=最高(用户交互) 1=高(主动对话) 2=中(社交) 3=低(记忆) 4=最低(朋友圈) */
  priority: number
}

class LLMCoordinator {
  private lastUserInteraction = 0
  private runningRequests: Map<string, LLMRequestToken> = new Map()
  private cooldownMs = DEFAULT_COOLDOWN
  private pausedSources: Set<string> = new Set()

  /** 标记用户活跃（发送消息时调用） */
  markUserActive(): void {
    this.lastUserInteraction = Date.now()

    // 暂停所有后台任务，让主 Agent 独占资源
    this.pausedSources.clear()
    this.runningRequests.forEach((token, source) => {
      if (token.priority > 0) {
        this.pausedSources.add(source)
      }
    })
  }

  /** 用户是否处于活跃期（最近 N 秒内有交互） */
  get isUserActive(): boolean {
    return Date.now() - this.lastUserInteraction < this.cooldownMs
  }

  /** 设置冷却时间 */
  setCooldown(ms: number): void {
    this.cooldownMs = ms
  }

  /**
   * 请求 LLM 调用许可
   * @returns true = 允许调用，false = 当前应延迟
   */
  requestPermission(source: string, priority: number): boolean {
    // 清理过期记录
    if (Date.now() - this.lastUserInteraction >= this.cooldownMs) {
      // 用户已空闲，恢复所有
      this.pausedSources.clear()
    }

    // 如果该 source 被暂停
    if (this.pausedSources.has(source)) {
      return false
    }

    // 如果用户活跃且请求优先级 > 0（非用户交互）
    if (this.isUserActive && priority > 0) {
      // 低优先级任务在用户活跃期自动延迟
      this.pausedSources.add(source)
      console.log(
        `[LLMCoordinator] ⏸  暂停 "${source}" (用户活跃中，还剩 ${Math.round((this.cooldownMs - (Date.now() - this.lastUserInteraction)) / 1000)}s)`
      )
      return false
    }

    this.runningRequests.set(source, { source, priority })
    return true
  }

  /** 请求完成，释放许可 */
  releasePermission(source: string): void {
    this.runningRequests.delete(source)
  }

  /**
   * 等待 LLM 调用许可（异步轮询）
   * 在用户活跃期自动等待，用户空闲后自动放行
   */
  async waitForPermission(source: string, priority: number, maxWaitMs: number = 120_000): Promise<boolean> {
    if (this.requestPermission(source, priority)) {
      return true
    }

    const startTime = Date.now()
    const pollInterval = 1000

    return new Promise((resolve) => {
      const check = setInterval(() => {
        if (this.requestPermission(source, priority)) {
          clearInterval(check)
          resolve(true)
          return
        }
        if (Date.now() - startTime > maxWaitMs) {
          clearInterval(check)
          console.log(`[LLMCoordinator] ⚠️ "${source}" 等待超时 (${maxWaitMs}ms)，强制放行`)
          this.pausedSources.delete(source)
          resolve(true)
        }
      }, pollInterval)
    })
  }

  /** 获取当前状态（用于调试/UI） */
  getStatus(): {
    userActive: boolean
    pausedSources: string[]
    runningSources: string[]
    cooldownRemaining: number
  } {
    return {
      userActive: this.isUserActive,
      pausedSources: [...this.pausedSources],
      runningSources: [...this.runningRequests.keys()],
      cooldownRemaining: this.isUserActive
        ? Math.round((this.cooldownMs - (Date.now() - this.lastUserInteraction)) / 1000)
        : 0,
    }
  }
}

/** 全局单例 */
export const llmCoordinator = new LLMCoordinator()

// 优先级常量
export const PRIORITY = {
  USER_INTERACTION: 0,
  PROACTIVE: 1,
  SOCIAL: 2,
  MEMORY: 3,
  MOMENTS: 4,
} as const
