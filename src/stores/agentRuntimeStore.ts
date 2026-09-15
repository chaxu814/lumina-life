// ============================================================
// agentRuntimeStore.ts — Agent 运行时状态（非持久化）
//
// 解决问题：ChatPanel 子视图卸载/重载时 agentEvents 丢失
// 导致"切面板回来后看不到过程动画"。
//
// 设计：所有 Agent 运行时事件都写入此 store，
// 任何 Component 都能实时读取，不受组件生命周期影响。
// ============================================================

import { create } from 'zustand'

export interface AgentEvent {
  type: string           // 'thinking' | 'tool_start' | 'tool_end' | 'tool_error' | 'text' | 'token_update' | 'memory_summary' | 'thinking_stream'
  text?: string
  tool?: string
  args?: unknown
  result?: unknown
  timestamp?: number
  // thinking_stream 事件字段
  isFirst?: boolean
  isLast?: boolean
  // token_update 事件字段
  totalTokens?: number
  usage?: any
  delta?: number
}

export interface AgentRuntimeState {
  // ── 事件流（最新事件实时叠加） ──
  agentEvents: AgentEvent[]
  setAgentEvents: (events: AgentEvent[]) => void
  clearAgentEvents: () => void

  // ── 流式文本（LLM 生成中的实时内容） ──
  streamingContent: string
  setStreamingContent: (content: string) => void

  // ── 最后一条 thinking 事件（用于显示"正在思考什么"） ──
  lastThinking: string
  setLastThinking: (text: string) => void

  // ── 工具链追踪 ──
  toolTraces: Array<{ name: string; status: 'running' | 'done' | 'error' }>
  addToolTrace: (name: string, status: 'running' | 'done' | 'error') => void
  clearToolTraces: () => void

  // ── 🆕 上下文用量（实时显示在输入栏） ──
  contextUsage: { promptTokens: number; contextWindow: number; updatedAt: number }
  setContextUsage: (promptTokens: number, contextWindow: number) => void

  // ── 重置全部 ──
  resetAgentRuntime: () => void
}

export const useAgentRuntime = create<AgentRuntimeState>()((set) => ({
  agentEvents: [],
  setAgentEvents: (events) => set({ agentEvents: [...events] }),
  clearAgentEvents: () => set({ agentEvents: [] }),

  streamingContent: '',
  setStreamingContent: (content) => set({ streamingContent: content }),

  lastThinking: '',
  setLastThinking: (text) => set({ lastThinking: text }),

  toolTraces: [],
  addToolTrace: (name, status) => set((s) => {
    const existing = s.toolTraces.findIndex(t => t.name === name)
    if (existing >= 0) {
      const updated = [...s.toolTraces]
      updated[existing] = { name, status }
      return { toolTraces: updated }
    }
    return { toolTraces: [...s.toolTraces, { name, status }] }
  }),
  clearToolTraces: () => set({ toolTraces: [] }),

  // 🆕 上下文用量
  contextUsage: { promptTokens: 0, contextWindow: 0, updatedAt: 0 },
  setContextUsage: (promptTokens, contextWindow) => set({
    contextUsage: { promptTokens, contextWindow, updatedAt: Date.now() },
  }),

  resetAgentRuntime: () => set({
    agentEvents: [],
    streamingContent: '',
    lastThinking: '',
    toolTraces: [],
    // 不重置 contextUsage — 对话结束后仍显示上次用量
  }),
}))
