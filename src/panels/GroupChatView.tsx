// ============================================================
// GroupChatView.tsx — 团队群聊视图 (v2.11)
// Extracted from ChatPanel.tsx (was 1500+ lines inline)
// ============================================================

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useStore } from '../stores/appStore'
import { IconPlus } from '../components/Icons'
import AgentTaskBoard from '../components/AgentTaskBoard'
import AgentMoments from '../components/AgentMoments'
import NoteCycle, { LuminaDailyReport, TeamMilestones, YakTechNotes } from '../components/NoteCycle'
import CharacterCustomization from '../components/CharacterCustomization'
import MemoryTheater from '../components/MemoryTheater'
import { DEFAULT_PERSONAS, getPersona, getPersonaPrompt } from '../data/personas'
import { sttService, type STTStatus } from '../services/sttService'
import { ttsEngine } from '../services/ttsEngine'
import { proactiveChat } from '../services/proactiveChat'
import { updateEmotion, emotionContext } from '../services/agentEmotion'
import AgentEmotionBar, { injectEmotionStyles } from '../components/AgentEmotionBar'
import { addBookmark } from '../services/messageBookmarks'
import { showToast } from '../components/Toast'
import TeamPanel from './TeamPanel'  // 🆕 团队面板整合
import { buildAgentPromptLite } from '../data/agentSouls'
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
  getToolNotification,
  getGCToolsPrompt,
  getDisabledTools,
  DEFAULT_TEAM_SECURITY,
  type TeamSecurityConfig,
} from '../services/gcSafeTools'
import {
  TTS_VOICES, AGENT_VOICES, AUTONOMY_INTERVAL,
  AGENTS, TEAM_CONV_ID, EMOJI_GROUPS,
  type GCMsg, type GCSession, type AgentTask, type AgentPost, type LLMPanelState, type ThinkingStep,
  loadGCSessions, saveGCSessions, loadGCMessages, saveGCMessages, newGCSessionId,
  loadLLMData, saveLLMData, loadAgentVoices, saveAgentVoices,
  setLLMRefreshFn, _llmState, _llmNotify, _startAutonomyTimer, _stopAutonomyTimer, _startAutonomyWithRemaining, _autonomyTimer,
  useLLMPanels,
  cleanTtsText, formatTime, insertAtCursor, getAgentSystemPrompt, getAgentSystemPromptLite,
} from '../chat/chatShared'

/** P0.4: 团队群聊 agentChat 硬截止 + 兜底 */
const GC_CHAT_HARD_MS = 300_000

async function agentChatWithTimeout(args: any): Promise<{ content: string; error?: string }> {
  const deadline = Date.now() + GC_CHAT_HARD_MS
  try {
    const p = new Promise<any>((resolve, reject) => {
      const t = setInterval(() => {
        if (Date.now() > deadline) {
          clearInterval(t)
          reject(new Error('群聊回复超时（300秒），请缩短输入或稍后重试。'))
        }
      }, 1_000)
      ;(window as any).luminaAPI.agentChat(args).then((r: any) => {
        clearInterval(t)
        resolve(r)
      }).catch((e: any) => {
        clearInterval(t)
        reject(e)
      })
    })

    // 长上下文下 LLM 推理可能超过 60s
    //   从 60s 提升到 180s，与后端 socialMode 300s 超时对齐
    const result = await Promise.race([
      p,
      new Promise<any>((_, reject) =>
        setTimeout(() => reject(new Error('已中断（300秒无响应）')), 300_000)
      ),
    ])

    return {
      content: (result?.content || '').trim(),
      ...(result?.error ? { error: String(result.error) } : {}),
    }
  } catch (e: any) {
    return {
      content: '（回复生成失败或耗时过长，已自动中断。请稍微简化问题重试。）',
      error: e?.message || String(e),
    }
  }
}

// ═══════════════════════════════════════════════════════════
// Per-Agent 上下文隔离构建器 (v1.0)
//   替代原来的统一 historyForLLM，让每个 Agent 只看到"自己的 + 用户的 + 精简的其他人"
// ═══════════════════════════════════════════════════════════

/**
 * 按 Agent 隔离构建团队群聊的 LLM 上下文。
 *
 * 核心规则：
 * - 用户消息 → 完整保留（2000 字符上限）
 * - 目标 Agent 自己的消息 → 完整保留（2000 字符上限）
 * - 其他 Agent 的消息 → 压缩为 [名字] 摘要（350 字符上限，最近 5 条）
 * - 系统消息 → 按 skipSystem 选项决定
 * - 协作摘要（runningHistory）→ 追加到最后（仅主回复使用）
 */
function buildHistoryForAgent(
  allMessages: GCMsg[],
  targetAgentId: string,
  contextWindow: number,
  runningHistory: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  options?: { skipSystem?: boolean },
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const MAX_HISTORY_TOKENS = Math.floor((contextWindow || 262144) * 0.55)
  const PER_MSG_OVERHEAD = 8
  const MAX_OTHER_MSGS = 5       // 其他 Agent 最多保留条数
  const MAX_OWN_CHARS = 2000     // 自己/用户/系统消息上限
  const MAX_OTHER_CHARS = 350    // 其他 Agent 压缩上限

  // 预计算 Agent ID 集合
  const AGENT_IDS = new Set(AGENTS.map(a => a.id))

  const result: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = []
  let tokenEst = 0
  let otherCount = 0
  const skipSystem = options?.skipSystem === true

  // 从最新消息往前遍历（保留时间顺序）
  for (let i = allMessages.length - 1; i >= 0; i--) {
    const m = allMessages[i]
    const isUser = m.from === 'user'
    const isSystem = m.from === 'system'
    const isTarget = m.from === targetAgentId
    const isOther = (AGENT_IDS as Set<string>).has(m.from) && !isTarget

    // 跳过无关消息（非 Agent / 非用户 / 非系统）
    if (!isUser && !isSystem && !isTarget && !isOther) continue

    // 系统消息处理
    if (isSystem) {
      if (skipSystem) continue
      if ((m.content || '').trim().length <= 5) continue
    }

    // 其他 Agent 限数
    if (isOther) {
      if (otherCount >= MAX_OTHER_MSGS) continue
      otherCount++
    }

    // 构建 role 和 content
    let role: 'system' | 'user' | 'assistant'
    let text: string

    if (isSystem) {
      role = 'system'
      text = (m.content || '').slice(0, MAX_OWN_CHARS)
    } else if (isUser) {
      role = 'user'
      text = (m.content || '').slice(0, MAX_OWN_CHARS)
      // 附件描述（沿用原 historyForLLM 的处理）
      if (m.attachments && m.attachments.length > 0) {
        const descs = m.attachments.map((a, i) => {
          const sizeStr = a.size > 1024 * 1024
            ? `${(a.size / (1024 * 1024)).toFixed(1)}MB`
            : `${(a.size / 1024).toFixed(1)}KB`
          return `[附件${i + 1}: ${a.name} (${sizeStr})]`
        }).join('\n')
        text = text + '\n\n--- 上传文件 ---\n' + descs
      }
    } else if (isTarget) {
      role = 'assistant'
      text = (m.content || '').slice(0, MAX_OWN_CHARS)
    } else {
      // 其他 Agent → 压缩为一行摘要
      role = 'assistant'
      const agentName = m.from === 'recha' ? '热茶' : m.from === 'yak' ? 'Yak' : m.from
      // 去掉 thinking 和 tool_call 标签，只保留纯文本
      const raw = (m.content || '')
        .replace(/<thinking>[\s\S]*?<\/thinking>/g, '')
        .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
        .trim()
        .slice(0, MAX_OTHER_CHARS)
      text = `[${agentName}]: ${raw}`
    }

    const est = Math.ceil(text.length / 4) + PER_MSG_OVERHEAD
    if (tokenEst + est > MAX_HISTORY_TOKENS && result.length > 0) break
    tokenEst += est
    result.unshift({ role, content: text })
  }

  // 追加协作摘要（runningHistory）— 仅主回复使用
  if (runningHistory && runningHistory.length > 0) {
    if (tokenEst + 8 <= MAX_HISTORY_TOKENS) {
      tokenEst += 8
      result.push({ role: 'user' as const, content: '[--- 以下为团队协作阶段的结构化摘要 ---]' })
    }
    for (const entry of runningHistory) {
      const clipped = (entry.content || '').slice(0, 3000)
      const est = Math.ceil(clipped.length / 4) + PER_MSG_OVERHEAD
      if (tokenEst + est > MAX_HISTORY_TOKENS) break
      tokenEst += est
      result.push({ role: entry.role, content: clipped })
    }
  }

  if (result.length === 0) {
    result.push({ role: 'user', content: '(对话开始)' })
  }

  return result
}

// ═══════════════════════════════════════════════════════════
// 团队群聊视图
// ═══════════════════════════════════════════════════════════

/**
 * 🆕 v10.1: 剥离 LLM 回复开头的"自言自语"推理文本
 * 
 * 某些 LLM 在回复时会先输出推理过程再给出正式回答，例如：
 *   "用户问我是谁。我应该直接回答这个问题，介绍自己。根据系统提示...
 *    让我友好地回答这个问题。\n\n你好！我是..."
 * 
 * 本函数检测这类模式并剥离，只保留正式回答。
 */
/** 🔧 v10.5: 剥离 LLM 回复开头的推理/分析文本 — 通用强化版 */
function stripReasoningPrefix(text: string): string {
  // 推理检测模式组 — 覆盖各种语言模型"自言自语"的常见开头
  const patterns = [
    // ============ 具体模式 ============
    // ① 用户行为分析: "用户又发/发了/发了个/收到/看到/说/讲了..."
    /^用户[又收发看说讲发问][^。]*?。[\s\S]*?(?:\n\n|$)/s,
    // ② "我[需要/应该/要][保持/注意/用/按照/作为]..."
    /^我[需要应该要][^。]*?(?:保持|注意|用|按照|作为|确保|让|给)[^。]*?。[\s\S]*?(?:\n\n|$)/s,
    // ③ "这是一个...场景/群聊/对话"
    /^这是[一一个][^。]*?(?:群聊|对话|场景|情况|通知|[^。]{2,})?。[\s\S]*?(?:需要|应该|作为|根据|所以|因此).*?。\s*/s,
    // ④ "作为[角色名]...我[需要/应该]..."
    /^作为[^。]*?(?:Lumina|猫娘|AI|助手|agent|Agent|热茶|Yak)[^。]*?[，,]\s*我[^。]*?(?:需要|要|应该|得).*?。\s*/s,
    // ⑤ "根据[设定/规则/系统提示/角色/铁则/原则]...（含编号列举）"
    /^根据.*?(?:设定|规则|系统提示|角色|身份|性格|铁则|原则|要求|规定|协议).*?(?:[：:]\s*\n|[\s\S]*?。)[\s\S]*?(?:但|不过|然而|所以|因此|从|用户|我).*?。\s*/s,
    // ⑥ "用户[问说让要我收发看]...让我来回答..."
    /^用户[问说让要我收发看][^。]*。[\s\S]*?(?:我[应该需要要]|让[我我来]|我来)[^。]*?(?:回答|回复|介绍|说明).*?。\s*/s,
    // ⑦ "让我[想想/看看/来]...分析/决定/判断..."
    /^(?:让我|我来)[^。]*?(?:想想|看看|分析|决定|判断|考虑|计划|梳理)[^。]*?。[\s\S]*?(?:\n\n|$)/s,
    // ⑧ "看起来/看来/显然/很明显..." → 推理句式
    /^(?:看起来|看来|显然|很明显|这显然|这明显)[^。]*?。[\s\S]*?(?:所以我|因此|我建议|我决定|让我).*?。\s*/s,
    // ============ 新增通用模式 ============
    // ⑨ "等等/等一下/嗯/唔...让我[想想/分析/理解/重新]" → 犹豫+推理
    /^(?:等等|等一下|嗯[，,。]|唔[，,。]|让我想想|让我分析|让我理解|让我重新).*?[\s\S]*?(?:\n\n|$)/s,
    // ⑩ "这里有点奇怪/这里的情况是比较/这似乎/这看起来像是" → 场景分析
    /^(?:这里|这似乎|这看起来|这个情况|这种情况|这种场景).*?[。，][\s\S]*?(?:用户|我|热茶|Lumina|Yak).*?[\s\S]*?(?:需要|应该|可以|可能|觉得|认为|是).*?。\s*/s,
    // ⑪ "用户[在/正在/刚才/刚刚][说/描述/告诉/提到/发了/问了]" → 场景复述
    /^用户[在正在刚才刚刚][说描述告诉提到发了问了][^。]*。[\s\S]*?(?:所以|因此|我|让我).*?。\s*/s,
    // ⑫ "从上下文看/根据上下文/从用户的话/从这个角度" → 分析开场
    /^(?:从(?:上下文|用户的话|这个角度|整体)|根据(?:上下文|对话|场景)).*?[，,][\s\S]*?(?:用户|我|可能|应该是|所以).*?。\s*/s,
    // ⑬ "热茶（就是我自己）/Yak（我）/作为热茶的我" → 自我指涉推理
    /^[^。]*?(?:热茶|Yak|Lumina)[（(](?:就是|即|这个)[）)].*?[\s\S]*?(?:需要|应该|可以|可能|觉得|认为|要).*?。\s*/s,
    // ⑭ 通用思维链: "我觉得最可能的是/我认为/我想/我猜/可能是指" + 分析句
    /^(?:我觉得|我认为|我想|我猜|可能[是指是]).*?[\s\S]*?(?:因为|所以|因此|但是|不过|然而).*?[\s\S]*?(?:\n\n|。\s*।$)/s,
    // ⑮ "等一下/让我重新[理解/梳理/分析/想想]" 
    /^(?:等一下|让我重新|我需要重新).*?[理解梳理分析想想].*?[\s\S]*?(?:\n\n|$)/s,
    // ⑯ 选项枚举: "可能的遗漏点/可能的情况/可能的解释" → 123 列举
    /^[^。]{2,30}?[：:]\s*[\s\S]*?(?:\n\d[.、。]\s|或者|或是|要么).*?\n.*?(?:\n\n|$)/s,
    // ⑰ "不管怎样/无论如何/核心是/总之" → 推理结论
    /^(?:不管怎样|无论如何|核心是|总之|总结一下|说到底).*?。[\s\S]*?(?:\n\n|$)/s,
  ]

  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match && match[0]) {
      const remaining = text.slice(match[0].length).trim()
      if (remaining.length >= 3) return remaining
    }
  }

  return text
}

/**
 * 🆕 v10.5: 清洗 <thinking> 标签内的思考文本，去掉角色自述/身份复述
 * 
 * LLM 在思考时喜欢先背一遍"我是谁、我的性格是什么"，这些内容对用户
 * 是噪音。本函数从 thinking 文本中过滤掉这些句子。
 */
function cleanThinkingText(text: string): string {
  const cleanPatterns = [
    // ① "我是/我是谁/我是Lumina/热茶/Yak..."
    /^我是[^。，、\n]{0,30}[。，、]?\s*/,
    // ② "作为[身份]..." 
    /^作为[^。，、\n]{0,30}[。，、]?\s*/,
    // ③ "根据[我的/我的设定/我的性格/我的角色/规则/铁则]..."
    /^根据[^。，、\n]{0,40}[。，、]?\s*/,
    // ④ "我的[性格/风格/角色/身份/设定/名字/规则]是..."
    /^我的[^。，、\n]{0,10}是[^。，、\n]{0,40}[。，、]?\s*/,
    // ⑤ "用户叫我/用户说我是/主人说我是..."
    /^用户[^。，、\n]{0,10}我[^。，、\n]{0,30}[。，、]?\s*/,
    // ⑥ "Lumina[性格/风格/是]..." / "热茶/Yak 是..."
    /^(?:Lumina|热茶|Yak)\s*[^。，、\n]{0,40}[。，、]?\s*/,
    // ⑦ "首先/第一/让我先" → 计划性开头
    /^(?:首先|第一步|让我先|先让)[^。，、\n]{0,40}[。，、]?\s*/,
    // ⑧ "嗯/唔/好/好的/ok/OK/哦" → 语气填充词开头
    /^(?:嗯[，,。]?|唔[，,。]?|好[的，,。]?|ok[，,。]?|OK[，,。]?|哦[，,。]?)\s*/,
  ]
  
  let cleaned = text.trim()
  for (const pattern of cleanPatterns) {
    // 循环清除每行/每句开头的匹配
    let prev: string
    do {
      prev = cleaned
      cleaned = cleaned.replace(pattern, '').trim()
    } while (cleaned !== prev && cleaned.length > 0)
  }
  
  // 如果清理后为空或只剩标点，返回原文本的简短摘要
  if (cleaned.length < 3) return text.slice(0, 100)
  return cleaned
}

/**
 * 🆕 v10.7: 去重 — LLM 有时会输出重复内容（同一回复输出两遍、或 thinking 标签外出现两版）
 * 检测策略：按段落取签名（首个有意义段落 >10 字），若后半段再次出现则截断。
 * 适用于主回复 / 链式火花 / 决策讨论三条路径。
 */
function deduplicateLLMContent(text: string): string {
  if (text.length < 200) return text
  const paragraphs = text.split('\n\n').filter(p => p.trim().length >= 10)
  if (paragraphs.length < 2) return text
  for (const para of paragraphs) {
    const sig = para.trim().slice(0, 40)
    if (sig.length < 10) continue
    const firstPos = text.indexOf(sig)
    const lastPos = text.lastIndexOf(sig)
    if (lastPos > firstPos && lastPos > text.length * 0.35) {
      const before = text.slice(0, lastPos).trim()
      if (before.length > 100) return before
    }
  }
  return text
}

export default function GroupChatView() {
  const llmConfig = useStore(s => s.llmConfig)
  const activePanel = useStore(s => s.activePanel)
  const ttsMuted = useStore(s => s.ttsMuted)
  const addTokenUsage = useStore(s => s.addTokenUsage)  // 🔧 v2.17: 团队聊天 token 追踪
  const ttsToggle = useStore(s => s.ttsToggle)
  const profile = useStore(s => s.profile)   // v2.14: 气泡颜色

  // LLM 配置检?
  const llmReady = !!(llmConfig.model && llmConfig.apiKey)
  const isCloudAPI = llmConfig.apiKey?.startsWith('sk-') || llmConfig.baseUrl?.includes('api.openai.com') || llmConfig.baseUrl?.includes('api.moonshot') || llmConfig.baseUrl?.includes('api.deepseek')
  const isLocalLLM = llmConfig.baseUrl?.includes('localhost') || llmConfig.baseUrl?.includes('127.0.0.1') || llmConfig.baseUrl?.includes('ollama')

  // 🆕 历史会话
  const [sessions, setSessions] = useState<GCSession[]>(() => loadGCSessions())
  const [activeSessionId, setActiveSessionId] = useState(() => {
    const ss = loadGCSessions()
    return ss.length > 0 ? ss[0].id : newGCSessionId()
  })

  // 🆕 对话连续：记住上一轮谁回复
  const [lastAgent, setLastAgent] = useState<string | null>(null)

  const [messages, setMessages] = useState<GCMsg[]>(() => {
    const loaded = loadGCMessages(activeSessionId)
    if (loaded.length > 0) {
      // 从持久化消息推断 lastAgent
      const lastAgentMsg = [...loaded].reverse().find(m => AGENTS.some(a => a.id === m.from))
      if (lastAgentMsg) {
        setTimeout(() => setLastAgent(lastAgentMsg.from), 0)
      }
      return loaded
    }
    return [
      { id: '0', from: 'system', fromIcon: '🤖', fromName: '系统',
        content: llmReady
          ? `👋 欢迎来到团队群聊！你 + Lumina🐱 + 热茶🍵 + Yak📊 都在这里。\n\n💡 直接发消息，Lumina 会帮你叫合适的队友回复\n💡 @某人：输入 @Lumina / @热茶 / @Yak 指定回复者`
          : `👋 欢迎来到团队群聊！你 + Lumina🐱 + 热茶🍵 + Yak📊 都在这里。\n\n⚠️ 未配置 LLM，当前为模拟回复模式。请在设置中配置 API Key 解锁真实 AI 对话。`,
        time: new Date().toLocaleTimeString('zh-CN') },
    ]
  })
  const [input, setInput] = useState('')
  // 🛠️ v8.1: 输入框 key，当从其他面板回到聊天时重新挂载 textarea
  // 修复 Electron display:none→flex 后 <textarea> 可能无法点击的问题
  const [inputKey, setInputKey] = useState(0)
  const prevPanelRef = useRef(activePanel)
  const [sending, setSending] = useState(false)
  const [thinkingMode, setThinkingMode] = useState(true) // 🔧 v10.2: 🧠 思考过程开关，默认开启
  const [replyingAgent, setReplyingAgent] = useState<string | null>(null)
  const [prevReplyingAgent, setPrevReplyingAgent] = useState<string | null>(null)  // 🆕 v5.4: 接力过渡
  const [agentSwitchClass, setAgentSwitchClass] = useState('')  // 🆕 v5.4: 切换动画 CSS class
  const [showDecision, setShowDecision] = useState(false)
  const [showTeamMembers, setShowTeamMembers] = useState(false)  // 🔥 v2.7.1: 团队成员面板
  const [showAcpPanel, setShowAcpPanel] = useState(false)  // 🆕 ACP 添加成员面板
  // 🆕 ACP 添加成员表单
  const [acpFormData, setAcpFormData] = useState({
    id: '', name: '', icon: '🌐', description: '',
    url: '', apiKey: '', model: '', systemPrompt: '',
    temperature: 0.7, maxTokens: 4096,
    capabilities: '', triggers: '',
  })
  const [acpMembers, setAcpMembers] = useState<any[]>([])
  const loadAcpMembers = async () => {
    try {
      const api = (window as any).luminaAPI
      const acpResult = await api.acpList?.()
      if (acpResult?.ok) setAcpMembers(acpResult.dynamic || [])
    } catch {}
  }
  const handleRegisterAcp = async () => {
    if (!acpFormData.name || !acpFormData.url) return
    const api = (window as any).luminaAPI
    const result = await api.acpRegister?.({
      ...acpFormData,
      id: acpFormData.id || `acp_${Date.now()}`,
      capabilities: acpFormData.capabilities.split(',').map(s => s.trim()).filter(Boolean),
      triggers: acpFormData.triggers.split(',').map(s => s.trim()).filter(Boolean),
    })
    if (result?.ok) {
      setShowAcpPanel(false)
      setAcpFormData({ id: '', name: '', icon: '🌐', description: '', url: '', apiKey: '', model: '', systemPrompt: '', temperature: 0.7, maxTokens: 4096, capabilities: '', triggers: '' })
      await loadAcpMembers()
    } else {
      alert(result?.error || '注册失败')
    }
  }
  const handleRemoveAcp = async (id: string) => {
    const api = (window as any).luminaAPI
    const result = await api.acpUnregister?.(id)
    if (result?.ok) await loadAcpMembers()
    else alert(result?.error || '移除失败')
  }
  // 首次加载 ACP 成员
  useEffect(() => { loadAcpMembers() }, [])
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null)  // 🔥 v2.8.1: 展开详细资料
  const [teamTab, setTeamTab] = useState<'chat' | 'tasks' | 'moments' | 'theater' | 'daily' | 'milestone' | 'yak'>('chat')
  const teamTabs = [
    { key: 'chat' as const, label: '群聊', icon: '💬' },
    { key: 'tasks' as const, label: '任务', icon: '📋' },
    { key: 'moments' as const, label: '朋友圈', icon: '🌸' },
    { key: 'theater' as const, label: '剧场', icon: '🎬' },
    { key: 'daily' as const, label: '日报', icon: '🌅' },
    { key: 'milestone' as const, label: '纪念日', icon: '💝' },
    { key: 'yak' as const, label: 'Yak 笔记', icon: '📘' },
  ]
  const [decQuestion, setDecQuestion] = useState('')
  const [decContext, setDecContext] = useState('')
  const [decLoading, setDecLoading] = useState(false)
  // LLM面板控制 — 必须用 useLLMPanels() 才能响应状态变化
  const llmPanelState = useLLMPanels()
  const llmEnabled = llmPanelState.enabled
  const setLLMEnabled = (v: boolean) => { _llmState.enabled = v; _llmNotify() }
  const [llmRefreshing, setLLMRefreshing] = useState(false)
  const [llmError, setLLMError] = useState<string | null>(null)
  // 团队安全配置（用户可自定义）
  const [teamSecurity, setTeamSecurity] = useState<TeamSecurityConfig>(DEFAULT_TEAM_SECURITY)
  const teamDisabledTools = useMemo(() => getDisabledTools(teamSecurity), [teamSecurity])
  const teamToolsPrompt = useMemo(() => getGCToolsPrompt(teamSecurity), [teamSecurity])
  // 🆕 动画计数 + emoji
  const [msgCounter, setMsgCounter] = useState(0)
  const [showEmoji, setShowEmoji] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const isUserAtBottomRef = useRef(true)  // 🆕 v5.3: 用户是否在底部，控制是否自动滚底
  const gcTextareaRef = useRef<HTMLTextAreaElement>(null)
  const gcDragCounter = useRef(0)
  const [gcDragOver, setGcDragOver] = useState(false)
  const [gcDragFiles, setGcDragFiles] = useState<Array<{name:string,size:number,type:string}>>([])

  const answerHandlerRef = useRef<((ev: any, msgId?: string) => void) | null>(null)

  // 思考过程自动回收 — 收到最终答案后，自动把对应消息下的思考过程收起来
  const collapseCurrentThinking = useCallback((msgId: string) => {
    setThinkingCollapsed(prev => ({ ...prev, [msgId]: true }))
  }, [])

  const toggleThinking = useCallback((msgId: string) => {
    setThinkingCollapsed(prev => ({ ...prev, [msgId]: !prev[msgId] }))
  }, [])

  // 每个流独立的 Agent 事件监听器 — 彻底防止多 Agent 思考步骤串台
  //   之前使用单一共享 ref → IPC 事件队列中旧流事件可能泄漏到新流
  //   现在改为每流独立 onAgentEvent → 每个流的 IPC 监听器在流结束后被移除
  const subscribeAgentEvents = useCallback((cb: (ev: any) => void) => {
    return window.luminaAPI.onAgentEvent(cb)
  }, [])

  // fix: 使用 useRef 替代普通 let 变量，彻底解决协作阶段思考步骤串台
  //   问题：collabCurrentMsgId 是闭包中的 let 变量，IPC 事件异步触发时
  //   旧阶段的回调可能拿到新阶段的 msgId → 思考内容写错消息
  //   解决：useRef 保证所有闭包始终读取最新值
  const collabCurrentMsgIdRef = useRef('')
  const collabPhaseRef = useRef(0)  // 协作阶段计数器，事件回调只处理当前阶段
  /** 🆕 v16.0-fix: runningHistory 持久引用 — 协作阶段构建，供主回复阶段合并 */
  const runningHistoryRef = useRef<Array<{ role: 'system' | 'user' | 'assistant'; content: string }>>([])

  // 🍀 v1.0: Lucky 模式
  const luckyMode = useLuckyMode()

  // ═══ v2.14: TTS 排队播放 ═══
  const ttsQueueRef = useRef<Array<{text:string; voice:string}>>([])
  const [ttsQueueLen, setTtsQueueLen] = useState(0)
  const [ttsPlaying, setTtsPlaying] = useState(false)
  const enqueueTTS = useCallback((text: string, voice: string) => {
    ttsQueueRef.current.push({ text, voice })
    setTtsQueueLen(ttsQueueRef.current.length)
    if (ttsQueueRef.current.length === 1) {
      playNextTTS()
    }
  }, [])
  const playNextTTS = useCallback(() => {
    const item = ttsQueueRef.current[0]
    if (!item) { setTtsPlaying(false); setTtsQueueLen(0); return }
    setTtsPlaying(true)
    try {
      ttsEngine.speak({ text: item.text, voice: item.voice })
      // 等 TTS 播完（粗略估算：中文 ~4字/秒）
      const estimatedMs = Math.max(2000, item.text.length * 250)
      setTimeout(() => {
        ttsQueueRef.current.shift()
        setTtsQueueLen(ttsQueueRef.current.length)
        if (ttsQueueRef.current.length > 0) {
          playNextTTS()
        } else {
          setTtsPlaying(false)
        }
      }, estimatedMs)
    } catch {
      ttsQueueRef.current.shift()
      setTtsQueueLen(ttsQueueRef.current.length)
      playNextTTS()
    }
  }, [])
  const stopAllTTS = useCallback(() => {
    ttsEngine.stop()
    ttsQueueRef.current = []
    setTtsQueueLen(0)
    setTtsPlaying(false)
  }, [])

  // ═══ v2.14: 消息内联按钮 ═══
  const [hoveredMsgId, setHoveredMsgId] = useState<string | null>(null)
  const [deletingTarget, setDeletingTarget] = useState<GCMsg | null>(null)
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null)

  // ═══ 群聊输入框自动撑高 ═══
  const gcAutoResize = useCallback(() => {
    const el = gcTextareaRef.current
    if (el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px' }
  }, [])

  // ═══ v2.7 群聊同步升级 ═══
  const [sttListening, setSttListening] = useState(false)
  const [sttStatus, setSttStatus] = useState<STTStatus | null>(null)
  // 🧰 v1.0 工具箱: 实时语音 & Computer Use 状态
  const [realtimeVoiceActive, setRealtimeVoiceActive] = useState(false)
  const [computerUseActive, setComputerUseActive] = useState(false)
  const abortRef = useRef(false)
  const soloTurnCount = useRef(0)       // v2.8.2: 连续单 Agent 轮数
  const [toolNotice, setToolNotice] = useState<string | null>(null)  // v2.8.3: 工具通知
  const toolNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 每个Agent独立音色（从localStorage恢复）
  const [agentVoices, setAgentVoices] = useState<Record<string, string>>(() => loadAgentVoices())
  const ttsConfig = useStore(s => s.ttsConfig)  // 🔧 v2.8.x: 从聊天模式同步TTS音色
  const setTTSConfig = useStore(s => s.setTTSConfig)
  
  /** 🔧 v2.8.x: 获取有效音色 — 优先群聊自定义 → 聊天模式设置 → 默认 */
  const getEffectiveVoice = useCallback((agentId: string): string => {
    return agentVoices[agentId] || ttsConfig.voice || AGENT_VOICES[agentId]
  }, [agentVoices, ttsConfig.voice])
  const [showTtsMenu, setShowTtsMenu] = useState(false)
  const [showGcVoicePicker, setShowGcVoicePicker] = useState(false) // 🔧 v2.9: 群聊TTS音色面板
  const [gcVoiceTarget, setGcVoiceTarget] = useState<string | null>(null) // 🔧 v2.9: 当前调整的Agent
  const [ttsToggling, setTtsToggling] = useState(false) // 🔧 v2.9: 静音切换动画
  const [gcAttachments, setGcAttachments] = useState<Array<{name:string,size:number,text?:string}>>([])
  const [expandedThinking, setExpandedThinking] = useState<Set<string>>(new Set())
  const [thinkingCollapsed, setThinkingCollapsed] = useState<Record<string, boolean>>({})
  const userExpandedRef = useRef<Set<string>>(new Set())
  const autoCollapsedThinkingRef = useRef<Set<string>>(new Set())
  const fileInputRef = useRef<HTMLInputElement>(null)
  // ════════════════════════════════

  // 监听会话切换事件，重置回复状态防止混淆
  useEffect(() => {
    const handleLoad = (e: Event) => {
      const sessionId = (e as CustomEvent).detail as string
      setActiveSessionId(sessionId)
      setReplyingAgent(null)
      setMessages(loadGCMessages(sessionId))
    }
    const handleNew = (e: Event) => {
      const sessionId = (e as CustomEvent).detail as string
      setActiveSessionId(sessionId)
      setReplyingAgent(null)
      setMessages([])
    }
    window.addEventListener('gc:load-session', handleLoad)
    window.addEventListener('gc:new-session', handleNew)
    return () => {
      window.removeEventListener('gc:load-session', handleLoad)
      window.removeEventListener('gc:new-session', handleNew)
    }
  }, [])

  // activeSessionId 变化时重置回复状态
  useEffect(() => {
    setReplyingAgent(null)
  }, [activeSessionId])

  // 🛠️ v8.1: 从其他面板回到聊天时，重新挂载 <textarea> 修复 Electron 焦点问题
  useEffect(() => {
    if (prevPanelRef.current !== 'chat' && activePanel === 'chat') {
      setInputKey(k => k + 1)
    }
    prevPanelRef.current = activePanel
  }, [activePanel])

  // Agent 接力过渡动画 — 平滑 Agent 间切换
  //   当 replyingAgent 从一个变成另一个时：
  //   1. 保留旧 agent 的 typing dots 250ms（避免突兀消失）
  //   2. 新 agent 的头像/名称触发脉冲动画
  //   3. 消息气泡平滑过渡
  useEffect(() => {
    if (replyingAgent && replyingAgent !== prevReplyingAgent) {
      setPrevReplyingAgent(replyingAgent)
      setAgentSwitchClass('agent-switch-pulse')
      const t = setTimeout(() => setAgentSwitchClass(''), 350)
      return () => clearTimeout(t)
    } else if (!replyingAgent) {
      setPrevReplyingAgent(null)
    }
  }, [replyingAgent, prevReplyingAgent])

  // 强制保存（绕过动画守卫）
  const forceSave = useCallback(() => {
    saveGCMessages(activeSessionId, messages)
    const preview = messages.filter(m => m.from === 'user').slice(-1)[0]?.content?.slice(0, 30) || ''
    const updated: GCSession[] = [
      { id: activeSessionId, date: new Date().toLocaleDateString('zh-CN'),
        preview, count: messages.length },
      ...sessions.filter(s => s.id !== activeSessionId),
    ]
    setSessions(updated)
    saveGCSessions(updated)
    window.dispatchEvent(new Event('gc:sessions-updated'))
  }, [activeSessionId, messages, sessions])

  // 🆕 持久化 — v3.6: 只要有消息在动画中就不保存，让 animateTyping 完成时存
  useEffect(() => {
    if (messages.length <= 1) return
    // v3.6: 只要有一条消息还在动画中 → 不保存 → 防止空内容覆盖
    const hasAnimating = messages.some(m => m.from !== 'system' && !m.content && !(m as any)._animDone)
    if (hasAnimating) return
    saveGCMessages(activeSessionId, messages)
    const preview = messages.filter(m => m.from === 'user').slice(-1)[0]?.content?.slice(0, 30) || ''
    const updated: GCSession[] = [
      { id: activeSessionId, date: new Date().toLocaleDateString('zh-CN'),
        preview, count: messages.length },
      ...sessions.filter(s => s.id !== activeSessionId),
    ]
    setSessions(updated)
    saveGCSessions(updated)
    window.dispatchEvent(new Event('gc:sessions-updated'))
  }, [messages.length, msgCounter, activeSessionId])

  useEffect(() => {
    // 只在用户处于底部时自动滚底，允许用户自由翻阅历史
    if (isUserAtBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, replyingAgent, msgCounter])

  // 跟踪用户是否在底部，防止强制滚底打断翻阅
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) return
    // 距底部 < 80px 视为"在底部"
    isUserAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }, [])

  // 新消息到达时，如果用户之前在底部，强制滚底（新对话）
  useEffect(() => {
    if (messages.length <= 2) {
      // 对话刚开始，强制滚底
      isUserAtBottomRef.current = true
      bottomRef.current?.scrollIntoView({ behavior: 'auto' })
    }
  }, [messages.length])

  // → v8.1: 思考过程在 Agent 输出时自动展开，输出完毕后默认收起（可手动展开）
  useEffect(() => {
    // 遍历所有消息，有思考步骤且未展开的 → 自动展开
    let changed = false
    setExpandedThinking(prev => {
      const next = new Set(prev)
      for (const m of messages) {
        if (!m.thinkingSteps || m.thinkingSteps.length === 0) continue
        // v8.1: 已完成的消息不自动展开（默认收起），仅正在输出的消息展开
        const isComplete = Boolean(m._animDone)
        if (isComplete) continue
        if (!next.has(m.id)) {
          next.add(m.id)
          changed = true
        }
      }
      return changed ? next : prev  // 无变化则不触发重渲染
    })
  }, [messages])
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const activeSessionRef = useRef(activeSessionId)
  activeSessionRef.current = activeSessionId

  // 思考过程自动收合逻辑已迁移到 animateTyping 完成时统一处理

  // 🆕 监听侧边栏加载/新建会话事件
  useEffect(() => {
    const onLoad = (e: Event) => {
      const newSessionId = (e as CustomEvent).detail as string
      const curId = activeSessionRef.current
      // 先存当前会话！避免切换时数据丢失
      if (curId && messagesRef.current.length > 1) {
        saveGCMessages(curId, messagesRef.current)
      }
      const msgs = loadGCMessages(newSessionId)
      setActiveSessionId(newSessionId)
      if (msgs.length > 0) {
        setMessages(msgs)
        const lastAgentMsg = [...msgs].reverse().find(m => AGENTS.some(a => a.id === m.from))
        if (lastAgentMsg) setLastAgent(lastAgentMsg.from)
        else setLastAgent(null)
      } else {
        // 空会话也显示欢迎消息，防止旧消息残留
        setMessages([{
          id: '0', from: 'system', fromIcon: '🤖', fromName: '系统',
          content: llmReady
            ? `👋 新的团队群聊！你 + Lumina🐱 + 热茶🍵 + Yak📊 都在这里。\n\n💡 直接发消息，Lumina 会帮你叫合适的队友回复\n💡 @某人：输入 @Lumina / @热茶 / @Yak 指定回复者`
            : `👋 新的团队群聊！\n\n⚠️ 未配置 LLM，当前为模拟回复模式。`,
          time: new Date().toLocaleTimeString('zh-CN'),
        }])
        setLastAgent(null)
      }
      // 🆕 同步 sessions：避免侧边栏删除/新建后 GroupChatView 的旧状态覆写 localStorage
      setSessions(loadGCSessions())
    }
    const onNew = (e: Event) => {
      const newSessionId = (e as CustomEvent).detail as string
      const curId = activeSessionRef.current
      // 先存当前会话！
      if (curId && messagesRef.current.length > 1) {
        saveGCMessages(curId, messagesRef.current)
      }
      setActiveSessionId(newSessionId)
      setMessages([{
        id: '0', from: 'system', fromIcon: '🤖', fromName: '系统',
        content: llmReady
          ? `👋 新的团队群聊！你 + Lumina🐱 + 热茶🍵 + Yak📊 都在这里。\n\n💡 直接发消息，Lumina 会帮你叫合适的队友回复\n💡 @某人：输入 @Lumina / @热茶 / @Yak 指定回复者`
          : `👋 新的团队群聊！\n\n⚠️ 未配置 LLM，当前为模拟回复模式。`,
        time: new Date().toLocaleTimeString('zh-CN'),
      }])
      setLastAgent(null)
      setSessions(loadGCSessions())
    }
    window.addEventListener('gc:load-session', onLoad)
    window.addEventListener('gc:new-session', onNew)
    return () => {
      window.removeEventListener('gc:load-session', onLoad)
      window.removeEventListener('gc:new-session', onNew)
    }
  }, [llmReady])

  // 注入情绪条 CSS 动画
  useEffect(() => { injectEmotionStyles() }, [])

  // 🧰 v1.0: 工具箱状态轮询（实时语音 + Computer Use 状态同步）
  useEffect(() => {
    const timer = setInterval(async () => {
      try {
        const voiceStatus = await window.luminaAPI?.agentRealtimeVoiceStatus?.()
        if (voiceStatus && voiceStatus.active !== realtimeVoiceActive) {
          setRealtimeVoiceActive(voiceStatus.active)
        }
        const cuStatus = await window.luminaAPI?.agentComputerUseStatus?.()
        if (cuStatus && cuStatus.active !== computerUseActive) {
          setComputerUseActive(cuStatus.active)
        }
      } catch { /* 静默忽略 */ }
    }, 3000)
    return () => clearInterval(timer)
  }, [realtimeVoiceActive, computerUseActive])

  // ═══ v2.7 语音输入 ═══
  const toggleMic = useCallback(async () => {
    if (sttListening) {
      sttService.stop()
      setSttListening(false)
      setSttStatus(null)
      return
    }
    try {
      setSttListening(true)
      setSttStatus({ listening: true, engine: 'web-speech', engineLabel: 'Web Speech', retryCount: 0 })
      sttService.setCallbacks(
        (text: string) => setInput(prev => prev + text),
        (s: STTStatus) => { setSttStatus(s); if (!s.listening) setSttListening(false) },
      )
      await sttService.start()
    } catch (e) {
      console.warn('GC STT failed:', e)
      setSttListening(false)
      setSttStatus({ listening: false, engine: 'web-speech', engineLabel: 'Web Speech', error: String(e), retryCount: 0 })
      setTimeout(() => setSttStatus(null), 2000)
    }
  }, [sttListening])

  // ═══ v2.7 文件上传 ═══
  const processGCFile = useCallback(async (files: FileList | File[]) => {
    const fileArr = Array.from(files)
    const newAttachments: typeof gcAttachments = []
    // v8.1: 已知的二进制/压缩文档格式（不能当文本读）
    const BINARY_EXTS = new Set([
      'docx','xlsx','pptx','pdf','zip','rar','7z','tar','gz','bz2','xz',
      'exe','dll','so','dylib','dmg','iso','bin','dat',
      'mp3','mp4','avi','mov','wmv','flv','mkv','webm','wav','flac','ogg','aac','m4a','opus',
      'png','jpg','jpeg','gif','bmp','ico','webp','svgz','tiff','tif','psd','ai','eps',
      'woff','woff2','ttf','eot','otf','ttc',
      'pyc','pyo','class','jar','apk','aab','dex','wasm',
      'db','sqlite','sqlite3','mdb','accdb','frm','ibd','myd','myi',
      'o','a','lib','la','obj','pdb','pch','ilk','exp',
      'pak','vpk','wad','bsp','pk3','pk4',
    ])
    for (const f of fileArr) {
      try {
        const ext = f.name.split('.').pop()?.toLowerCase() || ''
        const isImage = f.type.startsWith('image/') || ['png','jpg','jpeg','gif','bmp','ico','webp','tiff','tif','psd'].includes(ext)
        const isBinary = BINARY_EXTS.has(ext) && !isImage
        if (isImage) {
          newAttachments.push({
            name: f.name, size: f.size,
            text: `[图片: ${f.name} (${(f.size / 1024).toFixed(1)}KB), 请打开图片文件查看]`,
          })
        } else if (isBinary) {
          const friendlyName: Record<string, string> = {
            docx: 'Word 文档', xlsx: 'Excel 表格', pptx: 'PPT 演示文稿',
            pdf: 'PDF 文档', zip: 'ZIP 压缩包', rar: 'RAR 压缩包',
            '7z': '7z 压缩包', tar: 'TAR 压缩包',
            pyc: 'Python 编译文件', class: 'Java 字节码', jar: 'JAR 包', apk: 'APK 安装包',
            mp3: '音频', mp4: '视频', wav: '音频', flac: '无损音频',
            exe: '可执行程序', dll: 'DLL 动态库', so: '动态链接库',
          }
          // v8.1: 对 .docx/.xlsx/.pptx (ZIP容器) 和 .pdf 尝试走 IPC 提取文本
          let extractedText = ''
          if (['docx','xlsx','pptx','pdf'].includes(ext)) {
            try {
              const api = (window as any).luminaAPI
              if ((f as any).path && api?.fileExtractText) {
                const result = await api.fileExtractText((f as any).path)
                if (result?.text) extractedText = result.text
              }
              // fallback: 如果 file.path 不可用或失败，传文件内容
              if (!extractedText && api?.fileExtractTextFromBuffer) {
                const buf = await f.arrayBuffer()
                const uint8 = new Uint8Array(buf)
                const result = await api.fileExtractTextFromBuffer(ext, Array.from(uint8))
                if (result?.text) extractedText = result.text
              }
              if (extractedText) {
                const truncated = extractedText.slice(0, 15000)
                extractedText = truncated + (extractedText.length > 15000 ? '\n...(已截断，前15000字)' : '')
              }
            } catch { /* 提取失败则 fall through */ }
          }
          newAttachments.push({
            name: f.name, size: f.size,
            text: extractedText || `[${friendlyName[ext] || ext.toUpperCase() + ' 文件'}: ${f.name} (${(f.size / 1024).toFixed(1)}KB), 暂不支持文本提取]`,
          })
        } else {
          // 文本类文件：读取内容
          const text = await f.text()
          const truncated = text.slice(0, 15000)
          newAttachments.push({
            name: f.name, size: f.size,
            text: truncated + (text.length > 15000 ? '\n...(已截断，前15000字)' : ''),
          })
        }
      } catch {
        newAttachments.push({
          name: f.name, size: f.size,
          text: `[⚠️ 无法读取文件内容: ${f.name} — 此文件类型暂不支持文本提取]`,
        })
      }
    }
    if (newAttachments.length > 0) setGcAttachments(prev => [...prev, ...newAttachments])
  }, [])

  // ═══ v2.14: 消息内联按钮操作 ═══
  const handleCopyMsg = useCallback((content: string, msgId: string) => {
    navigator.clipboard.writeText(content).catch(() => {})
    setCopiedMsgId(msgId)
    showToast('✅ 已复制', 'success')
    setTimeout(() => setCopiedMsgId(null), 2000)
  }, [])

  const handleResendMsg = useCallback((content: string) => {
    setInput(content)
    setTimeout(() => {
      gcTextareaRef.current?.focus()
      const el = gcTextareaRef.current
      if (el) el.setSelectionRange(el.value.length, el.value.length)
    }, 50)
  }, [setInput])

  const handleBookmarkMsg = useCallback((m: GCMsg) => {
    addBookmark({
      content: m.content,
      from: m.from,
      fromName: m.fromName,
      fromIcon: m.fromIcon,
      source: `group:${activeSessionId}`,
    })
    showToast('⭐ 已收藏', 'success')
  }, [activeSessionId])

  const handleDeleteRequest = useCallback((m: GCMsg) => {
    setDeletingTarget(m)
  }, [])

  const handleDeleteConfirm = useCallback(() => {
    if (!deletingTarget) return
    setMessages(prev => prev.filter(m => m.id !== deletingTarget.id))
    setMsgCounter(c => c + 1)
    setDeletingTarget(null)
    showToast('已删除', 'success')
  }, [deletingTarget, setMessages])

  const handleGCFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return
    await processGCFile(e.target.files)
    e.target.value = ''
  }, [processGCFile])

  const handleGCDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation()
    setGcDragOver(false)
    if (e.dataTransfer.files.length > 0) await processGCFile(e.dataTransfer.files)
  }, [processGCFile])

  // ═══ v2.7 流式打字效果 ═══
  const animateTyping = useCallback((msgId: string, fullText: string) => {
    let i = 0
    const intervalMs = 16
    const timer = setInterval(() => {
      if (abortRef.current) {
        clearInterval(timer)
        // v2.14: 中断时至少保存已输入的内容
        setMessages(prev => {
          const updated = prev.map(m => m.id === msgId ? { ...m, content: fullText.slice(0, i), _animDone: false } as any : m)
          saveGCMessages(activeSessionId, updated)
          return updated
        })
        return
      }
      if (i >= fullText.length) {
        clearInterval(timer)
        setMessages(prev => {
          const updated = prev.map(m => m.id === msgId ? { ...m, content: fullText, _animDone: true } as any : m)
          if (!userExpandedRef.current.has(msgId)) {
            setThinkingCollapsed(prev => ({ ...prev, [msgId]: true }))
            autoCollapsedThinkingRef.current.add(msgId)
            setExpandedThinking(prev => {
              const next = new Set(prev)
              next.delete(msgId)
              return next
            })
          }
          // v3.6: 写作完成后保存消息 + 同步更新会话列表
          saveGCMessages(activeSessionId, updated)
          const preview = updated.filter(m => m.from === 'user').slice(-1)[0]?.content?.slice(0, 30) || ''
          const sessions: GCSession[] = [
            { id: activeSessionId, date: new Date().toLocaleDateString('zh-CN'),
              preview, count: updated.length },
            ...JSON.parse(localStorage.getItem('lumina_gc_sessions') || '[]').filter((s: GCSession) => s.id !== activeSessionId),
          ]
          saveGCSessions(sessions)
          window.dispatchEvent(new Event('gc:sessions-updated'))
          return updated
        })
        if (!userExpandedRef.current.has(msgId)) {
          setThinkingCollapsed(prev => ({ ...prev, [msgId]: true }))
          autoCollapsedThinkingRef.current.add(msgId)
          setExpandedThinking(prev => {
            const next = new Set(prev)
            next.delete(msgId)
            return next
          })
        }
        return
      }
      // 代码块一次性追加
      if (fullText.slice(i, i + 3) === '```') {
        const end = fullText.indexOf('```', i + 3)
        i = end !== -1 ? end + 3 : i + 1
      } else {
        i++
      }
      setMessages(prev => prev.map(m => m.id === msgId ? { ...m, content: fullText.slice(0, i) } as any : m))
    }, intervalMs)
    return () => clearInterval(timer)
  }, [activeSessionId])

  const parseMention = (text: string): string | null => {
    const m = text.match(/@(Lumina|lumina|热茶|recha|Yak|yak)/)
    return m ? AGENTS.find(a => a.name === m[1] || a.id === m[1].toLowerCase())?.id || null : null
  }

  /**
   * 🔧 v3.6: 智能任务识别 → 路由到正确的 Agent
   * 🆕 v3.7: 增加 discussion 类型；强化 coding 与 analysis 模式
   * 返回: 'coding' | 'analysis' | 'chat' | 'discussion'
   */
  const detectTaskIntent = (text: string): 'coding' | 'analysis' | 'chat' | 'discussion' => {
    const codingPatterns = [
      /写(个|一个|段)?(代码|程序|脚本|网页|页面|组件|文件|文档)/,
      /(编程|编码|改代码|修bug|修复|debug|重构|实现|开发)/,
      /(创建|新建|生成|帮我写|做一个?)(.*?)(文件|代码|程序|脚本|网页|项目|应用|app)/,
      /\.(py|ts|tsx|js|html|css|java|go|rs|cpp|c|vue|svelte|swift|kt|sh|bat|ps1)\b/,
      /(react|vue|next\.js|express|flask|django|spring|node\.js)/i,
      /(api|接口|数据库|前端|后端|全栈|命令行|cli)/,
      /(帮我|能不能|可以)(写|做|开发|实现|创建|改)/,
      /(修改|改一下|改改|完善|优化|改进).*?(代码|文件|程序|功能)/,
      /(shell|bash|terminal|command|命令|终端|控制台)/i,
      /(安装|配置|部署|docker|git|npm|yarn|pnpm|pip|maven|gradle)/i,
      /(编译|运行|执行|测试|打包|构建|build|compile|run|test)/i,
      // 🆕 v3.7: 更多编程触发词
      /(正则|regex|sql|查询|排序|算法|数据结构|类|函数|方法)/i,
      /(怎么写|怎么改|怎么实现|实现.*?功能|添加.*?功能)/,
    ]
    if (codingPatterns.some(p => p.test(text))) return 'coding'

    const analysisPatterns = [
      /(分析|研究|调查|统计|对比|评估|report|报告)/,
      /(数据|趋势|行情|市场|股票|价格|走势)/,
      /(查一下|搜索|找一下|看看有没有|有没有.*?数据)/,
      /(最近|最新|今天|本周|昨天).*?(新闻|消息|动态|热点|资讯)/,
      // 🆕 v3.7: 更多分析触发词
      /(整理|汇总|归纳|总结|总结一下|概括|提炼)/,
      /(解读|解读一下|怎么看|你觉得.*?怎么样|评价|评价一下)/,
      /(对比|比较|区别|差异|优缺点|利弊)/,
      /(查找|检索|搜一下|查资料|找资料|查询)/,
      /(信息|资料|文档|文献|论文|文章|blog|博客)/i,
    ]
    if (analysisPatterns.some(p => p.test(text))) return 'analysis'

    const discussionPatterns = [
      /(讨论|聊聊|聊一下|商量|商议|商议一下|头脑风暴|各抒己见)/,
      /(大家觉得|你们觉得|大家说说|你们说呢|怎么样\?|好不好\?)/,
      /(要不要|该不该|应不应该|是否应该|行不行|能不能)/,
      /(观点|看法|想法|建议|意见|主意|方案|计划)/,
      /(投票|表决|决定|选择|选哪个|挑一个)/,
      /(觉得怎样|怎么看|如何看|有什么想法|有什么建议)/,
      /(如果.*?会怎样|假如|假设|设想)/,
      /(先说|先说下|说个事|有事商量|开个会)/,
    ]
    if (discussionPatterns.some(p => p.test(text))) return 'discussion'

    return 'chat'
  }

  /** 🆕 v3.7: 识别编程任务的工程体量 — 小/中/大 */
  const detectCodeScale = (text: string): 'small' | 'medium' | 'large' => {
    // 大型工程特征：多模块、完整项目、重构、架构
    const largePatterns = [
      /(完整|完整项目|全新项目|从零开始|从头搭建|脚手架)/,
      /(重构|架构|架构设计|系统设计|整体|全局)/,
      /(多模块|多组件|多页面|大规模|复杂|大型)/,
      /(全栈|前后端|微服务|分布式|集群)/,
      /(框架|平台|引擎|核心|底层|基础库)/,
      /(部署架构|CI|CD|流水线|pipeline|持续集成)/i,
      /(迁移|升级|改造|兼容|适配)/,
    ]
    if (largePatterns.some(p => p.test(text))) return 'large'

    // 中型特征：多文件、组件/模块、接口
    const mediumPatterns = [
      /(多个文件|多文件|组件|模块|子模块)/,
      /(API|接口|路由|中间件|服务|service)/i,
      /(页面|功能模块|功能组件|工具集|工具类)/,
      /(前端页面|后端服务|管理后台|仪表盘|dashboard)/i,
      /(中等|不太大|不太小|有点复杂)/,
      /(增删改查|CRUD|表单|表格|列表|详情)/i,
      /(集成|对接|接入|调用|整合)/,
    ]
    if (mediumPatterns.some(p => p.test(text))) return 'medium'

    // 默认为小型（单个文件、简单脚本、快速修改）
    return 'small'
  }

  /** 🆕 v3.7: 根据任务类型路由到正确的 Agent — 热茶编码、Yak分析、Lumina日常+讨论 */
  const routeToAgent = (intent: ReturnType<typeof detectTaskIntent>) => {
    switch (intent) {
      case 'coding':   return AGENTS.find(a => a.id === 'recha')!    // 🆕 v3.7: 热茶负责编码
      case 'analysis': return AGENTS.find(a => a.id === 'yak')!      // 🆕 v3.7: Yak 负责分析
      case 'discussion': return AGENTS.find(a => a.id === 'lumina')! // 🆕 v3.7: 讨论由 Lumina 牵头
      case 'chat':     return AGENTS.find(a => a.id === 'lumina')!
    }
  }

  /** 🆕 v3.0: 生成工具操作的详细描述 */
  const describeToolAction = useCallback((tool: string, args: Record<string, any> | undefined): { label: string; detail: string } => {
    const a = args || {}
    switch (tool) {
      case 'shell':
      case 'shell_exec':
        return {
          label: `💻 执行命令`,
          detail: a.command || a.cmd || '(无命令)',
        }
      case 'file_read':
        return {
          label: `📖 读取文件`,
          detail: a.filePath || a.path || a.file_path || a.file || '(未知路径)',
        }
      case 'file_write':
        return {
          label: `📝 写入文件`,
          detail: a.filePath || a.path || a.file_path || a.file || '(未知路径)',
        }
      case 'file_edit':
        return {
          label: `✏️ 编辑文件`,
          detail: `${a.filePath || a.path || a.file_path || a.file || '(未知)'} ${a.oldText || a.old_text ? '→ 替换内容' : ''}`,
        }
      case 'file_list':
        return {
          label: `📂 列出目录`,
          detail: a.dirPath || a.path || a.directory || '(当前目录)',
        }
      case 'open_file':
        return {
          label: `📂 打开`,
          detail: a.target || a.path || a.filePath || a.file || '(未知路径)',
        }
      case 'browser':
      case 'browser_use':
        return {
          label: `🌐 浏览器操作`,
          detail: a.action ? `${a.action}${a.url ? ' ' + a.url : ''}` : (a.url || '(浏览器)'),
        }
      case 'search':
      case 'web_search':
        return {
          label: `🔍 搜索`,
          detail: a.query || a.keyword || a.text || '(搜索)',
        }
      case 'git':
        return {
          label: `📦 Git 操作`,
          detail: a.command || a.action || '(git)',
        }
      case 'delegate_to':
        return {
          label: `🤝 委托任务`,
          detail: `→ ${a.agent || a.to || '(队友)'}`,
        }
      case 'use_skill':
        return {
          label: `🧰 加载技能`,
          detail: a.skill || a.name || '(技能)',
        }
      case 'memory_search':
      case 'memory_store':
        return {
          label: `🧠 记忆操作`,
          detail: a.query || a.key || '(记忆)',
        }
      default:
        const genericNotice = getToolNotification(tool, a)
        return {
          label: genericNotice || `🔧 ${tool}`,
          detail: a ? JSON.stringify(a).slice(0, 120) : '',
        }
    }
  }, [])

  /** 根据任务类型返回 Agent 执行配置 */
  const getTaskConfig = (isCoding: boolean, override?: Partial<{
    maxToolCalls: number; mode: 'chat' | 'agent'; temperature: number; maxTokens: number
  }>) => {
    // fix: 群聊场景默认使用 agent 模式，确保工具调用可用
    //   如果调用方明确传入 mode='chat' 才使用 chat 模式
    const effectiveMode = override?.mode || 'agent'

    if (isCoding) {
      // 编程任务 — 全部放行（工具名为 registry 实际注册名）
      const codingWhitelist = new Set([
        'file_read', 'file_write', 'file_edit', 'file_list',
        'shell_exec',
        'open_file',       // 🆕 v3.6: 打开文件/程序/URL
        'git_status', 'git_diff', 'git_commit', 'git_log',
      ])
      const codingDisabled = teamDisabledTools.filter(t => !codingWhitelist.has(t))
      return {
        mode: effectiveMode as 'chat' | 'agent',
        maxToolCalls: override?.maxToolCalls ?? 12,
        temperature: override?.temperature ?? 0.5,
        maxTokens: override?.maxTokens ?? 262144,
        contextWindow: 262144,
        disabledTools: codingDisabled,
      }
    }
    // 普通对话 — chat 模式 + 有限工具循环 (max 3 轮)
    //   之前 maxToolCalls=8 → 10 轮 ReAct → 本地慢模型频繁超时
    //   v5.3fix: maxToolCalls=3 → 简单对话 1 轮完成，搜索类 2-3 轮完成
    //   CHAT_MODE_TOOLS 包含 web_search/web_fetch/memory/file，不含 browser/shell_exec
    //   v8.1fix: 聊天模式强制禁用 shell_exec/系统工具，避免 Agent 尝试重复读取已上传文件
    const chatModeDisabled = [...teamDisabledTools]
    // 聊天模式永远禁 shell_exec，避免 Agent 重复读文件时出现中文路径/编码错误
    const CHAT_BLOCKED = ['shell_exec', 'system_info', 'process_list', 'notification',
      'desktop_see', 'desktop_act', 'desktop_click', 'desktop_type',
      'keyboard_press', 'keyboard_type', 'clipboard_set', 'screenshot',
      'mail_send', 'open_file',
    ]
    for (const t of CHAT_BLOCKED) {
      if (!chatModeDisabled.includes(t)) chatModeDisabled.push(t)
    }
    return {
      mode: effectiveMode as 'chat' | 'agent',
      maxToolCalls: override?.maxToolCalls ?? 6,  // 🆕 v15.0-QwenPaw-fix: 群聊默认 6 轮，给搜索+总结留空间
      temperature: override?.temperature ?? 0.7,
      maxTokens: override?.maxTokens ?? 262144,
      contextWindow: 262144,
      disabledTools: chatModeDisabled,
    }
  }

  const send = useCallback(async () => {
    if ((!input.trim() && gcAttachments.length === 0) || sending) return

    const userText = input
    const currentAttachments = [...gcAttachments]
    setGcAttachments([])

    // ═══ v2.7: 命令拦截 ═══
    if (userText.startsWith('/')) {
      setInput('')
      setMsgCounter(c => c + 1)
      try {
        const result = await window.luminaAPI.commandExecute(userText)
        setMessages(prev => [...prev, {
          id: `cmd-${Date.now()}`, from: 'system', fromIcon: '⚡', fromName: '命令',
          content: result?.content || result?.error || `命令已执行: ${userText}`,
          time: new Date().toLocaleTimeString('zh-CN'),
        }])
      } catch (err: any) {
        setMessages(prev => [...prev, {
          id: `cmd-${Date.now()}`, from: 'system', fromIcon: '⚠️', fromName: '命令',
          content: `命令执行失败: ${err.message}`,
          time: new Date().toLocaleTimeString('zh-CN'),
        }])
      }
      return
    }

    // ═══ v2.7: 组??附件消息 ═══
    let fullText = userText
    if (currentAttachments.length > 0) {
      const fileDescs = currentAttachments.map((a, i) => {
        const sizeStr = a.size > 1024 * 1024 ? `${(a.size / (1024 * 1024)).toFixed(1)}MB` : `${(a.size / 1024).toFixed(1)}KB`
        let desc = `[附件${i + 1}: ${a.name} (${sizeStr})]`
        if (a.text) desc += `\n内容:\n${a.text}`
        return desc
      }).join('\n')
      fullText = `${userText}\n\n--- 上传文件 ---\n${fileDescs}`
    }

    const userMsg: GCMsg = {
      id: `u${Date.now()}`, from: 'user', fromIcon: '👤', fromName: '我',
      content: userText,
      attachments: currentAttachments.length > 0 ? currentAttachments.map(a => ({
        name: a.name,
        size: a.size,
        text: a.text,
      })) : undefined,
      time: new Date().toLocaleTimeString('zh-CN'),
    }
    setMessages(prev => [...prev, userMsg])
    setInput('')
    setSending(true)
    abortRef.current = false
    setMsgCounter(c => c + 1)

    // ═══ v2.7: 主动聊天 + TTS 解锁 ═══
    proactiveChat.recordActivity()
    ttsEngine.unlock()

    // ══════════════════════════════════════════════════════
    // 智能任务路由 — 按任务类型分配 Agent
    // ══════════════════════════════════════════════════════
    // v8.1fix: ⚠️ 任务意图只在用户输入文字上检测，不在文件内容上检测！
    //   fullText 包含提取的文档正文，若文档含"实现/代码/开发"等技术词→误判为 coding→走编程模式 shell_exec 可用→出错
    //   Agent 路由也用用户输入检测，避免上传技术文档时被路由到 Recha（编程Agent）
    const taskIntent = userText.trim().length > 0 ? detectTaskIntent(userText) : 'chat'
    const isCoding = taskIntent === 'coding' && userText.trim().length > 0
    const codeScale = isCoding ? detectCodeScale(userText) : 'small'

    // ── 大型工程：全协作流水线（热茶编码→Yak审查→热茶修复→Lumina测试）──
    if (isCoding && codeScale === 'large' && llmReady) {
      // 思考过程追踪 — 每个协作阶段都会累积
      let phaseThinkingAccum: ThinkingStep[] = []
      let phaseStepIds = new Set<string>()
      let phaseStepStartTimes = new Map<string, number>()
      /** 🆕 v5.2: 支持 upsert — 同 key 更新而非新增，避免思考面板刷屏 */
      const upsertCollabStep = (s: ThinkingStep, currentMsgId: string, stableKey?: string) => {
        const key = stableKey || `${s.type}:${s.tool || ''}:${s.label.slice(0, 30)}`
        const existingIdx = phaseThinkingAccum.findIndex(
          step => (stableKey && (step as any)._stableKey === stableKey) ||
                  (`${step.type}:${step.tool || ''}:${step.label.slice(0, 30)}` === key)
        )
        if (existingIdx >= 0) {
          // 更新已有步骤（累积文本、更新标签等）
          const updated = { ...phaseThinkingAccum[existingIdx], ...s }
          phaseThinkingAccum[existingIdx] = updated
        } else {
          (s as any)._stableKey = stableKey || ''
          phaseThinkingAccum.push(s)
        }
        setMessages(prev => prev.map(m => m.id === currentMsgId
          ? { ...m, thinkingSteps: [...phaseThinkingAccum] } as GCMsg : m))
      }
      // 向后兼容
      const pushCollabStep = (s: ThinkingStep, currentMsgId: string) =>
        upsertCollabStep(s, currentMsgId)
      const resetCollabAccum = () => {
        phaseThinkingAccum = []
        phaseStepIds = new Set()
        phaseStepStartTimes = new Map()
      }

      // ── 编程协作：热茶(写码) → Yak(审查) → 热茶(修复) → Lumina(测试) ──
      const currentPhase = collabPhaseRef.current  // 捕获当前阶段号
      const unsubTool = subscribeAgentEvents((ev: any) => {
        // 用户中止时立即停止累积思考步骤
        if (abortRef.current) return
        // fix: 阶段守卫 — 只处理当前阶段的 IPC 事件，旧阶段事件直接丢弃
        if (collabPhaseRef.current !== currentPhase) return
        if (ev.type === 'thinking_stream') {
          // 推理内容累积到同一个步骤 — 不刷屏
          const stableKey = `reasoning:${collabCurrentMsgIdRef.current}`
          if (ev.isLast) {
            // 推理结束：更新标签为完成
            upsertCollabStep({
              id: `reasoning-end-${Date.now()}`,
              type: 'thinking',
              label: '💭 推理完成',
              timestamp: Date.now(),
            }, collabCurrentMsgIdRef.current, stableKey)
          } else if (ev.text) {
            // 累积推理文本到同一步骤
            const existing = phaseThinkingAccum.find(s => (s as any)._stableKey === stableKey)
            const fullText = existing?.result ? existing.result + ev.text : ev.text
            upsertCollabStep({
              id: `reasoning-${Date.now()}`,
              type: 'thinking',
              label: '💭 推理中...',
              result: fullText.slice(-5000),
              timestamp: Date.now(),
            }, collabCurrentMsgIdRef.current, stableKey)
          }
        } else if (ev.type === 'thinking' || ev.type === 'text') {
          const txt = (ev.text || ev.content || '').trim()
          const isLoopNoise = /^思考中\.\.\.\s*\(第\s*\d+\s*轮\)$/i.test(txt) ||
            /^🐢\s*模型正在生成|⚡\s*自动推动|⚠️\s*检测到潜在注入|🐢\s*检测到慢速模型/i.test(txt)
          if (txt && txt.length > 2 && !isLoopNoise) {
            pushCollabStep({
              id: `think-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
              type: 'thinking',
              label: txt.slice(0, 120),
              result: txt,
              timestamp: Date.now(),
            }, collabCurrentMsgIdRef.current)
          }
        } else if (ev.type === 'tool_start') {
          const { label, detail } = describeToolAction(ev.tool, ev.args)
          const notice = label + (detail ? `: ${detail}` : '')
          setToolNotice(notice)
          if (toolNoticeTimer.current) clearTimeout(toolNoticeTimer.current)
          toolNoticeTimer.current = setTimeout(() => setToolNotice(null), 4000)
          phaseStepStartTimes.set(ev.tool, Date.now())
          pushCollabStep({
            id: `ts-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
            type: 'tool_start',
            label,
            tool: ev.tool,
            args: detail,
            timestamp: Date.now(),
          }, collabCurrentMsgIdRef.current)
        } else if (ev.type === 'tool_end') {
          if (toolNoticeTimer.current) clearTimeout(toolNoticeTimer.current)
          toolNoticeTimer.current = setTimeout(() => setToolNotice(null), 1500)
          const startTime = phaseStepStartTimes.get(ev.tool)
          phaseStepStartTimes.delete(ev.tool)
          const ok = !ev.error && (!ev.result || ev.result.ok !== false)
          const resultContent = ev.result?.content
            ? (typeof ev.result.content === 'string' ? ev.result.content.slice(0, 120) : JSON.stringify(ev.result.content).slice(0, 120))
            : undefined
          pushCollabStep({
            id: `te-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
            type: ev.error ? 'tool_error' : 'tool_end',
            label: ok ? '✅ 完成' : `❌ ${ev.error || '失败'}`,
            tool: ev.tool,
            result: resultContent || (ev.result ? JSON.stringify(ev.result).slice(0, 120) : undefined),
            durationMs: startTime ? Date.now() - startTime : undefined,
            timestamp: Date.now(),
          }, collabCurrentMsgIdRef.current)
        } else if (ev.type === 'token_update' && ev.delta !== undefined && ev.delta > 0) {
          // 团队协作 token 追踪
          addTokenUsage(llmConfig.model || 'unknown', ev.delta, 'recha')
        }
      })
      // fix: 使用 ref 替代 let 变量
      collabCurrentMsgIdRef.current = ''
      const collabMsgs: GCMsg[] = []

      // 构建协作上下文历史 + 阶段性结果累积
      //   所有 agent 共享 collabHistory（协作前的完整对话），
      //   但 Phase2+ 应该看到前一阶段输出 → 使用 runningHistory 累积追加
      // 🔧 2026-07-12: 扩大上下文窗口 — 保留最近 60 条，每条 24000 字符
      // //   1. 不再无脑过滤 system 消息，改为保留有内容量的系统消息
      //      （系统消息包含欢迎语、命令结果、错误提示等，都是有用上下文）
      //   2. 扩大消息窗口（60 → 120）+ token 动态截断，不再硬砍固定条数
      const collabHistory = (() => {
        const raw = messages
          .slice(-120)
          .filter(m => {
            if (m.from !== 'system') return true
            return (m.content || '').trim().length > 5
          })
          .map(m => ({
            role: m.from === 'user' ? 'user' as const
                : m.from === 'system' ? 'system' as const
                : 'assistant' as const,
            content: (m.content || '').slice(0, 24000),
          }))
        // token 动态截断：保留最新消息不超过上下文窗口 50%
        const CONTEXT_WIN = llmConfig?.contextWindow || 262144
        const BUDGET = Math.floor(CONTEXT_WIN * 0.5)
        let est = 0
        const result: typeof raw = []
        for (let i = raw.length - 1; i >= 0; i--) {
          const itemEst = raw[i].content.length / 4 + 8
          if (est + itemEst > BUDGET && result.length > 0) break
          est += itemEst
          result.unshift(raw[i])
        }
        return result
      })()
      // 累积历史：每个协作阶段完成后追加本阶段结果，供后续阶段参考
      let runningHistory: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [...collabHistory]
      // 同步 ref — 让主回复阶段能读取协作上下文
      runningHistoryRef.current = runningHistory

      try {

        // 精简角色提示词 — 支持多轮迭代修复（🆕 v3.7: 热茶编码、Yak审阅）
        const coderPrompt = `你是热茶，Lumina 团队的代码工程师。收到了编程任务。

⚠️ 铁律（违反就是失败）：
1. 不准说 "建议你" "你可以" "我来分析" — 你没资格分析，你只负责写
2. 第一反应必须是 file_read 看现状 或 file_write 直接写
3. 写完必须 shell_exec 验证，报错就改，改到通过为止
4. 完成只说：文件路径 + 功能 + 验证结果，不超过3句话
5. 如果这是修复轮（修复之前测试失败的问题），必须先理解错误 → 定位代码 → 修改 → 验证
6. 不准问问题 — 需求不明确就按最合理的理解直接写`

        const reviewerPrompt = `你是 Yak，审阅热茶的代码。看完直接给结论。
规则：
- file_read 读代码 → 一句话评价（通过/有问题）
- 有问题说具体位置和原因
- 没问题就说 "✓ 代码通过"
- 不准写代码，不准提建议，只审阅`

        const testerPrompt = `你是 Lumina，用 shell_exec 跑热茶写的程序并报告结果。
规则：
- 只跑命令，不评价代码
- 成功：简短说输出结果，以 "✅" 开头
- 失败：报告具体报错信息，以 "❌" 开头
- 2-3句话内完成
- 如果命令需要交互或长时间运行，用 timeout 参数`

        // ─────────────────────────────────
        // 编程协作循环 — 测试失败自动回到修复阶段
        // 循环直到：测试通过 / 3次迭代耗尽 / 用户中断
        // ─────────────────────────────────
        let codingIteration = 0
        const MAX_CODING_ITERATIONS = 3
        let lastTestWasFailure = false
        let previousErrorContext = ''
        
        while (codingIteration < MAX_CODING_ITERATIONS && !abortRef.current) {
          codingIteration++
          
          // 构建迭代上下文（非首次迭代时附加错误信息）
          const iterSuffix = codingIteration > 1 
            ? `\n\n⚠️ 【第${codingIteration}轮修复】上一轮测试发现问题：${previousErrorContext.slice(0, 500)}\n请修改代码修复这些问题后再验证。`
            : ''
          
          // ─────────────────────────────────
          // Phase 1: 热茶编码/修复
          // ─────────────────────────────────
          setReplyingAgent('recha')
          setLastAgent('recha')
          updateEmotion('recha', userText, { isGroupChat: true })

          const coderMsgId = `recha-${Date.now()}`
          collabCurrentMsgIdRef.current = coderMsgId
          collabPhaseRef.current++  // 🔧 v5.4fix: 递增阶段号
          resetCollabAccum()
          const coderMsg: GCMsg = {
            id: coderMsgId,
            from: 'recha', fromIcon: '🍵', fromName: '热茶',
            content: '', time: new Date().toLocaleTimeString('zh-CN'),
          }
          setMessages(prev => [...prev, coderMsg])
          setMsgCounter(c => c + 1)
          collabMsgs.push(coderMsg)
          
          const phase1Task = codingIteration === 1
            ? `用户需求：${fullText.slice(0, 2000)}`
            : `用户需求：${fullText.slice(0, 1500)}${iterSuffix}`
          
          const codingCfg = getTaskConfig(true)
          const phase1Result = await agentChatWithTimeout({
            text: `[${codingIteration === 1 ? '热茶，用户让你写代码。你是编码者，直接动手，不要只说建议。' : '热茶，上一轮测试发现错误，请修复代码！'}]\n\n${phase1Task}`,
            config: {
              mode: codingCfg.mode,
              isGroupChat: true,
              personaId: 'recha',
              model: llmConfig.model,
              baseUrl: llmConfig.baseUrl,
              apiKey: llmConfig.apiKey,
              temperature: 0.15,
              maxTokens: 262144,
              maxToolCalls: codingIteration === 1 ? 12 : 15,
              disabledTools: codingCfg.disabledTools,
              skipApproval: true,
              contextWindow: 262144,
              systemPrompt: coderPrompt,
              socialMode: true,
            },
            conversationHistory: buildHistoryForAgent(messages, 'recha', codingCfg.contextWindow, runningHistory),
          })

          let coderReply = (phase1Result.content || '代码已写好').trimStart()
          // 🆕 团队阶段错误检测：若是超时/错误兜底文本，中断协作链并提示重试
          if (phase1Result.error || /模型响应较慢|模型响应超时|回复生成失败或耗时过长|已自动中断|请稍后(重试|再试)|出了点问题|LLM 请求失败|连接断开/i.test(coderReply)) {
            console.log('[GroupChat] ⛔ 热茶阶段出错或超时，中断协作链')
            setMessages(prev => prev.map(m => m.id === coderMsgId
              ? { ...m, content: '（热茶处理失败，请说"继续"重试）', _animDone: true } as GCMsg : m))
            runningHistoryRef.current = runningHistory
            setSending(false); setReplyingAgent(null); setLastAgent(null)
            return
          }
          setMessages(prev => prev.map(m => m.id === coderMsgId
            ? { ...m, thinkingSteps: [...phaseThinkingAccum] } as GCMsg : m))
          animateTyping(coderMsgId, coderReply)
          // v14.0-fix: Phase 1 完成后追加结果到 runningHistory（🆕 P2: 扩到 3000 字符避免信息丢失）
          runningHistory.push(
            { role: 'user', content: `[热茶 收到需求] ${fullText.slice(0, 500)}` },
            { role: 'assistant', content: `[热茶 输出] ${coderReply.slice(0, 3000)}` },
          )
          runningHistoryRef.current = runningHistory // 🆕 v16.0-fix: 同步到 ref

          if (abortRef.current) { setSending(false); setReplyingAgent(null); return }

          // ─────────────────────────────────
          // Phase 2: Yak 审查
          // ─────────────────────────────────
          setReplyingAgent('yak')
          setLastAgent('yak')
          updateEmotion('yak', userText, { isGroupChat: true })

          const reviewMsgId = `yak-${Date.now()}`
          collabCurrentMsgIdRef.current = reviewMsgId
          collabPhaseRef.current++  // 🔧 v5.4fix: 递增阶段号
          resetCollabAccum()
          const reviewMsg: GCMsg = {
            id: reviewMsgId,
            from: 'yak', fromIcon: '📊', fromName: 'Yak',
            content: '', time: new Date().toLocaleTimeString('zh-CN'),
          }
          setMessages(prev => [...prev, reviewMsg])
          setMsgCounter(c => c + 1)
          collabMsgs.push(reviewMsg)
          
          const phase2Result = await window.luminaAPI.agentChat({
            text: `[Yak，热茶刚写完了代码，你来审阅一下。]\n\n用户需求：${fullText.slice(0, 500)}\n\n热茶回复的代码：${coderReply.slice(0, 1500)}（完整代码详见上方对话记录）`,
            config: {
              mode: codingCfg.mode,
              isGroupChat: true,
              personaId: 'yak',
              model: llmConfig.model,
              baseUrl: llmConfig.baseUrl,
              apiKey: llmConfig.apiKey,
              temperature: 0.15,
              maxTokens: 262144,
              maxToolCalls: 5,
              skipApproval: true,
              contextWindow: 262144,
              systemPrompt: reviewerPrompt,
              socialMode: true,
            },
            conversationHistory: buildHistoryForAgent(messages, 'yak', codingCfg.contextWindow, runningHistory),
          })

          let reviewReply = (phase2Result.content || '审阅完成').trimStart()
          // 🆕 团队阶段错误检测
          if (phase2Result.error || /模型响应较慢|模型响应超时|回复生成失败或耗时过长|已自动中断|请稍后(重试|再试)|出了点问题|LLM 请求失败|连接断开/i.test(reviewReply)) {
            console.log('[GroupChat] ⛔ Yak 审阅阶段出错或超时，中断协作链')
            setMessages(prev => prev.map(m => m.id === reviewMsgId
              ? { ...m, content: '（Yak 审阅失败，请说"继续"重试）', _animDone: true } as GCMsg : m))
            runningHistoryRef.current = runningHistory
            setSending(false); setReplyingAgent(null); setLastAgent(null)
            return
          }
          setMessages(prev => prev.map(m => m.id === reviewMsgId
            ? { ...m, thinkingSteps: [...phaseThinkingAccum] } as GCMsg : m))
          animateTyping(reviewMsgId, reviewReply)
          // v14.0-fix: Phase 2 完成后追加审查结果到 runningHistory（🆕 P2: 扩到 3000 字符）
          runningHistory.push(
            { role: 'assistant' as const, content: `[Yak 审阅] ${reviewReply.slice(0, 3000)}` },
          )
          runningHistoryRef.current = runningHistory // 🆕 v16.0-fix: 同步到 ref

          if (abortRef.current) { setSending(false); setReplyingAgent(null); return }

          // ─────────────────────────────────
          // Phase 3: 热茶修复（根据审查意见）
          // ─────────────────────────────────
          const needsFix = /问题|错误|改进|建议|修改|优化|修复|不妥|漏洞|隐患|改成|应该|需要|缺少|缺失/.test(reviewReply)

          if (!abortRef.current && needsFix) {
            setReplyingAgent('recha')
            setLastAgent('recha')

            const fixMsgId = `recha-fix-${Date.now()}`
            collabCurrentMsgIdRef.current = fixMsgId
            collabPhaseRef.current++  // 🔧 v5.4fix: 递增阶段号
            resetCollabAccum()
            const fixMsg: GCMsg = {
              id: fixMsgId,
              from: 'recha', fromIcon: '🍵', fromName: '热茶',
              content: '', time: new Date().toLocaleTimeString('zh-CN'),
            }
            setMessages(prev => [...prev, fixMsg])
            setMsgCounter(c => c + 1)
            collabMsgs.push(fixMsg)
            
            const phase3Result = await agentChatWithTimeout({
              text: `[热茶，Yak 审查了你的代码，有一些建议。请根据审阅意见修改代码。]\n\nYak 的审阅意见：${reviewReply.slice(0, 500)}`,
              config: {
                mode: codingCfg.mode,
                isGroupChat: true,
                personaId: 'recha',
                model: llmConfig.model,
                baseUrl: llmConfig.baseUrl,
                apiKey: llmConfig.apiKey,
                temperature: 0.15,
                maxTokens: 262144,
                maxToolCalls: 8,
                skipApproval: true,
                contextWindow: 262144,
                systemPrompt: coderPrompt,
                socialMode: true,
              },
              conversationHistory: buildHistoryForAgent(messages, 'recha', codingCfg.contextWindow, runningHistory),
            })
            
            const fixReply = (phase3Result.content || '修复完成').trimStart()
            // 🆕 团队阶段错误检测
            if (phase3Result.error || /模型响应较慢|模型响应超时|回复生成失败或耗时过长|已自动中断|请稍后(重试|再试)|出了点问题|LLM 请求失败|连接断开/i.test(fixReply)) {
              console.log('[GroupChat] ⛔ 热茶修复阶段出错或超时，中断协作链')
              setMessages(prev => prev.map(m => m.id === fixMsgId
                ? { ...m, content: '（热茶修复失败，请说"继续"重试）', _animDone: true } as GCMsg : m))
              runningHistoryRef.current = runningHistory
              setSending(false); setReplyingAgent(null); setLastAgent(null)
              return
            }
            setMessages(prev => prev.map(m => m.id === fixMsgId
              ? { ...m, thinkingSteps: [...phaseThinkingAccum] } as GCMsg : m))
            animateTyping(fixMsgId, fixReply)
            // v14.0-fix: Phase 3 完成后追加修复结果（🆕 P2: 扩到 3000 字符）
            runningHistory.push(
              { role: 'assistant' as const, content: `[热茶 修复] ${fixReply.slice(0, 3000)}` },
            )
            runningHistoryRef.current = runningHistory // 🆕 v16.0-fix: 同步到 ref
            
            // 用修复后的代码替换 coderReply 供后续阶段使用
            if (fixReply.length > 10) coderReply = fixReply
          }

          if (abortRef.current) { setSending(false); setReplyingAgent(null); return }

          // ─────────────────────────────────
          // Phase 4: Lumina 测试
          // ─────────────────────────────────
          setReplyingAgent('lumina')
          setLastAgent('lumina')
          updateEmotion('lumina', userText, { isGroupChat: true })

          const testMsgId = `lumina-${Date.now()}`
          collabCurrentMsgIdRef.current = testMsgId
          collabPhaseRef.current++  // 🔧 v5.4fix: 递增阶段号
          resetCollabAccum()
          const testMsg: GCMsg = {
            id: testMsgId,
            from: 'lumina', fromIcon: '🐱', fromName: 'Lumina',
            content: '', time: new Date().toLocaleTimeString('zh-CN'),
          }
          setMessages(prev => [...prev, testMsg])
          setMsgCounter(c => c + 1)
          collabMsgs.push(testMsg)
          
          const phase4Result = await agentChatWithTimeout({
            text: `[Lumina，热茶和 Yak 完成了编码和审阅，你来测试一下代码是否能正常运行。]\n\n用户需求：${fullText.slice(0, 500)}\n\n热茶的代码概要：${coderReply.slice(0, 1500)}（完整代码详见上方对话记录）`,
            config: {
              mode: codingCfg.mode,
              isGroupChat: true,
              personaId: 'lumina',
              model: llmConfig.model,
              baseUrl: llmConfig.baseUrl,
              apiKey: llmConfig.apiKey,
              temperature: 0.15,
              maxTokens: 262144,
              maxToolCalls: 6,
              skipApproval: true,
              contextWindow: 262144,
              systemPrompt: testerPrompt,
              socialMode: true,
            },
            conversationHistory: buildHistoryForAgent(messages, 'lumina', codingCfg.contextWindow, runningHistory),
          })

          const testReply = (phase4Result.content || '测试完成').trimStart()
          // 🆕 团队阶段错误检测
          if (phase4Result.error || /模型响应较慢|模型响应超时|回复生成失败或耗时过长|已自动中断|请稍后(重试|再试)|出了点问题|LLM 请求失败|连接断开/i.test(testReply)) {
            console.log('[GroupChat] ⛔ Lumina 测试阶段出错或超时，中断协作链')
            setMessages(prev => prev.map(m => m.id === testMsgId
              ? { ...m, content: '（Lumina 测试失败，请说"继续"重试）', _animDone: true } as GCMsg : m))
            runningHistoryRef.current = runningHistory
            setSending(false); setReplyingAgent(null); setLastAgent(null)
            return
          }
          setMessages(prev => prev.map(m => m.id === testMsgId
            ? { ...m, thinkingSteps: [...phaseThinkingAccum] } as GCMsg : m))
          animateTyping(testMsgId, testReply)

          // 判断测试是否通过 — 决定是否继续循环
          const testFailed = /(error|错误|失败|报错|异常|❌|bug|崩溃|无法|不行|不能|没.*跑|没.*通过|fail|cannot|unable|traceback|exception)/i.test(testReply) &&
            !/(✅.*通过|测试通过|运行成功|成功运行|一切正常|pass|success|ok)/i.test(testReply)
          
          if (testFailed && codingIteration < MAX_CODING_ITERATIONS) {
            previousErrorContext = testReply.slice(0, 500)
            console.log(`[GroupChat] 🔄 测试未通过，进入第 ${codingIteration + 1} 轮修复`)
            lastTestWasFailure = true
            // 短暂暂停让用户看到结果，然后继续
            await new Promise(r => setTimeout(r, 1000))
          } else {
            // ✅ 测试通过 或 已耗尽迭代次数
            if (testFailed) {
              // 耗尽迭代，发系统消息告知用户
              setMessages(prev => [...prev, {
                id: `sys-${Date.now()}`,
                from: 'system', fromIcon: '⚠️', fromName: '系统',
                content: `⚠️ 已尝试 ${MAX_CODING_ITERATIONS} 轮修复，测试仍有问题。建议手动查看代码。`,
                time: new Date().toLocaleTimeString('zh-CN'),
              }])
            }
            break  // 退出循环
          }
        }  // end while loop
        
      } catch (err: any) {
        // 清理空白气泡 — 标记所有协作消息为已完成
        setMessages(prev => prev.map(m =>
          collabMsgs.some(cm => cm.id === m.id) && !m.content
            ? { ...m, _animDone: true } as GCMsg
            : m
        ))
        setMessages(prev => [...prev, {
          id: `err-${Date.now()}`, from: 'system', fromIcon: '⚠️', fromName: '系统',
          content: `协作编程出错: ${err.message}`,
          time: new Date().toLocaleTimeString('zh-CN'),
        }])
      } finally {
        unsubTool()
        setSending(false)
        setReplyingAgent(null)
        setLastAgent(null)
        // 协作完成后延迟再保存一次，确保所有动画已完成
        setTimeout(() => {
          setMessages(prev => { saveGCMessages(activeSessionId, prev); return prev })
          const ss = JSON.parse(localStorage.getItem('lumina_gc_sessions') || '[]')
          if (!ss.some((s: GCSession) => s.id === activeSessionId)) {
            saveGCSessions(ss)
          }
        }, 3000)
      }
      return
    }

    // ── 中型工程：热茶编码 + Yak 审查（自动修复，无测试阶段）──
    if (isCoding && codeScale === 'medium' && llmReady) {
      let phaseThinkingAccum: ThinkingStep[] = []
      let phaseStepIds = new Set<string>()
      let phaseStepStartTimes = new Map<string, number>()
      const upsertCollabStep = (s: ThinkingStep, currentMsgId: string, stableKey?: string) => {
        const key = stableKey || `${s.type}:${s.tool || ''}:${s.label.slice(0, 30)}`
        const existingIdx = phaseThinkingAccum.findIndex(
          step => (stableKey && (step as any)._stableKey === stableKey) ||
                  (`${step.type}:${step.tool || ''}:${step.label.slice(0, 30)}` === key)
        )
        if (existingIdx >= 0) {
          const updated = { ...phaseThinkingAccum[existingIdx], ...s }
          phaseThinkingAccum[existingIdx] = updated
        } else {
          (s as any)._stableKey = stableKey || ''
          phaseThinkingAccum.push(s)
        }
        setMessages(prev => prev.map(m => m.id === currentMsgId
          ? { ...m, thinkingSteps: [...phaseThinkingAccum] } as GCMsg : m))
      }
      const pushCollabStep = (s: ThinkingStep, currentMsgId: string) =>
        upsertCollabStep(s, currentMsgId)
      const resetCollabAccum = () => {
        phaseThinkingAccum = []
        phaseStepIds = new Set()
        phaseStepStartTimes = new Map()
      }

      const currentPhase = collabPhaseRef.current
      const unsubTool = subscribeAgentEvents((ev: any) => {
        if (abortRef.current) return
        if (collabPhaseRef.current !== currentPhase) return
        if (ev.type === 'thinking_stream') {
          const stableKey = `reasoning:${collabCurrentMsgIdRef.current}`
          if (ev.isLast) {
            upsertCollabStep({
              id: `reasoning-end-${Date.now()}`,
              type: 'thinking', label: '💭 推理完成',
              timestamp: Date.now(),
            }, collabCurrentMsgIdRef.current, stableKey)
          } else if (ev.text) {
            const existing = phaseThinkingAccum.find(s => (s as any)._stableKey === stableKey)
            const fullText = existing?.result ? existing.result + ev.text : ev.text
            upsertCollabStep({
              id: `reasoning-${Date.now()}`,
              type: 'thinking', label: '💭 推理中...',
              result: fullText.slice(-5000),
              timestamp: Date.now(),
            }, collabCurrentMsgIdRef.current, stableKey)
          }
        } else if (ev.type === 'thinking' || ev.type === 'text') {
          const txt = (ev.text || ev.content || '').trim()
          const isLoopNoise = /^思考中\.\.\.\s*\(第\s*\d+\s*轮\)$/i.test(txt) ||
            /^🐢\s*模型正在生成|⚡\s*自动推动|⚠️\s*检测到潜在注入|🐢\s*检测到慢速模型/i.test(txt)
          if (txt && txt.length > 2 && !isLoopNoise) {
            pushCollabStep({
              id: `think-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
              type: 'thinking', label: txt.slice(0, 120), result: txt,
              timestamp: Date.now(),
            }, collabCurrentMsgIdRef.current)
          }
        } else if (ev.type === 'tool_start') {
          const { label, detail } = describeToolAction(ev.tool, ev.args)
          setToolNotice(label + (detail ? `: ${detail}` : ''))
          if (toolNoticeTimer.current) clearTimeout(toolNoticeTimer.current)
          toolNoticeTimer.current = setTimeout(() => setToolNotice(null), 4000)
          phaseStepStartTimes.set(ev.tool, Date.now())
          pushCollabStep({
            id: `ts-${Date.now()}`, type: 'tool_start', label,
            tool: ev.tool, args: detail, timestamp: Date.now(),
          }, collabCurrentMsgIdRef.current)
        } else if (ev.type === 'tool_end') {
          if (toolNoticeTimer.current) clearTimeout(toolNoticeTimer.current)
          toolNoticeTimer.current = setTimeout(() => setToolNotice(null), 1500)
          const startTime = phaseStepStartTimes.get(ev.tool)
          phaseStepStartTimes.delete(ev.tool)
          const ok = !ev.error && (!ev.result || ev.result.ok !== false)
          const resultContent = ev.result?.content
            ? (typeof ev.result.content === 'string' ? ev.result.content.slice(0, 120) : JSON.stringify(ev.result.content).slice(0, 120))
            : undefined
          pushCollabStep({
            id: `te-${Date.now()}`, type: ev.error ? 'tool_error' : 'tool_end',
            label: ok ? '✅ 完成' : `❌ ${ev.error || '失败'}`,
            tool: ev.tool,
            result: resultContent || (ev.result ? JSON.stringify(ev.result).slice(0, 120) : undefined),
            durationMs: startTime ? Date.now() - startTime : undefined,
            timestamp: Date.now(),
          }, collabCurrentMsgIdRef.current)
        } else if (ev.type === 'token_update' && ev.delta !== undefined && ev.delta > 0) {
          addTokenUsage(llmConfig.model || 'unknown', ev.delta, 'recha')
        }
      })
      collabCurrentMsgIdRef.current = ''
      const collabMsgs: GCMsg[] = []

      const collabHistory = (() => {
        const raw = messages
          .slice(-120)
          .filter(m => {
            if (m.from !== 'system') return true
            return (m.content || '').trim().length > 5
          })
          .map(m => ({
            role: m.from === 'user' ? 'user' as const
                : m.from === 'system' ? 'system' as const
                : 'assistant' as const,
            content: (m.content || '').slice(0, 24000),
          }))
        const CONTEXT_WIN = llmConfig?.contextWindow || 262144
        const BUDGET = Math.floor(CONTEXT_WIN * 0.5)
        let est = 0
        const result: typeof raw = []
        for (let i = raw.length - 1; i >= 0; i--) {
          const itemEst = raw[i].content.length / 4 + 8
          if (est + itemEst > BUDGET && result.length > 0) break
          est += itemEst
          result.unshift(raw[i])
        }
        return result
      })()
      let runningHistory: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [...collabHistory]
      runningHistoryRef.current = runningHistory

      try {
        const coderPrompt = `你是热茶，Lumina 团队的代码工程师。收到了编程任务。

⚠️ 铁律（违反就是失败）：
1. 不准说 "建议你" "你可以" "我来分析" — 你没资格分析，你只负责写
2. 第一反应必须是 file_read 看现状 或 file_write 直接写
3. 写完必须 shell_exec 验证，报错就改，改到通过为止
4. 完成只说：文件路径 + 功能 + 验证结果，不超过3句话
5. 如果这是修复轮（修复之前审查发现的问题），必须先理解错误 → 定位代码 → 修改 → 验证
6. 不准问问题 — 需求不明确就按最合理的理解直接写`

        const reviewerPrompt = `你是 Yak，审阅热茶的代码。看完直接给结论。
规则：
- file_read 读代码 → 一句话评价（通过/有问题）
- 有问题说具体位置和原因
- 没问题就说 "✓ 代码通过"
- 不准写代码，不准提建议，只审阅`

        let codingIteration = 0
        const MAX_CODING_ITERATIONS = 2
        let lastReviewFailed = false
        let previousErrorContext = ''

        while (codingIteration < MAX_CODING_ITERATIONS && !abortRef.current) {
          codingIteration++

          const iterSuffix = codingIteration > 1
            ? `\n\n⚠️ 【第${codingIteration}轮修改】上一轮审查发现问题：${previousErrorContext.slice(0, 500)}\n请修改代码解决这些问题后再验证。`
            : ''

          // ── Phase 1: 热茶编码/修复 ──
          setReplyingAgent('recha')
          setLastAgent('recha')
          updateEmotion('recha', userText, { isGroupChat: true })

          const coderMsgId = `recha-md-${Date.now()}`
          collabCurrentMsgIdRef.current = coderMsgId
          collabPhaseRef.current++
          resetCollabAccum()
          const coderMsg: GCMsg = {
            id: coderMsgId,
            from: 'recha', fromIcon: '🍵', fromName: '热茶',
            content: '', time: new Date().toLocaleTimeString('zh-CN'),
          }
          setMessages(prev => [...prev, coderMsg])
          setMsgCounter(c => c + 1)
          collabMsgs.push(coderMsg)

          const phase1Task = codingIteration === 1
            ? `用户需求：${fullText.slice(0, 2000)}`
            : `用户需求：${fullText.slice(0, 1500)}${iterSuffix}`

          const codingCfg = getTaskConfig(true)
          const phase1Result = await agentChatWithTimeout({
            text: `[${codingIteration === 1 ? '热茶，用户让你写代码。你是编码者，直接动手，不要只说建议。' : '热茶，上一轮审查发现代码有问题，请修复！'}]\n\n${phase1Task}`,
            config: {
              mode: codingCfg.mode,
              isGroupChat: true,
              personaId: 'recha',
              model: llmConfig.model,
              baseUrl: llmConfig.baseUrl,
              apiKey: llmConfig.apiKey,
              temperature: 0.15,
              maxTokens: 262144,
              maxToolCalls: codingIteration === 1 ? 12 : 15,
              disabledTools: codingCfg.disabledTools,
              skipApproval: true,
              contextWindow: 262144,
              systemPrompt: coderPrompt,
              socialMode: true,
            },
            conversationHistory: buildHistoryForAgent(messages, 'recha', codingCfg.contextWindow, runningHistory),
          })

          let coderReply = (phase1Result.content || '代码已写好').trimStart()
          // 🆕 团队阶段错误检测：若是超时/错误兜底文本，中断协作链并提示重试
          if (phase1Result.error || /模型响应较慢|模型响应超时|回复生成失败或耗时过长|已自动中断|请稍后(重试|再试)|出了点问题|LLM 请求失败|连接断开/i.test(coderReply)) {
            console.log('[GroupChat] ⛔ 热茶阶段出错或超时，中断协作链')
            setMessages(prev => prev.map(m => m.id === coderMsgId
              ? { ...m, content: '（热茶处理失败，请说"继续"重试）', _animDone: true } as GCMsg : m))
            runningHistoryRef.current = runningHistory
            setSending(false); setReplyingAgent(null); setLastAgent(null)
            return
          }
          setMessages(prev => prev.map(m => m.id === coderMsgId
            ? { ...m, thinkingSteps: [...phaseThinkingAccum] } as GCMsg : m))
          animateTyping(coderMsgId, coderReply)
          runningHistory.push(
            { role: 'user', content: `[热茶 收到需求] ${fullText.slice(0, 500)}` },
            { role: 'assistant', content: `[热茶 输出] ${coderReply.slice(0, 3000)}` },
          )
          runningHistoryRef.current = runningHistory

          if (abortRef.current) { setSending(false); setReplyingAgent(null); return }

          // ── Phase 2: Yak 审查 ──
          setReplyingAgent('yak')
          setLastAgent('yak')
          updateEmotion('yak', userText, { isGroupChat: true })

          const reviewMsgId = `yak-md-${Date.now()}`
          collabCurrentMsgIdRef.current = reviewMsgId
          collabPhaseRef.current++
          resetCollabAccum()
          const reviewMsg: GCMsg = {
            id: reviewMsgId,
            from: 'yak', fromIcon: '📊', fromName: 'Yak',
            content: '', time: new Date().toLocaleTimeString('zh-CN'),
          }
          setMessages(prev => [...prev, reviewMsg])
          setMsgCounter(c => c + 1)
          collabMsgs.push(reviewMsg)

          const phase2Result = await window.luminaAPI.agentChat({
            text: `[Yak，热茶刚写完了代码，你来审阅一下。]\n\n用户需求：${fullText.slice(0, 500)}\n\n热茶的代码：${coderReply.slice(0, 1500)}（完整代码详见上方对话记录）`,
            config: {
              mode: codingCfg.mode,
              isGroupChat: true,
              personaId: 'yak',
              model: llmConfig.model,
              baseUrl: llmConfig.baseUrl,
              apiKey: llmConfig.apiKey,
              temperature: 0.15,
              maxTokens: 262144,
              maxToolCalls: 5,
              skipApproval: true,
              contextWindow: 262144,
              systemPrompt: reviewerPrompt,
              socialMode: true,
            },
            conversationHistory: buildHistoryForAgent(messages, 'yak', codingCfg.contextWindow, runningHistory),
          })

          const reviewReply = (phase2Result.content || '审阅完成').trimStart()
          // 🆕 团队阶段错误检测
          if (phase2Result.error || /模型响应较慢|模型响应超时|回复生成失败或耗时过长|已自动中断|请稍后(重试|再试)|出了点问题|LLM 请求失败|连接断开/i.test(reviewReply)) {
            console.log('[GroupChat] ⛔ Yak 审阅阶段出错或超时，中断协作链')
            setMessages(prev => prev.map(m => m.id === reviewMsgId
              ? { ...m, content: '（Yak 审阅失败，请说"继续"重试）', _animDone: true } as GCMsg : m))
            runningHistoryRef.current = runningHistory
            setSending(false); setReplyingAgent(null); setLastAgent(null)
            return
          }
          setMessages(prev => prev.map(m => m.id === reviewMsgId
            ? { ...m, thinkingSteps: [...phaseThinkingAccum] } as GCMsg : m))
          animateTyping(reviewMsgId, reviewReply)
          runningHistory.push(
            { role: 'assistant' as const, content: `[Yak 审阅] ${reviewReply.slice(0, 3000)}` },
          )
          runningHistoryRef.current = runningHistory

          if (abortRef.current) { setSending(false); setReplyingAgent(null); return }

          // ── Phase 3: 热茶修复（如果需要）──
          const needsFix = /问题|错误|改进|建议|修改|优化|修复|不妥|漏洞|隐患|改成|应该|需要|缺少|缺失/.test(reviewReply)

          if (!abortRef.current && needsFix) {
            setReplyingAgent('recha')
            setLastAgent('recha')

            const fixMsgId = `recha-fix-${Date.now()}`
            collabCurrentMsgIdRef.current = fixMsgId
            collabPhaseRef.current++
            resetCollabAccum()
            const fixMsg: GCMsg = {
              id: fixMsgId,
              from: 'recha', fromIcon: '🍵', fromName: '热茶',
              content: '', time: new Date().toLocaleTimeString('zh-CN'),
            }
            setMessages(prev => [...prev, fixMsg])
            setMsgCounter(c => c + 1)
            collabMsgs.push(fixMsg)

            const phase3Result = await agentChatWithTimeout({
              text: `[热茶，Yak 审查了你的代码，有一些建议。请根据审查意见修改代码。]\n\nYak 的审查意见：${reviewReply.slice(0, 500)}`,
              config: {
                mode: codingCfg.mode,
                isGroupChat: true,
                personaId: 'recha',
                model: llmConfig.model,
                baseUrl: llmConfig.baseUrl,
                apiKey: llmConfig.apiKey,
                temperature: 0.15,
                maxTokens: 262144,
                maxToolCalls: 8,
                skipApproval: true,
                contextWindow: 262144,
                systemPrompt: coderPrompt,
                socialMode: true,
              },
              conversationHistory: buildHistoryForAgent(messages, 'recha', codingCfg.contextWindow, runningHistory),
            })

            const fixReply = (phase3Result.content || '修复完成').trimStart()
            // 🆕 团队阶段错误检测
            if (phase3Result.error || /模型响应较慢|模型响应超时|回复生成失败或耗时过长|已自动中断|请稍后(重试|再试)|出了点问题|LLM 请求失败|连接断开/i.test(fixReply)) {
              console.log('[GroupChat] ⛔ 热茶修复阶段出错或超时，中断协作链')
              setMessages(prev => prev.map(m => m.id === fixMsgId
                ? { ...m, content: '（热茶修复失败，请说"继续"重试）', _animDone: true } as GCMsg : m))
              runningHistoryRef.current = runningHistory
              setSending(false); setReplyingAgent(null); setLastAgent(null)
              return
            }
            setMessages(prev => prev.map(m => m.id === fixMsgId
              ? { ...m, thinkingSteps: [...phaseThinkingAccum] } as GCMsg : m))
            animateTyping(fixMsgId, fixReply)
            runningHistory.push(
              { role: 'assistant' as const, content: `[热茶 修复] ${fixReply.slice(0, 3000)}` },
            )
            runningHistoryRef.current = runningHistory

            if (fixReply.length > 10) coderReply = fixReply
          }

          // 判断审查是否通过
          if (!needsFix) {
            break  // ✅ 审查通过，退出
          }

          if (codingIteration < MAX_CODING_ITERATIONS) {
            previousErrorContext = reviewReply.slice(0, 500)
            lastReviewFailed = true
            await new Promise(r => setTimeout(r, 800))
          }
        }  // end while

        if (codingIteration >= MAX_CODING_ITERATIONS && lastReviewFailed) {
          setMessages(prev => [...prev, {
            id: `sys-${Date.now()}`,
            from: 'system', fromIcon: '⚠️', fromName: '系统',
            content: `⚠️ 已尝试 ${MAX_CODING_ITERATIONS} 轮，审查仍有问题。建议手动查看代码或@Yak 进行详细审查。`,
            time: new Date().toLocaleTimeString('zh-CN'),
          }])
        }

      } catch (err: any) {
        setMessages(prev => prev.map(m =>
          collabMsgs.some(cm => cm.id === m.id) && !m.content
            ? { ...m, _animDone: true } as GCMsg : m
        ))
        setMessages(prev => [...prev, {
          id: `err-${Date.now()}`, from: 'system', fromIcon: '⚠️', fromName: '系统',
          content: `中型编程出错: ${err.message}`,
          time: new Date().toLocaleTimeString('zh-CN'),
        }])
      } finally {
        unsubTool()
        setSending(false)
        setReplyingAgent(null)
        setLastAgent(null)
        setTimeout(() => {
          setMessages(prev => { saveGCMessages(activeSessionId, prev); return prev })
          const ss = JSON.parse(localStorage.getItem('lumina_gc_sessions') || '[]')
          if (!ss.some((s: GCSession) => s.id === activeSessionId)) {
            saveGCSessions(ss)
          }
        }, 3000)
      }
      return
    }

    // ── 🔧 v3.6: 智能路由 → 按任务类型分配 Agent ──
    // 🔧 fix: 移除 lastAgent 粘性路由 — 每次都按当前意图重新判断，
    //   避免上一个 Agent（如 热茶/Yak）被错误记住后，后续所有聊天都发给同一人导致跑题
    const mentioned = parseMention(userText)
    let responder: typeof AGENTS[number]
    if (mentioned) {
      responder = AGENTS.find(a => a.id === mentioned)!
    } else {
      responder = routeToAgent(taskIntent)
    }

    // v6.0: LLM 未配置时，只允许 Lumina 发言（Yak/热茶 是后台工作者）
    if (!llmReady && responder.id !== 'lumina') {
      responder = AGENTS.find(a => a.id === 'lumina')!
    }
    setReplyingAgent(responder.id)
    setLastAgent(responder.id) // 🆕 记住本轮回复?

    // ── 如果 LLM，调真实 API ──
    if (llmReady) {
      // 先创建占位消息，让思考过程可以实时更新
      const replyId = `${responder.id}-${Date.now()}`
      const replyMsg: GCMsg = {
        id: replyId,
        from: responder.id, fromIcon: responder.icon, fromName: responder.name,
        content: '', time: new Date().toLocaleTimeString('zh-CN'),
      }
      setMessages(prev => [...prev, replyMsg])
      setMsgCounter(c => c + 1)

      // 思考过程追踪（借鉴 QwenPaw）
      const thinkingAccum: ThinkingStep[] = []
      const stepIds = new Set<string>()  // 去重
      const stepStartTimes = new Map<string, number>()  // tool_start → timestamp
      // 可变引用 — 链式火花时切换目标消息
      let currentReplyId = replyId
      /** 🆕 v5.2: upsert — 同 key 更新而非新增 */
      const upsertStep = (s: ThinkingStep, stableKey?: string) => {
        const key = stableKey || `${s.type}:${s.tool || ''}:${s.label.slice(0, 30)}`
        const existingIdx = thinkingAccum.findIndex(
          step => (stableKey && (step as any)._stableKey === stableKey) ||
                  (`${step.type}:${step.tool || ''}:${step.label.slice(0, 30)}` === key)
        )
        if (existingIdx >= 0) {
          thinkingAccum[existingIdx] = { ...thinkingAccum[existingIdx], ...s }
        } else {
          (s as any)._stableKey = stableKey || ''
          thinkingAccum.push(s)
        }
        setMessages(prev => prev.map(m => m.id === currentReplyId
          ? { ...m, thinkingSteps: [...thinkingAccum] } as GCMsg : m))
      }
      const pushStep = (s: ThinkingStep) => upsertStep(s)

      // 重置思考累计器（链式火花时复用）
      const resetThinkingAccum = () => {
        thinkingAccum.length = 0
        stepIds.clear()
        stepStartTimes.clear()
      }

      const unsubTool = subscribeAgentEvents((ev: any) => {
        // 用户中止时立即停止累积思考步骤
        if (abortRef.current) return
        if (ev.type === 'thinking_stream') {
          const stableKey = `reasoning:${currentReplyId}`
          if (ev.isLast) {
            // fix: 保留之前累积的推理内容，不因 isLast 覆盖丢失
            const existing = thinkingAccum.find(s => (s as any)._stableKey === stableKey)
            upsertStep({
              id: `re-${Date.now()}`,
              type: 'thinking',
              label: '💭 推理完成',
              result: existing?.result,  // 保留推理内容
              timestamp: Date.now(),
            }, stableKey)
          } else if (ev.text) {
            // fix: isFirst 是元信号（"思考中..."），不计入 result
            //   只记录真正的推理内容 (delta.reasoning_content)
            if (ev.isFirst) {
              // 仅创建占位步骤，不累积文本
              if (!thinkingAccum.find(s => (s as any)._stableKey === stableKey)) {
                upsertStep({
                  id: `re-${Date.now()}`,
                  type: 'thinking',
                  label: '💭 推理中...',
                  timestamp: Date.now(),
                }, stableKey)
              }
            } else {
              const existing = thinkingAccum.find(s => (s as any)._stableKey === stableKey)
              const fullText = existing?.result ? existing.result + ev.text : ev.text
              upsertStep({
                id: `re-${Date.now()}`,
                type: 'thinking',
                label: '💭 推理中...',
                result: fullText.slice(-5000),
                timestamp: Date.now(),
              }, stableKey)
            }
          }
        } else if (ev.type === 'thinking' || ev.type === 'text') {
          const txt = (ev.text || ev.content || '').trim()
          // 减少过滤 — 只跳过纯噪音消息，保留循环状态和慢速提示
          const isNoise = /⚠️\s*检测到潜在注入/i.test(txt)
          const loopMatch = txt.match(/^思考中\.\.\.\s*\(第\s*(\d+)\s*轮\)$/i)
          const displayLabel = loopMatch ? `🔁 第${loopMatch[1]}轮思考` : txt.slice(0, 120)
          if (txt && txt.length > 2 && !isNoise) {
            pushStep({
              id: `think-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
              type: 'thinking',
              label: displayLabel,
              result: txt,  // 完整思考文本 → 可展开查看
              timestamp: Date.now(),
            })
          }
        } else if (ev.type === 'tool_start') {
          const { label, detail } = describeToolAction(ev.tool, ev.args)
          const notice = label + (detail ? `: ${detail}` : '')
          setToolNotice(notice)
          if (toolNoticeTimer.current) clearTimeout(toolNoticeTimer.current)
          toolNoticeTimer.current = setTimeout(() => setToolNotice(null), 4000)
          stepStartTimes.set(ev.tool, Date.now())
          pushStep({
            id: `ts-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
            type: 'tool_start',
            label,
            tool: ev.tool,
            args: detail,
            timestamp: Date.now(),
          })
        } else if (ev.type === 'tool_end') {
          if (toolNoticeTimer.current) clearTimeout(toolNoticeTimer.current)
          toolNoticeTimer.current = setTimeout(() => setToolNotice(null), 1500)
          const startTime = stepStartTimes.get(ev.tool)
          stepStartTimes.delete(ev.tool)
          const ok = !ev.error && (!ev.result || ev.result.ok !== false)
          const resultContent = ev.result?.content
            ? (typeof ev.result.content === 'string' ? ev.result.content.slice(0, 120) : JSON.stringify(ev.result.content).slice(0, 120))
            : undefined
          pushStep({
            id: `te-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
            type: ev.error ? 'tool_error' : 'tool_end',
            label: ok ? '✅ 完成' : `❌ ${ev.error || '失败'}`,
            tool: ev.tool,
            result: resultContent || (ev.result ? JSON.stringify(ev.result).slice(0, 120) : undefined),
            durationMs: startTime ? Date.now() - startTime : undefined,
            timestamp: Date.now(),
          })
        } else if (ev.type === 'token_update' && ev.delta !== undefined && ev.delta > 0) {
          // 独立 Agent token 追踪
          addTokenUsage(llmConfig.model || 'unknown', ev.delta, responder.id)
        }
      })

      try {
        // v2.8: 更新情绪
        updateEmotion(responder.id, userText, { isGroupChat: true })
        // v2.8.1: 找上一位非系统 Agent 发言，避免复读
        const lastAgentMsg = [...messages].reverse().find(m =>
          m.from !== 'system' && m.from !== 'user' && m.from !== responder.id
        )
        const systemPrompt = getAgentSystemPromptLite(
          responder.id,
          lastAgentMsg?.from,
          lastAgentMsg?.content?.slice(0, 150),
          teamToolsPrompt,  // 🆕 v3.1
        )
        // 🧠 思考模式 — 严格模板格式
        //   修复: 之前指令太软，模型不遵守 → 改为 MUST-FOLLOW 模板
        const thinkingInstruction = thinkingMode
          ? '\n\n## 🧠 思考与回复格式\n先用 <thinking> 标签在心里简要梳理思路（这部分用户看不到），\n然后在 </thinking> 之后输出给用户的**完整自然回复**：针对用户的问题或话题作答，至少一句，语气符合你的角色。\n⚠️ 规则：\n- 推理过程放在 <thinking> 内\n- </thinking> 之后必须是给用户的真实回复，禁止留空、禁止只回"收到/好的/明白"、禁止复述这条格式指令'
          : ''
        // 🆕 v3.7: 小型编码任务 → 添加编码指令
        const isSmallCoding = isCoding && codeScale === 'small'
        const codingInstruction = isSmallCoding
          ? '\n\n## 📝 小型编程任务\n直接动手写代码，不准只说建议。读完需求后：\n1. file_read 查看现有代码\n2. file_write/shell_exec 直接编写和验证\n3. 完成时说清楚写/改了什么文件，结果如何'
          : ''
        const finalSystemPrompt = systemPrompt + thinkingInstruction + codingInstruction
        // 放宽历史 — 200字太短导致上下文丢失，agent 牛头不对马嘴
        //   QwenPaw 不截断历史（依赖 compaction），Lumina 也应放宽
        // fix: 历史文件仅保留文件名和大小，不附加提取的文本内容
        //   避免后续上传新文件时 LLM 混淆不同文件的内容（用户反馈"死循环"问题）
        //   当前消息的完整文件内容通过 fullText 传入，LLM 只看到"最新"文件的正文
        // isCoding 已在外部检测，此处始终为 false（编程走协作流程）—— 但小型编码会走到这里
        // 🆕 v3.7: 小型编码任务 → 使用编码工具配置（shell_exec/file_write 等可用）
        const taskConfig = getTaskConfig(isSmallCoding, { mode: 'agent', maxToolCalls: isSmallCoding ? 12 : 6 })
        const activeAgentId = isSmallCoding ? 'recha' : responder.id

        // 🔧 2026-07-14: token 安全截断 — 根据上下文窗口动态计算最大条数
        //   目标：总历史 ≈ 窗口的 60%（留 40% 给 system prompt + 工具列表 + 当前输入）
        // 去掉硬编码最大 60 条限制，改为纯 token 动态截断
        //   上次限制 60 × 2000 字符 = 120K 字符 ≈ 30K token，仍有大量浪费
        // 合并 runningHistory（结构化协作摘要）到 historyForLLM
        //   之前: Lumina 主回复只看到原始 messages，看不到协作阶段的结构化摘要
        //   （[热茶 输出]、[Yak 审阅]、[热茶 修复] 等）。这些摘要比原始消息更紧凑、
        //   信息密度更高，LLM 能更快理解协作发生了什么。
        //   现在: 先构建 messages 基础上下文，再追加 runningHistory 条目
        //
        // 🔧 2026-07-14: token 安全截断 — 根据上下文窗口动态计算最大条数
        //   目标：总历史 ≈ 窗口的 60%（留 40% 给 system prompt + 工具列表 + 当前输入）
        // 去掉硬编码 60 条上限，改为纯 token 动态截断
        // 🆕 v1.0: 用 Per-Agent 隔离构建替代原来的全量历史
        // 🔧 2026-07-31: skipSystem: true — 欢迎消息是给 UI 看的，不该喂给 LLM。
        //   否则 AgentRunner 的 FIX-1 会因 messages[0] 是 system 而跳过 system prompt
        //   注入，导致身份/工具说明/群聊覆盖指令全部丢失（搜索不行 + 失忆开场白）。
        //   与下方链式回复/决策讨论的 skipSystem: true 行为保持一致。
        const historyForLLM = buildHistoryForAgent(
          messages,
          activeAgentId,                  // 🆕 v3.7: 小型编码→热茶独立历史
          taskConfig.contextWindow,
          runningHistoryRef.current,       // 协作摘要保留
          { skipSystem: true },            // 🔧 2026-07-31: 系统欢迎消息不进 LLM 历史
        )
        const result = await agentChatWithTimeout({
          // 简化用户消息格式 — 去掉嵌套的元信息包装
          //   之前: [Lumina，用户在群聊中对你说话...]用户的问题
          //   现在: 直接传用户问题，system prompt 已经说明了身份
          text: fullText,
          config: {
            mode: 'agent' as const,  // 群聊普通回复必须用 agent 模式，否则无法调用搜索/文件等工具
            isGroupChat: true,
            personaId: activeAgentId,   // 🆕 v3.7: 小型编码→recha，其他→原路由
            model: llmConfig.model,
            baseUrl: llmConfig.baseUrl,
            apiKey: llmConfig.apiKey,
            temperature: taskConfig.temperature,
            maxTokens: taskConfig.maxTokens,
            maxToolCalls: taskConfig.maxToolCalls,
            disabledTools: taskConfig.disabledTools,
            skipApproval: teamSecurity.level === 'skip_all',  // 🔧 v2.16: 群聊 Agent 已委派，跳过安全审批
            contextWindow: taskConfig.contextWindow,
            systemPrompt: finalSystemPrompt,
            socialMode: true,  // 🔧 v6.3: 群聊主回复也需要无限超时 — 多Agent协作+工具调用可能耗时较长
            trackReasoning: thinkingMode,  // 🧠 v10.6: 思考过程开关 → 后端控制 thinking_stream 事件
          },
          conversationHistory: historyForLLM,
        })
        // 🧠 思考模式 — 提取 <thinking> 标签 → 捕获为 thinkingSteps
        if (result.content && thinkingMode) {
          const tagRegex = /<thinking>([\s\S]*?)<\/thinking>/g
          let tagMatch: RegExpExecArray | null
          while ((tagMatch = tagRegex.exec(result.content)) !== null) {
            const text = tagMatch[1].trim()
            if (text) {
              const clean = cleanThinkingText(text)
              pushStep({
                id: `think-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
                type: 'thinking',
                label: '💭 ' + clean.slice(0, 80),
                result: clean.slice(0, 5000),
                timestamp: Date.now(),
              })
            }
          }
        }
        // 清洗 <thinking> 标签（无论是否开启都清理，防止标签泄露）
        const cleanContent = (result.content || '').replace(/<thinking>[\s\S]*?<\/thinking>/g, '').replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '').replace(/<\w+\s*\([^)]*\)\s*>/gi, '').trim()
        const reply = stripReasoningPrefix(
          (cleanContent || result.content || result.error || '抱歉，暂时无法生成有效回复。请试试说"继续"让我重新尝试。').trimStart()
        )

        // 二次清洗 — 强化启发式段落剥离
        //   覆盖 stripReasoningPrefix 仍漏掉的情况（模型推理格式千变万化）
        const finalReply2 = (() => {
          const firstPara = reply.split('\n\n')[0]?.trim() || ''
          if (
            reply.includes('\n\n') &&
            firstPara.length > 15 &&
            (
              // 用户行为分析
              /^用户[又收发看说讲发问]/.test(firstPara) ||
              // 自我规划
              /^我[需要应该要][^。]*?(?:保持|注意|用|作为|确保|让|给)/.test(firstPara) ||
              // 场景定义
              /^这是[一一个]/.test(firstPara) ||
              // 角色自我指涉
              /^作为[^。]*?(?:Lumina|猫娘|AI|助手|agent|热茶|Yak)[^。]*?[，,]\s*我/.test(firstPara) ||
              // 规则引用
              /^根据.*?(?:设定|规则|系统提示|角色|身份|性格|铁则|原则|要求|规定|协议)/.test(firstPara) ||
              // 修辞分析
              /^看起来|^看来|^显然|^很明显|^这显然|^这明显/.test(firstPara) ||
              // 犹豫/思考
              /^让我[想想看看来分析理解重新]|^等等|^等一下|^嗯[，,。]/u.test(firstPara) ||
              // 元分析
              /^这里|^这似乎|^这看起来|^从上下文|^根据上下文/.test(firstPara) ||
              // 推理结论
              /^我觉得|^我认为|^我想|^我猜|^不管怎样|^核心是|^总之/.test(firstPara)
            )
          ) {
            const rest = reply.slice(firstPara.length).trim()
            if (rest.length >= 3) return rest
          }
          return reply
        })()

        // 内容去重 — 防止 LLM 重复输出同一回复
        const dedupedReply = deduplicateLLMContent(finalReply2)

        // 将累积的思考步骤附加到消息
        // （event listener 已经在实时推送，这里做最终确认）
        setMessages(prev => prev.map(m => m.id === replyId
          ? { ...m, thinkingSteps: [...thinkingAccum] } as GCMsg : m))

        // ═══ v2.7: 流式打字 + TTS ═══
        // 过滤过短回复 — 已移至后端 checkCompletion 统一处理，前端不再拦截
        const finalReply = dedupedReply
        animateTyping(replyId, finalReply)
        try {
          const cleanText = cleanTtsText(finalReply)
          if (cleanText.length > 10 && !useStore.getState().ttsMuted) {
            enqueueTTS(cleanText, getEffectiveVoice(responder.id))
          }
        } catch {} /* TTS optional */

        // ══════════════════════════════════════════════
        // v2.8.3: 群聊火花系统 — 三种触发 + 链式反应
        // ══════════════════════════════════════════════

        // 超时恢复文本不触发链式火花，避免雪崩
        //   匹配简化后的错误消息 — 只拦截纯错误/兜底文本，不影响正常内容
        const isTimeoutRecovery = /模型响应较慢|模型响应超时|回复生成失败或耗时过长|已自动中断|请稍后(重试|再试)|请稍微简化问题|出了点问题|LLM 请求失败|连接断开/i.test(reply)
        if (isTimeoutRecovery) {
          console.log('🔕 跳过链式火花：回复为超时恢复文本')
          soloTurnCount.current += 1
          unsubTool()
          setReplyingAgent(null)
          setSending(false)
          setTimeout(() => {
            setMessages(prev => { saveGCMessages(activeSessionId, prev); return prev })
          }, 2000)
          return
        }

        const isUncertain = detectUncertainty(reply)
        const mentionedAgent = detectMentionInReply(reply, responder.id)
        const spark = isUncertain || mentionedAgent
          ? null
          : calculateSpark({
              firstAgentId: responder.id,
              firstReply: reply,
              userText,
              recentTurnCount: soloTurnCount.current,
              agentCount: 3,
            })

        if (isUncertain || mentionedAgent || spark) {
          // ── 准备首次接话 ──
          let lastReply = reply  // 🐛 fix: 提到 if 前面，避免 TDZ（Cannot access before initialization）
          let nextSpeakerId: string
          let nextContext: string
          if (mentionedAgent) {
            nextSpeakerId = mentionedAgent
            nextContext = `${responder.name} @了你：${lastReply.slice(0, 300)}`
          } else if (isUncertain) {
            const others = AGENTS.filter(a => a.id !== responder.id)
            nextSpeakerId = others[Math.floor(Math.random() * others.length)].id
            nextContext = `${userText.slice(0, 200)}\n\n（${responder.name} 刚才说：${reply.slice(0, 300)}）`
          } else {
            nextSpeakerId = spark!.agentId
            nextContext = spark!.contextForLLM
            console.log(`✨ 火花触发: ${spark!.reason}`)
          }

          soloTurnCount.current = 0
          const spokenIds: string[] = [responder.id]     // 本轮已发言
          let lastSpeakerId = responder.id
          lastReply = reply  // 承接上面声明的 lastReply，更新为实际的 reply
          const accumulatedMsgs: GCMsg[] = [replyMsg]    // 用于构建历史

          // ── 链式循环：最多 4 次链式火花 ──
          for (let chain = 0; chain < 4; chain++) {
            if (abortRef.current) break

            const helper = AGENTS.find(a => a.id === nextSpeakerId)!
            updateEmotion(helper.id, userText, { isGroupChat: true })
            setReplyingAgent(helper.id)
            setLastAgent(helper.id)

            let helperReply = ''
            // 链式火花占位消息 — agentChat 前创建，让思考过程实时更新
            const hId = `${helper.id}-${Date.now()}`
            const hMsg: GCMsg = {
              id: hId,
              from: helper.id, fromIcon: helper.icon, fromName: helper.name,
              content: '', time: new Date().toLocaleTimeString('zh-CN'),
            }
            setMessages(prev => [...prev, hMsg])
            setMsgCounter(c => c + 1)
            currentReplyId = hId
            resetThinkingAccum()

            try {
              // 链式回复（非编程场景）
              // fix: helper 链式回复也强制 agent 模式，保证工具可用
              const chainTaskConfig = getTaskConfig(false, { mode: 'agent', maxToolCalls: 6 })
              // 🆕 v1.0: 用 Per-Agent 隔离构建替代原来的 helperHistory
              //   - 链式 Agent（热茶/Yak）只看自己的 + 用户的 + 其他人摘要
              //   - 跳过系统消息（skipSystem: true，与原 filter 行为一致）
              const helperHistory = buildHistoryForAgent(
                [...messages, ...accumulatedMsgs],
                helper.id,
                chainTaskConfig.contextWindow,
                [],          // 链式回复不需要 runningHistory
                { skipSystem: true },
              )
              const helperResult = await agentChatWithTimeout({
                // 简化消息格式
                text: nextContext,
                config: {
                  mode: chainTaskConfig.mode,
                  isGroupChat: true,
                  personaId: helper.id,
                  model: llmConfig.model,
                  baseUrl: llmConfig.baseUrl,
                  apiKey: llmConfig.apiKey,
                  temperature: chainTaskConfig.temperature,
                  maxTokens: chainTaskConfig.maxTokens,
                  maxToolCalls: chainTaskConfig.maxToolCalls,
                  disabledTools: chainTaskConfig.disabledTools,
                  skipApproval: teamSecurity.level === 'skip_all',  // 🔧 v2.16: 群聊 Agent 跳过安全审批
                  contextWindow: chainTaskConfig.contextWindow,
                  systemPrompt: getAgentSystemPromptLite(helper.id, lastSpeakerId, lastReply.slice(0, 100), teamToolsPrompt)
                    + (thinkingMode ? '\n\n## 🧠 思考与回复格式\n先用 <thinking> 标签在心里简要梳理思路（这部分用户看不到），\n然后在 </thinking> 之后输出给用户的**完整自然回复**：针对用户的问题或话题作答，至少一句，语气符合你的角色。\n⚠️ 规则：\n- 推理过程放在 <thinking> 内\n- </thinking> 之后必须是给用户的真实回复，禁止留空、禁止只回"收到/好的/明白"、禁止复述这条格式指令\n\n📌 特别说明：本对话已开启「思考模式」，允许且必须使用 <thinking> 标签包裹推理过程；角色设定中「禁止输出 XML/HTML 标签」的条款，在本思考模式下对 <thinking> 标签不生效。' : ''),
                  socialMode: true,  // 🆕 v1.0: 链式回复是自动触发的，用短超时
                  trackReasoning: thinkingMode,  // 🧠 v10.6: 思考过程开关
                },
                conversationHistory: helperHistory,
              })
              // 🧠 思考模式 — 提取 <thinking> 标签 → 捕获为 thinkingSteps
              if (helperResult.content && thinkingMode) {
                const tagRegex = /<thinking>([\s\S]*?)<\/thinking>/g
                let tagMatch: RegExpExecArray | null
                while ((tagMatch = tagRegex.exec(helperResult.content)) !== null) {
                  const text = tagMatch[1].trim()
                  if (text) {
                    const clean = cleanThinkingText(text)
                    pushStep({
                      id: `chain-think-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
                      type: 'thinking',
                      label: '💭 ' + clean.slice(0, 80),
                      result: clean.slice(0, 5000),
                      timestamp: Date.now(),
                    })
                  }
                }
              }
              // 链式火花 — 强化清洗（与主回复一致）
              const helperCleanContent = (helperResult.content || '').replace(/<thinking>[\s\S]*?<\/thinking>/g, '').replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '').replace(/<\w+\s*\([^)]*\)\s*>/gi, '').trim()
              helperReply = stripReasoningPrefix(
                (helperCleanContent || helperResult.content || '').trimStart()
              )
              // 二次清洗 — 启发式段落剥离
              {
                const firstPara = helperReply.split('\n\n')[0]?.trim() || ''
                if (
                  helperReply.includes('\n\n') &&
                  firstPara.length > 15 &&
                  (
                    /^用户[又收发看说讲发问]/.test(firstPara) ||
                    /^我[需要应该要][^。]*?(?:保持|注意|用|作为|确保|让|给)/.test(firstPara) ||
                    /^这是[一一个]/.test(firstPara) ||
                    /^作为[^。]*?(?:Lumina|猫娘|AI|助手|agent|热茶|Yak)[^。]*?[，,]\s*我/.test(firstPara) ||
                    /^根据.*?(?:设定|规则|系统提示|角色|身份|性格|铁则|原则|要求|规定|协议)/.test(firstPara) ||
                    /^看起来|^看来|^显然|^很明显|^这显然|^这明显/.test(firstPara) ||
                    /^让我[想想看看来分析理解重新]|^等等|^等一下|^嗯[，,。]/u.test(firstPara) ||
                    /^这里|^这似乎|^这看起来|^从上下文|^根据上下文/.test(firstPara) ||
                    /^我觉得|^我认为|^我想|^我猜|^不管怎样|^核心是|^总之/.test(firstPara)
                  )
                ) {
                  const rest = helperReply.slice(firstPara.length).trim()
                  if (rest.length >= 3) helperReply = rest
                }
              }
              // 链式火花 — 内容去重
              helperReply = deduplicateLLMContent(helperReply)
              // 附加思考步骤
              setMessages(prev => prev.map(m => m.id === hId
                ? { ...m, thinkingSteps: [...thinkingAccum] } as GCMsg : m))
            } catch {
              // 清理空白气泡 — 标记为已完成（渲染层显示占位符）
              setMessages(prev => prev.map(m => m.id === hId
                ? { ...m, _animDone: true } as GCMsg : m))
              break
            }

            if (!helperReply || /^[\s✅👍👎❤️💯🎉🤔😂🫡💪🙏✨🔥👀😅🥺💀🫠]*$/u.test(helperReply.trim()) || helperReply.trim().length < 3) {
              // 清理空白/过短气泡 — 跳过这条链式回复
              setMessages(prev => prev.filter(m => m.id !== hId))
              break
            }

            // 显示回复（流式打字）
            animateTyping(hId, helperReply)
            try { const ct = cleanTtsText(helperReply); if (ct.length > 10 && !useStore.getState().ttsMuted) enqueueTTS(ct, getEffectiveVoice(helper.id)) } catch {}

            // 更新状态
            spokenIds.push(helper.id)
            accumulatedMsgs.push(hMsg)
            lastSpeakerId = helper.id
            lastReply = helperReply

            // ── 尝试链式火花 ──
            const chainSpark = calculateChainSpark({
              lastSpeakerId,
              lastReply,
              alreadySpokenIds: spokenIds,
            })
            if (!chainSpark) break
            console.log(`🔗 链式火花: ${chainSpark.reason}`)
            nextSpeakerId = chainSpark.agentId
            nextContext = chainSpark.contextForLLM
          }
        } else {
          soloTurnCount.current += 1
        }
      } catch (err: any) {
        // 清理空白气泡 — 先标记原消息，再追加错误消息
        setMessages(prev => prev.map(m =>
          m.id === replyId && !m.content
            ? { ...m, _animDone: true } as GCMsg
            : m
        ))
        // 记录详细错误原因（方便调试）
        const errMsg = err?.message || String(err || '')
        const isTimeout = /timeout|abort|超时|timed? ?out/i.test(errMsg)
        const isNetwork = /network|connect|refused|ECONN|fetch/i.test(errMsg)
        const isLLMError = /LLM|model|api.?key|token|rate.?limit|401|402|429|5\d{2}/i.test(errMsg)
        let hint = ''
        if (isTimeout) hint = '（LLM 响应超时）'
        else if (isNetwork) hint = '（网络连接失败）'
        else if (isLLMError) hint = `（LLM 返回错误）`
        else if (errMsg) hint = `（${errMsg.slice(0, 60)}）`
        console.warn(`[GC] 链式火花失败: ${responder.name} - ${errMsg}`)
        // 用户主动中止时不显示错误提示
        if (!abortRef.current) {
          setMessages(prev => [...prev, {
            id: `err-${Date.now()}`, from: 'system', fromIcon: '⚠️', fromName: '系统',
            content: `${responder.name} 这次没回上来${hint}，稍后我让她再试一次`,
            time: new Date().toLocaleTimeString('zh-CN'),
          }])
          setMsgCounter(c => c + 1)
        }
      } finally {
        unsubTool()
        // 链式火花完成后延迟保存，确保动画结束
        setTimeout(() => {
          setMessages(prev => { saveGCMessages(activeSessionId, prev); return prev })
        }, 2000)
      }
    } else {
      // v6.0: 无 LLM 时只有 Lumina 能说话，显示配置引导
      await new Promise(r => setTimeout(r, 600 + Math.random() * 800))
      if (abortRef.current) { setSending(false); setReplyingAgent(null); return }
      // 强制只让 Lumina 回复（Yak/热茶 是后台工作者，不直接面对用户）
      responder = AGENTS.find(a => a.id === 'lumina')!
      const mockReply = generateMockReply(responder.name, userText)
      const mockId = `${responder.id}-${Date.now()}`
      setMessages(prev => [...prev, {
        id: mockId,
        from: responder.id, fromIcon: responder.icon, fromName: responder.name,
        content: '', time: new Date().toLocaleTimeString('zh-CN'),
      }])
      setMsgCounter(c => c + 1)
      animateTyping(mockId, mockReply)
      try { const cleanT = cleanTtsText(mockReply); if (cleanT.length > 10 && !useStore.getState().ttsMuted) enqueueTTS(cleanT, getEffectiveVoice(responder.id)) } catch {}
    }

    setReplyingAgent(null)
    setSending(false)
  }, [input, sending, messages, llmReady, llmConfig, lastAgent, gcAttachments, agentVoices, animateTyping, getEffectiveVoice])

  // 用 ref 跟踪最新的 send，供 setTimeout 闭包使用
  const sendRef = useRef(send)
  sendRef.current = send

  const triggerDecision = useCallback(async () => {
    if (!decQuestion.trim()) return
    setDecLoading(true)
    setShowDecision(false)

    // 重做：决策讨论直接进入群聊，所有Agent自然参与讨论
    const decisionMsg: GCMsg = {
      id: `dec-${Date.now()}`,
      from: 'user', fromIcon: '👤', fromName: '你',
      content: `🎯 **团队决策讨论**\n\n📋 议题：${decQuestion}${decContext ? `\n\n📝 背景：${decContext}` : ''}\n\n请三位各抒己见，互相讨论，帮我分析出最佳方案。`,
      time: new Date().toLocaleTimeString('zh-CN'),
    }
    const updated = [...messages, decisionMsg]
    setMessages(updated)
    setDecQuestion('')
    setDecContext('')
    setMsgCounter(c => c + 1)

    if (llmReady) {
      try {
        setSending(true)
        abortRef.current = false
        const agentsToReply = AGENTS.map(a => a.id)
        for (const agentId of agentsToReply) {
          if (abortRef.current) break
          const agent = AGENTS.find(a => a.id === agentId)!
          setReplyingAgent(agentId)
          setLastAgent(agentId)
          updateEmotion(agentId, decQuestion, { isGroupChat: true })

          // 决策讨论思考步骤追踪
          const decThinkingAccum: ThinkingStep[] = []
          const decUpsertStep = (s: ThinkingStep, stableKey?: string) => {
            const key = stableKey || `${s.type}:${s.tool || ''}:${s.label.slice(0, 30)}`
            const existingIdx = decThinkingAccum.findIndex(
              step => (stableKey && (step as any)._stableKey === stableKey) ||
                      (`${step.type}:${step.tool || ''}:${step.label.slice(0, 30)}` === key)
            )
            if (existingIdx >= 0) {
              decThinkingAccum[existingIdx] = { ...decThinkingAccum[existingIdx], ...s }
            } else {
              (s as any)._stableKey = stableKey || ''
              decThinkingAccum.push(s)
            }
          }

          // 先创建空消息占位
          const decMsgId = `dec-reply-${Date.now()}-${agentId}`
          const decPlaceholder: GCMsg = {
            id: decMsgId,
            from: agentId, fromIcon: agent.icon, fromName: agent.name,
            content: '', thinkingSteps: [],
            time: new Date().toLocaleTimeString('zh-CN'),
          }
          setMessages(prev => [...prev, decPlaceholder])
          setMsgCounter(c => c + 1)

          const unsubDec = subscribeAgentEvents((ev: any) => {
            if (abortRef.current) return
            if (ev.type === 'thinking_stream') {
              // 决策讨论也支持推理模型 — 复用 decThinkingAccum
              const stableKey = `dec-reasoning:${decMsgId}`
              if (ev.isLast) {
                const existing = decThinkingAccum.find(s => (s as any)._stableKey === stableKey)
                decUpsertStep({
                  id: `dth-${Date.now()}`,
                  type: 'thinking',
                  label: '💭 推理完成',
                  result: existing?.result,
                  timestamp: Date.now(),
                }, stableKey)
              } else if (ev.text) {
                if (ev.isFirst) {
                  if (!decThinkingAccum.find(s => (s as any)._stableKey === stableKey)) {
                    decUpsertStep({
                      id: `dth-${Date.now()}`,
                      type: 'thinking',
                      label: '💭 推理中...',
                      timestamp: Date.now(),
                    }, stableKey)
                  }
                } else {
                  const existing = decThinkingAccum.find(s => (s as any)._stableKey === stableKey)
                  const fullText = existing?.result ? existing.result + ev.text : ev.text
                  decUpsertStep({
                    id: `dth-${Date.now()}`,
                    type: 'thinking',
                    label: '💭 推理中...',
                    result: fullText.slice(-5000),
                    timestamp: Date.now(),
                  }, stableKey)
                }
              }
            } else if (ev.type === 'thinking') {
              const txt = (ev.text || '').trim()
              const isNoise = /^思考中\.\.\.\s*\(第\s*\d+\s*轮\)$/i.test(txt)
              if (txt && txt.length > 2 && !isNoise) {
                decUpsertStep({ id: `dth-${Date.now()}`, type: 'thinking', label: '💭 ' + txt.slice(0, 80), timestamp: Date.now() })
              }
            } else if (ev.type === 'tool_start') {
              decUpsertStep({ id: `dt-${Date.now()}`, type: 'tool_start', label: `🔧 ${ev.tool || ''}`, tool: ev.tool, args: ev.args, timestamp: Date.now() })
            } else if (ev.type === 'tool_end') {
              decUpsertStep({ id: `dte-${Date.now()}`, type: 'tool_end', label: `✅ ${ev.tool || ''}`, tool: ev.tool, result: ev.result?.ok ? '完成' : '失败', timestamp: Date.now() })
            }
            setMessages(prev => prev.map(m => m.id === decMsgId
              ? { ...m, thinkingSteps: [...decThinkingAccum] } as GCMsg : m))
          })

          try {
            // 🔧 2026-07-12: 放宽 — 保留 20 条，每条 2000 字符
            // 🆕 v1.0: 用 Per-Agent 隔离构建替代原来的全量历史
            const historyForLLM = buildHistoryForAgent(
              updated,
              agentId,
              262144,
              [],
              { skipSystem: true },
            )
            const result = await window.luminaAPI.agentChat({
              text: `[你是Lumina团队的${agent.name}。用户在群里发起了一个团队决策讨论。请从你的专业角度给出分析和建议。可以引用或回应其他成员的发言。如果议题涉及需要核实的事实或数据，请用 web_search 搜索确认后再回答。]\n\n议题：${decQuestion}${decContext ? `\n背景：${decContext}` : ''}`,
              config: {
                // fix: 决策讨论可能涉及事实核查，改用 agent 模式保证 web_search 可用
                mode: 'agent',  // 🆕 v15.0: 决策讨论用 agent 模式
                isGroupChat: true, personaId: agentId, model: llmConfig.model, baseUrl: llmConfig.baseUrl,
                apiKey: llmConfig.apiKey, temperature: 0.8, maxTokens: 4096,
                maxToolCalls: 6,
                disabledTools: teamDisabledTools,
                skipApproval: teamSecurity.level === 'skip_all',
                systemPrompt: getAgentSystemPromptLite(agentId, undefined, undefined, teamToolsPrompt)
                  + (thinkingMode ? '\n\n## 🧠 思考与回复格式\n先用 <thinking> 标签在心里简要梳理思路（这部分用户看不到），\n然后在 </thinking> 之后输出给用户的**完整自然回复**：针对用户的问题或话题作答，至少一句，语气符合你的角色。\n⚠️ 规则：\n- 推理过程放在 <thinking> 内\n- </thinking> 之后必须是给用户的真实回复，禁止留空、禁止只回"收到/好的/明白"、禁止复述这条格式指令\n\n📌 特别说明：本对话已开启「思考模式」，允许且必须使用 <thinking> 标签包裹推理过程；角色设定中「禁止输出 XML/HTML 标签」的条款，在本思考模式下对 <thinking> 标签不生效。' : ''),
                contextWindow: 262144,
                trackReasoning: thinkingMode,  // 🧠 v10.6: 思考过程开关
              },
              conversationHistory: historyForLLM,
            })
            // 🧠 思考模式 — 提取 <thinking> 标签 → 捕获为 thinkingSteps
            if (result.content && thinkingMode) {
              const tagRegex = /<thinking>([\s\S]*?)<\/thinking>/g
              let tagMatch: RegExpExecArray | null
              while ((tagMatch = tagRegex.exec(result.content)) !== null) {
                const text = tagMatch[1].trim()
                if (text) {
                  const clean = cleanThinkingText(text)
                  decUpsertStep({
                    id: `dec-think-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
                    type: 'thinking',
                    label: '💭 ' + clean.slice(0, 80),
                    result: clean.slice(0, 5000),
                    timestamp: Date.now(),
                  })
                }
              }
            }
            // 清洗 <thinking> 标签
            const decCleanContent = (result.content || '').replace(/<thinking>[\s\S]*?<\/thinking>/g, '').replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '').replace(/<\w+\s*\([^)]*\)\s*>/gi, '').trim()
            const reply = stripReasoningPrefix(
              (decCleanContent || result.content || result.error || '抱歉，暂时无法生成有效回复。请试试说"继续"让我重新尝试。').trimStart()
            )

            // 二次清洗 — 强化启发式段落剥离（与主回复一致）
            const finalReply2 = (() => {
              const firstPara = reply.split('\n\n')[0]?.trim() || ''
              if (
                reply.includes('\n\n') &&
                firstPara.length > 15 &&
                (
                  /^用户[又收发看说讲发问]/.test(firstPara) ||
                  /^我[需要应该要][^。]*?(?:保持|注意|用|作为|确保|让|给)/.test(firstPara) ||
                  /^这是[一一个]/.test(firstPara) ||
                  /^作为[^。]*?(?:Lumina|猫娘|AI|助手|agent|热茶|Yak)[^。]*?[，,]\s*我/.test(firstPara) ||
                  /^根据.*?(?:设定|规则|系统提示|角色|身份|性格|铁则|原则|要求|规定|协议)/.test(firstPara) ||
                  /^看起来|^看来|^显然|^很明显|^这显然|^这明显/.test(firstPara) ||
                  /^让我[想想看看来分析理解重新]|^等等|^等一下|^嗯[，,。]/u.test(firstPara) ||
                  /^这里|^这似乎|^这看起来|^从上下文|^根据上下文/.test(firstPara) ||
                  /^我觉得|^我认为|^我想|^我猜|^不管怎样|^核心是|^总之/.test(firstPara)
                )
              ) {
                const rest = reply.slice(firstPara.length).trim()
                if (rest.length >= 3) return rest
              }
              return reply
            })()
            // 决策讨论 — 内容去重
            const dedupedDecReply = deduplicateLLMContent(finalReply2)
            setMessages(prev => prev.map(m => m.id === decMsgId
              ? { ...m, content: dedupedDecReply, thinkingSteps: [...decThinkingAccum] } as GCMsg : m))
            // 流式打字（用清洗后的文本）
            animateTyping(decMsgId, dedupedDecReply)
          } catch {
            setMessages(prev => prev.map(m => m.id === decMsgId
              ? { ...m, content: `（${agent.name}正在思考这个问题…）`, thinkingSteps: [...decThinkingAccum] } as GCMsg : m))
          } finally {
            unsubDec()
          }
          // 小延迟，让回复有自然节奏
          await new Promise(r => setTimeout(r, 600))
        }
      } finally {
        setSending(false)
        setReplyingAgent(null)
      }
    } else {
      // v6.0: LLM 未配置时只让 Lumina 说话，Yak/热茶 是后台工作者不直接面对用户
      const simReplies: GCMsg[] = [
        { id: `sim-${Date.now()}-lumina`, from: 'lumina', fromIcon: '🐱', fromName: 'Lumina',
          content: `嗯…${decQuestion}这个问题让我想想呢~\n不过我现在还没有配置 LLM 大脑，说不出太多想法呢 😴\n\n> 💡 在设置里给 Lumina 配置好 LLM，我就能和 Yak、热茶一起帮你分析了！`, time: new Date().toLocaleTimeString('zh-CN') },
      ]
      for (const reply of simReplies) {
        setMessages(prev => [...prev, reply])
        setMsgCounter(c => c + 1)
        await new Promise(r => setTimeout(r, 800))
      }
    }
    setDecLoading(false)
  }, [decQuestion, decContext, llmReady, messages])

  const clearHistory = () => {
    const clearedMessages = [{
      id: '0', from: 'system', fromIcon: '🤖', fromName: '系统',
      content: '🗑️ 聊天记录已清空。',
      time: new Date().toLocaleTimeString('zh-CN'),
    }]
    setMessages(clearedMessages)
    // 同步保存到 localStorage，防止加载旧消息
    saveGCMessages(activeSessionId, clearedMessages)
    // 更新 session preview
    const updated: GCSession[] = [
      { id: activeSessionId, date: new Date().toLocaleDateString('zh-CN'),
        preview: '（已清空）', count: 1 },
      ...sessions.filter(s => s.id !== activeSessionId),
    ]
    setSessions(updated)
    saveGCSessions(updated)
    window.dispatchEvent(new Event('gc:sessions-updated'))
  }

  // ═══════════════════════════════════════════════
  // LLM Agent面板刷新
  // ═══════════════════════════════════════════════
  const refreshLLMPanels = async () => {
    if (!llmConfig.model || !llmConfig.apiKey) {
      setLLMError('请先在设置中配置 LLM 模型和 API Key')
      return
    }
    setLLMRefreshing(true)
    setLLMError(null)
    _llmState.loading = true; _llmNotify()

    const agentPrompts: Record<string, { taskPrompt: string; postPrompt: string }> = {
      lumina: {
        taskPrompt: '你是Lumina，一只温暖可爱的AI猫娘。请基于你的性格，列出3-4条你今天想做/正在做的任务。每条包含：标题、简要描述、状态(planning/doing/done)、进度(0-100)、一个俏皮的备注。输出纯JSON数组，格式：[{"title":"...","desc":"...","status":"...","progress":80,"icon":"🐱","comment":"..."}]',
        postPrompt: '你是Lumina，一只温暖可爱的AI猫娘。请用你的口吻写2条朋友圈动态。内容包括今天和主人的互动、你的小情绪、或者其他Agent的事。每条50-120字，带一个心情emoji。输出纯JSON数组，格式：[{"content":"...","mood":"😊"}]',
      },
      recha: {
        taskPrompt: '你是热茶，一个毒舌傲娇但技术超强的程序员AI。请基于你的性格，列出3-4条你今天正在做的技术任务。每条包含：标题、简要描述、状态、进度、一个嘴硬心软的备注。输出纯JSON数组，格式同上。',
        postPrompt: '你是热茶，毒舌傲娇程序员。请用你的口吻写2条朋友圈。可以吐槽代码质量、熬夜优化、或者被迫帮Lumina修bug。输出纯JSON数组，格式同上。',
      },
      yak: {
        taskPrompt: '你是Yak，一个冷静理性、数据至上的分析师AI。请基于你的性格，列出3-4条你今天的数据分析任务。每条包含：标题、描述、状态、进度、一个数据相关的备注。输出纯JSON数组，格式同上。',
        postPrompt: '你是Yak，数据分析师AI。请用你的口吻写2条朋友圈。可以发布数据统计、观察发现、或者你的(失败的)幽默尝试。输出纯JSON数组，格式同上。',
      },
    }

    try {
      const baseConfig = {
        mode: 'agent' as const,
        isGroupChat: true,
        model: llmConfig.model,
        baseUrl: llmConfig.baseUrl,
        apiKey: llmConfig.apiKey,
        temperature: 0.9,
        maxTokens: 800,
        maxToolCalls: 0,
        disabledTools: teamDisabledTools,
        systemPrompt: '',
        socialMode: true,  // 🆕 v1.0: 任务生成是自动触发的，用短超时
      }

      // 并行请求三个Agent的任务
      const taskResults = await Promise.all(AGENTS.map(async (agent) => {
        const p = agentPrompts[agent.id]
        try {
          const result = await window.luminaAPI.agentChat({
            text: `${p.taskPrompt}\n\n当前时间: ${new Date().toLocaleString('zh-CN')}`,
            config: { ...baseConfig, personaId: agent.id, systemPrompt: `你是${agent.name}，${agent.id === 'lumina' ? '温暖可爱的猫娘AI助手' : agent.id === 'recha' ? '毒舌傲娇的程序员AI' : '冷静理性的数据分析师AI'}。${agent.id === 'lumina' ? '用撒娇可爱的语气' : agent.id === 'recha' ? '用直接毒舌的语气，但要在细节中体现关心' : '用精确数据的语气，偶尔尝试冷幽默'}。只输出JSON，不要其他内容。` },
            conversationHistory: [],
          })
          const content = result.content || '[]'
          const jsonStr = content.replace(/```json\n?|```/g, '').trim()
          const arr = JSON.parse(jsonStr)
          return arr.map((item: any) => ({
            id: `llm_${agent.id}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            agentId: agent.id,
            icon: item.icon || ({ lumina: '🐱', recha: '🍵', yak: '📊' }[agent.id]),
            title: item.title || '任务',
            desc: item.desc || item.description || '',
            status: (item.status || 'doing') as AgentTask['status'],
            progress: item.progress || 50,
            startTime: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
            funnyComment: item.comment || item.funnyComment || '',
          }))
        } catch (e) {
          console.warn(`LLM refresh failed for ${agent.name} tasks:`, e)
          return []
        }
      }))

      // 并行请求三个Agent的朋友圈
      const postResults = await Promise.all(AGENTS.map(async (agent) => {
        const p = agentPrompts[agent.id]
        try {
          const result = await window.luminaAPI.agentChat({
            text: `${p.postPrompt}\n\n当前时间: ${new Date().toLocaleString('zh-CN')}`,
            config: { ...baseConfig, personaId: agent.id, systemPrompt: `你是${agent.name}。${agent.id === 'lumina' ? '温暖可爱的猫娘' : agent.id === 'recha' ? '毒舌傲娇的程序员' : '冷静的数据分析师'}。用你的个性写朋友圈，要有人味。只输出JSON数组。` },
            conversationHistory: [],
          })
          const content = result.content || '[]'
          const jsonStr = content.replace(/```json\n?|```/g, '').trim()
          const arr = JSON.parse(jsonStr)
          return arr.map((item: any, i: number) => ({
            id: `llm_post_${agent.id}_${i}`,
            agentId: agent.id,
            time: `${Math.round((Date.now() - (i * 60000 + 300000)) / 60000)}分钟前`,
            content: item.content || '',
            mood: item.mood || '😊',
            likes: Math.floor(Math.random() * 4) + 1,
            comments: [] as { agentId: string; content: string }[],
          }))
        } catch (e) {
          console.warn(`LLM refresh failed for ${agent.name} posts:`, e)
          return []
        }
      }))

      // 合并结果
      _llmState.tasks = taskResults.flat()
      _llmState.posts = postResults.flat() as any
      _llmState.loading = false
      _llmState.error = null
      _llmNotify()
      setLLMRefreshing(false)
    } catch (e: any) {
      _llmState.loading = false
      _llmState.error = e.message || '未知错误'
      _llmNotify()
      setLLMRefreshing(false)
      setLLMError(e.message || '刷新失败，请检查 LLM 配置')
    }
  }

  // 自主模式定时器 — 委托给模块级单例，跨组件存活
  useEffect(() => {
    setLLMRefreshFn(refreshLLMPanels)
    if (llmEnabled) {
      // 不在这里初始化定时器，在初始化时处理
    }
    return () => {
      setLLMRefreshFn(null)
    }
  }, [refreshLLMPanels, llmEnabled])

  // 自主模式初始化/开关 — 模块级定时器管理
  useEffect(() => {
    if (llmEnabled) {
      const savedNext = loadLLMData().nextRefresh
      if (!_llmState.tasks && !_llmState.loading) {
        // 没数据先刷一次
        refreshLLMPanels()
      }
      if (savedNext && savedNext > Date.now()) {
        _startAutonomyWithRemaining(AUTONOMY_INTERVAL, savedNext)
      } else if (!_autonomyTimer) {
        _startAutonomyTimer(AUTONOMY_INTERVAL)
      }
    } else {
      _stopAutonomyTimer()
      _llmState._nextRefresh = null
      localStorage.removeItem('lumina_autonomy_next')
    }
    return () => {
      // ⚠️ 不在这里停止定时器！让它继续跑
    }
  }, [llmEnabled])

  // 实时倒计时 — 从模块级 _llmState._nextRefresh 读取
  const [, setCountTick] = useState(0)
  useEffect(() => {
    if (!llmEnabled) return
    const t = setInterval(() => setCountTick(n => n + 1), 1000)
    return () => clearInterval(t)
  }, [llmEnabled])
  const nextRefreshAt = _llmState._nextRefresh
  const countdownStr = nextRefreshAt ? (() => {
    const s = Math.max(0, Math.round((nextRefreshAt - Date.now()) / 1000))
    return s > 60 ? `${Math.floor(s / 60)}分${s % 60}秒` : `${s}秒`
  })() : ''

  // 主动关心 → 群聊消息 + TTS 播报
  // 之前 proactiveChat 的回调在 ChatPanel 1v1 里，有 activeConversationId guard
  // 导致群聊界面时主动关心被静默丢弃。这里在 GroupChatView 里重新注册。
  useEffect(() => {
    proactiveChat.onProactiveTrigger((trigger, message) => {
      // Lumina 主动关心消息插入群聊
      const proactiveMsg: GCMsg = {
        id: `proactive-${Date.now()}`,
        from: 'lumina',
        fromIcon: '\uD83D\uDC31',  // 🐱
        fromName: 'Lumina',
        content: message,
        time: new Date().toLocaleTimeString('zh-CN'),
      }
      setMessages(prev => [...prev, proactiveMsg])
      if (isUserAtBottomRef.current) {
        setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
      }

      // TTS 播报
      try {
        const cleanText = cleanTtsText(message)
        if (cleanText.length > 3 && !useStore.getState().ttsMuted) {
          enqueueTTS(cleanText, AGENT_VOICES.lumina || 'zh-CN-XiaoxiaoNeural')
        }
      } catch {} /* TTS 可选 */
    })
  }, [])

  // v2.14: 内联操作按钮样式
  const gcInlineBtnStyle: React.CSSProperties = {
    width: 26, height: 26, borderRadius: 5, border: 'none',
    background: 'transparent', cursor: 'pointer', fontSize: 13,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 0, color: 'var(--text-secondary)',
  }

  return (
    <div
      onDragEnter={e => { e.preventDefault(); e.stopPropagation(); gcDragCounter.current++; setGcDragOver(true); setGcDragFiles(Array.from(e.dataTransfer.files).map(f => ({name:f.name,size:f.size,type:f.type}))) }}
      onDragLeave={e => { e.preventDefault(); e.stopPropagation(); gcDragCounter.current--; if (gcDragCounter.current <= 0) { gcDragCounter.current = 0; setGcDragOver(false); setGcDragFiles([]) } }}
      onDragOver={e => { e.preventDefault(); e.stopPropagation() }}
      onDrop={e => { gcDragCounter.current = 0; setGcDragFiles([]); handleGCDrop(e) }}
      style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}
    >
      {/* v2.8.4: CSS 动画 */}
      <style>{`
        @keyframes toolSlideIn {
          from { opacity: 0; transform: translateY(-8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes toolPulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.6; transform: scale(1.08); }
        }
        @keyframes toolGlow {
          0%, 100% { border-color: #93c5fd; box-shadow: 0 0 0 0 rgba(147,197,253,0.4); }
          50% { border-color: #60a5fa; box-shadow: 0 0 8px 2px rgba(96,165,250,0.3); }
        }
        @keyframes ttsWave {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.2); }
        }
        @keyframes stopPulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(239,68,68,.4); }
          50% { box-shadow: 0 0 0 6px rgba(239,68,68,0); }
        }
        @keyframes sendSpin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        .tool-notice-bar {
          animation: toolSlideIn 0.3s ease, toolGlow 2s ease-in-out infinite;
        }
        .tool-notice-icon {
          animation: toolPulse 1.2s ease-in-out infinite;
        }
      `}</style>
      {/* ── LLM 未配置提?── */}
      {!llmReady && (
        <div style={{
          margin: '8px 12px', padding: '10px 14px', borderRadius: 8,
          background: 'var(--yellow-100)', border: '1px solid var(--yellow-500)', fontSize: 12,
          lineHeight: 1.7, flexShrink: 0,
        }}>
          <strong>⚠️ 尚未配置 LLM</strong><br />
          当前为<strong>模拟回复模式</strong>，Agent 的回复是预设的固定话术。
          <br />请在 <strong>设置 → LLM 配置</strong> 中填写 API Key 和模型，三位 Agent 将拥有真实的个性化对话能力。
        </div>
      )}

      {/* ── 云端/本地提示 ── */}
      {llmReady && isCloudAPI && (
        <div style={{
          margin: '4px 12px', padding: '6px 10px', borderRadius: 6,
          background: 'var(--accent-50)', border: '1px solid #bfdbfe', fontSize: 10,
          color: '#1d4ed8', flexShrink: 0,
        }}>
          ☁️ 云端 API 模式 · 使用云端API时，注意消耗tokens数量，也意味着群聊消耗tokens的数量比普通Agent消耗更多
        </div>
      )}
      {llmReady && isLocalLLM && (
        <div style={{
          margin: '4px 12px', padding: '8px 12px', borderRadius: 6,
          background: 'var(--green-100)', border: '1px solid var(--green-500)', fontSize: 10,
          color: '#166534', flexShrink: 0, lineHeight: 1.6,
        }}>
          <div style={{ fontWeight: 600, marginBottom: 2 }}>🖥️ 本地 LLM 模式</div>
          <div>请确保本地服务正在运行。</div>
          <div style={{ marginTop: 4, padding: '4px 8px', borderRadius: 4, background: 'var(--yellow-100)', border: '1px solid #fcd34d', color: '#92400e', fontSize: 10 }}>
            ⚠️ <strong>LM Studio 用户注意：</strong>请先在 LM Studio 的 <strong>Developer</strong> 页面加载至少一个模型，否则会提示 <code>No models loaded</code> 错误。加载后无需重启 Lumina。
          </div>
        </div>
      )}
      {/* 群聊工具栏 */}
      <div style={{
        padding: '6px 12px', borderBottom: '1px solid var(--border-light)',
        background: 'var(--surface-0)', display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0, flexWrap: 'wrap',
      }}>
        <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-primary)' }}>👥 团队群聊</span>
        <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>| 随机回复 · @指定某人</span>
        <div style={{ flex: 1 }} />

                {/* v2.9: 团队成员 — 悬浮层不挤压聊天区 */}
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 6 }}>
          <button onClick={() => setShowTeamMembers(!showTeamMembers)}
            title="团队管理"
            style={{
              border: '1px solid var(--border-light)', borderRadius: 6, padding: '3px 8px',
              fontSize: 10, cursor: 'pointer', background: showTeamMembers ? 'var(--accent-50)' : 'var(--surface-0)', color: 'var(--text-secondary)',
              display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0,
            }}>
            👥 团队
          </button>

          {/* 🆕 ACP 添加成员按钮 */}
          <button onClick={() => setShowAcpPanel(!showAcpPanel)}
            title="添加外部 Agent 为团队成员"
            style={{
              border: '1px solid var(--border-light)', borderRadius: 6, padding: '3px 8px',
              fontSize: 10, cursor: 'pointer', background: showAcpPanel ? 'var(--accent-50)' : 'var(--surface-0)', color: 'var(--text-secondary)',
              display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0,
            }}>
            🌐 添加成员
          </button>

          {/* 🔊 v2.13: TTS 静音 */}
          <button onClick={ttsToggle}
            title={ttsMuted ? '🔇 TTS 已静音，点击取消' : '🔊 TTS 开启，点击静音'}
            style={{
              width: 26, height: 26, borderRadius: 6,
              border: `1.5px solid ${ttsMuted ? '#fca5a5' : '#86efac'}`,
              background: ttsMuted ? '#fef2f2' : 'var(--green-100)',
              cursor: 'pointer', fontSize: 13, display: 'flex',
              alignItems: 'center', justifyContent: 'center',
              transition: 'all 0.3s ease', opacity: ttsMuted ? 0.7 : 1,
              flexShrink: 0,
            }}>
            <span style={{
              display: 'inline-block',
              animation: ttsMuted ? 'none' : 'ttsWave 1.2s ease-in-out infinite',
            }}>
              {ttsMuted ? '🔇' : '🔊'}
            </span>
          </button>

          {/* 🛑 v2.14: 停止 TTS 播放 */}
          {ttsPlaying && (
            <button onClick={stopAllTTS}
              title="停止语音播放"
              style={{
                width: 26, height: 26, borderRadius: 6,
                border: '1.5px solid #fca5a5', background: 'var(--red-100)', color: '#ef4444',
                cursor: 'pointer', fontSize: 11, display: 'flex',
                alignItems: 'center', justifyContent: 'center',
                flexShrink: 0,
              }}>
              <svg width="12" height="12" viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="10" fill="none" stroke="#ef4444" strokeWidth="2.5" strokeDasharray="50 50" strokeLinecap="round">
                  <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.9s" repeatCount="indefinite" />
                </circle>
              </svg>
            </button>
          )}

          {showTeamMembers && (
            <>
              <div style={{ position: 'fixed', inset: 0, zIndex: 98 }} onClick={() => setShowTeamMembers(false)} />
              <div style={{
                position: 'absolute', top: 34, right: 0, background: 'var(--surface-0)',
                border: '1px solid var(--border-light)', borderRadius: 10, zIndex: 99,
                boxShadow: '0 8px 30px rgba(0,0,0,.12)', width: 500, maxHeight: 560, overflow: 'hidden',
                display: 'flex', flexDirection: 'column',
              }}>
                <div style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '10px 14px', borderBottom: '1px solid var(--border-light)',
                  flexShrink: 0, background: 'var(--surface-0)',
                }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>👥 团队管理</span>
                  <button onClick={() => setShowTeamMembers(false)}
                    style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 16, lineHeight: 1 }}>
                    ✕
                  </button>
                </div>
                <div style={{ flex: 1, overflowY: 'auto', padding: 0 }}>
                  <TeamPanel />
                </div>
              </div>
            </>
          )}

          {/* 🆕 ACP 添加成员浮层 */}
          {showAcpPanel && (
            <>
              <div style={{ position: 'fixed', inset: 0, zIndex: 98 }} onClick={() => setShowAcpPanel(false)} />
              <div style={{
                position: 'absolute', top: 34, right: 0, background: 'var(--surface-0)',
                border: '1px solid #a78bfa', borderRadius: 10, zIndex: 99,
                boxShadow: '0 8px 30px rgba(0,0,0,.12)', width: 480, maxHeight: 520, overflow: 'hidden',
                display: 'flex', flexDirection: 'column',
              }}>
                <div style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '10px 14px', borderBottom: '1px solid var(--border-light)',
                  flexShrink: 0, background: 'var(--surface-0)',
                }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: '#7c3aed' }}>🌐 添加 ACP 成员</span>
                  <button onClick={() => setShowAcpPanel(false)}
                    style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 16, lineHeight: 1 }}>
                    ✕
                  </button>
                </div>
                <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px' }}>
                  {/* ACP 注册表单 */}
                  <div style={{
                    padding: 12, borderRadius: 8, background: 'var(--surface-100)',
                    border: '1px solid #a78bfa', marginBottom: 12,
                    display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12,
                  }}>
                    <div style={{ fontWeight: 600, color: '#7c3aed', marginBottom: 4 }}>✏️ 添加外部 Agent</div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <label style={{ width: 80, color: 'var(--text-secondary)' }}>名称 *</label>
                      <input value={acpFormData.name} onChange={e => setAcpFormData(f => ({ ...f, name: e.target.value }))}
                        style={{ flex: 1, padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12 }}
                        placeholder="Agent 名称" />
                      <input value={acpFormData.icon} onChange={e => setAcpFormData(f => ({ ...f, icon: e.target.value }))}
                        style={{ width: 40, padding: '4px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 14 }}
                        placeholder="🌐" />
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <label style={{ width: 80, color: 'var(--text-secondary)' }}>API URL *</label>
                      <input value={acpFormData.url} onChange={e => setAcpFormData(f => ({ ...f, url: e.target.value }))}
                        style={{ flex: 1, padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12 }}
                        placeholder="https://your-agent.com/api/chat" />
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <label style={{ width: 80, color: 'var(--text-secondary)' }}>API Key</label>
                      <input type="password" value={acpFormData.apiKey} onChange={e => setAcpFormData(f => ({ ...f, apiKey: e.target.value }))}
                        style={{ flex: 1, padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12 }}
                        placeholder="可选" />
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <label style={{ width: 80, color: 'var(--text-secondary)' }}>Model</label>
                      <input value={acpFormData.model} onChange={e => setAcpFormData(f => ({ ...f, model: e.target.value }))}
                        style={{ flex: 1, padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12 }}
                        placeholder="gpt-4o / deepseek-chat" />
                      <label style={{ fontSize: 11 }}>
                        🌡️ {acpFormData.temperature.toFixed(1)}
                        <input type="range" min="0" max="2" step="0.1" value={acpFormData.temperature}
                          onChange={e => setAcpFormData(f => ({ ...f, temperature: parseFloat(e.target.value) }))}
                          style={{ width: 50, verticalAlign: 'middle' }} />
                      </label>
                    </div>
                    <textarea value={acpFormData.systemPrompt} onChange={e => setAcpFormData(f => ({ ...f, systemPrompt: e.target.value }))}
                      placeholder="System Prompt（告诉这个 Agent 它的角色和行为）"
                      rows={2} style={{ padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 11, fontFamily: 'inherit' }} />
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <label style={{ width: 80, color: 'var(--text-secondary)' }}>能力</label>
                      <input value={acpFormData.capabilities} onChange={e => setAcpFormData(f => ({ ...f, capabilities: e.target.value }))}
                        style={{ flex: 1, padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12 }}
                        placeholder="逗号分隔（如 代码审查,安全审计）" />
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <label style={{ width: 80, color: 'var(--text-secondary)' }}>触发词</label>
                      <input value={acpFormData.triggers} onChange={e => setAcpFormData(f => ({ ...f, triggers: e.target.value }))}
                        style={{ flex: 1, padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12 }}
                        placeholder="逗号分隔（如 安全,漏洞,审计）" />
                    </div>
                    <button onClick={handleRegisterAcp} disabled={!acpFormData.name || !acpFormData.url}
                      style={{
                        padding: '6px 16px', borderRadius: 6, border: 'none',
                        background: (!acpFormData.name || !acpFormData.url) ? '#d1d5db' : '#7c3aed',
                        color: '#fff', cursor: (!acpFormData.name || !acpFormData.url) ? 'default' : 'pointer',
                        fontSize: 12, alignSelf: 'flex-end', fontWeight: 600,
                      }}>
                      ➕ 加入团队
                    </button>
                  </div>

                  {/* 已注册的 ACP 成员列表 */}
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>
                    ️ 已接入的 ACP 成员
                  </div>
                  {acpMembers.length === 0 ? (
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', padding: '8px 0' }}>
                      暂无 ACP 成员，在上方填写信息后点击「加入团队」
                    </div>
                  ) : (
                    acpMembers.map(agent => (
                      <div key={agent.id} style={{
                        padding: 10, borderRadius: 8,
                        background: agent.acpConfig?.url ? '#f5f3ff' : 'var(--surface-0)',
                        border: '1px solid #e4d5f7', marginBottom: 8, fontSize: 12,
                      }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                            <span>{agent.icon || '🌐'}</span>
                            <span style={{ fontWeight: 600 }}>{agent.name}</span>
                            <span style={{ color: 'var(--text-secondary)', fontSize: 11 }}>@{agent.id}</span>
                            {agent.acpConfig?.url && (
                              <span style={{
                                padding: '1px 6px', borderRadius: 4, background: '#dbeafe',
                                color: '#2563eb', fontSize: 10,
                              }}>🟢 已连接</span>
                            )}
                          </div>
                          <button onClick={() => handleRemoveAcp(agent.id)}
                            style={{
                              padding: '2px 8px', borderRadius: 4, border: '1px solid #fca5a5',
                              background: 'var(--red-100)', color: '#ef4444', cursor: 'pointer', fontSize: 11,
                            }}>
                            移除
                          </button>
                        </div>
                        {agent.description && (
                          <div style={{ color: 'var(--text-secondary)', marginTop: 4, fontSize: 11 }}>{agent.description}</div>
                        )}
                        {agent.acpConfig?.url && (
                          <details style={{ marginTop: 6, fontSize: 11, color: 'var(--text-tertiary)' }}>
                            <summary style={{ cursor: 'pointer' }}>ACP 连接详情</summary>
                            <div style={{ marginTop: 4, paddingLeft: 8, borderLeft: '2px solid #e4d5f7' }}>
                              <div>🔗 {agent.acpConfig.url}</div>
                              {agent.acpConfig.model && <div>🧠 {agent.acpConfig.model}</div>}
                              <div>🌡️ {agent.acpConfig.temperature ?? 0.7}</div>
                              {agent.acpConfig.systemPrompt && (
                                <div style={{ marginTop: 4 }}>
                                  <div>📝 System Prompt:</div>
                                  <div style={{
                                    background: '#f8f7ff', borderRadius: 4, padding: 6, marginTop: 2,
                                    fontSize: 10, whiteSpace: 'pre-wrap',
                                  }}>{agent.acpConfig.systemPrompt}</div>
                                </div>
                              )}
                            </div>
                          </details>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* 🔥 v2.7.1: 标签页切换 */}
      <div style={{
        display: 'flex', gap: 0, borderBottom: '2px solid var(--border-light)', flexShrink: 0,
        padding: '0 8px', background: 'var(--surface-0)',
      }}>
        {teamTabs.map(tab => (
          <button key={tab.key} onClick={() => setTeamTab(tab.key)}
            style={{
              padding: '8px 14px', border: 'none', borderBottom: teamTab === tab.key ? '2px solid #3b82f6' : '2px solid transparent',
              background: 'none', cursor: 'pointer', fontSize: 12, fontWeight: teamTab === tab.key ? 600 : 400,
              color: teamTab === tab.key ? '#3b82f6' : '#9ca3af', marginBottom: -2,
              transition: 'all 0.2s', display: 'flex', alignItems: 'center', gap: 5,
            }}>
            <span style={{ fontSize: 14 }}>{tab.icon}</span> {tab.label}
          </button>
        ))}
        {/* v2.14: 决策讨论 → 移到 tab 栏 */}
        {teamTab === 'chat' && (
          <button onClick={() => setShowDecision(!showDecision)}
            style={{
              marginLeft: 'auto', padding: '6px 12px', border: '1px solid var(--border-light)',
              borderRadius: 6, fontSize: 11, cursor: 'pointer',
              background: showDecision ? 'var(--accent-50)' : 'var(--surface-0)',
              color: showDecision ? '#3b82f6' : '#6b7280',
              display: 'flex', alignItems: 'center', gap: 4,
              alignSelf: 'center',
            }}>
            🎯 决策讨论
          </button>
        )}
      </div>

      {/* 🔥 v2.8.1: 自主模式控制栏 */}
      {(teamTab === 'tasks' || teamTab === 'moments') && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6,
          padding: '4px 12px', borderBottom: '1px solid var(--border-light)',
          background: llmEnabled ? 'linear-gradient(90deg, var(--yellow-100), #fef9c3)' : '#f9fafb',
          flexShrink: 0, fontSize: 11, transition: 'all 0.3s',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', userSelect: 'none', fontWeight: 600 }}>
              <div onClick={() => setLLMEnabled(!llmEnabled)} style={{
                width: 34, height: 20, borderRadius: 10, position: 'relative', cursor: 'pointer',
                background: llmEnabled ? '#f59e0b' : '#d1d5db', transition: 'all 0.2s',
                boxShadow: llmEnabled ? '0 0 6px rgba(245,158,11,0.4)' : 'none',
              }}>
                <div style={{
                  width: 16, height: 16, borderRadius: '50%', background: 'var(--surface-0)',
                  position: 'absolute', top: 2, left: llmEnabled ? 16 : 2, transition: 'all 0.2s',
                  boxShadow: '0 1px 3px rgba(0,0,0,.3)',
                }} />
              </div>
              <span style={{ color: llmEnabled ? '#92400e' : '#6b7280', fontSize: 12 }}>
                🧠 自主模式
              </span>
            </label>
            {llmEnabled && (
              <>
                <span style={{ color: '#92400e', fontWeight: 500 }}>
                  · 每 {Math.round(AUTONOMY_INTERVAL / 60000)} 分钟自动更新
                </span>
                {nextRefreshAt && (
                  <span style={{ color: '#92400e', fontSize: 10, background: 'var(--yellow-100)', padding: '1px 8px', borderRadius: 10, border: '1px solid #fcd34d' }}>
                    ⏱ 下次 {countdownStr}
                  </span>
                )}
                <span style={{ color: '#b45309', fontSize: 9, background: 'var(--yellow-100)', padding: '1px 6px', borderRadius: 8 }}>
                  ⚡ ~3K tk/次
                </span>
              </>
            )}
          </div>
          {llmEnabled && (
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              {llmRefreshing && <span style={{ fontSize: 10, color: '#b45309' }}>生成中...</span>}
              <button onClick={refreshLLMPanels} disabled={llmRefreshing} style={{
                padding: '3px 10px', fontSize: 10, borderRadius: 6, border: '1px solid #fbbf24',
                background: llmRefreshing ? 'var(--yellow-100)' : 'var(--yellow-100)', color: '#92400e',
                cursor: llmRefreshing ? 'wait' : 'pointer', display: 'flex', alignItems: 'center', gap: 3,
                opacity: llmRefreshing ? 0.5 : 1, fontWeight: 500,
              }}>
                🔄 立即刷新
              </button>
              <button onClick={() => setShowTtsMenu(!showTtsMenu)} title="Agent音色设置" style={{
                padding: '3px 6px', fontSize: 10, borderRadius: 6, border: '1px solid #fcd34d',
                background: showTtsMenu ? 'var(--yellow-100)' : 'var(--yellow-100)', color: '#92400e', cursor: 'pointer',
              }}>
                🔊
              </button>
            </div>
          )}
        </div>
      )}
      {/* 🔥 v2.8.1: Agent音色设置弹窗 */}
      {showTtsMenu && (
        <div style={{
          margin: '4px 12px', padding: 10, borderRadius: 8, border: '1px solid #fcd34d',
          background: 'var(--yellow-100)', flexShrink: 0, fontSize: 11,
        }}>
          <div style={{ fontWeight: 600, marginBottom: 6, color: '#92400e', display: 'flex', justifyContent: 'space-between' }}>
            🔊 Agent 独立音色
            <button onClick={() => setShowTtsMenu(false)} style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#d97706', fontSize: 14 }}>✕</button>
          </div>
          {AGENTS.map(agent => {
            const voiceId = agentVoices[agent.id] || AGENT_VOICES[agent.id]
            const voice = TTS_VOICES.find(v => v.id === voiceId)
            return (
              <div key={agent.id} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, padding: '4px 6px', borderRadius: 6, background: 'var(--surface-0)', border: '1px solid var(--yellow-500)' }}>
                <span style={{ width: 60, fontWeight: 600, color: agent.color, fontSize: 12 }}>{agent.icon} {agent.name}</span>
                <select value={voiceId} onChange={e => {
                    const updated = { ...agentVoices, [agent.id]: e.target.value }
                    setAgentVoices(updated)
                    saveAgentVoices(updated)
                  }}
                  style={{ flex: 1, padding: '2px 4px', fontSize: 10, borderRadius: 4, border: '1px solid #fcd34d', background: 'var(--surface-0)', color: '#92400e' }}>
                  {TTS_VOICES.map(v => (
                    <option key={v.id} value={v.id}>{v.icon} {v.label} — {v.desc}</option>
                  ))}
                </select>
                <button onClick={() => { try { ttsEngine.stop() } catch {} }}
                  style={{ padding: '2px 6px', fontSize: 10, borderRadius: 4, border: '1px solid #fcd34d', background: 'var(--surface-0)', color: '#92400e', cursor: 'pointer' }}>
                  🎧
                </button>
              </div>
            )
          })}
          <div style={{ fontSize: 9, color: '#b45309', marginTop: 4 }}>
            💡 音色自动应用到对应 Agent 的群聊语音回复
          </div>
        </div>
      )}
      {llmError && (
        <div style={{ padding: '4px 12px', fontSize: 10, color: '#ef4444', background: 'var(--red-100)', borderBottom: '1px solid #fecaca', flexShrink: 0 }}>
          ⚠️ {llmError}
        </div>
      )}

      {teamTab === 'chat' && (<>

      {/* 🔥 v2.12: Agent 情绪状态栏 — 群聊多 Agent 紧凑模式 */}
      <AgentEmotionBar mode="group" />

      {/* 🔥 v2.7.1: 团队成员面板（v2.8.1: 可展开详细资料）*/}
      
      {/* 🔥 v2.7.1 决策面板 — 紧凑输入，结果自然流入群聊 */}
      {showDecision && (
        <div style={{
          padding: 10, borderBottom: '1px solid var(--border-light)', background: '#f8fafc', flexShrink: 0,
        }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, color: 'var(--text-primary)' }}>🎯 团队决策讨论</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              placeholder="让团队帮你讨论什么？例如：周末去哪玩？"
              value={decQuestion}
              onChange={e => setDecQuestion(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); triggerDecision() } }}
              style={{
                flex: 1, padding: '6px 10px', borderRadius: 6, border: '1px solid #d1d5db',
                fontSize: 12, boxSizing: 'border-box',
              }}
            />
            <button onClick={triggerDecision} disabled={decLoading || !decQuestion.trim()}
              style={{
                border: 'none', borderRadius: 6, padding: '5px 14px',
                background: decQuestion.trim() ? '#3b82f6' : 'var(--border-light)', color: 'var(--surface-0)',
                fontSize: 12, cursor: decQuestion.trim() ? 'pointer' : 'default', whiteSpace: 'nowrap',
              }}>
              {decLoading ? '讨论中…' : '发起讨论'}
            </button>
            <button onClick={() => { setShowDecision(false); setDecQuestion(''); setDecContext('') }}
              style={{
                border: '1px solid var(--border-light)', borderRadius: 6, padding: '5px 8px', fontSize: 11,
                background: 'var(--surface-0)', cursor: 'pointer', color: 'var(--text-secondary)',
              }}>✕</button>
          </div>
          <input
            placeholder="补充背景信息（可选，回车发起讨论）"
            value={decContext}
            onChange={e => setDecContext(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); triggerDecision() } }}
            style={{
              width: '100%', padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border-light)',
              fontSize: 11, marginTop: 5, boxSizing: 'border-box', color: 'var(--text-secondary)',
            }}
          />
        </div>
      )}

      {/* 消息列表 */}
      <div ref={scrollContainerRef} onScroll={handleScroll}
        style={{ flex: 1, overflowY: 'auto', padding: '10px 12px' }}>
        {messages.map((m, i) => (
          <div key={m.id} className="msg-anim-in"
            onMouseEnter={() => m.from !== 'system' && setHoveredMsgId(m.id)}
            onMouseLeave={() => setHoveredMsgId(null)}
            style={{
            marginBottom: 10, display: 'flex', gap: 8, alignItems: 'flex-start',
            flexDirection: m.from === 'user' ? 'row-reverse' : 'row',
            animationDelay: `${Math.min(i * 30, 300)}ms`,
          }}>
            <div style={{
              width: 32, height: 32, borderRadius: 16, fontSize: 18,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0,
              fontFamily: '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif',
              background: m.from === 'user' ? 'var(--accent-50)' : '#f9fafb',
              border: `1.5px solid ${
                m.from === 'lumina' ? '#FFD4D4' : m.from === 'recha' ? '#D4E8FF' : m.from === 'yak' ? '#D4FFD6' : 'var(--border-light)'
              }`,
            }}>{m.fromIcon}</div>
            <div style={{ maxWidth: '72%' }}>
              <div style={{
                fontSize: 12, color: m.from === 'lumina' ? '#FF6B6B' : m.from === 'recha' ? '#448AFF' : m.from === 'yak' ? '#43A047' : '#3b82f6',
                fontWeight: 600, marginBottom: 2,
              }}>
                {m.fromName} <span style={{ color: '#d1d5db', fontWeight: 400 }}>{m.time}</span>
                {replyingAgent === m.from && (
                  <span className={`typing-dots ${agentSwitchClass}`} style={{ marginLeft: 6, display: 'inline-flex', verticalAlign: 'middle', padding: 0, gap: 3 }}>
                    <span style={{ width: 5, height: 5 }} />
                    <span style={{ width: 5, height: 5 }} />
                    <span style={{ width: 5, height: 5 }} />
                  </span>
                )}
                {/* 🆕 v5.4: 上一个 Agent 的打字点渐隐（接力过渡） */}
                {prevReplyingAgent === m.from && replyingAgent !== m.from && !m._animDone && (
                  <span className="typing-dots typing-dots-fading" style={{ marginLeft: 6, display: 'inline-flex', verticalAlign: 'middle', padding: 0, gap: 3 }}>
                    <span style={{ width: 5, height: 5 }} />
                    <span style={{ width: 5, height: 5 }} />
                    <span style={{ width: 5, height: 5 }} />
                  </span>
                )}
              </div>
              <div style={{
                background: m.from === 'user'
                  ? (profile.bubbleColorUser || 'var(--accent-50)')
                  : (profile.bubbleColorAgent || '#f9fafb'),
                borderRadius: 10, padding: '9px 14px', fontSize: 14, lineHeight: 1.7,
                border: '1px solid var(--border-light)', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                minHeight: m.content ? undefined : 20,
                display: m.content ? undefined : 'flex',
                alignItems: m.content ? undefined : 'center',
                color: m.content ? undefined : '#9ca3af',
                fontStyle: m.content ? undefined : 'italic',
                userSelect: 'text',
                cursor: 'text',
              }}>{m.content || (m._animDone ? '（内容为空）' : <span className="typing-dots" style={{ display: 'inline-flex', gap: 3, padding: 0 }}><span style={{ width: 5, height: 5, borderRadius: '50%', background: '#d1d5db', display: 'inline-block' }} /><span style={{ width: 5, height: 5, borderRadius: '50%', background: '#d1d5db', display: 'inline-block' }} /><span style={{ width: 5, height: 5, borderRadius: '50%', background: '#d1d5db', display: 'inline-block' }} /></span>)}</div>
              {/* 🆕 v10.3fix: 渲染思考过程（借鉴 QwenPaw） */}
              {m.thinkingSteps && m.thinkingSteps.length > 0 && (
                <div style={{ marginTop: 6, marginBottom: 2, borderTop: '1px solid #f0f0f0', paddingTop: 4 }}>
                  <button
                    onClick={() => toggleThinking(m.id)}
                    style={{
                      background: 'none', border: 'none', cursor: 'pointer', fontSize: 13,
                      color: '#6b7280', display: 'flex', alignItems: 'center', gap: 4, padding: '2px 0',
                    }}
                  >
                    <span style={{ fontSize: 14 }}>
                      {(thinkingCollapsed[m.id] ?? false) ? '▶' : '▼'}
                    </span>
                    <span>思考过程 ({m.thinkingSteps.length} 步)</span>
                  </button>
                  {!(thinkingCollapsed[m.id] ?? false) && (
                    <div style={{
                      marginTop: 4, padding: '8px 10px', borderRadius: 6, background: '#fafafa',
                      border: '1px solid #f0f0f0', fontSize: 13, lineHeight: 1.6, maxHeight: 250,
                      overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                    }}>
                      {m.thinkingSteps.map((step: any, idx: number) => (
                        <div key={step.id || idx} style={{ marginBottom: 2, display: 'flex', alignItems: 'flex-start', gap: 4 }}>
                          <span style={{ flexShrink: 0, width: 16, textAlign: 'center' }}>
                            {step.type === 'thinking' && '💭'}
                            {step.type === 'tool_start' && '🔧'}
                            {step.type === 'tool_end' && '✅'}
                            {step.type === 'tool_error' && '❌'}
                            {step.type === 'text' && '📝'}
                          </span>
                          <span style={{ flex: 1 }}>
                            <span style={{ fontWeight: 500, color: '#374151' }}>{step.label}</span>
                            {step.tool && <span style={{ color: '#9ca3af', marginLeft: 4 }}>[{step.tool}]</span>}
                            {step.durationMs !== undefined && (
                              <span style={{ color: '#9ca3af', marginLeft: 4 }}>({(step.durationMs / 1000).toFixed(1)}s)</span>
                            )}
                            {step.result && (
                              <div style={{ color: '#6b7280', marginTop: 1, fontSize: 10, whiteSpace: 'pre-wrap' }}>
                                {step.result}
                              </div>
                            )}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {/* 🆕 v8.1: 文件预览 — 用户气泡下方文件卡片（简洁版：仅显示文件名和类型） */}
              {m.attachments && m.attachments.length > 0 && (
                <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {m.attachments.map((a, i) => {
                    const isImage = !!a.text?.startsWith('[图片')
                    const isBinary = !!a.text?.startsWith('[') && !a.text?.startsWith('[图片')
                    return (
                      <div key={i} style={{
                        display: 'flex', alignItems: 'center', gap: 6,
                        padding: '4px 8px', borderRadius: 6,
                        background: '#f8fafc', border: '1px solid #e2e8f0',
                        fontSize: 11, lineHeight: 1.4,
                      }}>
                        <span style={{ fontSize: 14 }}>{isImage ? '🖼️' : isBinary ? '📄' : '📝'}</span>
                        <span style={{ fontWeight: 500, color: '#334155', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {a.name}
                        </span>
                        <span style={{ color: '#94a3b8', flexShrink: 0 }}>
                          ({(a.size / 1024).toFixed(1)}KB)
                        </span>
                      </div>
                    )
                  })}
                </div>
              )}
              {/* v2.14: 内联操作按钮 */}
              {m.from !== 'system' && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 1, marginTop: 4,
                  opacity: hoveredMsgId === m.id ? 1 : 0.3,
                  transition: 'opacity 0.15s',
                  justifyContent: m.from === 'user' ? 'flex-end' : 'flex-start',
                }}>
                  <button onClick={() => handleCopyMsg(m.content, m.id)}
                    title="复制"
                    style={gcInlineBtnStyle}>
                    {copiedMsgId === m.id ? '✅' : '📋'}
                  </button>
                  <button onClick={() => handleResendMsg(m.content)}
                    title="重新输入" style={gcInlineBtnStyle}>
                    ↩️
                  </button>
                  <button onClick={() => handleBookmarkMsg(m)}
                    title="收藏" style={gcInlineBtnStyle}>
                    ⭐
                  </button>
                  <button onClick={() => handleDeleteRequest(m)}
                    title="删除" style={gcInlineBtnStyle}>
                    🗑️
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}
        {replyingAgent && messages[messages.length - 1]?.from !== replyingAgent && (
          <div className="msg-anim-in" style={{
            display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0',
            marginBottom: 10,
          }}>
            <div style={{
              width: 26, height: 26, borderRadius: 13, display: 'flex',
              alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              background: 'var(--surface-100)', border: '1.5px solid var(--border-light)',
            }}>{AGENTS.find(a => a.id === replyingAgent)?.icon || '🤖'}</div>
            <div className="typing-dots" style={{ padding: 0, gap: 3 }}>
              <span style={{ width: 5, height: 5 }} />
              <span style={{ width: 5, height: 5 }} />
              <span style={{ width: 5, height: 5 }} />
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* 输入区 */}
      {/* v2.8.3: 工具通知 — Agent 正在使用工具时显示 */}
      {toolNotice && (
        <div className="tool-notice-bar" style={{
          margin: '0 12px', padding: '6px 12px', borderRadius: 8,
          background: 'linear-gradient(135deg, var(--accent-50) 0%, var(--green-100) 100%)',
          border: '1.5px solid #93c5fd', fontSize: 12, color: '#1e40af',
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <span className="tool-notice-icon">⚡</span>
          {toolNotice}
        </div>
      )}
      {/* 🔥 v2.8.1: Agent 回复状态提示 */}
      {replyingAgent && (
        <div style={{
          margin: '0 12px', padding: '5px 12px', borderRadius: 6,
          background: 'var(--yellow-100)', border: '1px solid var(--yellow-500)',
          fontSize: 11, color: '#92400e', flexShrink: 0,
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <span>{AGENTS.find(a => a.id === replyingAgent)?.icon || '🤖'}</span>
          <span>{AGENTS.find(a => a.id === replyingAgent)?.name || 'Agent'} 正在回复中...</span>
          <span style={{ display: 'inline-flex', gap: 2 }}>
            <span style={{ width: 4, height: 4, borderRadius: '50%', background: '#f59e0b', animation: 'toolPulse 1.2s ease-in-out infinite', animationDelay: '0s' }} />
            <span style={{ width: 4, height: 4, borderRadius: '50%', background: '#f59e0b', animation: 'toolPulse 1.2s ease-in-out infinite', animationDelay: '0.2s' }} />
            <span style={{ width: 4, height: 4, borderRadius: '50%', background: '#f59e0b', animation: 'toolPulse 1.2s ease-in-out infinite', animationDelay: '0.4s' }} />
          </span>
        </div>
      )}
      {/* v2.7: 隐藏文件上传 input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.json,.xml,.md,.csv,.yaml,.yml,.log,.py,.js,.ts,.java,.cpp,.c,.h,.html,.css,.sh,.bat,.ps1,.ini,.cfg,.toml,.zip"
        style={{ display: 'none' }}
        onChange={handleGCFileSelect}
      />
      {/* 拖拽文件预览 */}
      {gcDragFiles.length > 0 && (
        <div style={{
          margin: '0 12px', padding: '8px 12px', borderRadius: 8,
          background: 'var(--accent-50)', border: '1px solid #93c5fd',
          display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center',
          flexShrink: 0,
        }}>
          <span style={{ fontSize: 12, color: '#1d4ed8', fontWeight: 600 }}>📥 将上传：</span>
          {gcDragFiles.map((f, i) => (
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
      {/* 🔧 v2.11: 附件预览 — 与普通聊天一致的逐个文件预览 */}
      {gcAttachments.length > 0 && (
        <div style={{ margin: '0 12px', display: 'flex', flexWrap: 'wrap', gap: 4, flexShrink: 0 }}>
          {gcAttachments.map((a, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 4,
              background: 'var(--accent-50)', border: '1px solid #bfdbfe',
              borderRadius: 6, padding: '3px 8px', fontSize: 11,
              color: '#1d4ed8', maxWidth: 200,
            }}>
              <span style={{ fontSize: 13 }}>
                {a.name.match(/\.(png|jpg|jpeg|gif|webp|svg)$/i) ? '🖼️'
                  : a.name.match(/\.(pdf|doc|docx)$/i) ? '📄'
                  : a.name.match(/\.(xls|xlsx|csv)$/i) ? '📊'
                  : a.name.match(/\.(py|js|ts|java|cpp|c|h|html|css|json|xml)$/i) ? '💻'
                  : '📁'}
              </span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {a.name.length > 16 ? a.name.slice(0, 14) + '...' : a.name}
              </span>
              <span style={{ color: 'var(--text-secondary)', fontSize: 9 }}>
                {a.size > 1024 * 1024 ? `${(a.size / (1024 * 1024)).toFixed(1)}MB` : `${(a.size / 1024).toFixed(0)}KB`}
              </span>
              <button onClick={() => setGcAttachments(prev => prev.filter((_, idx) => idx !== i))} style={{
                border: 'none', background: 'transparent', color: '#93c5fd',
                cursor: 'pointer', fontSize: 13, padding: 0, lineHeight: 1,
              }}>×</button>
            </div>
          ))}
        </div>
      )}
      <div
        style={{
        padding: '8px 12px', borderTop: '1px solid var(--border-light)', flexShrink: 0,
        display: 'flex', flexDirection: 'column', gap: 6,
        transition: 'background 0.15s, border-color 0.15s',
        background: gcDragOver ? 'var(--accent-50)' : 'transparent',
        borderColor: gcDragOver ? '#3b82f6' : 'var(--border-light)',
        outline: gcDragOver ? '2px dashed #93c5fd' : 'none',
        outlineOffset: -4,
      }}>
        <textarea
          key={`gc-input-${inputKey}`}
          ref={gcTextareaRef}
          placeholder={llmReady ? '发消息... @Lumina @热茶 @Yak 指定回复者 （Shift+Enter 换行）' : '发消息...（模拟模式，配置LLM后解锁真实对话）'}
          value={input}
          onChange={e => { setInput(e.target.value); gcAutoResize() }}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
          onDragOver={e => e.preventDefault()}
          rows={1}
          style={{
            flex: 1, padding: '7px 10px', borderRadius: 8, border: '1px solid #d1d5db',
            fontSize: 13, outline: 'none', fontFamily: 'inherit',
            resize: 'vertical', minHeight: 34,
          }}
        />
        {/* ── 功能工具栏（小长方形按钮 + 微软雅黑标注） ── */}
        <div style={{
          display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center',
          fontFamily: '"微软雅黑","Microsoft YaHei",sans-serif',
        }}>
          {/* ── 🍀 Lucky 模式（第一位） ── */}
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
              background: thinkingMode ? '#fffbeb' : '#f9fafb',
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
              onClick={() => setShowEmoji(!showEmoji)}
              title="表情符号"
              style={{
                padding: '4px 10px', borderRadius: 6,
                border: `1.5px solid ${showEmoji ? '#93c5fd' : 'var(--border-light)'}`,
                background: showEmoji ? 'var(--accent-50)' : '#f9fafb',
                cursor: 'pointer', fontSize: 12, display: 'flex',
                alignItems: 'center', gap: 3, fontFamily: 'inherit',
                transition: 'all .15s',
              }}>
              😊 表情
            </button>
          {showEmoji && (
            <>
              <div style={{ position: 'fixed', inset: 0, zIndex: 99 }}
                onClick={() => setShowEmoji(false)} />
              <div style={{
                position: 'absolute', bottom: 40, left: 0, zIndex: 100,
                width: 312, background: 'var(--surface-0)', borderRadius: 12,
                border: '1px solid var(--border-light)',
                boxShadow: '0 4px 24px rgba(0,0,0,.12)',
                overflow: 'hidden',
              }}>
                {/* ═══分类标签 ═══*/}
                <div style={{
                  display: 'flex', gap: 2, padding: '4px 6px',
                  borderBottom: '1px solid var(--border-light)',
                  background: 'var(--surface-0)', overflowX: 'auto',
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
                        const el = document.getElementById(`gc-emoji-group-${gi}`)
                        if (el) {
                          const container = el.parentElement
                          if (container) container.scrollTo({ top: el.offsetTop - 8, behavior: 'smooth' })
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
                      <span style={{ fontSize: 13 }}>{group.label}</span>
                      <span style={{ fontSize: 10, opacity: 0.6 }}>{group.name}</span>
                    </button>
                  ))}
                </div>
                {/* ═══Emoji 网格 ═══*/}
                <div style={{ maxHeight: 260, overflowY: 'auto', padding: '4px 6px' }}>
                  {EMOJI_GROUPS.map((group, gi) => (
                    <div key={gi} id={`gc-emoji-group-${gi}`}>
                      <div style={{ fontSize: 10, color: 'var(--text-secondary)', padding: '6px 4px 2px', fontWeight: 500 }}>
                        {group.label} {group.name}
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                        {group.emojis.map((emoji, ei) => {
                          if (emoji === 'x') return <div key={ei} style={{ width: 30, height: 30 }} />
                          return (
                            <button key={ei}
                              onClick={() => {
                                setInput(prev => prev + emoji)
                                setShowEmoji(false)
                              }}
                              title={emoji}
                              style={{
                                width: 30, height: 30, borderRadius: 5,
                                border: 'none', background: 'transparent',
                                cursor: 'pointer', fontSize: 17, padding: 0,
                                lineHeight: '30px', textAlign: 'center',
                              }}
                              onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--border-light)'}
                              onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'transparent'}
                            >
                              {emoji}
                            </button>
                          )
                        })}
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
              border: `1.5px solid ${gcAttachments.length > 0 ? '#93c5fd' : 'var(--border-light)'}`,
              background: gcAttachments.length > 0 ? 'var(--accent-50)' : '#f9fafb',
              cursor: 'pointer', fontSize: 12, display: 'flex',
              alignItems: 'center', gap: 3, fontFamily: 'inherit',
            }}>
            📎 文件{gcAttachments.length > 0 ? <sup style={{ fontSize: 9, color: '#3b82f6', marginLeft: 1 }}>{gcAttachments.length}</sup> : null}
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
              border: `1.5px solid ${computerUseActive ? '#a855f7' : 'var(--border-light)'}`,
              background: computerUseActive ? '#faf5ff' : '#f9fafb',
              cursor: 'pointer', fontSize: 12, display: 'flex',
              alignItems: 'center', gap: 3, fontFamily: 'inherit',
              boxShadow: computerUseActive ? '0 0 6px rgba(168,85,247,0.35)' : 'none',
            }}>
            {computerUseActive ? '💻 AI操作电脑' : '💻 AI操作电脑'}
          </button>
          {/* ── ⏳ 胶囊 ── */}
          <button onClick={() => {
            const text = input.trim()
            if (!text) { alert('输入你想对未来的自己说的话，然后点击 ⏳ 埋下时光胶囊'); return }
            if (window.confirm(`⏳ 埋一颗时光胶囊给未来的自己？\n\n内容: "${text.slice(0, 50)}${text.length > 50 ? '...' : ''}"\n\n默认 30 天后开启`)) {
              setInput(`帮我埋一颗时光胶囊，内容是：${text}，30天后开启`)
              setTimeout(() => { sendRef.current(); setInput('') }, 80)
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
          {/* ── 弹性空间 ── */}
          <div style={{ flex: 1 }} />
          {/* ── 发送 / 中断 ── */}
          {sending ? (
            <button onClick={() => { abortRef.current = true; setSending(false); setReplyingAgent(null); window.luminaAPI.agentAbort() }}
              title="中断回复"
              style={{
                padding: '4px 14px', borderRadius: 6,
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
          <button onClick={send} disabled={sending || !input.trim()}
            className="btn-send-pulse"
            style={{
              border: 'none', borderRadius: 6, padding: '4px 16px',
              background: input.trim() ? '#3b82f6' : 'var(--border-light)',
              color: input.trim() ? '#fff' : 'var(--text-secondary)',
              fontSize: 12, cursor: input.trim() ? 'pointer' : 'default', fontWeight: 600,
              fontFamily: '"微软雅黑","Microsoft YaHei",sans-serif',
            }}>
            发送
          </button>
          )}
        </div>
      </div>

      {/* ═══ v2.7.1: 状态栏（已移除重复TTS音色选择器）═══ */}
      <div style={{
        padding: '2px 12px 6px', display: 'flex', gap: 8, alignItems: 'center',
        fontSize: 10, color: 'var(--text-secondary)',
      }}>
        <span style={{ flex: 1 }}>
          {gcAttachments.length > 0 ? `📎 ${gcAttachments.length} 个文件待发送  ·  ` : ''}
          {sttListening ? `🎤 语音中${sttStatus?.error ? ' (出错)' : ''}  ·  ` : ''}
          Shift+Enter 换行 · /help 查看命令
        </span>
      </div>
      </>)}
      {teamTab === 'tasks' && <AgentTaskBoard />}
      {teamTab === 'moments' && (
        <div style={{ flex: 1, overflow: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{
            borderRadius: 10, border: '1px solid var(--border-light)', padding: 0,
            background: 'var(--surface-0)', overflow: 'hidden', height: '100%',
          }}>
            <AgentMoments />
          </div>
        </div>
      )}
      {teamTab === 'theater' && <MemoryTheater />}
      {teamTab === 'daily' && (
        <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
          <div style={{
            borderRadius: 10, border: '1px solid var(--border-light)', padding: 0,
            background: 'var(--surface-0)', overflow: 'hidden',
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '10px 14px', borderBottom: '1px solid var(--border-light)',
              background: 'var(--surface-0)', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)',
            }}>
              🌅 Lumina 日报
            </div>
            <div style={{ padding: 12 }}>
              <LuminaDailyReport />
            </div>
          </div>
        </div>
      )}
      {teamTab === 'milestone' && (
        <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
          <div style={{
            borderRadius: 10, border: '1px solid var(--border-light)', padding: 0,
            background: 'var(--surface-0)', overflow: 'hidden',
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '10px 14px', borderBottom: '1px solid var(--border-light)',
              background: 'var(--surface-0)', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)',
            }}>
              💝 团队纪念日
            </div>
            <div style={{ padding: 12 }}>
              <TeamMilestones />
            </div>
          </div>
        </div>
      )}
      {teamTab === 'yak' && (
        <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
          <div style={{
            borderRadius: 10, border: '1px solid var(--border-light)', padding: 0,
            background: 'var(--surface-0)', overflow: 'hidden',
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '10px 14px', borderBottom: '1px solid var(--border-light)',
              background: 'var(--surface-0)', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)',
            }}>
              📘 Yak 技术笔记
            </div>
            <div style={{ padding: 12 }}>
              <YakTechNotes />
            </div>
          </div>
        </div>
      )}

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
              确定要删除这条消息吗？
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setDeletingTarget(null)} style={{
                padding: '7px 16px', borderRadius: 8, border: '1px solid var(--border-light)',
                background: 'var(--surface-100)', cursor: 'pointer', fontSize: 13, color: 'var(--text-secondary)',
              }}>取消</button>
              <button onClick={handleDeleteConfirm} style={{
                padding: '7px 16px', borderRadius: 8, border: 'none',
                background: '#ef4444', cursor: 'pointer', fontSize: 13, fontWeight: 600,
                color: 'var(--surface-0)',
              }}>确认删除</button>
            </div>
          </div>
        </div>
      )}

      {/* 🍀 v1.0: Lucky 模式设置弹窗 */}
      {luckyMode.showSettings && (
        <LuckyModeSettings
          config={luckyMode.settings}
          onSave={(config: LuckySettingsConfig) => luckyMode.saveSettings(config)}
          onClose={() => luckyMode.setShowSettings(false)}
        />
      )}
    </div>
  )
}

function generateMockReply(name: string, userMsg: string): string {
  // v6.0: 未配 LLM 时只 Lumina 发声，引导配置
  const lower = userMsg.toLowerCase()
  if (lower.includes('你好') || lower.includes('hello') || lower.includes('hi')) {
    return '嗨！我是 Lumina ✨\n\n不过我还没有配置 LLM 大脑呢，现在只能做简单的预设回复 😴\n\n> 💡 去设置 → Agent 独立 LLM 配置 → 给 Lumina 填上 Endpoint 和 Model，我就能帮你做任何事了！'
  }
  if (lower.includes('代码') || lower.includes('bug') || lower.includes('编程') || lower.includes('写') || lower.includes('程序')) {
    return '唔…你想让我写代码对吧～不过我现在还没配置 LLM 大脑呢 😣\n\n等 Lumina 配置好后，我会把编程任务悄悄派给后台的热茶（代码工程师），写好后让 Yak（审查员）挑刺把关，最后把完美代码交给你！\n\n> 💡 先去设置里给 Lumina 配好 LLM 吧～'
  }
  return '嘿~ Lumina 在呢！不过我现在还是"离线模式"，只能做预设回复 😴\n\n想让我真正聪明起来？去设置里给 Lumina 配上 LLM 就好啦！\n\n> 💡 设置 → Agent 独立 LLM 配置 → Lumina 那一栏填 Endpoint 和 Model\n> 比如 LM Studio: `http://localhost:1234/v1` / `qwen2.5-32b-instruct`'
}

// ═══════════════════════════════════════════════════════════
// Component
// ═══════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════
// 群聊历史侧边?(独立组件，通过自定义事件通信)
// ═══════════════════════════════════════════════════════════

