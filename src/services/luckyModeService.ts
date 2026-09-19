// ============================================================
// luckyModeService.ts — Lucky 模式前端服务 (v1.0)
//
// 管理 Lucky 模式的 UI 状态：当前预设、运行状态、暂停状态
// 与后端 electron/luckyMode.ts 对接
// ============================================================

import type { LuckyModePreset } from '../components/LuckyModeSelector'
import type { LuckySettingsConfig } from '../components/LuckyModeSettings'

export interface LuckyRuntimeInfo {
  preset: LuckyModePreset
  isActive: boolean
  currentIteration: number
  maxIteration: number
  isPaused: boolean
  pauseReason: string | null
  completionPercent?: number
  completedTasks?: number
  totalTasks?: number
}

export interface LuckyModeServiceState {
  currentPreset: LuckyModePreset
  settings: LuckySettingsConfig
  runtime: LuckyRuntimeInfo
}

// ── 默认状态 ──

function createDefaultRuntime(preset: LuckyModePreset = 'off'): LuckyRuntimeInfo {
  return {
    preset,
    isActive: false,
    currentIteration: 0,
    maxIteration: preset === 'goal' ? 50 : preset === 'mission' ? 100 : 25,
    isPaused: false,
    pauseReason: null,
  }
}

let _state: LuckyModeServiceState = {
  currentPreset: 'off',
  settings: {
    preset: 'off',
    maxIterations: 25,
    doomLoop: {
      windowSize: 5,
      similarityThreshold: 0.85,
      maxRepetitions: 3,
      interventionAction: 'pause',
      reminderMessage: '🔄 我注意到你在重复做类似的操作，是不是遇到困难了？要不要换个思路？',
    },
    completionRubric: {
      enabled: true,
      rePromptOnTextOnly: true,
      rePromptMessage: '看起来你还没完成，能再检查一下吗？如果需要工具调用，请直接使用。',
      maxInterventionsPerTurn: 2,
    },
    goal: {
      maxIterations: 50,
      tokenBudget: 100000,
      goalDescription: '',
      completionCriteria: '',
      subTasks: [],
      bypassIterationLimit: false,
      trackProgress: true,
      useLLMEvaluation: true,
    },
    mission: {
      subTasks: [],
      bypassIterationLimit: true,
      trackProgress: true,
    },
  },
  runtime: createDefaultRuntime('off'),
}

// ── 订阅者模式 ──

type Subscriber = (state: LuckyModeServiceState) => void
const subscribers = new Set<Subscriber>()

function notify() {
  for (const sub of subscribers) {
    try { sub(_state) } catch {}
  }
}

export function subscribe(fn: Subscriber) {
  subscribers.add(fn)
  return () => subscribers.delete(fn)
}

export function getState(): LuckyModeServiceState {
  return _state
}

// ── 动作 ──

export function setPreset(preset: LuckyModePreset) {
  _state = {
    ..._state,
    currentPreset: preset,
    runtime: {
      ..._state.runtime,
      preset,
      isActive: preset !== 'off',
      currentIteration: preset !== _state.currentPreset ? 0 : _state.runtime.currentIteration,
      maxIteration: preset === 'goal' ? 50 : preset === 'mission' ? 100 : 25,
      isPaused: false,
      pauseReason: null,
    },
  }
  notify()
}

export function updateRuntime(partial: Partial<LuckyRuntimeInfo>) {
  _state = {
    ..._state,
    runtime: { ..._state.runtime, ...partial },
  }
  notify()
}

export function saveSettings(settings: LuckySettingsConfig) {
  _state = {
    ..._state,
    settings,
    currentPreset: settings.preset,
    runtime: {
      ..._state.runtime,
      preset: settings.preset,
      isActive: settings.preset !== 'off',
      currentIteration: 0,
      maxIteration: settings.preset === 'goal' ? settings.goal.maxIterations : settings.maxIterations,
      isPaused: false,
      pauseReason: null,
    },
  }
  notify()

  // 持久化到后端
  try {
    window.luminaAPI?.luckyModeSaveConfig?.(settings)
  } catch {}
}

export function setPaused(paused: boolean, reason: string | null = null) {
  _state = {
    ..._state,
    runtime: {
      ..._state.runtime,
      isPaused: paused,
      pauseReason: reason,
    },
  }
  notify()
}

export function incrementIteration() {
  _state = {
    ..._state,
    runtime: {
      ..._state.runtime,
      currentIteration: _state.runtime.currentIteration + 1,
    },
  }
  notify()
}

// ═══ 死循环检测 ═══

/** 文本相似度计算（简单的 Jaccard 相似度） */
function textSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().replace(/[^\u4e00-\u9fa5a-z0-9]/g, ' ').split(/\s+/).filter(Boolean))
  const wordsB = new Set(b.toLowerCase().replace(/[^\u4e00-\u9fa5a-z0-9]/g, ' ').split(/\s+/).filter(Boolean))
  if (wordsA.size === 0 || wordsB.size === 0) {return 0}
  let intersection = 0
  for (const w of wordsA) { if (wordsB.has(w)) {intersection++} }
  return intersection / (wordsA.size + wordsB.size - intersection)
}

/** 最近回复历史（内存中保留最近 windowSize 条） */
const recentReplies: string[] = []

/** 记录一次 Agent 回复 */
export function recordReply(text: string) {
  const settings = _state.settings
  const windowSize = settings.doomLoop?.windowSize || 5
  recentReplies.push(text)
  while (recentReplies.length > windowSize) {recentReplies.shift()}
}

/** 检测死循环 — 返回 null 表示正常，返回字符串表示检测到循环 */
export function detectDoomLoop(): string | null {
  const settings = _state.settings
  const doomLoop = settings.doomLoop
  if (!doomLoop) {return null}

  const threshold = doomLoop.similarityThreshold || 0.85
  const maxReps = doomLoop.maxRepetitions || 3

  // 对最近回复做两两比较
  let repetitions = 0
  for (let i = 1; i < recentReplies.length; i++) {
    const sim = textSimilarity(recentReplies[i - 1], recentReplies[i])
    if (sim >= threshold) {
      repetitions++
    } else {
      repetitions = 0
    }
    if (repetitions >= maxReps - 1) {
      return doomLoop.reminderMessage || '🔄 我注意到你在重复做类似的操作，要不要换个思路？'
    }
  }
  return null
}

/** 清空回复历史（新对话时调用） */
export function resetReplyHistory() {
  recentReplies.length = 0
}

// ═══ 完成度检查 ═══

/** 检测 Agent 回复是否表示任务已完成 */
export function detectCompletion(agentReply: string): boolean {
  const settings = _state.settings
  if (!settings.completionRubric?.enabled) {return false}

  const lower = agentReply.toLowerCase()
  const completionKeywords = [
    '已完成', '完成了', '搞定', 'done', '完成',
    '已经做好', '全部完成', '任务完成', '成功完成',
    '已经搞定', '已经处理', '已经修复', '已修复',
  ]

  // 如果回复中包含完成关键词，且没有工具调用（表示纯文本回复），视为完成
  const hasToolCall = agentReply.includes('```') && (
    agentReply.includes('bash') || agentReply.includes('python') ||
    agentReply.includes('shell') || agentReply.includes('execute')
  )

  if (settings.completionRubric.rePromptOnTextOnly && hasToolCall) {
    return false // 包含工具调用说明还没真正完成
  }

  return completionKeywords.some(kw => lower.includes(kw))
}

// ═══ Lucky 模式核心：每次 Agent 回复后调用 ═══

export interface LuckyCheckResult {
  shouldPause: boolean
  pauseReason: string | null
  isDoomLoop: boolean
  doomLoopMessage: string | null
  isCompleted: boolean
  shouldRePrompt: boolean
  rePromptMessage: string | null
}

/**
 * 在每次 Agent 回复后调用，执行所有 Lucky 模式检查
 * @param agentReply Agent 的回复文本
 * @returns 检查结果，告诉调用方是否需要干预
 */
export function checkAfterReply(agentReply: string): LuckyCheckResult {
  const state = _state
  const result: LuckyCheckResult = {
    shouldPause: false,
    pauseReason: null,
    isDoomLoop: false,
    doomLoopMessage: null,
    isCompleted: false,
    shouldRePrompt: false,
    rePromptMessage: null,
  }

  // 1. 记录回复
  recordReply(agentReply)

  // 2. 迭代计数
  incrementIteration()

  // 3. 检查是否超过最大迭代次数
  if (state.runtime.currentIteration >= state.runtime.maxIteration) {
    result.shouldPause = true
    result.pauseReason = `⚠️ 已达到最大迭代次数 ${state.runtime.maxIteration}，自动暂停。`
    setPaused(true, result.pauseReason)
    return result
  }

  // 4. 死循环检测
  const doomMsg = detectDoomLoop()
  if (doomMsg) {
    result.isDoomLoop = true
    result.doomLoopMessage = doomMsg
    if (state.settings.doomLoop?.interventionAction === 'pause') {
      result.shouldPause = true
      result.pauseReason = doomMsg
      setPaused(true, doomMsg)
    }
  }

  // 5. 完成度检查
  if (state.settings.completionRubric?.enabled) {
    const completed = detectCompletion(agentReply)
    if (completed) {
      result.isCompleted = true
    } else if (state.settings.completionRubric.rePromptOnTextOnly) {
      // 未检测到完成，但可能需要提醒
      const interventionCount = state.runtime.currentIteration
      const maxInterventions = state.settings.completionRubric.maxInterventionsPerTurn || 2
      if (interventionCount > 0 && interventionCount % 5 === 0 && interventionCount <= maxInterventions * 5) {
        result.shouldRePrompt = true
        result.rePromptMessage = state.settings.completionRubric.rePromptMessage || '看起来你还没完成，能再检查一下吗？'
      }
    }
  }

  return result
}

// ── 从后端加载配置 ──

export async function loadFromBackend() {
  try {
    // 🐛 修复：preload 导出的是 luckyModeGetConfig，不是 luckyModeLoadConfig
    const result = await window.luminaAPI?.luckyModeGetConfig?.()
    const config = result?.config
    if (config) {
      _state = {
        ..._state,
        settings: config as LuckySettingsConfig,
        currentPreset: config.preset,
        runtime: {
          ..._state.runtime,
          preset: config.preset,
          isActive: config.preset !== 'off',
          maxIteration: config.preset === 'goal' ? config.goal.maxIterations : config.maxIterations,
        },
      }
      notify()
    }
  } catch {}
}

// ── 与其他面板共享的事件 ──

export function dispatchLuckyModeEvent(type: string, detail?: any) {
  window.dispatchEvent(new CustomEvent('lucky-mode:' + type, { detail }))
}

// ── 初始加载 ──

// 在模块加载时自动尝试读取后端配置
if (typeof window !== 'undefined') {
  setTimeout(() => loadFromBackend(), 1000)
}
