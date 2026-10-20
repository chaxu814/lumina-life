import { contextBridge, ipcRenderer } from 'electron'

// ─── 接口定义 ─────────────────────────────────────────────

export interface LLMChatParams {
  baseUrl: string
  apiKey: string
  model: string
  messages: Array<{ role: string; content: string }>
  temperature?: number
  maxTokens?: number
  systemPrompt?: string
}

export interface LLMChatResult {
  content: string
  model: string
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
}

export interface TTSSpeakParams {
  text: string
  voice?: string
  speed?: number
}

export interface TTSSpeakResult {
  success: boolean
  filePath?: string
  error?: string
}

/**
 * 🔍 情绪收紧审计记录（渲染层 DTO）
 *
 * 与主进程 `EmotionGateRecord` 同构，但**故意不共享类型**：
 * 渲染层不应该直接 import 主进程模块（会拖进 Electron 依赖）。
 * 字段若有变动，preload 这里的形状会先断，由编译器而不是运行时发现。
 */
export interface EmotionAuditRecordDto {
  id: string
  ts: number
  emotion: { mood: number; energy: number; anxiety: number; fatigue: number; valence: number }
  rules: string[]
  suppressed: Array<{ tool: string; riskClass: string }>
  notice: string
  status: 'active' | 'recovered' | 'overridden'
  recoveredAt?: number
  overriddenAt?: number
  overrideReason?: string
  turnId?: string
}

export interface AgentRunConfig {
  mode: 'chat' | 'agent' | 'developer'
  model: string
  baseUrl: string
  apiKey: string
  temperature?: number
  maxTokens?: number
  maxToolCalls?: number
  systemPrompt?: string
  personaId?: string
  disabledTools?: string[]
  skipApproval?: boolean
  contextWindow?: number
  /** 🆕 v3.8.1: 社交模式（短超时，通过 IPC 透传） */
  socialMode?: boolean
  /** 🆕 v15.0: 说出来模式 — 让 Agent 在搜索/工具调用时说出思考过程 */
  verbalizeThinking?: boolean
  /** 🆕 2026-10-10: 后台任务标记（自主刷新/朋友圈等）—— 不打断用户对话 */
  background?: boolean
}

export interface AgentEvent {
  type: 'thinking' | 'thinking_stream' | 'text_stream' | 'tool_start' | 'tool_end' | 'text' | 'done' | 'error' | 'memory_summary' | 'token_update'
  agentId?: string
  agentName?: string
  content?: string
  tool?: string
  args?: any
  result?: any
  error?: string
  timestamp?: number
}

export interface AgentChatResult {
  content: string
  compactedContext?: string
  toolCalls?: Array<{ tool: string; args: any; result: any }>
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
}

export interface STTStatus {
  active: boolean
  error?: string
}

// ─── API 对象 ─────────────────────────────────────────────

const api = {
  // ─── 配置 ───────────────────────────────────────────────
  getConfig: () =>
    ipcRenderer.invoke('config:get') as Promise<any>,

  setConfig: (updates: any) =>
    ipcRenderer.invoke('config:set', updates) as Promise<void>,

  // ─── LLM (传统单轮) ─────────────────────────────────────
  llmChat: (params: LLMChatParams) =>
    ipcRenderer.invoke('llm:chat', params) as Promise<LLMChatResult>,

  /** 使用当前供应商/模型增强草稿提示词；只返回改写文本，不会发送原任务 */
  llmEnhancePrompt: (params: { baseUrl: string; apiKey?: string; model: string; text: string }) =>
    ipcRenderer.invoke('llm:enhance-prompt', params) as Promise<{
      content?: string
      error?: string
      /** 输出长度预算（字符） */
      budget?: number
      originalChars?: number
      enhancedChars?: number
      /** 模型超预算、结果被兜底裁剪过 */
      trimmed?: boolean
    }>,

  /** 🔧 v2.9: 获取 LLM 提供商支持的模型列表 */
  llmFetchModels: (params: { baseUrl: string; apiKey: string; provider?: string }) =>
    ipcRenderer.invoke('llm:fetchModels', params) as Promise<{ models: Array<{ id: string; multimodal?: boolean; vision?: boolean }> }>,

  /** 🔧 v2.17: 测试 LLM 连接 */
  llmTestConnection: (params: { baseUrl: string; apiKey: string; model: string }) =>
    ipcRenderer.invoke('llm:testConnection', params) as Promise<{ success: boolean; latency?: number; error?: string; usage?: any }>,

  /** 🔧 v2.9: 中止 LLM 请求 */
  llmAbort: () =>
    ipcRenderer.invoke('llm:abort') as Promise<void>,

  // ─── Agent 独立 LLM 配置 ───────────────────────────────
  /** v6.0: Agent 独立 LLM 配置（新接口） */
  agentConfigureLlm: (agentId: string, config: any) =>
    ipcRenderer.invoke('agent:configure-llm', { agentId, ...config }) as Promise<{ success: boolean }>,

  agentGetLlmConfigs: () =>
    ipcRenderer.invoke('agent:get-llm-configs') as Promise<any>,

  /** v5.0: Per-Agent 独立 LLM 配置（兼容旧接口，内部桥接到新 IPC） */
  agentLlmGetConfig: (agentId: string) =>
    ipcRenderer.invoke('agent-llm:get-config', { agentId }) as Promise<any>,

  agentLlmSetConfig: (agentId: string, config: { provider: string; model: string; endpoint: string; apiKey: string; timeout?: number; maxContextTokens?: number }) =>
    ipcRenderer.invoke('agent:configure-llm', { agentId, ...config }) as Promise<{ success: boolean }>,

  agentLlmGetAllConfigs: () =>
    ipcRenderer.invoke('agent:get-llm-configs') as Promise<any>,

  /** 🔧 v6.1: .env 供应商检测与全局配置同步 */
  agentGetAvailableProviders: () =>
    ipcRenderer.invoke('agent:get-available-providers') as Promise<Array<{ name: string; models: string[]; configured: boolean }>>,

  agentUseGlobalConfig: (params: { provider: string; model: string }) =>
    ipcRenderer.invoke('agent:use-global-config', params) as Promise<{ success: boolean }>,

  agentForceAutoDetect: () =>
    ipcRenderer.invoke('agent:force-auto-detect') as Promise<{ success: boolean; provider?: string; model?: string }>,

  /** 🆕 v9.0: 设置 Agent 情绪状态 */
  agentSetEmotion: (emotion: string) =>
    ipcRenderer.invoke('agent:setEmotion', emotion) as Promise<void>,

  // ─── v10.0: 统一 Provider 管理 (QwenPaw 风格) ─────────
  /** 获取所有供应商定义 */
  providerList: () =>
    ipcRenderer.invoke('provider:list') as Promise<{ providers: Array<{ id: string; name: string; isLocal: boolean; defaultBaseUrl: string; defaultModel: string; requiresApiKey: boolean }> }>,

  /** 获取所有供应商配置 */
  providerGetAll: () =>
    ipcRenderer.invoke('provider:get-all') as Promise<{ activeProviderId: string; configs: Record<string, any>; availableIds: string[] }>,

  /** 获取单个供应商配置 */
  providerGetConfig: (id: string) =>
    ipcRenderer.invoke('provider:get-config', id) as Promise<{ config: any }>,

  /** 保存供应商配置 */
  providerSaveConfig: (id: string, config: any) =>
    ipcRenderer.invoke('provider:save-config', id, config) as Promise<{ success: boolean; error?: string }>,

  /** 批量保存供应商配置 */
  providerSaveMultiple: (configs: Record<string, any>) =>
    ipcRenderer.invoke('provider:save-multiple', configs) as Promise<{ success: boolean; error?: string }>,

  /** 激活供应商 */
  providerSetActive: (id: string) =>
    ipcRenderer.invoke('provider:set-active', id) as Promise<{ success: boolean; error?: string }>,

  /** 获取模型列表（可传界面当前填写的地址/密钥，无需先保存） */
  providerFetchModels: (id: string, override?: { baseUrl?: string; apiKey?: string }) =>
    ipcRenderer.invoke('provider:fetch-models', id, override) as Promise<{ models: Array<{ id: string; multimodal?: boolean; vision?: boolean }>; error?: string }>,

  /** 测试连接 */
  providerTestConnection: (id: string) =>
    ipcRenderer.invoke('provider:test-connection', id) as Promise<{ success: boolean; latency?: number; error?: string }>,

  // 一键检测/接入本地模型（Ollama / LM Studio，免 Key）
  // input.baseUrl —— 把前端当前配置的端点一并纳入探测。
  //   修复：用户把 LM Studio 跑在内网另一台机（http://192.168.1.11:1234/v1），
  //   但 providerManager 的激活供应商还是云端项 → 探测只测 127.0.0.1 →
  //   远端这台被漏掉 → 误报「无法连接」+「离线模式」。
  providerDiscoverLocal: (input?: { baseUrl?: string }) =>
    ipcRenderer.invoke('provider:discover-local', input) as Promise<{ found?: any[]; guide?: Array<{ title: string; body: string }>; error?: string }>,
  /** 严格检测指定 Agent 的实际端点与 API Key，不尝试其它候选或 Agent 密钥 */
  providerProbeLocalConfig: (input: { baseUrl: string; provider?: string; apiKey?: string }) =>
    ipcRenderer.invoke('provider:probe-local-config', input) as Promise<{
      provider: { id: string; label: string; baseUrl: string; models: string[]; recommendedModel: string; apiKey: string } | null
      failure: { kind: string; baseUrl: string; status?: number; advice: string } | null
    }>,
  providerApplyLocal: (input: { id?: string; baseUrl?: string; model?: string }) =>
    ipcRenderer.invoke('provider:apply-local', input) as Promise<{ success: boolean; id?: string; model?: string; baseUrl?: string; contextWindow?: number; contextDetected?: boolean; error?: string }>,

  // ─── TTS ────────────────────────────────────────────────
  ttsSpeak: (params: TTSSpeakParams) =>
    ipcRenderer.invoke('tts:speak', params) as Promise<TTSSpeakResult>,

  ttsStop: () =>
    ipcRenderer.invoke('tts:stop') as Promise<void>,

  // ─── 记忆 (v2.3: 三层记忆 — 事实/反思/人格) ──────────
  memorySave: (category: string, content: string) =>
    ipcRenderer.invoke('memory:save', { category, content }) as Promise<{ success: boolean }>,

  memoryGet: (section?: string) =>
    ipcRenderer.invoke('memory:get', section || 'all') as Promise<any>,

  memoryAll: () =>
    ipcRenderer.invoke('memory:all') as Promise<any>,

  memoryProfile: () =>
    ipcRenderer.invoke('memory:profile') as Promise<any>,

  // 记忆运维
  memoryStats: () =>
    ipcRenderer.invoke('memory:stats') as Promise<{
      totalFacts: number; totalReflections: number; totalPreferences: number;
      totalHabits: number; totalLessons: number; totalConventions: number;
      vectorStoreSize: number; embeddingMode: string; lastIndexed: number; dbSize: number;
    }>,

  memoryReindex: () =>
    ipcRenderer.invoke('memory:reindex') as Promise<{ ok: boolean; indexed: number; vectorSize: number }>,

  memoryClearCategory: (category: string) =>
    ipcRenderer.invoke('memory:clear-category', category) as Promise<{ ok: boolean; error?: string }>,

  // ─── 誓约/预约 (v2.3) ─────────────────────────────────
  oathMake: (params: { text: string; type?: string; deadline?: string }) =>
    ipcRenderer.invoke('oath:make', params) as Promise<any>,

  oathList: (category?: string) =>
    ipcRenderer.invoke('oath:list', { category }) as Promise<any>,

  oathFulfill: (id: string) =>
    ipcRenderer.invoke('oath:fulfill', { id }) as Promise<any>,

  oathListAll: () =>
    ipcRenderer.invoke('oath:list-all') as Promise<any>,

  appointmentSet: (params: { title: string; time: string; description?: string }) =>
    ipcRenderer.invoke('appointment:set', params) as Promise<any>,

  appointmentList: () =>
    ipcRenderer.invoke('appointment:list') as Promise<any>,

  // ─── OCR & 桌面自动化 (v2.3) ─────────────────────────
  ocr: (params?: any) =>
    ipcRenderer.invoke('ocr:run', params || {}) as Promise<string>,

  desktopClick: (x: number, y: number) =>
    ipcRenderer.invoke('desktop:click', { x, y }) as Promise<void>,

  desktopType: (text: string) =>
    ipcRenderer.invoke('desktop:type', { text }) as Promise<void>,

  desktopKey: (key: string) =>
    ipcRenderer.invoke('desktop:key', { key }) as Promise<void>,

  desktopScreenshot: (region?: string) =>
    ipcRenderer.invoke('desktop:screenshot', { region: region || 'full' }) as Promise<string>,

  // ─── 桥接 (多平台) ────────────────────────────────────
  bridgeStart: (platform: string) =>
    ipcRenderer.invoke('bridge:start', platform) as Promise<any>,

  bridgeStop: (platform: string) =>
    ipcRenderer.invoke('bridge:stop', platform) as Promise<any>,

  bridgeStatus: () =>
    ipcRenderer.invoke('bridge:status') as Promise<any>,

  // ─── 窗口 ───────────────────────────────────────────────
  windowMinimize: () =>
    ipcRenderer.invoke('window:minimize') as Promise<void>,

  windowMaximize: () =>
    ipcRenderer.invoke('window:maximize') as Promise<void>,

  windowClose: () =>
    ipcRenderer.invoke('window:close') as Promise<void>,

  // ─── 数据操作 ───────────────────────────────────────────
  clearAllData: () =>
    ipcRenderer.invoke('data:clear-all') as Promise<void>,

  resetSettings: () =>
    ipcRenderer.invoke('settings:reset') as Promise<void>,

  // ─── 对话框 ─────────────────────────────────────────────
  dialogSave: (options: any) =>
    ipcRenderer.invoke('dialog:save', options) as Promise<string | null>,

  dialogOpen: (options: any) =>
    ipcRenderer.invoke('dialog:open', options) as Promise<string | null>,

  // ─── 任务工作区产物文件操作 ───────────────────────────────
  artifactSave: (payload: { filename: string; content: string }) =>
    ipcRenderer.invoke('artifact:save', payload) as Promise<{ ok: boolean; canceled?: boolean; filePath?: string; error?: string }>,
  artifactOpenInFolder: (filePath: string) =>
    ipcRenderer.invoke('artifact:open-in-folder', filePath) as Promise<{ ok: boolean; error?: string }>,
  artifactOpenExternal: (filePath: string) =>
    ipcRenderer.invoke('artifact:open-external', filePath) as Promise<{ ok: boolean; error?: string }>,
  artifactReadFile: (filePath: string) =>
    ipcRenderer.invoke('artifact:read-file', filePath) as Promise<{
      ok: boolean; dataUrl?: string; size?: number; mtime?: number; error?: string
    }>,

  // ─── Agent API ──────────────────────────────────────────
  /** 发送消息给 Agent (多轮工具调用) */
  agentChat: (params: { text: string; config: AgentRunConfig; sessionId?: string; compactedContext?: string; conversationHistory?: Array<{ role: string; content: string }> }) =>
    ipcRenderer.invoke('agent:chat', params) as Promise<AgentChatResult>,

  /** 中止 Agent 运行 */
  agentAbort: () =>
    ipcRenderer.invoke('agent:abort') as Promise<void>,

  /**
   * 🆕 2026-10-13：从主进程 dialog 日志恢复群聊会话（跨 origin 兜底）。
   *
   * 前端会话存在 localStorage，而它**按 origin 隔离**（开发 localhost / 打包 file://），
   * 切换运行模式后读不到历史。dialog 日志是主进程文件，不受影响。
   * 前端只在 localStorage 为空时调用，不会覆盖已有数据。
   */
  gcRestoreFromLogs: (agentId?: string) =>
    ipcRenderer.invoke('gc:restore-from-logs', agentId) as Promise<{
      ok: boolean
      error?: string
      sessions: Array<{
        id: string
        lastAt: number
        count: number
        preview: string
        messages: Array<{ from: string; content: string; time: string }>
      }>
    }>,

  /** 清空 Agent 对话历史 */
  agentClear: () =>
    ipcRenderer.invoke('agent:clear') as Promise<void>,

  /** 切换 Agent 模式 */
  agentSetMode: (mode: string) =>
    ipcRenderer.invoke('agent:setMode', mode) as Promise<void>,

  /** 获取 Agent 状态 */
  agentGetState: () =>
    ipcRenderer.invoke('agent:getState') as Promise<any>,

  /** 列出可用的 Agent */
  agentList: () =>
    ipcRenderer.invoke('agent:list') as Promise<any>,

  // ─── 异步任务 API ──────────────────────────────────────
  taskSubmit: (params: { title: string; prompt: string; config: AgentRunConfig }) =>
    ipcRenderer.invoke('task:submit', params) as Promise<any>,

  taskList: () =>
    ipcRenderer.invoke('task:list') as Promise<any>,

  taskCancel: (taskId: string) =>
    ipcRenderer.invoke('task:cancel', taskId) as Promise<any>,

  onTaskProgress: (callback: (ev: any) => void) => {
    const handler = (_event: any, ev: any) => callback(ev)
    ipcRenderer.on('task:progress', handler)
    return () => {
      ipcRenderer.removeListener('task:progress', handler)
    }
  },

  onTaskDone: (callback: (task: any) => void) => {
    const handler = (_event: any, task: any) => callback(task)
    ipcRenderer.on('task:done', handler)
    return () => {
      ipcRenderer.removeListener('task:done', handler)
    }
  },

  // 🆕 v02: 任务工作区实时事件
  onTaskCreated: (callback: (task: any) => void) => {
    const handler = (_event: any, task: any) => callback(task)
    ipcRenderer.on('task:created', handler)
    return () => { ipcRenderer.removeListener('task:created', handler) }
  },

  onTaskError: (callback: (task: any) => void) => {
    const handler = (_event: any, task: any) => callback(task)
    ipcRenderer.on('task:error', handler)
    return () => { ipcRenderer.removeListener('task:error', handler) }
  },

  onTaskRunnerEvent: (callback: (payload: { taskId: string; assignee?: string; event: any }) => void) => {
    const handler = (_event: any, payload: any) => callback(payload)
    ipcRenderer.on('task:runner-event', handler)
    return () => { ipcRenderer.removeListener('task:runner-event', handler) }
  },

  // 🆕 v3.0: 子智能体（实习生）生命周期事件 → 「子智能体」侧边栏实时渲染
  onSubtaskEvent: (callback: (ev: any) => void) => {
    const handler = (_event: any, ev: any) => callback(ev)
    ipcRenderer.on('subtask:event', handler)
    return () => { ipcRenderer.removeListener('subtask:event', handler) }
  },

  // 🎭 创新功能 2：团队可见性剧场
  //   onTheaterBeat  = 单幕增量（用于实时滚动动画）
  //   onTheaterState = 整场状态（用于折叠态概览）
  //   两者都返回取消订阅函数，与上面的 onSubtaskEvent 保持同一套写法。
  onTheaterBeat: (callback: (beat: any) => void) => {
    const handler = (_event: any, beat: any) => callback(beat)
    ipcRenderer.on('theater:beat', handler)
    return () => { ipcRenderer.removeListener('theater:beat', handler) }
  },

  onTheaterState: (callback: (state: any) => void) => {
    const handler = (_event: any, state: any) => callback(state)
    ipcRenderer.on('theater:state', handler)
    return () => { ipcRenderer.removeListener('theater:state', handler) }
  },

  // ══════════════════════════════════════════════════════════
  // 🆕 v1.0 决策征询（ask_decision）—— agent 主动问用户「走哪条路」
  //   与审批流（approval）是两回事：审批不答就拦下，决策不答走默认。
  // ══════════════════════════════════════════════════════════
  onDecisionRequested: (callback: (req: any) => void) => {
    const handler = (_e: any, req: any) => callback(req)
    ipcRenderer.on('decision:requested', handler)
    return () => { ipcRenderer.removeListener('decision:requested', handler) }
  },
  onDecisionResolved: (callback: (ev: any) => void) => {
    const handler = (_e: any, ev: any) => callback(ev)
    ipcRenderer.on('decision:resolved', handler)
    return () => { ipcRenderer.removeListener('decision:resolved', handler) }
  },
  decisionAnswer: (id: string, selectedIds: string[], customText?: string, cancelled?: boolean) =>
    ipcRenderer.invoke('decision:answer', { id, selectedIds, customText, cancelled }),
  decisionCancel: (id: string) => ipcRenderer.invoke('decision:cancel', id),
  decisionCancelAll: () => ipcRenderer.invoke('decision:cancel-all'),
  decisionPending: () => ipcRenderer.invoke('decision:pending'),
  decisionConfig: (patch?: any) => ipcRenderer.invoke('decision:config', patch),

  // ─── Skill 安装 API ───────────────────────────────────
  skillInstall: (zipPath: string) =>
    ipcRenderer.invoke('skill:install', zipPath) as Promise<{ success: boolean; skillId?: string; error?: string }>,

  skillList: () =>
    ipcRenderer.invoke('skill:list') as Promise<any>,

  skillUninstall: (skillId: string) =>
    ipcRenderer.invoke('skill:uninstall', skillId) as Promise<{ success: boolean; error?: string }>,

  skillRead: (skillId: string) =>
    ipcRenderer.invoke('skill:read', skillId) as Promise<any>,

  skillOpenDialog: () =>
    ipcRenderer.invoke('skill:openDialog') as Promise<string | null>,

  skillRun: (skillId: string, toolName: string, args: any) =>
    ipcRenderer.invoke('skill:run', { skillId, toolName, args }) as Promise<any>,

  skillListTools: (skillId: string) =>
    ipcRenderer.invoke('skill:list-tools', skillId) as Promise<any>,

  // ─── 听觉系统 API ──────────────────────────────────────
  /** 启动听觉 (STT) */
  hearingStart: (source?: string) =>
    ipcRenderer.invoke('hearing:start', { source: source || 'mic' }) as Promise<{ success: boolean }>,

  /** 停止听觉 */
  hearingStop: () =>
    ipcRenderer.invoke('hearing:stop') as Promise<void>,

  /** 获取听觉状态 */
  hearingStatus: () =>
    ipcRenderer.invoke('hearing:status') as Promise<STTStatus>,

  /** 监听转写结果 */
  onTranscription: (callback: (data: any) => void) => {
    const handler = (_event: any, data: any) => callback(data)
    ipcRenderer.on('hearing:transcription', handler)
    return () => {
      ipcRenderer.removeListener('hearing:transcription', handler)
    }
  },

  // ─── 菜单 ───────────────────────────────────────────────
  onMenuEvent: (channel: string, callback: (...args: any[]) => void) => {
    const handler = (_event: any, ...args: any[]) => callback(...args)
    ipcRenderer.on(channel, handler)
    return () => {
      ipcRenderer.removeListener(channel, handler)
    }
  },

  // 同步 cron 任务到主进程
  cronSyncAll: (entries: Array<{ name: string; schedule: string; action: string; enabled: boolean }>) =>
    ipcRenderer.invoke('cron:sync-all', entries) as Promise<{ ok: boolean; count?: number; error?: string }>,

  // ─── Loop 持久化 (Phase 4) ──────────────────────────────
  loopDataRead: () =>
    ipcRenderer.invoke('loop:data:read') as Promise<Record<string, any>>,

  loopDataWrite: (data: Record<string, any>) =>
    ipcRenderer.invoke('loop:data:write', data) as Promise<{ ok: boolean }>,

  // ─── 事件监听 ──────────────────────────────────────────
  onTokenUsage: (callback: (data: any) => void) => {
    ipcRenderer.on('token:usage', (_event: any, data: any) => callback(data))
  },

  // ─── Edge TTS (Python edge-tts) ────────────────────────
  edgeTtsPort: () =>
    ipcRenderer.invoke('edge-tts:port') as Promise<number>,

  edgeTtsStart: () =>
    ipcRenderer.invoke('edge-tts:start') as Promise<{ ok: boolean; port?: number; detail?: string }>,

  edgeTtsStop: () =>
    ipcRenderer.invoke('edge-tts:stop') as Promise<void>,

  edgeTtsStatus: () =>
    ipcRenderer.invoke('edge-tts:status') as Promise<{ running: boolean; port?: number }>,

  edgeTtsSpeak: (params: { text: string; voice?: string; rate?: number }) =>
    ipcRenderer.invoke('edge-tts:speak', params) as Promise<{ success: boolean }>,

  // ─── STT (v2.11 增强) ──────────────────────────────────
  sttCheck: () =>
    ipcRenderer.invoke('stt:check') as Promise<{ available: boolean; engines?: string[] }>,

  sttStart: () =>
    ipcRenderer.invoke('stt:start') as Promise<{ success: boolean }>,

  sttStop: () =>
    ipcRenderer.invoke('stt:stop') as Promise<void>,

  onSTTResult: (callback: (text: string) => void) => {
    const handler = (_event: any, text: string) => callback(text)
    ipcRenderer.on('stt:result', handler)
    return () => {
      ipcRenderer.removeListener('stt:result', handler)
    }
  },

  onSTTReady: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('stt:ready', handler)
    return () => {
      ipcRenderer.removeListener('stt:ready', handler)
    }
  },

  // ─── 离线中文 STT 模型（whisper-base 多语种）──────────
  sttOfflineStatus: () =>
    ipcRenderer.invoke('stt:offline-status') as Promise<any>,
  sttDownloadModel: () =>
    ipcRenderer.invoke('stt:download-model') as Promise<any>,
  onSttDownloadProgress: (callback: (p: any) => void) => {
    const handler = (_event: any, data: any) => callback(data)
    ipcRenderer.on('stt:download-progress', handler)
    return () => { ipcRenderer.removeListener('stt:download-progress', handler) }
  },

  // ─── SoVITS TTS ────────────────────────────────────────
  ttsSoVITSSpeak: (params: { text: string; voice?: string }) =>
    ipcRenderer.invoke('tts:sovits-speak', params) as Promise<{ success: boolean }>,

  playAudio: (filePath: string) =>
    ipcRenderer.invoke('audio:play', filePath) as Promise<void>,

  // ─── Avatar 状态 ────────────────────────────────────────
  agentUpdateAvatarState: (state: any) =>
    ipcRenderer.invoke('agent:updateAvatarState', state) as Promise<void>,

  // ─── 文件系统 ───────────────────────────────────────────
  fsReadFile: (filePath: string) =>
    ipcRenderer.invoke('fs:readFile', filePath) as Promise<string>,

  fsWriteFile: (filePath: string, content: string) =>
    ipcRenderer.invoke('fs:writeFile', filePath, content) as Promise<void>,

  fsListDir: (dirPath: string) =>
    ipcRenderer.invoke('fs:listDir', dirPath) as Promise<string[]>,

  // ─── 配置持久化 ────────────────────────────────────────
  configSaveToDb: (key: string, value: any) =>
    ipcRenderer.invoke('config:saveToDb', key, value) as Promise<void>,

  configLoadFromDb: (key: string) =>
    ipcRenderer.invoke('config:loadFromDb', key) as Promise<any>,

  // ─── 崩溃检测 ──────────────────────────────────────────
  systemCrashed: () =>
    ipcRenderer.invoke('system:crashed') as Promise<{ crashed: boolean; reason?: string }>,

  // ─── 自动更新 (P2.3) ──────────────────────────────────
  updateCheck: () =>
    ipcRenderer.invoke('update:check') as Promise<{ available: boolean; version?: string }>,

  updateStatus: () =>
    ipcRenderer.invoke('update:status') as Promise<{ checking: boolean; available: boolean; downloading: boolean; progress?: number }>,

  updateDownload: () =>
    ipcRenderer.invoke('update:download') as Promise<{ success: boolean }>,

  updateInstall: () =>
    ipcRenderer.invoke('update:install') as Promise<void>,

  // ─── MCP (v2.4) ────────────────────────────────────────
  mcpConnect: (params: { serverName: string; command?: string; args?: string[]; env?: any }) =>
    ipcRenderer.invoke('mcp:connect', params) as Promise<{ success: boolean; error?: string }>,

  mcpListServers: () =>
    ipcRenderer.invoke('mcp:list-servers') as Promise<any>,

  mcpListTools: (serverName?: string) =>
    ipcRenderer.invoke('mcp:list-tools', { serverName }) as Promise<any>,

  mcpCallTool: (params: { serverName: string; toolName: string; args: any }) =>
    ipcRenderer.invoke('mcp:call-tool', params) as Promise<any>,

  mcpDisconnect: (serverName: string) =>
    ipcRenderer.invoke('mcp:disconnect', serverName) as Promise<void>,

  // ─── Orchestrator (v2.5) ──────────────────────────────
  orchestratorExecute: (params: { goal: string; config: AgentRunConfig }) =>
    ipcRenderer.invoke('orchestrator:execute', params) as Promise<any>,

  orchestratorRoles: () =>
    ipcRenderer.invoke('orchestrator:roles') as Promise<any>,

  onOrchestratorProgress: (callback: (data: any) => void) => {
    const handler = (_event: any, data: any) => callback(data)
    ipcRenderer.on('orchestrator:progress', handler)
    return () => {
      ipcRenderer.removeListener('orchestrator:progress', handler)
    }
  },

  // ─── 邮件 (v2.7) ───────────────────────────────────────
  mailList: () =>
    ipcRenderer.invoke('mail:list') as Promise<any>,

  mailMarkRead: (id: string) =>
    ipcRenderer.invoke('mail:mark-read', id) as Promise<void>,

  mailDelete: (id: string) =>
    ipcRenderer.invoke('mail:delete', id) as Promise<void>,

  // v2.8: 归档邮件 — 删除的邮件可在此恢复，历史不再丢失
  mailArchivedList: () =>
    ipcRenderer.invoke('mail:archived-list') as Promise<any>,

  mailRestore: (id: string) =>
    ipcRenderer.invoke('mail:restore', id) as Promise<{ ok: boolean }>,

  mailPurgeArchived: (id: string) =>
    ipcRenderer.invoke('mail:purge-archived', id) as Promise<{ ok: boolean }>,

  mailUnreadCount: () =>
    ipcRenderer.invoke('mail:unread-count') as Promise<number>,

  onMailChanged: (callback: (data: { unread: number; total: number }) => void) => {
    const handler = (_event: any, data: { unread: number; total: number }) => callback(data)
    ipcRenderer.on('mail:changed', handler)
    return () => {
      ipcRenderer.removeListener('mail:changed', handler)
    }
  },

  // ─── 团队 Agent (v3.x) ─────────────────────────────────
  teamGetState: () =>
    ipcRenderer.invoke('team:get-state') as Promise<any>,

  teamTriggerSocial: (params: { message: string; sourceAgent?: string }) =>
    ipcRenderer.invoke('team:trigger-social', params) as Promise<any>,

  teamTriggerDecision: (params: { topic: string; options?: string[] }) =>
    ipcRenderer.invoke('team:trigger-decision', params) as Promise<any>,

  onTeamSocialMessage: (callback: (data: any) => void) => {
    const handler = (_event: any, data: any) => callback(data)
    ipcRenderer.on('team:social-message', handler)
    return () => {
      ipcRenderer.removeListener('team:social-message', handler)
    }
  },

  onTeamAgentSpeaking: (callback: (data: any) => void) => {
    const handler = (_event: any, data: any) => callback(data)
    ipcRenderer.on('team:agent-speaking', handler)
    return () => {
      ipcRenderer.removeListener('team:agent-speaking', handler)
    }
  },

  onTeamDiscussionStarted: (callback: (data: any) => void) => {
    const handler = (_event: any, data: any) => callback(data)
    ipcRenderer.on('team:discussion-started', handler)
    return () => {
      ipcRenderer.removeListener('team:discussion-started', handler)
    }
  },

  /** 👥 v9.3: 动态团队注册 */
  teamListMembers: () =>
    ipcRenderer.invoke('team:list-members') as Promise<any>,

  teamRegisterMember: (reg: any) =>
    ipcRenderer.invoke('team:register-member', reg) as Promise<any>,

  teamUnregisterMember: (id: string) =>
    ipcRenderer.invoke('team:unregister-member', id) as Promise<any>,

  // ─── 🤝 v3.20 团队协作（信箱 / 任务板 / 动态 worker / CU 策略）──
  collabMembers: () =>
    ipcRenderer.invoke('team-collab:members') as Promise<string[]>,

  collabMailboxInbox: (member: string, unreadOnly = true) =>
    ipcRenderer.invoke('team-collab:mailbox-inbox', member, unreadOnly) as Promise<any[]>,

  collabMailboxCounts: () =>
    ipcRenderer.invoke('team-collab:mailbox-counts') as Promise<Record<string, number>>,

  collabMailStream: () =>
    ipcRenderer.invoke('team-collab:mail-stream') as Promise<any[]>,

  collabMailboxMark: (member: string, ids?: string[]) =>
    ipcRenderer.invoke('team-collab:mailbox-mark', member, ids) as Promise<{ count: number }>,

  collabMailboxSend: (payload: { from: string; to: string; subject: string; body: string }) =>
    ipcRenderer.invoke('team-collab:mailbox-send', payload) as Promise<{ ok: boolean; id?: string }>,

  collabBoard: () =>
    ipcRenderer.invoke('team-collab:board') as Promise<any>,

  collabBoardHistory: (since?: number) =>
    ipcRenderer.invoke('team-collab:board-history', since) as Promise<any[]>,

  collabBoardList: (filter?: any) =>
    ipcRenderer.invoke('team-collab:board-list', filter) as Promise<any[]>,

  collabBoardAction: (action: string, payload: any) =>
    ipcRenderer.invoke('team-collab:board-action', action, payload) as Promise<any>,

  collabWorkers: () =>
    ipcRenderer.invoke('team-collab:workers') as Promise<any[]>,

  collabWorkerShutdown: (id: string) =>
    ipcRenderer.invoke('team-collab:worker-shutdown', id) as Promise<any>,

  collabMembersDetail: () =>
    ipcRenderer.invoke('team-collab:members-detail') as Promise<any[]>,

  collabCustomRoles: () =>
    ipcRenderer.invoke('team-collab:custom-roles') as Promise<any[]>,

  collabWorkflows: () =>
    ipcRenderer.invoke('team-collab:workflows') as Promise<any[]>,

  collabWorkflowGet: (id: string) =>
    ipcRenderer.invoke('team-collab:workflow-get', id) as Promise<any>,

  teachRecordStart: () =>
    ipcRenderer.invoke('teach:record-start') as Promise<any>,

  teachRecordStop: () =>
    ipcRenderer.invoke('teach:record-stop') as Promise<any>,

  teachSave: (payload: { name: string; description?: string; events: any[]; aggregateTyping?: boolean }) =>
    ipcRenderer.invoke('teach:save', payload) as Promise<any>,

  teachList: () =>
    ipcRenderer.invoke('teach:list') as Promise<any[]>,

  teachRemove: (id: string) =>
    ipcRenderer.invoke('teach:remove', id) as Promise<boolean>,

  teachReplay: (id: string) =>
    ipcRenderer.invoke('teach:replay', id) as Promise<any>,

  cuPolicyGet: () =>
    ipcRenderer.invoke('cu-policy:get') as Promise<any>,

  cuPolicySet: (patch: any) =>
    ipcRenderer.invoke('cu-policy:set', patch) as Promise<any>,

  cuPolicyGrant: (proc: string, level: string) =>
    ipcRenderer.invoke('cu-policy:grant', proc, level) as Promise<any>,

  cuPolicyRevoke: (proc: string) =>
    ipcRenderer.invoke('cu-policy:revoke', proc) as Promise<any>,

  cuPolicySession: () =>
    ipcRenderer.invoke('cu-policy:session') as Promise<any>,

  cuPolicyForeground: () =>
    ipcRenderer.invoke('cu-policy:foreground') as Promise<{ proc: string; title: string } | null>,
  // 跨平台能力矩阵：返回当前平台各功能是否可用 + 降级说明（platform:get-features）
  platformGetFeatures: () =>
    ipcRenderer.invoke('platform:get-features') as Promise<{ ok: boolean; matrix?: any; error?: string }>,

  // AI 主动推送（proactive:*）
  proactiveGetState: () =>
    ipcRenderer.invoke('proactive:get-state') as Promise<any>,
  proactiveGetSettings: () =>
    ipcRenderer.invoke('proactive:get-settings') as Promise<any>,
  proactiveUpdateSettings: (settings: any) =>
    ipcRenderer.invoke('proactive:update-settings', settings) as Promise<any>,
  proactivePushNow: () =>
    ipcRenderer.invoke('proactive:push-now') as Promise<{ should_speak: boolean; reason: string }>,
  proactiveToggle: (enabled: boolean) =>
    ipcRenderer.invoke('proactive:toggle', enabled) as Promise<{ enabled: boolean }>,
  proactiveUserActivity: () =>
    ipcRenderer.invoke('proactive:user-activity') as Promise<{ ok: boolean }>,

  // ─── v3.33 绩效画像 / 任务追踪 / 自治 / 检查点 / 团队日记 ───
  collabStatsProfiles: () =>
    ipcRenderer.invoke('team-collab:stats-profiles') as Promise<any>,

  collabStatsRank: (kind: string) =>
    ipcRenderer.invoke('team-collab:stats-rank', kind) as Promise<any[]>,

  collabTrace: (limit?: number) =>
    ipcRenderer.invoke('team-collab:trace', limit) as Promise<{ entries: any[]; summary: any }>,

  collabAutonomy: (action?: string) =>
    ipcRenderer.invoke('team-collab:autonomy', action) as Promise<any>,

  collabCheckpoints: () =>
    ipcRenderer.invoke('team-collab:checkpoints') as Promise<any[]>,

  collabCheckpointRollback: (id: string, confirm: boolean) =>
    ipcRenderer.invoke('team-collab:checkpoint-rollback', id, confirm) as Promise<any>,

  collabDailyLog: (date?: string) =>
    ipcRenderer.invoke('team-collab:daily-log', date) as Promise<any>,

  // ─── 主动技能 (v3.x) ───────────────────────────────────
  proactiveGetTriggers: () =>
    ipcRenderer.invoke('proactive:get-triggers') as Promise<Array<{ id: string; type: string; enabled: boolean; lastTriggered?: number; cooldown: number; priority: number }>>,

  onProactivePopup: (callback: (data: { id: string; message: string; type: string; timestamp: number }) => void) => {
    const handler = (_event: any, data: any) => callback(data)
    ipcRenderer.on('proactive:popup', handler)
    return () => {
      ipcRenderer.removeListener('proactive:popup', handler)
    }
  },

  // ─── Agent 事件 ────────────────────────────────────────
  onAgentEvent: (callback: (data: AgentEvent) => void) => {
    const handler = (_event: any, data: AgentEvent) => callback(data)
    ipcRenderer.on('agent:event', handler)
    return () => {
      ipcRenderer.removeListener('agent:event', handler)
    }
  },

  onAgentToolEvent: (callback: (data: { agentId: string; agentName: string; type: string; tool: string; args?: any; result?: any; timestamp: number }) => void) => {
    const handler = (_event: any, data: any) => callback(data)
    ipcRenderer.on('agent:tool-event', handler)
    return () => {
      ipcRenderer.removeListener('agent:tool-event', handler)
    }
  },

  /** 🧰 v1.0 工具箱: 实时语音对话入口 */
  agentStartRealtimeVoice: () =>
    ipcRenderer.invoke('team:start-realtime-voice') as Promise<{ success: boolean; message?: string; error?: string }>,

  /** 🧰 v1.0 工具箱: 停止实时语音对话 */
  agentStopRealtimeVoice: () =>
    ipcRenderer.invoke('team:stop-realtime-voice') as Promise<{ success: boolean; error?: string }>,

  /** 🧰 v1.0 工具箱: 实时语音对话状态 */
  agentRealtimeVoiceStatus: () =>
    ipcRenderer.invoke('team:realtime-voice-status') as Promise<{ active: boolean; error?: string }>,

  /** 🧰 v1.0 工具箱: Computer Use 模式入口 */
  agentStartComputerUse: () =>
    ipcRenderer.invoke('computer-use:start') as Promise<{ success: boolean; message?: string; error?: string }>,

  /** 🧰 v1.0 工具箱: Computer Use 停止 */
  agentStopComputerUse: () =>
    ipcRenderer.invoke('computer-use:stop') as Promise<{ success: boolean; error?: string }>,

  /** 🧰 v1.0 工具箱: Computer Use 状态 */
  agentComputerUseStatus: () =>
    ipcRenderer.invoke('computer-use:status') as Promise<{ active: boolean; running: boolean; error?: string }>,

  /** ✂ 截屏（落盘，返回路径）—— 输入栏「+ → 截图提问」用，agent 可再用文件工具打开 */
  agentScreenshot: () =>
    ipcRenderer.invoke('computer-use:screenshot') as Promise<{ success: boolean; path?: string; error?: string }>,

  /** 🧰 v1.0 工具箱: 同步角色配置到主进程 */
  teamSyncProfiles: (profiles: Array<{
    id: string; name: string; icon: string; role: string; description: string
    systemPrompt: string; capabilities: string[]
  }>) =>
    ipcRenderer.invoke('team:sync-profiles', profiles) as Promise<{ success: boolean; count?: number; error?: string }>,

  // ─── 缺失方法（从原始源码恢复）─────────────────────────
  /** 导航面板 */
  navigatePanel: (panelId: string) => {
    ipcRenderer.send('navigate:panel', panelId)
  },

  /** 关于 Lumina */
  showAbout: () => {
    ipcRenderer.invoke('window:show-about') as Promise<void>
  },

  // ─── 内置浏览器（用户可见窗口，Agent 用同一套工具驱动它） ──
  /** 打开/聚焦内置浏览器，可选先访问一个网址 */
  openBrowser: (url?: string) => ipcRenderer.invoke('browser:open', url) as Promise<{ ok: boolean; error?: string }>,
  /** 内置浏览器是否开着 */
  isBrowserOpen: () => ipcRenderer.invoke('browser:is-open') as Promise<{ ok: boolean; open: boolean }>,
  /** 关闭内置浏览器 */
  closeBrowserWindow: () => ipcRenderer.invoke('browser:close') as Promise<{ ok: boolean }>,

  // ─── 系统：外部打开 ──────────────────────────────────────
  /** 用系统默认浏览器/应用打开外链（交付物里的链接走这里） */
  openExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url) as Promise<boolean>,
  /** 用系统默认程序打开本地文件/目录（交付物里的文件走这里） */
  openPath: (targetPath: string) => ipcRenderer.invoke('shell:open-path', targetPath) as Promise<string>,

  // ─── 进度看板（图1 任务板） ─────────────────────────────
  /** 推送进度看板（主进程 / CLI / 外部工具灌进来） */
  onTaskBoard: (callback: (board: any) => void) => {
    const handler = (_e: any, board: any) => callback(board)
    ipcRenderer.on('task:board', handler)
    return () => { ipcRenderer.removeListener('task:board', handler) }
  },
  /** 读取当前进度看板 */
  getTaskBoard: () => ipcRenderer.invoke('task:board:get') as Promise<{ ok: boolean; board: any }>,
  /** 回写进度看板到主进程（CLI / 其他窗口据此读取） */
  setTaskBoard: (board: any) => ipcRenderer.send('task:board:set', board),

  /** 切换开发者工具 */
  toggleDevTools: () => {
    ipcRenderer.invoke('window:toggle-dev-tools') as Promise<void>
  },

  /** 监听开发者工具开关状态 */
  onDevToolsChanged: (callback: (opened: boolean) => void) => {
    const handler = (_event: any, opened: boolean) => callback(opened)
    ipcRenderer.on('window:devtools-changed', handler)
    return () => ipcRenderer.removeListener('window:devtools-changed', handler)
  },

  /** 主动引擎状态 */
  proactiveStatus: () =>
    ipcRenderer.invoke('proactive:status') as Promise<any>,

  /** 更新触发器 */
  proactiveUpdateTrigger: (id: string, updates: Record<string, any>) =>
    ipcRenderer.invoke('proactive:update-trigger', id, updates) as Promise<{ ok: boolean }>,

  /** 测试触发器 */
  proactiveTestTrigger: (id: string) =>
    ipcRenderer.invoke('proactive:test-trigger', id) as Promise<{ ok: boolean; error?: string }>,

  /** 更新主动配置 */
  proactiveUpdateConfig: (config: Record<string, any>) =>
    ipcRenderer.invoke('proactive:update-config', config) as Promise<{ ok: boolean }>,

  /** 设置通知 */
  proactiveSetNotify: (enabled: boolean) =>
    ipcRenderer.invoke('proactive:setNotify', enabled) as Promise<{ ok: boolean }>,

  /** 心跳 */
  proactiveHeartbeat: () =>
    ipcRenderer.invoke('proactive:heartbeat') as Promise<{ ok: boolean }>,

  /** 朋友圈时间线 */
  momentsTimeline: (params?: { limit?: number; offset?: number; agentId?: string; type?: string }) =>
    ipcRenderer.invoke('moments:timeline', params) as Promise<{ moments: any[]; total: number }>,

  /** 监听朋友圈新动态 */
  onMomentPosted: (callback: (moment: any) => void) => {
    const handler = (_event: any, moment: any) => callback(moment)
    ipcRenderer.on('moments:new-moment', handler)
    return () => {
      ipcRenderer.removeListener('moments:new-moment', handler)
    }
  },

  /** 点赞朋友圈 */
  momentsLike: (momentId: number, agentId: string) =>
    ipcRenderer.invoke('moments:like', momentId, agentId) as Promise<{ liked: boolean; likeCount: number }>,

  /** 发布朋友圈 */
  momentsPost: (params: { agentId: string; agentName: string; content: string; type?: string }) =>
    ipcRenderer.invoke('moments:post', params) as Promise<{ ok: boolean; moment?: any; error?: string }>,

  /** 删除朋友圈 */
  momentsDelete: (id: number) =>
    ipcRenderer.invoke('moments:delete', id) as Promise<{ ok: boolean }>,

  /** 查看评论 */
  momentsComments: (momentId: number) =>
    ipcRenderer.invoke('moments:comments', momentId) as Promise<{ comments: any[] }>,

  /** 执行命令 */
  commandExecute: (text: string) =>
    ipcRenderer.invoke('command:execute', text) as Promise<{ content?: string; error?: string }>,

  /** 监听审批请求 */
  onApprovalRequested: (callback: (req: any) => void) => {
    const handler = (_event: any, req: any) => callback(req)
    ipcRenderer.on('approval:requested', handler)
    return () => {
      ipcRenderer.removeListener('approval:requested', handler)
    }
  },

  /** 监听审批结果 */
  onApprovalResolved: (callback: (res: any) => void) => {
    const handler = (_event: any, res: any) => callback(res)
    ipcRenderer.on('approval:resolved', handler)
    return () => {
      ipcRenderer.removeListener('approval:resolved', handler)
    }
  },

  /** 🆕 v2.0: 更新审批配置（沙箱模式等） */
  approvalUpdateConfig: (config: any) =>
    ipcRenderer.invoke('approval:update-config', config) as Promise<{ ok: boolean }>,

  // ── 🌙 Dream System ──────────────────────────────────
  dreamList: () => ipcRenderer.invoke('dream:list'),
  dreamRecent: (count?: number) => ipcRenderer.invoke('dream:recent', count),
  dreamGet: (date: string) => ipcRenderer.invoke('dream:get', date),
  dreamDelete: (id: string) => ipcRenderer.invoke('dream:delete', id),
  dreamStats: () => ipcRenderer.invoke('dream:stats'),
  dreamGenerate: () => ipcRenderer.invoke('dream:generate'),
  onDreamNew: (callback: (dream: any) => void) => {
    const handler = (_event: any, dream: any) => callback(dream)
    ipcRenderer.on('dream:new', handler)
    return () => { ipcRenderer.removeListener('dream:new', handler) }
  },

  // 副人格冲突事件监听
  onPersonalityConflict: (callback: (conflict: any) => void) => {
    const handler = (_event: any, conflict: any) => callback(conflict)
    ipcRenderer.on('personality:conflict', handler)
    return () => { ipcRenderer.removeListener('personality:conflict', handler) }
  },

  // ── 📱 Push System ──────────────────────────────────
  pushUpdateConfig: (config: any) => ipcRenderer.invoke('push:update-config', config),
  pushGetConfig: () => ipcRenderer.invoke('push:get-config'),
  pushTestServerChan: (key: string) => ipcRenderer.invoke('push:test-serverchan', key),
  pushTestDingTalk: (webhook: string, secret: string) => ipcRenderer.invoke('push:test-dingtalk', webhook, secret),

  // ── 💻 Pet Window (v2.0 Plan C) ──────────────────
  petToggle: (enable: boolean) => ipcRenderer.invoke('pet:toggle', enable),
  petStatus: () => ipcRenderer.invoke('pet:status'),
  petConfig: () => ipcRenderer.invoke('pet:config'),
  petUpdateConfig: (config: any) => ipcRenderer.invoke('pet:update-config', config),
  petSettings: (cfg: any) => ipcRenderer.invoke('pet:settings', cfg),
  petTestIntent: (intent: any) => ipcRenderer.invoke('pet:test-intent', intent),
  petGetModel: () => ipcRenderer.invoke('pet:get-model'),
  petPrefs: () => ipcRenderer.invoke('pet:prefs'),
  petUpdatePrefs: (patch: any) => ipcRenderer.invoke('pet:update-prefs', patch),
  petOpenSettings: () => ipcRenderer.invoke('pet:open-settings'),
  petOpenOnboarding: () => ipcRenderer.invoke('pet:open-onboarding'),
  /** 打开独立可拖动聊天窗口 */
  petOpenChatWindow: () => ipcRenderer.invoke('pet:open-chat-window'),
  /** 监听桌宠开关状态广播（主进程 toggle 时推送） */
  onPetState: (callback: (running: boolean) => void) => {
    const handler = (_event: any, running: boolean) => callback(running)
    ipcRenderer.on('pet:state', handler)
    return () => { ipcRenderer.removeListener('pet:state', handler) }
  },
  /** 监听桌宠启动进度（0-100 + 阶段文字） */
  onPetStartupProgress: (callback: (progress: number, stage: string) => void) => {
    const handler = (_event: any, data: { progress: number; stage: string }) => callback(data.progress, data.stage)
    ipcRenderer.on('pet:startup-progress', handler)
    return () => { ipcRenderer.removeListener('pet:startup-progress', handler) }
  },
  /** 桌宠 → 主窗口：发送同步消息 */
  petSyncSend: (text: string) => ipcRenderer.send('pet:sync-send', { text }),
  /** 主窗口 → 桌宠：发送 Agent 回复 */
  petSyncReply: (text: string, role: string) => ipcRenderer.send('pet:sync-reply', { text, role }),
  /**
   * 主窗口 → 桌宠：转发本次 Agent 请求的**推理过程**（thinking / tool_*）。
   *
   * 🆕 2026-10-17：桌宠聊天窗此前只有「三个点」等待动画，看不到任何推理与工具调用，
   *   和主聊天面板的思考过程完全不像同一个产品。而 `agent:event` 只发给**发起请求的
   *   窗口**（这里是主窗口，PetChatSync 在其中），桌宠窗收不到。
   *   所以由主窗口订阅事件、按 requestId 过滤后，经本通道中转给桌宠窗。
   */
  petSyncTrace: (payload: { kind: string; text?: string; tool?: string; detail?: string; ok?: boolean; stream?: boolean }) =>
    ipcRenderer.send('pet:chat-trace', payload),
  /** 主窗口 → 桌宠：发送历史记录 */
  petSendHistory: (messages: Array<{ role: string; content: string }>) => ipcRenderer.send('pet:sync-history-reply', messages),
  /** 桌宠 → 主窗口：请求历史聊天记录 */
  petRequestHistory: () => ipcRenderer.send('pet:sync-history-request'),

  // ── 🗑 会话删除（2026-10-18）──────────────────────────────────
  //
  // 背景：桌宠聊天窗右上角那个垃圾桶此前只调 `clearChat()` 清空 DOM ——
  //   后端 store 里的会话与消息一条没动，下次拉历史又全回来，用户感知是
  //   「点了删除但没删掉」。而会话本身住在**主窗口**的 zustand store 里，
  //   桌宠窗是独立 BrowserWindow，够不到。所以需要这四个通道做中转：
  //     pet:conv-list-request  桌宠窗 → 主窗口   要会话清单
  //     pet:conv-list          主窗口 → 桌宠窗   回清单
  //     pet:conv-delete        桌宠窗 → 主窗口   执行删除
  //     pet:conv-changed       主窗口 → 桌宠窗   删完了，请清屏重拉
  /** 桌宠窗 → 主窗口：请求会话清单（用于"选择要删除的对话"） */
  petRequestConvList: () => ipcRenderer.send('pet:conv-list-request'),
  /** 主窗口 → 桌宠窗：回会话清单 */
  petSendConvList: (list: Array<{ id: string; name: string; count: number; isPet?: boolean }>) =>
    ipcRenderer.send('pet:conv-list', list),
  /** 桌宠窗 → 主窗口：执行删除（scope: current=清空当前会话 / select=删选中 / all=全删） */
  petDeleteConvs: (payload: { scope: 'current' | 'select' | 'all'; ids?: string[] }) =>
    ipcRenderer.send('pet:conv-delete', payload),
  /** 主窗口 → 桌宠窗：会话已变更（请清屏并重新拉历史） */
  petNotifyConvChanged: () => ipcRenderer.send('pet:conv-changed'),
  /** 主窗口监听：桌宠窗要会话清单 */
  onPetConvListRequest: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('pet:conv-list-request', handler)
    return () => { ipcRenderer.removeListener('pet:conv-list-request', handler) }
  },
  /** 桌宠窗监听：收到会话清单 */
  onPetConvList: (callback: (list: Array<{ id: string; name: string; count: number; isPet?: boolean }>) => void) => {
    const handler = (_event: any, list: Array<{ id: string; name: string; count: number; isPet?: boolean }>) => callback(list)
    ipcRenderer.on('pet:conv-list', handler)
    return () => { ipcRenderer.removeListener('pet:conv-list', handler) }
  },
  /** 主窗口监听：桌宠窗请求删除 */
  onPetConvDelete: (callback: (payload: { scope: 'current' | 'select' | 'all'; ids?: string[] }) => void) => {
    const handler = (_event: any, payload: { scope: 'current' | 'select' | 'all'; ids?: string[] }) => callback(payload)
    ipcRenderer.on('pet:conv-delete', handler)
    return () => { ipcRenderer.removeListener('pet:conv-delete', handler) }
  },
  /** 桌宠窗监听：会话已变更 */
  onPetConvChanged: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('pet:conv-changed', handler)
    return () => { ipcRenderer.removeListener('pet:conv-changed', handler) }
  },

  // ── 🪟 桌宠聊天窗顶栏 / 任务列表 / 动作中转（2026-10-18）──────────
  //
  // 会话与任务工作区的数据都住在**主窗口**的 zustand store 里，桌宠窗够不到。
  // 所以「任务列表」「打开对话产物」「实时语音」「AI 操作电脑」这类动作
  // 统一由桌宠窗发意图 → 主进程中转 → 主窗口 PetChatSync 执行 → 回结果。
  /** 主窗口 → 桌宠窗：任务列表数据（对话产物 / 技能 / 最近文件） */
  petSendTaskList: (data: {
    artifacts: Array<{ id: string; filename: string; kind?: string }>
    skills: string[]
    recentFiles: Array<{ id: string; filename: string; filePath?: string }>
  }) => ipcRenderer.send('pet:ui:tasklist', data),
  /** 主窗口监听：桌宠窗请求任务列表 */
  onPetUiTaskListRequest: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('pet:ui:tasklist-request', handler)
    return () => { ipcRenderer.removeListener('pet:ui:tasklist-request', handler) }
  },
  /** 主窗口 → 桌宠窗：动作执行结果 */
  petUiActionResult: (data: { kind: string; ok: boolean; message?: string }) =>
    ipcRenderer.send('pet:ui:action-result', data),
  /** 主窗口监听：桌宠窗发来的动作 */
  onPetUiAction: (callback: (payload: { kind: string; [k: string]: unknown }) => void) => {
    const handler = (_event: any, payload: { kind: string; [k: string]: unknown }) => callback(payload)
    ipcRenderer.on('pet:ui:action', handler)
    return () => { ipcRenderer.removeListener('pet:ui:action', handler) }
  },
  /** 主窗口监听：「在主窗口中打开」—— 切到桌宠对话并让输入框就绪 */
  onPetUiOpenMain: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('pet:ui:open-main', handler)
    return () => { ipcRenderer.removeListener('pet:ui:open-main', handler) }
  },
  /** 主窗口 → 主进程：回传桌宠请求的朋友圈/剧场/日报数据 */
  lifeProvideData: (payload: { reqId: string; items: Array<{ title: string; body?: string; meta?: string; icon?: string }> }) =>
    ipcRenderer.send('life:data-response', payload),
  /** 主窗口监听桌宠发来的同步消息 */
  onPetSyncMessage: (callback: (data: { text: string; from: string }) => void) => {
    const handler = (_event: any, data: { text: string; from: string }) => callback(data)
    ipcRenderer.on('pet:sync-message', handler)
    return () => { ipcRenderer.removeListener('pet:sync-message', handler) }
  },
  /** 主窗口监听桌宠请求历史记录 */
  onPetHistoryRequest: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('pet:sync-history-request', handler)
    return () => { ipcRenderer.removeListener('pet:sync-history-request', handler) }
  },
  /** 桌宠监听历史记录回复 */
  onPetHistoryReply: (callback: (messages: Array<{ role: string; content: string }>) => void) => {
    const handler = (_event: any, messages: Array<{ role: string; content: string }>) => callback(messages)
    ipcRenderer.on('pet:sync-history-reply', handler)
    return () => { ipcRenderer.removeListener('pet:sync-history-reply', handler) }
  },
  /** 监听桌宠事件（点击/双击/闲时等） */
  onPetEvent: (callback: (event: any) => void) => {
    const handler = (_event: any, evt: any) => callback(evt)
    ipcRenderer.on('pet:event', handler)
    return () => { ipcRenderer.removeListener('pet:event', handler) }
  },

  // ── 🎬 Agent 真人秀 ──────────────────────────────
  realityHistory: (count?: number) => ipcRenderer.invoke('reality:history', count),
  realityTrigger: (event?: any) => ipcRenderer.invoke('reality:trigger', event),
  realityStatus: () => ipcRenderer.invoke('reality:status'),
  realityRestart: (intervalMs?: number) => ipcRenderer.invoke('reality:restart', intervalMs),
  onRealityEvent: (callback: (event: any) => void) => {
    const handler = (_event: any, evt: any) => callback(evt)
    ipcRenderer.on('reality:show:event', handler)
    return () => { ipcRenderer.removeListener('reality:show:event', handler) }
  },

  // ── 🔬 可观测性 IPC（记忆审判台 + 团队泳道画布）──────────
  // 🔧 2026-10-04：这两个面板写完时**模块外零引用** —— 有单测、有 UI，
  //   但没有 IPC、没有 preload、没有挂载，运行时一行都执行不到。
  //   与 SkillMarketPanel 那个 bug 同类，所以这次把三层一并接上并加守卫测试。
  memoryTrialReview: () =>
    ipcRenderer.invoke('memory-trial:review') as Promise<{ ok: boolean; items?: any[]; error?: string }>,
  memoryTrialSubmit: (payload: { memoryKey: string; verdict: string; reason?: string }) =>
    ipcRenderer.invoke('memory-trial:submit', payload) as Promise<{ ok: boolean; result?: any; error?: string }>,
  memoryTrialStats: () =>
    ipcRenderer.invoke('memory-trial:stats') as Promise<{ ok: boolean; stats?: any; error?: string }>,
  memoryTrialHistory: (memoryKey?: string) =>
    ipcRenderer.invoke('memory-trial:history', memoryKey) as Promise<{ ok: boolean; records?: any[]; error?: string }>,
  /** 泳道图数据。形状是嵌套对象，因为 SwimlaneCanvas 按 `swimlane.get()` 取 */
  swimlane: {
    get: () => ipcRenderer.invoke('swimlane:get') as Promise<any>,
  },
  /**
   * 🩺 系统诊断 / 模型体检。
   *
   * 🔧 2026-10-07：DiagnosticsPanel 此前调用 `window.electronAPI.ipcInvoke(...)`，
   *   而 preload 里**从不存在**这个通用通道 → 面板静默退回 mockData（假数据），
   *   且它根本没在 App.tsx 注册（孤儿面板）。同时主进程的 diagnostics:* 通道
   *   （含 2026-10-05 新增的模型体检）**一个都没暴露**。
   *   现在按 luminaAPI 约定正式暴露，面板接上真实数据。
   */
  diagnostics: {
    summary: () => ipcRenderer.invoke('diagnostics:summary') as Promise<any>,
    quickCheck: () => ipcRenderer.invoke('diagnostics:quick-check') as Promise<any>,
    timeline: (limit?: number) => ipcRenderer.invoke('diagnostics:timeline', limit) as Promise<any>,
    latency: (windowMinutes?: number) =>
      ipcRenderer.invoke('diagnostics:latency', windowMinutes) as Promise<any>,
    toolCalls: (limit?: number) => ipcRenderer.invoke('diagnostics:tool-calls', limit) as Promise<any>,
    clear: () => ipcRenderer.invoke('diagnostics:clear') as Promise<any>,
    exportReport: () => ipcRenderer.invoke('diagnostics:export-report') as Promise<any>,
    /** 🩺 模型体检报告（结构化）—— 参数缺省时主进程会要求先配置模型 */
    modelHealth: (params: { modelName?: string; baseUrl?: string; userContextWindow?: number | null }) =>
      ipcRenderer.invoke('diagnostics:modelHealth', params) as Promise<any>,
    /** 🩺 模型体检报告（纯文本）—— 供「复制报告」按钮 */
    modelHealthText: (params: { modelName?: string; baseUrl?: string; userContextWindow?: number | null }) =>
      ipcRenderer.invoke('diagnostics:modelHealthText', params) as Promise<string>,
  },
  /**
   * 🎨 桌宠 UGC 精灵表。
   * 【为什么需要】spriteSheet.ts 里有完整规格与 AI 提示词生成器，
   *   但它经 modelImporter 拉进了 adm-zip / node:fs，渲染进程不能直接 import。
   *   这里把「规格 + 提示词」暴露给 gallery 面板。
   */
  sprite: {
    spec: () => ipcRenderer.invoke('sprite:spec') as Promise<any>,
    prompt: (opts?: { subject?: string; style?: string; frameW?: number; frameH?: number }) =>
      ipcRenderer.invoke('sprite:prompt', opts) as Promise<{ ok: boolean; prompt?: string; error?: string }>,
    quickPrompt: (subject?: string) =>
      ipcRenderer.invoke('sprite:quickPrompt', subject) as Promise<{ ok: boolean; prompt?: string; error?: string }>,
  },
  /**
   * 团队情绪（情绪仪表盘）。
   * 🔧 2026-10-04：EmotionDashboardPanel 此前调用 `teamEmotions()` 但 preload 里
   *   **从来不存在**（且用 `?.` 所以静默 no-op），面板永远空白。
   *   现在补上，数据来自真实的 worker 失败连击 + 因果状态，不是假曲线。
   */
  teamEmotions: () =>
    ipcRenderer.invoke('team:emotions') as Promise<{
      ok: boolean
      hasLiveData?: boolean
      emotions?: Record<string, {
        mood: number
        energy: number
        affinity: number
        label: string
        failureStreak: number
        history: Array<{ time: number; mood: number; energy: number }>
      }>
      error?: string
    }>,

  // ── 📦 Skill 市场 IPC ──────────────────────────────
  // 🔧 2026-10-04：这些通道主进程早就注册了（skillMarketIpc.ts 共 17 个），
  //   但**一个都没在 preload 暴露**。SkillMarketPanel 于是绕道
  //   `(window as any).electron.ipcRenderer.invoke(...)`，
  //   而 preload 根本没有 `window.electron` 这个通道 ——
  //   每次调用都会抛 `Cannot read properties of undefined`。
  //   结论：**整个技能市场面板是死的**，界面能渲染、按钮点了没反应。
  //   现在把通道按 luminaAPI 的约定正式暴露。
  skillMarketInstalled: () =>
    ipcRenderer.invoke('skill-market:installed') as Promise<any>,
  skillMarketSearch: (query: string, category?: string) =>
    ipcRenderer.invoke('skill-market:search', query, category) as Promise<any>,
  skillMarketModelScopeSearch: (query: string, category?: string) =>
    ipcRenderer.invoke('skill-market:modelscope-search', query, category) as Promise<any>,
  skillMarketInstallCommunity: (skillId: string) =>
    ipcRenderer.invoke('skill-market:install-community', skillId) as Promise<any>,
  skillMarketInstallLocal: () =>
    ipcRenderer.invoke('skill-market:install-local') as Promise<any>,
  skillMarketUninstall: (skillId: string) =>
    ipcRenderer.invoke('skill-market:uninstall', skillId) as Promise<any>,
  skillMarketToggle: (skillId: string, enabled: boolean) =>
    ipcRenderer.invoke('skill-market:toggle', skillId, enabled) as Promise<any>,
  /**
   * 远端注册表健康度。
   * 【为什么要单独暴露】搜索结果会把远端与静态索引**合并**返回，
   * 所以「远端挂了」在结果里看不见 —— 用户只看到一市场内置技能，
   * 却不知道为什么没有第三方的。UI 拿到这个才能如实告知。
   */
  skillMarketRegistryHealth: () =>
    ipcRenderer.invoke('skill-market:registry-health') as Promise<{
      lastCheckedAt: number
      reachable: boolean
      source: string
      detail: string
    }>,

  // ── 📦 Skill SDK ──────────────────────────────────
  skillSDKGenerate: (params: any) => ipcRenderer.invoke('skill-sdk:generate', params),
  skillSDKExport: (dirName: string, files: any) => ipcRenderer.invoke('skill-sdk:export', dirName, files),
  skillSDKHelp: () => ipcRenderer.invoke('skill-sdk:help'),

  // ── 🧪 Test Runner ──────────────────────────────────
  testSummary: () => ipcRenderer.invoke('test:summary'),
  testRun: () => ipcRenderer.invoke('test:run'),

  // ── 📊 报告持久化 (日报/周报/月报) ──────────────────
  reportSave: (params: { type: string; title: string; summary: string; content: string; period: string }) =>
    ipcRenderer.invoke('reports:save', params) as Promise<{ ok: boolean; report?: any; error?: string }>,
  reportList: (params?: { type?: string; limit?: number; offset?: number }) =>
    ipcRenderer.invoke('reports:list', params) as Promise<{ reports: any[]; total: number }>,
  reportLatest: (type?: string) =>
    ipcRenderer.invoke('reports:latest', type) as Promise<{ report: any | null }>,

  // 第二阶段: 场景模式
  modeGet: () => ipcRenderer.invoke('mode:get') as Promise<any>,
  modeSet: (mode: string) => ipcRenderer.invoke('mode:set', mode) as Promise<{ ok: boolean; mode?: any; error?: string }>,
  modeConfig: (mode?: string) => ipcRenderer.invoke('mode:config', mode) as Promise<any>,
  modeUpdateConfig: (mode: string, overrides: any) => ipcRenderer.invoke('mode:update-config', mode, overrides) as Promise<{ ok: boolean; error?: string }>,
  modeAllConfigs: () => ipcRenderer.invoke('mode:all-configs') as Promise<any>,
  modeReleaseOverride: () => ipcRenderer.invoke('mode:release-override') as Promise<{ ok: boolean }>,
  modeDetectNow: () => ipcRenderer.invoke('mode:detect-now') as Promise<any>,
  // 自定义模式 CRUD
  modeCustomCreate: (meta: any) => ipcRenderer.invoke('mode:custom-create', meta) as Promise<{ ok: boolean; mode?: any; error?: string }>,
  modeCustomDelete: (id: string) => ipcRenderer.invoke('mode:custom-delete', id) as Promise<{ ok: boolean; error?: string }>,
  modeCustomList: () => ipcRenderer.invoke('mode:custom-list') as Promise<{ ok: boolean; modes: any[]; error?: string }>,
  // 工作流模板
  workflowList: () => ipcRenderer.invoke('workflow:list') as Promise<{ ok: boolean; templates: any[]; error?: string }>,
  workflowGet: (id: string) => ipcRenderer.invoke('workflow:get', id) as Promise<{ ok: boolean; template?: any; error?: string }>,
  workflowCreate: (data: any) => ipcRenderer.invoke('workflow:create', data) as Promise<{ ok: boolean; template?: any; error?: string }>,
  workflowUpdate: (id: string, data: any) => ipcRenderer.invoke('workflow:update', id, data) as Promise<{ ok: boolean; template?: any; error?: string }>,
  workflowDelete: (id: string) => ipcRenderer.invoke('workflow:delete', id) as Promise<{ ok: boolean; error?: string }>,
  workflowActivate: (id: string) => ipcRenderer.invoke('workflow:activate', id) as Promise<{ ok: boolean; template?: any; error?: string }>,
  workflowSearch: (query: string) => ipcRenderer.invoke('workflow:search', query) as Promise<{ ok: boolean; templates: any[]; error?: string }>,
  // 面板插件系统
  panelList: (placement?: string) => ipcRenderer.invoke('panel:list', placement) as Promise<{ ok: boolean; panels: any[]; error?: string }>,
  panelGet: (id: string) => ipcRenderer.invoke('panel:get', id) as Promise<{ ok: boolean; panel?: any; error?: string }>,
  panelListAll: () => ipcRenderer.invoke('panel:list-all') as Promise<{ ok: boolean; panels: any[]; error?: string }>,
  panelSetEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke('panel:set-enabled', id, enabled) as Promise<{ ok: boolean; error?: string }>,
  panelRegister: (reg: any) => ipcRenderer.invoke('panel:register', reg) as Promise<{ ok: boolean; panel?: any; error?: string }>,
  panelUnregister: (id: string) => ipcRenderer.invoke('panel:unregister', id) as Promise<{ ok: boolean; error?: string }>,
  // ACP 解耦
  acpRegister: (config: any) => ipcRenderer.invoke('acp:register', config) as Promise<{ ok: boolean; error?: string }>,
  acpUpdate: (id: string, updates: any) => ipcRenderer.invoke('acp:update', id, updates) as Promise<{ ok: boolean; error?: string }>,
  acpList: () => ipcRenderer.invoke('acp:list') as Promise<{ ok: boolean; builtIn: any[]; dynamic: any[]; error?: string }>,
  acpUnregister: (id: string) => ipcRenderer.invoke('acp:unregister', id) as Promise<{ ok: boolean; error?: string }>,
  acpSendMessage: (id: string, message: string) => ipcRenderer.invoke('acp:send-message', id, message) as Promise<{ ok: boolean; response?: string; error?: string }>,
  modeScene: () => ipcRenderer.invoke('mode:scene') as Promise<any>,
  onModeChanged: (callback: (data: any) => void) => {
    const handler = (_event: any, data: any) => callback(data)
    ipcRenderer.on('mode:changed', handler)
    return () => { ipcRenderer.removeListener('mode:changed', handler) }
  },
  onModeSceneUpdate: (callback: (data: any) => void) => {
    const handler = (_event: any, data: any) => callback(data)
    ipcRenderer.on('mode:scene-update', handler)
    return () => { ipcRenderer.removeListener('mode:scene-update', handler) }
  },

  // 第三阶段: 使用数据统计 IPC
  usageToday: () => ipcRenderer.invoke('usage:today') as Promise<any>,
  usageRecentDays: (days: number) => ipcRenderer.invoke('usage:recent-days', days) as Promise<any>,
  usageRecentSwitches: (limit?: number) => ipcRenderer.invoke('usage:recent-switches', limit) as Promise<any>,
  usageRecentProactive: (limit?: number) => ipcRenderer.invoke('usage:recent-proactive', limit) as Promise<any>,
  usageModeDistribution: () => ipcRenderer.invoke('usage:mode-distribution') as Promise<any>,
  usageAllData: () => ipcRenderer.invoke('usage:all-data') as Promise<any>,
  usageReset: () => ipcRenderer.invoke('usage:reset') as Promise<{ ok: boolean; error?: string }>,

  // 新闻采集与推送（已有 IPC handler）
  newsCollect: () => ipcRenderer.invoke('news:collect') as Promise<any>,
  /** 「为你推荐」轻量榜单（10 分钟缓存，不跑 LLM 筛选） */
  newsRecommend: (opts?: { limit?: number; force?: boolean }) => ipcRenderer.invoke('news:recommend', opts) as Promise<{
    ok: boolean
    cached?: boolean
    stale?: boolean
    items: Array<{ title: string; url: string; source: string; category: string; pubDate: string; hotScore: number }>
    error?: string
  }>,
  /** 「为你推荐」AI 精选：LLM 按兴趣重排 + 推荐理由（后台异步，失败返回空） */
  newsRecommendSmart: (opts?: { limit?: number; force?: boolean }) => ipcRenderer.invoke('news:recommend:smart', opts) as Promise<{
    ok: boolean
    cached?: boolean
    reason?: string
    items: Array<{
      title: string; url: string; source: string; category: string
      pubDate: string; hotScore: number; reason: string; score: number
    }>
    error?: string
  }>,
  newsPushToMail: () => ipcRenderer.invoke('news:push-to-mail') as Promise<{ ok: boolean; count?: number; error?: string }>,
  newsCollectAndPush: () => ipcRenderer.invoke('news:collect-and-push') as Promise<any>,

  // 新闻推送配置 IPC
  newsDigestGetConfig: () => ipcRenderer.invoke('news-digest:get-config') as Promise<any>,
  newsDigestUpdateConfig: (config: any) => ipcRenderer.invoke('news-digest:update-config', config) as Promise<{ ok: boolean; error?: string }>,
  newsDigestTrigger: (slot?: number) => ipcRenderer.invoke('news-digest:trigger', slot) as Promise<{ ok: boolean; error?: string }>,
  newsDigestResetCooldown: () => ipcRenderer.invoke('news-digest:reset-cooldown') as Promise<{ ok: boolean }>,

  // v2.0: 系统弹窗通知权限
  newsDigestNotifyPermission: () => ipcRenderer.invoke('news-digest:notify-permission') as Promise<{ ok: boolean; permission: string; error?: string }>,
  newsDigestRequestNotifyPermission: () => ipcRenderer.invoke('news-digest:notify-request-permission') as Promise<{ ok: boolean; permission: string; error?: string }>,

  // 新闻源信息（供前端展示可用新闻源列表）
  newsSourcesGetAvailable: () => ipcRenderer.invoke('news-sources:get-available') as Promise<any[]>,

  // 「雷达」：实时行情
  newsFetchQuotes: () => ipcRenderer.invoke('news:fetch-quotes') as Promise<{
    ok: boolean
    error?: string
    indices: any[]
    stocks: any[]
    updatedAt?: string
  }>,

  // 游戏化系统
  gamificationStats: () => ipcRenderer.invoke('gamification:stats') as Promise<any>,
  gamificationAchievements: () => ipcRenderer.invoke('gamification:achievements') as Promise<any>,

  // 🆕 Phase 2: 情绪 × XP 联动
  gamificationEmotionXp: () => ipcRenderer.invoke('gamification:getEmotionXp') as Promise<{ success: boolean; multiplier: number; label: string; emotion: { mood: number; energy: number; affinity: number } }>,

  // 每日任务
  gamificationQuests: () => ipcRenderer.invoke('gamification:quests') as Promise<any>,
  gamificationQuestsUpdateProgress: (stats: any) => ipcRenderer.invoke('gamification:quests-update-progress', stats) as Promise<any>,
  gamificationQuestsClaim: (questId: string) => ipcRenderer.invoke('gamification:quests-claim', questId) as Promise<{ ok: boolean; error?: string }>,
  gamificationQuestsClaimStreak: () => ipcRenderer.invoke('gamification:quests-claim-streak') as Promise<{ bonus: number; error?: string }>,

  // 新闻 MCP 工具
  newsMCPCollect: () => ipcRenderer.invoke('news-mcp:collect') as Promise<any>,
  newsMCPFetchFull: (url: string) => ipcRenderer.invoke('news-mcp:fetch-full', url) as Promise<any>,
  newsMCPGenerateDigest: (maxItems?: number, includeEnglish?: boolean) => ipcRenderer.invoke('news-mcp:generate-digest', maxItems, includeEnglish) as Promise<any>,
  newsMCPManageSubscription: (action: string, email?: string) => ipcRenderer.invoke('news-mcp:manage-subscription', action, email) as Promise<any>,
  newsMCPPublishSite: (source: string, date?: string) => ipcRenderer.invoke('news-mcp:publish-site', source, date) as Promise<any>,

  // 新闻推送事件（刷新面板）
  onNewsDigestPushed: (callback: (data: any) => void) => {
    const handler = (_event: any, data: any) => callback(data)
    ipcRenderer.on('news:digest-pushed', handler)
    return () => ipcRenderer.removeListener('news:digest-pushed', handler)
  },

  // 导航事件（通知点击跳转）
  onNavigate: (callback: (route: string) => void) => {
    const handler = (_event: any, route: string) => callback(route)
    ipcRenderer.on('navigate', handler)
    return () => ipcRenderer.removeListener('navigate', handler)
  },

  // 每日任务更新事件
  onQuestsUpdated: (callback: (data: any) => void) => {
    const handler = (_event: any, data: any) => callback(data)
    ipcRenderer.on('gamification:quests-updated', handler)
    return () => ipcRenderer.removeListener('gamification:quests-updated', handler)
  },

  // 🎮 游戏化事件监听
  onAchievementUnlocked: (callback: (achievement: any) => void) => {
    const handler = (_event: any, achievement: any) => callback(achievement)
    ipcRenderer.on('gamification:achievement', handler)
    return () => ipcRenderer.removeListener('gamification:achievement', handler)
  },
  onLevelUp: (callback: (data: any) => void) => {
    const handler = (_event: any, data: any) => callback(data)
    ipcRenderer.on('gamification:level-up', handler)
    return () => ipcRenderer.removeListener('gamification:level-up', handler)
  },
  onXpGained: (callback: (data: any) => void) => {
    const handler = (_event: any, data: any) => callback(data)
    ipcRenderer.on('gamification:xp', handler)
    return () => ipcRenderer.removeListener('gamification:xp', handler)
  },

  // 📧 SMTP 邮件配置（真实邮件推送）
  smtpGetConfig: () => ipcRenderer.invoke('mail:smtp:get') as Promise<any>,
  smtpSetConfig: (patch: Record<string, any>) => ipcRenderer.invoke('mail:smtp:set', patch) as Promise<{ ok: boolean; config?: any; error?: string }>,
  smtpResetConfig: () => ipcRenderer.invoke('mail:smtp:reset') as Promise<{ ok: boolean; config?: any; error?: string }>,

  // 🍀 Lucky 模式 (v1.0)
  luckyModeGetConfig: () => ipcRenderer.invoke('lucky-mode:get-config') as Promise<any>,
  luckyModeSaveConfig: (config: any) => ipcRenderer.invoke('lucky-mode:save-config', config) as Promise<{ success: boolean }>,
  luckyModeGetState: () => ipcRenderer.invoke('lucky-mode:get-state') as Promise<any>,
  luckyModeSetPreset: (preset: string) => ipcRenderer.invoke('lucky-mode:set-preset', preset) as Promise<{ success: boolean }>,
  luckyModeResetState: () => ipcRenderer.invoke('lucky-mode:reset-state') as Promise<{ success: boolean }>,
  luckyModePause: (reason: string) => ipcRenderer.invoke('lucky-mode:pause', reason) as Promise<{ success: boolean }>,
  luckyModeResume: () => ipcRenderer.invoke('lucky-mode:resume') as Promise<{ success: boolean }>,
  luckyModeIncrementIteration: () => ipcRenderer.invoke('lucky-mode:increment-iteration') as Promise<{ success: boolean }>,

  // 📡 渠道配置
  channelGetConfigs: () => ipcRenderer.invoke('channel:get-configs') as Promise<any>,
  channelUpdateConfig: (key: string, config: any) => ipcRenderer.invoke('channel:update-config', key, config) as Promise<{ ok: boolean; error?: string }>,
  channelGetStatus: () => ipcRenderer.invoke('channel:get-status') as Promise<any>,
  channelTest: (key: string) => ipcRenderer.invoke('channel:test', key) as Promise<{ ok: boolean; error?: string }>,

  // 🏊 Agent 常驻池
  agentPoolGetStatus: () => ipcRenderer.invoke('agent-pool:status') as Promise<any>,
  agentPoolGetConfig: () => ipcRenderer.invoke('agent-pool:config') as Promise<any>,
  agentPoolUpdateConfig: (config: any) => ipcRenderer.invoke('agent-pool:update-config', config) as Promise<{ ok: boolean; error?: string }>,
  agentPoolCompress: (id: string) => ipcRenderer.invoke('agent-pool:compress', id) as Promise<{ ok: boolean }>,

  // 🧭 P3 意图路由
  routerClassify: (message: string) => ipcRenderer.invoke('router:classify', message) as Promise<any>,
  routerGetConfig: () => ipcRenderer.invoke('router:config') as Promise<any>,
  routerUpdateConfig: (config: any) => ipcRenderer.invoke('router:update-config', config) as Promise<{ ok: boolean }>,
  routerGetRules: () => ipcRenderer.invoke('router:rules') as Promise<any[]>,

  // 🔒 P4 权限控制
  accessGetPermissions: () => ipcRenderer.invoke('access:permissions') as Promise<any[]>,
  accessGetPermissionsFor: (agentId: string) => ipcRenderer.invoke('access:permissions-for', agentId) as Promise<any>,
  accessUpdatePermissions: (agentId: string, patch: any) => ipcRenderer.invoke('access:update-permissions', agentId, patch) as Promise<{ ok: boolean }>,
  accessResetPermissions: (agentId: string) => ipcRenderer.invoke('access:reset-permissions', agentId) as Promise<{ ok: boolean }>,
  accessCheckFile: (agentId: string, filepath: string) => ipcRenderer.invoke('access:check-file', agentId, filepath) as Promise<any>,
  accessCheckWrite: (agentId: string, filepath: string) => ipcRenderer.invoke('access:check-write', agentId, filepath) as Promise<any>,
  accessGetViolations: (agentId?: string) => ipcRenderer.invoke('access:violations', agentId) as Promise<any[]>,
  accessClearViolations: () => ipcRenderer.invoke('access:clear-violations') as Promise<{ ok: boolean }>,

  // 沙箱管理
  sandboxGetConfig: () => ipcRenderer.invoke('sandbox:config') as Promise<any>,
  sandboxAddAuthorizedDir: (params: any) => ipcRenderer.invoke('sandbox:add-authorized-dir', params) as Promise<any>,
  sandboxRemoveAuthorizedDir: (dirId: string) => ipcRenderer.invoke('sandbox:remove-authorized-dir', dirId) as Promise<{ ok: boolean }>,
  sandboxGetAgentDir: (agentId: string) => ipcRenderer.invoke('sandbox:agent-dir', agentId) as Promise<{ sandboxDir: string }>,
  sandboxUpdateAgent: (agentId: string, patch: any) => ipcRenderer.invoke('sandbox:update-agent', agentId, patch) as Promise<{ ok: boolean }>,
  sandboxCheckPath: (agentId: string, filePath: string, operation: string) => ipcRenderer.invoke('sandbox:check-path', agentId, filePath, operation) as Promise<any>,

  // 🆕 v9.2: 文件文本提取 — PDF/DOCX/XLSX/PPTX 提取纯文本，供群聊附件使用
  fileExtractText: (filePath: string) => ipcRenderer.invoke('file:extract-text', filePath) as Promise<{ text?: string; error?: string }>,
  fileExtractTextFromBuffer: (ext: string, buffer: number[]) => ipcRenderer.invoke('file:extract-text-buffer', ext, buffer) as Promise<{ text?: string; error?: string }>,
  // ── 🔍 I5/I6/I7: 沙箱审计 / 数据导出导入 / 功能开关（集成接线）────────
  sandboxGetAuditLog: () => ipcRenderer.invoke('sandbox:audit-log') as Promise<any>,
  featureFlagsGetAll: () => ipcRenderer.invoke('feature-flags:get-all') as Promise<Record<string, boolean>>,
  featureFlagsSet: (key: string, value: boolean) => ipcRenderer.invoke('feature-flags:set', key, value) as Promise<{ ok: boolean }>,
  dataExportZip: () => ipcRenderer.invoke('data:export-zip') as Promise<any>,
  dataImportZip: () => ipcRenderer.invoke('data:import-zip') as Promise<any>,
  dataGetLocations: () => ipcRenderer.invoke('data:get-locations') as Promise<{ userData: string; memoryDb: string; flagsFile: string }>,
  // ── 🤖 自定义 Agent (D5) ─────────────────────────────────
  customAgentList: () =>
    ipcRenderer.invoke('custom-agent:list') as Promise<{ ok: boolean; agents?: any[]; defaultLeaderId?: string; toolsets?: string[]; error?: string }>,
  customAgentGet: (id: string) =>
    ipcRenderer.invoke('custom-agent:get', id) as Promise<{ ok: boolean; agent?: any; soul?: string; error?: string }>,
  customAgentCreate: (config: any) =>
    ipcRenderer.invoke('custom-agent:create', config) as Promise<{ ok: boolean; agent?: any; error?: string }>,
  customAgentUpdate: (id: string, updates: any) =>
    ipcRenderer.invoke('custom-agent:update', id, updates) as Promise<{ ok: boolean; agent?: any; error?: string }>,
  customAgentDelete: (id: string) =>
    ipcRenderer.invoke('custom-agent:delete', id) as Promise<{ ok: boolean; error?: string }>,
  customAgentReadSoul: (id: string) =>
    ipcRenderer.invoke('custom-agent:read-soul', id) as Promise<{ ok: boolean; soul?: string; error?: string }>,
  customAgentSetDefault: (id: string) =>
    ipcRenderer.invoke('custom-agent:set-default', id) as Promise<{ ok: boolean; defaultLeaderId?: string; error?: string }>,
  customAgentGetDefault: () =>
    ipcRenderer.invoke('custom-agent:get-default') as Promise<{ ok: boolean; defaultLeaderId?: string }>,

  // -- 提案3: team memory federation --
  federationExport: (opts?: { source?: string; memoryRoot?: string }) =>
    ipcRenderer.invoke('federation:export', opts) as Promise<{ ok: boolean; package?: any; error?: string }>,
  federationImport: (pkg: any, options?: any) =>
    ipcRenderer.invoke('federation:import', pkg, options) as Promise<any>,
  federationList: () =>
    ipcRenderer.invoke('federation:list') as Promise<{ ok: boolean; sources?: any[]; error?: string }>,
  federationSetConfidence: (source: string, confidence: number) =>
    ipcRenderer.invoke('federation:set-confidence', source, confidence) as Promise<{ ok: boolean; error?: string }>,

  // -- 提案4: cross-device WebDAV sync --
  webdavGetConfig: () =>
    ipcRenderer.invoke('webdav-sync:get-config') as Promise<{ ok: boolean; config?: any; hasEncryption?: boolean }>,
  webdavSaveSettings: (input: any) =>
    ipcRenderer.invoke('webdav-sync:save-settings', input) as Promise<{ ok: boolean; config?: any; error?: string }>,
  webdavSetEncryptionPassword: (password: string) =>
    ipcRenderer.invoke('webdav-sync:set-encryption-password', password) as Promise<{ ok: boolean; error?: string }>,
  webdavTestConnection: () =>
    ipcRenderer.invoke('webdav-sync:test-connection') as Promise<{ ok: boolean; status?: number; error?: string }>,
  webdavRun: () =>
    ipcRenderer.invoke('webdav-sync:run') as Promise<{ ok: boolean; report?: any; error?: string }>,
  webdavResolveConflict: (relPath: string, choice: 'local' | 'remote' | 'merge') =>
    ipcRenderer.invoke('webdav-sync:resolve-conflict', relPath, choice) as Promise<{ ok: boolean; error?: string }>,

  // ── 🔒 三档权限（仅可查看 / 工作区内修改 / 完全权限）──
  // 后端在 reactEngine 里强制执行；这里只负责读写档位与广播变更。
  // ── 🔍 可见性分档（陪伴 / 协作 / 审计）──
  // 详见 orchestration/visibility.ts 顶部。切档是运行时行为，不需重启会话。
  visibilityGet: () => ipcRenderer.invoke('visibility:get') as Promise<{
    ok: boolean
    tier?: string
    tiers?: Array<{ tier: string; label: string; summary: string; audience: string; showsEventTypes: string[] }>
    error?: string
  }>,
  visibilitySet: (tier: string) => ipcRenderer.invoke('visibility:set', tier) as Promise<{
    ok: boolean
    tier?: string
    error?: string
  }>,
  onVisibilityChanged: (cb: (payload: { tier: string }) => void) => {
    const h = (_e: unknown, p: { tier: string }): void => cb(p)
    ipcRenderer.on('visibility:changed', h)
    return () => { ipcRenderer.removeListener('visibility:changed', h) }
  },

  // ── 🔍 情绪收紧审计 ──────────────────────────────────────────
  // 「她为什么不帮我」必须能解释。详见 orchestration/emotionAudit.ts 顶部三条约束。
  // ⚠️ override 的语义是「只放行**这一轮**」，不是永久解锁，也不是权限授权。
  emotionAuditList: () =>
    ipcRenderer.invoke('emotionAudit:list') as Promise<{
      ok: boolean
      records?: EmotionAuditRecordDto[]
      error?: string
    }>,
  emotionAuditActive: () =>
    ipcRenderer.invoke('emotionAudit:active') as Promise<{
      ok: boolean
      records?: EmotionAuditRecordDto[]
      error?: string
    }>,
  emotionAuditExplain: (id: string) =>
    ipcRenderer.invoke('emotionAudit:explain', id) as Promise<{
      ok: boolean
      summary?: { id: string; ts: number; status: string; headline: string; detail: string[] }
      record?: EmotionAuditRecordDto
      error?: string
    }>,
  emotionAuditOverride: (id: string, reason?: string) =>
    ipcRenderer.invoke('emotionAudit:override', id, reason) as Promise<{
      ok: boolean
      record?: EmotionAuditRecordDto
      notice?: string
      stillGatedNextTurn?: boolean
      permissionUnchanged?: boolean
      error?: string
    }>,
  emotionAuditRules: () =>
    ipcRenderer.invoke('emotionAudit:rules') as Promise<{
      ok: boolean
      rules?: Record<string, { label: string; condition: string; riskClass: string; recovery: string; source: string }>
      error?: string
    }>,
  onEmotionAuditChanged: (cb: (payload: { id: string; status: string }) => void) => {
    const h = (_e: unknown, p: { id: string; status: string }): void => cb(p)
    ipcRenderer.on('emotionAudit:changed', h)
    return () => { ipcRenderer.removeListener('emotionAudit:changed', h) }
  },

  // ── 💰 Budget Guardian（预算守护者） ──────────────────────────
  // 统一 LLM 账本 + 三级预算收紧。语义同 emotionAudit：override 只是「本轮放行」。
  budgetSummary: () =>
    ipcRenderer.invoke('budget:summary') as Promise<{
      ok: boolean
      summary?: any
      error?: string
    }>,
  budgetAudit: () =>
    ipcRenderer.invoke('budget:audit') as Promise<{
      ok: boolean
      audit?: any[]
      error?: string
    }>,
  budgetSetConfig: (patch: Record<string, unknown>) =>
    ipcRenderer.invoke('budget:setConfig', patch) as Promise<{
      ok: boolean
      summary?: any
      error?: string
    }>,
  budgetOverride: (reason: string) =>
    ipcRenderer.invoke('budget:override', reason) as Promise<{
      ok: boolean
      record?: any
      summary?: any
      error?: string
    }>,
  budgetPriceTable: () =>
    ipcRenderer.invoke('budget:priceTable') as Promise<{
      ok: boolean
      prices?: any[]
      overrides?: any[]
      error?: string
    }>,
  budgetSetPriceOverrides: (entries: any[]) =>
    ipcRenderer.invoke('budget:setPriceOverrides', entries) as Promise<{
      ok: boolean
      error?: string
    }>,

  permGet: () =>
    ipcRenderer.invoke('perm:get') as Promise<{
      ok: boolean
      tier?: string
      workspaceRoot?: string | null
      effectiveWorkspaceRoot?: string
      fullAcknowledged?: boolean
      needsAcknowledgement?: boolean
      meta?: Record<string, { label: string; short: string; desc: string; color: string }>
      tiers?: string[]
      error?: string
    }>,
  permSetTier: (tier: string, acknowledged?: boolean) =>
    ipcRenderer.invoke('perm:setTier', tier, acknowledged) as Promise<{
      ok: boolean
      tier?: string
      fullAcknowledged?: boolean
      needsAcknowledgement?: boolean
      error?: string
    }>,
  permSetRoot: (root: string | null) =>
    ipcRenderer.invoke('perm:setRoot', root) as Promise<{
      ok: boolean
      workspaceRoot?: string | null
      effectiveWorkspaceRoot?: string
    }>,
  permOnChanged: (cb: (payload: { tier: string; fullAcknowledged: boolean; needsAcknowledgement: boolean }) => void) => {
    const listener = (_e: unknown, payload: unknown) => cb(payload as { tier: string; fullAcknowledged: boolean; needsAcknowledgement: boolean })
    ipcRenderer.on('perm:changed', listener)
    return () => { ipcRenderer.removeListener('perm:changed', listener) }
  },

  // ── 🎨 主题皮肤生态 ─────────────────────────────────────
  themeList: () =>
    ipcRenderer.invoke('theme:list') as Promise<{ ok: boolean; themes?: any[]; error?: string }>,
  themeApply: (name: string) =>
    ipcRenderer.invoke('theme:apply', name) as Promise<{ ok: boolean; theme?: any; resolvedVars?: Record<string, string>; error?: string }>,
  themeImport: (filePath: string) =>
    ipcRenderer.invoke('theme:import', filePath) as Promise<{ ok: boolean; theme?: any; error?: string }>,
  themeExport: (name: string, filePath: string) =>
    ipcRenderer.invoke('theme:export', name, filePath) as Promise<{ ok: boolean; error?: string }>,
  themeDelete: (name: string) =>
    ipcRenderer.invoke('theme:delete', name) as Promise<{ ok: boolean; error?: string }>,
  themeGetCurrent: () =>
    ipcRenderer.invoke('theme:get-current') as Promise<{ ok: boolean; theme?: any; resolvedVars?: Record<string, string>; error?: string }>,
  themeSave: (theme: any) =>
    ipcRenderer.invoke('theme:save', theme) as Promise<{ ok: boolean; theme?: any; error?: string }>,
  themeOnChanged: (cb: (payload: { name: string; isDark: boolean; resolvedVars: Record<string, string> }) => void) => {
    const listener = (_e: unknown, payload: any) => cb(payload)
    ipcRenderer.on('theme:changed', listener)
    return () => ipcRenderer.removeListener('theme:changed', listener)
  },
  // ── v0.2: Live2D model store (local/offline) ─────────────
  modelStoreList: () =>
    ipcRenderer.invoke('pet:models:list') as Promise<{ ok: boolean; models?: any[]; current?: any; error?: string }>,
  modelStoreSelect: (id: string) =>
    ipcRenderer.invoke('pet:set-model', id) as Promise<{ ok: boolean; kind?: string; modelId?: string; error?: string }>,
  modelStoreRemove: (id: string) =>
    ipcRenderer.invoke('pet:models:remove', { id }) as Promise<{ ok: boolean; models?: any[]; error?: string }>,
  modelStoreImportFolder: () =>
    ipcRenderer.invoke('model-store:import-folder') as Promise<{ ok: boolean; canceled?: boolean; blocked?: boolean; error?: string; model?: any; warnings?: any[]; issues?: any[] }>,
  modelStoreCloudStatus: () =>
    ipcRenderer.invoke('model-store:cloud-status') as Promise<{ ok: boolean; configured: boolean; url: string | null; mode: string; note: string }>,

  // ── v0.2: third-party skill runtime ──────────────────────
  skillRuntimeOpenPackage: () =>
    ipcRenderer.invoke('skill-runtime:open-package') as Promise<{ ok: boolean; canceled?: boolean; zipPath?: string; error?: string }>,
  skillRuntimePrepare: (zipPath: string) =>
    ipcRenderer.invoke('skill-runtime:prepare', zipPath) as Promise<{ ok: boolean; stagedId?: string; manifest?: any; scan?: any; signatureStatus?: string; signatureReason?: string; error?: string }>,
  skillRuntimeConfirm: (stagedId: string) =>
    ipcRenderer.invoke('skill-runtime:confirm', stagedId) as Promise<{ ok: boolean; skill?: any; error?: string }>,
  skillRuntimeList: () =>
    ipcRenderer.invoke('skill-runtime:list') as Promise<{ ok: boolean; skills?: any[]; error?: string }>,
  skillRuntimeUninstall: (name: string) =>
    ipcRenderer.invoke('skill-runtime:uninstall', name) as Promise<{ ok: boolean; error?: string }>,

  // ── 🕰 Day Replay（时间线回放；实验 flag: dayreplay.enabled）──
  dayreplayToday: () => ipcRenderer.invoke('dayreplay:today') as Promise<any>,
  dayreplayGet: (date?: string) => ipcRenderer.invoke('dayreplay:get', date) as Promise<any>,
  dayreplayExport: (opts?: { date?: string; format?: 'markdown' | 'text' }) =>
    ipcRenderer.invoke('dayreplay:export', opts) as Promise<any>,

  // ── 📊 Mood×Productivity 情绪看板（实验 flag: moodstats.enabled）──
  moodstatsReport: () => ipcRenderer.invoke('moodstats:report') as Promise<any>,
  moodstatsSnapshots: (n?: number) => ipcRenderer.invoke('moodstats:snapshots', n) as Promise<any>,
  moodstatsAbGet: () => ipcRenderer.invoke('moodstats:ab:get') as Promise<any>,
  moodstatsAbSetEnabled: (on: boolean) => ipcRenderer.invoke('moodstats:ab:setEnabled', on) as Promise<any>,
  moodstatsAbOptOut: () => ipcRenderer.invoke('moodstats:ab:optOut') as Promise<any>,
  moodstatsAbRerandomize: () => ipcRenderer.invoke('moodstats:ab:rerandomize') as Promise<any>,
  moodstatsAbRejoin: () => ipcRenderer.invoke('moodstats:ab:rejoin') as Promise<any>,
  moodstatsSetMaster: (on: boolean) => ipcRenderer.invoke('moodstats:setMaster', on) as Promise<any>,
  moodstatsExport: () => ipcRenderer.invoke('moodstats:export') as Promise<any>,

  // ── 🌙☀️ 仪式感（睡前复盘 / 晨间简报）──
  ritualsGetStatus: () => ipcRenderer.invoke('rituals:getStatus') as Promise<any>,
  ritualsSetConfig: (patch: Record<string, any>) => ipcRenderer.invoke('rituals:setConfig', patch) as Promise<any>,
  ritualsRunNight: () => ipcRenderer.invoke('rituals:runNight') as Promise<any>,
  ritualsRunMorning: () => ipcRenderer.invoke('rituals:runMorning') as Promise<any>,

  // ── 🔁 交班模式（加密卡片 + 二维码 + 局域网 H5；实验 flag: handover.enabled）──
  handoverGenerate: (opts: { ttlMinutes?: number; mode?: 'password' | 'machine'; password?: string }) =>
    ipcRenderer.invoke('handover:generate', opts) as Promise<any>,
  handoverSave: (container: string, suggestedName?: string) =>
    ipcRenderer.invoke('handover:save', { container, suggestedName }) as Promise<any>,
  handoverRevoke: (code: string) => ipcRenderer.invoke('handover:revoke', { code }) as Promise<any>,
  handoverStatus: () => ipcRenderer.invoke('handover:status') as Promise<any>,
}

contextBridge.exposeInMainWorld('luminaAPI', api)

export type LuminaAPI = typeof api
