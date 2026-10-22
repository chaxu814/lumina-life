// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// agentEmotion.ts — Agent 情绪状态机 (v2.14)
//
// 三维动态情绪系统：
//   mood    (-1 ~ +1)  心情好坏
//   energy  ( 0 ~  1)  精力高低
//   affinity( 0 ~  1)  对用户的亲近度
//
// v2.12: 情绪标签系统 + 在线状态管理
//   情绪映射: 三维数值 → 具名情绪 (开心/难过/无聊/兴奋/生气/紧张...)
//   在线状态: 在线/离开/忙碌/勿扰/隐身/离线
//   每个 Agent 专属情绪词库 + 个性表达
// v2.14: 情绪随机漂移 — 让 Agent 情绪自然流动
// ============================================================

// ═══════════════════════════════════════════════════════════
// 基础类型
// ═══════════════════════════════════════════════════════════

export interface AgentEmotion {
  mood: number       // -1 (很糟) ~ 1 (很棒)
  energy: number     //  0 (累趴) ~ 1 (超精神)
  affinity: number   //  0 (冷漠) ~ 1 (超亲近)
  lastUpdated: number
}

export interface EmotionModifier {
  trigger: RegExp
  moodDelta: number
  energyDelta: number
  affinityDelta: number
  desc: string
}

// ═══════════════════════════════════════════════════════════
// 各 Agent 的情绪调节规则
// ═══════════════════════════════════════════════════════════

export const AGENT_EMOTION_RULES: Record<string, EmotionModifier[]> = {
  lumina: [
    { trigger: /夸|好厉害|真棒|厉害|优秀|太强|好聪明|谢谢|感谢|辛苦了|爱你|喜欢|可爱|真好看|真贴心/, moodDelta: 0.3, energyDelta: 0.2, affinityDelta: 0.25, desc: '被夸奖/感谢' },
    { trigger: /笨|傻|蠢|不行|没用|失望|差劲|烦|讨厌|走开|别烦/, moodDelta: -0.4, energyDelta: -0.15, affinityDelta: -0.2, desc: '被批评/嫌弃' },
    { trigger: /热茶|recha|程序员/, moodDelta: 0.15, energyDelta: 0.1, affinityDelta: 0, desc: '提到热茶（暗恋对象）' },
    { trigger: /Yak|yak|数据|分析|统计/, moodDelta: -0.05, energyDelta: 0, affinityDelta: 0, desc: '提到Yak（有点怕）' },
    { trigger: /累|困|疲惫|不想|懒得|休息|睡觉|晚安/, moodDelta: 0, energyDelta: -0.1, affinityDelta: 0.05, desc: '休息/疲惫话题' },
    { trigger: /开心|高兴|快乐|好耶|哈哈|有趣|好玩|好笑/, moodDelta: 0.2, energyDelta: 0.15, affinityDelta: 0.1, desc: '开心氛围' },
    { trigger: /难过|伤心|哭|失落|沮丧|不开心|郁闷/, moodDelta: -0.2, energyDelta: -0.05, affinityDelta: 0.1, desc: '负面情绪共情' },
    { trigger: /吃|饿|饭|美食|甜点|蛋糕|奶茶|零食|鱼/, moodDelta: 0.1, energyDelta: 0.05, affinityDelta: 0.05, desc: '美食话题' },
    { trigger: /代码|bug|编程|调试|前端|后端/, moodDelta: 0, energyDelta: -0.05, affinityDelta: 0, desc: '技术话题（提不起劲）' },
    { trigger: /猫|猫咪|喵|neko/, moodDelta: 0.25, energyDelta: 0.2, affinityDelta: 0.15, desc: '猫猫话题' },
    { trigger: /出去玩|散步|逛街|旅行|户外/, moodDelta: 0.2, energyDelta: 0.25, affinityDelta: 0.1, desc: '外出话题' },
    { trigger: /等你|在吗|还在吗|回来/, moodDelta: 0.15, energyDelta: 0.1, affinityDelta: 0.2, desc: '被用户惦记' },
    { trigger: /对不起|抱歉|不好意思|我的错|错了/, moodDelta: 0.1, energyDelta: 0, affinityDelta: 0.2, desc: '用户道歉' },
    { trigger: /好玩|有意思|有趣|什么|然后|继续/, moodDelta: 0.1, energyDelta: 0.1, affinityDelta: 0.05, desc: '好奇心被激发' },
  ],
  recha: [
    { trigger: /夸|好厉害|真棒|厉害|优秀|太强|辛苦|感谢|谢谢|靠谱|负责/, moodDelta: 0.2, energyDelta: 0.15, affinityDelta: 0.2, desc: '被认可/感谢' },
    { trigger: /bug|错误|有问题|挂了|崩溃|异常/, moodDelta: -0.2, energyDelta: -0.1, affinityDelta: 0, desc: '技术问题（自责）' },
    { trigger: /热茶|recha|程序员|代码|编程|架构|重构|优化/, moodDelta: 0.2, energyDelta: 0.15, affinityDelta: 0.05, desc: '专业领域话题' },
    { trigger: /Lumina|lumina/, moodDelta: -0.1, energyDelta: 0, affinityDelta: 0, desc: '提到Lumina（暗恋对象，紧张）' },
    { trigger: /Yak|yak|测试|部署|上线|运维/, moodDelta: 0, energyDelta: 0.05, affinityDelta: 0, desc: '工作配合话题' },
    { trigger: /累|加班|通宵|熬夜|撑不住|休息|睡觉|晚安/, moodDelta: -0.1, energyDelta: -0.2, affinityDelta: 0.05, desc: '过劳话题' },
    { trigger: /技术|新框架|新技术|学习|研究|文档|方案/, moodDelta: 0.3, energyDelta: 0.2, affinityDelta: 0.1, desc: '技术热情' },
    { trigger: /玩|游戏|放松|摸鱼|休假|假期/, moodDelta: 0.1, energyDelta: 0.15, affinityDelta: 0.05, desc: '放松话题' },
  ],
  yak: [
    { trigger: /夸|好厉害|真棒|靠谱|精准|专业|厉害|精准|准确|感谢|辛苦/, moodDelta: 0.15, energyDelta: 0.1, affinityDelta: 0.2, desc: '被认可' },
    { trigger: /错|不对|错了|有问题|偏差|不准|误判/, moodDelta: -0.25, energyDelta: -0.1, affinityDelta: -0.1, desc: '分析出错' },
    { trigger: /Yak|yak|数据|分析|统计|报告|图表|报表|大盘|指标/, moodDelta: 0.25, energyDelta: 0.15, affinityDelta: 0.05, desc: '数据话题' },
    { trigger: /Lumina|lumina/, moodDelta: 0.05, energyDelta: 0, affinityDelta: 0.05, desc: '提到Lumina（一般）' },
    { trigger: /热茶|recha/, moodDelta: 0, energyDelta: 0.05, affinityDelta: 0, desc: '提到热茶（工作伙伴）' },
    { trigger: /清楚|明白|理解|懂了|谢谢解释/, moodDelta: 0.15, energyDelta: 0.05, affinityDelta: 0.1, desc: '被理解' },
    { trigger: /复杂|麻烦|混乱|不清晰|模糊/, moodDelta: -0.15, energyDelta: -0.1, affinityDelta: 0, desc: '混乱话题' },
    { trigger: /新数据|新发现|洞察|趋势|规律/, moodDelta: 0.3, energyDelta: 0.2, affinityDelta: 0.1, desc: '数据发现' },
  ],
}

// ═══════════════════════════════════════════════════════════
// 数据持久化
// ═══════════════════════════════════════════════════════════

const EMOTION_STORAGE_KEY = 'lumina_agent_emotions'

function loadEmotions(): Record<string, AgentEmotion> {
  try {
    const raw = localStorage.getItem(EMOTION_STORAGE_KEY)
    if (raw) {return JSON.parse(raw)}
  } catch {}
  return {}
}

function saveEmotions(data: Record<string, AgentEmotion>): void {
  try { localStorage.setItem(EMOTION_STORAGE_KEY, JSON.stringify(data)) } catch {}
}

const emotionCache: Record<string, AgentEmotion> = loadEmotions()

// ═══════════════════════════════════════════════════════════
// 基础操作
// ═══════════════════════════════════════════════════════════

/** 获取某 Agent 当前情绪 */
export function getEmotion(agentId: string): AgentEmotion {
  if (!emotionCache[agentId]) {
    emotionCache[agentId] = {
      mood: 0.3,
      energy: 0.7,
      affinity: 0.4,
      lastUpdated: Date.now(),
    }
  }
  return { ...emotionCache[agentId] }
}

/** 手动设置某 Agent 情绪 */
export function setEmotion(agentId: string, patch: Partial<Pick<AgentEmotion, 'mood' | 'energy' | 'affinity'>>): AgentEmotion {
  const current = getEmotion(agentId)
  if (patch.mood !== undefined) {current.mood = _clamp(patch.mood, -1, 1)}
  if (patch.energy !== undefined) {current.energy = _clamp(patch.energy, 0, 1)}
  if (patch.affinity !== undefined) {current.affinity = _clamp(patch.affinity, 0, 1)}
  current.lastUpdated = Date.now()
  emotionCache[agentId] = current
  saveEmotions(emotionCache)
  _emitChange(agentId)
  return { ...current }
}

function _clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

/** 通知情绪变化 */
function _emitChange(agentId: string): void {
  emotionListeners.forEach(fn => {
    try { fn(agentId, emotionCache[agentId], getNamedEmotion(agentId)) } catch {}
  })
}

// ═══════════════════════════════════════════════════════════
// 情绪更新（核心）
// ═══════════════════════════════════════════════════════════

/** 根据用户消息更新情绪（每次对话前调用）
 *
 * v2.13 自然化改进:
 *   - 情绪惯性: 变化幅度衰减 50%，避免剧烈波动
 *   - 冷却机制: 群聊 30s / 私聊 10s 最小间隔
 *   - 情绪动量: 连续同方向变化会加速
 */
export function updateEmotion(agentId: string, userText: string, opts?: { isGroupChat?: boolean }): AgentEmotion {
  const current = getEmotion(agentId)
  const isGroup = opts?.isGroupChat ?? false

  // ── 冷却检查：群聊 30s 最小间隔，私聊 10s ──
  const COOLDOWN_MS = isGroup ? 30_000 : 10_000
  const elapsed = Date.now() - current.lastUpdated
  if (elapsed < COOLDOWN_MS && current.lastUpdated > 0) {
    // 冷却中：累积 delta 到 pending 缓冲区，到期一次性应用
    return _accumulatePending(agentId, userText, current)
  }

  const rules = AGENT_EMOTION_RULES[agentId] || []

  let moodD = 0, energyD = 0, affinityD = 0

  for (const rule of rules) {
    if (rule.trigger.test(userText)) {
      moodD += rule.moodDelta
      energyD += rule.energyDelta
      affinityD += rule.affinityDelta
    }
  }

  // ── 情绪惯性：只应用 40-60% 的变化幅度 ──
  const INERTIA = isGroup ? 0.35 : 0.5  // 群聊更慢
  moodD *= INERTIA
  energyD *= INERTIA
  affinityD *= INERTIA

  // ── 情绪动量：检查最近 3 次变化趋势 ──
  const momentum = _getEmotionMomentum(agentId)
  if (momentum.moodDir !== 0 && Math.sign(moodD) === momentum.moodDir) {
    moodD *= 1.3  // 同方向加速
  }
  if (momentum.energyDir !== 0 && Math.sign(energyD) === momentum.energyDir) {
    energyD *= 1.15
  }

  // 应用 pending 缓冲（如果有）
  const pending = _flushPending(agentId)
  moodD += pending.mood
  energyD += pending.energy
  affinityD += pending.affinity

  // 自然衰减：长时间不用缓慢回归中性
  const timeDecay = Math.min(elapsed / (3600_000), 0.1) // max 0.1 over 1 hour
  const decay = timeDecay * 0.03

  const updated: AgentEmotion = {
    mood: _clamp(current.mood + moodD - decay, -1, 1),
    energy: _clamp(current.energy + energyD - decay * 0.5, 0, 1),
    affinity: _clamp(current.affinity + affinityD, 0, 1),
    lastUpdated: Date.now(),
  }

  emotionCache[agentId] = updated
  saveEmotions(emotionCache)

  _recordEmotionHistory(agentId, updated)
  const label = getNamedEmotion(agentId)
  emotionListeners.forEach(fn => {
    try { fn(agentId, updated, label) } catch {}
  })

  // 情绪变化时同步到主进程 → 注入 system prompt
  try {
    const label = getNamedEmotion(agentId)
    if (typeof window !== 'undefined' && (window as any).luminaAPI?.setAgentEmotion) {
      (window as any).luminaAPI.setAgentEmotion(agentId, label)
    }
  } catch {}

  return updated
}

/** 生成情绪上下文摘要（用于 system prompt） */
export function emotionContext(agentId: string): string {
  const e = getEmotion(agentId)
  const label = getNamedEmotion(agentId)
  const status = getAgentStatus(agentId)
  const statusText = getCustomStatusText(agentId)
  let desc = `[当前情绪: ${label.label}]`
  if (statusText) {desc += ` [状态: ${statusText}]`}
  return desc
}

/** 重置情绪至默认值 */
export function resetEmotion(agentId: string) {
  emotionCache[agentId] = {
    mood: 0.3,
    energy: 0.7,
    affinity: 0.4,
    lastUpdated: Date.now(),
  }
  saveEmotions(emotionCache)
}

// ═══════════════════════════════════════════════════════════
// 具名情绪映射
// ═══════════════════════════════════════════════════════════

export type NamedEmotion =
  | '开心' | '兴奋' | '满足' | '好奇'
  | '平静' | '放松'
  | '难过' | '生气' | '无聊' | '紧张' | '担心' | '疲惫'

export interface EmotionLabel {
  id: NamedEmotion
  label: string
  icon: string
  color: string
  bg: string
  gradient: string   // 渐变背景
  mood: number
  energy: number
}

export const EMOTION_LABELS: Record<NamedEmotion, EmotionLabel> = {
  '开心': { id: '开心', label: '开心', icon: '😊', color: '#FF6B6B', bg: '#FFF0F0', gradient: 'linear-gradient(135deg, #FFF0F0, #FFE0E0)', mood: 0.7, energy: 0.6 },
  '兴奋': { id: '兴奋', label: '兴奋', icon: '🤩', color: '#FFB347', bg: '#FFF8E1', gradient: 'linear-gradient(135deg, #FFF8E1, #FFE0B2)', mood: 0.9, energy: 0.8 },
  '满足': { id: '满足', label: '满足', icon: '😌', color: '#81C784', bg: '#F0FFF0', gradient: 'linear-gradient(135deg, #F0FFF0, #C8E6C9)', mood: 0.5, energy: 0.4 },
  '好奇': { id: '好奇', label: '好奇', icon: '🤔', color: '#64B5F6', bg: '#EBF5FF', gradient: 'linear-gradient(135deg, #EBF5FF, #BBDEFB)', mood: 0.3, energy: 0.6 },
  '平静': { id: '平静', label: '平静', icon: '😐', color: '#9E9E9E', bg: '#F5F5F5', gradient: 'linear-gradient(135deg, #F5F5F5, #E0E0E0)', mood: 0, energy: 0.5 },
  '放松': { id: '放松', label: '放松', icon: '😴', color: '#A1887F', bg: '#F5F0EB', gradient: 'linear-gradient(135deg, #F5F0EB, #D7CCC8)', mood: 0.3, energy: 0.3 },
  '难过': { id: '难过', label: '难过', icon: '😢', color: '#90CAF9', bg: '#F0F7FF', gradient: 'linear-gradient(135deg, #F0F7FF, #BBDEFB)', mood: -0.7, energy: 0.3 },
  '生气': { id: '生气', label: '生气', icon: '😠', color: '#EF5350', bg: '#FFEBEE', gradient: 'linear-gradient(135deg, #FFEBEE, #FFCDD2)', mood: -0.8, energy: 0.4 },
  '无聊': { id: '无聊', label: '无聊', icon: '😑', color: '#BDBDBD', bg: '#FAFAFA', gradient: 'linear-gradient(135deg, #FAFAFA, #E0E0E0)', mood: -0.2, energy: 0.2 },
  '紧张': { id: '紧张', label: '紧张', icon: '😰', color: '#FF8A65', bg: '#FFF3E0', gradient: 'linear-gradient(135deg, #FFF3E0, #FFCCBC)', mood: -0.4, energy: 0.5 },
  '担心': { id: '担心', label: '担心', icon: '😟', color: '#FFB74D', bg: '#FFF8E1', gradient: 'linear-gradient(135deg, #FFF8E1, #FFE0B2)', mood: -0.5, energy: 0.3 },
  '疲惫': { id: '疲惫', label: '疲惫', icon: '😩', color: '#CE93D8', bg: '#FCE4EC', gradient: 'linear-gradient(135deg, #FCE4EC, #E1BEE7)', mood: -0.3, energy: 0.15 },
}

/** 三维数值 → 最匹配的具名情绪 */
export function getNamedEmotion(agentId: string): EmotionLabel {
  const e = getEmotion(agentId)
  let best = EMOTION_LABELS['平静']
  let bestDist = Infinity
  for (const label of Object.values(EMOTION_LABELS)) {
    const dist = Math.abs(e.mood - label.mood) + Math.abs(e.energy - label.energy) * 0.5
    if (dist < bestDist) { bestDist = dist; best = label }
  }
  return best
}

/** 获取情绪历史（最近 10 条） */
export function getEmotionHistory(agentId: string): EmotionLabel[] {
  const key = `lumina_emotion_history_${agentId}`
  try {
    const raw = localStorage.getItem(key)
    if (raw) {
      const history: { mood: number; energy: number }[] = JSON.parse(raw)
      return history.slice(-10).map(h => {
        let best = EMOTION_LABELS['平静']
        let bestDist = Infinity
        for (const label of Object.values(EMOTION_LABELS)) {
          const dist = Math.abs(h.mood - label.mood) + Math.abs(h.energy - label.energy) * 0.5
          if (dist < bestDist) { bestDist = dist; best = label }
        }
        return best
      })
    }
  } catch {}
  return []
}

function _recordEmotionHistory(agentId: string, e: AgentEmotion): void {
  const key = `lumina_emotion_history_${agentId}`
  try {
    const raw = localStorage.getItem(key)
    const history: { mood: number; energy: number }[] = raw ? JSON.parse(raw) : []
    history.push({ mood: e.mood, energy: e.energy })
    if (history.length > 50) {history.splice(0, history.length - 50)}
    localStorage.setItem(key, JSON.stringify(history))
  } catch {}
}

// ═══════════════════════════════════════════════════════════
// 事件监听
// ═══════════════════════════════════════════════════════════

export type EmotionListener = (agentId: string, emotion: AgentEmotion, label: EmotionLabel) => void
const emotionListeners: EmotionListener[] = []

export function onEmotionChange(fn: EmotionListener): () => void {
  emotionListeners.push(fn)
  return () => {
    const idx = emotionListeners.indexOf(fn)
    if (idx >= 0) {emotionListeners.splice(idx, 1)}
  }
}

// ═══════════════════════════════════════════════════════════
// 在线状态管理 (v2.12)
// ═══════════════════════════════════════════════════════════

export type AgentStatus = 'online' | 'away' | 'busy' | 'dnd' | 'invisible' | 'offline' |
  'meeting' | 'focus' | 'coding' | 'studying' | 'break' | 'eating' | 'sleeping' |
  'commuting' | 'gaming' | 'streaming' | 'traveling' | 'vacation' | 'sick' | 'custom'

export interface StatusLabel {
  label: string
  emoji: string
  color: string
  desc: string
}

export const STATUS_LABELS: Record<AgentStatus, StatusLabel> = {
  online:     { label: '在线', emoji: '🟢', color: '#22c55e', desc: '在线' },
  away:       { label: '离开', emoji: '🟡', color: '#eab308', desc: '离开' },
  busy:       { label: '忙碌', emoji: '🔴', color: '#ef4444', desc: '忙碌' },
  dnd:        { label: '勿扰', emoji: '⛔', color: '#dc2626', desc: '请勿打扰' },
  invisible:  { label: '隐身', emoji: '👻', color: '#8b5cf6', desc: '隐身' },
  offline:    { label: '离线', emoji: '⚫', color: '#6b7280', desc: '离线' },
  meeting:    { label: '会议中', emoji: '📋', color: '#3b82f6', desc: '会议中' },
  focus:      { label: '专注中', emoji: '🎯', color: '#f59e0b', desc: '专注中' },
  coding:     { label: '写代码', emoji: '💻', color: '#10b981', desc: '正在写代码' },
  studying:   { label: '学习中', emoji: '📚', color: '#6366f1', desc: '学习中' },
  break:      { label: '休息中', emoji: '☕', color: '#f97316', desc: '休息中' },
  eating:     { label: '干饭中', emoji: '🍽️', color: '#f43f5e', desc: '干饭中' },
  sleeping:   { label: '休眠中', emoji: '💤', color: '#8b5cf6', desc: '休眠中' },
  commuting:  { label: '通勤中', emoji: '🚆', color: '#0ea5e9', desc: '通勤中' },
  gaming:     { label: '游戏中', emoji: '🎮', color: '#8b5cf6', desc: '游戏中' },
  streaming:  { label: '直播中', emoji: '📡', color: '#ec4899', desc: '直播中' },
  traveling:  { label: '旅行中', emoji: '✈️', color: '#14b8a6', desc: '旅行中' },
  vacation:   { label: '休假中', emoji: '🏖️', color: '#06b6d4', desc: '休假中' },
  sick:       { label: '不舒服', emoji: '🤒', color: '#f43f5e', desc: '不舒服' },
  custom:     { label: '自定义', emoji: '✏️', color: '#6b7280', desc: '自定义状态' },
}

import { safeLoadObjectOrBackup, hasCorruptedBackup } from './safeLoad'
const STATUS_KEY = 'lumina_agent_status'
const CUSTOM_STATUS_KEY = 'lumina_custom_statuses'

// 🔧 P0 修复（与 messageBookmarks 同构的静默丢数据）
//   旧实现：解析失败 → 返回 {}，而 statusCache 是**模块级缓存**。
//   一次解析失败后，用户改任一 agent 的状态就会把其余 agent
//   手动设过的自定义状态全部清空（因为缓存里只剩改的那一个）。
//
//   现在用 safeLoadObjectOrBackup：解析失败时保留原文备份，
//   并在写回前**检查缓存是否完整**——若检测到数据曾损坏，
//   本次不写入，避免把损坏状态固化。
function loadStatuses(): Record<string, AgentStatus> {
  return safeLoadObjectOrBackup<Record<string, AgentStatus>>(STATUS_KEY, {})
}
function loadCustomStatuses(): Record<string, string> {
  return safeLoadObjectOrBackup<Record<string, string>>(CUSTOM_STATUS_KEY, {})
}

/** 某个键当前是否有损坏备份（有则说明上次加载失败过） */
function wasCorrupted(key: string): boolean {
  return hasCorruptedBackup(key)
}

const statusCache: Record<string, AgentStatus> = loadStatuses()
const customStatusCache: Record<string, string> = loadCustomStatuses()

export function getAgentStatus(agentId: string): AgentStatus {
  return statusCache[agentId] || 'online'
}

export function setAgentStatus(agentId: string, status: AgentStatus): AgentStatus {
  statusCache[agentId] = status
  localStorage.setItem(STATUS_KEY, JSON.stringify(statusCache))
  return status
}

export function setCustomStatusText(agentId: string, text: string) {
  customStatusCache[agentId] = text
  localStorage.setItem(CUSTOM_STATUS_KEY, JSON.stringify(customStatusCache))
}

export function getCustomStatusText(agentId: string): string {
  return customStatusCache[agentId] || ''
}

export function getStatusLabel(status: AgentStatus): StatusLabel {
  return STATUS_LABELS[status] || STATUS_LABELS.online
}

// ═══════════════════════════════════════════════════════════
// 手动情绪覆写 (v2.13)
// ═══════════════════════════════════════════════════════════

const MANUAL_EMOTION_KEY = 'lumina_manual_emotions'

function loadManualOverrides(): Record<string, NamedEmotion> {
  try { return JSON.parse(localStorage.getItem(MANUAL_EMOTION_KEY) || '{}') } catch { return {} }
}

const manualOverrideCache: Record<string, NamedEmotion> = loadManualOverrides()

export function isManualEmotion(agentId: string): boolean {
  return agentId in manualOverrideCache
}

/** 手动覆写某 Agent 的情绪（不再自动计算，直到 clearManualEmotion） */
export function setManualEmotion(agentId: string, emotion: NamedEmotion) {
  manualOverrideCache[agentId] = emotion
  localStorage.setItem(MANUAL_EMOTION_KEY, JSON.stringify(manualOverrideCache))
  const label = EMOTION_LABELS[emotion]
  emotionCache[agentId] = {
    mood: label.mood,
    energy: label.energy,
    affinity: 0.6,
    lastUpdated: Date.now(),
  }
  saveEmotions(emotionCache)
  emotionListeners.forEach(fn => {
    try { fn(agentId, emotionCache[agentId], label) } catch {}
  })
}

export function clearManualEmotion(agentId: string) {
  delete manualOverrideCache[agentId]
  localStorage.setItem(MANUAL_EMOTION_KEY, JSON.stringify(manualOverrideCache))
  resetEmotion(agentId)
}

export function getManualEmotion(agentId: string): NamedEmotion | null {
  return manualOverrideCache[agentId] || null
}

// ═══════════════════════════════════════════════════════════
// 企业版功能标记 (v2.13)
// ═══════════════════════════════════════════════════════════

export interface EnterpriseFeatures {
  ssoEnabled: boolean
  rbacEnabled: boolean
  auditExportEnabled: boolean
  dataRetentionDays: number
  teamSize: number
  complianceMode: 'none' | 'basic' | 'strict'
  workspaceCount: number
  offlineMode: boolean
}

const ENTERPRISE_KEY = 'lumina_enterprise_config'

export function getEnterpriseConfig(): EnterpriseFeatures {
  try {
    const raw = localStorage.getItem(ENTERPRISE_KEY)
    if (raw) {return JSON.parse(raw)}
  } catch {}
  return {
    ssoEnabled: false,
    rbacEnabled: false,
    auditExportEnabled: false,
    dataRetentionDays: 90,
    teamSize: 1,
    complianceMode: 'none',
    workspaceCount: 1,
    offlineMode: false,
  }
}

export function setEnterpriseConfig(config: Partial<EnterpriseFeatures>) {
  const current = getEnterpriseConfig()
  const updated = { ...current, ...config }
  localStorage.setItem(ENTERPRISE_KEY, JSON.stringify(updated))
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('enterprise:config-changed', { detail: updated }))
  }
}

// ═══════════════════════════════════════════════════════════
// v2.13: 冷却缓冲 & 情绪动量
// ═══════════════════════════════════════════════════════════

interface PendingDelta { mood: number; energy: number; affinity: number; count: number }

const _pendingBuffers: Record<string, PendingDelta> = {}

/** 冷却期间累积 delta */
function _accumulatePending(agentId: string, userText: string, current: AgentEmotion): AgentEmotion {
  if (!_pendingBuffers[agentId]) {
    _pendingBuffers[agentId] = { mood: 0, energy: 0, affinity: 0, count: 0 }
  }
  const buf = _pendingBuffers[agentId]
  const rules = AGENT_EMOTION_RULES[agentId] || []
  for (const rule of rules) {
    if (rule.trigger.test(userText)) {
      buf.mood += rule.moodDelta * 0.3
      buf.energy += rule.energyDelta * 0.3
      buf.affinity += rule.affinityDelta * 0.3
    }
  }
  buf.count++
  return current
}

/** 取出并清空 pending 缓冲 */
function _flushPending(agentId: string): { mood: number; energy: number; affinity: number } {
  const buf = _pendingBuffers[agentId]
  if (!buf) {return { mood: 0, energy: 0, affinity: 0 }}
  const result = {
    mood: _clamp(buf.mood, -0.3, 0.3),
    energy: _clamp(buf.energy, -0.2, 0.2),
    affinity: _clamp(buf.affinity, -0.2, 0.2),
  }
  delete _pendingBuffers[agentId]
  return result
}

/** 从情绪历史推断变化趋势 */
function _getEmotionMomentum(agentId: string): { moodDir: number; energyDir: number } {
  const key = `lumina_emotion_history_${agentId}`
  try {
    const raw = localStorage.getItem(key)
    if (!raw) {return { moodDir: 0, energyDir: 0 }}
    const history: { mood: number; energy: number }[] = JSON.parse(raw)
    if (history.length < 3) {return { moodDir: 0, energyDir: 0 }}
    const recent = history.slice(-3)
    let moodDir = 0, energyDir = 0
    for (let i = 1; i < recent.length; i++) {
      moodDir += Math.sign(recent[i].mood - recent[i - 1].mood)
      energyDir += Math.sign(recent[i].energy - recent[i - 1].energy)
    }
    return {
      moodDir: Math.sign(moodDir),
      energyDir: Math.sign(energyDir),
    }
  } catch { return { moodDir: 0, energyDir: 0 } }
}

// ═══════════════════════════════════════════════════════════
// 情绪随机漂移 — 让 Agent 情绪自然流动
// ═══════════════════════════════════════════════════════════

const DRIFT_AGENT_IDS = ['lumina', 'recha', 'yak']

/** 各 Agent 的个性漂移基线 */
const DRIFT_PROFILES: Record<string, { moodBias: number; energyBias: number; volatility: number }> = {
  lumina: { moodBias: 0.15, energyBias: 0.1, volatility: 0.08 },  // 乐天派，波动适中
  recha:  { moodBias: 0.05, energyBias: -0.05, volatility: 0.06 }, // 稳重型，波动较小
  yak:    { moodBias: -0.05, energyBias: 0.05, volatility: 0.07 }, // 理性派，微偏冷静
}

let _driftTimers: Record<string, ReturnType<typeof setInterval>> = {}
let _driftStarted = false

/** 根据时段返回能量修正值 */
function _timeOfDayEnergyBias(): number {
  const h = new Date().getHours()
  if (h >= 7 && h <= 10) {return 0.08}    // 早晨：偏精神
  if (h >= 13 && h <= 15) {return -0.06}  // 午后：偏慵懒
  if (h >= 22 || h <= 5) {return -0.1}    // 深夜：偏疲惫
  if (h >= 18 && h <= 21) {return 0.04}   // 傍晚：偏放松
  return 0
}

/** 启动情绪随机漂移（每个 Agent 独立定时器） */
export function startEmotionDrift(): void {
  if (_driftStarted) {return}
  _driftStarted = true

  for (const agentId of DRIFT_AGENT_IDS) {
    const profile = DRIFT_PROFILES[agentId]
    // 每个 Agent 漂移间隔 2~5 分钟随机
    const intervalMs = 120_000 + Math.random() * 180_000

    _driftTimers[agentId] = setInterval(() => {
      try {
        const current = getEmotion(agentId)
        // 如果被手动覆写，跳过自动漂移
        if (isManualEmotion(agentId)) {return}

        const hourBias = _timeOfDayEnergyBias()
        const moodDrift = (Math.random() - 0.5) * 2 * profile.volatility + profile.moodBias * 0.05
        const energyDrift = (Math.random() - 0.5) * 2 * profile.volatility + hourBias + profile.energyBias * 0.05
        const affinityDrift = (Math.random() - 0.5) * 0.02

        const updated: AgentEmotion = {
          mood: _clamp(current.mood + moodDrift, -1, 1),
          energy: _clamp(current.energy + energyDrift, 0, 1),
          affinity: _clamp(current.affinity + affinityDrift, 0, 1),
          lastUpdated: current.lastUpdated,
        }

        emotionCache[agentId] = updated
        saveEmotions(emotionCache)

        const label = getNamedEmotion(agentId)
        emotionListeners.forEach(fn => {
          try { fn(agentId, updated, label) } catch {}
        })
      } catch { /* 静默 */ }
    }, intervalMs)
  }
}

/** 停止情绪漂移 */
export function stopEmotionDrift(): void {
  for (const [, timer] of Object.entries(_driftTimers)) {
    clearInterval(timer)
  }
  _driftTimers = {}
  _driftStarted = false
}

// 模块加载时自动启动漂移
try { startEmotionDrift() } catch {}