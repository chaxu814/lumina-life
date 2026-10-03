// ============================================================
// pushExecutor.ts — 主动推送执行器
//
// 升级说明（v1.1）：
//   旧版「只走桌宠气泡 + 侧边栏，绝不调用系统 Notification」。
//   现在**可选**升级为系统弹窗，但保持默认克制：
//     - 不传 notifySystem → 行为与旧版完全一致（零弹窗）
//     - 传了 notifySystem → 仅当 intensity 达到 escalateAt 才弹
//     - 系统弹窗自身还要过 systemNotifier 的分级/限流/权限/聚焦判定
//   也就是说：默认不打扰，升级也不会造成通知风暴。
// ============================================================

import type { PushDecision } from './pushDecider'
import type { PushState } from './pushState'
import { recordPush } from './pushState'

export type PushIntensity = 'low' | 'medium' | 'high'

export interface PushExecutorDeps {
  /** 桌宠窗口显示气泡 */
  showPetBubble?: (text: string) => void
  /** 向聊天面板/侧边栏追加一条 Lumina 主动消息 */
  appendSidebarMessage?: (text: string, type: string) => void
  /** 记录推送日志 */
  log?: (msg: string) => void
  /**
   * 系统弹窗出口（v1.1 新增，可选）。
   * 不传 = 保持旧版「绝不弹系统通知」的行为。
   * 建议注入 systemNotifier.notify 的适配函数，由它再做一遍权限/聚焦/限流判定。
   */
  notifySystem?: (title: string, body: string, category: string) => void
  /** 达到该强度及以上才升级为系统弹窗（默认 'high'，即只有高强度才弹） */
  escalateAt?: PushIntensity
}

export interface PushResult {
  delivered: boolean
  /** 是否触发了系统弹窗（false 不代表失败，只是没弹） */
  notifiedSystem: boolean
  state: PushState
  timestamp: number
}

const INTENSITY_RANK: Record<PushIntensity, number> = { low: 0, medium: 1, high: 2 }

/**
 * 执行一次推送决策
 * - should_speak=false 时不执行
 * - 气泡 + 侧边栏始终执行（保持原有克制行为）
 * - 系统弹窗仅在注入 notifySystem 且强度达标时**尝试**执行，且任何异常都被吞掉
 */
export function executePush(
  decision: PushDecision,
  state: PushState,
  deps: PushExecutorDeps = {},
  now = Date.now(),
): PushResult {
  if (!decision.should_speak) {
    return { delivered: false, notifiedSystem: false, state, timestamp: now }
  }

  // 桌宠气泡
  if (deps.showPetBubble) {
    try { deps.showPetBubble(decision.speech) } catch { /* ignore */ }
  }

  // 侧边栏消息
  if (deps.appendSidebarMessage) {
    try { deps.appendSidebarMessage(decision.speech, decision.type) } catch { /* ignore */ }
  }

  // ── 系统弹窗（可选升级路径） ──
  let notifiedSystem = false
  const threshold = deps.escalateAt ?? 'high'
  if (
    deps.notifySystem &&
    INTENSITY_RANK[decision.intensity] >= INTENSITY_RANK[threshold]
  ) {
    try {
      deps.notifySystem(`Lumina 主动提醒 · ${decision.type}`, decision.speech, decision.type)
      notifiedSystem = true
    } catch {
      // 通知失败绝不影响气泡/侧边栏的正常投递
      notifiedSystem = false
    }
  }

  if (deps.log) {
    deps.log(
      `[push] ${decision.type}/${decision.intensity}: ${decision.speech}` +
      (notifiedSystem ? ' (+system)' : ''),
    )
  }

  return {
    delivered: true,
    notifiedSystem,
    state: recordPush(state, now),
    timestamp: now,
  }
}
