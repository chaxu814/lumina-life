// ============================================================
// ipc/teamIpc.ts — 团队/模式系统 IPC 处理器 (v5.0)
//
// v5.0: 从「三 Agent 团队 IPC」适配到「单 Agent 三模式」。
//   保留向后兼容的 IPC 接口，底层使用 ModeManager。
//   移除 agentPool 依赖。
// ============================================================

import { ipcMain } from 'electron'
import { getTeamManager } from '../agentTeamManager'
import { getSocialEngine } from '../agentSocialEngine'
import { getAgentMemory, initAgentMemory } from '../agentIndependentMemory'
import { getTeamProactive, initTeamProactive } from '../teamProactiveSystem'
import type { TeamConfig, DecisionProposal, AgentMode } from '../agentTeamTypes'
import { MODE_CONFIGS } from '../agentTeamPersonas'
import { globalEventBus, BusEvents } from '../eventBus'

export function registerTeamIpc(): void {
  // ── 初始化 ──────────────────────────────────────────
  const team = getTeamManager()
  const mem = initAgentMemory()
  const proactive = initTeamProactive()

  // ── 团队状态查询（v5.0: 适配 ModeManager） ──────────

  ipcMain.handle('team:getState', () => {
    const currentMode = team.currentMode
    const modeConfig = MODE_CONFIGS[currentMode]

    // 向后兼容：构造虚拟的 3-agent 状态（UI 层仍期望 3 个 agent）
    const agentModes: AgentMode[] = ['chat', 'code', 'analyze']
    const agents = agentModes.map(mode => {
      const mc = MODE_CONFIGS[mode]
      return {
        id: mode === 'chat' ? 'lumina' : mode === 'code' ? 'recha' : 'yak',
        name: mc.name,
        icon: mc.icon,
        archetype: mode === 'chat' ? 'companion' : mode === 'code' ? 'technician' : 'analyst',
        mood: mode === currentMode ? 'active' : 'idle',
        energy: mode === currentMode ? 100 : 50,
        isSpeaking: mode === currentMode,
        currentFocus: mode === currentMode ? '当前活跃模式' : null,
        dailyUserInteractions: 0,
        dailyAgentInteractions: 0,
        personality: mc.description,
        catchphrases: [],
        knowledgeDomains: [],
        knowledgeBlindSpots: [],
        speechStyle: mc.stylePrompt,
      }
    })

    return JSON.parse(JSON.stringify({
      agents,
      relationships: [],
      mood: team.state.mood,
      currentTopic: team.state.topicFocus,
      isDiscussing: false,
      dailyMessageCount: 0,
      eventLog: [],
      config: team.config,
      currentMode,
    }))
  })

  ipcMain.handle('team:getAgents', () => {
    const currentMode = team.currentMode
    const agentModes: AgentMode[] = ['chat', 'code', 'analyze']
    return agentModes.map(mode => {
      const mc = MODE_CONFIGS[mode]
      return {
        id: mode === 'chat' ? 'lumina' : mode === 'code' ? 'recha' : 'yak',
        name: mc.name,
        icon: mc.icon,
        archetype: mode === 'chat' ? 'companion' : mode === 'code' ? 'technician' : 'analyst',
        mood: mode === currentMode ? 'active' : 'idle',
        energy: mode === currentMode ? 100 : 50,
        isSpeaking: mode === currentMode,
      }
    })
  })

  ipcMain.handle('team:getRelationships', () => {
    return []  // v5.0: 无 Agent 间关系
  })

  ipcMain.handle('team:getConfig', () => {
    return team.config
  })

  // ── 配置更新 ────────────────────────────────────────

  ipcMain.handle('team:updateConfig', (_e, config: Partial<TeamConfig>) => {
    team.updateConfig(config)
    return { ok: true }
  })

  // ── Agent 独立记忆 ──────────────────────────────────

  ipcMain.handle('team:getAgentMemory', (_e, agentId: string, limit?: number) => {
    return mem.queryMemory(agentId, { limit: limit ?? 20 })
  })

  ipcMain.handle('team:getAgentSocialMemory', (_e, agentId: string, aboutAgentId: string) => {
    return mem.getSocialMemory(agentId, aboutAgentId)
  })

  // ── 决策讨论 ────────────────────────────────────────

  ipcMain.handle('team:triggerDecision', async (_e, params: { question: string; context: string; options: string[] }) => {
    const summary = await proactive.triggerTeamDecision(params.question, params.context, params.options)
    return { summary, votes: [] }
  })

  // ── 手动触发社交 ────────────────────────────────────

  ipcMain.handle('team:triggerSocial', async () => {
    const social = getSocialEngine()
    if (!social) return null
    const triggered = await social.trySpontaneousConversation()
    return triggered ? { ok: true } : null
  })

  // ── 获取讨论中的对话 ────────────────────────────────

  ipcMain.handle('team:getActiveDiscussion', () => {
    const social = getSocialEngine()
    if (!social) return null
    const ctx = social.getActiveConversation()
    if (!ctx) return null
    return {
      topic: ctx.topic,
      mode: ctx.mode,
      round: ctx.currentRound,
      maxRounds: ctx.maxRounds,
      participants: ctx.participants,
      history: ctx.history.slice(-10),
    }
  })

  // ── 团队状态摘要 ────────────────────────────────────

  ipcMain.handle('team:getStatusSummary', () => {
    return proactive.getTeamStatusSummary()
  })

  // ── v5.0: 模式切换 IPC ──────────────────────────────

  ipcMain.handle('team:setMode', (_e, mode: AgentMode) => {
    team.setMode(mode, 'user IPC')
    return { ok: true, mode }
  })

  ipcMain.handle('team:getMode', () => {
    return team.currentMode
  })

  // ── 事件转发到渲染进程 ──────────────────────────────

  const forwardToRenderer = (channel: string) => (payload: any) => {
    const { BrowserWindow } = require('electron')
    const wins = BrowserWindow.getAllWindows()
    for (const win of wins) {
      win.webContents.send(channel, payload)
    }
  }

  globalEventBus.on(BusEvents.AGENT_SOCIAL_MESSAGE, forwardToRenderer('team:socialMessage'))
  globalEventBus.on(BusEvents.AGENT_SPEAKING, forwardToRenderer('team:agentSpeaking'))
  globalEventBus.on(BusEvents.TEAM_DISCUSSION_STARTED, forwardToRenderer('team:discussionStarted'))
  globalEventBus.on(BusEvents.TEAM_DISCUSSION_ENDED, forwardToRenderer('team:discussionEnded'))
  globalEventBus.on(BusEvents.RELATIONSHIP_CHANGED, forwardToRenderer('team:relationshipChanged'))
  globalEventBus.on(BusEvents.TEAM_DECISION_COMPLETE, forwardToRenderer('team:decisionComplete'))
  globalEventBus.on(BusEvents.AGENT_MODE_CHANGED, forwardToRenderer('team:modeChanged'))

  // ─── 🧰 v1.0 工具箱: 实时语音对话 ─────────────────
  let realtimeVoiceActive = false

  ipcMain.handle('team:start-realtime-voice', async () => {
    try {
      if (realtimeVoiceActive) {
        return { success: false, message: '实时语音会话已在进行中' }
      }
      realtimeVoiceActive = true
      // 通知渲染进程进入实时语音模式
      forwardToRenderer('team:realtimeVoiceStarted')({})
      console.log('[TeamIPC] 实时语音对话已启动')
      return {
        success: true,
        message: '🎙️ 实时语音对话已启动，请开始说话。\n提示：团队 Agent 会听到你的声音并实时回复。',
      }
    } catch (err: any) {
      realtimeVoiceActive = false
      return { success: false, error: `启动实时语音失败: ${err.message}` }
    }
  })

  ipcMain.handle('team:stop-realtime-voice', async () => {
    try {
      if (!realtimeVoiceActive) {
        return { success: true, message: '实时语音已处于停止状态' }
      }
      realtimeVoiceActive = false
      console.log('[TeamIPC] 实时语音对话已停止')
      return { success: true }
    } catch (err: any) {
      return { success: false, error: `停止实时语音失败: ${err.message}` }
    }
  })

  ipcMain.handle('team:realtime-voice-status', async () => {
    return { active: realtimeVoiceActive }
  })

  // 停止实时语音（可从 main.ts 或渲染进程触发）
  globalEventBus.on(BusEvents.AGENT_MODE_CHANGED, (payload) => {
    if (payload && payload.to === 'chat') {
      realtimeVoiceActive = false
    }
  })

  // ─── 🧰 v1.0 工具箱: 同步角色配置 ────────────
  ipcMain.handle('team:sync-profiles', async (_event, profiles: Array<{
    id: string; name: string; icon: string; role: string; description: string
    systemPrompt: string; capabilities: string[]
  }>) => {
    try {
      // 将自定义角色配置存储到全局
      const { getTeamManager } = require('../agentTeamManager')
      const team = getTeamManager()
      // 存储到全局内存（供 agentTeamPersonas 读取）
      ;(global as any).__lumina_custom_profiles = profiles
      console.log(`[TeamIPC] 已同步 ${profiles.length} 个角色配置`)
      return { success: true, count: profiles.length }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  console.log('[TeamIPC] 团队 IPC 注册完成 (v5.0 模式架构)')
}

/**
 * 在 LLM 配置就绪后初始化社交引擎
 */
export function initTeamSocialEngine(
  llmCall: (personaId: string, prompt: string, context?: Record<string, unknown>) => Promise<string>,
  toolLlmCall?: (personaId: string, prompt: string, context?: Record<string, unknown>) => Promise<string>
): void {
  const social = getSocialEngine(llmCall, toolLlmCall)
  const team = getTeamManager()

  // v5.0: 不再需要 AgentPool 初始化
  console.log('[TeamIPC] 社交引擎已初始化（v5.0 无 AgentPool）')

  // 启动团队主动行为
  const proactive = getTeamProactive()
  proactive.start()

  console.log('[TeamIPC] 社交引擎已初始化并启动')
}
