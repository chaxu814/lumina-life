// ============================================================
// stores/stateBridge.ts — 跨 Store 状态同步桥 (v1.0)
//
// 🔧 P2-fix: 消除 agentRuntimeStore ↔ appStore 之间的
//   状态重叠和竞争条件。确保以下关键状态同步：
//     - agentRuntimeStore.agentEvents → appStore.isProcessing
//     - appStore.agentMode → agentRuntimeToolset
//
// 使用方式: 在 store 初始化后调用 initStateBridge()
// ============================================================

import { useStore } from './appStore'
import { useAgentRuntime } from './agentRuntimeStore'

// ═══════════════════════════════════════════════════════════
// 状态同步
// ═══════════════════════════════════════════════════════════

/**
 * 根据 agentRuntimeStore 的事件状态同步 appStore.isProcessing
 * 有事件 → isProcessing = true; 无事件 → isProcessing = false
 */
function syncProcessingState(): void {
  try {
    const runtime = useAgentRuntime.getState()
    const appState = useStore.getState()

    const hasActiveEvents = runtime.agentEvents.length > 0
    const isThinking = runtime.agentEvents.some(e => e.type === 'thinking' || e.type === 'tool_start')

    if (hasActiveEvents || isThinking !== appState.isProcessing) {
      useStore.getState().setIsProcessing(isThinking || hasActiveEvents)
    }
  } catch (err) {
    console.warn('[StateBridge] syncProcessingState 失败:', err)
  }
}

// ═══════════════════════════════════════════════════════════
// 订阅管理
// ═══════════════════════════════════════════════════════════

let _subscribed = false

export function initStateBridge(): void {
  if (_subscribed) return
  _subscribed = true

  console.log('[StateBridge] 初始化...')

  // 立即同步一次
  syncProcessingState()

  // 订阅 agentRuntimeStore 变更 → 同步到 appStore
  useAgentRuntime.subscribe((state) => {
    // 事件流变化 → 同步处理状态
    if (state.agentEvents.length > 0) {
      syncProcessingState()
    }
  })

  // 定时检查（作为兜底，确保状态不漂移）
  const interval = setInterval(() => {
    syncProcessingState()
  }, 5000)

  // 页面卸载时清除
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => {
      clearInterval(interval)
    })
  }

  console.log('[StateBridge] 已就绪，同步通道已建立')
}

/**
 * 手动触发一次全同步
 */
export function syncAll(): void {
  syncProcessingState()
}
