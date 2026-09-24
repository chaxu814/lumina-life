// ============================================================
// pushExecutor.ts — 主动推送执行器
// 只走桌宠气泡 + 侧边栏消息，不弹系统打断式通知
// ============================================================

import type { PushDecision } from './pushDecider'
import type { PushState } from './pushState'
import { recordPush } from './pushState'

export interface PushExecutorDeps {
  /** 桌宠窗口显示气泡 */
  showPetBubble?: (text: string) => void
  /** 向聊天面板/侧边栏追加一条 Lumina 主动消息 */
  appendSidebarMessage?: (text: string, type: string) => void
  /** 记录推送日志 */
  log?: (msg: string) => void
}

export interface PushResult {
  delivered: boolean
  state: PushState
  timestamp: number
}

/**
 * 执行一次推送决策
 * - should_speak=false 时不执行
 * - 只走桌宠气泡 + 侧边栏，绝不调用系统 Notification
 */
export function executePush(
  decision: PushDecision,
  state: PushState,
  deps: PushExecutorDeps = {},
  now = Date.now(),
): PushResult {
  if (!decision.should_speak) {
    return { delivered: false, state, timestamp: now }
  }

  // 桌宠气泡
  if (deps.showPetBubble) {
    try { deps.showPetBubble(decision.speech) } catch { /* ignore */ }
  }

  // 侧边栏消息
  if (deps.appendSidebarMessage) {
    try { deps.appendSidebarMessage(decision.speech, decision.type) } catch { /* ignore */ }
  }

  if (deps.log) {
    deps.log(`[push] ${decision.type}/${decision.intensity}: ${decision.speech}`)
  }

  return {
    delivered: true,
    state: recordPush(state, now),
    timestamp: now,
  }
}
