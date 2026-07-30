// ============================================================
// luckyMode.ts — Lucky 模式决策引擎
//
// 负责三种预设模式的决策逻辑：
//   - Default — ReAct 循环的防死循环 + 自动完成检查
//   - Goal — 目标驱动 + 子任务拆解（合并原 Mission）
// ============================================================

import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'

// ═══════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════

export type LuckyModePreset = 'off' | 'default' | 'goal' | 'mission'  // 'mission' deprecated, merged into 'goal'

export interface LuckyDoomLoopConfig {
  /** 检测窗口大小 */
  windowSize: number
  /** 工具调用参数 Jaccard 相似度阈值 */
  similarityThreshold: number
  /** 窗口内允许的最大重复次数 */
  maxRepetitions: number
  /** 触发后的干预方式 */
  interventionAction: 'pause' | 'remind'
  /** 提醒文案 */
  reminderMessage: string
}

export interface LuckyCompletionRubric {
  /** 启用完成检查 */
  enabled: boolean
  /** 纯文本未调用工具时重新提示 */
  rePromptOnTextOnly: boolean
  /** 重新提示时的文案 */
  rePromptMessage: string
  /** 每轮最多干预次数 */
  maxInterventionsPerTurn: number
}

export interface LuckyGoalConfig {
  /** 最大迭代轮数 */
  maxIterations: number
  /** Token 预算（超过即自动结束会话） */
  tokenBudget: number
  /** 当前会话已用 Token */
  usedTokens: number
  /** 目标描述 */
  goalDescription: string
  /** 完成度评估标准（自然语言描述） */
  completionCriteria: string
  /** 是否运行中 */
  isActive: boolean
  // 🆕 合并自 Mission：子任务列表
  subTasks: string[]
  /** 已完成子任务 */
  completedSubTasks: string[]
  /** 当前进行中的子任务 */
  currentSubTask: string | null
  /** 是否解除 ReAct 迭代限制 */
  bypassIterationLimit: boolean
  /** 进度追踪启用 */
  trackProgress: boolean
  /** 🆕 v3.0: LLM 精确评估开关 */
  useLLMEvaluation: boolean
}

/** @deprecated 已合并到 LuckyGoalConfig，保留兼容旧配置 */
export interface LuckyMissionConfig {
  subTasks: string[]
  completedSubTasks: string[]
  currentSubTask: string | null
  bypassIterationLimit: boolean
  trackProgress: boolean
}

export interface LuckyModeConfig {
  preset: LuckyModePreset

  // ── Default (ReAct) ──
  /** 最大迭代轮数 */
  maxIterations: number
  /** 死循环保护 */
  doomLoop: LuckyDoomLoopConfig
  /** 完成检查 */
  completionRubric: LuckyCompletionRubric

  // ── Goal ──
  /** 目标模式配置 */
  goal: LuckyGoalConfig

  // ── Mission (Deprecated) ──
  /** 任务模式配置 */
  mission: LuckyMissionConfig
}

// ── 运行时状态追踪 ──

export interface LuckyModeState {
  /** 当前使用的预设 */
  activePreset: LuckyModePreset
  /** 当前迭代轮次计数 */
  currentIteration: number
  /** 最近工具调用历史（用于死循环检测） */
  recentToolCalls: Array<{
    toolName: string
    args: string
    timestamp: number
  }>
  /** 当前轮次内已完成的文本输出次数（用于完成检查） */
  textOnlyCount: number
  /** 是否被暂停（等待用户介入） */
  isPaused: boolean
  /** 暂停原因 */
  pauseReason: string | null
  /** 会话开始时间 */
  sessionStartedAt: number | null
  /** 目标模式专用状态 */
  goalState: {
    /** 本轮已用 token */
    sessionTokens: number
    /** 达到完成度的置信度 (0~1) */
    completionConfidence: number
    /** 最后一次完成度评估结果 */
    lastEvaluation: string | null
  }
  /** 任务模式专用状态（deprecated） */
  missionState: {
    /** 当前任务阶段 */
    currentPhase: string | null
    /** 已完成阶段的列表 */
    completedPhases: string[]
  }
}

// ── 默认配置 ──

export const DEFAULT_LUCKY_CONFIG: LuckyModeConfig = {
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
    usedTokens: 0,
    goalDescription: '',
    completionCriteria: '',
    isActive: false,
    // 🆕 合并自 Mission
    subTasks: [],
    completedSubTasks: [],
    currentSubTask: null,
    bypassIterationLimit: true,
    trackProgress: true,
    useLLMEvaluation: false,
  },

  // @deprecated 保留兼容旧配置
  mission: {
    subTasks: [],
    completedSubTasks: [],
    currentSubTask: null,
    bypassIterationLimit: true,
    trackProgress: true,
  },
}

export const LUCKY_MODE_PRESETS: Record<LuckyModePreset, {
  label: string
  icon: string
  description: string
  configOverrides: Partial<LuckyModeConfig>
}> = {
  off: {
    label: '关闭',
    icon: '⏹️',
    description: '不使用 Lucky 模式，AI 按默认方式回复',
    configOverrides: { preset: 'off' },
  },
  default: {
    label: '标准循环',
    icon: '🔄',
    description: '防死循环 + 自动完成检查，适合日常对话',
    configOverrides: {
      preset: 'default',
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
    },
  },
  goal: {
    label: '目标驱动',
    icon: '🎯',
    description: '设定目标后AI反复尝试直到完成，支持子任务拆解',
    configOverrides: {
      preset: 'goal',
      maxIterations: 50,
      goal: {
        maxIterations: 50,
        tokenBudget: 100000,
        usedTokens: 0,
        goalDescription: '',
        completionCriteria: '',
        isActive: true,
        subTasks: [],
        completedSubTasks: [],
        currentSubTask: null,
        bypassIterationLimit: true,
        trackProgress: true,
        useLLMEvaluation: false,
      },
    },
  },
  mission: {
    label: '任务拆解（已弃用）',
    icon: '📋',
    description: '已迁移至目标模式子任务功能',
    configOverrides: { preset: 'off' },
  },
}

// ── 相似度计算工具 ──

function toolCallSimilarity(a: string, b: string): number {
  // 简单的字符级 Jaccard 相似度
  const setA = new Set(a.toLowerCase().split('').filter(c => c.trim()))
  const setB = new Set(b.toLowerCase().split('').filter(c => c.trim()))
  const intersection = new Set([...setA].filter(c => setB.has(c)))
  const union = new Set([...setA, ...setB])
  return union.size > 0 ? intersection.size / union.size : 0
}

// ── 死循环检测 ──

export function checkDoomLoop(
  state: LuckyModeState,
  config: LuckyDoomLoopConfig,
): { isDoomLoop: boolean; reason: string | null } {
  const recentCalls = state.recentToolCalls.slice(-config.windowSize)
  if (recentCalls.length < config.windowSize) {
    return { isDoomLoop: false, reason: null }
  }

  // 🆕 浏览器/搜索工具豁免：连续搜网页不算死循环
  const browsingTools = ['browser', 'search', 'web_search', 'fetch', 'web_fetch', 'screenshot']
  const allBrowsing = recentCalls.every(t => browsingTools.includes(t.toolName))
  if (allBrowsing) {
    return { isDoomLoop: false, reason: null }
  }

  // 统计窗口内相似工具调用
  let repetitionCount = 0
  for (let i = 0; i < recentCalls.length - 1; i++) {
    for (let j = i + 1; j < recentCalls.length; j++) {
      const similarity = toolCallSimilarity(recentCalls[i].args, recentCalls[j].args)
      if (similarity >= config.similarityThreshold && recentCalls[i].toolName === recentCalls[j].toolName) {
        repetitionCount++
      }
    }
  }

  // 检查重复比例是否超过阈值
  const totalPairs = (recentCalls.length * (recentCalls.length - 1)) / 2
  const repetitionRate = repetitionCount / totalPairs

  if (repetitionRate >= 0.5 && repetitionCount >= config.maxRepetitions) {
    return {
      isDoomLoop: true,
      reason: `检测到死循环：连续 ${repetitionCount} 次使用 "${recentCalls[recentCalls.length - 1].toolName}" 做类似操作`,
    }
  }

  return { isDoomLoop: false, reason: null }
}

// ── 完成检查 ──

export function checkCompletion(
  text: string,
  config: LuckyCompletionRubric,
  state: LuckyModeState,
): { needsRePrompt: boolean; reason: string | null; rePromptMessage: string | null } {
  if (!config.enabled) {
    return { needsRePrompt: false, reason: null, rePromptMessage: null }
  }

  // 检查纯文本输出且未使用工具
  if (config.rePromptOnTextOnly) {
    // 简单的启发式检查：太短且无工具调用才提示（阈值从 10 放宽到 3）
    if (text.length < 3 && state.textOnlyCount > 0) {
      return {
        needsRePrompt: true,
        reason: '输出仅文字且无工具调用',
        rePromptMessage: config.rePromptMessage,
      }
    }

    // 🆕 中文短回复直接放过（"好的""明白""继续"等）
    if (/^[\u4e00-\u9fff]{1,4}[\uFF01-\uFF0F]?$/.test(text)) {
      return { needsRePrompt: false, reason: null, rePromptMessage: null }
    }

    // 如果输出中包含了"建议""你可以"但没实质内容
    const suggestionPatterns = [
      /^建议你|^你可以|^我建议|^你试试|^推荐你/,
      // 已移除 "好的|好的呢|收到|明白了|OK|没问题" 等正常回复
    ]
    if (suggestionPatterns.some(p => p.test(text))) {
      return {
        needsRePrompt: true,
        reason: '输出仅为敷衍/建议性内容，未实际执行',
        rePromptMessage: config.rePromptMessage,
      }
    }
  }

  return { needsRePrompt: false, reason: null, rePromptMessage: null }
}

// ── 迭代限制检查 ──

export function checkIterationLimit(
  state: LuckyModeState,
  config: LuckyModeConfig,
): { shouldStop: boolean; reason: string | null } {
  const effectiveLimit = config.preset === 'goal'
    ? config.goal.bypassIterationLimit
      ? config.goal.maxIterations * 2
      : config.goal.maxIterations
    : config.maxIterations

  if (state.currentIteration >= effectiveLimit) {
    return {
      shouldStop: true,
      reason: `已达到最大迭代次数 (${effectiveLimit})，自动停止。如需继续，请重新发送消息。`,
    }
  }

  return { shouldStop: false, reason: null }
}

// ── Token 预算检查 (Goal 模式) ──

export function checkTokenBudget(
  config: LuckyGoalConfig,
  additionalTokens: number = 0,
): { overBudget: boolean; reason: string | null } {
  const totalUsed = config.usedTokens + additionalTokens
  if (config.tokenBudget > 0 && totalUsed >= config.tokenBudget) {
    return {
      overBudget: true,
      reason: `Token 预算已用尽 (${totalUsed}/${config.tokenBudget})，目标会话结束。`,
    }
  }
  return { overBudget: false, reason: null }
}

// ── 目标完成度评估 (Goal 模式) — 基于 LLM 输出判断 ──

export function evaluateGoalCompletion(
  lastOutput: string,
  criteria: string,
  /** 🆕 v3.0: LLM 精确评估结果（可选），传入后跳过关键词匹配 */
  llmEvaluation?: { confidence: number; evaluation: string } | null,
): { confidence: number; evaluation: string } {
  // 如果有 LLM 评估结果，直接使用
  if (llmEvaluation) {
    return llmEvaluation
  }

  // 原有启发式评估（关键词匹配）
  const lower = lastOutput.toLowerCase()

  // 完成信号
  const completionSignals = [
    '已完成', '完成了', '任务完成', '搞定了', '做好了',
    'done', 'completed', 'finished', 'accomplished',
    '成功', '顺利', '通过', '✅', '✔️',
  ]
  // 未完成信号
  const incompleteSignals = [
    '还没', '尚未', '还未', '需要继续', '下一步', '后续',
    '还差', '存在问题', '出现问题', '遇到问题', '有bug',
    '未完成', 'not done', 'incomplete', 'todo', 'tbd',
    'error', '错误', '失败', '❌',
  ]

  let score = 0.5  // 默认中性

  const hasCompletionSignal = completionSignals.some(s => lower.includes(s))
  const hasIncompleteSignal = incompleteSignals.some(s => lower.includes(s))

  if (hasCompletionSignal && !hasIncompleteSignal) score = 0.9
  else if (hasCompletionSignal && hasIncompleteSignal) score = 0.6  // 矛盾信号
  else if (hasIncompleteSignal) score = 0.2
  else if (lastOutput.length > 200) score = 0.7  // 长输出通常意味着做了事

  // 检查是否包含了关键交付物
  if (criteria) {
    const criteriaKeywords = criteria.toLowerCase().split(/[\s,，、]+/).filter(k => k.length > 2)
    const matchedKeywords = criteriaKeywords.filter(k => lower.includes(k))
    if (criteriaKeywords.length > 0) {
      const matchRate = matchedKeywords.length / criteriaKeywords.length
      score = score * 0.5 + matchRate * 0.5  // 结合关键词匹配
    }
  }

  return {
    confidence: Math.round(score * 100) / 100,
    evaluation: score >= 0.7
      ? `✅ 目标完成度评估：${Math.round(score * 100)}% —— 看起来已经完成`
      : score >= 0.4
        ? `⏳ 目标完成度评估：${Math.round(score * 100)}% —— 部分完成，需要继续`
        : `🔄 目标完成度评估：${Math.round(score * 100)}% —— 还需更多工作`,
  }
}

// ── 子任务进度追踪 (Goal 模式) ──

export function trackMissionProgress(
  outputText: string,
  config: LuckyGoalConfig,
): { completedSubTasks: string[]; nextSubTask: string | null; allDone: boolean } {
  const completed = [...config.completedSubTasks]
  const remaining = config.subTasks.filter(t => !completed.includes(t))

  if (remaining.length === 0) {
    return { completedSubTasks: completed, nextSubTask: null, allDone: true }
  }

  // 检测输出中是否提到完成了某个子任务
  const lower = outputText.toLowerCase()
  for (const task of remaining) {
    const taskLower = task.toLowerCase()
    const completionPhrases = [
      `${taskLower}已完成`,
      `${taskLower}完成`,
      `${taskLower}搞定`,
      `完成了${taskLower}`,
      `完成${taskLower}`,
      `${taskLower} done`,
      `${taskLower} completed`,
    ]
    if (completionPhrases.some(p => lower.includes(p))) {
      completed.push(task)
    }
  }

  const stillRemaining = config.subTasks.filter(t => !completed.includes(t))
  return {
    completedSubTasks: completed,
    nextSubTask: stillRemaining[0] || null,
    allDone: stillRemaining.length === 0,
  }
}

// ── 状态工厂 ──

export function createLuckyState(): LuckyModeState {
  return {
    activePreset: 'off',
    currentIteration: 0,
    recentToolCalls: [],
    textOnlyCount: 0,
    isPaused: false,
    pauseReason: null,
    sessionStartedAt: null,
    goalState: {
      sessionTokens: 0,
      completionConfidence: 0,
      lastEvaluation: null,
    },
    missionState: {
      currentPhase: null,
      completedPhases: [],
    },
  }
}

// ── 持久化 ──

function getConfigPath(): string {
  const userDataDir = app.getPath('userData')
  return path.join(userDataDir, 'lucky-mode-config.json')
}

function getStatePath(): string {
  const userDataDir = app.getPath('userData')
  return path.join(userDataDir, 'lucky-mode-state.json')
}

export function loadLuckyConfig(): LuckyModeConfig {
  const configPath = getConfigPath()
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf-8')
      const parsed = JSON.parse(raw)
      // 用默认值补齐缺失字段（兼容旧配置）
      return { ...DEFAULT_LUCKY_CONFIG, ...parsed, goal: { ...DEFAULT_LUCKY_CONFIG.goal, ...(parsed.goal || {}) } }
    }
  } catch (e) {
    console.error('[LuckyMode] 读取配置失败，使用默认值:', e)
  }
  return { ...DEFAULT_LUCKY_CONFIG }
}

export function saveLuckyConfig(config: LuckyModeConfig): void {
  const configPath = getConfigPath()
  try {
    const dir = path.dirname(configPath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
  } catch (e) {
    console.error('[LuckyMode] 保存配置失败:', e)
  }
}

export function loadLuckyState(): LuckyModeState {
  const statePath = getStatePath()
  try {
    if (fs.existsSync(statePath)) {
      const raw = fs.readFileSync(statePath, 'utf-8')
      return JSON.parse(raw)
    }
  } catch (e) {
    console.error('[LuckyMode] 读取状态失败:', e)
  }
  return createLuckyState()
}

export function saveLuckyState(state: LuckyModeState): void {
  const statePath = getStatePath()
  try {
    const dir = path.dirname(statePath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8')
  } catch (e) {
    console.error('[LuckyMode] 保存状态失败:', e)
  }
}

// ── 核心决策 ──

export interface LuckyDecisionContext {
  /** 本轮 AI 输出的文本 */
  outputText: string
  /** 本轮使用的工具数量 */
  toolCallsInThisTurn: number
  /** 本轮使用的 token 数量 */
  tokensUsedInThisTurn: number
  /** 本轮使用的工具名称列表 */
  toolNames: string[]
  /** 当前场景模式（可选，来自 modeManager） */
  currentMode?: string
}

export interface LuckyModeDecision {
  /** 是否允许继续下一轮 */
  shouldContinue: boolean
  /** 是否暂停循环（等待用户介入） */
  shouldPause: boolean
  /** 是否注入提醒消息 */
  shouldRemind: boolean
  /** 提醒/暂停文案 */
  remindMessage: string | null
  /** 状态更新（调用方需要合并到持久状态） */
  stateUpdates: Partial<LuckyModeState>
}

/**
 * Lucky 模式决策入口
 *
 * 在每轮 ReAct 循环后调用，依次检查：
 *   1. 迭代限制
 *   2. 死循环检测 (Default)
 *   3. 完成检查 (Default)
 *   4. Goal 完成度
 *   5. Token 预算
 *   6. Mission 进度追踪（合并到 Goal）
 */
export function luckyModeDecision(
  state: LuckyModeState,
  config: LuckyModeConfig,
  context: LuckyDecisionContext,
): LuckyModeDecision {
  const updates: Partial<LuckyModeState> = {}

  // 1. 迭代限制
  const iterLimit = checkIterationLimit(state, config)
  if (iterLimit.shouldStop) {
    return {
      shouldContinue: false,
      shouldPause: true,
      shouldRemind: false,
      remindMessage: iterLimit.reason,
      stateUpdates: {},
    }
  }

  // ── Default 模式相关检查 ──

  if (config.preset === 'default') {
    // 2. 死循环检测
    const doomLoop = checkDoomLoop(state, config.doomLoop)
    if (doomLoop.isDoomLoop) {
      if (config.doomLoop.interventionAction === 'pause') {
        return {
          shouldContinue: false,
          shouldPause: true,
          shouldRemind: false,
          remindMessage: doomLoop.reason + '——' + config.doomLoop.reminderMessage,
          stateUpdates: { isPaused: true, pauseReason: doomLoop.reason },
        }
      } else {
        return {
          shouldContinue: true,
          shouldPause: false,
          shouldRemind: true,
          remindMessage: doomLoop.reason + '——' + config.doomLoop.reminderMessage,
          stateUpdates: { isPaused: false, pauseReason: null },
        }
      }
    }

    // 3. 完成检查
    const completion = checkCompletion(context.outputText, config.completionRubric, state)
    if (completion.needsRePrompt) {
      const canIntervene = (state.textOnlyCount || 0) <= config.completionRubric.maxInterventionsPerTurn
      if (canIntervene) {
        return {
          shouldContinue: true,
          shouldPause: false,
          shouldRemind: true,
          remindMessage: completion.rePromptMessage,
          stateUpdates: {},
        }
      }
    }
  }

  // ── Goal 模式相关检查 ──

  if (config.preset === 'goal') {
    // 4. Goal 完成度评估（支持 LLM 精确评估）
    const evaluation = evaluateGoalCompletion(context.outputText, config.goal.completionCriteria, null)
    updates.goalState = {
      ...state.goalState,
      completionConfidence: evaluation.confidence,
      lastEvaluation: evaluation.evaluation,
    }

    // 如果完成度高，给出提醒
    if (evaluation.confidence >= 0.9) {
      return {
        shouldContinue: false,
        shouldPause: false,
        shouldRemind: true,
        remindMessage: evaluation.evaluation + ' 🎉 目标似乎已完成，是否继续？',
        stateUpdates: updates,
      }
    }

    // 5. Token 预算检查
    const budget = checkTokenBudget(config.goal, context.tokensUsedInThisTurn)
    if (budget.overBudget) {
      return {
        shouldContinue: false,
        shouldPause: true,
        shouldRemind: false,
        remindMessage: budget.reason,
        stateUpdates: updates,
      }
    }

    // 6. 🆕 子任务进度追踪（原 Mission）
    if (config.goal.subTasks.length > 0 && config.goal.trackProgress) {
      const progress = trackMissionProgress(context.outputText, config.goal)
      if (progress.allDone) {
        return {
          shouldContinue: false,
          shouldPause: false,
          shouldRemind: true,
          remindMessage: '📋 所有子任务已完成！目标模式结束。',
          stateUpdates: {
            ...updates,
            goalState: {
              ...(updates.goalState || state.goalState),
            },
          },
        }
      }
      if (progress.nextSubTask !== config.goal.currentSubTask) {
        updates.goalState = {
          ...(updates.goalState || state.goalState),
          currentSubTask: progress.nextSubTask,
          completedSubTasks: progress.completedSubTasks,
        }
      }
    }
  }

  return {
    shouldContinue: true,
    shouldPause: false,
    shouldRemind: false,
    remindMessage: null,
    stateUpdates: updates,
  }
}
