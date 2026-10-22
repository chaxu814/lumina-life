// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// chatShared.ts — 团队群聊 & Agent 自主面板 共享类型/常量/状态
// 提取自 ChatPanel.tsx (v2.10.1)
// ============================================================

import { useState, useEffect } from 'react'
import { updateEmotion, emotionContext } from '../services/agentEmotion';
import { buildAgentPrompt, buildAgentPromptLite, AGENT_SOULS } from '../data/agentSouls';

// ═══════════════════════════════════════════════════════════
// TTS Voice 列表
// ═══════════════════════════════════════════════════════════

export const TTS_VOICES = [
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓', icon: '🎀', desc: '活泼女声（默认）' },
  { id: 'zh-CN-YunxiNeural', label: '云希', icon: '📰', desc: '新闻男声' },
  { id: 'zh-CN-YunyangNeural', label: '云扬', icon: '🎙️', desc: '专业男声' },
  { id: 'zh-CN-XiaoyiNeural', label: '晓伊', icon: '🌸', desc: '温暖女声' },
  { id: 'zh-CN-XiaochenNeural', label: '晓辰', icon: '🌙', desc: '沉稳女声' },
  { id: 'zh-CN-XiaohanNeural', label: '晓涵', icon: '🕊️', desc: '温柔女声' },
  { id: 'zh-CN-YunjianNeural', label: '云健', icon: '👴', desc: '老年男声' },
]

export const AGENT_VOICES: Record<string, string> = {
  lumina: 'zh-CN-XiaoxiaoNeural',
  recha:  'zh-CN-YunyangNeural',
  yak:    'zh-CN-YunxiNeural',
}

export const AUTONOMY_INTERVAL = 5 * 60 * 1000

// ═══════════════════════════════════════════════════════════
// 团队 Agent 角色 / 群聊消息类型
// ═══════════════════════════════════════════════════════════

/** Agent 思考步骤 — 借鉴 QwenPaw 的思考过程展示 */
export interface ThinkingStep {
  id: string
  type: 'thinking' | 'tool_start' | 'tool_end' | 'tool_error' | 'text'
  /** 步骤描述（给用户看的） */
  label: string
  /** 工具名（仅 tool_start/tool_end） */
  tool?: string
  /** 工具参数摘要 */
  args?: string
  /** 结果摘要 */
  result?: string
  /** 耗时 ms */
  durationMs?: number
  /** 时间戳 */
  timestamp: number
}

export interface GCMsg {
  id: string; from: string; fromIcon: string; fromName: string
  content: string; time: string
  thinking?: string; steps?: unknown[]
  /** v3.0: 思考过程步骤（可折叠展示） */
  thinkingSteps?: ThinkingStep[]
  /** v8.1: 附件列表（用户上传的文件，气泡下方单独展示） */
  attachments?: { name: string; size: number; text?: string; imageDataUrl?: string }[]
  _animDone?: boolean
}

export const AGENTS = [
  { id: 'lumina', icon: '🐱', name: 'Lumina', color: '#FF6B6B' },
  { id: 'recha', icon: '🍵', name: '热茶', color: '#448AFF' },
  { id: 'yak', icon: '📊', name: 'Yak', color: '#43A047' },
] as const

export const TEAM_CONV_ID = '__team_group_chat__'

export interface GCSession {
  id: string; date: string; preview: string; count: number
  pinned?: boolean
}

export function loadGCSessions(): GCSession[] {
  try { const raw = localStorage.getItem('lumina_gc_sessions'); return raw ? JSON.parse(raw) : [] }
  catch { return [] }
}

export function saveGCSessions(ss: GCSession[]) {
  try {
    localStorage.setItem('lumina_gc_sessions', JSON.stringify(ss))
  } catch (e) {
    // 🐛 2026-10-13：会话列表本身很小（每条几十字节），但同样不能静默失败 ——
    //   写不进去 = 重启后侧边栏会话列表回退到旧版本，用户会以为"会话丢了"。
    console.error('[chatShared] ❌ 保存会话列表失败（localStorage 容量超限？）：', e)
  }
}

export function loadGCMessages(sid: string): GCMsg[] {
  try {
    const raw = localStorage.getItem(`lumina_gc_${sid}`)
    if (!raw) {return []}
    const msgs: GCMsg[] = JSON.parse(raw)
    // 从存储读回来的都是**历史**，不可能还在打字机动画里。
    // 但持久化时机是"每次 messages 变化"，如果上次退出时正在打字，
    // 那条消息会被存成没有 _animDone —— 渲染层据此判断"还在输出"，
    // 于是每次启动它的思考过程都是展开的。这里统一按"已完成"归一。
    const normalized: GCMsg[] = msgs.map(m => (m._animDone === true ? m : { ...m, _animDone: true }))
    // 过滤空白气泡 — 但保留有思考步骤的消息（即使内容为空）
    return normalized.filter(m =>
      m.from === 'system' || m.content ||
      (m.thinkingSteps && m.thinkingSteps.length > 0)
    )
  }
  catch { return [] }
}

export function saveGCMessages(sid: string, msgs: GCMsg[]) {
  // 保存前过滤空白气泡 — 但保留有思考步骤的消息
  const clean = msgs.filter(m =>
    m.from === 'system' || m.content || !m._animDone ||
    (m.thinkingSteps && m.thinkingSteps.length > 0)
  )
  const key = `lumina_gc_${sid}`

  try {
    localStorage.setItem(key, JSON.stringify(clean))
    return
  } catch (e) {
    // 🐛 2026-10-13：容量超限时旧实现**静默失败** —— 用户重启后发现
    //   "最近聊的都没了"，而控制台之外没有任何线索。localStorage 上限约 5MB，
    //   长会话（本仓实测已有 7791 条的会话）很容易撞上。
    console.warn(
      `[chatShared] ⚠️ 保存会话 ${sid} 失败（localStorage 容量超限？），` +
      `将降级为只保留最近的消息：`, e,
    )
  }

  // 降级：逐步丢弃最老的消息，保证**最近的对话**一定存得下。
  //   宁可少留历史，也不能整段丢失 —— 用户最在意的是"刚才说的话还在不在"。
  for (const keep of [200, 100, 50, 20]) {
    if (clean.length <= keep) {continue}
    try {
      localStorage.setItem(key, JSON.stringify(clean.slice(-keep)))
      console.warn(`[chatShared] ↩️ 已降级保存：${clean.length} → 最近 ${keep} 条`)
      return
    } catch { /* 继续尝试更小的保留量 */ }
  }

  console.error(
    `[chatShared] ❌ 会话 ${sid} 保存失败（连最近 20 条都写不进去）。` +
    `本轮对话重启后将不可见 —— 建议清理旧会话释放 localStorage 空间。`,
  )
}

export function newGCSessionId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

/**
 * 持久化群聊时，计算会话列表的下一个状态。
 *
 * 关键区分：
 * - 仅仅「切换/加载」历史会话（消息数 === 该会话加载时的基线）属于只读操作，
 *   不应把会话置顶、也不应把日期改成今天 → 返回 null（调用方只保存消息，不动列表）。
 * - 只有真正产生了新消息（消息数 > 基线）才把当前会话置顶，并刷新日期/预览/计数。
 *
 * `today` 可注入，便于测试固定日期。
 */
export function buildSessionsOnPersist(
  sessions: GCSession[],
  activeSessionId: string,
  messages: Pick<GCMsg, 'from' | 'content'>[],
  baseline: number | undefined,
  today: string = new Date().toLocaleDateString('zh-CN'),
): GCSession[] | null {
  const base = baseline ?? -1
  if (messages.length <= base) { return null }
  const preview = messages.filter(m => m.from === 'user').slice(-1)[0]?.content?.slice(0, 30) || ''
  return [
    { id: activeSessionId, date: today, preview, count: messages.length },
    ...sessions.filter(s => s.id !== activeSessionId),
  ]
}

// ═══════════════════════════════════════════════════════════
// Agent 任务 / 帖子 类型
// ═══════════════════════════════════════════════════════════

export interface AgentTask {
  id: string; agentId: string; title: string; desc: string
  status: 'planning' | 'doing' | 'done' | 'failed'; progress: number
  icon: string; startTime: string; endTime?: string; result?: string; funnyComment?: string
}

export interface AgentPost {
  id: string; agentId: string; time: string; content: string; mood: string
  likes: number; comments: { agentId: string; content: string }[]
}

// ═══════════════════════════════════════════════════════════
// LLM 自主面板共享状态
// ═══════════════════════════════════════════════════════════

export interface LLMPanelState {
  enabled: boolean; loading: boolean; error: string | null
  tasks: AgentTask[] | null; posts: AgentPost[] | null
  _nextRefresh: number | null
}

export function loadLLMData(): {
  enabled: boolean; tasks: AgentTask[] | null
  posts: AgentPost[] | null; nextRefresh: number | null
} {
  try {
    return {
      enabled: localStorage.getItem('lumina_autonomy_enabled') === 'true',
      tasks: JSON.parse(localStorage.getItem('lumina_autonomy_tasks') || 'null'),
      posts: JSON.parse(localStorage.getItem('lumina_autonomy_posts') || 'null'),
      nextRefresh: JSON.parse(localStorage.getItem('lumina_autonomy_next') || 'null'),
    }
  } catch { return { enabled: false, tasks: null, posts: null, nextRefresh: null } }
}

export function saveLLMData(
  tasks: AgentTask[] | null, posts: AgentPost[] | null,
  enabled: boolean, next: number | null,
): void {
  try {
    if (tasks) {localStorage.setItem('lumina_autonomy_tasks', JSON.stringify(tasks))}
    if (posts) {localStorage.setItem('lumina_autonomy_posts', JSON.stringify(posts))}
    localStorage.setItem('lumina_autonomy_enabled', String(enabled))
    // 修复: next 为 0 时也需要保存（if(next) 对 0 为 falsy）
    if (next !== null && next !== undefined) {localStorage.setItem('lumina_autonomy_next', JSON.stringify(next))}
  } catch { /* ignore */ }
}

export function loadAgentVoices(): Record<string, string> {
  try {
    const saved = localStorage.getItem('lumina_agent_voices')
    return saved ? JSON.parse(saved) : { ...AGENT_VOICES }
  } catch { return { ...AGENT_VOICES } }
}

export function saveAgentVoices(v: Record<string, string>): void {
  try { localStorage.setItem('lumina_agent_voices', JSON.stringify(v)) } catch { /* ignore */ }
}

// ═══ 初始化：从 localStorage 恢复自主模式状态 ═══
const _savedLLM = loadLLMData()
export const _llmState: LLMPanelState = {
  enabled: _savedLLM.enabled,
  loading: false,
  error: null,
  tasks: _savedLLM.tasks,
  posts: _savedLLM.posts,
  _nextRefresh: _savedLLM.nextRefresh,
}

export let _autonomyTimer: ReturnType<typeof setInterval> | null = null
let _autonomyTimeout: ReturnType<typeof setTimeout> | null = null
let _llmRefreshFn: (() => void) | null = null
const _llmListeners = new Set<() => void>()

/** 注册自主刷新回调（由 ChatPanel 调用） */
export function setLLMRefreshFn(fn: (() => void) | null) {
  _llmRefreshFn = fn
}

export function _llmNotify() {
  _llmListeners.forEach(fn => fn())
  saveLLMData(_llmState.tasks, _llmState.posts, _llmState.enabled, null)
}

export function _startAutonomyTimer(intervalMs: number) {
  _stopAutonomyTimer()
  const next = Date.now() + intervalMs
  _llmState._nextRefresh = next
  localStorage.setItem('lumina_autonomy_next', JSON.stringify(next))
  _llmNotify()
  _autonomyTimer = setInterval(() => {
    _llmRefreshFn?.()
    if (_llmState.enabled) {
      const n = Date.now() + intervalMs
      _llmState._nextRefresh = n
      localStorage.setItem('lumina_autonomy_next', JSON.stringify(n))
      _llmNotify()
    }
  }, intervalMs)
}

export function _stopAutonomyTimer() {
  if (_autonomyTimer) { clearInterval(_autonomyTimer); _autonomyTimer = null }
  if (_autonomyTimeout) { clearTimeout(_autonomyTimeout); _autonomyTimeout = null }
}

export function _startAutonomyWithRemaining(intervalMs: number, savedNext: number) {
  _stopAutonomyTimer()
  const remaining = Math.max(0, savedNext - Date.now())
  if (remaining > 0) {
    _llmState._nextRefresh = savedNext
    _llmNotify()
    _autonomyTimeout = setTimeout(() => {
      _llmRefreshFn?.()
      if (_llmState.enabled) {
        const n = Date.now() + intervalMs
        _llmState._nextRefresh = n
        localStorage.setItem('lumina_autonomy_next', JSON.stringify(n))
        _llmNotify()
        _startAutonomyTimer(intervalMs)
      }
    }, remaining)
  } else {
    _llmRefreshFn?.()
    _startAutonomyTimer(intervalMs)
  }
}

export function useLLMPanels(): Readonly<LLMPanelState> {
  const [, bump] = useState(0)
  useEffect(() => {
    const fn = () => bump(n => n + 1)
    _llmListeners.add(fn)
    return () => { _llmListeners.delete(fn) }
  }, [])
  return _llmState as Readonly<LLMPanelState>
}

// ═══════════════════════════════════════════════════════════
// Emoji 选择器数据
// ═══════════════════════════════════════════════════════════

export const EMOJI_GROUPS: { label: string; name: string; emojis: string[] }[] = [
  { label: '😊', name: '表情', emojis: ['😀','😃','😄','😁','😅','🤣','😂','🙂','😊','😇','🥰','😍','🤩','😘','😗','😚','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','🤐','🤨','😐','😑','😶','😏','😒','🙄','😬','😮','🤥','😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮','🥴','😵','🤯','😤','😡','😠','🤬','😈','👿','💀','💩','🤡','👹','👺','👻','👽','👾','🤖','😺','😸','😹','😻','😼','😽','🙀','😿','😾'] },
  { label: '👋', name: '手势', emojis: ['👋','🤚','🖐','🖖','👌','🤌','🤏','🤞','🤟','🤘','🤙','👈','👉','👆','🖕','👇','👍','👎','👊','🤛','🤜','👏','🙌','🤲','🙏','💅','🤝','💪','🦵','🦶','👂','👃','🧠','🦷','🦴','👀','👁','👅','👄'] },
  { label: '🐱', name: '动物', emojis: ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🐔','🐧','🐦','🐤','🦆','🦅','🦉','🦇','🐺','🐗','🐴','🦄','🐝','🐛','🦋','🐌','🐞','🐜','🐢','🐍','🦎','🦖','🦕','🐙','🦑','🦐','🦀','🐡','🐠','🐟','🐬','🐳','🐋','🦈','🐊','🐅','🐆','🦓','🦍','🐘','🦛','🦏','🐪','🐫','🦒','🦘','🐂','🐄','🐎','🐖','🐏','🐑','🐐','🦌','🐕','🐩','🐈','🐓','🦃','🦚','🦜','🦢','🦩','🕊','🐇','🦝','🦨','🦡','🦦','🦥','🐁','🐀','🐿','🦔','🐾','🐉','🐲'] },
  { label: '🌿', name: '自然', emojis: ['🌸','🌺','🌻','🌹','🌷','🌼','💐','🥀','🌱','🌲','🌳','🌴','🌵','🍀','🍁','🍂','🍃','☀️','🌈','🌊','⭐','🌟','💫','🔥','💧','🌍','🌎','🌏','🌕','🌙'] },
  { label: '🍕', name: '食物', emojis: ['🍎','🍊','🍋','🍌','🍉','🍇','🍓','🍈','🍒','🍑','🥭','🍍','🥥','🥝','🍅','🍆','🥑','🥦','🥒','🌽','🥕','🧄','🧅','🥔','🍠','🥐','🍞','🥖','🧀','🥚','🍳','🥞','🥓','🥩','🍗','🍖','🌭','🍔','🍟','🍕','🥪','🌮','🌯','🥗','🍿','🧈','🍜','🍝','🍣','🍤','🍚','🍛','🍲','🥘','🍰','🎂','🍪','🍩','🍫','🍬','🍭','☕','🍵','🍺','🍷','🥤','🧃'] },
  { label: '⚽', name: '活动', emojis: ['⚽','🏀','🏈','⚾','🎾','🏐','🎱','🏓','🏸','🥅','🏒','🏹','⛳','🎣','🤿','🥊','🎮','🎲','🎸','🎹','🎺','🎻','🥁','🎤','🎧','📷','🎥','📺','💻','⌨️','🖥️','🖱️','📱','🔋','💡','🔦','📚','📝','✂️','🔒','🔑','🔨','⚙️','🧲','💊','🩹','🧬','🔬','🔭','📡','🚀','✈️'] },
  { label: '❤️', name: '符号', emojis: ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝','💟','☮️','✝️','☪️','🕉','☸️','✡️','🔯','🕎','☯️','☦️','🛐','⚛️','🉑','☢️','☣️','📴','📳','🈶','🈚','🈸','🈺','🈷️','✴️','🆚','💮','🉐','㊙️','㊗️','🈴','🈵','🈹','🈲','🅰️','🅱️','🆎','🆑','🅾️','🆘','❌','⭕','🛑','♨️'] },
]

// ═══════════════════════════════════════════════════════════
// Helper Functions (extracted from ChatPanel.tsx)
// ═══════════════════════════════════════════════════════════

export function cleanTtsText(text: string): string {
  let cleaned = text
    .replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '').replace(/\[[^\]]*\]/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/```[\s\S]*?```/g, '代码省略').replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1').replace(/_([^_]+)_/g, '$1')
    .replace(/^[*_~#>]+/gm, '').replace(/^[\s]*[-*+]\s+/gm, '')
    .replace(/^[\s]*\d+[.)]\s+/gm, '').replace(/^[-*_]{3,}\s*$/gm, '')
    .replace(/[\u{1F600}-\u{1F64F}]/gu, '').replace(/[\u{1F300}-\u{1F5FF}]/gu, '')
    .replace(/[\u{1F680}-\u{1F6FF}]/gu, '').replace(/[\u{1F700}-\u{1F77F}]/gu, '')
    .replace(/[\u{1F780}-\u{1F7FF}]/gu, '').replace(/[\u{1F800}-\u{1F8FF}]/gu, '')
    .replace(/[\u{1F900}-\u{1F9FF}]/gu, '').replace(/[\u{1FA00}-\u{1FA6F}]/gu, '')
    .replace(/[\u{1FA70}-\u{1FAFF}]/gu, '').replace(/[\u{2600}-\u{27BF}]/gu, '')
    .replace(/[\u{2300}-\u{23FF}]/gu, '').replace(/[\u{2B50}\u{2B06}\u{2B07}\u{2B05}\u{27A1}\u{2934}\u{2935}\u{25AA}\u{25AB}\u{25B6}\u{25C0}\u{25FB}\u{25FC}\u{25FD}\u{25FE}]/gu, '')
    .replace(/[\u{200D}]/gu, '').replace(/[\u{FE0F}]/gu, '')
    .replace(/\n{3,}/g, '\n\n').split('\n').map(l => l.trim()).join('\n').trim()
  if (!cleaned || cleaned.length < 3) {cleaned = text.replace(/```[\s\S]*?```/g, '代码省略').trim()}
  if (!cleaned) {cleaned = text.slice(0, 200)}
  return cleaned
}

/** 会话/消息时间戳 —— 只显示日期，不显示时分。
 *  今天 → 「今天」；昨天 → 「昨天」；本年 → 「MM-DD」；跨年 → 「YYYY-MM-DD」。
 *  仅用于展示；排序请直接用 createdAt / timestamp 原始值，不要依赖格式化文本。 */
export function formatDateLabel(ts: number): string {
  const d = new Date(ts)
  if (isNaN(d.getTime())) {return ''}
  const now = new Date()
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const dayDiff = Math.round((startOfDay(now) - startOfDay(d)) / 86400000)
  if (dayDiff === 0) {return '今天'}
  if (dayDiff === 1) {return '昨天'}
  const M = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  if (d.getFullYear() === now.getFullYear()) {return `${M}-${day}`}
  return `${d.getFullYear()}-${M}-${day}`
}

export function getConvPreview(messages: Array<{ role: string; content: string }>): string {
  const first = messages.find(m => m.role === 'user')
  return first ? first.content.slice(0, 30) + (first.content.length > 30 ? '...' : '') : '新对话'
}

export function insertAtCursor(textarea: HTMLTextAreaElement, text: string) {
  const start = textarea.selectionStart
  const end = textarea.selectionEnd
  const before = textarea.value.slice(0, start)
  const after = textarea.value.slice(end)
  const newValue = before + text + after
  return { value: newValue, cursor: start + text.length }
}

// ═══════════════════════════════════════════════════════════
// 团队 Agent 角色 Prompt
// ═══════════════════════════════════════════════════════════
// v2.8: Agent 灵魂系统 — 用 buildAgentPrompt 动态构建 system prompt
// 老 AGENT_PROMPTS 已迁移至 agentSouls.ts
// ═══════════════════════════════════════════════════════════

export function getAgentSystemPrompt(
  agentId: string,
  lastSpeakerId?: string,
  lastSpeakerContent?: string,
): string {
  const ctx = emotionContext(agentId)
  return buildAgentPrompt(agentId, ctx, undefined, lastSpeakerId, lastSpeakerContent)
}

/** v2.14: 群聊精简 prompt — 大幅减少 token */
export function getAgentSystemPromptLite(
  agentId: string,
  lastSpeakerId?: string,
  lastSpeakerContent?: string,
  teamToolsPrompt?: string,  // 🆕 v3.1: 安全配置生成的工具提示词
): string {
  const ctx = emotionContext(agentId)
  return buildAgentPromptLite(agentId, ctx, lastSpeakerId, lastSpeakerContent, teamToolsPrompt)
}
