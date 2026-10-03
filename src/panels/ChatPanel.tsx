// ============================================================
// ChatPanel.tsx — 聊天面板 (v2.3)
//
// v2.3 改进:
//   1. 🗂️左侧历史对话列表 (P1.2)
//   2. 🎵 TTS 音色切换下拉
//   3. Agent ReAct Loop + 情绪引擎
//   4. P0.3: 语音输入 (STT) 🎤
//   5. P1.1: 主动对话系统集成
//   6. P1.4: avatar_state 上下文传递
// ============================================================


import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useStore } from '../stores/appStore'
import { useAgentRuntime } from '../stores/agentRuntimeStore'
import { sttService, type STTStatus } from '../services/sttService'
import { ttsEngine } from '../services/ttsEngine'
import { proactiveChat } from '../services/proactiveChat'
import { getDisabledToolNames } from '../stores/appStore'
import PersonalityConflictAlert from '../components/PersonalityConflictAlert'
import { IconPlus, IconSend } from '../components/Icons'
import ModelSelector from '../components/ModelSelector'
import { DEFAULT_PERSONAS, getPersona, getPersonaPrompt } from '../data/personas'
import { AGENT_ROLES, getAgentRole } from '../data/agentRoles'
import { useLoopStore } from '../stores/loopStore'
import { detectLoopIntent } from '../services/loopEngine'
import ProactiveSidebar from '../components/ProactiveSidebar'
import MomentsPanel from '../components/MomentsPanel'
import AgentTaskBoard from '../components/AgentTaskBoard'
import TaskWorkspacePanel from '../components/TaskWorkspacePanel'
import ThinkingStepList, { normalizeThinkingStep } from '../components/ThinkingStepList'
import { useTaskWorkspace } from '../stores/taskWorkspaceStore'
import AgentMoments from '../components/AgentMoments'
import MemoryTheater from '../components/MemoryTheater'
import GroupChatHistorySidebar from '../components/GroupChatHistorySidebar'
import GroupChatView from '../panels/GroupChatView'
import { updateEmotion, emotionContext } from '../services/agentEmotion'
import { injectEmotionStyles } from '../components/AgentEmotionBar'
import { addBookmark } from '../services/messageBookmarks'
import { showToast } from '../components/Toast'
import LinkifiedText from '../components/LinkifiedText'
import { shouldAutoOpen } from '../utils/linkifyText'
import { buildAgentPrompt, AGENT_SOULS } from '../data/agentSouls'
import {
  calculateSpark,
  calculateChainSpark,
  detectUncertainty,
  detectMentionInReply,
} from '../services/conversationDynamics'
import LuckyModeSelector from '../components/LuckyModeSelector'
import TaskDispatcher from '../components/TaskDispatcher'
import DecisionCard, { type DecisionRequest } from '../components/DecisionCard'
import SubagentCards from '../components/SubagentCards'
import TheaterMount from '../components/TheaterMount'
import { TASK_TYPE_CARDS, TEAM_MEMBERS, type TaskType } from '../data/agentRoles'
import ContextUsageIndicator from '../components/ContextUsageIndicator'
import LuckyModeSettings from '../components/LuckyModeSettings'
import { useLuckyMode } from '../hooks/useLuckyMode'
import type { LuckySettingsConfig } from '../components/LuckyModeSettings'
import {
  TTS_VOICES, AGENT_VOICES, AUTONOMY_INTERVAL,
  AGENTS, TEAM_CONV_ID, EMOJI_GROUPS,
  type GCMsg, type GCSession, type AgentTask, type AgentPost, type LLMPanelState, type ThinkingStep,
  loadGCSessions, saveGCSessions, loadGCMessages, saveGCMessages, newGCSessionId,
  loadLLMData, saveLLMData, loadAgentVoices, saveAgentVoices,
  setLLMRefreshFn, _llmState, _llmNotify, _startAutonomyTimer, _stopAutonomyTimer, _startAutonomyWithRemaining, _autonomyTimer,
  useLLMPanels,
  cleanTtsText, formatDateLabel, getConvPreview, insertAtCursor, getAgentSystemPrompt,
} from '../chat/chatShared'

/**
 * 新 assistant 回复落地后调用：仅当 browser.autoOpenLinks 开关开启、
 * 且回复里确有 http/https 链接时，才自动在内置浏览器打开「主要 URL」。
 * 每次回复现读配置，开关改动即时生效，无需额外监听。全程静默失败，不打扰用户。
 *
 * 【判据：!== false，而不是 === true】
 * 该开关的产品默认是「开」（见 CONFIG_DEFAULTS.browser.autoOpenLinks）。
 * 旧用户配置文件里可能根本没有这个键，此时 `=== true` 会读到 undefined，
 * 表现为「设置面板显示已开启，但回复里从不自动打开」——
 * 幽灵状态是最难排查的一类 bug。
 * `!== false` 的语义是：键缺失 → 走默认（开）；只有用户显式关过才是关。
 * 必须与 BrowserLinksPanel / memoryIpc 的 CONFIG_DEFAULTS 保持同一套判据。
 */
async function maybeAutoOpenBrowserOnReply(text: string): Promise<void> {
  try {
    const cfg = await window.luminaAPI.getConfig()
    const enabled = cfg?.browser?.autoOpenLinks !== false
    const target = shouldAutoOpen(text, enabled)
    if (target) {void window.luminaAPI.openBrowser(target)}
  } catch { /* 静默失败 */ }
}

export default function ChatPanel() {
  const conversations = useStore(s => s.conversations)
  const activeConversationId = useStore(s => s.activeConversationId)
    const createConversation = useStore(s => s.createConversation)
  const deleteConversation = useStore(s => s.deleteConversation)
  const deleteMessageFromStore = useStore(s => s.deleteMessage)
  const renameConversation = useStore(s => s.renameConversation)
  const togglePinConversation = useStore(s => s.togglePinConversation)
  const switchConversation = useStore(s => s.switchConversation)
  const isProcessing = useStore(s => s.isProcessing)
  const setIsProcessing = useStore(s => s.setIsProcessing)
  const addMsg = ((useStore as any).getState() as any).addMessage as (...args: any[]) => void

  const llmConfig = useStore(s => s.llmConfig)
  const addTokenUsage = useStore(s => s.addTokenUsage)
  const addAuditLog = useStore(s => s.addAuditLog)
  const ttsConfig = useStore(s => s.ttsConfig)
  const setTTSConfig = useStore(s => s.setTTSConfig)
  const ttsMuted = useStore(s => s.ttsMuted)
  const ttsToggle = useStore(s => s.ttsToggle)

  const activePersona = useStore(s => s.activePersona)
  const setActivePersona = useStore(s => s.setActivePersona)
  const agentConfig = useStore(s => s.agentConfig)
  const setAgentConfig = useStore(s => s.setAgentConfig)
  const skillConfig = useStore(s => s.skillConfig)
  const profile = useStore(s => s.profile)
  // 📋 任务工作区面板开合状态
  const taskPanelOpen = useTaskWorkspace(s => s.panelOpen)
  const toggleTaskPanel = useTaskWorkspace(s => s.togglePanel)

  const [input, setInput] = useState('')
  const [mode, setMode] = useState<'chat' | 'agent' | 'developer' | 'worker' | 'group'>('group')
  /** Lumina Agent 角色选择 — 初始化时读取上次选择的角色 */
  const [selectedRole, setSelectedRole] = useState<string>(() => agentConfig.lastRole || 'general')
  /** 角色选择器 — 只有无历史记录时才自动弹出 */
  const [rolePickerOpen, setRolePickerOpen] = useState(false)
  /** 🔧 动态快捷指令 — 每次进入空对话时从池中随机挑 3 个 */
  const [dynamicPrompts, setDynamicPrompts] = useState<string[]>([])

  /** 从池中随机选 N 个不重复的提示 */
  const pickRandomPrompts = useCallback((pool: string[], n = 3) => {
    const shuffled = [...pool].sort(() => Math.random() - 0.5)
    return shuffled.slice(0, n)
  }, [])

  // ── ?ref 跟踪最新值，避免 useEffect([]) 闭包过期（必须声明在 mode 之后）──
  const latestRef = useRef({ activeConversationId, isProcessing, mode, selectedRole } as const)
  latestRef.current = { activeConversationId, isProcessing, mode, selectedRole }
  const handleSendRef = useRef<((text: string) => void) | null>(null)
  // handleSendRef.current ?handleSendWithText 声明后赋?
  /** 🔧 v2.8.x: 跟踪上一个 mode，用于切换时清理上下文 */
  const prevModeRef = useRef<'chat' | 'agent' | 'developer' | 'worker' | 'group'>(mode)
  /** 🔧 v2.10.x: 进入群聊前保存当前会话ID，退出时恢复，防止串台 */
  const savedConvRef = useRef<string | null>(null)
  /** 🔧 v2.10.x: 保存/恢复输入框文字，防止串台 */
  const savedInputRef = useRef<string>('')

  // 双层架构 — 本地 state 主渲染，runtime store 做跨面板备份
  const [agentEvents, setAgentEvents] = useState<any[]>(() => {
    // 首次挂载时从 runtime store 恢复（切模式回来不丢事件）
    return useAgentRuntime.getState().agentEvents
  })
  const runtimeLastThinking = useAgentRuntime(s => s.lastThinking)
  const runtimeToolTraces = useAgentRuntime(s => s.toolTraces)
  /** 上轮 Agent 完成的思考过程，渲染为可折叠面板 */
  const [lastAgentEvents, setLastAgentEvents] = useState<any[]>([])
  /** 🆕 v6.1: 当前消息的结构化思考步骤 (ThinkingStep[]) — 借鉴团队群聊 */
  const [currentThinkingSteps, setCurrentThinkingSteps] = useState<ThinkingStep[]>([])
  /** 🆕 v6.1: 当前消息ID，用于关联思考步骤 */
  const [currentReplyId] = useState(() => `reply-${Date.now()}`)
  const [thinkingExpanded, setThinkingExpanded] = useState(false)
  /** 运行中"实时思考"面板：输出期间默认展开，输出完毕/中断后自动收起（可随时点开） */
  const [liveThinkingExpanded, setLiveThinkingExpanded] = useState(true)
  const [showPersonaPicker, setShowPersonaPicker] = useState(false)
  const [showVoicePicker, setShowVoicePicker] = useState(false)
  const [showHistory, setShowHistory] = useState(true)
  const [editingNameId, setEditingNameId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [sttListening, setSttListening] = useState(false)
  const [sttStatus, setSttStatus] = useState<STTStatus | null>(null)
  const [ttsSpeaking, setTtsSpeaking] = useState(false)
  const [ttsJustStopped, setTtsJustStopped] = useState(false) // 刚取消动?
  const [ttsToggling, setTtsToggling] = useState(false) // 静音切换动画
  const [ttsError, setTtsError] = useState<string | null>(null)
  const ttsStoppedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const ttsToggleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const [showUploadTip, setShowUploadTip] = useState(false)
  const [showProactivePanel, setShowProactivePanel] = useState(false)
  const [showMomentsPanel, setShowMomentsPanel] = useState(false)
  // 🍀 v1.0: Lucky 模式
  const luckyMode = useLuckyMode()
  const [uploadTipVisible, setUploadTipVisible] = useState(false)
  const uploadTipTimer = useRef<ReturnType<typeof setTimeout>>(null)
  const [attachments, setAttachments] = useState<Array<{ name: string; size: number; type: string; dataUrl?: string; text?: string }>>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const [dragFiles, setDragFiles] = useState<Array<{name:string,size:number,type:string}>>([])
  // ── v2.4.1: 流式输出 ─────────────────────────────────
  const [streamingText, setStreamingText] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const typingRef = useRef<number>(0)
  const fullResponseRef = useRef('')
  // ──────────────────────────────────────────────────────
  const bottomRef = useRef<HTMLDivElement>(null)
  /** 消息列表滚动容器 — 用来判断用户是否已离开底部（离开就不再强制跟随） */
  const chatScrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const abortRef = useRef(false)
  // ── v2.7: 审批流状态 ────────────────────────────
  const [approvalRequests, setApprovalRequests] = useState<any[]>([])

  // ═══ v2.14: 消息内联按钮 ═══
  const [hoveredMsgId, setHoveredMsgId] = useState<string | null>(null)

  // 📋 任务派发中心（Lumina Agent 同步入口）
  const [showTaskDispatcher, setShowTaskDispatcher] = useState(false)

  // 🧭 决策卡片：agent 调 ask_decision 工具时主进程推过来，用户选完回传
  const [pendingDecisions, setPendingDecisions] = useState<DecisionRequest[]>([])

  // 挂载时补拉一次：避免「卡片已发出但窗口刚重建」时丢卡片；
  // 同时注册监听接住后续新决策
  useEffect(() => {
    const api: any = (window as any).lumina || (window as any).api
    if (!api?.onDecisionRequested) {return}

    let alive = true
    api.decisionPending?.()
      .then((r: any) => { if (alive && r?.ok && Array.isArray(r.pending)) {setPendingDecisions(r.pending)} })
      .catch(() => { /* 拉不到就算了，不影响新决策 */ })

    const offReq = api.onDecisionRequested((req: DecisionRequest) => {
      setPendingDecisions(prev => prev.some(d => d.id === req.id) ? prev : [...prev, req])
    })
    const offRes = api.onDecisionResolved?.((ev: any) => {
      if (!ev?.id) {return}
      setPendingDecisions(prev => prev.filter(d => d.id !== ev.id))
    })

    return () => {
      alive = false
      offReq?.()
      offRes?.()
    }
  }, [])

  // 提交后立刻从本地移除，不必等主进程回推（否则会有“已提交但卡片还在”的闪烁）
  const handleDecisionSubmit = useCallback((id: string, selectedIds: string[], customText?: string) => {
    setPendingDecisions(prev => prev.filter(d => d.id !== id))
    const api: any = (window as any).lumina || (window as any).api
    api?.decisionAnswer?.(id, selectedIds, customText).catch(() => { /* 失败主进程会超时兜底 */ })
  }, [])

  const handleDecisionCancel = useCallback((id: string) => {
    setPendingDecisions(prev => prev.filter(d => d.id !== id))
    const api: any = (window as any).lumina || (window as any).api
    api?.decisionCancel?.(id).catch(() => { /* 同上 */ })
  }, [])

  // 副人格冲突弹幕
  const [personalityConflict, setPersonalityConflict] = useState<any>(null)
  const [deletingTarget, setDeletingTarget] = useState<{ msgId: string; content: string } | null>(null)
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null)

  // ── 工具栏状态（与团队群聊一致） ──
  // 🧠 思考模式 — 默认开启（与团队群聊 / ChatInputBar 保持一致）。
  // 之前这里是 false，而后端 trackReasoning 未显式传时会走默认值，
  // 造成"按钮显示关闭、实际行为又像开着"的两边不一致。
  const [thinkingMode, setThinkingMode] = useState(true)
  // handleSendWithText 没有依赖数组（避免重建回调导致输入框抖动），
  // 所以开关状态必须走 ref 才能在发送时读到最新值。
  const thinkingModeRef = useRef(thinkingMode)
  thinkingModeRef.current = thinkingMode
  // ── 流式状态用 ref 兜住 ──
  // handleSendWithText 里的收尾代码是在 await 之后执行的，那时闭包捕获的
  // agentEvents / currentThinkingSteps 早就过期了（还是发送前的旧快照），
  // 导致"上轮思考过程"面板拿到空数据。统一从 ref 读。
  const thinkingAccumRef = useRef<ThinkingStep[]>([])
  const eventLogRef = useRef<any[]>([])
  /** handleAbort 用：把还没落地的合帧立刻刷出去 */
  const thinkingFlushRef = useRef<(() => void) | null>(null)
  const [realtimeVoiceActive, setRealtimeVoiceActive] = useState(false)
  const [computerUseActive, setComputerUseActive] = useState(false)

  // 🆕 DevTools 紧凑模式（DevTools 打开 OR 简约模式）
  const compactMode = useStore((s) => s.compactMode)
  const [devtoolsOpen, setDevtoolsOpen] = useState(false)
  const compact = compactMode || devtoolsOpen

  // 🆕 简约模式变化时也隐藏/恢复历史列表
  useEffect(() => {
    if (compactMode) {
      narrowRef.current = true
      setShowHistory(false)
    } else if (!devtoolsOpen) {
      narrowRef.current = false
      setShowHistory(true)
    }
  }, [compactMode, devtoolsOpen])

  // 🆕 窄屏自适应：DevTools 打开时自动隐藏历史列表
  const narrowRef = useRef(false)
  useEffect(() => {
    const api = (window as any).luminaAPI
    if (!api?.onDevToolsChanged) {return}
    const unsub = api.onDevToolsChanged((opened: boolean) => {
      setDevtoolsOpen(opened)
      if (opened !== narrowRef.current) {
        narrowRef.current = opened
        setShowHistory(!opened)
      }
    })
    return unsub
  }, [])

  const activeConv = conversations.find(c => c.id === activeConversationId)
  const messages = activeConv?.messages || []
  const persona = getPersona(activePersona, agentConfig.customPersonas)
  const currentVoice = TTS_VOICES.find(v => v.id === ttsConfig.voice) || TTS_VOICES[0]

  // 🔧 角色对话隔离 — agent 模式下只显示当前角色的对话
  const isAgentMode = mode !== 'group'
  const filteredConversations = isAgentMode
    ? conversations.filter(c => c.roleId === selectedRole || (!c.roleId && selectedRole === 'general'))
    : conversations

  // ═════════════════════════════════════════════════════
  // 默认进入团队群聊模式 — 初始化 IPC
  // ═════════════════════════════════════════════════════
  useEffect(() => {
    if (mode === 'group') {
      window.luminaAPI?.agentSetMode('group')
    }
  }, []) // 仅挂载时执行一次

  // ═════════════════════════════════════════════════════
  // .x: 模式切换清理 — 防止上下文污染 + isProcessing 残留
  // ═════════════════════════════════════════════════════
  useEffect(() => {
    const prev = prevModeRef.current
    // 离开群聊模式 → 其他模式：清理状态 + 恢复会话
    if (prev === 'group' && mode !== 'group') {
      setIsProcessing(false)
      useStore.getState().setIsProcessing?.(false)  // 🔧 v2.10.x: 同步清理 store 中的 isProcessing
      setAgentEvents([])
      useAgentRuntime.getState().clearAgentEvents()
      setLastAgentEvents([])
      abortRef.current = true
      setTimeout(() => { abortRef.current = false }, 500)
      // .x: 恢复进入群聊前的会话和输入
      if (savedConvRef.current) {
        switchConversation(savedConvRef.current)
        savedConvRef.current = null
      }
      setInput(savedInputRef.current)
      savedInputRef.current = ''
      console.log('[ChatPanel] 离开群聊模式，恢复会话和输入')
    }
    // 进入群聊模式：保存当前会话和输入 + 清理主面板状态
    if (prev !== 'group' && mode === 'group') {
      savedConvRef.current = activeConversationId  // 🔧 v2.10.x: 保存当前会话
      savedInputRef.current = input  // 🔧 v2.10.x: 保存当前输入
      setIsProcessing(false)
      useStore.getState().setIsProcessing?.(false)  // 🔧 v2.10.x: 同步清理 store 中的 isProcessing
      setAgentEvents([])
      useAgentRuntime.getState().clearAgentEvents()
      setLastAgentEvents([])
      abortRef.current = true
      setTimeout(() => { abortRef.current = false }, 500)
      setInput('')  // 🔧 v2.10.x: 清空主面板输入
      console.log('[ChatPanel] 进入群聊模式，已保存会话和输入')
    }
    // .x: 进入 Lumina Agent 模式 → 仅首次（无 lastRole）自动弹角色选择器
    if (prev === 'group' && mode === 'agent') {
      const curState = useStore.getState()
      const hasChosenRole = !!curState.agentConfig.lastRole
      const roleForMode = curState.agentConfig.lastRole || 'general'
      // 🔧 自动切换到该角色的对话（或创建一个）
      const roleConvs = curState.conversations.filter(c => c.roleId === roleForMode)
      if (roleConvs.length > 0) {
        const lastUsed = roleConvs.sort((a, b) => b.createdAt - a.createdAt)[0]
        if (curState.activeConversationId !== lastUsed.id) {switchConversation(lastUsed.id)}
      } else {
        createConversation(undefined, roleForMode)
      }
      if (!hasChosenRole) {
        setRolePickerOpen(true)
        console.log('[ChatPanel] 首次进入 Lumina Agent，打开角色选择器')
      } else {
        console.log('[ChatPanel] 进入 Lumina Agent，已记住角色:', roleForMode)
      }
      // 🔧 生成该角色的动态快捷指令
      const role = getAgentRole(roleForMode)
      setDynamicPrompts(pickRandomPrompts(role.quickPromptsPool))
    }
    prevModeRef.current = mode
  }, [mode])

  // ── 自动滚底 ──
  // 之前是 `scrollIntoView({behavior:'smooth'})` 直接挂在 [messages, agentEvents, streamingText] 上。
  // 这三个在流式输出时**每个 token 都是新引用**，于是每秒最多发起 60 次平滑滚动：
  //   - 平滑滚动动画会被下一次调用打断重定向 → 滚轮"卡手"，拖上拖下很难受
  //   - 而且完全没有"用户在不在底部"的判断，用户往上翻历史会被立刻拽回底部
  // 现在：① 用户不在底部就不跟随 ② 用 rAF 合帧，一帧最多滚一次 ③ 流式期间用 auto 而非 smooth
  const isUserAtBottomRef = useRef(true)
  const scrollRafRef = useRef(0)
  const handleChatScroll = useCallback(() => {
    const el = chatScrollRef.current
    if (!el) {return}
    isUserAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }, [])
  useEffect(() => {
    if (!isUserAtBottomRef.current) {return}
    if (scrollRafRef.current) {return}
    scrollRafRef.current = window.requestAnimationFrame(() => {
      scrollRafRef.current = 0
      if (!isUserAtBottomRef.current) {return}
      bottomRef.current?.scrollIntoView({ behavior: 'auto' })
    })
  }, [messages, agentEvents, streamingText])
  useEffect(() => () => {
    if (scrollRafRef.current) { window.cancelAnimationFrame(scrollRafRef.current); scrollRafRef.current = 0 }
  }, [])

  // 注入情绪条 CSS 动画
  useEffect(() => { injectEmotionStyles() }, [])

  // ── v2.7: 审批流事件监听 ──────────────────────
  useEffect(() => {
    if (!window.luminaAPI) {return}
    const unsub1 = window.luminaAPI.onApprovalRequested((req: any) => {
      setApprovalRequests(prev => [...prev, req])
    })
    const unsub2 = window.luminaAPI.onApprovalResolved((data: any) => {
      setApprovalRequests(prev => prev.filter(r => r.id !== data.request.id))
    })
    return () => { unsub1?.(); unsub2?.() }
  }, [])

  // 副人格冲突事件监听
  useEffect(() => {
    if (!window.luminaAPI?.onPersonalityConflict) {return}
    const unsub = window.luminaAPI.onPersonalityConflict((conflict: any) => {
      setPersonalityConflict(conflict)
    })
    return () => { unsub?.() }
  }, [])

  // ═══ v2.14: 消息内联按钮操作 ═══
  const handleCopyMsg = useCallback((content: string, msgId: string) => {
    navigator.clipboard.writeText(content).catch(() => {})
    setCopiedMsgId(msgId)
    showToast('✅ 已复制到剪贴板', 'success')
    setTimeout(() => setCopiedMsgId(null), 2000)
  }, [])

  const handleResendMsg = useCallback((content: string) => {
    setInput(content)
    // 聚焦输入框并移到末尾
    setTimeout(() => {
      const el = inputRef.current
      if (el) {
        el.focus()
        el.setSelectionRange(el.value.length, el.value.length)
      }
    }, 50)
  }, [setInput])

  const handleBookmarkMsg = useCallback((msg: { role: string; content: string }, persona: any) => {
    addBookmark({
      content: msg.content,
      from: msg.role === 'user' ? 'user' : activePersona,
      fromName: msg.role === 'user' ? (profile.nickname || '你') : (persona?.name || 'Agent'),
      fromIcon: msg.role === 'user' ? '👤' : (persona?.icon || '🤖'),
      source: `chat:${activeConversationId}`,
    })
    showToast('⭐ 已收藏', 'success')
  }, [activePersona, profile.nickname, activeConversationId])

  const handleDeleteRequest = useCallback((msgId: string, content: string) => {
    setDeletingTarget({ msgId, content })
  }, [])

  const handleDeleteConfirm = useCallback(() => {
    if (!deletingTarget) {return}
    deleteMessageFromStore(activeConversationId, deletingTarget.msgId)
    setDeletingTarget(null)
    showToast('已删除', 'success')
  }, [deletingTarget, activeConversationId, deleteMessageFromStore])

  // ═════════════════════════════════════════════════════
  // STT + proactive init
  // ═════════════════════════════════════════════════════

  useEffect(() => {
    sttService.setCallbacks(
      (text) => {
        setInput(text)
        if (text.trim()) {setTimeout(() => handleSendRef.current?.(text), 300)}
      },
      (status) => {
        setSttStatus(status)
        setSttListening(status.listening)
      }
    )

    proactiveChat.onProactiveTrigger((trigger, message) => {
      const { activeConversationId, isProcessing } = latestRef.current
      if (!activeConversationId || isProcessing) {return}
      // @ts-expect-error
      addAuditLog('system', 'proactive', trigger.type)
      playTTS(message)
    })
    proactiveChat.start()

    return () => {
      sttService.stop()
      proactiveChat.stop()
    }
  }, [])

  // TTS 播放状态监?
  useEffect(() => {
    setTtsSpeaking(ttsEngine.isSpeaking)
    ttsEngine.onStateChange((speaking) => {
      setTtsSpeaking(speaking)
      if (!speaking) {setTtsError(null)} // 播放结束清除错误
    })
    ttsEngine.onError((err) => {
      console.warn('[ChatPanel] TTS 错误:', err)
      setTtsError(err)
      setTtsSpeaking(false)
    })
    // 启动时检?TTS 服务健康状?
    ttsEngine.healthCheck().then((r) => {
      if (!r.ok) {console.warn('[ChatPanel] TTS 健康检?', r.detail)}
    })
  }, [])

  // 组件卸载时清理 streaming，防止切换面板后状态残留
  useEffect(() => {
    return () => {
      if (typingRef.current) {
        clearInterval(typingRef.current)
        typingRef.current = 0
      }
      setIsStreaming(false)
      setStreamingText('')
    }
  }, [])

  const autoResize = useCallback(() => {
    const el = inputRef.current
    if (el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px' }
  }, [])

  // ═════════════════════════════════════════════════════
  // TTS
  // ═════════════════════════════════════════════════════

  const playTTS = async (text: string) => {
    if (useStore.getState().ttsMuted) {return}
    if (useStore.getState().ttsConfig.enabled === false) {return}
    const clean = cleanTtsText(text)
    if (!clean || clean.length < 2) {
      console.warn('[TTS] 清洗后文本太短，跳过:', JSON.stringify(clean))
      return
    }
    console.log(`[TTS] 准备朗读 (${clean.length}字符): ${clean.slice(0, 40)}...`)
    setTtsError(null)
    const result = await ttsEngine.speak({
      text: clean,
      voice: ttsConfig.voice,
      speed: ttsConfig.speed,
      volume: ttsConfig.volume,
    })
    if (result.error) {
      console.warn('[TTS] 播放失败:', result.error)
      setTtsError(result.error)
    }
  }

  // ═════════════════════════════════════════════════════
  // STT 麦克?
  // ═════════════════════════════════════════════════════

  const toggleMic = async () => {
    if (sttListening) {
      sttService.stop()
      setSttListening(false)
    } else {
      await sttService.start()
    }
  }

  // ═════════════════════════════════════════════════════
  // Agent Send
  // ═════════════════════════════════════════════════════

  /** v2.4.1: 打字机流式输出动画 */
  const startTypingAnimation = useCallback((fullText: string, _convId: string, onDone: () => void) => {
    if (typingRef.current) {clearInterval(typingRef.current)}

    setStreamingText('')
    setIsStreaming(true)
    fullResponseRef.current = fullText

    let index = 0
    const charsPerTick = 4
    const intervalMs = 16  // ~250??

    typingRef.current = window.setInterval(() => {
      index += charsPerTick
      if (index >= fullText.length) {
        clearInterval(typingRef.current)
        typingRef.current = 0
        setStreamingText(fullText)
        // 短暂停留后完?
        setTimeout(() => {
          setIsStreaming(false)
          setStreamingText('')
          onDone()
        }, 150)
      } else {
        setStreamingText(fullText.slice(0, index))
      }
    }, intervalMs)
  }, [])

  // ═════════════════════════════════════════════════════
  // 文件上传（含拖拽支持）
  // ═════════════════════════════════════════════════════

  const processMainFiles = async (files: FileList | File[]) => {
    const fileArr = Array.from(files)
    const newAttachments: typeof attachments = []

    for (const file of fileArr) {
      const attachment: typeof attachments[0] = { name: file.name, size: file.size, type: file.type }

      if (file.type.startsWith('image/')) {
        const reader = new FileReader()
        const dataUrl = await new Promise<string>((resolve) => { reader.onload = () => resolve(reader.result as string); reader.readAsDataURL(file) })
        attachment.dataUrl = dataUrl
      }

      const textTypes = ['text/', 'application/json', 'application/javascript', 'application/xml', 'text/xml']
      if (textTypes.some(t => file.type.startsWith(t)) || file.name.match(/\.(txt|json|xml|md|csv|yaml|yml|log|py|js|ts|java|cpp|c|h|html|css|sh|bat|ps1|ini|cfg|toml)$/i)) {
        const text = await new Promise<string>((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result as string); reader.readAsText(file) })
        attachment.text = text.slice(0, 10000)
      }
      newAttachments.push(attachment)
    }
    if (newAttachments.length > 0) {setAttachments(prev => [...prev, ...newAttachments])}
  }

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) {return}
    await processMainFiles(e.target.files)
    if (fileInputRef.current) {fileInputRef.current.value = ''}
  }

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation()
    setDragOver(false)
    if (e.dataTransfer.files.length > 0) {await processMainFiles(e.dataTransfer.files)}
  }

  const removeAttachment = (index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index))
  }

  const clearAttachments = () => setAttachments([])

  const handleSendWithText = useCallback(async (text: string) => {
    if (!text.trim() || isProcessing || !activeConversationId) {return}

    // ── v2.7: 命令拦截 ──────────────────────────
    if (text.startsWith('/')) {
      try {
        const result = await window.luminaAPI.commandExecute(text)
        const displayText = result?.content || result?.error || `命令已执行: ${text}`
        useStore.getState().addMessage(activeConversationId, 'system', displayText)
      } catch (err: any) {
        useStore.getState().addMessage(activeConversationId, 'system', `命令执行失败: ${err.message}`)
      }
      setInput('')
      return
    }

    // ── 📋 被动确认「看看」展开 ──────────────────────────
    const lookUp = text.trim().match(/^(看看|查看|详情|展开)(.*)$/)
    if (lookUp) {
      const tasks = useLoopStore.getState().tasks
      const withOutput = tasks.filter(t => t.outputs.length > 0)
      // 只展开 10 分钟内有产出的 Loop（避免旧产出被误触）
      const recent = withOutput.filter(t => {
        const last = t.outputs[t.outputs.length - 1]
        return last && Date.now() - last.time < 30 * 60 * 1000
      })
      if (recent.length > 0) {
        const target = recent[recent.length - 1]
        const last = target.outputs[target.outputs.length - 1]
        const detail = target.subtasks
          .map(s => `- ${s.title}${s.result ? '：' + s.result.slice(0, 120) : ''}`)
          .join('\n')
        useStore.getState().addMessage(activeConversationId, 'assistant',
          `📋「${target.goal}」第 ${target.runCount} 轮产出：\n\n${last.content}\n\n---\n本轮子任务详情：\n${detail}`)
        setInput('')
        return
      }
      // 没有最近产出 → 继续正常对话（LLM 会回答）
    }

    // ── 🔓 解锁 AudioContext（确保首次 TTS 不被 autoplay 阻止）──
    ttsEngine.unlock()

    setInput(''); abortRef.current = false; setIsProcessing(true)
    proactiveChat.recordActivity()

    // 组装带附件的用户消息
    let userMessage = text
    const currentAttachments = [...attachments]
    if (currentAttachments.length > 0) {
      const fileDescs = currentAttachments.map((a, i) => {
        const sizeStr = a.size > 1024 * 1024 ? `${(a.size / (1024 * 1024)).toFixed(1)}MB` : `${(a.size / 1024).toFixed(1)}KB`
        let desc = `[附件${i + 1}: ${a.name} (${sizeStr})]`
        if (a.text) {desc += `\n内容:\n${a.text}`}
        return desc
      }).join('\n')
      userMessage = `${text}\n\n--- 上传文件 ---\n${fileDescs}`
      clearAttachments()
    }
    // 修复 — 用户消息写入 store（之前从未持久化！）
    const currentConvId = useStore.getState().activeConversationId || activeConversationId
    useStore.getState().addMessage(currentConvId, 'user', userMessage)
    setLastAgentEvents([])
    setThinkingExpanded(false)
    setLiveThinkingExpanded(true)
    setAgentEvents([{ type: 'thinking', text: '思考中...', timestamp: Date.now() }])
    useAgentRuntime.getState().setAgentEvents([{ type: 'thinking', text: '思考中...', timestamp: Date.now() }])

    // ── 🔁 OKR 意图检测：「帮我每天做 XXX」→ 自动创建 Loop 草稿 ──
    const loopIntent = detectLoopIntent(text)
    if (loopIntent) {
      const loop = await useLoopStore.getState().createLoop(loopIntent.goal, {
        suggestedTriggers: [loopIntent.trigger],
      }).catch(() => null)
      if (loop) {
        const plan = loop.subtasks
          .map((s, i) => `${i + 1}. ${s.title}：${s.description.slice(0, 60)}`)
          .join('\n')
        const freqLabel = loopIntent.trigger.type === 'interval'
          ? (() => {
              const h = Math.round((loopIntent.trigger.config?.intervalMs || 86400000) / 3600000)
              return h === 24 ? '每天' : h === 168 ? '每周' : `每 ${h} 小时`
            })()
          : '定期'
        useStore.getState().addMessage(activeConversationId, 'system',
          `🔁 已为你创建自动任务（待确认）：\n\n` +
          `📋 目标：${loopIntent.goal}\n⏰ 触发：${freqLabel}\n\n` +
          `我会帮你做这些事：\n${plan}\n\n` +
          `去「任务看板 → Loop → 确认启动」后即可开始运转。`)
      }
    }

    const systemPrompt = persona ? getPersonaPrompt(persona) : undefined
    const rolePrompt = mode === 'agent' ? getAgentRole(selectedRole).systemPrompt : undefined
    const effectiveSystemPrompt = rolePrompt || systemPrompt
    // 清理 — group 模式永远不走此路径（由 GroupChatView 独立处理）
    //   isGroupChat 不设置，默认 false，buildSystemPrompt 使用干净提示词
    const config = {
      mode: 'agent' as const,
      model: llmConfig.model,
      baseUrl: llmConfig.baseUrl,
      apiKey: llmConfig.apiKey,
      temperature: llmConfig.temperature,
      maxTokens: llmConfig.maxTokens,
      // 之前是 10 —— 对"读文件 → 改 → 跑命令 → 验证结果"这种闭环几乎不够，
      // Agent 经常在验证之前就被迫收尾，于是给出的结论没有验证支撑。
      // 配合 agentRunner 里的重复工具封禁门，调高是安全的。
      maxToolCalls: 20,
      systemPrompt: effectiveSystemPrompt,
      personaId: activePersona,
      disabledTools: getDisabledToolNames(skillConfig),
      contextWindow: llmConfig.contextWindow || 0,
      // 🧠 思考开关接到后端：关掉就不再产生 thinking_stream
      trackReasoning: thinkingModeRef.current,
    }

    // 本轮的累积器挂在 ref 上：await 之后的收尾代码要读到的是"最终快照"，
    // 而不是点击发送那一刻的旧闭包值（否则"上轮思考过程"面板拿到的是空数组）
    const eventLog = (eventLogRef.current = [] as any[])
    let agentText = ''
    /** 🆕 v6.1: 当前消息的思维步骤追踪器 */
    const stepIds = new Set<string>()
    const stepStartTimes = new Map<string, number>()
    const thinkingAccum = (thinkingAccumRef.current = [] as ThinkingStep[])

    // 🧹 流式合帧 ——
    // 推理 token 来得比帧还快，逐个 setState 会把渲染队列堆满、把主线程占死。
    // 用户看到的就是两件事：思考文字不像在"打印"，以及滚轮卡手。
    // 这里把同一帧内的多次更新合并成一次渲染，累积逻辑完全不变。
    let thinkingRaf = 0
    const flushThinking = () => {
      thinkingRaf = 0
      setCurrentThinkingSteps([...thinkingAccum])
      // 双写 — 本地 state(渲染) + runtime store(跨面板备份)
      setAgentEvents([...eventLog])
      useAgentRuntime.getState().setAgentEvents([...eventLog])
    }
    /** 收尾用：把还没落地的合帧立刻刷出去，避免结束时读到旧快照 */
    const flushThinkingNow = () => {
      if (thinkingRaf) { window.cancelAnimationFrame(thinkingRaf); thinkingRaf = 0 }
      flushThinking()
    }
    const scheduleThinking = () => {
      if (thinkingRaf) {return}
      thinkingRaf = window.requestAnimationFrame(flushThinking)
    }
    // 暴露给 handleAbort，让"中断"也能拿到最后一帧的思考步骤
    thinkingFlushRef.current = flushThinkingNow

    /** 🆕 v6.1: upsert 思维步骤 — 同 key 更新而非新增 (借鉴团队群聊) */
    const upsertThinkingStep = (s: ThinkingStep, stableKey?: string) => {
      const key = stableKey || `${s.type}:${s.tool || ''}:${s.label.slice(0, 30)}`
      const existingIdx = thinkingAccum.findIndex(
        step => (stableKey && (step as any)._stableKey === stableKey) ||
                (`${step.type}:${step.tool || ''}:${step.label.slice(0, 30)}` === key)
      )
      if (existingIdx >= 0) {
        thinkingAccum[existingIdx] = { ...thinkingAccum[existingIdx], ...s, label: thinkingAccum[existingIdx].label }
      } else {
        (s as any)._stableKey = stableKey || ''
        thinkingAccum.push(s)
      }
      // 合帧：一帧最多渲染一次，而不是每个 token 渲染一次
      scheduleThinking()
    }

    const unsub = window.luminaAPI.onAgentEvent((ev) => {
      if (abortRef.current) {return}

      // 推理流 — 不再吞掉！推入 ThinkingStep 显示推理内容
      if (ev.type === 'thinking_stream') {
        const streamStepId = `re-${currentReplyId}`
        const stableKey = `reasoning:${currentReplyId}`
        if (ev.isLast) {
          const existing = thinkingAccum.find(s => (s as any)._stableKey === stableKey)
          upsertThinkingStep({
            id: streamStepId,
            type: 'thinking',
            label: '💭 推理完成',
            result: existing?.result,
            timestamp: Date.now(),
          }, stableKey)
          useAgentRuntime.getState().setLastThinking('')
        } else if (ev.text && !ev.isFirst) {
          const existing = thinkingAccum.find(s => (s as any)._stableKey === stableKey)
          const fullText = existing?.result ? existing.result + ev.text : ev.text
          upsertThinkingStep({
            id: streamStepId,
            type: 'thinking',
            label: '💭 推理中...',
            result: fullText.slice(-5000),
            timestamp: Date.now(),
          }, stableKey)
        } else if (ev.isFirst) {
          // isFirst 只创建占位，不累积文本
          if (!thinkingAccum.find(s => (s as any)._stableKey === stableKey)) {
            upsertThinkingStep({
              id: streamStepId,
              type: 'thinking',
              label: '💭 推理中...',
              timestamp: Date.now(),
            }, stableKey)
          }
        }
        return
      }

      // thinking 事件 — 推入 ThinkingStep
      if (ev.type === 'thinking') {
        const txt = (ev.text || '').trim()
        const isNoise = /⚠️\s*检测到潜在注入/i.test(txt)
        const loopMatch = txt.match(/^思考中\.\.\.\s*\(第\s*(\d+)\s*轮\)$/i)
        const displayLabel = loopMatch ? `🔁 第${loopMatch[1]}轮思考` : txt.slice(0, 120)
        if (txt && txt.length > 2 && !isNoise) {
          upsertThinkingStep({
            id: `think-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            type: 'thinking',
            label: displayLabel,
            result: txt,
            timestamp: Date.now(),
          })
          useAgentRuntime.getState().setLastThinking(txt)
        }
        // 也保留 eventLog 以兼容旧的上轮面板
        const last = eventLog[eventLog.length - 1]
        if (!last || last.type !== 'thinking' || last.text !== txt) {
          eventLog.push(ev)
        }
        return
      }

      // 其他事件正常推入（token_update / text 等同样高频，交给合帧统一渲染）
      eventLog.push(ev)
      scheduleThinking()

      // 工具事件 → ThinkingStep
      // 注：工具调用的「持久记录」由 services/taskWorkspaceBridge.ts 统一写入
      // taskWorkspaceStore —— 那里是一处订阅覆盖所有面板（单聊 + 团队群聊），
      // 这里只维护本轮瞬时状态（resetAgentRuntime 会清）。
      if (ev.type === 'tool_start' && ev.tool) {
        useAgentRuntime.getState().addToolTrace(ev.tool, 'running')
        upsertThinkingStep({
          id: `tool-${Date.now()}-${ev.tool}`,
          type: 'tool_start',
          label: `🔨 ${ev.tool}`,
          tool: ev.tool,
          args: ev.args ? JSON.stringify(ev.args).slice(0, 120) : '',
          timestamp: Date.now(),
        })
      }
      if (ev.type === 'tool_end' && ev.tool) {
        const durationMs = ev.result?._durationMs
        useAgentRuntime.getState().addToolTrace(ev.tool, ev.result?.ok ? 'done' : 'error')
        upsertThinkingStep({
          id: `toolend-${Date.now()}-${ev.tool}`,
          type: ev.result?.ok ? 'tool_end' : 'tool_error',
          label: ev.result?.ok ? `✅ ${ev.tool}` : `❌ ${ev.tool}`,
          tool: ev.tool,
          result: ev.result?.content?.slice(0, 500) || ev.result?.error || '(完成)',
          durationMs,
          timestamp: Date.now(),
        })
      }
      if (ev.type === 'tool_error' && ev.tool) {
        useAgentRuntime.getState().addToolTrace(ev.tool, 'error')
        upsertThinkingStep({
          id: `toolerr-${Date.now()}-${ev.tool}`,
          type: 'tool_error',
          label: `❌ ${ev.tool}`,
          tool: ev.tool,
          result: ev.error?.slice(0, 200),
          timestamp: Date.now(),
        })
      }

      // ── v2.4.1: 实时 token 用量 ──
      if (ev.type === 'token_update' && (ev as any).delta !== undefined && (ev as any).delta > 0) {
        addTokenUsage(llmConfig.model, (ev as any).delta, 'assistant')
      }
      // 🆕 上下文用量指示器：实时更新 prompt tokens / context window
      if (ev.type === 'token_update' && (ev as any).promptTokens > 0) {
        const cw = (ev as any).contextWindow || llmConfig.contextWindow || 0
        useAgentRuntime.getState().setContextUsage((ev as any).promptTokens, cw)
      }
    })

    try {
      // 传递当前对话的完整历史?Agent，确保重?切换对话后能恢复上下?
      const latestConvId = useStore.getState().activeConversationId || activeConversationId
      const latestConv = useStore.getState().conversations.find(c => c.id === latestConvId)
      const history = latestConv?.messages
        .filter(m => m.role !== 'system')
        .map(m => ({ role: m.role, content: m.content })) || []
      const result = await window.luminaAPI.agentChat({
        text,
        config,
        sessionId: latestConvId,
        compactedContext: latestConv?.compactedContext,
        conversationHistory: history,
      })
      agentText = result.content || ''
      // 🔧 P1: 保存压缩上下文
      if (result.compactedContext && latestConv) {
        useStore.getState().updateConversation(latestConvId, { compactedContext: result.compactedContext })
      }
      // 🆕 对话结束后更新上下文用量（最终值）
      if (result.contextWindow) {
        const lastEvt = eventLog.reverse().find(e => e.type === 'token_update')
        const pt = (lastEvt as any)?.promptTokens || 0
        if (pt > 0) {useAgentRuntime.getState().setContextUsage(pt, result.contextWindow)}
      }
      unsub()
      // 保存结构化思考步骤供面板展示
      flushThinkingNow()
      setLastAgentEvents([...eventLogRef.current, ...thinkingAccumRef.current.map(s => ({ ...s, type: 'thinking', text: `${s.label}${s.result ? '\n' + s.result : ''}` }))])
      setAgentEvents([])
      setCurrentThinkingSteps([])
      useAgentRuntime.getState().resetAgentRuntime()

      // ═══ Lucky 模式检查 ═══
      if (agentText && luckyMode.isActive && luckyMode.preset !== 'off') {
        const { checkAfterReply } = await import('../services/luckyModeService')
        const checkResult = checkAfterReply(agentText)

        // 死循环检测
        if (checkResult.isDoomLoop && checkResult.doomLoopMessage) {
          const finalConvId = useStore.getState().activeConversationId || activeConversationId
          useStore.getState().addMessage(finalConvId, 'system', checkResult.doomLoopMessage)
        }

        // 达到最大迭代次数
        if (checkResult.shouldPause && checkResult.pauseReason) {
          const finalConvId = useStore.getState().activeConversationId || activeConversationId
          useStore.getState().addMessage(finalConvId, 'system', checkResult.pauseReason)
          luckyMode.pause(checkResult.pauseReason)
        }
      }

      if (agentText && !abortRef.current) {
        // ── 🔧 v2.17: 修复闭包过期 — 使用最新 convId，切换对话时不丢消息 ──
        const finalConvId = useStore.getState().activeConversationId || activeConversationId
        useStore.getState().addMessage(finalConvId, 'assistant', agentText)
        // ═══ 浏览器链接智能联动：开关开启时，新回复含 URL 则自动在内置浏览器打开 ═══
        // 仅对「刚落地的新回复」触发；切换/渲染历史会话不会走到这里。
        void maybeAutoOpenBrowserOnReply(agentText)
        // ── v2.4.1: 流式打字动画 ──────────────────────
        startTypingAnimation(agentText, finalConvId, () => {
          // @ts-expect-error
          addAuditLog('llm', 'agent_chat', `[${mode}] ${text.slice(0, 50)}`)
          playTTS(agentText)
        })
      } else if (result.error) {
        // v6.0: 后端返回了错误
        const finalConvId = useStore.getState().activeConversationId || activeConversationId
        if (result.content) {
          // 附带了用户友好的说明内容
          useStore.getState().addMessage(finalConvId, 'assistant', result.content)
          startTypingAnimation(result.content, finalConvId, () => {
            // @ts-expect-error
            addAuditLog('llm', 'agent_chat', `[${mode}] ${text.slice(0, 50)}`)
          })
        } else {
          // 没有 content 时也要显示错误消息（之前静默失败）
          useStore.getState().addMessage(finalConvId, 'assistant',
            `哎呀，出了点小问题… ${result.error ? String(result.error).slice(0, 300) : '未知错误'}`)
        }
      }
    } catch (err: any) {
      unsub(); flushThinkingNow(); setLastAgentEvents([...eventLogRef.current, ...thinkingAccumRef.current.map(s => ({ ...s, type: 'thinking', text: `${s.label}${s.result ? '\n' + s.result : ''}` }))])
      setAgentEvents([])
      setCurrentThinkingSteps([])
      useAgentRuntime.getState().resetAgentRuntime()
      // v6.0: 网络错误/异常也显示友好提示，不要静默消失
      const finalConvId = useStore.getState().activeConversationId || activeConversationId
      const errMsg = err?.message || String(err)
      if (errMsg.includes('ETIMEDOUT') || errMsg.includes('ECONNREFUSED')) {
        useStore.getState().addMessage(finalConvId, 'assistant',
          `唔…我好像连不上 LLM 服务器呢 🥺\n\n可能是 LM Studio 没启动，或者 Endpoint 地址不对。\n\n> 检查一下设置 → Agent 独立 LLM 配置 → Lumina 的 Endpoint 是否正确。`)
      } else {
        useStore.getState().addMessage(finalConvId, 'assistant',
          `哎呀，出了点小问题… ${errMsg.slice(0, 200)}`)
      }
    }
    setIsProcessing(false)
  }, [isProcessing, activeConversationId, mode, selectedRole, llmConfig, persona, agentConfig, activePersona, ttsMuted, ttsConfig, setIsProcessing, addAuditLog])

  // ref 赋值在 useCallback 声明之后，避免 TDZ
  handleSendRef.current = handleSendWithText

  const handleSend = () => handleSendWithText(input)

  /** 📋 任务派发：在 Lumina Agent 里把任务路由给指定执行者
   * （群聊视图由 GroupChatView 自己处理路由，这里单人视图直接走当前对话） */
  const handleTaskDispatch = useCallback(async (taskType: TaskType, agentId: string, prompt: string) => {
    const card = TASK_TYPE_CARDS.find(c => c.id === taskType)
    const agent = TEAM_MEMBERS.find(m => m.id === agentId)
    if (!card) {return}

    const task = prompt || card.desc
    const assignee = agent ? `${agent.icon} ${agent.name}` : getAgentRole(selectedRole).name
    const text = agent
      ? `📋 任务派发：${card.icon} ${card.name}\n\n📌 任务：${task}\n🎯 执行者：${assignee}\n\n📨 请${agent!.name}开始处理此任务。`
      : `📋 任务派发：${card.icon} ${card.name}\n\n📌 任务：${task}\n\n📨 请开始处理此任务。`

    await handleSendWithText(text)
  }, [handleSendWithText, selectedRole])
  const handleAbort = () => {
    abortRef.current = true
    window.luminaAPI.agentAbort()
    // 保留思考步骤供查看 —— 读 ref 而不是闭包旧值，并把没落地的合帧刷出来
    thinkingFlushRef.current?.()
    setLastAgentEvents([...eventLogRef.current, ...thinkingAccumRef.current.map(s => ({ ...s, type: 'thinking', text: `${s.label}${s.result ? '\n' + s.result : ''}` }))])
    setAgentEvents([])
    setCurrentThinkingSteps([])
    // 中断后转入"上轮思考过程"折叠面板，同样以收起状态呈现
    setLiveThinkingExpanded(false)
    setThinkingExpanded(false)
    useAgentRuntime.getState().resetAgentRuntime()
    setIsProcessing(false)
    // v2.4.1: 停止打字动画
    if (typingRef.current) { clearInterval(typingRef.current); typingRef.current = 0 }
    setIsStreaming(false)
    setStreamingText('')
  }
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
  }

  // ═════════════════════════════════════════════════════
  // Render
  // ═════════════════════════════════════════════════════

  const currentPersona = getPersona(activePersona, agentConfig.customPersonas)

  // ── 共用样式常量 ──────────────────────────────────────

  const subtleBtn: React.CSSProperties = {
    padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border-light)',
    background: 'var(--surface-100)', cursor: 'pointer', fontSize: 13,
    display: 'flex', alignItems: 'center', gap: 4,
    transition: 'background 0.15s',
  }

  // v2.14: 消息内联操作按钮样式
  const inlineBtnStyle: React.CSSProperties = {
    width: 22, height: 22, borderRadius: 4, border: 'none',
    background: 'transparent', cursor: 'pointer', fontSize: 11,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 0, color: 'var(--text-secondary)',
  }

  return (
    <div style={{ display: 'flex', height: '100%', background: 'var(--surface-0)' }}>
      {/* 🆕 v3.0: 副人格冲突弹幕 */}
      <PersonalityConflictAlert
        conflict={personalityConflict}
        onDismiss={() => setPersonalityConflict(null)}
      />
      {/* ═══ 历史对话侧边栏 ═══ */}
      <div style={{
        width: showHistory ? 220 : 0,
        minWidth: showHistory ? 220 : 0,
        borderRight: showHistory ? '1px solid var(--border-light)' : 'none',
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
        transition: 'width 0.25s ease, min-width 0.25s ease',
        flexShrink: 0,
      }}>
        {(showHistory) && (
          <>
            {/* 👥 团队群聊 — 紧凑卡片风格 */}
            <div
              onClick={() => { setMode('group'); window.luminaAPI?.agentSetMode('group') }}
              style={{
                margin: '4px 6px', padding: '10px 12px',
                cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10,
                borderRadius: 10, border: mode === 'group' ? '1.5px solid var(--accent-500)' : '1.5px solid transparent',
                background: mode === 'group'
                  ? 'var(--accent-50)'
                  : 'transparent',
                transition: 'all 0.2s',
                flexShrink: 0,
              }}
              onMouseEnter={e => {
                if (mode !== 'group') {
                  (e.currentTarget as HTMLElement).style.background = 'var(--surface-100)'
                  ;(e.currentTarget as HTMLElement).style.borderRadius = '10px'
                }
              }}
              onMouseLeave={e => {
                if (mode !== 'group') {
                  (e.currentTarget as HTMLElement).style.background = 'transparent'
                }
              }}
            >
              <span style={{
                fontSize: 26,
                filter: mode === 'group' ? 'none' : 'grayscale(0.3)',
                transition: 'filter 0.2s',
              }}>👥</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: 15, fontWeight: mode === 'group' ? 800 : 600,
                  color: mode === 'group' ? 'var(--accent-600)' : 'var(--text-primary)',
                  lineHeight: 1.3,
                }}>
                  团队群聊
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  Lumina🐱 · 热茶 · Yak📊
                </div>
              </div>
              {mode === 'group' && (
                <span style={{
                  width: 8, height: 8, borderRadius: 4, background: 'var(--accent-500)',
                  flexShrink: 0, boxShadow: '0 0 6px rgba(59,130,246,0.5)',
                }} />
              )}
            </div>

            {/* 🆕 Lumina Agent — 团队群聊下方的单一入口 */}
            <div style={{ padding: '4px 6px', flexShrink: 0 }}>
              <button
                className={'mode-sidebar-item' + (mode !== 'group' ? ' active' : '')}
                onClick={() => {
                  setMode('agent')
                  if (!agentConfig.lastRole) {setRolePickerOpen(true)}
                  window.luminaAPI?.agentSetMode('agent')
                }}
              >
                <span className="mode-dot" style={{
                  background: mode !== 'group' ? getAgentRole(selectedRole).color : '#d1d5db',
                }} />
                <span>{getAgentRole(selectedRole).icon}</span>
                <span style={{ flex: 1 }}>
                  {mode !== 'group' ? getAgentRole(selectedRole).name : 'Lumina Agent'}
                </span>
              </button>
            </div>

            {/* 🆕 群聊历史会话 ??group 模式显示 */}
            {mode === 'group' && <GroupChatHistorySidebar />}

            {showHistory && mode !== 'group' && (
              <>
                {/* 侧边栏标?*/}
                <div style={{
                  padding: '10px 12px', borderBottom: '1px solid var(--border-light)',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  flexShrink: 0,
                }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    📝 历史对话
                  </span>
                  <button onClick={() => createConversation(undefined, selectedRole)} title="新建对话"
                    style={{
                      width: 24, height: 24, borderRadius: 5, border: '1px solid var(--border-light)',
                      background: 'var(--surface-100)', cursor: 'pointer', display: 'flex',
                      alignItems: 'center', justifyContent: 'center', fontSize: 14, color: 'var(--text-secondary)',
                    }}>
                    <IconPlus size={14} />
                  </button>
                </div>

                {/* 对话列表 */}
                <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
                  {filteredConversations.length === 0 && (
                    <div style={{ padding: 16, textAlign: 'center', color: 'var(--text-secondary)', fontSize: 12 }}>
                      暂无对话记录
                    </div>
                  )}
                  {[...filteredConversations]
                    .sort((a, b) => {
                      if (a.pinned && !b.pinned) {return -1}
                      if (!a.pinned && b.pinned) {return 1}
                      return b.createdAt - a.createdAt
                    })
                    .map(conv => {
                  const isActive = conv.id === activeConversationId
                  const preview = getConvPreview(conv.messages)
                  const isEditing = editingNameId === conv.id

                  const startRename = (e: React.MouseEvent) => {
                    e.stopPropagation()
                    setEditName(conv.name || preview)
                    setEditingNameId(conv.id)
                  }
                  const commitRename = () => {
                    if (editName.trim()) {renameConversation(conv.id, editName.trim())}
                    setEditingNameId(null)
                  }

                  return (
                    <div key={conv.id}
                      onClick={() => { if (!isEditing) {switchConversation(conv.id)} }}
                      style={{
                        padding: '8px 10px', margin: '1px 6px',
                        borderRadius: 6, cursor: 'pointer',
                        background: isActive ? '#eff6ff' : 'transparent',
                        border: isActive ? '1px solid #bfdbfe' : '1px solid transparent',
                        transition: 'all 0.12s',
                        position: 'relative',
                      }}
                      onMouseEnter={e => {
                        (e.currentTarget as HTMLElement).style.background = isActive ? '#eff6ff' : 'var(--surface-100)'
                      }}
                      onMouseLeave={e => {
                        (e.currentTarget as HTMLElement).style.background = isActive ? '#eff6ff' : 'transparent'
                      }}
                    >
                      {conv.pinned && (
                        <span style={{ position: 'absolute', top: 1, right: 2, fontSize: 9 }} title="已置顶">📌</span>
                      )}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          {isEditing ? (
                            <input
                              value={editName}
                              onChange={e => setEditName(e.target.value)}
                              onBlur={commitRename}
                              onKeyDown={e => {
                                if (e.key === 'Enter') {commitRename()}
                                if (e.key === 'Escape') {setEditingNameId(null)}
                              }}
                              autoFocus
                              onClick={e => e.stopPropagation()}
                              style={{
                                width: '100%', padding: '2px 4px', borderRadius: 4,
                                border: '1px solid #3b82f6', outline: 'none',
                                fontSize: 12, fontWeight: 600,
                              }}
                            />
                          ) : (
                            <div style={{
                              fontSize: 13, fontWeight: isActive ? 600 : 500,
                              color: isActive ? '#1d4ed8' : 'var(--text-primary)',
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            }}>
                              {conv.name || preview}
                            </div>
                          )}
                          <div style={{
                            fontSize: 10, color: 'var(--text-secondary)', marginTop: 2,
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          }}>
                            {formatDateLabel(conv.createdAt)} · {conv.messages.length} 条消息
                          </div>
                        </div>
                        {!isEditing && (
                          <div style={{ display: 'flex', gap: 1, flexShrink: 0, marginLeft: 2 }}
                            onClick={e => e.stopPropagation()}>
                            <button
                              onClick={startRename}
                              title="重命名"
                              style={{
                                width: 20, height: 20, borderRadius: 4, border: 'none',
                                background: 'transparent', color: 'var(--text-tertiary)',
                                cursor: 'pointer', fontSize: 10, display: 'flex',
                                alignItems: 'center', justifyContent: 'center',
                              }}>
                              ✏️
                            </button>
                            <button
                              onClick={() => togglePinConversation(conv.id)}
                              title={conv.pinned ? '取消置顶' : '置顶'}
                              style={{
                                width: 20, height: 20, borderRadius: 4, border: 'none',
                                background: conv.pinned ? '#fef3c7' : 'transparent',
                                color: conv.pinned ? '#d97706' : '#d1d5db',
                                cursor: 'pointer', fontSize: 10, display: 'flex',
                                alignItems: 'center', justifyContent: 'center',
                              }}>
                              📌
                            </button>
                            <button
                              onClick={e => {
                                e.stopPropagation()
                                if (conversations.length <= 1) {return}
                                deleteConversation(conv.id)
                              }}
                              title="删除对话"
                              style={{
                                width: 22, height: 22, borderRadius: 4, border: 'none',
                                background: 'transparent', cursor: conversations.length <= 1 ? 'default' : 'pointer',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                fontSize: 14, fontWeight: 700, color: 'var(--text-secondary)',
                                opacity: conversations.length <= 1 ? 0.3 : 1,
                              }}
                              onMouseEnter={e => {
                                if (conversations.length > 1)
                                  {(e.currentTarget as HTMLElement).style.color = '#ef4444'}
                              }}
                              onMouseLeave={e => {
                                (e.currentTarget as HTMLElement).style.color = 'var(--text-secondary)'
                              }}
                            >
                              ×
                        </button>
                      </div>
                    )}
                    </div>
                  </div>
                  )
                })}
            </div>
          </>
        )}
          </>
        )}
      </div>

      {/* ═══主聊天区 ═══*/}
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, height: '100%', position: 'relative' }}>
        {/* ⚡ 主动引擎滑出面板 */}
        <div style={{
          position: 'absolute', top: 0, left: 0, bottom: 0,
          width: showProactivePanel ? 300 : 0, overflow: showProactivePanel ? 'auto' : 'hidden',
          zIndex: 100, transition: 'width 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
          background: 'var(--surface-50)', borderRight: showProactivePanel ? '1px solid var(--border-light)' : 'none',
          boxShadow: showProactivePanel ? '4px 0 20px rgba(0,0,0,0.08)' : 'none',
        }}>
          {showProactivePanel && <ProactiveSidebar visible={showProactivePanel} onClose={() => setShowProactivePanel(false)} />}
        </div>
        {/* 🌸 Agent 朋友圈滑出面板 */}
        <div style={{
          position: 'absolute', top: 0, right: 0, bottom: 0,
          width: showMomentsPanel ? 340 : 0, overflow: showMomentsPanel ? 'auto' : 'hidden',
          zIndex: 101, transition: 'width 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
          background: 'var(--surface-0)', borderLeft: showMomentsPanel ? '1px solid #e5e7eb' : 'none',
          boxShadow: showMomentsPanel ? '-4px 0 20px rgba(0,0,0,0.08)' : 'none',
        }}>
          {showMomentsPanel && <MomentsPanel visible={showMomentsPanel} onClose={() => setShowMomentsPanel(false)} />}
        </div>
        {/* ── Header ── */}
        <div style={{
          padding: compact ? '6px 10px' : '10px 14px', borderBottom: '1px solid var(--border-light)',
          display: 'flex', alignItems: 'center', gap: compact ? 4 : 8, flexShrink: 0, flexWrap: 'wrap',
        }}>
          {/* 历史切换按钮 */}
          <button onClick={() => setShowHistory(!showHistory)}
            title={showHistory ? '收起历史' : '展开历史'}
            style={{
              ...subtleBtn, padding: '4px 6px', minWidth: 28, justifyContent: 'center',
              color: showHistory ? '#3b82f6' : 'var(--text-secondary)',
            }}>
            {showHistory ? '◀' : '▶'}
          </button>

          {/* ⚡ 主动引擎按钮 — compact 隐藏 */}
          {!compact && <button onClick={() => { setShowProactivePanel(!showProactivePanel); setShowHistory(true) }}
            title="24/7 主动对话引擎" style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '5px 14px', border: 'none', cursor: 'pointer', borderRadius: 20,
              fontSize: 12, fontWeight: 700,
              background: showProactivePanel ? 'linear-gradient(135deg, #7c3aed, #6366f1)' : 'linear-gradient(135deg, #8b5cf6, #7c3aed)',
              color: '#fff',
              boxShadow: showProactivePanel ? '0 0 14px rgba(124,58,237,0.5)' : '0 2px 8px rgba(124,58,237,0.3)',
              transition: 'all 0.25s',
            }}><span style={{ fontSize: 15 }}>⚡</span><span>主动引擎</span></button>}

          {/* 🌸 朋友圈按钮 — compact 隐藏 */}
          {!compact && <button onClick={() => setShowMomentsPanel(!showMomentsPanel)}
            title="Agent 朋友圈" style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '5px 14px', cursor: 'pointer', borderRadius: 20,
              fontSize: 12, fontWeight: 700,
              background: showMomentsPanel ? 'linear-gradient(135deg, #ec4899, #f43f5e)' : 'linear-gradient(135deg, #fdf2f8, #fce7f3)',
              color: showMomentsPanel ? 'var(--surface-0)' : '#be185d',
              border: showMomentsPanel ? 'none' : '1px solid #f9a8d4',
              boxShadow: showMomentsPanel ? '0 0 14px rgba(236,72,153,0.5)' : '0 1px 3px rgba(236,72,153,0.15)',
              transition: 'all 0.25s',
            }}><span style={{ fontSize: 15 }}>🌸</span><span>朋友圈</span></button>}

          <span
            onClick={() => mode !== 'group' && setRolePickerOpen(true)}
            style={{
              fontWeight: 600, fontSize: 15,
              color: mode === 'group' ? '#111827' : getAgentRole(selectedRole).color,
              display: 'flex', alignItems: 'center', gap: 4,
              cursor: mode !== 'group' ? 'pointer' : 'default',
              padding: '2px 6px', borderRadius: 8,
              transition: 'background 0.15s',
            }}
            onMouseEnter={e => { if (mode !== 'group') {e.currentTarget.style.background = `${getAgentRole(selectedRole).color}10`} }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
          >
            {mode === 'group' ? '👥 团队群聊' : (
              <>
                {getAgentRole(selectedRole).icon}
                <span>{getAgentRole(selectedRole).name}</span>
                <span style={{
                  width: 6, height: 6, borderRadius: 3,
                  background: getAgentRole(selectedRole).color,
                  marginLeft: 2, boxShadow: `0 0 6px ${getAgentRole(selectedRole).color}60`,
                }} />
              </>
            )}
          </span>

          {/* 📋 任务工作区切换按钮 — 唯一开合入口，激活态高亮 */}
          <button onClick={toggleTaskPanel}
            title={taskPanelOpen ? '收起任务工作区' : '展开任务工作区'}
            className={`tw-toolbar-btn ${taskPanelOpen ? 'active' : ''}`}
            style={{
              ...subtleBtn, padding: '4px 8px', gap: 4, fontSize: 11,
              color: taskPanelOpen ? 'var(--accent-600)' : 'var(--text-secondary)',
            }}><span style={{ fontSize: 13 }}>📋</span><span>任务工作区</span></button>

          {/* 🔄 切换角色按钮 — 仅非群聊模式 */}
          {mode !== 'group' && (
            <button onClick={() => setRolePickerOpen(true)}
              title="切换角色" style={{
                ...subtleBtn, padding: '3px 8px', gap: 4,
                fontSize: 11, fontWeight: 600,
                color: getAgentRole(selectedRole).color,
                background: `${getAgentRole(selectedRole).color}10`,
                border: `1px solid ${getAgentRole(selectedRole).color}30`,
                borderRadius: 14,
                transition: 'all 0.2s',
              }}>
              <span style={{ fontSize: 12 }}>🔄</span>
              <span>切换角色</span>
            </button>
          )}

          <div style={{ flex: 1, minWidth: 8 }} />

          {/* ── Agent音色选择 — v2.8.1: 群聊或 compact 下隐藏 */}
          {mode !== 'group' && !compact && (
          <div style={{ position: 'relative' }}>
            <button onClick={() => { setShowVoicePicker(!showVoicePicker) }}
              style={{
                ...subtleBtn, gap: 3, fontSize: 11, padding: '4px 8px',
              }}
              title={`当前: ${currentVoice.label} — ${currentVoice.desc}`}>
              <span style={{ fontSize: 13 }}>🎙️</span>
              <span>Agent音色</span>
              <span style={{ fontSize: 9, color: 'var(--text-secondary)' }}></span>
            </button>
            {showVoicePicker && (
              <div style={{
                position: 'absolute', top: 36, right: 0, background: 'var(--surface-0)',
                border: '1px solid var(--border-light)', borderRadius: 10, padding: 6,
                zIndex: 100, boxShadow: '0 8px 24px rgba(0,0,0,.12)',
                minWidth: 220, maxHeight: 300, overflowY: 'auto',
                animation: 'voiceDropIn 0.25s cubic-bezier(0.34,1.56,0.64,1) both',
                transformOrigin: 'top right',
              }}>
                <style>{`
                  @keyframes voiceDropIn { from { opacity: 0; transform: scale(0.9) translateY(-6px); } to { opacity: 1; transform: scale(1) translateY(0); } }
                  @keyframes voiceItemIn { from { opacity: 0; transform: translateX(-6px); } to { opacity: 1; transform: translateX(0); } }
                `}</style>
                <div style={{ fontSize: 10, color: 'var(--text-secondary)', padding: '4px 8px 6px', borderBottom: '1px solid var(--border-light)', marginBottom: 4, fontWeight: 600, letterSpacing: 0.5 }}>
                  🎙️ Agent 音色
                </div>
                {TTS_VOICES.map((v, i) => {
                  const isActive = v.id === ttsConfig.voice
                  return (
                    <div key={v.id}
                      onClick={() => {
                        setTTSConfig({ voice: v.id })
                        setShowVoicePicker(false)
                      }}
                      style={{
                        padding: '7px 10px', cursor: 'pointer', borderRadius: 6, fontSize: 12,
                        background: isActive ? '#eff6ff' : 'transparent',
                        display: 'flex', alignItems: 'center', gap: 8,
                        border: isActive ? '1px solid #bfdbfe' : '1px solid transparent',
                        animation: `voiceItemIn 0.2s ease ${i * 30}ms both`,
                        transition: 'background 0.15s, border-color 0.15s',
                      }}
                      onMouseEnter={e => { if (!isActive) {e.currentTarget.style.background = 'var(--surface-50)'} }}
                      onMouseLeave={e => { if (!isActive) {e.currentTarget.style.background = 'transparent'} }}
                    >
                      <span style={{ fontSize: 16 }}>{v.icon}</span>
                      <div>
                        <div style={{ fontWeight: isActive ? 600 : 500, color: isActive ? '#1d4ed8' : 'var(--text-primary)' }}>
                          {v.label}
                          {isActive && <span style={{ marginLeft: 6, fontSize: 10, color: '#3b82f6' }}>✓</span>}
                        </div>
                        <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{v.desc}</div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
          )}

          {/* ── TTS 可视化播放器 — v2.8.1: 群聊或 compact 下隐藏 */}
          {mode !== 'group' && !compact && (
          <div style={{ position: 'relative' }}>
            <button
              onClick={() => {
                if (ttsSpeaking) {
                  // 正在朗读 ?停止 + 触发取消动画
                  ttsEngine.stop()
                  setTtsJustStopped(true)
                  if (ttsStoppedTimer.current) {clearTimeout(ttsStoppedTimer.current)}
                  ttsStoppedTimer.current = setTimeout(() => setTtsJustStopped(false), 600)
                } else {
                  // 未朗??切换静音 + 触发翻转动画
                  ttsToggle()
                  setTtsToggling(true)
                  if (ttsToggleTimer.current) {clearTimeout(ttsToggleTimer.current)}
                  ttsToggleTimer.current = setTimeout(() => setTtsToggling(false), 500)
                }
              }}
              title={
                ttsError
                  ? `⚠️ ${ttsError}`
                  : ttsSpeaking
                  ? '点击停止朗读'
                  : ttsJustStopped
                  ? '已停止'
                  : ttsToggling
                  ? ttsMuted ? '已静音' : '已取消静音'
                  : ttsMuted
                  ? '已静音，点击取消静音'
                  : '点击静音 TTS'
              }
              style={{
                ...subtleBtn,
                padding: ttsSpeaking || ttsJustStopped ? '4px 10px' : '4px 7px',
                fontSize: 15,
                minWidth: ttsSpeaking || ttsJustStopped ? 48 : 28,
                justifyContent: 'center',
                gap: 3,
                background: ttsError
                  ? '#fffbeb'
                  : ttsJustStopped
                  ? '#fef2f2'
                  : ttsSpeaking
                  ? '#eff6ff'
                  : ttsToggling
                  ? (ttsMuted ? '#fef2f2' : '#eff6ff')
                  : ttsMuted
                  ? '#fef2f2'
                  : 'var(--surface-100)',
                border: `1.5px solid ${
                  ttsError
                    ? '#fcd34d'
                    : ttsJustStopped
                    ? '#fca5a5'
                    : ttsSpeaking
                    ? '#93c5fd'
                    : ttsToggling
                    ? (ttsMuted ? '#fca5a5' : '#93c5fd')
                    : ttsMuted
                    ? '#fca5a5'
                    : 'var(--border-light)'
                }`,
                transition: 'all 0.2s ease',
                transform: ttsToggling ? 'scale(1.1)' : 'scale(1)',
                boxShadow: ttsToggling
                  ? (ttsMuted ? '0 0 0 3px rgba(239,68,68,0.2)' : '0 0 0 3px rgba(59,130,246,0.2)')
                  : 'none',
              }}>
              {/* ── 播放中：音频可视化条 ── */}
              {ttsSpeaking && !ttsJustStopped && (
                <span style={{
                  display: 'flex', alignItems: 'end', gap: 2, height: 16,
                }}>
                  {[
                    { anim: 'ttsBarJump', dur: '0.6s', delay: '0s', h: 0.7 },
                    { anim: 'ttsBarJump2', dur: '0.55s', delay: '0.08s', h: 0.5 },
                    { anim: 'ttsBarJump3', dur: '0.65s', delay: '0.15s', h: 0.9 },
                    { anim: 'ttsBarJump4', dur: '0.5s', delay: '0.22s', h: 0.6 },
                    { anim: 'ttsBarJump5', dur: '0.7s', delay: '0.05s', h: 0.8 },
                  ].map((bar, i) => (
                    <span key={i} style={{
                      display: 'inline-block',
                      width: 3,
                      height: 16,
                      borderRadius: 2,
                      background: `linear-gradient(180deg, #3b82f6, #93c5fd)`,
                      transformOrigin: 'bottom',
                      animation: `${bar.anim} ${bar.dur} ease-in-out infinite`,
                      animationDelay: bar.delay,
                    }} />
                  ))}
                </span>
              )}

              {/* ── 刚取消：条收拢动?── */}
              {ttsJustStopped && (
                <span style={{ display: 'flex', alignItems: 'end', gap: 2, height: 16 }}>
                  {[0, 1, 2, 3, 4].map((i) => (
                    <span key={i} style={{
                      display: 'inline-block',
                      width: 3,
                      height: 16,
                      borderRadius: 2,
                      background: `linear-gradient(180deg, #ef4444, #fca5a5)`,
                      transformOrigin: 'bottom',
                      animation: 'ttsBarCollapse 0.5s ease-in forwards',
                      animationDelay: `${i * 0.04}s`,
                    }} />
                  ))}
                </span>
              )}

              {/* ── 错误状?── */}
              {ttsError && !ttsSpeaking && !ttsJustStopped && (
                <span style={{ fontSize: 13 }}>⚠️</span>
              )}

              {/* ── 默认状?── */}
              {!ttsSpeaking && !ttsJustStopped && !ttsError && (
                <span style={{
                  animation: ttsToggling
                    ? 'ttsToggleSpin 0.5s cubic-bezier(0.34, 1.56, 0.64, 1)'
                    : ttsMuted
                    ? 'none'
                    : 'ttsBreath 2s ease-in-out infinite',
                  display: 'inline-block',
                }}>
                  {ttsMuted ? '🔇' : '🔊'}
                </span>
              )}
            </button>

            {/* ── 错误气泡提示 ── */}
            {ttsError && !ttsSpeaking && (
              <div style={{
                position: 'absolute', top: -40, left: '50%',
                transform: 'translateX(-50%)',
                background: '#1f2937', color: '#fff', borderRadius: 8,
                padding: '6px 10px', fontSize: 11, lineHeight: 1.5,
                whiteSpace: 'nowrap', zIndex: 101,
                boxShadow: '0 2px 12px rgba(0,0,0,.18)',
                animation: 'fadeInUp 0.3s ease',
                maxWidth: 260,
                overflow: 'hidden', textOverflow: 'ellipsis',
              }}>
                ⚠️ {ttsError}
              </div>
            )}
          </div>
          )}

          {/* New Chat — 群聊模式下隐藏，群聊用侧边栏的 + 按钮 */}
          {mode !== 'group' && (
          <button onClick={() => createConversation(undefined, selectedRole)} title="新建对话"
            style={{
              ...subtleBtn, padding: '4px 6px', minWidth: 28, justifyContent: 'center',
            }}>
            <IconPlus size={16} />
          </button>
          )}
        </div>

        {mode === 'group' ? <GroupChatView /> : (rolePickerOpen ? (
        <div style={{ flex: 1, display: 'flex', justifyContent: 'center', overflowY: 'auto', padding: '16px 20px', alignItems: 'flex-start' }}>
          <style>{`
            @keyframes roleCardIn { from { opacity: 0; transform: translateY(16px) scale(0.96); } to { opacity: 1; transform: translateY(0) scale(1); } }
            @keyframes roleGlow { 0%,100% { box-shadow: 0 0 0 0 transparent; } 50% { box-shadow: 0 0 20px 4px var(--glow-color); } }
            .role-card { animation: roleCardIn 0.4s ease both; transition: all 0.25s cubic-bezier(0.4,0,0.2,1); }
            .role-card:hover { transform: translateY(-3px) scale(1.015); }
            .role-card.selected { animation: roleGlow 2s ease-in-out infinite; }
            .skill-tag { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 500; margin: 1px; }
            .role-picker-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; width: 100%; }
          `}</style>
          <div style={{ width: '100%' }}>
            {/* 标题区 */}
            <div style={{ textAlign: 'center', marginBottom: 16, paddingTop: 10 }}>
              <div style={{ fontSize: 44, marginBottom: 4, animation: 'roleCardIn 0.6s ease both', filter: 'drop-shadow(0 3px 8px rgba(0,0,0,0.1))' }}>🐱</div>
              <div style={{ fontSize: 22, fontWeight: 800, background: 'linear-gradient(135deg, #6366f1, #ec4899, #f59e0b)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', marginBottom: 4 }}>
                你好，我是 Lumina！
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>选一个专攻角色，我来帮你把事情做好 ✨</div>
            </div>

            {/* 角色网格 — 默认3列，超宽屏4列 */}
            <div className="role-picker-grid">
              {AGENT_ROLES.map((role, idx) => {
                const active = selectedRole === role.id
                return (
                  <div key={role.id}
                    className={`role-card${active ? ' selected' : ''}`}
                    style={{
                      animationDelay: `${idx * 50}ms`,
                      ['--glow-color' as any]: `${role.color}33`,
                      border: `2px solid ${active ? role.color : 'var(--border-light)'}`,
                      borderRadius: 12, padding: '12px 14px', cursor: 'pointer',
                      background: active ? role.bgColor : 'var(--surface-0)',
                      boxShadow: active ? `0 4px 16px ${role.color}25` : '0 1px 6px rgba(0,0,0,0.04)',
                      position: 'relative', overflow: 'hidden',
                    }}
                    onClick={() => {
                      setSelectedRole(role.id)
                      setRolePickerOpen(false)
                      setAgentConfig({ lastRole: role.id })
                      const curState = useStore.getState()
                      const roleConvs = curState.conversations.filter(c => c.roleId === role.id)
                      if (roleConvs.length > 0) {
                        const lastUsed = roleConvs.sort((a, b) => b.createdAt - a.createdAt)[0]
                        switchConversation(lastUsed.id)
                      } else {
                        createConversation(undefined, role.id)
                      }
                    }}
                  >
                    {active && (
                      <div style={{ position: 'absolute', top: 7, right: 9, width: 19, height: 19, borderRadius: 10, background: role.color, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700, animation: 'roleCardIn 0.3s ease' }}>✓</div>
                    )}
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9, marginBottom: 7 }}>
                      <span style={{ fontSize: 28, flexShrink: 0, filter: active ? 'none' : 'grayscale(0.15)', transition: 'filter 0.2s' }}>{role.icon}</span>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 700, fontSize: 13, color: active ? role.color : '#111827' }}>{role.name}</div>
                        <div style={{ marginTop: 2, fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.4 }}>{role.desc}</div>
                      </div>
                    </div>
                    {/* 能力标签 */}
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 7 }}>
                      {role.skillTags.map(tag => (
                        <span key={tag} className="skill-tag" style={{
                          background: active ? `${role.color}15` : 'var(--surface-100)',
                          color: active ? role.color : 'var(--text-secondary)',
                          border: `1px solid ${active ? `${role.color}30` : 'var(--border-light)'}`,
                        }}>{tag}</span>
                      ))}
                    </div>
                    {/* 欢迎语预览 */}
                    <div style={{
                      fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.5,
                      padding: '5px 8px', borderRadius: 7,
                      background: active ? `${role.color}08` : 'var(--surface-50)',
                      borderLeft: `2px solid ${active ? role.color : 'var(--border-light)'}`,
                      display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                    }}>
                      "{role.welcomeMsg}"
                    </div>
                  </div>
                )
              })}
            </div>

            {/* 底部提示 */}
            <div style={{ marginTop: 14, textAlign: 'center', fontSize: 12, color: 'var(--text-tertiary)', paddingBottom: 8 }}>
              <span>选中角色即可开始对话</span>
              <span style={{ opacity: 0.4 }}> · </span>
              <span>随时可在顶部栏「切换角色」重新选择</span>
            </div>
          </div>
        </div>
        ) : (<> 

        {/* ── Messages ── */}
        <div ref={chatScrollRef} onScroll={handleChatScroll} style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>
          {messages.length === 0 && !isProcessing && (
            <div style={{ textAlign: 'center', color: 'var(--text-secondary)', marginTop: 60, fontSize: 14 }}>
              <style>{`
                @keyframes welcomePop { 0% { opacity: 0; transform: scale(0.8) translateY(10px); } 100% { opacity: 1; transform: scale(1) translateY(0); } }
                @keyframes chipSlide { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
              `}</style>
              {/* 角色图标 + 欢迎语 */}
              <div style={{ animation: 'welcomePop 0.5s ease both' }}>
                <div style={{
                  fontSize: 52, marginBottom: 10,
                  filter: 'drop-shadow(0 4px 12px rgba(0,0,0,0.08))',
                }}>{getAgentRole(selectedRole).icon}</div>
                <div style={{
                  fontSize: 17, fontWeight: 700,
                  color: getAgentRole(selectedRole).color,
                  marginBottom: 6,
                }}>
                  {getAgentRole(selectedRole).name} 已就绪
                </div>
                <div style={{
                  marginTop: 4, fontSize: 13, color: 'var(--text-secondary)',
                  maxWidth: 360, margin: '0 auto', lineHeight: 1.6,
                }}>
                  {getAgentRole(selectedRole).welcomeMsg}
                </div>
              </div>

              {/* 快捷指令气泡 — 动态推荐 + 点击直接发送 */}
              <div style={{
                display: 'flex', flexWrap: 'wrap', justifyContent: 'center',
                gap: 8, marginTop: 20, maxWidth: 500, margin: '20px auto 0',
              }}>
                {(dynamicPrompts.length > 0 ? dynamicPrompts : getAgentRole(selectedRole).quickPrompts).map((prompt, i) => (
                  <button key={`${selectedRole}-${i}`}
                    onClick={() => {
                      // 🔧 点击直接发送，不填输入框
                      handleSendWithText(prompt)
                    }}
                    style={{
                      animation: `chipSlide 0.4s ease both`,
                      animationDelay: `${300 + i * 80}ms`,
                      padding: '8px 16px', borderRadius: 20, cursor: 'pointer',
                      border: `1px solid ${getAgentRole(selectedRole).color}30`,
                      background: 'var(--surface-50)',
                      color: getAgentRole(selectedRole).color,
                      fontSize: 12, fontWeight: 500,
                      transition: 'all 0.2s',
                    }}
                    onMouseEnter={e => {
                      (e.currentTarget as HTMLElement).style.background = 'var(--surface-100)'
                      ;(e.currentTarget as HTMLElement).style.transform = 'translateY(-1px)'
                    }}
                    onMouseLeave={e => {
                      (e.currentTarget as HTMLElement).style.background = 'var(--surface-50)'
                      ;(e.currentTarget as HTMLElement).style.transform = 'translateY(0)'
                    }}
                  >
                    ✨ {prompt}
                  </button>
                ))}
              </div>

              <div style={{ marginTop: 16, fontSize: 11, color: 'var(--text-tertiary)' }}>
                点击快捷指令即可发送 · 🎤 语音也可以哦
              </div>
            </div>
          )}

          {messages.map((msg, i) => {
            const isUser = msg.role === 'user'
            return (
            <div key={msg.id} className="msg-anim-in"
              onMouseEnter={() => msg.role !== 'system' && setHoveredMsgId(msg.id)}
              onMouseLeave={() => setHoveredMsgId(null)}
              style={{
              animationDelay: `${Math.min(i * 25, 300)}ms`,
              marginBottom: 12, display: 'flex',
              flexDirection: isUser ? 'row-reverse' : 'row',
              alignItems: 'flex-start', gap: 8,
            }}>
              <div style={{
                width: 28, height: 28, borderRadius: 14,
                background: isUser ? '#3b82f6' : '#f472b6',
                color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 12, flexShrink: 0, overflow: 'hidden',
                fontFamily: '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif',
              }}>
                {isUser
                  ? (profile.avatar
                      ? <img src={profile.avatar} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      : '👤')
                  : currentPersona?.icon || '🐱'}
              </div>
              <div style={{
                maxWidth: '75%', background: isUser
                  ? (profile.bubbleColorUser || 'var(--accent-50)')
                  : (profile.bubbleColorAgent || 'var(--surface-100)'),
                borderRadius: 12, padding: '8px 12px', border: '1px solid var(--border-light)',
                userSelect: 'text',
                cursor: 'text',
                color: 'var(--text-primary)',
              }}>
                {isUser && profile.nickname && (
                  <div style={{ fontSize: 10, fontWeight: 600, color: '#3b82f6', marginBottom: 2 }}>
                    {profile.nickname}
                  </div>
                )}
                <div style={{
                  fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word', userSelect: 'text',
                }}><LinkifiedText text={msg.content.replace(/^\n+/, '')} /></div>
                {/* ═══ v2.14: 内联操作按钮 ═══ */}
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 2, marginTop: 6,
                  opacity: hoveredMsgId === msg.id ? 1 : 0.35,
                  transition: 'opacity 0.15s',
                  justifyContent: isUser ? 'flex-end' : 'flex-start',
                }}>
                  {msg.role !== 'system' && (<>
                    <button onClick={() => handleCopyMsg(msg.content, msg.id)}
                      title="复制"
                      style={inlineBtnStyle}>
                      {copiedMsgId === msg.id ? '✅' : '📋'}
                    </button>
                    {msg.role === 'assistant' && (
                      <button onClick={() => handleResendMsg(msg.content)}
                        title="重新输入到输入框" style={inlineBtnStyle}>
                        ↩️
                      </button>
                    )}
                    <button onClick={() => handleBookmarkMsg(msg, currentPersona)}
                      title="收藏" style={inlineBtnStyle}>
                      ⭐
                    </button>
                    <button onClick={() => handleDeleteRequest(msg.id, msg.content)}
                      title="删除" style={inlineBtnStyle}>
                      🗑️
                    </button>
                  </>)}
                  <span style={{ fontSize: 10, color: 'var(--text-secondary)', marginLeft: 4 }}>
                    {formatDateLabel(msg.timestamp)}
                  </span>
                </div>
              </div>
            </div>
          )})}

          {/* ── v2.7: 审批卡片 ────────────────────── */}
          {approvalRequests.map((req) => (
            <div key={req.id} style={{
              marginBottom: 12, padding: 12, borderRadius: 10,
              border: '2px solid #fbbf24', background: 'var(--yellow-100)',
              animation: 'fadeInUp 0.3s ease',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 18 }}>🔐</span>
                <span style={{ fontWeight: 600, fontSize: 14, color: '#92400e' }}>需要你的批准</span>
                {req.timeout > 0 && (
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: '#b45309' }}>
                    ⏱ {Math.ceil(req.timeout / 1000)}s 后自动拒绝
                  </span>
                )}
              </div>
              <div style={{
                background: 'var(--surface-0)', borderRadius: 8, padding: 10,
                border: '1px solid #fde68a', marginBottom: 8,
              }}>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
                  🖥️ {req.toolName}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>
                  {req.description}
                </div>
                <div style={{ fontSize: 11, color: '#b45309' }}>
                  风险等级: {req.severity === 'CRITICAL' ? '🔴 严重' : req.severity === 'HIGH' ? '🟠 高' : req.severity === 'MEDIUM' ? '🟡 中' : '🟢 低'}
                  {req.threats?.length > 0 && (
                    <span style={{ marginLeft: 8 }}>
                      {req.threats.map((t: string) => ` · ${t}`).join('')}
                    </span>
                  )}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={async () => {
                    try {
                      await window.luminaAPI.commandExecute(`/approve ${req.id}`)
                    } catch {}
                    setApprovalRequests(prev => prev.filter(r => r.id !== req.id))
                  }}
                  style={{
                    flex: 1, padding: '8px 16px', borderRadius: 8,
                    background: '#10b981', color: '#fff', border: 'none',
                    fontSize: 13, fontWeight: 600, cursor: 'pointer',
                  }}>
                  ✅ 批准
                </button>
                <button
                  onClick={async () => {
                    try {
                      await window.luminaAPI.commandExecute(`/deny ${req.id}`)
                    } catch {}
                    setApprovalRequests(prev => prev.filter(r => r.id !== req.id))
                  }}
                  style={{
                    flex: 1, padding: '8px 16px', borderRadius: 8,
                    background: '#ef4444', color: '#fff', border: 'none',
                    fontSize: 13, fontWeight: 600, cursor: 'pointer',
                  }}>
                  ❌ 拒绝
                </button>
              </div>
            </div>
          ))}

          {/* 🆕 v6.1: 上轮 Agent 思考过程 — 升级版 (借鉴团队群聊) */}
          {lastAgentEvents.length > 0 && agentEvents.length === 0 && (
            <div style={{ marginBottom: 8 }}>
              <button
                className="thinking-toggle"
                onClick={() => setThinkingExpanded(!thinkingExpanded)}
                aria-expanded={thinkingExpanded}
                style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  padding: '5px 10px', borderRadius: 8,
                  border: '1px solid var(--border-light)', background: 'var(--surface-50)',
                  fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer',
                  width: 'fit-content',
                }}
              >
                <span className="thinking-chevron" style={{ fontSize: 8 }}>
                  ▶
                </span>
                <span>🧠 思考过程</span>
                <span style={{
                  background: 'var(--border-light)', borderRadius: 8,
                  padding: '0px 5px', fontSize: 9, color: 'var(--text-secondary)',
                }}>{lastAgentEvents.length}步</span>
                {lastAgentEvents.some((e: any) => e.type === 'tool_start') && (
                  <span style={{ fontSize: 9 }}>🔧</span>
                )}
              </button>
              {/* grid-template-rows: 0fr → 1fr 做展开/收起动画，无需 JS 量高度 */}
              <div className={'thinking-collapse' + (thinkingExpanded ? ' open' : '')}>
                <div className="thinking-clip">
                  <div style={{
                    marginTop: 4, padding: '4px 6px',
                    background: 'var(--surface-50)', borderRadius: 8,
                    border: '1px solid var(--border-light)',
                    maxHeight: 320, overflowY: 'auto', overflowX: 'hidden',
                  }}>
                    <ThinkingStepList
                      steps={lastAgentEvents.map((ev: any, i: number) => normalizeThinkingStep(ev, i))}
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 🆕 v6.1: 实时思考过程 — 运行中展示。
              输出期间默认展开，输出完毕自动收起（面板卸载、转入下方折叠面板）。
              内部复用 ThinkingStepList，避免和上轮折叠面板、群聊三套渲染各走各的。 */}
          {isProcessing && currentThinkingSteps.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <button
                className="thinking-toggle"
                onClick={() => setLiveThinkingExpanded(v => !v)}
                aria-expanded={liveThinkingExpanded}
                aria-controls="live-thinking"
                style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  padding: '5px 10px', borderRadius: 8,
                  border: '1px solid var(--border-light)', background: 'var(--surface-50)',
                  fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer',
                  width: 'fit-content',
                }}
              >
                <span className="thinking-chevron" style={{ fontSize: 8 }}>
                  ▶
                </span>
                <span className="thinking-live-dot" />
                <span>🧠 思考中</span>
                <span style={{
                  background: 'var(--border-light)', borderRadius: 8,
                  padding: '0px 5px', fontSize: 9, color: 'var(--text-secondary)',
                }}>{currentThinkingSteps.length}步</span>
              </button>
              {/* grid-template-rows: 0fr → 1fr 做展开/收起动画，无需 JS 量高度 */}
              <div id="live-thinking" className={'thinking-collapse' + (liveThinkingExpanded ? ' open' : '')}>
                <div className="thinking-clip">
                  <div style={{
                    marginTop: 4, padding: '4px 6px',
                    background: 'var(--surface-50)', borderRadius: 8,
                    border: '1px solid var(--border-light)',
                    maxHeight: 320, overflowY: 'auto', overflowX: 'hidden',
                  }}>
                    <ThinkingStepList steps={currentThinkingSteps} />
                  </div>
                </div>
              </div>
            </div>
          )}

          {isProcessing && currentThinkingSteps.length === 0 && (
            <div style={{
              display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 4px',
              marginBottom: 8,
            }}>
              <div style={{
                width: 28, height: 28, borderRadius: 14,
                background: '#f472b6', color: '#fff',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 14, flexShrink: 0,
              }}>
                {currentPersona?.icon || '🐱'}
              </div>
              <div>
                <div style={{
                  background: 'var(--surface-100)', borderRadius: 12, padding: '8px 14px',
                  border: '1px solid var(--border-light)',
                }}>
                  <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                    {currentPersona?.name || 'Lumina'} 正在思考
                  </span>
                  <span style={{ marginLeft: 4, display: 'inline-flex', verticalAlign: 'middle', padding: 0, gap: 3 }}>
                    <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#d1d5db', animation: 'toolPulse 1.2s ease-in-out infinite', animationDelay: '0s', display: 'inline-block' }} />
                    <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#d1d5db', animation: 'toolPulse 1.2s ease-in-out infinite', animationDelay: '0.2s', display: 'inline-block' }} />
                    <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#d1d5db', animation: 'toolPulse 1.2s ease-in-out infinite', animationDelay: '0.4s', display: 'inline-block' }} />
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* ── v2.4.1: 流式打字动画气泡 ── */}
          {isStreaming && streamingText && (
            <div style={{
              marginBottom: 12, display: 'flex',
              flexDirection: 'row', alignItems: 'flex-start', gap: 8,
              animation: 'fadeInUp 0.2s ease',
            }}>
              <div style={{
                width: 28, height: 28, borderRadius: 14,
                background: '#f472b6', color: '#fff',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 12, flexShrink: 0,
              }}>
                {currentPersona?.icon || '🐱'}
              </div>
              <div style={{
                maxWidth: '75%', background: 'var(--surface-100)',
                borderRadius: 12, padding: '8px 12px',
                border: '1px solid var(--border-light)',
              }}>
                <div style={{
                  fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word', color: '#172b4d',
                }}>
                  {streamingText.replace(/^\n+/, '')}
                  <span style={{
                    display: 'inline-block', width: 2, height: 14,
                    background: '#3b82f6', marginLeft: 1, verticalAlign: 'text-bottom',
                    animation: 'cursorBlink 0.8s infinite',
                  }} />
                </div>
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        {/* ── Input ── */}
        {/* 拖拽文件预览 */}
        {dragFiles.length > 0 && (
          <div style={{
            margin: '0 16px', padding: '8px 12px', borderRadius: 8,
            background: 'var(--accent-50)', border: '1px solid #93c5fd',
            display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center',
            flexShrink: 0,
          }}>
            <span style={{ fontSize: 12, color: 'var(--accent-600)', fontWeight: 600 }}>📥 将上传：</span>
            {dragFiles.map((f, i) => (
              <span key={i} style={{
                fontSize: 11, color: '#1e40af', background: '#dbeafe',
                padding: '2px 8px', borderRadius: 4,
                display: 'flex', alignItems: 'center', gap: 4,
              }}>
                {f.type.startsWith('image/') ? '🖼️' : f.name.match(/\.(pdf|doc|docx)$/i) ? '📄' : '📁'}
                {f.name.length > 20 ? f.name.slice(0, 17) + '...' : f.name}
                <span style={{ color: 'var(--text-secondary)', fontSize: 10 }}>
                  {(f.size/1024/1024).toFixed(1)}MB
                </span>
              </span>
            ))}
          </div>
        )}
        <div
          onDragOver={e => { e.preventDefault(); e.stopPropagation(); setDragOver(true); setDragFiles(Array.from(e.dataTransfer.files).map(f => ({name:f.name,size:f.size,type:f.type}))) }}
          onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) { setDragOver(false); setDragFiles([]) } }}
          onDrop={e => { setDragFiles([]); handleDrop(e) }}
          style={{
          padding: '8px 16px 12px', borderTop: '1px solid #e5e7eb', flexShrink: 0,
          transition: 'background 0.15s, border-color 0.15s',
          background: dragOver ? '#eff6ff' : 'transparent',
          borderColor: dragOver ? '#3b82f6' : 'var(--border-light)',
          outline: dragOver ? '2px dashed #93c5fd' : 'none',
          outlineOffset: -4,
        }}>
          {isProcessing && (
            <div style={{ marginBottom: 6, display: 'flex', justifyContent: 'flex-end' }}>
              <button onClick={handleAbort} style={{
                padding: '2px 10px', borderRadius: 4, border: '1px solid #fca5a5',
                background: 'var(--red-100)', color: '#dc2626', cursor: 'pointer', fontSize: 12,
              }}>停止</button>
            </div>
          )}

          {sttListening && (
            <div style={{
              marginBottom: 4, fontSize: 11, color: '#ef4444',
              display: 'flex', alignItems: 'center', gap: 4,
            }}>
              <span style={{
                width: 6, height: 6, borderRadius: 3, background: '#ef4444',
                animation: 'pulse 0.6s infinite',
              }} />
              🎤 正在听你说话...
            </div>
          )}
          {sttStatus?.error && (
            <div style={{ marginBottom: 4, fontSize: 11, color: '#f59e0b' }}>
              ⚠️ {sttStatus.error}
            </div>
          )}

          {/* 附件预览 */}
          {attachments.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
              {attachments.map((a, i) => (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  background: 'var(--accent-50)', border: '1px solid var(--accent-100)',
                  borderRadius: 6, padding: '3px 8px', fontSize: 11,
                  color: 'var(--accent-600)', maxWidth: 200,
                }}>
                  {a.dataUrl ? (
                    <img src={a.dataUrl} alt="" style={{ width: 18, height: 18, borderRadius: 3, objectFit: 'cover' }} />
                  ) : (
                    <span style={{ fontSize: 13 }}>{a.name.match(/\.(pdf|doc|docx|xls|xlsx)$/i) ? '📄' : '📁'}</span>
                  )}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {a.name.length > 16 ? a.name.slice(0, 14) + '...' : a.name}
                  </span>
                  <button onClick={() => removeAttachment(i)} style={{
                    border: 'none', background: 'transparent', color: '#93c5fd',
                    cursor: 'pointer', fontSize: 13, padding: 0, lineHeight: 1,
                  }}>×</button>
                </div>
              ))}
            </div>
          )}

          {/* ── 隐藏文件上传 input ── */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.json,.xml,.md,.csv,.yaml,.yml,.log,.py,.js,.ts,.java,.cpp,.c,.h,.html,.css,.sh,.bat,.ps1,.ini,.cfg,.toml,.zip"
            style={{ display: 'none' }}
            onChange={handleFileSelect}
          />

          {/* ── textarea（与团队群聊一致） ── */}
          <div style={{ position: 'relative' }}>
            <textarea ref={inputRef} value={input}
              onChange={e => { setInput(e.target.value); autoResize() }}
              onKeyDown={handleKeyDown}
              placeholder={
                isProcessing ? 'Lumina 正在回复，你可以先打草稿等待' :
                `${getAgentRole(selectedRole).icon} ${getAgentRole(selectedRole).name} · ${getAgentRole(selectedRole).desc}`
              }
              rows={1}
              style={{
                width: '100%', padding: '10px 14px', borderRadius: 10,
                border: `1.5px solid ${getAgentRole(selectedRole).color}40`,
                fontSize: 13, outline: 'none', fontFamily: 'inherit',
                resize: 'vertical', minHeight: 52, paddingRight: 74,
                boxSizing: 'border-box', lineHeight: 1.5,
                transition: 'border-color 0.2s',
              }}
              onFocus={e => { (e.target as HTMLElement).style.borderColor = getAgentRole(selectedRole).color }}
              onBlur={e => { (e.target as HTMLElement).style.borderColor = `${getAgentRole(selectedRole).color}40` }}
            />
            {/* 发送按钮（输入框内右下角，与团队群聊一致） */}
            <div style={{
              position: 'absolute', right: 10, bottom: 8,
              display: 'flex', alignItems: 'center',
            }}>
              {isProcessing ? (
                <button onClick={handleAbort}
                  title="中断回复"
                  style={{
                    padding: '4px 12px', borderRadius: 6,
                    border: '1.5px solid #fca5a5', background: 'var(--red-100)', color: '#ef4444',
                    cursor: 'pointer', fontSize: 12, display: 'flex',
                    alignItems: 'center', gap: 3, fontFamily: 'inherit', fontWeight: 600,
                  }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" style={{ animation: 'sendSpin 0.9s linear infinite' }}>
                    <circle cx="12" cy="12" r="10" fill="none" stroke="#ef4444" strokeWidth="2.5" strokeDasharray="50 50" strokeLinecap="round" />
                  </svg>
                  中断
                </button>
              ) : (
                <button onClick={handleSend} disabled={!input.trim()}
                  title="发送消息"
                  style={{
                    border: 'none', borderRadius: 6, padding: '4px 12px',
                    background: input.trim() ? '#3b82f6' : 'var(--border-light)',
                    color: input.trim() ? '#fff' : 'var(--text-secondary)',
                    fontSize: 12, cursor: input.trim() ? 'pointer' : 'default', fontWeight: 600,
                    fontFamily: '"微软雅黑","Microsoft YaHei",sans-serif',
                    display: 'flex', alignItems: 'center', gap: 4,
                  }}>
                  <IconSend size={14} />
                  发送
                </button>
              )}
            </div>
          </div>

          {/* ── 功能工具栏（小长方形按钮 + 微软雅黑标注） ── */}
          <div style={{
            display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center',
            fontFamily: '"微软雅黑","Microsoft YaHei",sans-serif',
          }}>
            {/* ── 🧠 模型选择 ── */}
            <ModelSelector />
            {/* ── 🍀 Lucky 模式（第二位） ── */}
            <LuckyModeSelector
              currentPreset={luckyMode.preset}
              onPresetChange={luckyMode.setPreset}
              runtimeInfo={{
                preset: luckyMode.preset,
                isActive: luckyMode.isActive,
                currentIteration: luckyMode.runtime.currentIteration,
                maxIteration: luckyMode.runtime.maxIteration,
                isPaused: luckyMode.isPaused,
                pauseReason: luckyMode.runtime.pauseReason,
              }}
              onOpenSettings={() => luckyMode.setShowSettings(true)}
            />
            {/* 🍀 Lucky 模式暂停继续按钮 */}
            {luckyMode.isPaused && (
              <button
                onClick={luckyMode.resume}
                style={{
                  padding: '4px 10px', borderRadius: 6,
                  border: '1.5px solid #fca5a5', background: '#fef2f2',
                  cursor: 'pointer', fontSize: 12, display: 'flex',
                  alignItems: 'center', gap: 3, fontFamily: 'inherit',
                  color: '#dc2626',
                }}>
                ▶️ 继续
              </button>
            )}
            {/* ── 🧠 思考 ── */}
            <button
              onClick={() => setThinkingMode(v => !v)}
              title={thinkingMode ? '🧠 思考过程已开启 — 点击关闭' : '🧠 思考过程已关闭 — 点击开启'}
              style={{
                padding: '4px 10px', borderRadius: 6,
                border: `1.5px solid ${thinkingMode ? '#f59e0b' : 'var(--border-light)'}`,
                background: thinkingMode ? 'var(--yellow-100)' : 'var(--surface-50)',
                cursor: 'pointer', fontSize: 12, display: 'flex',
                alignItems: 'center', gap: 3, fontFamily: 'inherit',
                opacity: thinkingMode ? 1 : 0.6,
                transition: 'all .2s',
              }}>
              🧠 思考
            </button>
            {/* ── 😊 表情 ── */}
            <div style={{ position: 'relative', flexShrink: 0 }}>
              <button
                onClick={() => setShowEmojiPicker(!showEmojiPicker)}
                title="表情符号"
                style={{
                  padding: '4px 10px', borderRadius: 6,
                  border: `1.5px solid ${showEmojiPicker ? '#93c5fd' : 'var(--border-light)'}`,
                  background: showEmojiPicker ? 'var(--accent-50)' : 'var(--surface-50)',
                  cursor: 'pointer', fontSize: 12, display: 'flex',
                  alignItems: 'center', gap: 3, fontFamily: 'inherit',
                  transition: 'all .15s',
                }}>
                😊 表情
              </button>
              {showEmojiPicker && (
                <>
                  <div style={{ position: 'fixed', inset: 0, zIndex: 99 }}
                    onClick={() => setShowEmojiPicker(false)} />
                  <div style={{
                    position: 'absolute', bottom: 40, left: 0, zIndex: 100,
                    width: 312, background: 'var(--surface-0)', borderRadius: 12,
                    border: '1px solid var(--border-light)',
                    boxShadow: '0 4px 24px rgba(0,0,0,.12)',
                    overflow: 'hidden',
                  }}>
                    <div style={{
                      display: 'flex', gap: 2, padding: '4px 6px',
                      borderBottom: '1px solid var(--border-light)',
                      background: 'var(--surface-50)', overflowX: 'auto',
                    }}
                      onWheel={e => {
                        const el = e.currentTarget
                        el.scrollLeft += e.deltaY
                        e.preventDefault()
                      }}
                    >
                      {EMOJI_GROUPS.map((group, gi) => (
                        <button key={gi}
                          onClick={() => {
                            const el = document.getElementById(`emoji-panel-${gi}`)
                            if (el) {
                              const container = el.parentElement
                              if (container) {
                                container.scrollTo({ top: el.offsetTop - 8, behavior: 'smooth' })
                              }
                            }
                          }}
                          title={group.name}
                          style={{
                            flexShrink: 0, height: 28, borderRadius: 6,
                            border: 'none', background: 'transparent',
                            cursor: 'pointer', fontSize: 12, fontWeight: 500,
                            color: 'var(--text-secondary)', padding: '0 8px',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            gap: 3, transition: 'background .1s',
                            whiteSpace: 'nowrap',
                          }}
                          onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--border-light)'}
                          onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'transparent'}
                        >
                          <span style={{ fontSize: 14 }}>{group.label}</span>
                          <span>{group.name}</span>
                        </button>
                      ))}
                    </div>
                    <div style={{ maxHeight: 240, overflowY: 'auto', padding: 6 }}>
                      {EMOJI_GROUPS.map((group, gi) => (
                        <div key={gi} id={`emoji-panel-${gi}`}>
                          {gi > 0 && <div style={{ height: 1, background: 'var(--border-light)', margin: '6px 2px' }} />}
                          <div style={{
                            fontSize: 10, color: 'var(--text-secondary)', fontWeight: 600,
                            padding: '2px 4px', marginBottom: 2,
                          }}>
                            {group.label} {group.name}
                          </div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
                            {group.emojis.map((emoji, ei) => (
                              <button key={ei}
                                onClick={() => {
                                  const el = inputRef.current
                                  if (el) {
                                    const { value, cursor } = insertAtCursor(el, emoji)
                                    setInput(value)
                                    setTimeout(() => {
                                      el.focus()
                                      el.setSelectionRange(cursor, cursor)
                                    }, 0)
                                  }
                                }}
                                title={emoji}
                                style={{
                                  width: 32, height: 32, borderRadius: 6,
                                  border: 'none', background: 'transparent',
                                  cursor: 'pointer', fontSize: 18,
                                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                                  transition: 'background .1s',
                                }}
                                onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--border-light)'}
                                onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'transparent'}
                              >
                                {emoji}
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
            {/* ── 📎 文件 ── */}
            <button
              onClick={() => fileInputRef.current?.click()}
              title="上传文件"
              style={{
                padding: '4px 10px', borderRadius: 6,
                border: `1.5px solid ${attachments.length > 0 ? '#93c5fd' : 'var(--border-light)'}`,
                background: attachments.length > 0 ? 'var(--accent-50)' : '#f9fafb',
                cursor: 'pointer', fontSize: 12, display: 'flex',
                alignItems: 'center', gap: 3, fontFamily: 'inherit',
              }}>
              📎 文件{attachments.length > 0 ? <sup style={{ fontSize: 9, color: '#3b82f6', marginLeft: 1 }}>{attachments.length}</sup> : null}
            </button>
            {/* ── 🎙️ 实时语音对话 ── */}
            <button onClick={async () => {
              if (realtimeVoiceActive) {
                try {
                  const r = await window.luminaAPI?.agentStopRealtimeVoice?.()
                  if (r?.success) { setRealtimeVoiceActive(false); showToast?.('🎙️ 实时语音对话已停止', 'info') }
                  else { showToast?.(`⚠️ ${r?.error || '停止失败'}`, 'warning') }
                } catch (e: any) { showToast?.(`⚠️ ${e.message}`, 'warning') }
              } else {
                try {
                  const r = await window.luminaAPI?.agentStartRealtimeVoice?.()
                  if (r?.success) { setRealtimeVoiceActive(true); showToast?.(r.message || '🎙️ 实时语音对话已启动', 'info') }
                  else { showToast?.(`⚠️ ${r?.error || '启动失败'}`, 'warning') }
                } catch (e: any) { showToast?.(`⚠️ ${e.message}`, 'warning') }
              }
            }}
              title={realtimeVoiceActive ? '停止实时语音对话' : '实时语音对话'}
              style={{
                padding: '4px 10px', borderRadius: 6,
                border: `1.5px solid ${realtimeVoiceActive ? '#22c55e' : 'var(--border-light)'}`,
                background: realtimeVoiceActive ? 'var(--green-100)' : '#f9fafb',
                cursor: 'pointer', fontSize: 12, display: 'flex',
                alignItems: 'center', gap: 3, fontFamily: 'inherit',
                boxShadow: realtimeVoiceActive ? '0 0 6px rgba(34,197,94,0.35)' : 'none',
              }}>
              {realtimeVoiceActive ? '🔊 实时语音对话' : '🎙️ 实时语音对话'}
            </button>
            {/* ── 💻 AI操作电脑 ── */}
            <button onClick={async () => {
              if (computerUseActive) {
                try { await window.luminaAPI?.agentStopComputerUse?.() } catch {}
                setComputerUseActive(false)
                showToast?.('💻 AI操作电脑已停止', 'info')
              } else {
                try {
                  const r = await window.luminaAPI?.agentStartComputerUse?.()
                  if (r?.success) { setComputerUseActive(true); showToast?.(r.message || '💻 AI操作电脑已就绪', 'info') }
                  else { showToast?.(`⚠️ ${r?.error || '启动失败'}`, 'warning') }
                } catch (e: any) { showToast?.(`⚠️ ${e.message}`, 'warning') }
              }
            }}
              title={computerUseActive ? '停止 AI操作电脑' : '让 AI 操作你的电脑'}
              style={{
                padding: '4px 10px', borderRadius: 6,
                border: `1.5px solid ${computerUseActive ? '#22c55e' : 'var(--border-light)'}`,
                background: computerUseActive ? 'var(--green-100)' : '#f9fafb',
                cursor: 'pointer', fontSize: 12, display: 'flex',
                alignItems: 'center', gap: 3, fontFamily: 'inherit',
                boxShadow: computerUseActive ? '0 0 6px rgba(34,197,94,0.35)' : 'none',
              }}>
              {computerUseActive ? '💻 AI操作电脑（运行中）' : '💻 AI操作电脑'}
            </button>
            {/* ── ⏳ 胶囊 ── */}
            <button onClick={() => {
              const text = input.trim()
              if (!text) { alert('输入你想对未来的自己说的话，然后点击 ⏳ 埋下时光胶囊'); return }
              if (window.confirm(`⏳ 埋一颗时光胶囊给未来的自己？\n\n内容: "${text.slice(0, 50)}${text.length > 50 ? '...' : ''}"\n\n默认 30 天后开启`)) {
                handleSendWithText(`帮我埋一颗时光胶囊，内容是：${text}，30天后开启`)
                setInput('')
              }
            }}
              title="埋时光胶囊 ⏳"
              style={{
                padding: '4px 10px', borderRadius: 6,
                border: '1.5px solid var(--border-light)',
                background: '#f9fafb',
                cursor: 'pointer', fontSize: 12, display: 'flex',
                alignItems: 'center', gap: 3, fontFamily: 'inherit',
              }}>
              ⏳ 胶囊
            </button>
            {/* 🆕 上下文用量指示器 */}
            <ContextUsageIndicator />
            {/* 弹性空间 */}
            <div style={{ flex: 1, minWidth: 8 }} />
          </div>

          {/* ── 📋 任务派发中心入口（工具条下方，与群聊一致） ── */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            fontFamily: 'var(--font-sans)',
          }}>
            <button
              onClick={() => setShowTaskDispatcher(true)}
              title="任务派发中心"
              style={{
                padding: '4px 10px', borderRadius: 6,
                border: '1.5px solid var(--border-light)',
                background: 'var(--surface-50)',
                cursor: 'pointer', fontSize: 12, display: 'flex',
                alignItems: 'center', gap: 3, fontFamily: 'inherit',
                transition: 'all 0.2s',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--accent, #6366f1)'; e.currentTarget.style.background = 'var(--surface-100)' }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border-light)'; e.currentTarget.style.background = 'var(--surface-50)' }}
            >
              📋 任务派发中心
            </button>
            <span style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>
              选择任务类型 → 选择执行者 → 一键派发
            </span>
          </div>

          {/* 子智能体（实习生）进度卡片：入口条正下方，与群聊视图一致 */}
          <SubagentCards sessionId={activeConversationId} />

          {/* 🎭 创新功能 2：团队可见性剧场（开关在「更多设置 → 任务剧场」）
              关闭时 TheaterMount 直接返回 null，不订阅也不占位 */}
          <TheaterMount />

          {/* 🍀 v1.0: Lucky 模式设置弹窗 */}
          {luckyMode.showSettings && (
            <LuckyModeSettings
              config={luckyMode.settings}
              onSave={(config: LuckySettingsConfig) => luckyMode.saveSettings(config)}
              onClose={() => luckyMode.setShowSettings(false)}
            />
          )}

          {/* ── 底部提示 ── */}
          <div style={{
            marginTop: 4, fontSize: 10, color: 'var(--text-secondary)',
            display: 'flex', justifyContent: 'space-between',
          }}>
            <span>
              {sttListening ? '🎤 语音输入中...' : 'Shift+Enter 换行 · /help 查看命令'}
            </span>
            <span style={{ cursor: 'default', color: 'var(--text-secondary)' }}>
              {getAgentRole(selectedRole).name}</span>
          </div>
        </div>

        <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} } @keyframes sendSpin { to { transform: rotate(360deg); } }`}</style>

        {/* 📋 任务派发中心弹窗 */}
        {showTaskDispatcher && (
          <TaskDispatcher
            onDispatch={handleTaskDispatch}
            onClose={() => setShowTaskDispatcher(false)}
          />
        )}

        {/* 🧭 决策卡片（agent 主动问「走哪条路」时出现）
            与审批弹窗分开：审批不答就拦下操作，决策不答按推荐项继续。 */}
        {pendingDecisions.map((d) => (
          <DecisionCard
            key={d.id}
            request={d}
            onSubmit={handleDecisionSubmit}
            onCancel={handleDecisionCancel}
          />
        ))}

        {/* v2.14: 删除确认 */}
        {deletingTarget && (
          <div style={{
            position: 'fixed', inset: 0, zIndex: 100000,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(0,0,0,0.3)',
          }} onClick={() => setDeletingTarget(null)}>
            <div style={{
              background: 'var(--surface-0)', borderRadius: 14, padding: 24,
              minWidth: 280, maxWidth: 400,
              boxShadow: '0 8px 30px rgba(0,0,0,0.15)',
            }} onClick={e => e.stopPropagation()}>
              <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8, color: 'var(--text-primary)' }}>
                🗑️ 删除消息
              </div>
              <div style={{
                fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6,
                maxHeight: 80, overflow: 'hidden', lineHeight: 1.5,
              }}>
                {deletingTarget.content.slice(0, 150)}{deletingTarget.content.length > 150 ? '...' : ''}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 20 }}>
                确定要删除这条消息吗？删除后不可恢复。
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button onClick={() => setDeletingTarget(null)} style={{
                  padding: '7px 16px', borderRadius: 8, border: '1px solid var(--border-light)',
                  background: 'var(--surface-100)', cursor: 'pointer', fontSize: 13, color: 'var(--text-secondary)',
                }}>取消</button>
                <button onClick={handleDeleteConfirm} style={{
                  padding: '7px 16px', borderRadius: 8, border: 'none',
                  background: '#ef4444', cursor: 'pointer', fontSize: 13, fontWeight: 600,
                  color: '#fff',
                }}>确认删除</button>
              </div>
            </div>
          </div>
        )}
      </> ))}
      </div>
      {/* 📋 右侧任务工作区面板 — 作为 flex 兄弟节点，展开时聊天区自动收缩 */}
      <TaskWorkspacePanel />
    </div>
  )
}
