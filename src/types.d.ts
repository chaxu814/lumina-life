// ============================================================
// Lumina Life 1.0 — 全局类型声明
// ============================================================

export {}

// ── 第三方库类型声明 ──────────────────────────────

declare module 'screenshot-desktop' {
  interface ScreenshotOptions {
    filename?: string
    format?: 'png' | 'jpg'
    screen?: string
  }
  function screenshot(options?: ScreenshotOptions): Promise<Buffer>
  namespace screenshot {
    function listDisplays(): Promise<string[]>
    function all(): Promise<Buffer[]>
  }
  export = screenshot
}

declare global {
  interface Window {
    luminaAPI: {
      // 配置
      getConfig: () => Promise<Record<string, any>>
      setConfig: (updates: Record<string, any>) => Promise<Record<string, any>>

      // LLM
      llmChat: (params: {
        provider?: string; apiKey: string; baseUrl: string; model: string
        messages: Array<{ role: string; content: string }>
        temperature?: number; maxTokens?: number; structuredOutput?: boolean
        systemPrompt?: string
      }) => Promise<{
        content?: string
        usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null
        error?: string
      }>

      // 获取 LLM 提供商支持的模型列表
      llmFetchModels: (params: { baseUrl: string; apiKey: string }) => Promise<{
        models: Array<{ id: string; multimodal?: boolean; vision?: boolean }>
        error?: string
      }>

      // LLM 连接测试
      llmTestConnection: (params: { baseUrl: string; apiKey: string; model: string }) => Promise<{
        success: boolean
        latency?: number
        usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
        error?: string
        model?: string
      }>

      // 多模态能力测试
      llmTestMultimodal: (params: { baseUrl: string; apiKey: string; model: string }) => Promise<{
        supported: boolean
        image: boolean
        video: boolean
        audio: boolean
        model?: string
        detectedCapabilities?: { id: string; multimodal: boolean; vision: boolean }
        error?: string
        reason?: string
      }>

      // v5.0: Per-Agent 独立 LLM 配置
      agentLlmGetConfig: (agentId: string) => Promise<{ config?: any; error?: string }>
      agentLlmSetConfig: (agentId: string, config: any) => Promise<{ ok: boolean; config?: any; error?: string }>
      agentLlmGetAllConfigs: () => Promise<{
        configs?: Record<string, any>
        agents?: Array<{ id: string; name: string; icon: string; configured: boolean; provider: string; model: string }>
        lumina?: any; yak?: any; recha?: any
        error?: string
      }>
      agentConfigureLlm: (agentId: string, config: {
        provider: string; model: string; endpoint: string; apiKey?: string; timeout?: number; maxContextTokens?: number
      }) => Promise<{ success: boolean; config?: any; error?: string }>

      // 导航
      navigatePanel: (panelId: string) => void
      showAbout: () => void
      toggleDevTools: () => void

      // TTS
      ttsSpeak: (params: { text: string; voice?: string; speed?: number; volume?: number }) => Promise<{ audio?: string; error?: string }>

      // Edge TTS
      edgeTtsStart: () => Promise<{ ok: boolean; success?: boolean; port?: number; detail?: string }>
      edgeTtsStop: () => Promise<{ success: boolean }>
      edgeTtsStatus: () => Promise<{ running: boolean; ok?: boolean }>
      edgeTtsSpeak: (params: { text: string; voice?: string; speed?: number }) => Promise<{ audio?: string; error?: string }>

      // 记忆 (v2.3: 三层记忆 — 事实/反思/人格)
      memorySave: (category: string, content: string) => Promise<any>
      memoryGet: (section?: string) => Promise<any>
      memoryAll: () => Promise<string>
      memoryProfile: () => Promise<any>

      // 誓约/预约 (v2.3)
      oathMake: (params: { content: string; category?: string }) => Promise<{ ok: boolean; id?: number; error?: string }>
      oathList: (category?: string) => Promise<{ oaths: Array<{ id: number; content: string; category: string; fulfilled: boolean; createdAt: string }> }>
      oathFulfill: (id: number) => Promise<{ ok: boolean; error?: string }>
      oathListAll: () => Promise<{ oaths: any[]; appointments: any[] }>
      appointmentSet: (params: { title: string; when: string; message?: string }) => Promise<{ ok: boolean; id?: number; error?: string }>
      appointmentList: () => Promise<{ appointments: Array<{ id: number; title: string; when: string; message: string; triggered: boolean }> }>

      // OCR & 桌面自动化 (v2.3)
      ocr: (params?: { region?: string; language?: string }) => Promise<{ text: string; ok: boolean; error?: string }>
      desktopClick: (x: number, y: number) => Promise<{ ok: boolean; error?: string }>
      desktopType: (text: string) => Promise<{ ok: boolean; error?: string }>
      desktopKey: (key: string) => Promise<{ ok: boolean; error?: string }>
      desktopScreenshot: (region?: string) => Promise<{ ok: boolean; path?: string; error?: string }>

      // 桥接
      bridgeStart: (platform: string) => Promise<{ ok: boolean; error?: string }>
      bridgeStop: (platform: string) => Promise<{ ok: boolean; error?: string }>
      bridgeStatus: () => Promise<Record<string, { running: boolean; connected: boolean }>>

      // Agent API (v2)
      agentChat: (params: {
        text: string
        sessionId?: string
        compactedContext?: string
        config: {
          mode: 'chat' | 'agent' | 'developer'
          model: string; baseUrl: string; apiKey: string
          temperature?: number; maxTokens?: number; maxToolCalls?: number
          systemPrompt?: string; personaId?: string
          disabledTools?: string[]
          skipApproval?: boolean
          contextWindow?: number
          socialMode?: boolean
          isGroupChat?: boolean
          trackReasoning?: boolean  // 🧠 v10.6: thinking_stream
        }
        conversationHistory?: Array<{ role: string; content: string }>
      }) => Promise<{ success: boolean; content?: string; compactedContext?: string; totalTokens?: number; contextWindow?: number; error?: string }>

      agentAbort: () => Promise<{ success: boolean }>
      agentClear: () => Promise<{ success: boolean }>
      agentSetMode: (mode: string) => Promise<{ success: boolean }>

      // 设置 Agent 情绪状态
      agentSetEmotion: (emotion: { mood: number; energy: number; affinity: number; label?: string }) => Promise<{ success: boolean }>

      // 统一 Provider 管理 (QwenPaw 风格)
      providerList: () => Promise<{ providers: Array<{ id: string; name: string; isLocal: boolean; defaultBaseUrl: string; defaultModel: string; requiresApiKey: boolean }> }>
      providerGetAll: () => Promise<{ activeProviderId: string; configs: Record<string, { baseUrl: string; apiKey: string; model: string; enabled: boolean; timeout: number; maxContextTokens: number }>; availableIds: string[] }>
      providerGetConfig: (id: string) => Promise<{ config: { baseUrl: string; apiKey: string; model: string; enabled: boolean; timeout: number; maxContextTokens: number } | null }>
      providerSaveConfig: (id: string, config: any) => Promise<{ success: boolean; error?: string }>
      providerSaveMultiple: (configs: Record<string, any>) => Promise<{ success: boolean; error?: string }>
      providerSetActive: (id: string) => Promise<{ success: boolean; error?: string }>
      providerFetchModels: (id: string, override?: { baseUrl?: string; apiKey?: string }) => Promise<{ models: Array<{ id: string; multimodal?: boolean; vision?: boolean }>; error?: string }>
      providerTestConnection: (id: string) => Promise<{ success: boolean; latency?: number; error?: string }>
      providerDiscoverLocal: () => Promise<{ found?: any[]; guide?: Array<{ title: string; body: string }>; error?: string }>
      providerApplyLocal: (input: { id?: string; baseUrl?: string; model?: string }) => Promise<{ success: boolean; id?: string; model?: string; baseUrl?: string; error?: string }>

      onAgentEvent: (callback: (event: {
        type: string; text?: string; tool?: string
        args?: Record<string, any>; result?: any
        content?: string; error?: string; totalTokens?: number
        command?: any; summary?: string
        // thinking_stream 事件字段
        isFirst?: boolean; isLast?: boolean
        // token_update 事件字段
        delta?: number; usage?: any
      }) => void) => () => void

      // 听觉 + STT (v2.11)
      hearingStart: (source?: 'mic' | 'system' | 'both') => Promise<{ ok: boolean; detail: string }>
      hearingStop: () => Promise<{ ok: boolean }>
      hearingStatus: () => Promise<{ running: boolean; wsUrl?: string; source?: string }>
      onTranscription: (callback: (result: { text: string; isFinal: boolean }) => void) => () => void
      sttCheck: () => Promise<{ available: boolean; engine?: string }>
      sttStart: () => Promise<{ ok: boolean; error?: string }>
      sttStop: () => Promise<{ ok: boolean }>
      onSTTResult: (callback: (text: string) => void) => () => void
      sttOfflineStatus: () => Promise<{ ok: boolean; depReady?: boolean; modelReady?: boolean; model?: string; sizeMB?: number }>
      sttDownloadModel: () => Promise<{ ok: boolean; alreadyReady?: boolean; error?: string }>
      onSttDownloadProgress: (callback: (p: any) => void) => () => void

      // Skill
      skillInstall: (zipPath: string) => Promise<any>
      skillList: () => Promise<{ skills: any[] }>
      skillUninstall: (skillId: string) => Promise<{ success: boolean; error?: string }>
      skillRead: (skillId: string) => Promise<{ doc: string | null }>
      skillOpenDialog: () => Promise<any>

      // 任务
      taskSubmit: (params: { title: string; prompt: string; config: any }) => Promise<{ taskId: string }>
      taskList: () => Promise<any[]>
      taskCancel: (taskId: string) => Promise<{ ok: boolean }>
      onTaskProgress: (callback: (ev: any) => void) => () => void
      onTaskDone: (callback: (task: any) => void) => () => void

      // 窗口
      windowMinimize: () => Promise<void>
      windowMaximize: () => Promise<void>
      windowClose: () => Promise<void>

      // 数据
      clearAllData: () => Promise<{ success: boolean; error?: string }>
      resetSettings: () => Promise<{ success: boolean; error?: string }>

      // Lucky Mode 配置持久化
      luckyModeGetConfig: () => Promise<{ config?: any; error?: string }>
      luckyModeSaveConfig: (config: any) => Promise<{ ok: boolean; error?: string }>

      // 对话框
      dialogSave: (options: any) => Promise<any>
      dialogOpen: (options: any) => Promise<any>

      // STT (P0.3)
      sttStart: () => Promise<{ ok: boolean; error?: string }>
      sttStop: () => Promise<{ ok: boolean }>

      // SoVITS TTS (P0.4)
      ttsSoVITSSpeak: (params: { text: string; refAudio?: string; refText?: string }) => Promise<{ audio?: string; error?: string }>
      playAudio: (filePath: string) => Promise<void>

      // 菜单/事件
      onMenuEvent: (channel: string, callback: (...args: any[]) => void) => () => void
      // 主窗口回传桌宠生活视图数据
      lifeProvideData: (payload: { reqId: string; items: Array<{ title: string; body?: string; meta?: string; icon?: string }> }) => void
      onTokenUsage: (callback: (data: any) => void) => void

      // Cron 任务同步到主进程
      cronSyncAll: (entries: Array<{ name: string; schedule: string; action: string; enabled: boolean }>) => Promise<{ ok: boolean; count?: number; error?: string }>

      // 📬 Agent 邮件 (v2.6)
      mailList: (filter?: 'unread' | 'all') => Promise<{ mails: Array<{ id: string; subject: string; body: string; priority: string; read: boolean; createdAt: number; readAt?: number; deletedAt?: number }>; unread: number; total: number }>
      mailMarkRead: (mailId: string) => Promise<{ ok: boolean; count?: number }>
      mailDelete: (mailId: string) => Promise<{ ok: boolean }>
      mailUnreadCount: () => Promise<{ count: number }>
      // v2.8: 归档邮件（软删除，可恢复）
      mailArchivedList: () => Promise<{ mails: Array<{ id: string; subject: string; body: string; priority: string; read: boolean; createdAt: number; readAt?: number; deletedAt?: number }> }>
      mailRestore: (mailId: string) => Promise<{ ok: boolean }>
      mailPurgeArchived: (mailId: string) => Promise<{ ok: boolean }>
      onMailChanged: (callback: (data: { unread: number; total: number }) => void) => () => void

      // Agent 朋友圈/Moments
      momentsPost: (params: { agentId: string; agentName: string; content: string; imagePath?: string; emotion?: string; type?: string; relatedAgentId?: string }) => Promise<{ ok: boolean; moment?: any; error?: string }>
      momentsTimeline: (params?: { limit?: number; offset?: number; agentId?: string; type?: string }) => Promise<{ moments: any[]; total: number }>
      momentsDelete: (id: number) => Promise<{ ok: boolean }>
      momentsLike: (momentId: number, agentId: string) => Promise<{ liked: boolean; likeCount: number }>
      momentsComments: (momentId: number) => Promise<{ comments: any[] }>
      momentsAddComment: (momentId: number, agentId: string, agentName: string, content: string) => Promise<{ ok: boolean; comment?: any }>
      momentsRecentSummary: (limit?: number) => Promise<{ summary: string }>
      onMomentPosted: (callback: (moment: any) => void) => () => void
      teamGetState: () => Promise<{
        agents: any[]; relationships: any[]; mood: string;
        currentTopic: string; isDiscussing: boolean;
        dailyMessageCount: number; eventLog: any[]
      }>
      teamTriggerSocial: () => Promise<{ topic: string; rounds: number } | null>
      teamTriggerDecision: (question: string, context: string, options: string[]) => Promise<{
        summary: string; votes: any[]
      }>
      onTeamSocialMessage: (callback: (data: any) => void) => () => void
      onTeamAgentSpeaking: (callback: (data: any) => void) => () => void
      onTeamDiscussionStarted: (callback: (data: any) => void) => () => void
      onTeamDiscussionEnded: (callback: (data: any) => void) => () => void

      // 主动引擎 API
      proactiveStatus: () => Promise<{
        running: boolean; triggers: Array<{ id: string; type: string; enabled: boolean; lastTriggered?: number; cooldown: number; priority: number }>;
        config: Record<string, any>; dailyCount: number; lastActive?: number;
      }>
      proactiveUpdateConfig: (config: Record<string, any>) => Promise<{ ok: boolean }>
      proactiveUpdateTrigger: (id: string, updates: Record<string, any>) => Promise<{ ok: boolean }>
      proactiveGetTriggers: () => Promise<Array<{ id: string; type: string; condition: string; template: string; enabled: boolean; cooldown: number; priority: number }>>
      proactiveHeartbeat: () => Promise<{ ok: boolean }>
      proactiveTestTrigger: (id: string) => Promise<{ ok: boolean; error?: string }>
      proactiveScreenContext: () => Promise<{ context: string; timestamp?: number } | null>
      proactiveUserMessage: () => Promise<{ ok: boolean }>
      proactiveSetNotify: (enabled: boolean) => Promise<{ ok: boolean }>

      // 命令 + 审批
      commandExecute: (text: string) => Promise<{ content?: string; error?: string }>
      commandList: () => Promise<{ commands: Array<{ name: string; desc: string; usage: string }> }>
      onApprovalRequested: (callback: (req: { id: string; tool: string; args: any; reason: string; level: number; agentName: string }) => void) => () => void
      onApprovalResolved: (callback: (res: { id: string; approved: boolean }) => void) => () => void
      /** 🆕 v2.0: 沙箱模式配置 */
      approvalUpdateConfig: (config: { executionLevel?: string; enabled?: boolean }) => Promise<{ ok: boolean }>

      // 主动引擎 + 团队工具事件
      onProactivePopup: (callback: (data: { id: string; message: string; type: string; timestamp: number }) => void) => () => void
      onAgentToolEvent: (callback: (data: { agentId: string; agentName: string; type: string; tool: string; args?: any; result?: any; timestamp: number }) => void) => () => void

      // 动态团队注册
      teamListMembers: () => Promise<Array<{ id: string; name: string; icon: string; role: string; description: string; capabilities: string[]; triggers?: string[]; registeredAt?: string; isBuiltIn: boolean }>>
      teamRegisterMember: (reg: { id: string; name: string; icon: string; description: string; capabilities: string[]; triggers?: string[] }) => Promise<{ ok: boolean; error?: string }>
      teamUnregisterMember: (id: string) => Promise<{ ok: boolean; error?: string }>

      // 🧰 v1.0 工具箱: 实时语音对话
      agentStartRealtimeVoice: () => Promise<{ success: boolean; message?: string; error?: string }>
      agentStopRealtimeVoice: () => Promise<{ success: boolean; error?: string }>
      agentRealtimeVoiceStatus: () => Promise<{ active: boolean; error?: string }>

      // 🧰 v1.0 工具箱: Computer Use
      agentStartComputerUse: () => Promise<{ success: boolean; message?: string; error?: string }>
      agentStopComputerUse: () => Promise<{ success: boolean; error?: string }>
      agentComputerUseStatus: () => Promise<{ active: boolean; running: boolean; error?: string }>

      // 🧰 v1.0 工具箱: 同步角色配置
      teamSyncProfiles: (profiles: Array<{
        id: string; name: string; icon: string; role: string; description: string
        systemPrompt: string; capabilities: string[]
      }>) => Promise<{ success: boolean; count?: number; error?: string }>

      // 🌙 Dream System
      dreamList: () => Promise<{ dreams: any[] }>
      dreamRecent: (count?: number) => Promise<{ dreams: any[] }>
      dreamGet: (date: string) => Promise<{ dream: any | null }>
      dreamDelete: (id: string) => Promise<{ ok: boolean; error?: string }>
      dreamStats: () => Promise<{ stats: any }>
      dreamGenerate: () => Promise<{ ok: boolean; error?: string }>
      onDreamNew: (callback: (dream: any) => void) => () => void

      // 副人格冲突事件监听
      onPersonalityConflict: (callback: (conflict: any) => void) => () => void

      // 📱 Push System
      pushUpdateConfig: (config: any) => Promise<{ ok: boolean; error?: string }>
      pushGetConfig: () => Promise<{ config: any }>
      pushTestServerChan: (key: string) => Promise<{ ok: boolean; error?: string }>
      pushTestDingTalk: (webhook: string, secret: string) => Promise<{ ok: boolean; error?: string }>

      // 🎬 Agent 真人秀
      realityHistory: (count?: number) => Promise<{ events: any[] }>
      realityTrigger: (event?: any) => Promise<{ ok: boolean; error?: string }>
      realityStatus: () => Promise<{ running: boolean }>
      realityRestart: (intervalMs?: number) => Promise<{ ok: boolean; error?: string }>
      onRealityEvent: (callback: (event: any) => void) => () => void

      // 📦 Skill SDK
      skillSDKGenerate: (params: any) => Promise<{ ok: boolean; error?: string }>
      skillSDKExport: (dirName: string, files: any) => Promise<{ ok: boolean; error?: string }>

      // 🧪 Test Runner
      testSummary: () => Promise<{ summary: any }>
      testRun: () => Promise<{ ok: boolean; error?: string }>

      // 报告持久化 (日报/周报/月报)
      reportSave: (params: {
        type: 'daily' | 'weekly' | 'monthly'
        title: string
        summary: string
        content: string
        period: string
      }) => Promise<{ ok: boolean; report?: any; error?: string }>
      reportList: (params?: {
        type?: string; limit?: number; offset?: number
      }) => Promise<{ reports: any[]; total: number }>
      reportLatest: (type?: string) => Promise<{ report: any | null }>

      // Plan C: 桌宠模式
      petToggle: (enable: boolean) => Promise<{ ok: boolean; enabled?: boolean; error?: string }>
      petStatus: () => Promise<boolean>
      petConfig: () => Promise<{
        clickThrough: boolean; autoRestart: boolean; opacity: number; scale: number
      }>
      petUpdateConfig: (config: Partial<{
        clickThrough: boolean; autoRestart: boolean; opacity: number; scale: number
      }>) => Promise<{ ok: boolean; config?: any; error?: string }>
      /** 监听桌宠事件（点击/双击/闲时等） */
      onPetEvent: (callback: (event: {
        type: 'click' | 'double-click' | 'drag-end' | 'idle-long' | 'mouse-enter' | 'mouse-leave'
        timestamp: number; data?: any
      }) => void) => () => void

      // 新闻早报
      newsCollect: () => Promise<{
        items: Array<{
          id: string; title: string; url: string; source: string
          category: string; pubDate: string; summary: string; hotScore: number
        }>
        totalCollected: number; filteredCount: number; date: string
        error?: string
      }>
      newsPushToMail: () => Promise<{ ok: boolean; count?: number; error?: string }>

      // 渠道配置
      channelGetConfigs: () => Promise<Array<{
        key: string; type: string; name: string; enabled: boolean
        credentials: Record<string, string>
        options?: Record<string, any>
      }>>
      channelUpdateConfig: (key: string, config: {
        type: string; name: string; enabled: boolean
        credentials: Record<string, string>
        options?: Record<string, any>
      }) => Promise<{ ok: boolean; error?: string }>
      channelGetStatus: () => Promise<Array<{
        key: string; type: string; name: string; online: boolean
      }>>
      channelTest: (key: string) => Promise<{ ok: boolean; error?: string }>

      // 🏊 Agent 常驻池
      agentPoolGetStatus: () => Promise<Array<{
        id: string; idleMs: number; turnCount: number; totalTokens: number
        lastUsed: number; isIdle: boolean; idleCompressed: boolean; personaId: string
      }>>
      agentPoolGetConfig: () => Promise<{
        maxSize: number; idleTimeoutMs: number; keepaliveEnabled: boolean
        keepaliveIntervalMs: number; evictOnIdle: boolean; persistentAgents: string[]
      }>
      agentPoolUpdateConfig: (config: Partial<{
        maxSize: number; idleTimeoutMs: number; keepaliveEnabled: boolean
        keepaliveIntervalMs: number; evictOnIdle: boolean; persistentAgents: string[]
      }>) => Promise<{ ok: boolean; error?: string }>
      agentPoolCompress: (id: string) => Promise<{ ok: boolean }>

      // 🧭 P3 意图路由
      routerClassify: (message: string) => Promise<{
        target: string; confidence: number; reason: string
        autoRouted: boolean; message: string; taskType?: string
        extractedContext?: string
      }>
      routerGetConfig: () => Promise<{
        autoRoute: boolean; minConfidence: number
        luminaKeywords: string[]; rules: Array<{
          target: string; triggers: string[]; taskType: string
          minScore: number; description: string
        }>
      }>
      routerUpdateConfig: (config: Partial<{
        autoRoute: boolean; minConfidence: number
        luminaKeywords: string[]; rules: any[]
      }>) => Promise<{ ok: boolean }>
      routerGetRules: () => Promise<Array<{
        target: string; triggers: string[]; taskType: string
        minScore: number; description: string
      }>>

      // 🔒 P4 权限控制
      accessGetPermissions: () => Promise<Array<{
        agentId: string; allowedReadPaths: string[]; allowedWritePaths: string[]
        allowedDangerousTools: string[]; networkAccess: boolean
        allowedDomains: string[]; shellAccess: boolean
        allowedCommands: string[]; description: string
      }>>
      accessGetPermissionsFor: (agentId: string) => Promise<{
        agentId: string; allowedReadPaths: string[]; allowedWritePaths: string[]
        allowedDangerousTools: string[]; networkAccess: boolean
        allowedDomains: string[]; shellAccess: boolean
        allowedCommands: string[]; description: string
      } | null>
      accessUpdatePermissions: (agentId: string, patch: any) => Promise<{ ok: boolean }>
      accessResetPermissions: (agentId: string) => Promise<{ ok: boolean }>
      accessCheckFile: (agentId: string, filepath: string) => Promise<{ allowed: boolean; reason: string; suggestion?: string }>
      accessCheckWrite: (agentId: string, filepath: string) => Promise<{ allowed: boolean; reason: string; suggestion?: string }>
      accessGetViolations: (agentId?: string) => Promise<Array<{
        timestamp: number; agentId: string; action: string
        target: string; reason: string; denied: boolean
      }>>
      accessClearViolations: () => Promise<{ ok: boolean }>

      // 📁 文件读写（Loop 引擎跨 Session 持久化等）
      fsReadFile: (filePath: string) => Promise<string>
      fsWriteFile: (filePath: string, content: string) => Promise<void>
      fsListDir: (dirPath: string) => Promise<unknown[]>

      // 🧪 功能开关（I7：主进程 featureFlags 经 IPC 暴露）
      featureFlagsGetAll: () => Promise<Record<string, boolean>>
      featureFlagsSet: (key: string, value: boolean) => Promise<{ ok: boolean }>

      // 🔐 数据导出/导入（I6：本地记忆打包 zip，合并不覆盖）
      dataExportZip: () => Promise<{ ok: boolean; zipPath?: string; bytes?: number; error?: string }>
      dataImportZip: () => Promise<{ ok: boolean; imported?: Record<string, number>; skipped?: Record<string, number>; error?: string }>
      dataGetLocations: () => Promise<{ userData?: string; memoryDb?: string; flagsFile?: string }>

      // task workspace artifact file ops
      artifactSave: (payload: { filename: string; content: string }) => Promise<{ ok: boolean; canceled?: boolean; filePath?: string; error?: string }>
      artifactOpenInFolder: (filePath: string) => Promise<{ ok: boolean; error?: string }>
      artifactOpenExternal: (filePath: string) => Promise<{ ok: boolean; error?: string }>
      artifactReadFile: (filePath: string) => Promise<{ ok: boolean; dataUrl?: string; size?: number; mtime?: number; error?: string }>
      
      // 🤖 自定义 Agent (D5)
      customAgentList: () => Promise<{ ok: boolean; agents?: any[]; defaultLeaderId?: string; toolsets?: string[]; error?: string }>
      customAgentGet: (id: string) => Promise<{ ok: boolean; agent?: any; soul?: string; error?: string }>
      customAgentCreate: (config: any) => Promise<{ ok: boolean; agent?: any; error?: string }>
      customAgentUpdate: (id: string, updates: any) => Promise<{ ok: boolean; agent?: any; error?: string }>
      customAgentDelete: (id: string) => Promise<{ ok: boolean; error?: string }>
      customAgentReadSoul: (id: string) => Promise<{ ok: boolean; soul?: string; error?: string }>
      customAgentSetDefault: (id: string) => Promise<{ ok: boolean; defaultLeaderId?: string; error?: string }>
      customAgentGetDefault: () => Promise<{ ok: boolean; defaultLeaderId?: string }>

      // 🛒 v0.2: Live2D 配件商城（本地/离线模式）
      modelStoreList: () => Promise<{ ok: boolean; models?: any[]; current?: any; error?: string }>
      modelStoreSelect: (id: string) => Promise<{ ok: boolean; kind?: string; modelId?: string; error?: string }>
      modelStoreRemove: (id: string) => Promise<{ ok: boolean; models?: any[]; error?: string }>
      modelStoreImportFolder: () => Promise<{ ok: boolean; canceled?: boolean; blocked?: boolean; error?: string; model?: any; warnings?: any[]; issues?: any[] }>
      modelStoreCloudStatus: () => Promise<{ ok: boolean; configured: boolean; url: string | null; mode: string; note: string }>

      // 🧪 v0.2: 第三方技能包运行时
      skillRuntimeOpenPackage: () => Promise<{ ok: boolean; canceled?: boolean; zipPath?: string; error?: string }>
      skillRuntimePrepare: (zipPath: string) => Promise<{ ok: boolean; stagedId?: string; manifest?: any; scan?: any; signatureStatus?: string; signatureReason?: string; error?: string }>
      skillRuntimeConfirm: (stagedId: string) => Promise<{ ok: boolean; skill?: any; error?: string }>
      skillRuntimeList: () => Promise<{ ok: boolean; skills?: any[]; error?: string }>
      skillRuntimeUninstall: (name: string) => Promise<{ ok: boolean; error?: string }>

      // 🎨 主题皮肤生态
      themeList: () => Promise<{ ok: boolean; themes?: any[]; error?: string }>
      themeApply: (name: string) => Promise<{ ok: boolean; theme?: any; resolvedVars?: Record<string, string>; error?: string }>
      themeImport: (filePath: string) => Promise<{ ok: boolean; theme?: any; error?: string }>
      themeExport: (name: string, filePath: string) => Promise<{ ok: boolean; error?: string }>
      themeDelete: (name: string) => Promise<{ ok: boolean; error?: string }>
      themeGetCurrent: () => Promise<{ ok: boolean; theme?: any; resolvedVars?: Record<string, string>; error?: string }>
      themeSave: (theme: any) => Promise<{ ok: boolean; theme?: any; error?: string }>
      themeOnChanged: (cb: (payload: { name: string; isDark: boolean; resolvedVars: Record<string, string> }) => void) => () => void

      // proposal3: team memory federation
      federationExport: (opts?: { source?: string; memoryRoot?: string }) => Promise<{ ok: boolean; package?: any; error?: string }>
      federationImport: (pkg: any, options?: any) => Promise<any>
      federationList: () => Promise<{ ok: boolean; sources?: any[]; error?: string }>
      federationSetConfidence: (source: string, confidence: number) => Promise<{ ok: boolean; error?: string }>

      // proposal4: cross-device WebDAV sync
      webdavGetConfig: () => Promise<{ ok: boolean; config?: any; hasEncryption?: boolean }>
      webdavSaveSettings: (input: any) => Promise<{ ok: boolean; config?: any; error?: string }>
      webdavSetEncryptionPassword: (password: string) => Promise<{ ok: boolean; error?: string }>
      webdavTestConnection: () => Promise<{ ok: boolean; status?: number; error?: string }>
      webdavRun: () => Promise<{ ok: boolean; report?: any; error?: string }>
      webdavResolveConflict: (relPath: string, choice: 'local' | 'remote' | 'merge') => Promise<{ ok: boolean; error?: string }>
    }
  }
}
