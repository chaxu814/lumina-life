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
import { IconPlus } from '../components/Icons'
import { DEFAULT_PERSONAS, getPersona, getPersonaPrompt } from '../data/personas'
import ProactiveSidebar from '../components/ProactiveSidebar'
import MomentsPanel from '../components/MomentsPanel'
import AgentTaskBoard from '../components/AgentTaskBoard'
import AgentMoments from '../components/AgentMoments'
import MemoryTheater from '../components/MemoryTheater'
import GroupChatHistorySidebar from '../components/GroupChatHistorySidebar'
import GroupChatView from '../panels/GroupChatView'
import { updateEmotion, emotionContext } from '../services/agentEmotion'
import AgentEmotionBar, { injectEmotionStyles } from '../components/AgentEmotionBar'
import { addBookmark } from '../services/messageBookmarks'
import { showToast } from '../components/Toast'
import { buildAgentPrompt, AGENT_SOULS } from '../data/agentSouls'
import {
  calculateSpark,
  calculateChainSpark,
  detectUncertainty,
  detectMentionInReply,
} from '../services/conversationDynamics'
import LuckyModeSelector from '../components/LuckyModeSelector'
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
  cleanTtsText, formatTime, getConvPreview, insertAtCursor, getAgentSystemPrompt,
} from '../chat/chatShared'

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
  const skillConfig = useStore(s => s.skillConfig)
  const profile = useStore(s => s.profile)

  const [input, setInput] = useState('')
  const [mode, setMode] = useState<'chat' | 'agent' | 'developer' | 'worker' | 'group'>('group')

  // ── ?ref 跟踪最新值，避免 useEffect([]) 闭包过期（必须声明在 mode 之后）──
  const latestRef = useRef({ activeConversationId, isProcessing, mode } as const)
  latestRef.current = { activeConversationId, isProcessing, mode }
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
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const abortRef = useRef(false)
  // ── v2.7: 审批流状态 ────────────────────────────
  const [approvalRequests, setApprovalRequests] = useState<any[]>([])

  // ═══ v2.14: 消息内联按钮 ═══
  const [hoveredMsgId, setHoveredMsgId] = useState<string | null>(null)

  // 副人格冲突弹幕
  const [personalityConflict, setPersonalityConflict] = useState<any>(null)
  const [deletingTarget, setDeletingTarget] = useState<{ msgId: string; content: string } | null>(null)
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null)

  const activeConv = conversations.find(c => c.id === activeConversationId)
  const messages = activeConv?.messages || []
  const persona = getPersona(activePersona, agentConfig.customPersonas)
  const currentVoice = TTS_VOICES.find(v => v.id === ttsConfig.voice) || TTS_VOICES[0]

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
    prevModeRef.current = mode
  }, [mode])

  // scroll
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, agentEvents, streamingText])

  // 注入情绪条 CSS 动画
  useEffect(() => { injectEmotionStyles() }, [])

  // ── v2.7: 审批流事件监听 ──────────────────────
  useEffect(() => {
    if (!window.luminaAPI) return
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
    if (!window.luminaAPI?.onPersonalityConflict) return
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
    if (!deletingTarget) return
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
        if (text.trim()) setTimeout(() => handleSendRef.current?.(text), 300)
      },
      (status) => {
        setSttStatus(status)
        setSttListening(status.listening)
      }
    )

    proactiveChat.onProactiveTrigger((trigger, message) => {
      const { activeConversationId, isProcessing } = latestRef.current
      if (!activeConversationId || isProcessing) return
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
      if (!speaking) setTtsError(null) // 播放结束清除错误
    })
    ttsEngine.onError((err) => {
      console.warn('[ChatPanel] TTS 错误:', err)
      setTtsError(err)
      setTtsSpeaking(false)
    })
    // 启动时检?TTS 服务健康状?
    ttsEngine.healthCheck().then((r) => {
      if (!r.ok) console.warn('[ChatPanel] TTS 健康检?', r.detail)
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
    if (useStore.getState().ttsMuted) return
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
    if (typingRef.current) clearInterval(typingRef.current)

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
    if (newAttachments.length > 0) setAttachments(prev => [...prev, ...newAttachments])
  }

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return
    await processMainFiles(e.target.files)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation()
    setDragOver(false)
    if (e.dataTransfer.files.length > 0) await processMainFiles(e.dataTransfer.files)
  }

  const removeAttachment = (index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index))
  }

  const clearAttachments = () => setAttachments([])

  const handleSendWithText = useCallback(async (text: string) => {
    if (!text.trim() || isProcessing || !activeConversationId) return

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

    // ── 🔓 解锁 AudioContext（确保首?TTS 不被 autoplay 阻止）──
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
        if (a.text) desc += `\n内容:\n${a.text}`
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
    setAgentEvents([{ type: 'thinking', text: '思考中...', timestamp: Date.now() }])
    useAgentRuntime.getState().setAgentEvents([{ type: 'thinking', text: '思考中...', timestamp: Date.now() }])

    const systemPrompt = persona ? getPersonaPrompt(persona) : undefined
    // 清理 — group 模式永远不走此路径（由 GroupChatView 独立处理）
    //   isGroupChat 不设置，默认 false，buildSystemPrompt 使用干净提示词
    const config = {
      mode: mode === 'worker' ? 'agent' : mode as 'chat' | 'agent' | 'developer',
      model: llmConfig.model,
      baseUrl: llmConfig.baseUrl,
      apiKey: llmConfig.apiKey,
      temperature: llmConfig.temperature,
      maxTokens: llmConfig.maxTokens,
      maxToolCalls: mode === 'worker' ? 3 : 10,
      systemPrompt: mode === 'worker'
        ? `${systemPrompt || ''}\n\n【Worker 模式】你是高效的任务执行器。只输出结果，不闲聊。`
        : systemPrompt,
      personaId: activePersona,
      disabledTools: getDisabledToolNames(skillConfig),
      contextWindow: llmConfig.contextWindow || 0,
    }

    const eventLog: any[] = []
    let agentText = ''
    /** 🆕 v6.1: 当前消息的思维步骤追踪器 */
    let stepIds = new Set<string>()
    let stepStartTimes = new Map<string, number>()
    let thinkingAccum: ThinkingStep[] = []

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
      setCurrentThinkingSteps([...thinkingAccum])
      // 同步到 runtime store 以便跨面板访问
      useAgentRuntime.getState().setAgentEvents([...eventLog])
    }

    const unsub = window.luminaAPI.onAgentEvent((ev) => {
      if (abortRef.current) return

      // 推理流 — 不再吞掉！推入 ThinkingStep 显示推理内容
      if (ev.type === 'thinking_stream') {
        const stableKey = `reasoning:${currentReplyId}`
        if (ev.isLast) {
          const existing = thinkingAccum.find(s => (s as any)._stableKey === stableKey)
          upsertThinkingStep({
            id: `re-${Date.now()}`,
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
            id: `re-${Date.now()}`,
            type: 'thinking',
            label: '💭 推理中...',
            result: fullText.slice(-5000),
            timestamp: Date.now(),
          }, stableKey)
        } else if (ev.isFirst) {
          // isFirst 只创建占位，不累积文本
          if (!thinkingAccum.find(s => (s as any)._stableKey === stableKey)) {
            upsertThinkingStep({
              id: `re-${Date.now()}`,
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

      // 其他事件正常推入
      eventLog.push(ev)
      // 双写 — 本地 state (渲染) + runtime store (跨面板备份)
      setAgentEvents([...eventLog])
      useAgentRuntime.getState().setAgentEvents([...eventLog])

      // 工具事件 → ThinkingStep
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
        conversationHistory: history,
      })
      agentText = result.content || ''
      unsub()
      // 保存结构化思考步骤供面板展示
      setLastAgentEvents([...agentEvents, ...currentThinkingSteps.map(s => ({ ...s, type: 'thinking', text: `${s.label}${s.result ? '\n' + s.result : ''}` }))])
      setAgentEvents([])
      setCurrentThinkingSteps([])
      useAgentRuntime.getState().resetAgentRuntime()

      if (agentText && !abortRef.current) {
        // ── 🔧 v2.17: 修复闭包过期 — 使用最新 convId，切换对话时不丢消息 ──
        const finalConvId = useStore.getState().activeConversationId || activeConversationId
        useStore.getState().addMessage(finalConvId, 'assistant', agentText)
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
      unsub(); setLastAgentEvents([...agentEvents, ...currentThinkingSteps.map(s => ({ ...s, type: 'thinking', text: `${s.label}${s.result ? '\n' + s.result : ''}` }))])
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
  }, [isProcessing, activeConversationId, mode, llmConfig, persona, agentConfig, activePersona, ttsMuted, ttsConfig, setIsProcessing, addAuditLog])

  // ref 赋值在 useCallback 声明之后，避免 TDZ
  handleSendRef.current = handleSendWithText

  const handleSend = () => handleSendWithText(input)
  const handleAbort = () => {
    abortRef.current = true
    window.luminaAPI.agentAbort()
    // 保留思考步骤供查看
    setLastAgentEvents([...agentEvents, ...currentThinkingSteps.map(s => ({ ...s, type: 'thinking', text: `${s.label}${s.result ? '\n' + s.result : ''}` }))])
    setAgentEvents([])
    setCurrentThinkingSteps([])
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
        borderRight: showHistory ? '1px solid #e5e7eb' : 'none',
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
        transition: 'width 0.25s ease, min-width 0.25s ease',
        flexShrink: 0,
      }}>
        {(showHistory) && (
          <>
            {/* 👥 团队群聊 — 固定在顶部，独立醒目 */}
            <div
              onClick={() => { setMode('group'); window.luminaAPI?.agentSetMode('group') }}
              style={{
                padding: '10px 12px',
                cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8,
                background: mode === 'group'
                  ? 'linear-gradient(135deg, #eff6ff 0%, #f0f9ff 100%)'
                  : 'linear-gradient(135deg, #fafafa 0%, #f5f5f5 100%)',
                borderBottom: mode === 'group'
                  ? '2px solid #3b82f6'
                  : '2px solid transparent',
                borderLeft: mode === 'group' ? '3px solid #3b82f6' : '3px solid transparent',
                transition: 'all 0.2s',
                flexShrink: 0,
              }}
              onMouseEnter={e => {
                if (mode !== 'group') {
                  (e.currentTarget as HTMLElement).style.background = 'linear-gradient(135deg, #f3f4f6 0%, #e5e7eb 100%)'
                }
              }}
              onMouseLeave={e => {
                if (mode !== 'group') {
                  (e.currentTarget as HTMLElement).style.background = 'linear-gradient(135deg, #fafafa 0%, #f5f5f5 100%)'
                }
              }}
            >
              <span style={{
                fontSize: 20,
                filter: mode === 'group' ? 'none' : 'grayscale(0.3)',
                transition: 'filter 0.2s',
              }}>👥</span>
              <div style={{ flex: 1 }}>
                <div style={{
                  fontSize: 14, fontWeight: mode === 'group' ? 700 : 600,
                  color: mode === 'group' ? '#1d4ed8' : 'var(--text-primary)',
                }}>
                  团队群聊
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 1 }}>
                  Lumina🐱 · 热茶 · Yak📊
                </div>
              </div>
              {mode === 'group' && (
                <span style={{
                  width: 8, height: 8, borderRadius: 4, background: '#3b82f6',
                  flexShrink: 0, boxShadow: '0 0 6px rgba(59,130,246,0.5)',
                }} />
              )}
            </div>

            {/* 🆕 模式切换 — 团队群聊下方的模式选择 */}
            <div style={{ padding: '4px 6px', flexShrink: 0 }}>
              {([
                { id: 'chat' as const, icon: '💬', label: '聊天' },
                { id: 'agent' as const, icon: '🤖', label: 'AI智能体' },
                { id: 'worker' as const, icon: '⚡', label: '快速模式' },
                { id: 'developer' as const, icon: '🔧', label: '修复模式' },
              ]).map(item => (
                <button key={item.id}
                  className={'mode-sidebar-item' + (mode === item.id ? ' active' : '')}
                  onClick={() => { setMode(item.id); window.luminaAPI?.agentSetMode(item.id) }}
                >
                  <span className="mode-dot" style={{
                    background: mode === item.id ? 'var(--accent-500, #6366f1)' : '#d1d5db',
                  }} />
                  <span>{item.icon}</span>
                  <span style={{ flex: 1 }}>{item.label}</span>
                </button>
              ))}
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
                  <button onClick={() => createConversation()} title="新建对话"
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
                  {conversations.length === 0 && (
                    <div style={{ padding: 16, textAlign: 'center', color: 'var(--text-secondary)', fontSize: 12 }}>
                      暂无对话记录
                    </div>
                  )}
                  {[...conversations]
                    .sort((a, b) => {
                      if (a.pinned && !b.pinned) return -1
                      if (!a.pinned && b.pinned) return 1
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
                    if (editName.trim()) renameConversation(conv.id, editName.trim())
                    setEditingNameId(null)
                  }

                  return (
                    <div key={conv.id}
                      onClick={() => { if (!isEditing) switchConversation(conv.id) }}
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
                                if (e.key === 'Enter') commitRename()
                                if (e.key === 'Escape') setEditingNameId(null)
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
                            {formatTime(conv.createdAt)} · {conv.messages.length} 条消息
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
                                background: 'transparent', color: '#d1d5db',
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
                                if (conversations.length <= 1) return
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
                                  (e.currentTarget as HTMLElement).style.color = '#ef4444'
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
          background: '#f8f9fb', borderRight: showProactivePanel ? '1px solid #e5e7eb' : 'none',
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
          padding: '10px 14px', borderBottom: '1px solid var(--border-light)',
          display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, flexWrap: 'wrap',
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

          {/* ⚡ 主动引擎按钮 */}
          <button onClick={() => { setShowProactivePanel(!showProactivePanel); setShowHistory(true) }}
            title="24/7 主动对话引擎" style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '5px 14px', border: 'none', cursor: 'pointer', borderRadius: 20,
              fontSize: 12, fontWeight: 700,
              background: showProactivePanel ? 'linear-gradient(135deg, #7c3aed, #6366f1)' : 'linear-gradient(135deg, #8b5cf6, #7c3aed)',
              color: '#fff',
              boxShadow: showProactivePanel ? '0 0 14px rgba(124,58,237,0.5)' : '0 2px 8px rgba(124,58,237,0.3)',
              transition: 'all 0.25s',
            }}><span style={{ fontSize: 15 }}>⚡</span><span>主动引擎</span></button>

          {/* 🌸 朋友圈按钮 */}
          <button onClick={() => setShowMomentsPanel(!showMomentsPanel)}
            title="Agent 朋友圈" style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '5px 14px', cursor: 'pointer', borderRadius: 20,
              fontSize: 12, fontWeight: 700,
              background: showMomentsPanel ? 'linear-gradient(135deg, #ec4899, #f43f5e)' : 'linear-gradient(135deg, #fdf2f8, #fce7f3)',
              color: showMomentsPanel ? 'var(--surface-0)' : '#be185d',
              border: showMomentsPanel ? 'none' : '1px solid #f9a8d4',
              boxShadow: showMomentsPanel ? '0 0 14px rgba(236,72,153,0.5)' : '0 1px 3px rgba(236,72,153,0.15)',
              transition: 'all 0.25s',
            }}><span style={{ fontSize: 15 }}>🌸</span><span>朋友圈</span></button>

          <span style={{ fontWeight: 600, fontSize: 15, color: '#111827' }}>
            {mode === 'group' ? '👥 团队群聊' : mode === 'agent' ? '🤖 AI智能体' : mode === 'worker' ? '⚡ 快速模式' : mode === 'developer' ? '🔧 修复模式' : '💬 聊天'}
          </span>
          <div style={{ flex: 1, minWidth: 8 }} />

          {/* Persona picker — v2.8.1: 群聊模式下隐藏 */}
          {mode !== 'group' && (
          <div style={{ position: 'relative' }}>
            <button onClick={() => { setShowPersonaPicker(!showPersonaPicker); setShowVoicePicker(false) }}
              style={subtleBtn}>
              {currentPersona?.icon || '🐱'} {currentPersona?.name || 'Lumina'}
            </button>
            {showPersonaPicker && (
              <div style={{
                position: 'absolute', top: 36, right: 0, background: 'var(--surface-0)',
                border: '1px solid var(--border-light)', borderRadius: 8, padding: 4,
                zIndex: 100, boxShadow: '0 4px 12px rgba(0,0,0,.1)', minWidth: 140,
              }}>
                {[...DEFAULT_PERSONAS, ...agentConfig.customPersonas].map(p => (
                  <div key={p.id} onClick={() => { setActivePersona(p.id); setShowPersonaPicker(false) }}
                    style={{
                      padding: '6px 10px', cursor: 'pointer', borderRadius: 4, fontSize: 13,
                      background: p.id === activePersona ? '#eff6ff' : 'transparent',
                    }}>
                    {p.icon} {p.name}
                  </div>
                ))}
              </div>
            )}
          </div>
          )}

          {/* ── TTS 音色选择 — v2.8.1: 群聊模式下隐藏 */}
          {mode !== 'group' && (
          <div style={{ position: 'relative' }}>
            <button onClick={() => { setShowVoicePicker(!showVoicePicker); setShowPersonaPicker(false) }}
              style={{
                ...subtleBtn, gap: 3, fontSize: 11, padding: '4px 8px',
              }}
              title={`当前音色: ${currentVoice.label} - ${currentVoice.desc}`}>
              <span style={{ fontSize: 13 }}>{currentVoice.icon}</span>
              <span>{currentVoice.label}</span>
              <span style={{ fontSize: 9, color: 'var(--text-secondary)' }}></span>
            </button>
            {showVoicePicker && (
              <div style={{
                position: 'absolute', top: 36, right: 0, background: 'var(--surface-0)',
                border: '1px solid var(--border-light)', borderRadius: 8, padding: 6,
                zIndex: 100, boxShadow: '0 4px 12px rgba(0,0,0,.1)',
                minWidth: 200, maxHeight: 280, overflowY: 'auto',
              }}>
                <div style={{ fontSize: 10, color: 'var(--text-secondary)', padding: '4px 8px 6px', borderBottom: '1px solid var(--border-light)', marginBottom: 4 }}>
                  Edge-TTS 音色
                </div>
                {TTS_VOICES.map(v => {
                  const isActive = v.id === ttsConfig.voice
                  return (
                    <div key={v.id}
                      onClick={() => {
                        setTTSConfig({ voice: v.id })
                        setShowVoicePicker(false)
                      }}
                      style={{
                        padding: '6px 10px', cursor: 'pointer', borderRadius: 4, fontSize: 12,
                        background: isActive ? '#eff6ff' : 'transparent',
                        display: 'flex', alignItems: 'center', gap: 8,
                        border: isActive ? '1px solid #bfdbfe' : '1px solid transparent',
                      }}>
                      <span style={{ fontSize: 16 }}>{v.icon}</span>
                      <div>
                        <div style={{ fontWeight: isActive ? 600 : 500, color: isActive ? '#1d4ed8' : 'var(--text-primary)' }}>
                          {v.label}
                          {isActive && <span style={{ marginLeft: 6, fontSize: 10, color: '#3b82f6' }}></span>}
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

          {/* ── TTS 可视化播放器 — v2.8.1: 群聊下隐藏 */}
          {mode !== 'group' && (
          <div style={{ position: 'relative' }}>
            <button
              onClick={() => {
                if (ttsSpeaking) {
                  // 正在朗读 ?停止 + 触发取消动画
                  ttsEngine.stop()
                  setTtsJustStopped(true)
                  if (ttsStoppedTimer.current) clearTimeout(ttsStoppedTimer.current)
                  ttsStoppedTimer.current = setTimeout(() => setTtsJustStopped(false), 600)
                } else {
                  // 未朗??切换静音 + 触发翻转动画
                  ttsToggle()
                  setTtsToggling(true)
                  if (ttsToggleTimer.current) clearTimeout(ttsToggleTimer.current)
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
          <button onClick={() => createConversation()} title="新建对话"
            style={{
              ...subtleBtn, padding: '4px 6px', minWidth: 28, justifyContent: 'center',
            }}>
            <IconPlus size={16} />
          </button>
          )}
        </div>

        {mode === 'group' ? <GroupChatView /> : (<>

        {/* 🔥 v2.12: Agent 情绪状态栏 */}
        <AgentEmotionBar
          mode={mode}
          onStatusChange={(agentId, status) => {
            console.log(`[ChatPanel] ${agentId} status → ${status}`)
          }}
        />

        {/* ── Messages ── */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>
          {messages.length === 0 && !isProcessing && (
            <div style={{ textAlign: 'center', color: 'var(--text-secondary)', marginTop: 100, fontSize: 14 }}>
              <div style={{ fontSize: 48, marginBottom: 12 }}></div>
              <div>你好！我是 Lumina，你的 AI 桌宠助手</div>
              <div style={{ marginTop: 4, fontSize: 12 }}>试试让我帮你做事？搜索、文件、Git、定时任务…</div>
              <div style={{ marginTop: 8, fontSize: 11, color: '#d1d5db' }}>
                也可以点 🎤 用语音跟我说话哦
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
                  ? (profile.bubbleColorUser || '#eff6ff')
                  : (profile.bubbleColorAgent || 'var(--surface-100)'),
                borderRadius: 12, padding: '8px 12px', border: '1px solid var(--border-light)',
                userSelect: 'text',
                cursor: 'text',
              }}>
                {isUser && profile.nickname && (
                  <div style={{ fontSize: 10, fontWeight: 600, color: '#3b82f6', marginBottom: 2 }}>
                    {profile.nickname}
                  </div>
                )}
                <div style={{
                  fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word', userSelect: 'text',
                }}>{msg.content.replace(/^\n+/, '')}</div>
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
                    {formatTime(msg.timestamp)}
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
                onClick={() => setThinkingExpanded(!thinkingExpanded)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  padding: '5px 10px', borderRadius: 8,
                  border: '1px solid var(--border-light)', background: '#fafafa',
                  fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer',
                  transition: 'background 0.15s', width: 'fit-content',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--border-light)')}
                onMouseLeave={e => (e.currentTarget.style.background = '#fafafa')}
              >
                <span style={{
                  display: 'inline-block',
                  transition: 'transform 0.2s',
                  transform: thinkingExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                  fontSize: 8,
                }}>▶</span>
                <span>🧠 思考过程</span>
                <span style={{
                  background: 'var(--border-light)', borderRadius: 8,
                  padding: '0px 5px', fontSize: 9, color: 'var(--text-secondary)',
                }}>{lastAgentEvents.length}步</span>
                {lastAgentEvents.some((e: any) => e.type === 'tool_start') && (
                  <span style={{ fontSize: 9 }}>🔧</span>
                )}
              </button>
              {thinkingExpanded && (
                <div style={{
                  marginTop: 4, padding: '6px 8px',
                  background: '#fafafa', borderRadius: 8,
                  border: '1px solid var(--border-light)',
                  maxHeight: 320, overflowY: 'auto',
                }}>
                  {lastAgentEvents.map((ev: any, i: number) => {
                    const isThinking = ev.type === 'thinking'
                    const isToolStart = ev.type === 'tool_start'
                    const isToolEnd = ev.type === 'tool_end' || ev.type === 'tool_error'
                    return (
                      <div key={i} style={{
                        marginBottom: 3, display: 'flex', alignItems: 'flex-start',
                        gap: 6, fontSize: 11,
                        borderBottom: i < lastAgentEvents.length - 1 ? '1px solid #f3f4f6' : 'none',
                        paddingBottom: 3,
                      }}>
                        <span style={{ fontSize: 12, flexShrink: 0, marginTop: 0 }}>
                          {isThinking && (ev.label?.includes('推理') ? '💭' : '🤔')}
                          {isToolStart && '🔨'}
                          {isToolEnd && (ev.result?.ok !== false ? '✅' : '❌')}
                          {!isThinking && !isToolStart && !isToolEnd && '📋'}
                        </span>
                        <div style={{ color: 'var(--text-secondary)', lineHeight: 1.4, flex: 1, minWidth: 0 }}>
                          {isThinking && (
                            <>
                              <span style={{ fontWeight: 500 }}>{ev.label || ev.text?.slice(0, 60)}</span>
                              {ev.result && ev.result !== ev.label && ev.result !== ev.text && (
                                <div style={{
                                  marginTop: 2, padding: '2px 6px',
                                  background: 'var(--green-100)', borderRadius: 4,
                                  color: 'var(--text-primary)', fontSize: 10,
                                  whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                                  maxHeight: 120, overflowY: 'auto',
                                }}>{ev.result.slice(0, 800)}</div>
                              )}
                            </>
                          )}
                          {isToolStart && (
                            <span>
                              <b>{ev.tool}</b>
                              {ev.args ? ` ${ev.args.slice(0, 80)}` : ''}
                            </span>
                          )}
                          {isToolEnd && (
                            <div style={{ color: ev.result?.ok !== false ? '#16a34a' : '#dc2626' }}>
                              <span style={{ fontWeight: ev.tool ? 600 : 400 }}>
                                {ev.tool && `${ev.tool}: `}
                              </span>
                              <span style={{ fontSize: 10 }}>
                                {(ev.result || ev.error || '(完成)').slice(0, 200)}
                              </span>
                              {ev.durationMs && (
                                <span style={{ marginLeft: 6, color: 'var(--text-secondary)', fontSize: 9 }}>
                                  {(ev.durationMs / 1000).toFixed(1)}s
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {/* 🆕 v6.1: 实时思考过程 — 运行中展示（借鉴团队群聊） */}
          {isProcessing && currentThinkingSteps.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div style={{
                padding: '6px 8px', background: 'var(--yellow-100)', borderRadius: 8,
                border: '1px solid #fde68a', maxHeight: 320, overflowY: 'auto',
              }}>
                <div style={{ fontSize: 11, color: '#92400e', fontWeight: 600, marginBottom: 4 }}>
                  🧠 实时思考中...
                </div>
                {currentThinkingSteps.map((step, i) => {
                  const isReasoning = step.label?.includes('推理')
                  return (
                    <div key={step.id || i} style={{
                      marginBottom: 3, display: 'flex', alignItems: 'flex-start',
                      gap: 6, fontSize: 11,
                      borderBottom: i < currentThinkingSteps.length - 1 ? '1px solid #fef3c7' : 'none',
                      paddingBottom: 3,
                    }}>
                      <span style={{ fontSize: 12, flexShrink: 0 }}>
                        {isReasoning ? '💭' : step.type === 'tool_start' ? '🔨' : step.type === 'tool_end' ? '✅' : step.type === 'tool_error' ? '❌' : '🤔'}
                      </span>
                      <div style={{ color: 'var(--text-secondary)', lineHeight: 1.4, flex: 1, minWidth: 0 }}>
                        <span style={{ fontWeight: 500 }}>{step.label}</span>
                        {step.result && step.result !== step.label && (
                          <div style={{
                            marginTop: 2, padding: '2px 6px',
                            background: isReasoning ? '#f0fdf4' : 'var(--surface-100)',
                            borderRadius: 4, color: 'var(--text-primary)', fontSize: 10,
                            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                            maxHeight: 100, overflowY: 'auto',
                          }}>{step.result.slice(0, 500)}</div>
                        )}
                        {step.durationMs && (
                          <span style={{ marginLeft: 6, color: 'var(--text-secondary)', fontSize: 9 }}>
                            {(step.durationMs / 1000).toFixed(1)}s
                          </span>
                        )}
                      </div>
                    </div>
                  )
                })}
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
            <span style={{ fontSize: 12, color: '#1d4ed8', fontWeight: 600 }}>📥 将上传：</span>
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
                  background: 'var(--accent-50)', border: '1px solid #bfdbfe',
                  borderRadius: 6, padding: '3px 8px', fontSize: 11,
                  color: '#1d4ed8', maxWidth: 200,
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

          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <textarea ref={inputRef} value={input}
              onChange={e => { setInput(e.target.value); autoResize() }}
              onKeyDown={handleKeyDown}
              placeholder={
                isProcessing ? 'Lumina 正在回复，你可以先打草稿等待' :
                mode === 'worker' ? 'Worker 模式 — 给我一个任务，我快速执行' :
                mode === 'developer' ? 'Dev 模式 — 告诉我代码任务' :
                mode === 'agent' ? '告诉我要做什么，Agent 自动执行...（或点 🎤 语音输入）' :
                '和我聊天吧...（或点 🎤 语音输入）'
              }
              rows={1}
              style={{
                flex: 1, padding: '8px 12px', borderRadius: 8,
                border: '1px solid #d1d5db', fontSize: 13, lineHeight: 1.5,
                resize: 'vertical', outline: 'none', fontFamily: 'inherit',
                minHeight: 36,
                background: isProcessing ? '#fffbeb' : 'var(--surface-0)',
              }}
            />

            {/* 📎 文件上传 */}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.json,.xml,.md,.csv,.yaml,.yml,.log,.py,.js,.ts,.java,.cpp,.c,.h,.html,.css,.sh,.bat,.ps1,.ini,.cfg,.toml,.zip"
              style={{ display: 'none' }}
              onChange={handleFileSelect}
            />
            <div style={{ position: 'relative', flexShrink: 0 }}
              onMouseEnter={() => {
                if (uploadTipTimer.current) { clearTimeout(uploadTipTimer.current); uploadTipTimer.current = null }
                setUploadTipVisible(true)
                setShowUploadTip(true)
              }}
              onMouseLeave={() => {
                setUploadTipVisible(false)
                uploadTipTimer.current = setTimeout(() => setShowUploadTip(false), 200)
              }}
            >
              <button
                onClick={() => fileInputRef.current?.click()}
                title="上传文件"
                style={{
                  width: 36, height: 36, borderRadius: 8,
                  border: `1.5px solid ${attachments.length > 0 ? '#93c5fd' : 'var(--border-light)'}`,
                  background: attachments.length > 0 ? '#eff6ff' : 'var(--surface-100)',
                  cursor: 'pointer', fontSize: 17,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  transition: 'all .15s',
                }}>
                📎
              </button>
              {showUploadTip && (
                <div style={{
                  position: 'absolute', bottom: 42, left: '50%',
                  background: '#1f2937', color: '#fff', borderRadius: 8,
                  padding: '6px 10px', fontSize: 11, lineHeight: 1.5,
                  whiteSpace: 'nowrap', zIndex: 101,
                  boxShadow: '0 2px 12px rgba(0,0,0,.18)',
                  pointerEvents: 'none',
                  opacity: uploadTipVisible ? 1 : 0,
                  transform: uploadTipVisible
                    ? 'translate(-50%, 0) scale(1)'
                    : 'translate(-50%, 6px) scale(0.95)',
                  transition: 'opacity 0.18s ease-out, transform 0.18s ease-out',
                }}>
                  <div style={{ fontWeight: 600, marginBottom: 3 }}>📎 上传文件</div>
                  <div style={{ opacity: 0.8 }}>图片 · 文档 · 代码 · 文本</div>
                  <div style={{ opacity: 0.6, fontSize: 10, marginTop: 2 }}>png / pdf / docx / xlsx / py / js / txt</div>
                  <div style={{ opacity: 0.5, fontSize: 10, marginTop: 1 }}>单文件 ≤10MB · 支持多种格式</div>
                </div>
              )}
            </div>

            {/* 😊 Emoji 选择?*/}
            <div style={{ position: 'relative', flexShrink: 0 }}>
              <button
                onClick={() => setShowEmojiPicker(!showEmojiPicker)}
                title="表情符号"
                style={{
                  width: 36, height: 36, borderRadius: 8,
                  border: `1.5px solid ${showEmojiPicker ? '#93c5fd' : 'var(--border-light)'}`,
                  background: showEmojiPicker ? '#eff6ff' : 'var(--surface-100)',
                  cursor: 'pointer', fontSize: 17,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  transition: 'all .15s', flexShrink: 0,
                }}>
                😊
              </button>
              {showEmojiPicker && (
                <>
                  <div style={{ position: 'fixed', inset: 0, zIndex: 99 }}
                    onClick={() => setShowEmojiPicker(false)} />
                  <div style={{
                    position: 'absolute', bottom: 44, right: 0, zIndex: 100,
                    width: 312, background: 'var(--surface-0)', borderRadius: 12,
                    border: '1px solid var(--border-light)',
                    boxShadow: '0 4px 24px rgba(0,0,0,.12)',
                    overflow: 'hidden',
                  }}>
                    {/* ═══分类标签 ═══*/}
                    <div style={{
                      display: 'flex', gap: 2, padding: '4px 6px',
                      borderBottom: '1px solid var(--border-light)',
                      background: '#fafafa', overflowX: 'auto',
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
                            const el = document.getElementById(`emoji-group-${gi}`)
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
                    {/* ═══Emoji 网格 ═══*/}
                    <div style={{ maxHeight: 240, overflowY: 'auto', padding: 6 }}>
                      {EMOJI_GROUPS.map((group, gi) => (
                        <div key={gi} id={`emoji-group-${gi}`}>
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

            <button onClick={toggleMic} disabled={isProcessing}
              title={sttListening ? '停止语音输入' : '语音输入'}
              style={{
                width: 36, height: 36, borderRadius: 8,
                border: `1.5px solid ${sttListening ? '#ef4444' : 'var(--border-light)'}`,
                background: sttListening ? '#fef2f2' : 'var(--surface-100)',
                cursor: isProcessing ? 'default' : 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                transition: 'all .2s', flexShrink: 0,
                opacity: isProcessing ? 0.5 : 1, fontSize: 16,
              }}>
              {sttListening ? '🔴' : '🎤'}
            </button>

            {/* 🆕 v3.0: 时光胶囊按钮 */}
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
                width: 36, height: 36, borderRadius: 8,
                border: '1.5px solid var(--border-light)',
                background: 'var(--surface-100)',
                cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                transition: 'all .2s', flexShrink: 0, fontSize: 16,
              }}>
              ⏳
            </button>

            <button onClick={handleSend} disabled={isProcessing || !input.trim()}
              className="btn-send-pulse"
              style={{
                border: 'none', borderRadius: 8, padding: '7px 16px',
                background: input.trim() ? (isProcessing ? '#2563eb' : '#3b82f6') : 'var(--border-light)',
                color: (isProcessing || input.trim()) ? 'var(--surface-0)' : 'var(--text-secondary)',
                fontSize: 13, cursor: input.trim() && !isProcessing ? 'pointer' : 'default', fontWeight: 600,
                minWidth: 56, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                transition: 'all .2s',
                boxShadow: isProcessing ? '0 0 0 3px rgba(59,130,246,.3)' : undefined,
              }}>
              {isProcessing ? (<>
                <span style={{
                  width: 14, height: 14, borderRadius: '50%',
                  border: '2px solid rgba(255,255,255,.3)',
                  borderTopColor: '#fff',
                  animation: 'spin 0.6s linear infinite',
                  flexShrink: 0,
                }} />
                <span style={{ fontSize: 12 }}>处理中</span>
              </>) : (
                '发送'
              )}
            </button>
          </div>

          {/* 🍀 v1.0: Lucky 模式控制栏 */}
          <div style={{
            marginTop: 4, display: 'flex', alignItems: 'center', gap: 6,
          }}>
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
              disabled={isProcessing}
              onOpenSettings={() => luckyMode.setShowSettings(true)}
            />
            {luckyMode.isActive && !luckyMode.isPaused && (
              <span style={{
                fontSize: 9, color: 'var(--text-secondary)', marginLeft: 2,
                display: 'flex', alignItems: 'center', gap: 3,
              }}>
                <span style={{
                  width: 4, height: 4, borderRadius: 2,
                  background: '#10b981',
                  animation: 'pulse 1.2s ease-in-out infinite',
                }} />
                运行中
              </span>
            )}
            {luckyMode.isPaused && (
              <button
                onClick={luckyMode.resume}
                style={{
                  padding: '1px 8px', borderRadius: 4,
                  border: '1px solid #fca5a5', background: '#fef2f2',
                  cursor: 'pointer', fontSize: 10, color: '#dc2626',
                  display: 'flex', alignItems: 'center', gap: 3,
                }}>
                ▶️ 继续
              </button>
            )}
          </div>

          {/* 🍀 v1.0: Lucky 模式设置弹窗 */}
          {luckyMode.showSettings && (
            <LuckyModeSettings
              config={luckyMode.settings}
              onSave={(config: LuckySettingsConfig) => luckyMode.saveSettings(config)}
              onClose={() => luckyMode.setShowSettings(false)}
            />
          )}

          <div style={{
            marginTop: 4, fontSize: 10, color: 'var(--text-secondary)',
            display: 'flex', justifyContent: 'space-between',
          }}>
            <span>
              {mode === 'worker' ? '⚡ Worker: 单任务快速执行' :
               mode === 'agent' ? '🤖 Agent: 多轮自动工具调用' :
               mode === 'developer' ? '🔧 Developer: ?Git 工具' :
               '💬 Chat: 轻量对话模式'}
              {sttListening ? ' · 🎤 语音输入中...' : ' · Shift+Enter 换行'}
            </span>
            <span style={{ cursor: 'pointer' }}
              onClick={() => {
                const modes = ['chat','agent','worker','developer','group'] as const
                const i = modes.indexOf(mode)
                const next = modes[(i+1) % modes.length]
                setMode(next)
                window.luminaAPI?.agentSetMode(next)
              }}>
              切换模式
            </span>
          </div>
        </div>

        <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }`}</style>

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
      </> )}
      </div>
    </div>
  )
}
