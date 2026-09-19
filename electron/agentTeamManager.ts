// ============================================================
// agentTeamManager.ts — 模式管理器 (v5.0)
//
// v5.0: 从「多 Agent 团队管理」迁移到「单 Agent 模式管理」。
//   不再管理多个 Agent 实例，只负责模式检测和切换。
//   保留社交引擎所需的基本团队状态。
// ============================================================

import type { AgentMode, AgentState, TeamState, TeamConfig, TeamMood, ConversationMode } from './agentTeamTypes'
import { DEFAULT_TEAM_CONFIG } from './agentTeamTypes'
import { MODE_CONFIGS, detectMode } from './agentTeamPersonas'
import { globalEventBus, BusEvents } from './eventBus'
import { getTeamRegistry } from './core/teamRegistry'
import type { DynamicMemberRegistration } from './core/teamRegistry'
import { personalityConflictManager } from './gamification/personalityConflict'
// 🆕 v0.1.1: Agent 间动态关系（亲密度/信任/协作随真实互动演化，持久化）
import { getRelationshipStore } from './agentRelationships'
// 🆕 Lucky 模式情绪桥接
import { setCurrentMood } from './luckyModeIntegration'

// ═══════════════════════════════════════════════════════════
// 模式管理器
// ═══════════════════════════════════════════════════════════

export class ModeManager {
  private _currentMode: AgentMode = 'chat'
  private _teamConfig: TeamConfig = { ...DEFAULT_TEAM_CONFIG }
  private _teamState: TeamState = {
    active: true,
    mood: 'relaxed',
    conversationMode: 'casual_chat',
    topicFocus: null,
    silenceSince: null,
    lastHeardFrom: {},
  }

  // ── 模式管理 ──

  get currentMode(): AgentMode { return this._currentMode }

  /** 手动切换模式 */
  setMode(mode: AgentMode, reason: string = 'manual'): void {
    const from = this._currentMode
    if (from === mode) {return}
    this._currentMode = mode
    globalEventBus.emit(BusEvents.AGENT_MODE_CHANGED, { from, to: mode, reason, triggeredBy: 'user' })
    // 触发副人格觉醒
    personalityConflictManager.onModeChanged(from, mode)
  }

  /** 自动检测并切换模式（基于用户输入） */
  detectAndSwitch(userInput: string): AgentMode {
    const detected = detectMode(userInput)
    if (detected && detected !== this._currentMode) {
      const from = this._currentMode
      this._currentMode = detected
      globalEventBus.emit(BusEvents.AGENT_MODE_CHANGED, {
        from, to: detected,
        reason: `检测到意图: "${userInput.slice(0, 50)}"`,
        triggeredBy: 'auto',
      })
      // 触发副人格觉醒
      personalityConflictManager.triggerConflict(from, detected, userInput)
    }
    return this._currentMode
  }

  /** 获取当前模式的配置 */
  getCurrentModeConfig() {
    return MODE_CONFIGS[this._currentMode]
  }

  // ── 团队配置（社交引擎用） ──

  get config(): TeamConfig { return this._teamConfig }
  /** v5.0 compat: 旧方法名，与 getter 等效 */
  getConfig(): TeamConfig { return this._teamConfig }
  updateConfig(partial: Partial<TeamConfig>) {
    Object.assign(this._teamConfig, partial)
  }

  // ── 团队状态（社交引擎用） ──

  get state(): TeamState { return this._teamState }
  /** v5.0 compat: 旧方法名 */
  getTeamState(): TeamState { return this._teamState }
  setMood(mood: TeamMood) {
    this._teamState.mood = mood
    // 🆕 Lucky: 同步情绪到 Lucky 模式集成
    setCurrentMood(mood)
    // 🆕 Lucky: 广播情绪变化事件
    globalEventBus.emit('agent:mood_changed', { mood, intensity: 0.5 })
  }
  setConversationMode(mode: ConversationMode) { this._teamState.conversationMode = mode }
  setTopicFocus(topic: string | null) { this._teamState.topicFocus = topic }
  updateLastHeardFrom(agentId: string) {
    this._teamState.lastHeardFrom[agentId] = new Date().toISOString()
    this._teamState.silenceSince = null
  }

  // ── v5.0 compat: 心跳 ──

  userHeartbeat(): void {
    // 保持团队活跃状态
    this._teamState.active = true
    this._teamState.silenceSince = null
  }

  /** v5.0 compat: 精力衰减 tick — teamProactiveSystem 每分钟调用 */
  tick(): void {
    this._teamState.active = true
    // 副人格觉醒定时检查
    personalityConflictManager.tick()
  }

  // ── 动态团队注册 ──

  /** 注册动态团队成员 */
  registerTeamMember(reg: DynamicMemberRegistration): boolean {
    const ok = getTeamRegistry().register(reg)
    if (ok) {
      globalEventBus.emit(BusEvents.AGENT_MODE_CHANGED as any, {
        from: 'unknown', to: this._currentMode,
        reason: `新成员注册: ${reg.name} (${reg.id})`,
        triggeredBy: 'system',
      })
    }
    return ok
  }

  /** 移除动态团队成员 */
  unregisterTeamMember(id: string): boolean {
    return getTeamRegistry().unregister(id)
  }

  /** 列出所有成员（内置+动态） */
  listTeamMembers() {
    return getTeamRegistry().getAllMembers()
  }

  // ── Agent 状态（兼容旧调用） ──

  getAgentState(agentId: string): Record<string, any> | null {
    // v5.0: 所有模式都是同一个 Lumina，返回兼容旧格式
    const config = MODE_CONFIGS[this._currentMode]
    return {
      id: agentId || 'lumina',
      name: config.name,
      online: true,
      currentMood: this._teamState.mood,
      currentTone: 'warm',
      busyLevel: 0,
      lastSpokeAt: new Date().toISOString(),
      currentTask: null,
      // v5.0 compat fields for teamProactiveSystem
      mood: this._teamState.mood,
      energy: 100,
      dailyUserInteractions: 0,
      persona: {
        id: agentId,
        name: config.name,
        icon: config.icon,
        archetype: 'companion' as const,
        personality: config.description,
        defaultTone: 'warm' as const,
        currentTone: 'warm' as const,
        knowledgeDomains: ['life', 'entertainment', 'emotion'] as any[],
        knowledgeBlindSpots: ['deep_code', 'complex_data'] as any[],
        speechStyle: config.stylePrompt,
        catchphrases: [] as string[],
        systemPrompt: '',
        allowedTools: [] as string[],
        visible: config.visible,
        isPrimary: agentId === 'lumina',
        ttsVoice: config.ttsVoice,
        createdAt: '2025-01-01',
        activityLevel: 5,
        memoryContext: '',
        lastActive: new Date().toISOString(),
      },
    }
  }

  /** v5.0 compat: 返回所有 Agent（旧格式），供 teamProactiveSystem 使用 */
  getAllAgents(): Array<ReturnType<typeof this.getAgentState>> {
    const builtIn = [
      this.getAgentState('lumina'),
      this.getAgentState('recha'),
      this.getAgentState('yak'),
    ]
    // 追加动态成员
    const dynamic = getTeamRegistry().getDynamicMembers().map(m => this.getAgentState(m.id))
    return [...builtIn, ...dynamic]
  }

  /** v5.0 compat: 返回所有关系（旧格式），供 teamProactiveSystem 使用。
   * v0.1.1 起改为读取动态关系存储：委托/群聊等真实互动会改变亲密度、信任、协作数，
   * 并持久化到 userData/lumina-relationships.json；首次启动以出厂基线播种。 */
  getAllRelationships(): Array<{ pairKey: string; agentA: string; agentB: string; type: string; affinity: number; trust: number; argumentCount: number; collaborationCount: number; lastInteraction: string; evolutionLog: string[] }> {
    return getRelationshipStore().getAll()
  }
}

// ═══════════════════════════════════════════════════════════
// 单例（垫片 → 委派给 AgentOrchestrator）
// ═══════════════════════════════════════════════════════════

let _instance: ModeManager | null = null

export function getTeamManager(): ModeManager {
  // 优先从 orchestrator 返回
  try {
    const { getOrchestrator } = require('./core/agentOrchestrator')
    const orch = getOrchestrator()
    if (orch.modeManager) {return orch.modeManager}
  } catch {}
  if (!_instance) {_instance = new ModeManager()}
  return _instance
}

/** v5.0: 别名 — 向后兼容 */
export { getTeamManager as getModeManager }
