// ============================================================
// stores/loopStore.ts — Loop 引擎的 UI 状态层 (Zustand)
//
// 对接 services/loopEngine.ts：
//   - 模块级单例引擎（create 初始化时即启动：读取持久化 + 开始触发检查）
//   - 把引擎任务状态镜像到 store，供 LoopPanel 等组件响应式订阅
//   - 暴露透传动作（confirm / pause / resume / stop / runCycle 等）
//
// 注意：本模块被 import 时即启动引擎。已在 main.tsx 顶部加入
// side-effect import，与应用同生命周期。
// ============================================================

import { create } from 'zustand'
import { LoopEngine } from '../services/loopEngine'
import type { LoopTask, LoopTrigger } from '../services/loopTypes'
import { useStore } from './appStore'
import { createLLMExecutor } from '../services/loopExecutor'
import { createElectronLoopPersistence } from '../services/loopPersist'

export interface LoopToast {
  id: string
  loopId: string
  goal: string
  runCount: number
  summary: string
  createdAt: number
}

export interface LoopStoreState {
  /** 所有 Loop 任务（镜像自引擎，已持久化） */
  tasks: LoopTask[]
  /** 当前选中（供面板定位） */
  selectedLoopId: string | null
  /** 已从持久化恢复 */
  hydrated: boolean
  /** 引擎实例 */
  engine: LoopEngine
  /** 待展示的 Toast 通知队列 */
  pendingToasts: LoopToast[]

  selectLoop: (id: string | null) => void
  dismissToast: (id: string) => void

  // ── 透传动作 ──
  createLoop: (goal: string, opts?: { agentId?: string; suggestedTriggers?: LoopTrigger[] }) => Promise<LoopTask | null>
  confirmLoop: (id: string) => Promise<void>
  pauseLoop: (id: string) => Promise<void>
  resumeLoop: (id: string) => Promise<void>
  stopLoop: (id: string) => Promise<void>
  removeLoop: (id: string) => Promise<void>
  runNow: (id: string) => Promise<void>
}

export const useLoopStore = create<LoopStoreState>()((set, get) => {
  // 模块级单例：引擎随 store 一起初始化并自启动
  const engine = new LoopEngine({
    persistence: createElectronLoopPersistence(),  // Phase 4: 磁盘持久化
    onChanged: (tasks) => set({ tasks, hydrated: true }),
    // 被动确认模式：Loop 每轮产出后，推 toast + 轻量提示
    onCycleComplete: (loop) => {
      try {
        const last = loop.outputs[loop.outputs.length - 1]
        const convId = useStore.getState().activeConversationId
        
        // 现有逻辑：推送到当前会话（聊天模式）
        if (convId && last) {
          useStore.getState().addMessage(convId, 'system',
            `📋 老板，「${loop.goal}」第 ${loop.runCount} 轮产出已出炉。输入「看看」展开详情。`)
        }
        
        // 🆕 新增：推送到团队群聊
        if (last) {
          const TEAM_CONV_ID = '__team_group_chat__'
          const teamMsg = {
            id: `loop-team-${Date.now()}`,
            from: 'system',
            fromIcon: '🔁',
            fromName: 'Loop 任务',
            content: `📋「${loop.goal}」第 ${loop.runCount} 轮产出：\n\n${last.content.slice(0, 300)}${last.content.length > 300 ? '…' : ''}`,
            time: new Date().toLocaleTimeString('zh-CN'),
          }
          // 通过 localStorage 持久化到团队群聊
          try {
            const existing = JSON.parse(localStorage.getItem(`lumina_gc_msgs_${TEAM_CONV_ID}`) || '[]')
            existing.push(teamMsg)
            localStorage.setItem(`lumina_gc_msgs_${TEAM_CONV_ID}`, JSON.stringify(existing))
            window.dispatchEvent(new CustomEvent('gc:message-added', { detail: teamMsg }))
          } catch {}
        }
        
        // Phase 4: 推送 Toast 通知
        const toast: LoopToast = {
          id: `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          loopId: loop.id,
          goal: loop.goal,
          runCount: loop.runCount,
          summary: last.content.slice(0, 80),
          createdAt: Date.now(),
        }
        set(s => ({ pendingToasts: [...s.pendingToasts, toast] }))
      } catch { /* 忽略（会话未就绪时） */ }
    },
  })

  // 注入真实 LLM 执行器（替代 Phase 1 的 mock）
  engine.setExecutor(createLLMExecutor(() => {
    try { return useStore.getState().llmConfig } catch { return undefined }
  }))

  void engine.init()

  return {
    tasks: [],
    selectedLoopId: null,
    hydrated: false,
    pendingToasts: [],
    engine,

    selectLoop: (id) => set({ selectedLoopId: id }),
    dismissToast: (id) => set(s => ({ pendingToasts: s.pendingToasts.filter(t => t.id !== id) })),

    confirmLoop: async (id) => { await engine.confirmLoop(id) },
    pauseLoop: async (id) => { await engine.pauseLoop(id) },
    resumeLoop: async (id) => { await engine.resumeLoop(id) },
    stopLoop: async (id) => { await engine.stopLoop(id) },
    removeLoop: async (id) => { await engine.removeLoop(id) },
    runNow: async (id) => { await engine.runCycle(id) },
    createLoop: async (goal, opts) => engine.createLoop(goal, opts),
  }
})
