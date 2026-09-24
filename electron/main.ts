// ============================================================
// main.ts ??Lumina Life 1.0 Electron 主进程（正式版）
//
// 核心架构: 多 Agent 协作 · 记忆系统 · 安全审查 · Session 管理 · 审批流
// ============================================================

// 必须在最顶部加载环境变量，否则 process.env 不生效
import 'dotenv/config'

import { app, BrowserWindow, globalShortcut, Tray, Menu, screen, nativeImage, ipcMain, Notification, dialog } from 'electron'
import { join } from 'path'
import { getAppIconPath, getTrayIcon } from './appIcon'
import { createTrayMenu, showTrayMenu } from './tray/trayMenu'

// ── 必须在 app.whenReady 前设置 ──────────────────────
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
// 约束每个渲染器的 V8 堆上限（防止长跑膨胀；桌面应用 768MB 足够）
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=768')
// 关闭用不到的 Chromium 功能，省一点常驻开销
app.commandLine.appendSwitch('disable-features', 'TranslateUI,LensOverlay')

import { createAppMenu } from './menu'
import { initAutoUpdater, destroyAutoUpdater } from './autoUpdater'
import { scheduleMemoryTrims } from './memoryManager'
import { getPluginManager } from './pluginSDK'
import { startCronLoop } from './tools/impl/cron'
import { initProactiveEngine, getProactiveEngine } from './proactiveEngine'
import { initUsageStats, getUsageStats, registerUsageStatsIpc } from './usageStats'     // 📊 v3.0: 使用数据统计
import { initProactiveNotifier } from './proactiveNotifier'  // 🆕 v3.8.1: UI 弹窗桥接
import { initMailStore } from './mailStore'
import { initSmartMailDispatcher } from './smartMailDispatcher'  // 🆕 v3.9.1: 智能邮件推送
import { initNewsDigestScheduler } from './newsDigestScheduler'  // 📡 v4.0: 新闻推送调度 (8/12/18/22)
import { initMomentsStore } from './moments/momentsStore'  // 🌸 v2.10
import * as momentsStore from './moments/momentsStore'     // 🌸 v2.10 IPC
import { initKnowledgeBase, getKnowledgeBase } from './knowledgeBase'  // 🧠 v3.9: 知识库
import { initComputerUse } from './computerUse'  // 🖥️ v3.10: 桌面操控
import * as petWindowNs from './pet/petWindow'  // 已被 orchestrator 静态拉入主 bundle，直接静态引用
import { registerPetIntentIpc, initPetLifeState } from './pet/intentDispatcher'
import { initSkillMarket } from './skillMarket'  // 📦 v3.10: Skill 市场
import { initGitAgent } from './gitAgent'  // 📝 v3.11: Git 自动集成
import { initMCPClient } from './mcpServer'  // 🔌 v3.11: MCP 协议
import { getTeamRegistry, registerTeamMember, unregisterTeamMember, initAcpSystem } from './core/teamRegistry'  // 👥 v9.3: 动态团队注册
import { initDeepResearch } from './deepResearch'  // 🔬 v3.11: Deep Research
import { initCloudSync } from './cloudSync'  // ☁️ v3.11: 云同步
// 🌙 v3.0: 梦境系统
import { generateTodayDream, generateTodayDreamAsync, registerDreamLLM, getAllDreams, getRecentDreams, getDreamByDate, deleteDream, getDreamStats } from './dream/dreamEngine'
// 多渠道推送
import { pushMessage, updatePushConfig, getPushConfig, DEFAULT_PUSH_CONFIG } from './push/pushService'
// 桌宠模式 -> 运行时动态加载，避免模块加载冲突
//     v3.0 -> v4.0 Plan C: 独立进程架构，初始化 -> await import() 加载
//     桌面小窗透明置顶，独立生命周期，与主进程通过 IPC 通信
// Agent 真人秀
import { startRealityShow, stopRealityShow, getShowHistory, triggerShowEvent, isRealityShowRunning, restartRealityShow, registerRealityShowLLM } from './realityShow/realityShowEngine'
// 游戏化系统
import { xpManager, XP_RULES, levelFromXp, xpProgress, getTitle } from './gamification/levels'
import { achievementManager, ACHIEVEMENTS } from './gamification/achievements'
import { loadGamificationData, saveGamificationData } from './gamification/index'
import { questManager } from './gamification/quests'
// 技能 SDK
import { generateSkillTemplate, exportSkillToDisk, getSDKHelp } from './skillSDK/skillSDKEngine'
// 测试覆盖
import { runTests, getDefaultSummary } from './testRunner/testRunnerEngine'
// 事件总线（用于跨模块事件转发）
import { globalEventBus, BusEvents } from './eventBus'

// ─── v6.0: Agent 独立 LLM 配置 + 委托管理器 ────────────
import { initAgentConfig, getAgentConfig } from './agentConfig'
import { requestCuAbort } from './tools/impl/cuCore'
import { LLMProvider } from './core/llmProvider'
import { initOrchestrator, getOrchestrator } from './core/agentOrchestrator'
// ─── P3-5: Agent 工作区管理器 ──────────────────────────
import { initAgentWorkspaceManager } from './agentWorkspaceManager'
// ─── v10.0: 统一 LLM Provider 管理器 (QwenPaw 风格) ──────
import { getProviderManager, registerProviderIpc } from './core/providerManager'
import { registerOnboardingIpc } from './onboarding/onboardingIpc'
import { registerCustomAgentIpc } from './ipc/customAgentIpc'
// ─── v8.0: 真·多 Agent 独立 Runner ──────────────────────
import { AgentRunner } from './agentRunner'
import { TEAM_MEMBERS } from './agentTeamPersonas'
import type { TeamMemberId } from './agentTeamTypes'

// ─── IPC 注册模块 ─────────────────────────────────────
import { registerAgentIpc } from './ipc/agentIpc'
import { registerMemoryIpc } from './ipc/memoryIpc'
import { registerBridgeIpc } from './ipc/bridgeIpc'
import { registerSystemIpc, cleanupSystemProcesses, autoStartEdgeTts } from './ipc/systemIpc'
import { registerSttModelIpc } from './whisper/sttModelIpc'  // 🎙 离线中文 STT 模型就绪检测/一键下载
import { registerTeamIpc, initTeamSocialEngine } from './ipc/teamIpc'
import { registerLoopIpc } from './ipc/loopIpc'
import { registerThemeIpc } from './ipc/themeIpc' // theme skin ecosystem

// ─── 🆕 v2.7 新模??────────────────────────────────────
import { initMessageQueue, getMessageQueue, destroyMessageQueue } from './messageQueue'
import { getSkillPool } from './skillPool'
import { initSecurityGuard, getSecurityGuard } from './securityGuard'
import { getSessionManager } from './sessionManager'
import { initApprovalService, getApprovalService } from './approvalService'
import { getCommandRouter, CommandRouter } from './chatCommands'
// 命令处理??+ Skill Market + Debug 面板
import { registerCommandHandlers } from './ipc/commandIpc'
import { registerSkillMarketIpc } from './ipc/skillMarketIpc'
import { registerComputerUseIpc } from './ipc/computerUseIpc'  // 🖥??v3.10
import { registerTeamCollabIpc } from './ipc/teamCollabIpc'  // 🤝 v3.20: 信箱/任务板/动态 worker/CU 策略
import { registerGitAgentIpc } from './ipc/gitAgentIpc'  // 📝 v3.11
import { registerMCPIpc } from './ipc/mcpIpc'  // 🔌 v3.11
import { registerDeepResearchIpc } from './ipc/deepResearchIpc'  // 🔬 v3.11
import { registerCodingModeIpc } from './ipc/codingModeIpc'
import { registerDiagnosticsIpc } from './ipc/diagnosticsIpc'
import { registerSandboxAuditIpc } from './ipc/sandboxAuditIpc'
import { registerPlatformIpc } from './ipc/platformIpc'
import { registerPushIpc } from './ipc/pushIpc'  // cross-platform feature matrix  // 🔍 I5: 沙箱透明审计
import { allFlags, setFlag as setFeatureFlag } from './core/featureFlags'  // I7: 功能开关
import { exportDataToZip, importDataFromZip, getDataLocations, defaultExportFileName } from './utils/dataExport'  // I6: 数据导出/导入
import { registerDramaLLM } from './team/relationshipDrama'  // I1: 团队关系剧本
import { registerLuckyModeIpc } from './ipc/luckyModeIpc'
import { registerArtifactIpc } from './ipc/artifactIpc'  // task workspace artifact file ops
import { registerModelStoreIpc } from './ipc/modelStoreIpc'  // v0.2 Live2D model store (local mode)
import { registerSkillRuntimeIpc } from './ipc/skillRuntimeIpc'  // v0.2 third-party skill runtime
import { registerMemoryFederationIpc } from './ipc/memoryFederationIpc'  // proposal3: memory federation
import { registerWebdavSyncIpc } from './ipc/webdavSyncIpc'  // proposal4: webdav sync
import { initLuckyModeIntegration } from './luckyModeIntegration'
import { initPanelRegistry, getPanelRegistry, listPanels } from './panelRegistry'
import { startConfigWatcher, stopConfigWatcher } from './configWatcher'
import { getModeManager, initModeManager } from './modeManager'
import { getWorkflowTemplateManager, initWorkflowTemplateManager } from './workflowTemplateManager'
import { initChannelManager, getChannelManager } from './channels/channelManager'

// ==================??// 状??// ==================??
let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false

// 桌宠模块（独立进程，Plan C 架构）
let petModule: Awaited<typeof import('./pet/petWindow')> | null = null

// 梦境/真人秀共用 LLM 调用：复用桌宠大脑配置（团队/全局 Provider），未配置则抛错→各自回退模板
async function lifeLLMCall(system: string, user: string): Promise<string> {
  const cfg = petWindowNs.resolvePetBrainConfig()
  if (!cfg) {throw new Error('LLM not configured for dream/reality')}
  const provider = petWindowNs.createPetLLM(cfg)
  const res = await provider.call({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.9,
    maxTokens: 420,
  } as any)
  return res?.text || ''
}

// 从记忆库抽取近期真实片段供梦境编织（五层记忆，任何失败安全降级为空）
function dreamMemorySnippet(): string {
  try {
    const { getMemoryStore } = require('./memory/memoryStore')
    const { buildLayeredRecall } = require('./memory/layeredMemory')
    const { createMemoryStoreAdapter } = require('./memory/layeredMemoryAdapter')
    const recall = buildLayeredRecall(createMemoryStoreAdapter(getMemoryStore()), {
      budget: { persona: 4, facts: 10, reflection: 3, recent: 3, working: 4 },
      maxLineLen: 90,
    })
    if (recall.prompt) {return recall.prompt}
    // 五层门面失败时退回旧桥
    const { buildPetMemoryContext } = require('./pet/petMemoryBridge')
    return buildPetMemoryContext(getMemoryStore(), { maxFacts: 12, maxSummaries: 4 }).snippet || ''
  } catch { return '' }
}

const WINDOW_CONFIG = {
  width: 1280,
  height: 820,
  minWidth: 900,
  minHeight: 600,
  transparent: false,
  frame: false,
  backgroundColor: '#ffffff',
  vibrancy: 'light' as any,
  titleBarStyle: 'hidden' as const,
}

// ==================??// 窗口创建
// ==================??
function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    ...WINDOW_CONFIG,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: true, // 主窗被遮挡/最小化时节流定时器、动画与媒体，降低常驻内存/CPU
      spellcheck: false,          // 非文档型应用，关闭拼写检查词典
    },
    icon: getAppIconPath(),
    show: false,
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  createAppMenu(win)

  // 让主动引擎通知点击时能稳定唤起主窗
  win.once('ready-to-show', () => {
    win.show()
    win.focus()
    ;(globalThis as any).__luminaMainWindow = win
  })
  win.on('show', () => { ;(globalThis as any).__luminaMainWindow = win })

  win.on('close', (e) => {
    if (!isQuitting) { e.preventDefault(); win.hide() }
  })

  win.on('closed', () => { mainWindow = null })

  // 🆕 DevTools 被用户点 X 关闭时也通知渲染进程恢复 compact
  win.webContents.on('devtools-closed', () => {
    win.webContents.send('window:devtools-changed', false)
  })

  return win
}

// ==================??// 托盘
// ==================??
function createTray(): void {
  const trayIcon = getTrayIcon()
  tray = new Tray(trayIcon.isEmpty() ? nativeImage.createEmpty() : trayIcon)

  tray.setToolTip('Lumina Life 1.0')

  // 自定义圆角浮层托盘菜单（替代原生 setContextMenu）
  let gameEnabled = process.env.LUMINA_GAME_ENABLED === '1' || process.env.LUMINA_GAME_ENABLED === 'true'
  createTrayMenu(tray, {
    actions: {
      toggleMainWindow: () => {
        if (!mainWindow) { return }
        if (mainWindow.isVisible()) { mainWindow.hide() } else { mainWindow.show() }
      },
      openSettings: () => {
        mainWindow?.show()
        mainWindow?.focus()
        mainWindow?.webContents.send('tray:open-settings')
      },
      openTaskWorkspace: () => {
        mainWindow?.show()
        mainWindow?.focus()
        mainWindow?.webContents.send('tray:open-task-workspace')
      },
      toggleGame: () => {
        gameEnabled = !gameEnabled
        process.env.LUMINA_GAME_ENABLED = gameEnabled ? '1' : '0'
        return gameEnabled
      },
      quit: () => {
        isQuitting = true
        app.quit()
      },
    },
    getState: () => ({
      online: true,
      mood: '在线',
      moodColor: '#4ade80',
      statusText: mainWindow?.isVisible() ? '在线' : '已隐藏',
      gameEnabled,
      windowVisible: !!mainWindow?.isVisible(),
    }),
  })

  // 左键 / 右键都弹出自定义浮层；双击直接显示主窗口
  tray.on('click', () => showTrayMenu())
  tray.on('right-click', () => showTrayMenu())
  tray.on('double-click', () => mainWindow?.show())
}

// ==================??// 快捷??// ==================??
function registerHotkeys(): void {
  globalShortcut.register('Ctrl+Shift+L', () => {
    if (mainWindow?.isVisible()) { mainWindow.hide() }
    else { mainWindow?.show() }
  })

  // Alt+Space ??全局呼出/隐藏 Lumina（类似游戏控制台?
globalShortcut.register('Alt+Space', () => {
    if (mainWindow?.isVisible()) { mainWindow.hide() }
    else { mainWindow?.show(); mainWindow?.focus() }
  })

  // Alt+Shift+L ??截图当前屏幕并发??Lumina 分析
  globalShortcut.register('Alt+Shift+L', () => {
    if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
      mainWindow.webContents.send('menu:capture-and-analyze')
    }
  })

  // Ctrl+Alt+X：Computer Use 全局急停（任何时候立即中止正在执行的桌面操控）
  globalShortcut.register('Ctrl+Alt+X', () => {
    try {
      requestCuAbort()
      console.log('[Hotkey] Computer Use abort requested (Ctrl+Alt+X)')
      new Notification({ title: 'Lumina', body: '🛑 已停止 Computer Use 正在执行的操作' }).show()
    } catch { /* 通知不可用时仍已置急停标志 */ }
  })
}

// ==================
// 面板插件系统 IPC
// ==================


// ==================
// ACP 团队解??IPC ??自定??Agent 成员
// ==================


// 注册右键上下文菜单
function registerContextMenu(mainWindow: BrowserWindow): void {
  mainWindow.webContents.on('context-menu', (_event, params) => {
    const { selectionText, isEditable } = params
    const template: Electron.MenuItemConstructorOptions[] = []

    // 标准编辑操作
    if (isEditable) {
      template.push(
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '全选', role: 'selectAll' },
      )
    } else if (selectionText && selectionText.trim()) {
      // 有选中文字 ??提供 Lumina 功能
      template.push(
        { label: '复制', role: 'copy' },
        { type: 'separator' },
        {
          label: '??Lumina 翻译',
          click: () => mainWindow.webContents.send('menu:lumina-task', {
            task: 'translate', text: selectionText.trim(),
          }),
        },
        {
          label: '??Lumina 总结',
          click: () => mainWindow.webContents.send('menu:lumina-task', {
            task: 'summarize', text: selectionText.trim(),
          }),
        },
        {
          label: '??Lumina 解释',
          click: () => mainWindow.webContents.send('menu:lumina-task', {
            task: 'explain', text: selectionText.trim(),
          }),
        },
        { type: 'separator' },
        {
          label: '🔍 让热茶审查代码',
          click: () => mainWindow.webContents.send('menu:lumina-task', {
            task: 'review_code', text: selectionText.trim(),
          }),
        },
      )
    } else {
      // 无选中文字 ??标准菜单
      template.push(
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
      )
    }

    // 只在有菜单项时弹出
    if (template.length > 0) {
      const menu = Menu.buildFromTemplate(template)
      menu.popup({ window: mainWindow })
    }
  })
}

// ==================
// 面板插件系统 IPC
// ==================


// ==================
// ACP 团队解??IPC ??自定??Agent 成员
// ==================


// ==================== CLI 模式检测 (v8.0) ====================
const isCLIMode = process.env.LUMINA_CLI_MODE === '1'
  || process.argv.includes('--cli')
  || process.argv.includes('--headless')

const isAPIMode = process.env.LUMINA_API_ENABLED === '1'
  || process.argv.includes('--api')

// 🔔 Windows Toast 通知身份（与 electron-builder appId 一致，否则打包后通知可能不显示）
app.setAppUserModelId('com.lumina.desktop-pet')

// ── 单实例锁：防止双击启动多个实例 ──────────────────────
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  console.log('[main] 已有实例在运行，退出当前实例')
  app.quit()
} else {
  app.on('second-instance', () => {
    // 第二个实例启动时，聚焦已有窗口
    const wins = BrowserWindow.getAllWindows()
    for (const w of wins) {
      if (w.isMinimized()) { w.restore() }
      w.show()
      w.focus()
    }
  })
}

// ==================??// 应用生命周期
// ==================??
app.whenReady().then(async () => {
  // ── 🔔 Windows 通知权限（尽早声明） ─────────────────
  try {
    const anyNotify = Notification as any
    if (typeof anyNotify.requestPermission === 'function' && anyNotify.permission === 'default') {
      await anyNotify.requestPermission()
    }
    // 同时确保通知具备显示条件
    if (typeof anyNotify.isSupported === 'function' && !anyNotify.isSupported()) {
      console.warn('[Notification] 当前环境不支持系统通知')
    }
  } catch {}

  // ── CLI 模式 ────────────────────────────────────────
  if (isCLIMode) {
    console.log('[main] 🖥️ CLI 模式启动')
    // 初始化核心服务
    // 🆗 静态 import 已在文件顶部完成，直接使用
    initSecurityGuard({ enabled: true })
    initApprovalService({ enabled: false })
    const agentConfig = initAgentConfig()
    initOrchestrator()
    console.log('[main] Agent 配置已加??', agentConfig.getAllStatus().length)
    // 运行 CLI (直接传入 process.argv，由 runCLI 自行解析)
    const { default: runCLI } = await import('./cli/index')
    await runCLI(process.argv)
    app.quit()
    return
  }

  // ── 🔒 安全策略 ─────────────────────────────────────
  // 安全已通过 webPreferences 保障（contextIsolation + nodeIntegration:false + sandbox），
  // 不在 Response Header 层加 CSP（会误伤 dev server HMR / file:// 协议加载）??  // 如需对外部加载的 webview ??CSP，在 webview 标签??partition 上单独设置??
  // ── v6.0: 初始??Agent 独立 LLM 配置 + 委托管理??──
  const agentConfig = initAgentConfig()
  initOrchestrator()
  console.log('[main] v6.0 Agent 独立 LLM 配置已加载',
    agentConfig.getAllStatus().map(s => `${s.icon}${s.name}=${s.configured ? s.model : '未配置'}`).join(', '),
  )

  // ── P3-5: 初始化 Agent 工作区管理器 ──
  const agentWorkspace = initAgentWorkspaceManager()
  console.log('[main] P3-5 Agent 工作区已初始化',
    Object.keys(agentWorkspace.profiles.getAll()).map(id => `${id}`).join(', '),
  )

  // ── v10.0: 初始化统一 Provider 管理??───────────────
  const pm = getProviderManager(app.getPath('userData'))
  await pm.initialize()
  const activeId = pm.getActiveProviderId()
  if (activeId) {
    console.log(`[main] ✅ 已激活 LLM 提供者: ${activeId}`)
  } else {
    console.log('[main] ⚠️ 未激活任何 LLM 提供者')
  }

  // ── v8.0: 初始化各 Agent 独立 Runner ─────────────────
  // Yak 和热茶创建持??Runner，注册到 DelegationManager
  // Lumina ??Runner ??agentIpc 按需创建（每次聊天可重建?
const orch = getOrchestrator()
  const workerIds: TeamMemberId[] = ['yak', 'recha']

  /** Worker 不应有的工具 ??后台 Worker 不需要前??网络/MCP/桌面操控类工??*/
  const WORKER_BLOCKED_TOOLS = [
    'browser', 'web_fetch', 'web_search', 'web_search_multi', 'serpapi_search', 'tavily_search', 'tavily_extract',
    'screenshot', 'ocr',
    'desktop_see', 'desktop_act', 'desktop_click', 'desktop_type', 'desktop_key', 'desktop_screen_size', 'desktop_scan',
    'hearing_start', 'hearing_stop', 'hearing_status', 'hearing_transcript',
    'keyboard_press', 'keyboard_type',
    'mail_send', 'mail_list', 'mail_mark_read',
    'mcp_connect', 'mcp_list_servers', 'mcp_list_tools', 'mcp_call_tool',
    'skill_run', 'use_skill', 'install_skill', 'quick_setup',
    'proactive_status', 'proactive_trigger', 'proactive_check',
    'notification', 'open_file', 'clipboard_get', 'clipboard_set',
    'weather',
    'mode_switch', 'mode_status',
    'oath_make', 'oath_list', 'oath_fulfill', 'appointment_set', 'appointment_list',
    'content_collect',
    'ast_search', 'lsp_symbols', 'lsp_references',
    'delegate_to',  // Worker 不调用委??    'delegate_chain',  // Worker 不运行流水线
  ]
  /** Yak 额外禁止 ??审查/分析类工??*/
  const YAK_EXTRA_BLOCKED: string[] = []
  /** 热茶额外禁止 ??写文??执行命令类工??*/
  const RECHA_EXTRA_BLOCKED = [
    'file_write', 'file_edit',
    'shell_exec',
    'git_status', 'git_commit', 'git_log', 'git_diff',
    'cron_schedule', 'cron_list', 'cron_cancel',
    'todo',
  ]

  for (const id of workerIds) {
    if (agentConfig.isConfigured(id)) {
      const member = TEAM_MEMBERS[id]
      const extraBlocked = id === 'recha' ? RECHA_EXTRA_BLOCKED : YAK_EXTRA_BLOCKED
      const runner = new AgentRunner({
        mode: 'agent',
        personaId: id,
        // v8.0: 不传 systemPrompt ??buildYakPrompt/buildRechaPrompt 已包含完??persona
        // 避免 initSystemPrompt 追加「自定义指令」造成提示词重??        model: '',
        baseUrl: '',
        apiKey: '',
        skipApproval: true,        // 后台 Worker 不需要用户逐项审批
        isChildAgent: true,        // 过滤 blockedInChild 工具
        disabledTools: [...WORKER_BLOCKED_TOOLS, ...extraBlocked],
      } as any)
      orch.registerRunner(id, runner)
      console.log(`[main] 🚀 ${member?.icon} ${id} 独立 Runner 已创建（${member?.name}）`)
    } else {
      console.log(`[main] ⏭️ ${id} 未配??LLM，跳??Runner 创建`)
    }
  }

  // 初始??Agent 常驻?
try {
    const { initAgentPool } = await import('./agentPool')
    const pool = initAgentPool({ persistentAgents: ['yak', 'recha', 'lumina'] })
    // 把已创建??Runner 注册到池（或由池接管?
for (const { id } of orch.listRunners()) {
      pool.markUsed(id)
    }
    console.log('[main] 🏊 Agent 常驻池已初始')
  } catch (err: any) {
    console.warn(`[main] ⚠️ Agent 常驻池启动可?? ${err.message}`)
  }

  // ── v8.0: 初始化 API 服务 (如果启用) ──────────────
  if (isAPIMode || process.env.LUMINA_API_ENABLED === '1') {
    const apiPort = parseInt(process.env.LUMINA_API_PORT || '3456', 10)
    const apiHost = process.env.LUMINA_API_HOST || '127.0.0.1'
    const apiKey = process.env.LUMINA_API_KEY || null
    try {
      const { initApiServer } = await import('./api/server')
      const api = initApiServer({ enabled: true, port: apiPort, host: apiHost, apiKey })
      await api.start()
      console.log(`[main] 🌐 API 服务器已启动: http://${apiHost}:${apiPort}`)
    } catch (err: any) {
      console.error(`[main] ⚠️ API 服务器启动失?? ${err.message}`)
    }
  }

  // ── 📡 Phase C: 初始化渠道管理器 ────────────────────
  try {
    const channelManager = initChannelManager()
    // .x: 初始化渠道↔Agent 桥接器
    let channelBridge: any = null
    try {
      const { initChannelAgentBridge } = await import('./channels/channelAgentBridge')
      channelBridge = initChannelAgentBridge()
      console.log(`[main] 📡 渠道 Agent 桥接器已初始化`)
    } catch (err: any) {
      console.warn(`[main] ⚠️ 渠道 Agent 桥接器加载失败: ${err.message}`)
    }

    await channelManager.init(async (msg) => {
      // 渠道消息 → Agent 处理
      console.log(`[Channel] 收到消息: [${msg.channel}] ${msg.fromUserName || msg.fromUser}: ${msg.text.slice(0, 80)}`)
      if (channelBridge) {
        channelBridge.handleMessage(msg).catch((err: any) => {
          console.error(`[Channel] Agent 处理失败:`, err.message)
        })
      }
    })
    console.log(`[main] 📡 渠道管理器已初始化`)
  } catch (err: any) {
    console.warn(`[main] ⚠️ 渠道管理器启动可能失败: ${err.message}`)
  }

  // 1. 窗口
  mainWindow = createWindow()

  // 2. 托盘 + 快捷??+ 右键菜单
  try { createTray() } catch { /* tray not available */ }
  // 低风险常驻内存治理（启动后/隐藏后清缓存，不影响本地资源与桌宠）
  try { scheduleMemoryTrims(() => mainWindow) } catch (e) { console.warn('[MemoryManager] 启动失败（忽略）:', e) }
  try { registerHotkeys() } catch { /* hotkeys not available */ }
  registerContextMenu(mainWindow)

  // 🔧 F12 开发者工具快捷键
  try {
    globalShortcut.register('F12', () => {
      if (mainWindow) {
        mainWindow.webContents.toggleDevTools()
        const opened = mainWindow.webContents.isDevToolsOpened()
        setTimeout(() => {
          mainWindow?.webContents.send('window:devtools-changed', opened)
        }, 300)
      }
    })
    console.log('[main] 🔧 F12 开发者工具快捷键已注')
  } catch (e) {
    console.warn('[main] ⚠️ F12 快捷键注册失??', e)
  }

  // 3. 注册所??IPC handler
  registerAgentIpc(mainWindow)
  registerCommandHandlers()                           // 🆕 v3.5: 斜杠命令处理??  registerSkillMarketIpc()                            // 🆕 v3.5: Skill 市场 IPC
  registerComputerUseIpc()                            // 🖥??v3.10: 桌面操控 IPC
  registerGitAgentIpc()                               // 📝 v3.11: Git Agent IPC
  registerMCPIpc()                                    // 🔌 v3.11: MCP IPC
  registerDeepResearchIpc()                           // 🔬 v3.11: Deep Research IPC
  registerCodingModeIpc()                             // 🆕 v3.5: Coding Mode IPC
  registerLuckyModeIpc()                              // 🍀 v1.0: Lucky 模式 IPC
  initLuckyModeIntegration()                          // 🍀 Lucky 模式深度集成初始??  registerDiagnosticsIpc(mainWindow)                  // 🆕 v3.5: 诊断面板 IPC
  startConfigWatcher(__dirname)                        // 🆕 v3.5: 配置热重??  registerMemoryIpc()
  registerBridgeIpc(mainWindow)
  registerSystemIpc(mainWindow)
  registerSttModelIpc(() => mainWindow)          // 🎙 离线语音模型（whisper-base 多语种/中文）
  registerProviderIpc()
  registerOnboardingIpc()                                 // 🧭 Setup Wizard: 首次启动引导
  registerCustomAgentIpc()                                // 🤖 自定义 Agent 管理                               // 📡 v10.0: 统一 Provider IPC
  registerTeamIpc()                                   // 🆕 v2.6: AI 小团队系统 IPC
  registerTeamCollabIpc()                             // 🤝 v3.20: 信箱/任务板/动态 worker/CU 策略
  registerLoopIpc()                                   // 🔁 Phase 4: Loop 磁盘持久化 IPC
  registerThemeIpc()                                   // 🎨 theme skin ecosystem
  registerSandboxAuditIpc()                            // 🔍 I5: 沙箱审计/玻璃房 IPC
  registerPlatformIpc()
  registerPushIpc()
  registerArtifactIpc(() => mainWindow)
  registerModelStoreIpc()                            // v0.2 Live2D model store (local/offline)
  registerSkillRuntimeIpc()                          // v0.2 third-party skill runtime (sandbox+approval+scan)            // task workspace artifact file ops
  registerMemoryFederationIpc()                       // proposal3: memory federation
  registerWebdavSyncIpc()                            // proposal4: webdav sync                                 // cross-platform feature matrix IPC
  ipcMain.handle('feature-flags:get-all', () => allFlags())  // I7: 全量功能开关
  ipcMain.handle('feature-flags:set', (_e, key: string, value: boolean) => { setFeatureFlag(key as any, !!value); return { ok: true, key, value } })  // I7: 写回开关
  ipcMain.handle('data:get-locations', () => getDataLocations())  // I6: 本机数据位置
  ipcMain.handle('data:export-zip', async () => {  // I6: 导出记忆 zip
    const { canceled, filePath } = await dialog.showSaveDialog({ defaultPath: defaultExportFileName(), filters: [{ name: 'Lumina 记忆包', extensions: ['zip'] }] })
    if (canceled || !filePath) { return { ok: false, canceled: true } }
    return exportDataToZip(filePath)
  })
  ipcMain.handle('data:import-zip', async () => {  // I6: 导入记忆 zip（主键去重）
    const { canceled, filePaths } = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Lumina 记忆包', extensions: ['zip'] }] })
    if (canceled || !filePaths || !filePaths[0]) { return { ok: false, canceled: true } }
    return importDataFromZip(filePaths[0])
  })
  registerGamificationIpc()                           // 🎮 v3.0: 游戏化系统 IPC

  // 3.5.1 🎭 v6.0: 社交引擎初始化（Agent 朋友??团队闲聊?
const socialLlmCall = async (
    personaId: string,
    prompt: string,
    _context?: Record<string, unknown>,
  ): Promise<string> => {
    const cfg = getAgentConfig().get(personaId as any)
    if (!cfg || !cfg.enabled || !cfg.model || !cfg.endpoint) {return ''}
    try {
      const provider = new LLMProvider({
        baseUrl: cfg.endpoint,
        apiKey: cfg.apiKey || '',
        model: cfg.model,
        maxContextTokens: cfg.maxContextTokens || 4096,
        socialMode: true,
        personaId,
      })
      const response = await provider.call({
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.9,
        maxTokens: 512,
      })
      return response.text || ''
    } catch (err) {
      console.error(`[SocialEngine] ??LLM 调用失败 (${personaId}):`, err)
      return ''
    }
  }
  initTeamSocialEngine(socialLlmCall)

  // 3.6 📬 Agent 邮箱初始??  initMailStore()

  // 3.6.1 📨 v3.9.1: 智能邮件调度??(早安摘要/Token告警/安全告警)
  initSmartMailDispatcher()

  // 3.6.2 📡 v4.0: 新闻推送调??(8:00/12:00/18:00/22:00 四时??
  initNewsDigestScheduler()

  // 3.7 🌸 v2.10: Agent 朋友圈初始化
  initMomentsStore()

  // 3.8 🧠 v3.9: 知识库初始化
  initKnowledgeBase()

  // 3.9 🖥️ v3.10: 桌面操控引擎初始化
  try {
    const _cuAgentCfg = getAgentConfig()
    const _cuLumina = _cuAgentCfg.isConfigured('lumina') ? _cuAgentCfg.get('lumina') : null
    initComputerUse({
      safetyLevel: 'ask',
      llmBaseUrl: _cuLumina?.endpoint || process.env.LUMINA_VLM_BASE_URL || process.env.LLM_BASE_URL,
      llmApiKey: _cuLumina?.apiKey || process.env.LUMINA_VLM_API_KEY || process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '',
      llmModel: process.env.LUMINA_VLM_MODEL || _cuLumina?.model || process.env.LLM_MODEL,
    })
  } catch {
    initComputerUse({ safetyLevel: 'ask' })
  }

  // 3.10 📦 v3.10: Skill 市场初始??+ 安装内置 skill
  const skillMarket = initSkillMarket()
  skillMarket.installBundledSkills()

  // 3.11 📝 v3.11: Git Agent 初始?
try {
    initGitAgent(process.cwd())
  } catch { /* */ }

  // 3.12 🔌 v3.11: MCP Client 初始化（npx 可能不可用，静默跳过?
try {
    const mcpClient = initMCPClient()
    mcpClient.installBuiltinServer('fetch').catch(() => {})
  } catch { /* npx not available, MCP features will be disabled */ }

  // 3.13 🔬 v3.11: Deep Research 初始?
try {
    initDeepResearch({
      llmApiKey: process.env.OPENAI_API_KEY,
      llmBaseUrl: process.env.OPENAI_BASE_URL,
      llmModel: process.env.LLM_MODEL,
    })
  } catch { /* */ }

  // 3.14 ☁️ v3.11: 云同步初始化
  const cloudSync = initCloudSync()
  cloudSync.init().catch(() => {})  // 异步初始??
  // ── 💻 v4.0 Plan C: 桌宠模块（独立进程）─────────────
  try {
    petModule = petWindowNs
    petModule.registerPetIpc()
    petModule.maybeShowOnboarding()   // 首次使用：N.E.K.O 风格初始人格引导
    // 随 Lumina 启动：如果 autoRestart=true，自动开启桌宠
    try {
      const petCfg = petModule.getPetConfig()
      if (petCfg.autoRestart) {
        console.log('[main] 🐱 随 Lumina 启动：自动开启桌宠')
        petModule.togglePet(true, mainWindow)
      }
    } catch (e) { console.warn('[main] 桌宠自启动失败:', e) }
    console.log('[main] 🐱 桌宠模块已加载（独立进程架构）')
  } catch (e: any) {
    console.warn('[main] ⚠️ 桌宠模块加载失败（降级运行）:', e.message)
  }

  // ──  Phase 1 Week 1: 桌宠意图调度器（LLM → 动作标签 → Live2D）──
  try {
    registerPetIntentIpc()
    initPetLifeState() // 启动即恢复内驱力/情绪并周期落盘，重启不回基线
  } catch (e: any) {
    console.warn('[main] ⚠️ 桌宠意图调度器加载失败（降级运行）:', e.message)
  }

  // ── 🐍 v4.0 Plan C: Python Agent Node ───────────────
  try {
    const { startPythonServices, getPythonManager } = await import('./pythonManager')
    await startPythonServices()
    console.log('[main] 🐍 Python Agent Node 已启用')
  } catch (e: any) {
    console.warn('[main] ⚠️ Python Agent Node 启动失败（降级运行）:', e.message)
  }

  // 3.5 Edge TTS 开机自启（await 确保首次对话前服务已就绪??  //     窗口异步加载 HTML 期间并行等待，ready-to-show 前大概率完成
  await autoStartEdgeTts()

  // 4. 自动更新
  initAutoUpdater(mainWindow)

  // 5. Cron 调度循环 (v2.5: 主进程统一管理)
  startCronLoop(mainWindow)

  // 6. 插件系统
  try {
    const pluginMgr = getPluginManager()
    pluginMgr.attachWindow(mainWindow)
  } catch { /* plugins not available */ }

  // 7. 🆕 24/7 主动对话引擎
  // 屏幕感知和热搜感知默认开启（间隔已调优，避免过于频繁）
  const proactiveEngine = initProactiveEngine({
    enabled: true,
    screenWatchEnabled: true,     // 默认开启屏幕感知（10分钟间隔）
    hotTopicEnabled: true,        // 默认开启热搜感知（30分钟间隔）
  })
  proactiveEngine.start()

  // 启动后触发启动问候（延迟3秒等LLM就绪）
  setTimeout(() => {
    try {
      getProactiveEngine().fireEvent('app:start')
    } catch { /* engine may not be ready */ }
  }, 3000)

  // 主动引擎 ??渲染进程通知桥接 (右上角弹??
  initProactiveNotifier()

  // 使用数据统计（所有阶段共用）
  initUsageStats()

  // ── 🎯 v2.0 第二阶段: 场景感知 + 模式管理 ────────────
  try {
    initModeManager(mainWindow)
    initWorkflowTemplateManager()
    initPanelRegistry?.()
    registerModeIpc(mainWindow)
    registerWorkflowIpc()
    registerPanelIpc()
    registerAcpIpc()
    console.log('[main] 🎯 场景模式管理器已启动')
  } catch (e: any) {
    console.warn('[main] ⚠️ 场景模式管理器启动失败:', e.message)
  }

  // 游戏化系统初始化（从持久化恢复）
try {
    // 尝试加载持久化数?
const gamificationData = loadGamificationData()
    if (gamificationData) {
      xpManager.setState(gamificationData.totalXp, gamificationData.todayXp, gamificationData.lastResetDate)
      achievementManager.setStats({
        totalChats: gamificationData.userStats?.totalChats || 0,
        totalMessages: gamificationData.userStats?.totalMessages || 0,
        toolsUsed: gamificationData.userStats?.toolsUsed || [],
        totalToolCalls: gamificationData.userStats?.totalToolCalls || 0,
        totalAffinity: gamificationData.userStats?.totalAffinity || 0,
        daysActive: gamificationData.userStats?.daysActive || 1,
        streakDays: gamificationData.userStats?.streakDays || 1,
        memoriesSaved: gamificationData.userStats?.memoriesSaved || 0,
        tasksCompleted: gamificationData.userStats?.tasksCompleted || 0,
        modeSwitches: gamificationData.userStats?.modeSwitches || 0,
        timeCapsulesBuried: gamificationData.userStats?.timeCapsulesBuried || 0,
        unlockedAchievements: gamificationData.unlockedAchievements || [],
      })
    }
    console.log(`[main] 🎮 游戏化系统已初始化 Lv.${levelFromXp(xpManager.getState().totalXp)} (${xpManager.getState().totalXp} XP)`)
  } catch (e) {
    console.warn('[main] ⚠️ 游戏化初始化失败:', e)
  }

  // 🎮 成就/等级事件 ??转发到渲染进??+ 自动保存
  try {
    globalEventBus.on(BusEvents.ACHIEVEMENT_UNLOCKED, (achievement: any) => {
      mainWindow?.webContents.send('gamification:achievement', achievement)
      saveGamificationData()
    })
    globalEventBus.on(BusEvents.LEVEL_UP, (data: any) => {
      mainWindow?.webContents.send('gamification:level-up', data)
      saveGamificationData()
    })
    globalEventBus.on(BusEvents.XP_GAINED, (data: any) => {
      mainWindow?.webContents.send('gamification:xp', data)
      saveGamificationData()
    })
    // 任务更新 -> 转发到渲染进程
    globalEventBus.on(BusEvents.QUEST_UPDATED, (data: any) => {
      mainWindow?.webContents.send('gamification:quests-updated', data)
    })
    // 每 30 秒定期保存（防崩溃丢数据）
    setInterval(() => { saveGamificationData() }, 30_000)
  } catch {}

  // 🌙 v3.0: 梦境系统: 每分钟检查是否该生成今日梦境 (3:00 触发)
  // 也监听 app:start 事件，启动时尝试生成
  setInterval(() => {
    const now = new Date()
    if (now.getHours() === 3 && now.getMinutes() === 0) {
      generateTodayDreamAsync(dreamMemorySnippet()).catch(() => {})
    }
  }, 60_000)
  // 启动时也尝试一次（如果还不到凌??点，只对新用户生效）
  setTimeout(() => generateTodayDreamAsync(dreamMemorySnippet()).catch(() => {}), 10_000)

  // Agent 真人秀 ??启动后台生成??0 秒间隔）
  // 梦境/真人秀接上 LLM（复用桌宠大脑配置；未配置时各自回退模板彩蛋）
  registerDreamLLM(lifeLLMCall)
  registerRealityShowLLM((_agent: string, sys: string) => lifeLLMCall(sys, ''))
  registerDramaLLM((prompt: string) => lifeLLMCall(prompt, ''))  // I1: 团队关系剧本走真实 LLM，未配置回退模板
  // Agent 真人秀（后台生成，60s 间隔；内心独白优先 LLM，其余为剧本）
  startRealityShow(60_000)

  // 📡 新闻推送事??Windows 通知 + 转发到渲染进?
try {
    globalEventBus.on('news:digest-pushed' as any, (data: any) => {
      mainWindow?.webContents.send('news:digest-pushed', data)
      // Windows 10/11 Toast 通知
      if (process.platform === 'win32') {
        try {
          const notif = new Notification({
            title: '📡 Lumina 新闻早报',
            body: `${data?.count || 0} 条新闻已推送到邮箱\n${data?.date || ''}`,
            silent: false,
            icon: getAppIconPath(),
          })
          notif.show()
          // 点击通知打开新闻面板
          notif.on('click', () => {
            mainWindow?.show()
            mainWindow?.webContents.send('navigate', 'news')
          })
        } catch (e) {
          console.warn('[main] 通知发送失??', e)
        }
      }
    })
  } catch {}

  // MCP 新闻工具 ??注册??MCP 客户?
try {
    const { getNewsMCPTools } = require('./newstools/mcpNewsServer')
    const tools = getNewsMCPTools(mainWindow)
    // 通过 globalEventBus 暴露??MCP 系统
    globalEventBus.on('mcp:register-tools' as any, () => {
      tools.forEach((t: any) => {
        globalEventBus.emit('mcp:register-tool' as any, t)
      })
    })
  } catch (e) {
    console.warn('[main] MCP 新闻工具注册失败:', e)
  }

  // 🎬 真人秀事件 ??转发到渲染进?
try {
    globalEventBus.on(BusEvents.REALITY_SHOW_EVENT, (event: any) => {
      mainWindow?.webContents.send('reality:show:event', event)
    })
    // 梦境事件 -> 转发到渲染进程
    globalEventBus.on(BusEvents.DREAM_NEW, (dream: any) => {
      mainWindow?.webContents.send('dream:new', dream)
    })
    // 副人格冲突事件 -> 转发到渲染进程
    globalEventBus.on(BusEvents.PERSONALITY_CONFLICT, (conflict: any) => {
      mainWindow?.webContents.send('personality:conflict', conflict)
    })
  } catch {}

  // 7b. 🆕 Window IPC handlers (关于 / 开发者工具)
  ipcMain.handle('window:show-about', () => {
    const { dialog } = require('electron')
    dialog.showMessageBox(mainWindow!, {
      type: 'info',
      title: '关于 Lumina Life',
      message: 'Lumina Life',
      detail: `版本: 1.0\nElectron: ${process.versions.electron}\nChrome: ${process.versions.chrome}\nNode.js: ${process.versions.node}\n\n© 2026 Lumina Team. All rights reserved.`,
      buttons: ['确定'],
    })
  })
  ipcMain.handle('window:toggle-dev-tools', () => {
    if (mainWindow?.webContents.isDevToolsOpened()) {
      mainWindow.webContents.closeDevTools()
      mainWindow.webContents.send('window:devtools-changed', false)
    } else {
      mainWindow?.webContents.openDevTools()
      setTimeout(() => {
        mainWindow?.webContents.send('window:devtools-changed', true)
      }, 300)
    }
  })

  // 8. 🆕 ProactiveEngine IPC handlers
  ipcMain.handle('proactive:status', () => getProactiveEngine().getStatus())
  ipcMain.handle('proactive:update-config', (_e: any, config: any) => {
    getProactiveEngine().updateConfig(config)
    return { ok: true }
  })
  ipcMain.handle('proactive:update-trigger', (_e: any, id: string, updates: any) => {
    const ok = getProactiveEngine().updateTrigger(id, updates)
    return { ok }
  })
  ipcMain.handle('proactive:test-trigger', (_e: any, id: string) => {
    const trigger = getProactiveEngine().getTriggers().find(t => t.id === id)
    if (!trigger) {return { ok: false, error: '触发器不存在' }}
    // 强制激活指定触发器
    getProactiveEngine().forceActivate(id)
    return { ok: true }
  })
  ipcMain.handle('proactive:get-triggers', () => getProactiveEngine().getTriggers())
  ipcMain.handle('proactive:heartbeat', () => {
    getProactiveEngine().heartbeat()
    // 同步通知团队系统用户活跃
    try {
      const { getTeamProactive } = require('./teamProactiveSystem')
      getTeamProactive()?.noteUserActivity()
    } catch { /* 团队系统可能未初始化 */ }
    return { ok: true }
  })
  ipcMain.handle('proactive:screen-context', () => {
    return getProactiveEngine().getLastScreenContext()
  })
  // 主动通知开
  ipcMain.handle('proactive:setNotify', (_e: any, enabled: boolean) => {
    getProactiveEngine().updateConfig({ notificationsEnabled: enabled })
    return { ok: true }
  })
  // 通知引擎用户发送了消息（机会感知用
  ipcMain.handle('proactive:user-message', () => {
    getProactiveEngine().noteUserMessage()
    getUsageStats().recordMessage()
    // 同步通知团队系统
    try {
      const { getTeamProactive } = require('./teamProactiveSystem')
      getTeamProactive()?.noteUserActivity()
    } catch { /* 团队系统可能未初始化 */ }
    return { ok: true }
  })

  // 使用数据统计 IPC
  registerUsageStatsIpc()

  // Agent 常驻??IPC
  try {
    const { getAgentPool } = await import('./agentPool')
    ipcMain.handle('agent-pool:status', () => getAgentPool().getStatus())
    ipcMain.handle('agent-pool:config', () => getAgentPool().getConfig())
    ipcMain.handle('agent-pool:update-config', (_e: any, config: any) => {
      getAgentPool().updateConfig(config)
      return { ok: true }
    })
    ipcMain.handle('agent-pool:compress', async (_e: any, id: string) => {
      const ok = await getAgentPool().compress(id)
      return { ok }
    })
  } catch (err: any) {
    console.warn(`[main] ⚠️ Agent ??IPC 注册失败: ${err.message}`)
  }

  // P3 意图路由 IPC
  try {
    const { initIntentRouter, getIntentRouter } = await import('./intentRouter')
    initIntentRouter()
    ipcMain.handle('router:classify', (_e: any, message: string) => {
      return getIntentRouter().classify(message)
    })
    ipcMain.handle('router:config', () => {
      return getIntentRouter().getConfig()
    })
    ipcMain.handle('router:update-config', (_e: any, config: any) => {
      getIntentRouter().updateConfig(config)
      return { ok: true }
    })
    ipcMain.handle('router:rules', () => {
      return getIntentRouter().getRules()
    })
  } catch (err: any) {
    console.warn(`[main] ⚠️ 意图路由 IPC 注册失败: ${err.message}`)
  }

  // P4 权限控制 IPC
  try {
    const { initAccessController, getAccessController } = await import('./accessControl')
    initAccessController()
    ipcMain.handle('access:permissions', () => {
      return getAccessController().getAllPermissions()
    })
    ipcMain.handle('access:permissions-for', (_e: any, agentId: string) => {
      return getAccessController().getPermissions(agentId as any) || null
    })
    ipcMain.handle('access:update-permissions', (_e: any, agentId: string, patch: any) => {
      const ok = getAccessController().updatePermissions(agentId as any, patch)
      return { ok }
    })
    ipcMain.handle('access:reset-permissions', (_e: any, agentId: string) => {
      const ok = getAccessController().resetPermissions(agentId as any)
      return { ok }
    })
    ipcMain.handle('access:check-file', (_e: any, agentId: string, filepath: string) => {
      return getAccessController().checkReadPath(agentId as any, filepath)
    })
    ipcMain.handle('access:check-write', (_e: any, agentId: string, filepath: string) => {
      return getAccessController().checkWritePath(agentId as any, filepath)
    })
    ipcMain.handle('access:violations', (_e: any, agentId?: string) => {
      return getAccessController().getViolations(agentId as any)
    })
    ipcMain.handle('access:clear-violations', () => {
      getAccessController().clearViolations()
      return { ok: true }
    })
  } catch (err: any) {
    console.warn(`[main] ⚠️ 权限控制 IPC 注册失败: ${err.message}`)
  }

  // 沙箱 IPC handlers
  try {
    const { initSandbox, getSandbox } = await import('./sandbox')
    const sandbox = await initSandbox()

    ipcMain.handle('sandbox:config', () => {
      return sandbox.getConfig()
    })
    ipcMain.handle('sandbox:add-authorized-dir', async (_e: any, params: any) => {
      return await sandbox.addAuthorizedDir(params)
    })
    ipcMain.handle('sandbox:remove-authorized-dir', async (_e: any, dirId: string) => {
      const ok = await sandbox.removeAuthorizedDir(dirId)
      return { ok }
    })
    ipcMain.handle('sandbox:agent-dir', (_e: any, agentId: string) => {
      return { sandboxDir: sandbox.getAgentSandboxDir(agentId) }
    })
    ipcMain.handle('sandbox:update-agent', async (_e: any, agentId: string, patch: any) => {
      await sandbox.updateAgentConfig(agentId, patch)
      return { ok: true }
    })
    ipcMain.handle('sandbox:check-path', async (_e: any, agentId: string, filePath: string, operation: string) => {
      return await sandbox.checkFileAccess(agentId, filePath, operation as any)
    })
  } catch (err: any) {
    console.warn(`[main] ⚠️ 沙箱 IPC 注册失败: ${err.message}`)
  }


  // 8.5 🌸 v2.10: Agent 朋友??Moments IPC handlers
  ipcMain.handle('moments:post', (_e: any, params: any) => {
    try {
      const moment = momentsStore.postMoment(params)
      mainWindow?.webContents.send('moments:new-moment', moment)
      return { ok: true, moment }
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
  })
  ipcMain.handle('moments:timeline', (_e: any, params: any) => {
    try {
      return momentsStore.getTimeline(params || {})
    } catch (e: any) {
      return { moments: [], total: 0, error: e.message }
    }
  })
  ipcMain.handle('moments:delete', (_e: any, id: number) => {
    try { return { ok: momentsStore.deleteMoment(id) } }
    catch (e: any) { return { ok: false, error: e.message } }
  })
  ipcMain.handle('moments:like', (_e: any, momentId: number, agentId: string) => {
    try { return momentsStore.likeMoment(momentId, agentId) }
    catch (e: any) { return { liked: false, likeCount: 0, error: e.message } }
  })
  ipcMain.handle('moments:comments', (_e: any, momentId: number) => {
    try { return { comments: momentsStore.getComments(momentId) } }
    catch (e: any) { return { comments: [], error: e.message } }
  })
  ipcMain.handle('moments:add-comment', (_e: any, momentId: number, agentId: string, agentName: string, content: string) => {
    try {
      const comment = momentsStore.addComment(momentId, agentId, agentName, content)
      return { ok: true, comment }
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
  })
  ipcMain.handle('moments:recent-summary', (_e: any, limit?: number) => {
    try { return { summary: momentsStore.getRecentSummary(limit) } }
    catch (e: any) { return { summary: '', error: e.message } }
  })

  // 报告持久??IPC
  ipcMain.handle('reports:save', (_e: any, params: any) => {
    try {
      const report = momentsStore.saveReport(params)
      return { ok: true, report }
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
  })
  ipcMain.handle('reports:list', (_e: any, params: any) => {
    try {
      return momentsStore.getReports(params || {})
    } catch (e: any) {
      return { reports: [], total: 0, error: e.message }
    }
  })
  ipcMain.handle('reports:latest', (_e: any, type?: string) => {
    try {
      const report = momentsStore.getLatestReport(type)
      return { report }
    } catch (e: any) {
      return { report: null, error: e.message }
    }
  })

  // ==================??  // 8.7 👥 v9.3: 动态团队注??IPC handlers
  // ==================??
  ipcMain.handle('team:list-members', () => {
    try {
            return getTeamRegistry().getAllMembers()
    }
    catch (e: any) { return [] }
  })
  ipcMain.handle('team:register-member', (_e: any, reg: any) => {
    try {
            const ok = getTeamRegistry().register(reg)
      return { ok, error: ok ? undefined : 'ID 已存在或为内置成员' }
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
  })
  ipcMain.handle('team:unregister-member', (_e: any, id: string) => {
    try {
            const ok = getTeamRegistry().unregister(id)
      return { ok, error: ok ? undefined : `成员 ${id} 不存在或是内置成员` }
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
  })

  // ==================??  // 8.6 🧠 v3.9: 知识??IPC handlers
  // ==================?
const kb = getKnowledgeBase()

  ipcMain.handle('kb:stats', () => kb.getStats())
  ipcMain.handle('kb:list', () => kb.listDocuments())
  ipcMain.handle('kb:search', (_e: any, query: string, topK?: number) => kb.search(query, topK || 5))
  ipcMain.handle('kb:get-doc', (_e: any, id: string) => kb.getDocument(id) || null)
  ipcMain.handle('kb:delete-doc', (_e: any, id: string) => kb.deleteDocument(id))
  ipcMain.handle('kb:update-doc', (_e: any, id: string, updates: any) => kb.updateDocument(id, updates))
  ipcMain.handle('kb:rag-context', (_e: any, query: string, maxTokens?: number) => kb.buildRAGContext(query, maxTokens || 2000))
  ipcMain.handle('kb:import-file', async (_e: any, filePath: string) => {
    try {
      const doc = await kb.importFile(filePath)
      return { ok: true, doc }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })
  ipcMain.handle('kb:import-url', async (_e: any, url: string, title: string, content: string) => {
    try {
      const doc = await kb.importUrl(url, title, content)
      return { ok: true, doc }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })
  ipcMain.handle('kb:create-note', async (_e: any, title: string, content: string, tags?: string[]) => {
    try {
      const doc = await kb.createNote(title, content, tags)
      return { ok: true, doc }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })

  // ==================??  // 9. 🆕 v2.7 新模块初始化
  // ==================??
  // 9.1 消息队列
  initMessageQueue(async (item) => {
    console.log(`[MessageQueue] 处理消息: ${item.channel}/${item.sessionId} priority=${item.priority}`)
    // 消息 -> Agent IPC 处理，这里做日志和事件转发
    mainWindow?.webContents.send('bridge:message', {
      channel: item.channel,
      sessionId: item.sessionId,
      priority: item.priority,
      payload: item.payload,
    })
  })

  // 9.2 分级安全审查
  initSecurityGuard({
    enabled: true,
    blockCritical: true,
    requireApprovalForHigh: true,
    logAll: true,
  })

  // 9.3 审批流服?
const approvalService = initApprovalService({
    enabled: true,
    defaultTimeoutMs: 300_000,
  })

  // 审批事件 ??推送到渲染进程
  approvalService.on('approval:requested', (request) => {
    mainWindow?.webContents.send('approval:requested', request)
  })
  approvalService.on('approval:resolved', (request, decision) => {
    mainWindow?.webContents.send('approval:resolved', { request, decision })
  })

  // 9.4 Session 管理?
const sessionManager = getSessionManager()
  // 启动时恢复未完成 session
  const recovered = sessionManager.recoverIncompleteSessions()
  if (recovered.length > 0) {
    console.log(`[SessionManager] 恢复??${recovered.length} 个未完成??session`)
    mainWindow?.webContents.send('session:recovered', recovered)
  }

  // 9.5 聊天命令路由注册
  const cmdRouter = getCommandRouter()
  cmdRouter.registerAll({
    help: async (p) => ({
      success: true,
      message: cmdRouter.generateHelp(p.args[0]),
    }),
    compact: async () => {
      mainWindow?.webContents.send('command:compact')
      return { success: true, message: '已触发上下文压缩' }
    },
    new: async () => {
      mainWindow?.webContents.send('command:new-session')
      return { success: true, message: '已开始新对话。之前的关键上下文已保留' }
    },
    stop: async () => {
      mainWindow?.webContents.send('command:stop-agent')
      return { success: true, message: '已停止当前 Agent' }
    },
    skills: async (p) => {
      const pool = getSkillPool()
      const workspaceId = p.args[0] || 'default'
      const skills = pool.listWorkspaceSkills(workspaceId)
      if (skills.length === 0) {return { success: true, message: `workspace "${workspaceId}" 中没有安??skills。` }}
      const list = skills.map(s => `${s.emoji} **${s.name}** v${s.version} ??${s.description}`).join('\n')
      return { success: true, message: `## ${workspaceId} ??Skills\n\n${list}` }
    },
    agents: async () => {
      const agents = [
        { name: 'luna', emoji: '🐱', desc: '温暖猫娘: 陪伴、聊天、情感支持' },
        { name: 'ray', emoji: '💻', desc: '毒舌程序员: 写代码、Debug、技术问题' },
        { name: 'sora', emoji: '📊', desc: '冷静分析师: 搜索、研究、数据分析' },
        { name: 'assistant', emoji: '🤖', desc: '通用助手 ??综合任务处理' },
      ]
      const list = agents.map(a => `${a.emoji} **${a.name}** ??${a.desc}`).join('\n')
      return { success: true, message: `## 可用 Agent 角色\n\n${list}\n\n使用 \`/switch <name>\` 切换。` }
    },
    switch: async (p) => {
      const validRoles = ['luna', 'ray', 'sora', 'assistant']
      const target = p.args[0]?.toLowerCase()
      if (!validRoles.includes(target)) {
        return { success: false, message: `无效角色。可?? ${validRoles.join(', ')}` }
      }
      mainWindow?.webContents.send('command:switch-agent', target)
      return { success: true, message: `已切换到 ${target}。` }
    },
    approve: async (p) => {
      const result = getApprovalService().approve(p.args[0])
      if (!result) {return { success: false, message: `审批失败: 未找??ID "${p.args[0]}" 或已过期。` }}
      return { success: true, message: `已批准操?? ${result.toolName}` }
    },
    deny: async (p) => {
      const result = getApprovalService().deny(p.args[0], '用户拒绝')
      if (!result) {return { success: false, message: `拒绝失败: 未找??ID "${p.args[0]}" 或已过期。` }}
      return { success: true, message: `已拒绝操?? ${result.toolName}` }
    },
    plan: async (p) => {
      mainWindow?.webContents.send('command:create-plan', p.args.join(' '))
      return { success: true, message: '正在创建执行计划...' }
    },
    stats: async () => {
      mainWindow?.webContents.send('command:show-stats')
      return { success: true, message: '正在加载用量统计...' }
    },
    clear: async () => {
      mainWindow?.webContents.send('command:clear-chat')
      return { success: true, message: '聊天记录已清空（记忆不受影响）' }
    },
    export: async (p) => {
      const format = p.args[0] || 'markdown'
      mainWindow?.webContents.send('command:export', format)
      return { success: true, message: `正在导出??${format} 格式...` }
    },
  })

  // 9.6 v2.7 新增 IPC handlers
  registerV27Ipc(mainWindow)

  console.log('[Lumina] 主进程就绪 (v1.0.0)')
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {app.quit()}
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) { mainWindow = createWindow() }
  else { mainWindow?.show() }
})

app.on('before-quit', () => {
  isQuitting = true
  // 🎮 保存游戏化数据（XP + 成就）
  try { saveGamificationData() } catch {}
  // 🫀 保存桌宠内驱力/情绪（重启延续，不回基线）
  try {
    const { flushPetLifeState } = require('./pet/intentDispatcher')
    flushPetLifeState()
  } catch { /* intent dispatcher not loaded */ }
  cleanupSystemProcesses()
  // 🐍 v4.0 Plan C: 关闭 Python Agent Node
  try {
    const { getPythonManager } = require('./pythonManager')
    getPythonManager().stop()
  } catch { /* python manager not loaded */ }
  destroyAutoUpdater()
  destroyMessageQueue()
  getApprovalService().stop()
  // v8.0: 关闭 API 服务?
try {
    const { getApiServer } = require('./api/server')
    getApiServer().stop()
  } catch { /* api server not loaded */ }
  // 持久化所有活??session
  try {
    const sm = getSessionManager()
    const active = sm.listSessions({ completed: false })
    for (const s of active) {
      const data = sm.loadSession(s.id)
      if (data) {sm.completeSession(s.id)}
    }
  } catch { /* ignore */ }
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

// ==================??// v2.7 IPC 处理器注??// ==================??
function registerV27Ipc(mainWindow: BrowserWindow): void {
  // ── Skill Pool ──────────────────────────────────────
  ipcMain.handle('skill-pool:list', () => getSkillPool().listAllSkills())
  ipcMain.handle('skill-pool:install', async (_e, zipPath: string) => getSkillPool().installFromZip(zipPath))
  ipcMain.handle('skill-pool:download', async (_e, skillName: string, workspaceId: string) =>
    getSkillPool().downloadToWorkspace(skillName, workspaceId))
  ipcMain.handle('skill-pool:remove', async (_e, skillName: string, workspaceId: string) =>
    getSkillPool().removeFromWorkspace(skillName, workspaceId))
  ipcMain.handle('skill-pool:delete', async (_e, skillName: string) =>
    getSkillPool().deleteFromPool(skillName))
  ipcMain.handle('skill-pool:workspace-skills', async (_e, workspaceId: string) =>
    getSkillPool().listWorkspaceSkills(workspaceId))
  ipcMain.handle('skill-pool:check-updates', async (_e, workspaceId: string) =>
    getSkillPool().checkForUpdates(workspaceId))
  ipcMain.handle('skill-pool:sync', async (_e, workspaceId: string) =>
    getSkillPool().syncWorkspace(workspaceId))

  // ── Message Queue ───────────────────────────────────
  ipcMain.handle('queue:stats', () => getMessageQueue().getStats())
  ipcMain.handle('queue:pending', (_e, channel: string, sessionId: string) =>
    getMessageQueue().getPendingCount(channel, sessionId))
  ipcMain.handle('queue:clear', (_e, channel: string, sessionId: string) => {
    getMessageQueue().clearChannel(channel, sessionId)
    return { ok: true }
  })

  // ── Security Guard ──────────────────────────────────
  ipcMain.handle('security:check-message', (_e, text: string) =>
    getSecurityGuard().checkMessage(text))
  ipcMain.handle('security:audit-log', (_e, limit?: number) =>
    getSecurityGuard().getAuditLog(limit))
  ipcMain.handle('security:config', () => getSecurityGuard().getConfig())
  ipcMain.handle('security:update-config', (_e, config: any) => {
    getSecurityGuard().updateConfig(config)
    return { ok: true }
  })

  // ── Approval Service ────────────────────────────────
  ipcMain.handle('approval:pending', () => getApprovalService().listPending())
  ipcMain.handle('approval:history', (_e, limit?: number) => {
    const all = getApprovalService().listCompleted()
    return limit ? all.slice(0, limit) : all
  })
  ipcMain.handle('approval:stats', () => {
    const svc = getApprovalService()
    return {
      pendingCount: svc.pendingCount,
      executionLevel: svc.executionLevel,
      locale: svc.locale,
    }
  })
  ipcMain.handle('approval:approve', (_e, id: string, note?: string) =>
    getApprovalService().approve(id, note))
  ipcMain.handle('approval:deny', (_e, id: string, note?: string) =>
    getApprovalService().deny(id, note))
  ipcMain.handle('approval:update-config', (_e, config: any) => {
    getApprovalService().updateConfig(config)
    return { ok: true }
  })

  // ── Session Manager ─────────────────────────────────
  ipcMain.handle('session:list', (_e, filter?: any) =>
    getSessionManager().listSessions(filter))
  ipcMain.handle('session:recover', () =>
    getSessionManager().recoverIncompleteSessions())
  ipcMain.handle('session:search', (_e, query: string) =>
    getSessionManager().searchSessions(query))
  ipcMain.handle('session:export', (_e, sessionId: string, format: string) =>
    getSessionManager().exportSession(sessionId, format as any))
  ipcMain.handle('session:delete', (_e, sessionId: string) => {
    getSessionManager().deleteSession(sessionId)
    return { ok: true }
  })
  ipcMain.handle('session:cleanup', (_e, maxAgeDays?: number) => {
    const count = getSessionManager().cleanupOldSessions(maxAgeDays)
    return { ok: true, count }
  })

  // ── Chat Commands ───────────────────────────────────
  ipcMain.handle('command:parse', (_e, input: string) => {
    const parsed = getCommandRouter().parse(input)
    if (!parsed) {return null}
    return { command: parsed.command.name, args: parsed.args }
  })
  ipcMain.handle('command:execute', async (_e, input: string) => {
    const parsed = getCommandRouter().parse(input)
    if (!parsed) {return { success: false, message: '不是有效命令' }}
    return await getCommandRouter().execute(parsed)
  })
  ipcMain.handle('command:help', (_e, cmdName?: string) =>
    getCommandRouter().generateHelp(cmdName))

  // ── Token Estimator (用于前端显示) ──────────────────
  ipcMain.handle('token:estimate', (_e, text: string) => {
    const { TokenEstimator } = require('./tokenEstimator')
    const estimator = new TokenEstimator()
    return estimator.estimate(text)
  })

  // ── 🌙 Dream System IPC ──────────────────────────────
  ipcMain.handle('dream:list', () => getAllDreams())
  ipcMain.handle('dream:recent', (_e, count?: number) => getRecentDreams(count ?? 7))
  ipcMain.handle('dream:get', (_e, date: string) => getDreamByDate(date))
  ipcMain.handle('dream:delete', (_e, id: string) => deleteDream(id))
  ipcMain.handle('dream:stats', () => getDreamStats())
  ipcMain.handle('dream:generate', () => {
    const ok = generateTodayDream()
    return { ok, dreams: getAllDreams() }
  })

  // ── 📱 Push System IPC ──────────────────────────────
  ipcMain.handle('push:update-config', (_e, config: Partial<typeof DEFAULT_PUSH_CONFIG>) => {
    updatePushConfig(config)
    return { ok: true }
  })
  ipcMain.handle('push:get-config', () => getPushConfig())
  ipcMain.handle('push:test-serverchan', async (_e, key: string) => {
    const oldKey = getPushConfig().serverChanKey
    updatePushConfig({ serverChanKey: key })
    const result = await pushMessage({ title: '🔔 Lumina 推送测', content: '如果你收到这条消息，说明推送配置成功！', category: 'custom' })
    updatePushConfig({ serverChanKey: oldKey })
    return { ok: result.serverChan }
  })
  ipcMain.handle('push:test-dingtalk', async (_e, webhook: string, secret: string) => {
    const oldConfig = getPushConfig()
    updatePushConfig({ dingTalkWebhook: webhook, dingTalkSecret: secret })
    const result = await pushMessage({ title: '🔔 Lumina 推送测', content: '如果你收到这条消息，说明推送配置成功！', category: 'custom' })
    updatePushConfig(oldConfig)
    return { ok: result.dingTalk }
  })

  // ── 📡 渠道配置 IPC (v16.0-fix) ────────────────────
  ipcMain.handle('channel:get-configs', async () => {
    try {
      const configs = getChannelManager().getConfigs()
      return configs.map((c, i) => ({
        key: `channel_${i}`,
        type: c.type,
        name: c.name,
        enabled: c.enabled,
        credentials: c.credentials,
      }))
    } catch { return [] }
  })
  ipcMain.handle('channel:update-config', async (_e, key: string, config: any) => {
    try {
      const cm = getChannelManager()
      const existing = cm.getConfigs()
      const idx = parseInt(key.replace('channel_', ''), 10) || -1
      if (idx >= 0 && idx < existing.length) {
        // 保留 options（前端配置表单不包含 options 字段）
        const mergedOptions = config.options ?? existing[idx].options ?? {}
        await cm.updateConfig(`channel_${idx}`, {
          ...existing[idx],
          ...config,
          options: mergedOptions,
        })
      } else {
        // 新增渠道
        await cm.updateConfig(key, {
          enabled: config.enabled,
          type: config.type,
          name: config.name,
          credentials: config.credentials || {},
          options: config.options ?? {},
        })
      }
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })
  ipcMain.handle('channel:get-status', async () => {
    try {
      return getChannelManager().getStatus()
    } catch { return [] }
  })
  ipcMain.handle('channel:test', async (_e, key: string) => {
    try {
      const ok = await getChannelManager().startChannel(key)
      return { ok }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })

  // ── 🎬 Agent 真人秀 IPC ──────────────────────────────
  ipcMain.handle('reality:history', (_e, count?: number) => getShowHistory(count ?? 50))
  ipcMain.handle('reality:trigger', (_e, event?: any) => triggerShowEvent(event))
  ipcMain.handle('reality:status', () => isRealityShowRunning())
  ipcMain.handle('reality:restart', (_e, intervalMs?: number) => restartRealityShow(intervalMs))

  // ── 📦 Skill SDK IPC ──────────────────────────────
  ipcMain.handle('skill-sdk:generate', (_e, params: any) => {
    const result = generateSkillTemplate(params)
    return { files: result.files, manifest: result.manifest }
  })
  ipcMain.handle('skill-sdk:export', (_e, dirName: string, files: Record<string, string>) => {
    const ok = exportSkillToDisk(dirName, files)
    return { ok }
  })
  ipcMain.handle('skill-sdk:help', () => getSDKHelp())

  // ── 🧪 Test Runner IPC ──────────────────────────────
  ipcMain.handle('test:summary', () => getDefaultSummary())
  ipcMain.handle('test:run', async () => {
    const result = await runTests()
    return result
  })
}

// ==================
// 面板插件系统 IPC
// ==================


// ==================
// ACP 团队解??IPC ??自定??Agent 成员
// ==================


// ==============================
// v8.1: Panel Plugin IPC - Skill/Plugin UI Panels
// ==============================

function registerPanelIpc(): void {
  // getPanelRegistry and listPanels are imported at top of file

  ipcMain.handle('panel:list', (_e: any, placement?: string) => {
    try { const panels = listPanels(placement as any); return { ok: true, panels } }
    catch (e: any) { return { ok: false, error: e.message, panels: [] } }
  })

  ipcMain.handle('panel:get', (_e: any, id: string) => {
    try { const panel = getPanelRegistry().getPanel(id); return panel ? { ok: true, panel } : { ok: false, error: 'Not found' } }
    catch (e: any) { return { ok: false, error: e.message } }
  })

  ipcMain.handle('panel:list-all', () => {
    try { return { ok: true, panels: getPanelRegistry().getAllPanels() } }
    catch (e: any) { return { ok: false, error: e.message, panels: [] } }
  })

  ipcMain.handle('panel:set-enabled', (_e: any, id: string, enabled: boolean) => {
    try { const ok = getPanelRegistry().setEnabled(id, enabled); return { ok } }
    catch (e: any) { return { ok: false, error: e.message } }
  })

  ipcMain.handle('panel:register', (_e: any, reg: any) => {
    try { const panel = getPanelRegistry().register({ ...reg, source: 'user' }); return { ok: true, panel } }
    catch (e: any) { return { ok: false, error: e.message } }
  })

  ipcMain.handle('panel:unregister', (_e: any, id: string) => {
    try { const ok = getPanelRegistry().unregister(id); return { ok } }
    catch (e: any) { return { ok: false, error: e.message } }
  })
}

// ==============================
// v8.1: ACP Decoupling IPC - Custom Agent Members
// ==============================

function registerAcpIpc(): void {
  // getTeamRegistry, registerTeamMember, unregisterTeamMember are imported at top of file

  const acpMembersPath = (() => {
    try { const { app } = require('electron'); return require('path').join(app.getPath('userData'), 'acp-members.json') }
    catch { return require('path').join(process.cwd(), 'acp-members.json') }
  })()

  function loadAcpMembers(): void {
    try {
      const fs = require('fs')
      if (fs.existsSync(acpMembersPath)) {
        const members = JSON.parse(fs.readFileSync(acpMembersPath, 'utf-8'))
        for (const m of members) {registerTeamMember(m)}
        console.log('[ACP] Loaded ' + members.length + ' ACP members')
      }
    } catch (e: any) { console.warn('[ACP] Load failed:', e.message) }
  }

  function persistAcpMembers(): void {
    try {
      const fs = require('fs')
      const members = getTeamRegistry().getDynamicMembers().filter((m: any) => m.acpConfig)
      fs.writeFileSync(acpMembersPath, JSON.stringify(members, null, 2), 'utf-8')
    } catch (e: any) { console.warn('[ACP] Persist failed:', e.message) }
  }

  loadAcpMembers()

  ipcMain.handle('acp:register', (_e: any, config: any) => {
    try {
      const result = registerTeamMember({
        id: config.id || ('acp_' + Date.now()),
        name: config.name || 'ACP Agent',
        icon: config.icon || '🤖',
        role: 'worker',
        description: config.description || '',
        capabilities: config.capabilities || [],
        blindSpots: config.blindSpots || [],
        triggers: config.triggers || [],
        registeredAt: new Date().toISOString(),
        acpConfig: {
          url: config.url || '',
          apiKey: config.apiKey || '',
          model: config.model || '',
          systemPrompt: config.systemPrompt || '',
          temperature: config.temperature ?? 0.7,
          maxTokens: config.maxTokens || 4096,
        },
      })
      if (result) {persistAcpMembers()}
      return { ok: result }
    } catch (e: any) { return { ok: false, error: e.message } }
  })

  ipcMain.handle('acp:update', (_e: any, id: string, updates: any) => {
    try {
      const registry = getTeamRegistry()
      const existing = registry.getMember(id) as any
      if (!existing) {return { ok: false, error: 'Member not found' }}
      if (registry.isBuiltIn(id)) {return { ok: false, error: 'Cannot edit built-in member' }}
      registry.unregister(id)
      registerTeamMember({ ...existing, ...updates, id, acpConfig: { ...(existing.acpConfig || {}), ...(updates.acpConfig || {}) } })
      persistAcpMembers()
      return { ok: true }
    } catch (e: any) { return { ok: false, error: e.message } }
  })

  ipcMain.handle('acp:list', () => {
    try {
      const all = getTeamRegistry().getAllMembers()
      return {
        ok: true,
        builtIn: (all as any[]).filter((m: any) => getTeamRegistry().isBuiltIn(m.id)),
        dynamic: (all as any[]).filter((m: any) => !getTeamRegistry().isBuiltIn(m.id)),
      }
    } catch (e: any) { return { ok: false, error: e.message, builtIn: [], dynamic: [] } }
  })

  ipcMain.handle('acp:unregister', (_e: any, id: string) => {
    try { const ok = unregisterTeamMember(id); if (ok) {persistAcpMembers();} return { ok } }
    catch (e: any) { return { ok: false, error: e.message } }
  })

  ipcMain.handle('acp:send-message', async (_e: any, id: string, message: string) => {
    try {
      const registry = getTeamRegistry()
      const member = registry.getMember(id) as any
      if (!member) {return { ok: false, error: 'Member not found' }}
      if (!member.acpConfig?.url) {return { ok: false, error: 'ACP member has no URL configured' }}
      return { ok: true, response: '[ACP] Message sent to ' + member.name, simulated: true }
    } catch (e: any) { return { ok: false, error: e.message } }
  })

  console.log('[ACP] Custom member IPC registered')
}

// ==============================
// v8.1: 场景模式 IPC
// ==============================

function registerModeIpc(mainWindow: BrowserWindow): void {
  const mgr = getModeManager()

  ipcMain.handle('mode:get', () => {
    try { return mgr.getState() }
    catch (e: any) { return { error: e.message } }
  })

  ipcMain.handle('mode:set', (_e: any, mode: string) => {
    try { mgr.setMode(mode); return { ok: true, mode: mgr.getState() } }
    catch (e: any) { return { ok: false, error: e.message } }
  })

  ipcMain.handle('mode:config', (_e: any, mode?: string) => {
    try { return mgr.getModeConfig(mode) }
    catch (e: any) { return { error: e.message } }
  })

  ipcMain.handle('mode:update-config', (_e: any, mode: string, overrides: any) => {
    try { mgr.updateModeConfig(mode, overrides); return { ok: true } }
    catch (e: any) { return { ok: false, error: e.message } }
  })

  ipcMain.handle('mode:all-configs', () => {
    try { return { ok: true, configs: mgr.getAllConfigs() } }
    catch (e: any) { return { ok: false, error: e.message, configs: {} } }
  })

  ipcMain.handle('mode:release-override', () => {
    try { mgr.releaseOverride(); return { ok: true } }
    catch (e: any) { return { ok: false, error: e.message } }
  })

  ipcMain.handle('mode:detect-now', async () => {
    try {
      const { detectScene } = require('./sceneDetector')
      const scene = await detectScene()
      return { ok: true, scene }
    } catch (e: any) { return { ok: false, error: e.message } }
  })

  ipcMain.handle('mode:custom-create', (_e: any, meta: any) => {
    try { const m = mgr.addCustomMode(meta); return { ok: true, mode: m } }
    catch (e: any) { return { ok: false, error: e.message } }
  })

  ipcMain.handle('mode:custom-delete', (_e: any, id: string) => {
    try { const ok = mgr.removeCustomMode(id); return { ok } }
    catch (e: any) { return { ok: false, error: e.message } }
  })

  ipcMain.handle('mode:custom-list', () => {
    try { return { ok: true, modes: mgr.listCustomModes() } }
    catch (e: any) { return { ok: false, error: e.message, modes: [] } }
  })

  ipcMain.handle('mode:scene', () => {
    try { return { ok: true, scene: mgr.getState().scene } }
    catch (e: any) { return { ok: false, error: e.message } }
  })

  console.log('[ModeManager] IPC registered')
}

// ==============================
// v8.1: 工作流模板 IPC
// ==============================

function registerWorkflowIpc(): void {
  const mgr = getWorkflowTemplateManager()

  ipcMain.handle('workflow:list', () => {
    try { return { ok: true, templates: mgr.listTemplates() } }
    catch (e: any) { return { ok: false, error: e.message, templates: [] } }
  })

  ipcMain.handle('workflow:get', (_e: any, id: string) => {
    try { const t = mgr.getTemplate(id); return t ? { ok: true, template: t } : { ok: false, error: 'Not found' } }
    catch (e: any) { return { ok: false, error: e.message } }
  })

  ipcMain.handle('workflow:create', (_e: any, data: any) => {
    try { const t = mgr.createTemplate(data); return { ok: true, template: t } }
    catch (e: any) { return { ok: false, error: e.message } }
  })

  ipcMain.handle('workflow:update', (_e: any, id: string, data: any) => {
    try { const t = mgr.updateTemplate(id, data); return t ? { ok: true, template: t } : { ok: false, error: 'Not found' } }
    catch (e: any) { return { ok: false, error: e.message } }
  })

  ipcMain.handle('workflow:delete', (_e: any, id: string) => {
    try { const ok = mgr.deleteTemplate(id); return { ok } }
    catch (e: any) { return { ok: false, error: e.message } }
  })

  ipcMain.handle('workflow:activate', (_e: any, id: string) => {
    try { return mgr.activateTemplate(id) }
    catch (e: any) { return { ok: false, error: e.message } }
  })

  ipcMain.handle('workflow:search', (_e: any, query: string) => {
    try { return { ok: true, templates: mgr.searchTemplates(query) } }
    catch (e: any) { return { ok: false, error: e.message, templates: [] } }
  })

  console.log('[WorkflowTemplateManager] IPC registered')
}

// ==============================
// v3.0: 游戏化系统 IPC
// ==============================

function registerGamificationIpc(): void {
  // 🎮 游戏化统计
  ipcMain.handle('gamification:stats', () => {
    try {
      const xpState = xpManager.getState()
      const progress = xpManager.progress
      return {
        ok: true,
        data: {
          totalXp: xpState.totalXp,
          todayXp: xpState.todayXp,
          level: progress.level,
          currentXp: progress.currentXp,
          nextLevelXp: progress.nextLevelXp,
          progress: progress.progress,
          title: xpManager.title,
          unlockedAchievements: achievementManager.getStats().unlockedAchievements,
          userStats: achievementManager.getStats(),
        },
      }
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
  })

  // 🏆 已解锁成就列表
  ipcMain.handle('gamification:achievements', () => {
    try {
      return {
        ok: true,
        data: achievementManager.getStats().unlockedAchievements,
        all: ACHIEVEMENTS.map(a => ({
          id: a.id,
          name: a.name,
          description: a.description,
          icon: a.icon,
          category: a.category,
          hidden: a.hidden || false,
          unlocked: achievementManager.getStats().unlockedAchievements.includes(a.id),
        })),
      }
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
  })

  // 每日任务
  // ──────────────────────────────────────────────────

  ipcMain.handle('gamification:quests', () => {
    try {
      return { ok: true, data: questManager.getDailyQuests() }
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
  })

  ipcMain.handle('gamification:quests-update-progress', (_event, stats: any) => {
    try {
      const result = questManager.updateProgress(stats || {})
      return { ok: true, data: result }
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
  })

  ipcMain.handle('gamification:quests-claim', (_event, questId: string) => {
    try {
      const ok = questManager.claimReward(questId)
      return { ok, data: ok ? '领取成功' : '领取失败（未完成/已领取）' }
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
  })

  ipcMain.handle('gamification:quests-claim-streak', () => {
    try {
      const bonus = questManager.claimStreakBonus()
      return { ok: true, bonus }
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
  })

  console.log('[Gamification] 🎮 IPC 处理器已注册')
}
