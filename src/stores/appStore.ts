// ============================================================
// Lumina Life 1.0 — Zustand Store + 持久化
// ============================================================

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { showToast } from '../components/Toast'  // 🆕 Lucky 场景感知 Toast

export type PanelType = "chat" | "mail" | "settings" | "agent" | "security" | "skills" | "usage" | "diagnostics" | "tasks" | "bridge" | "profile" | "bookmarks" | "knowledge" | "skillmarket" | "deepresearch" | "dream" | "reality" | "skilldev" | "social" | "familytree" | "testcoverage" | "news" | "team" | "memory" | "emotions" | "plugins" | "more" | "teamcommunity" | "sandbox"

export interface ChatMessage {
  id: string; role: 'user' | 'assistant' | 'system'; content: string; timestamp: number
}

export interface Conversation {
  id: string; name: string; messages: ChatMessage[]; createdAt: number; modelName?: string; pinned?: boolean
  /** 所属角色 ID — 用于 Lumina Agent 多角色对话隔离 */
  roleId?: string
  /** 🔧 P1: 压缩上下文（用于跨轮次恢复） */
  compactedContext?: string
}

export interface LLMConfig {
  /** 供应商 ID（统一使用短 ID: 'deepseek' | 'qwen' | 'openai' | 'zhipu' | 'siliconflow' | 'lmstudio' | 'custom'） */
  provider: string; baseUrl: string; apiKey: string; model: string; temperature: number; maxTokens: number
  /** 上下文窗口大小 (0=自动检测) */
  contextWindow: number
}

export interface TTSConfig {
  voice: string; speed: number; volume: number
  engine?: 'edge-tts' | 'gpt-sovits' | 'indextts'
  enabled?: boolean
  indextts?: {
    port: number
    refAudioPath: string
    lang: 'ZH' | 'EN' | 'JA' | 'ES' | 'AR'
    emotion: string
    durationFactor: number
  }
}

export interface AgentPersona {
  id: string; name: string; desc: string; icon: string; systemPrompt: string
}

export interface AgentConfig {
  name: string; persona: string; tools: string[]; systemPrompt: string
  customPersonas: AgentPersona[]
  /** 记住上次选择的 Agent 角色 ID，有值时进入 Lumina Agent 不再弹选择器 */
  lastRole?: string
}

export interface SecurityConfig {
  safeMode: boolean; allowedApps: string[]; requireConfirm: boolean; rules: string[]
  /** 🆕 v2.0: 沙箱模式 — ON=SMART(中风险需审批) OFF=AUTO(仅高风险需审批) */
  sandboxMode: boolean
}

export interface SkillConfig {
  enabled: string[]
}

/** 技能 ID → 对应工具名映射（v2.5: 技能开关真正控制工具可用性） */
export const SKILL_TO_TOOLS: Record<string, string[]> = {
  weather:    ['weather'],
  search:     ['web_search_multi', 'web_fetch', 'web_search', 'browser_click_smart'],
  browser:    ['browser'],
  memory:     ['memory_save', 'memory_get', 'memory_all', 'memory_summarize', 'memory_search'],
  news:       ['web_search_multi', 'web_fetch'],
  stock:      [],
  translate:  [],
  code:       ['code_review_smart', 'shell_exec', 'file_search_smart'],
  notify:     ['notification'],
  timer:      ['cron_schedule', 'cron_list', 'cron_cancel'],
  image:      ['screenshot', 'ocr'],
  audio:      ['hearing_start', 'hearing_stop', 'hearing_status', 'hearing_transcript'],
  files:      ['file_read', 'file_write', 'file_edit', 'file_list'],
  desktop:    ['desktop_click', 'desktop_type', 'desktop_key', 'desktop_screen_size'],
  proactive:  ['proactive_status', 'proactive_trigger'],
}

/** 根据当前 skillConfig.enabled 返回禁用的工具名列表 */
export function getDisabledToolNames(skillConfig: SkillConfig): string[] {
  const disabled: string[] = []
  for (const [skillId, tools] of Object.entries(SKILL_TO_TOOLS)) {
    if (!skillConfig.enabled.includes(skillId)) {
      disabled.push(...tools)
    }
  }
  return disabled
}

export interface BridgeConfig {
  discord: { enabled: boolean; token: string }
  wechat: { enabled: boolean; token: string }
  telegram: { enabled: boolean; token: string }
  feishu: { enabled: boolean; token: string }
}

export interface TokenUsage {
  total: number; today: number; limit: number
  lastResetDate: string       // 🆕 v5.3: YYYY-MM-DD 上次重置日
  byModel: { model: string; tokens: number }[]
  byAgent: { agentId: string; tokens: number }[]  // 🆕 v5.3: 按 Agent 统计
  history: { date: string; tokens: number; model: string }[]
}

export interface CronTask {
  id: string; name: string; schedule: string; action: string; enabled: boolean
  lastRun?: string; nextRun?: string; type: 'cron' | 'once'
}

export interface UserProfile {
  avatar: string       // base64 data URL
  nickname: string
  gender: 'male' | 'female' | 'other' | 'secret'
  tags: string[]
  birthday: string     // ISO date string
  bubbleColorUser: string    // v2.14: 用户气泡颜色
  bubbleColorAgent: string   // v2.14: Agent气泡颜色
}

export interface AuditLog {
  id: string; time: string; action: string; type: 'llm' | 'tts' | 'skill' | 'security' | 'system' | 'agent' | 'tool'
}

/** ♿ 无障碍设置（创新提案 7：无障碍语音交互） */
export interface A11yConfig {
  /** PTT 全局快捷键（Electron accelerator），默认 Ctrl+Space */
  pttShortcut: string
  /** 语音交互闭环总开关 */
  voiceLoopEnabled: boolean
  /** 高对比度模式（WCAG AAA ≥7:1） */
  highContrast: boolean
  /** 字号缩放 1 / 1.25 / 1.5 */
  fontScale: 1 | 1.25 | 1.5
  /** 唤醒词开关（预留 Porcupine 接入） */
  wakeWordEnabled: boolean
}

// ═══ Memory v2 (Hermes 双层) ═══
export interface MemoryUserProfile { name?: string; preferences: string[]; habits: string[]; communicationStyle: string; personality: string }
export interface MemoryConfig { systemInfo: string[]; toolExperience: string[]; projectConventions: string[]; lessons: string[]; paths: Record<string, string> }
export interface StructuredMemory { user: MemoryUserProfile; memory: MemoryConfig }

// ═══ Agent 执行状态 ═══
export type AgentMode = 'chat' | 'agent' | 'developer' | 'worker'
export interface ToolTrace { timestamp: number; name: string; args: Record<string, any>; result?: { ok: boolean; content: string; durationMs?: number }; status: 'running' | 'done' | 'error' }

// ============================================================

interface AppStore {
  activePanel: PanelType
  setActivePanel: (p: PanelType) => void

  conversations: Conversation[]
  activeConversationId: string
  createConversation: (name?: string, roleId?: string) => void
  deleteConversation: (id: string) => void
  switchConversation: (id: string) => void
  updateConversation: (id: string, updates: Partial<Conversation>) => void
  renameConversation: (id: string, name: string) => void
  togglePinConversation: (id: string) => void
  addMessage: (convId: string, role: ChatMessage['role'], content: string) => void
  clearCurrentMessages: () => void
  deleteMessage: (convId: string, msgId: string) => void

  isProcessing: boolean
  setIsProcessing: (v: boolean) => void

  llmOnline: boolean
  llmChecked: boolean
  setLlmOnline: (v: boolean) => void
  setLlmChecked: (v: boolean) => void

  llmConfig: LLMConfig
  setLLMConfig: (c: Partial<LLMConfig>) => void

  /** 每个供应商独立保存的完整配置（含 apiKey、温度等） */
  providerConfigs: Record<string, LLMConfig>
  /** 切换供应商：自动保存当前配置 → 恢复目标供应商的配置 */
  switchLLMProvider: (providerId: string, defaultBaseUrl: string, defaultModel: string) => void

  /** 🆕 v10.8: Per-Agent 独立 LLM 配置（从 agent-llm-configs.json 加载） */
  agentLlmConfigs: Record<string, { enabled?: boolean; provider?: string; model?: string; endpoint?: string; apiKey?: string; timeout?: number }>
  /** 加载所有 per-agent 配置 */
  loadAgentLlmConfigs: () => Promise<void>
  /** 获取指定 agent 的有效 LLM 配置（per-agent 优先，fallback 到全局） */
  getAgentLlmConfig: (agentId: string) => LLMConfig

  /** 🔄 v10.0: 从后端 ProviderManager 同步配置 */
  syncProviderFromBackend: () => Promise<void>

  ttsConfig: TTSConfig
  setTTSConfig: (c: Partial<TTSConfig>) => void

  ttsMuted: boolean
  setTTSMuted: (v: boolean) => void
  ttsToggle: () => void
  ttsEngine: string  // 🔧 TTS 引擎选择（edge/azure/openai）
  setTTSEngine: (engine: string) => void

  agentConfig: AgentConfig
  setAgentConfig: (c: Partial<AgentConfig>) => void
  activePersona: string
  setActivePersona: (id: string) => void
  addCustomPersona: (p: AgentPersona) => void
  removeCustomPersona: (id: string) => void

  securityConfig: SecurityConfig
  setSecurityConfig: (c: Partial<SecurityConfig>) => void

  skillConfig: SkillConfig
  setSkillConfig: (c: Partial<SkillConfig>) => void

  bridgeConfig: BridgeConfig
  setBridgeConfig: (c: Partial<BridgeConfig>) => void

  tokenUsage: TokenUsage
  addTokenUsage: (model: string, tokens: number, agentId?: string) => void
  setTokenLimit: (limit: number) => void
  resetDailyTokens: () => void
  removeHistoryEntry: (index: number) => void
  clearTokenHistory: () => void

  cronTasks: CronTask[]
  addCronTask: (t: CronTask) => void
  removeCronTask: (id: string) => void
  toggleCronTask: (id: string) => void

  auditLogs: AuditLog[]
  addAuditLog: (log: Omit<AuditLog, 'id'>) => void

  // 沙箱配置
  sandboxConfig: {
    defaultRoot: string
    agents: Record<string, { sandboxDir: string; enabled: boolean }>
    authorizedDirs: Array<{ id: string; path: string; label: string; authorizedAt: number; tools: string[]; agentIds: string[] }>
  }
  setSandboxConfig: (c: any) => void

  // ═══ Memory v2 (Hermes 双层) ═══
  structuredMemory: StructuredMemory
  setStructuredMemory: (m: Partial<StructuredMemory>) => void
  memoryProfileText: string
  setMemoryProfileText: (t: string) => void

  // ═══ Agent v2 ═══
  agentMode: AgentMode
  setAgentMode: (m: AgentMode) => void
  toolTraces: ToolTrace[]
  addToolTrace: (t: ToolTrace) => void
  updateToolTrace: (name: string, status: 'done' | 'error', result?: ToolTrace['result']) => void
  clearToolTraces: () => void
  // ═══ 个性化 ═══
  profile: UserProfile
  setProfile: (p: Partial<UserProfile>) => void

  // ═══ v2.6 团队 ═══
  teamState: TeamAppState
  setTeamState: (t: Partial<TeamAppState>) => void

  // 首次运行引导
  firstRun: boolean
  completeOnboarding: () => void

  // 主题切换
  theme: 'light' | 'dark' | 'system'
  setTheme: (t: 'light' | 'dark' | 'system') => void

  // 🆕 简约模式（紧凑 UI）
  compactMode: boolean
  setCompactMode: (v: boolean) => void

  // ♿ 无障碍设置
  a11y: A11yConfig
  setA11y: (patch: Partial<A11yConfig>) => void

  // 是否显示实验功能（梦境 / 真人秀等实验彩蛋）
  showExperimental: boolean
  setShowExperimental: (v: boolean) => void

  // Profile 面板默认 Tab（⭐ 徽章点击时设为 'achievements'）
  profileTab: 'profile' | 'achievements'
  setProfileTab: (t: 'profile' | 'achievements') => void

  // 游戏化
  gamification: GamificationState
  setGamification: (g: Partial<GamificationState>) => void

  // 第二阶段: 场景模式
  luminaMode: LuminaModeState
  setLuminaMode: (m: Partial<LuminaModeState>) => void
  initializeModeListeners: () => () => void
}

/** 🆕 v2.0 场景模式前端状态 */
export type LuminaMode = 'work' | 'study' | 'fun' | 'idle'

export interface LuminaModeConfig {
  label: string
  emoji: string
  agentTone: string
  proactiveInterval: number
  proactiveEnabled: boolean
  newsEnabled: boolean
  temperature: number
  color: string
}

export interface SceneInfo {
  scene: LuminaMode
  confidence: number
  windowTitle: string
  processName: string
  detectedAt: number
  reason: string
}

export interface LuminaModeState {
  current: LuminaMode
  config: LuminaModeConfig
  allConfigs?: Record<LuminaMode, LuminaModeConfig>  // 🆕 v3.0: 所有模式配置
  manualOverride: boolean
  lastScene: SceneInfo | null
  lastSwitchAt: number
}

/** 🆕 v2.6 团队系统前端状态 */
export interface TeamAppState {
  agents: TeamAppAgent[]
  relationships: TeamAppRelationship[]
  mood: string
  currentTopic: string
  isDiscussing: boolean
  dailyMessageCount: number
  eventLog: TeamAppEvent[]
}

export interface TeamAppAgent {
  id: string
  name: string
  icon: string
  archetype: string
  mood: string
  energy: number
  isSpeaking: boolean
  currentFocus: string
  personality: string
  catchphrases: string[]
  knowledgeDomains: string[]
  knowledgeBlindSpots: string[]
  speechStyle: string
}

export interface TeamAppRelationship {
  pairKey: string
  agentA: string
  agentB: string
  type: string
  affinity: number
  trust: number
  lastInteraction: string
}

export interface TeamAppEvent {
  id: string
  type: string
  participants: string[]
  summary: string
  timestamp: number
}

// ═══ 🆕 v3.0 游戏化 ═══
export interface GamificationState {
  level: number
  totalXp: number
  todayXp: number
  title: string
  /** 0~1 当前等级进度 */
  progress: number
  unlockedAchievements: string[]
  /** 最近解锁的成就（用于弹窗动画） */
  lastUnlockedAchievement: string | null
}

const welcomeMsg: ChatMessage = {
  id: 'welcome', role: 'assistant',
  content: '✨ 你好！我是 Lumina Life 1.0（正式版），你的 AI 桌面伙伴。\n\n请先在 ⚙️ 设置 中配置 LLM 和 TTS，然后开始对话！',
  timestamp: Date.now(),
}

const defaultConversation: Conversation = {
  id: 'conv-default', name: '默认对话', messages: [welcomeMsg], createdAt: Date.now(),
}

const defaultTasks: CronTask[] = [
  { id: 'default-news', name: '每日新闻摘要', schedule: '0 8 * * *', action: '获取当日AI/科技新闻并生成摘要推送', enabled: true, type: 'cron', nextRun: '明日 08:00' },
  { id: 'default-weather', name: '天气提醒', schedule: '0 7 * * *', action: '获取当地天气并推送提醒', enabled: true, type: 'cron', nextRun: '明日 07:00' },
  { id: 'default-report-weekly', name: '周报生成', schedule: '0 18 * * 5', action: '生成本周工作总结报告', enabled: true, type: 'cron', nextRun: '周五 18:00' },
  { id: 'default-report-daily', name: '日报生成', schedule: '0 21 * * *', action: '生成今日工作情况报告', enabled: false, type: 'cron', nextRun: '每日 21:00' },
  { id: 'default-backup', name: '数据备份', schedule: '0 2 * * *', action: '自动备份对话记录与配置数据', enabled: true, type: 'cron', nextRun: '明日 02:00' },
]

export const useStore = create<AppStore>()(
  persist(
    // 显式标注 set/get 与返回类型：避免 persist 中间件泛型推断回退导致全 store 参数隐式 any（TS7006）
    (set: (partial: Partial<AppStore> | ((s: AppStore) => Partial<AppStore>)) => void, get: () => AppStore): AppStore => ({
      activePanel: 'chat',
      setActivePanel: (activePanel) => set({ activePanel }),

      // 默认打开团队群聊
      conversations: [defaultConversation],
      activeConversationId: '__team_group_chat__',

      createConversation: (name, roleId) => {
        const id = 'conv-' + Date.now()
        let convName = name
        if (!convName) {
          if (roleId) {
            // 🔧 按角色命名：代码开发 #1、学习搭子 #1 ...
            const ROLE_NAME_MAP: Record<string, string> = {
              general: '通用Agent', learner: '学习搭子', writer: '写作能手',
              developer: '代码开发', design: '商业设计', intel: '情报部门', colleague: '职场同事',
            }
            const roleLabel = ROLE_NAME_MAP[roleId] || roleId
            const roleCount = get().conversations.filter(c => c.roleId === roleId).length + 1
            convName = `${roleLabel} #${roleCount}`
          } else {
            convName = `对话 ${get().conversations.length + 1}`
          }
        }
        const newConv: Conversation = { id, name: convName, messages: [], createdAt: Date.now(), roleId }
        set((s) => ({ conversations: [...s.conversations, newConv], activeConversationId: id }))
      },
      deleteConversation: (id) => {
        set((s) => {
          const deleted = s.conversations.find(c => c.id === id)
          const filtered = s.conversations.filter((c) => c.id !== id)
          if (filtered.length === 0) {
            let fallbackName = '默认对话'
            if (deleted?.roleId) {
              const ROLE_NAME_MAP: Record<string, string> = {
                general: '通用Agent', learner: '学习搭子', writer: '写作能手',
                developer: '代码开发', design: '商业设计', intel: '情报部门', colleague: '职场同事',
              }
              fallbackName = `${ROLE_NAME_MAP[deleted.roleId] || deleted.roleId} #1`
            }
            const newConv: Conversation = { id: 'conv-' + Date.now(), name: fallbackName, messages: [welcomeMsg], createdAt: Date.now(), roleId: deleted?.roleId }
            return { conversations: [newConv], activeConversationId: newConv.id }
          }
          // 🔧 如果删的是当前激活的对话，切换到同角色的下一个对话
          if (s.activeConversationId === id) {
            const sameRole = filtered.filter(c => c.roleId === deleted?.roleId)
            const nextId = sameRole.length > 0 ? sameRole[0].id : filtered[0].id
            return { conversations: filtered, activeConversationId: nextId }
          }
          return { conversations: filtered, activeConversationId: s.activeConversationId }
        })
      },
      switchConversation: (id) => set({ activeConversationId: id }),
      updateConversation: (id, updates) => set((s) => ({
        conversations: s.conversations.map((c) => c.id === id ? { ...c, ...updates } : c),
      })),
      renameConversation: (id, name) => set((s) => ({
        conversations: s.conversations.map((c) => c.id === id ? { ...c, name } : c),
      })),
      togglePinConversation: (id) => set((s) => ({
        conversations: s.conversations.map((c) => c.id === id ? { ...c, pinned: !c.pinned } : c),
      })),
      addMessage: (convId, role, content) => set((s) => {
        const msg: ChatMessage = {
          id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          role, content, timestamp: Date.now(),
        }
        return {
          conversations: s.conversations.map((c) =>
            c.id === convId ? { ...c, messages: [...c.messages, msg], modelName: s.llmConfig.model } : c
          ),
        }
      }),
      clearCurrentMessages: () => set((s) => ({
        conversations: s.conversations.map((c) =>
          c.id === s.activeConversationId ? { ...c, messages: [] } : c
        ),
      })),
      deleteMessage: (convId, msgId) => set((s) => ({
        conversations: s.conversations.map((c) =>
          c.id === convId ? { ...c, messages: c.messages.filter(m => m.id !== msgId) } : c
        ),
      })),

      isProcessing: false,
      setIsProcessing: (isProcessing) => set({ isProcessing }),

      llmOnline: false,
      llmChecked: false,
      setLlmOnline: (llmOnline) => set({ llmOnline, llmChecked: true }),
      setLlmChecked: (llmChecked) => set({ llmChecked }),

      llmConfig: {
        provider: '', baseUrl: '', apiKey: '',
        model: '', temperature: 0.7, maxTokens: 262144, contextWindow: 0,
      },
      setLLMConfig: (c) => set((s) => ({ llmConfig: { ...s.llmConfig, ...c } })),

      providerConfigs: {},
      switchLLMProvider: (providerId, defaultBaseUrl, defaultModel) =>
        set((s) => {
          // 1) 保存当前供应商的完整配置
          const currentProvider = s.llmConfig.provider
          const newProviderConfigs = { ...s.providerConfigs }
          if (currentProvider) {
            newProviderConfigs[currentProvider] = { ...s.llmConfig }
          }

          // 2) 恢复目标供应商的配置（若无则用默认值 + 继承温度/tokens）
          const saved = newProviderConfigs[providerId]
          const newLLMConfig: LLMConfig = saved
            ? { ...saved, provider: providerId }
            : {
                provider: providerId,
                baseUrl: defaultBaseUrl,
                apiKey: s.llmConfig.apiKey || '',
                model: defaultModel,
                temperature: s.llmConfig.temperature || 0.7,
                maxTokens: s.llmConfig.maxTokens || 262144,
                contextWindow: s.llmConfig.contextWindow || 0,
              }

          return { llmConfig: newLLMConfig, providerConfigs: newProviderConfigs }
        }),

      // ── 🆕 v10.8: Per-Agent LLM 配置 ──────────────
      agentLlmConfigs: {},
      loadAgentLlmConfigs: async () => {
        try {
          const r = await window.luminaAPI?.agentLlmGetAllConfigs?.()
          if (r?.configs) {set({ agentLlmConfigs: r.configs })}
        } catch { /* 静默 */ }
      },
      getAgentLlmConfig: (agentId: string) => {
        const s = get()
        const agentCfg = s.agentLlmConfigs[agentId]
        // 如果 per-agent 配置存在且有 endpoint/model，优先使用
        if (agentCfg?.enabled && agentCfg?.endpoint && agentCfg?.model) {
          return {
            provider: agentCfg.provider || s.llmConfig.provider,
            baseUrl: agentCfg.endpoint,
            apiKey: agentCfg.apiKey || s.llmConfig.apiKey,
            model: agentCfg.model,
            temperature: s.llmConfig.temperature,
            maxTokens: s.llmConfig.maxTokens,
            contextWindow: s.llmConfig.contextWindow,
          }
        }
        // fallback 到全局配置
        return s.llmConfig
      },

      /** 🔄 v10.0: 从后端 ProviderManager 同步所有供应商配置 */
      syncProviderFromBackend: async () => {
        try {
          const win = window as any
          if (!win.luminaAPI?.providerGetAll) {return}
          const result = await win.luminaAPI.providerGetAll()
          if (!result) {return}

          const { activeProviderId, configs } = result
          if (!configs || Object.keys(configs).length === 0) {return}

          // 更新 providerConfigs
          const newProviderConfigs: Record<string, LLMConfig> = {}
          for (const [id, cfg] of Object.entries(configs) as any) {
            if (cfg.enabled || id === activeProviderId) {
              // maxTokens 是用户的"最大输出"偏好（后端不存）：激活供应商继承当前值，其余沿用各自上次值，避免每次同步被打回 8192
              const inheritedMaxTokens = (id === activeProviderId ? get().llmConfig.maxTokens : get().providerConfigs[id]?.maxTokens) || 8192
              newProviderConfigs[id] = {
                provider: id,
                baseUrl: cfg.baseUrl || '',
                apiKey: cfg.apiKey || '',
                model: cfg.model || '',
                temperature: get().llmConfig.temperature || 0.7,
                maxTokens: inheritedMaxTokens,
                contextWindow: cfg.maxContextTokens || 0,
              }
            }
          }

          set({ providerConfigs: newProviderConfigs })

          // 如果有激活的供应商，切换到它
          if (activeProviderId && newProviderConfigs[activeProviderId]) {
            set({
              llmConfig: newProviderConfigs[activeProviderId],
              // ?? 立刻标记为在线（已保存=之前是好的），TopBar 见 llmChecked=true 将跳过自检
              llmOnline: true,
              llmChecked: true,
            })
            // ?? 后台验证真实连通性，失败则切回离线
            try {
              const testResult = await win.luminaAPI.providerTestConnection?.(activeProviderId)
              if (!testResult?.success) {
                set({ llmOnline: false })
              }
            } catch {
              set({ llmOnline: false })
            }
          }
        } catch (err) {
          console.error('[Store] syncProviderFromBackend 失败:', err)
        }
      },

      ttsConfig: {
        voice: 'zh-CN-XiaoxiaoNeural', speed: 1.0, volume: 0.8,
        engine: 'edge-tts', enabled: true,
        indextts: { port: 18927, refAudioPath: '', lang: 'ZH', emotion: 'calm', durationFactor: 1.0 },
      },
      setTTSConfig: (c) => set((s) => ({ ttsConfig: { ...s.ttsConfig, ...c } })),

      ttsMuted: false,
      setTTSMuted: (ttsMuted) => set({ ttsMuted }),
      ttsToggle: () => set((s) => ({ ttsMuted: !s.ttsMuted })),

      ttsEngine: 'edge',  // 🔧 默认 TTS 引擎
      setTTSEngine: (ttsEngine) => set({ ttsEngine }),

      agentConfig: {
        name: 'Lumina', persona: 'lumina',
        tools: ['shell_exec', 'browser', 'search', 'file_read', 'file_write', 'file_edit', 'file_list', 'datetime', 'memory_save', 'memory_get', 'memory_all', 'todo'],
        systemPrompt: '',
        customPersonas: [],
      },
      activePersona: 'lumina',
      setActivePersona: (activePersona) => set({ activePersona }),
      setAgentConfig: (c) => set((s) => ({ agentConfig: { ...s.agentConfig, ...c } })),
      addCustomPersona: (p) => set((s) => ({ agentConfig: { ...s.agentConfig, customPersonas: [...s.agentConfig.customPersonas, p] } })),
      removeCustomPersona: (id) => set((s) => ({ agentConfig: { ...s.agentConfig, customPersonas: s.agentConfig.customPersonas.filter(p => p.id !== id) } })),

      securityConfig: {
        safeMode: true, allowedApps: ['notepad.exe', 'chrome.exe', 'explorer.exe'],
        requireConfirm: true,
        rules: ['no-leak', 'confirm-destructive', 'no-external-post', 'rate-limit', 'memory-privacy'],
        sandboxMode: true,  // 🆕 v2.0: 默认开启沙箱模式
      },
      setSecurityConfig: (c) => set((s) => ({ securityConfig: { ...s.securityConfig, ...c } })),

      skillConfig: { enabled: ['weather', 'search', 'browser', 'memory', 'code', 'files', 'desktop', 'audio', 'notify', 'timer', 'proactive', 'image'] },
      setSkillConfig: (c) => set((s) => ({ skillConfig: { ...s.skillConfig, ...c } })),

      bridgeConfig: {
        discord: { enabled: false, token: '' }, wechat: { enabled: false, token: '' },
        telegram: { enabled: false, token: '' }, feishu: { enabled: false, token: '' },
      },
      setBridgeConfig: (c) => set((s) => ({ bridgeConfig: { ...s.bridgeConfig, ...c } })),

      tokenUsage: { total: 0, today: 0, limit: 100000, lastResetDate: '', byModel: [], byAgent: [], history: [] },
      addTokenUsage: (model: string, tokens: number, agentId?: string) => set((s) => {
        const todayStr = new Date().toISOString().slice(0, 10)
        // 每日自动重置检查（兼容旧数据无 lastResetDate）
        const lastDate = s.tokenUsage.lastResetDate || ''
        const isNewDay = lastDate && lastDate !== todayStr
        const todayTokens = isNewDay ? tokens : (s.tokenUsage.today || 0) + tokens

        const byModel = [...(s.tokenUsage.byModel || [])]
        const idx = byModel.findIndex((m) => m.model === model)
        if (idx >= 0) {byModel[idx] = { model, tokens: byModel[idx].tokens + tokens }}
        else {byModel.push({ model, tokens })}

        // 按 Agent 统计
        const byAgent = [...(s.tokenUsage.byAgent || [])]
        if (agentId) {
          const aIdx = byAgent.findIndex((a) => a.agentId === agentId)
          if (aIdx >= 0) {byAgent[aIdx] = { agentId, tokens: byAgent[aIdx].tokens + tokens }}
          else {byAgent.push({ agentId, tokens })}
        }

        // 清理 byModel — 只保留最近30条历史中出现的模型
        const historyArr = s.tokenUsage.history || []
        const activeModels = new Set(historyArr.slice(-30).map(h => h.model))
        const cleanedByModel = byModel.filter(m => activeModels.has(m.model) || m.tokens > 0)

        return {
          tokenUsage: {
            ...s.tokenUsage,
            total: (s.tokenUsage.total || 0) + tokens,
            today: todayTokens,
            lastResetDate: todayStr,
            byModel: cleanedByModel,
            byAgent,
            history: [...historyArr.slice(-99), { date: new Date().toISOString().slice(0, 16), tokens, model }],
          },
        }
      }),
      setTokenLimit: (limit) => set((s) => ({
        tokenUsage: { ...s.tokenUsage, limit: Math.max(0, limit) },
      })),
      resetDailyTokens: () => set((s) => ({
        tokenUsage: { ...s.tokenUsage, today: 0 },
      })),
      removeHistoryEntry: (index) => set((s) => {
        const history = [...s.tokenUsage.history]
        history.splice(index, 1)
        return { tokenUsage: { ...s.tokenUsage, history } }
      }),
      clearTokenHistory: () => set((s) => ({
        tokenUsage: { ...s.tokenUsage, history: [] },
      })),

      cronTasks: defaultTasks,
      addCronTask: (t) => set((s) => ({ cronTasks: [...s.cronTasks, t] })),
      removeCronTask: (id) => set((s) => ({ cronTasks: s.cronTasks.filter((x) => x.id !== id) })),
      toggleCronTask: (id) => set((s) => ({ cronTasks: s.cronTasks.map((x) => x.id === id ? { ...x, enabled: !x.enabled } : x) })),

      sandboxConfig: {
        defaultRoot: '',
        agents: {},
        authorizedDirs: [],
      },
      setSandboxConfig: (c) => set((s) => ({ sandboxConfig: { ...s.sandboxConfig, ...c } })),

      auditLogs: [
        { id: 'init', time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }), action: '🔌 Agent 启动 — 等待 LLM 连接…', type: 'system' },
      ],
      addAuditLog: (log) => set((s) => ({ auditLogs: [{ id: Date.now().toString(), ...log }, ...s.auditLogs].slice(0, 200) })),

      // ═══ Memory v2 ═══
      structuredMemory: {
        user: { preferences: [], habits: [], communicationStyle: 'casual', personality: '' },
        memory: { systemInfo: [], toolExperience: [], projectConventions: [], lessons: [], paths: {} },
      },
      setStructuredMemory: (m) => set((s) => ({
        structuredMemory: {
          user: { ...s.structuredMemory.user, ...(m.user || {}) },
          memory: { ...s.structuredMemory.memory, ...(m.memory || {}) },
        },
      })),
      memoryProfileText: '',
      setMemoryProfileText: (memoryProfileText) => set({ memoryProfileText }),

      // ═══ Agent v2 ═══
      agentMode: 'agent',
      setAgentMode: (agentMode) => set({ agentMode }),
      toolTraces: [],
      addToolTrace: (t) => set((s) => ({ toolTraces: [...s.toolTraces, t] })),
      updateToolTrace: (name, status, result) => set((s) => ({
        toolTraces: s.toolTraces.map((t) =>
          t.name === name && t.status === 'running' ? { ...t, status, result } : t
        ),
      })),
      clearToolTraces: () => set({ toolTraces: [] }),

      // ═══ 个性化 ═══
      profile: {
        avatar: '',
        nickname: '',
        gender: 'secret' as const,
        tags: [] as string[],
        birthday: '',
        bubbleColorUser: '',   // 空字符串使用CSS变量自动适配主题
        bubbleColorAgent: '',  // 空字符串使用CSS变量自动适配主题
      },
      setProfile: (p) => set((s) => ({ profile: { ...s.profile, ...p } })),

      // ═══ v2.6 团队 ═══
      teamState: {
        agents: [],
        relationships: [],
        mood: 'quiet',
        currentTopic: '',
        isDiscussing: false,
        dailyMessageCount: 0,
        eventLog: [],
      },
      setTeamState: (t) => set((s) => ({ teamState: { ...s.teamState, ...t } })),
      // 首次运行引导
      firstRun: true,
      completeOnboarding: () => set({ firstRun: false }),

      // 主题切换
      theme: 'light',
      setTheme: (theme) => set({ theme }),

      // 🆕 简约模式
      compactMode: (() => { try { return localStorage.getItem('lumina_compact') === 'true' } catch { return false } })(),
      setCompactMode: (v) => { try { localStorage.setItem('lumina_compact', String(v)) } catch {} ; set({ compactMode: v }) },

      // ♿ 无障碍
      a11y: {
        pttShortcut: 'Ctrl+Space',
        voiceLoopEnabled: false,
        highContrast: false,
        fontScale: 1,
        wakeWordEnabled: false,
      },
      setA11y: (patch) => set((s) => ({ a11y: { ...s.a11y, ...patch } })),

      // 实验功能开关（默认开启；关闭后隐藏梦境/真人秀等彩蛋）
      showExperimental: (() => {
        try { return localStorage.getItem('lumina_show_experimental') !== 'false' } catch { return true }
      })(),
      setShowExperimental: (v) => {
        try { localStorage.setItem('lumina_show_experimental', String(v)) } catch {}
        set({ showExperimental: v })
      },

      // Profile 面板默认 Tab（⭐ 徽章点击时设为 'achievements'）
      profileTab: 'profile' as const,
      setProfileTab: (t) => set({ profileTab: t }),

      // 游戏化
      gamification: {
        level: 1,
        totalXp: 0,
        todayXp: 0,
        title: '初见',
        progress: 0,
        unlockedAchievements: [],
        lastUnlockedAchievement: null,
      },
      setGamification: (g) => set((s) => ({ gamification: { ...s.gamification, ...g } })),

      // 第二阶段: 场景模式
      luminaMode: {
        current: 'work',
        config: {
          label: '工作', emoji: '💼', agentTone: '', proactiveInterval: 0,
          proactiveEnabled: false, newsEnabled: true, temperature: 0.5, color: '#4A90D9',
        },
        manualOverride: false,
        lastScene: null,
        lastSwitchAt: Date.now(),
      },
      setLuminaMode: (m) => set((s) => ({
        luminaMode: { ...s.luminaMode, ...m },
      })),
      initializeModeListeners: () => {
        const api = (window as any).luminaAPI
        if (!api) {return () => {}}

        // 启动时拉取完整配置
        api.modeGet().then((state: any) => {
          if (state && !state.error) {
            set({
              luminaMode: {
                current: state.current || 'work',
                config: state.config || {},
                allConfigs: state.allConfigs || {},
                manualOverride: state.manualOverride || false,
                lastScene: state.scene || null,
                lastSwitchAt: Date.now(),
              },
            })
          }
        }).catch(() => {})

        const onChanged = (data: any) => {
          const s = get()
          // 从 modeGet 获取完整 allConfigs
          api.modeGet().then((fullState: any) => {
            if (fullState && !fullState.error) {
              set({
                luminaMode: {
                  current: data.mode || 'work',
                  config: data.config || s.luminaMode.config,
                  allConfigs: fullState.allConfigs || s.luminaMode.allConfigs,
                  manualOverride: data.manualOverride || false,
                  lastScene: data.scene || null,
                  lastSwitchAt: Date.now(),
                },
              })
              return
            }
            // fallback
            set({
              luminaMode: {
                current: data.mode || 'work',
                config: data.config || s.luminaMode.config,
                allConfigs: s.luminaMode.allConfigs,
                manualOverride: data.manualOverride || false,
                lastScene: data.scene || null,
                lastSwitchAt: Date.now(),
              },
            })
          }).catch(() => {
            // fallback 无 allConfigs 时的兜底
            set({
              luminaMode: {
                current: data.mode || 'work',
                config: data.config || s.luminaMode.config,
                manualOverride: data.manualOverride || false,
                lastScene: data.scene || null,
                lastSwitchAt: Date.now(),
              },
            })
          })

          // 🆕 Lucky 场景感知 Toast
          if (data.luckyAdjustment) {
            showToast(data.luckyAdjustment, 'info')
          }
        }
        const onSceneUpdate = (data: any) => {
          set((s: any) => ({
            luminaMode: {
              ...s.luminaMode,
              lastScene: data.scene || null,
            },
          }))
        }

        // 注册 IPC 监听 (通过 preload 暴露的 onModeChanged / onModeSceneUpdate)
        const unsub1 = api.onModeChanged?.(onChanged) || (() => {})
        const unsub2 = api.onModeSceneUpdate?.(onSceneUpdate) || (() => {})

        // 初始化时拉取一次状态
        api.modeGet?.().then((state: any) => {
          if (state && !state.error) {
            set({
              luminaMode: {
                current: state.current || 'work',
                config: state.config || get().luminaMode.config,
                manualOverride: state.manualOverride || false,
                lastScene: state.scene || null,
                lastSwitchAt: state.lastSwitchAt || Date.now(),
              },
            })
          }
        }).catch(() => {})

        return () => { unsub1(); unsub2() }
      },
    }),
    {
      name: 'lumina-life-storage',
      storage: createJSONStorage(() => localStorage),
      // 🔧 v1.1: 合并持久化数据时，清除旧的浅色模式气泡颜色（让 CSS 变量自适应深色模式）
      merge: (persistedState: any, currentState: any) => {
        const merged = { ...currentState, ...persistedState }
        // 如果气泡颜色是已知的浅色模式默认值，重置为空以使用 CSS 变量
        if (merged.profile) {
          if (merged.profile.bubbleColorUser === '#eff6ff') {merged.profile.bubbleColorUser = ''}
          if (merged.profile.bubbleColorAgent === '#f9fafb') {merged.profile.bubbleColorAgent = ''}
        }
        return merged
      },
      partialize: (state) => ({
        conversations: state.conversations,
        activeConversationId: state.activeConversationId,
        llmConfig: state.llmConfig,
        providerConfigs: state.providerConfigs,
        ttsConfig: state.ttsConfig,
        ttsEngine: state.ttsEngine,
        ttsMuted: state.ttsMuted,
        agentConfig: state.agentConfig,
        activePersona: state.activePersona,
        agentMode: state.agentMode,
        securityConfig: state.securityConfig,
        skillConfig: state.skillConfig,
        bridgeConfig: state.bridgeConfig,
        tokenUsage: state.tokenUsage,
        cronTasks: state.cronTasks,
        profile: state.profile,  // 🔧 v2.14: 持久化气泡颜色等个性化设置
        firstRun: state.firstRun,  // 🆕 v1.0: 持久化引导完成状态
        theme: state.theme,        // 🆕 v1.1: 持久化主题偏好
        gamification: state.gamification, // 🆕 v3.0: 持久化游戏化状态
        a11y: state.a11y,          // ♿ 无障碍偏好（PTT 快捷键/高对比/字号）
      }),
    }
  )
)
