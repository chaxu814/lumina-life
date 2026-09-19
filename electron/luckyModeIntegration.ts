// ============================================================
// luckyModeIntegration.ts — Lucky 模式深度集成桥接
//
// 负责将 luckyMode.ts 引擎连接到 Lumina 的四个子系统：
//   1. agentRunner.ts    — ReAct 循环控制
//   2. delegationManager.ts — 多 Agent 团队循环控制
//   3. modeManager.ts    — 场景感知自适应
//   4. agentSocialEngine.ts — 情绪影响循环行为
//
// 设计原则：最小侵入 — 依赖方只需调用一个函数，不修改已有逻辑
// ============================================================

import {
  type LuckyModeConfig,
  type LuckyModeState,
  type LuckyModeDecision,
  type LuckyModePreset,
  DEFAULT_LUCKY_CONFIG,
  createLuckyState,
  luckyModeDecision,
  checkIterationLimit,
  checkDoomLoop,
  checkCompletion,
  evaluateGoalCompletion,
  loadLuckyConfig,
  saveLuckyConfig,
  loadLuckyState,
  saveLuckyState,
} from './luckyMode'

import { globalEventBus, BusEvents } from './eventBus'

// ═══════════════════════════════════════════════════════════
// 运行时单例
// ═══════════════════════════════════════════════════════════

let _config: LuckyModeConfig = (() => {
  try { return loadLuckyConfig() } catch { return { ...DEFAULT_LUCKY_CONFIG } }
})()

let _state: LuckyModeState = (() => {
  try { return loadLuckyState() } catch { return createLuckyState() }
})()

let _currentMode = 'work'      // 当前场景模式（由 modeManager 更新）
let _currentMood = 'neutral'   // 当前 Agent 情绪（由 socialEngine 更新）
let _integrationInitialized = false

/** 获取当前场景模式 */
export function getCurrentMode(): string {
  return _currentMode
}

/** 设置当前场景模式（由 modeManager 调用） */
export function setCurrentMode(mode: string): void {
  _currentMode = mode
}

/** 获取当前 Agent 情绪 */
export function getCurrentMood(): string {
  return _currentMood
}

/** 设置当前 Agent 情绪（由 socialEngine 调用） */
export function setCurrentMood(mood: string): void {
  _currentMood = mood
}

/** 获取当前 Lucky 配置 */
export function getConfig(): LuckyModeConfig {
  return _config
}

/** 获取当前 Lucky 状态 */
export function getState(): LuckyModeState {
  return _state
}

/** 更新配置（持久化 + 发出事件） */
export function setConfig(config: LuckyModeConfig): void {
  _config = config
  saveLuckyConfig(config)

  // 切换预设时重置状态
  if (config.preset === 'off') {
    _state = createLuckyState()
  } else {
    _state.activePreset = config.preset
    _state.currentIteration = 0
    _state.recentToolCalls = []
    _state.textOnlyCount = 0
    _state.isPaused = false
    _state.pauseReason = null
    _state.sessionStartedAt = Date.now()
  }
  saveLuckyState(_state)

  globalEventBus.emit(BusEvents.LUCKY_MODE_CONFIG_CHANGED, { config })
}

/** 更新状态（持久化 + 发出事件） */
export function setState(partial: Partial<LuckyModeState>): void {
  _state = { ..._state, ...partial }
  saveLuckyState(_state)
  globalEventBus.emit(BusEvents.LUCKY_MODE_STATE_UPDATED, { state: _state })
}

// ═══════════════════════════════════════════════════════════
// 1️⃣ agentRunner.ts 集成 — ReAct 循环控制
// ═══════════════════════════════════════════════════════════

export interface LuckyReActContext {
  /** 本轮 AI 输出的文本 */
  outputText: string
  /** 本轮使用的工具数量 */
  toolCallsInThisTurn: number
  /** 本轮使用的 token 数量 */
  tokensUsedInThisTurn: number
  /** 本轮使用的工具名称列表 */
  toolNames: string[]
  /** 当前场景模式（来自 modeManager） */
  currentMode?: string
  /** Agent 当前情绪（来自 socialEngine） */
  currentMood?: string
}

/**
 * ReAct 循环用 — 在每一轮 LLM 回复后调用
 *
 * 返回决策：
 *   - shouldContinue: true → 继续下一轮
 *   - shouldPause: true → 暂停循环，等待用户介入
 *   - shouldRemind: true → 注入提醒后继续
 *   - remindMessage: 提醒/暂停文案
 */
export function checkLuckyModeForReAct(
  context: LuckyReActContext,
): {
  decision: LuckyModeDecision
  stateUpdates: Partial<LuckyModeState>
} {
  if (_config.preset === 'off') {
    return {
      decision: {
        shouldContinue: false,
        shouldPause: false,
        shouldRemind: false,
        remindMessage: null,
        stateUpdates: {},
      },
      stateUpdates: {},
    }
  }

  // 使用全局 mode/mood 作为上下文默认值
  const effectiveMode = context.currentMode || _currentMode
  const effectiveMood = context.currentMood || _currentMood
  const enhancedContext = { ...context, currentMode: effectiveMode, currentMood: effectiveMood }

  // 1. 记录工具调用
  const newToolCalls = context.toolNames.map(name => ({
    toolName: name,
    args: '',
    timestamp: Date.now(),
  }))
  const updatedToolCalls = [
    ..._state.recentToolCalls,
    ...newToolCalls,
  ].slice(-30)

  // 2. 更新状态：递增迭代、更新工具历史
  const intermediateState: LuckyModeState = {
    ..._state,
    currentIteration: _state.currentIteration + 1,
    recentToolCalls: updatedToolCalls,
    textOnlyCount: context.toolCallsInThisTurn === 0
      ? _state.textOnlyCount + 1
      : _state.textOnlyCount,
  }

  // 3. 注入场景感知 + 情绪影响的临时配置覆盖
  const adjustedConfig = _applyContextualOverrides(_config, enhancedContext)

  // 4. 执行 Lucky 模式决策
  const decision = luckyModeDecision(intermediateState, adjustedConfig, {
    outputText: context.outputText,
    toolCallsInThisTurn: context.toolCallsInThisTurn,
    tokensUsedInThisTurn: context.tokensUsedInThisTurn,
    toolNames: context.toolNames,
    currentMode: effectiveMode,
  })

  // 5. 如果决策要求继续，更新状态
  if (decision.shouldContinue && !decision.shouldPause) {
    const stateUpdates: Partial<LuckyModeState> = {
      currentIteration: _state.currentIteration + 1,
      recentToolCalls: updatedToolCalls,
      textOnlyCount: context.toolCallsInThisTurn === 0
        ? _state.textOnlyCount + 1
        : _state.textOnlyCount,
    }

    // 如果 Goal 模式，传递 token 更新
    if (_config.preset === 'goal' && _config.goal.isActive) {
      stateUpdates.goalState = {
        ..._state.goalState,
        sessionTokens: (_state.goalState?.sessionTokens || 0) + context.tokensUsedInThisTurn,
      }
    }

    return { decision, stateUpdates }
  }

  return { decision, stateUpdates: {} }
}

/**
 * 场景感知 + 情绪影响的配置覆盖
 */
function _applyContextualOverrides(
  config: LuckyModeConfig,
  context: LuckyReActContext,
): LuckyModeConfig {
  const adjusted = JSON.parse(JSON.stringify(config)) as LuckyModeConfig

  // ── 场景感知覆盖 ──
  if (context.currentMode) {
    switch (context.currentMode) {
      case 'work':
        // 工作模式：更紧的循环，更高的死循环敏感度
        adjusted.maxIterations = Math.min(adjusted.maxIterations, 30)
        if (adjusted.doomLoop) {
          adjusted.doomLoop.similarityThreshold = Math.max(0.7, adjusted.doomLoop.similarityThreshold - 0.1)
          adjusted.doomLoop.maxRepetitions = Math.min(adjusted.doomLoop.maxRepetitions, 3)
        }
        break
      case 'study':
        // 学习模式：更多探索空间
        adjusted.maxIterations = Math.min(adjusted.maxIterations, 50)
        if (adjusted.doomLoop) {
          adjusted.doomLoop.similarityThreshold = Math.min(0.9, adjusted.doomLoop.similarityThreshold + 0.05)
          adjusted.doomLoop.maxRepetitions = Math.max(adjusted.doomLoop.maxRepetitions, 4)
        }
        break
      case 'fun':
        // 娱乐模式：宽松循环，更多自由度
        adjusted.maxIterations = Math.min(adjusted.maxIterations, 40)
        if (adjusted.doomLoop) {
          adjusted.doomLoop.similarityThreshold = Math.min(0.95, adjusted.doomLoop.similarityThreshold + 0.1)
          adjusted.doomLoop.interventionAction = 'remind'  // 开心时不打断
        }
        break
      case 'idle':
        // 空闲模式：快速收敛，节省 token
        adjusted.maxIterations = Math.min(adjusted.maxIterations, 10)
        if (adjusted.completionRubric) {
          adjusted.completionRubric.enabled = true
          adjusted.completionRubric.maxInterventionsPerTurn = 1
        }
        break
    }
  }

  // ── 情绪影响覆盖 ──
  if (context.currentMood) {
    switch (context.currentMood) {
      case 'tired':
      case 'stressed':
        // 累/压力 → 减少循环次数，降低主动性
        adjusted.maxIterations = Math.max(3, Math.min(adjusted.maxIterations, 15))
        if (adjusted.doomLoop) {
          adjusted.doomLoop.interventionAction = 'pause'  // 累了就歇
        }
        break
      case 'playful':
      case 'happy':
        // 开心 → 更主动的循环，更多工具调用空间
        adjusted.maxIterations = Math.min(adjusted.maxIterations * 1.2, 100)
        if (adjusted.completionRubric) {
          adjusted.completionRubric.enabled = false  // 开心时少检查
        }
        break
    }
  }

  return adjusted
}

// ═══════════════════════════════════════════════════════════
// 2️⃣ delegationManager.ts 集成 — 多 Agent 团队循环控制
// ═══════════════════════════════════════════════════════════

export interface LuckyDelegationContext {
  /** 任务复杂度 ('simple' | 'medium' | 'complex') */
  complexity: string
  /** 任务类型 */
  taskType: string
  /** 当前场景模式 */
  currentMode?: string
  /** Agent 当前情绪 */
  currentMood?: string
}

export interface LuckyDelegationControl {
  /** 是否启用阶段门控（复杂任务拆解） */
  usePhaseGate: boolean
  /** 自动验证修复的最大轮数 */
  maxFixRounds: number
  /** 是否绕过 ReAct 迭代限制 */
  bypassIterationLimit: boolean
  /** Token 预算上限 */
  tokenBudget: number
}

/**
 * 返回团队协作循环的控制参数
 *
 * 在 delegationManager 委托任务前调用，决定：
 *   - 是否拆分阶段（phase-gated）
 *   - 自动修复轮数上限
 *   - 是否限制迭代
 */
export function getLuckyDelegationControl(
  context: LuckyDelegationContext,
): LuckyDelegationControl {
  // 默认值（Lucky 关闭时的行为）
  const defaults: LuckyDelegationControl = {
    usePhaseGate: context.complexity !== 'simple',
    maxFixRounds: 3,
    bypassIterationLimit: false,
    tokenBudget: 0,
  }

  if (_config.preset === 'off') {return defaults}

  switch (_config.preset) {
    case 'default':
      // 标准模式：中等控制
      return {
        usePhaseGate: context.complexity === 'complex',
        maxFixRounds: 3,
        bypassIterationLimit: false,
        tokenBudget: 0,
      }

    case 'goal':
      // 目标模式：严格预算控制，但允许更多修复轮数
      // 🆕 有子任务时自动启用阶段门控 + 解除迭代限制
      return {
        usePhaseGate: _config.goal?.subTasks?.length > 0 ? true : context.complexity !== 'simple',
        maxFixRounds: _config.goal?.subTasks?.length > 0 ? 8 : 5,
        bypassIterationLimit: _config.goal?.subTasks?.length > 0 ? true : false,
        tokenBudget: _config.goal?.tokenBudget || 100000,
      }

    case 'mission':
      // 任务模式（已弃用，保留旧配置兼容）：完全拆解 + 无迭代限制
      return {
        usePhaseGate: true,
        maxFixRounds: 3,
        bypassIterationLimit: true,
        tokenBudget: 0,
      }
  }

  return defaults
}

/**
 * 自动验证修复完成后，检查是否达到 Lucky 模式的停止条件
 */
export function shouldStopDelegationLoop(
  currentRound: number,
  totalRounds: number,
): { shouldStop: boolean; reason: string | null } {
  if (_config.preset === 'off') {return { shouldStop: false, reason: null }}

  // 目标模式：检查 token 预算
  if (_config.preset === 'goal' && _config.goal.isActive) {
    const usedBudget = _state.goalState?.sessionTokens || 0
    if (_config.goal.tokenBudget > 0 && usedBudget >= _config.goal.tokenBudget) {
      return {
        shouldStop: true,
        reason: `🎯 目标模式 Token 预算已用尽 (${usedBudget}/${_config.goal.tokenBudget})`,
      }
    }
  }

  // 通用迭代限制
  if (_config.preset === 'default' || _config.preset === 'goal') {
    const effectiveLimit = _config.preset === 'goal'
      ? (_config.goal?.maxIterations || 50)
      : (_config.maxIterations || 25)
    if (currentRound >= effectiveLimit) {
      return {
        shouldStop: true,
        reason: `🔄 Lucky 模式已达迭代上限 (${effectiveLimit})`,
      }
    }
  }

  return { shouldStop: false, reason: null }
}

// ═══════════════════════════════════════════════════════════
// 3️⃣ modeManager.ts 集成 — 场景感知自适应
// ═══════════════════════════════════════════════════════════

export type SceneAwareAction = 'tighten' | 'loosen' | 'suspend' | 'resume' | 'none'

/**
 * 场景切换时自动调整 Lucky 模式
 *
 * 由 modeManager 在场景变化时调用
 */
export function getSceneAwareAdjustment(
  newMode: string,
  previousMode: string,
): {
  action: SceneAwareAction
  description: string
  suggestedConfigOverrides?: Partial<LuckyModeConfig>
} {
  if (_config.preset === 'off') {
    return { action: 'none', description: 'Lucky 模式已关闭' }
  }

  switch (newMode) {
    case 'work':
      return {
        action: 'tighten',
        description: '💼 工作模式 → 收紧循环控制',
        suggestedConfigOverrides: {
          maxIterations: Math.min(_config.maxIterations, 25),
          completionRubric: {
            ..._config.completionRubric,
            enabled: true,
            rePromptOnTextOnly: true,
          },
        },
      }
    case 'study':
      return {
        action: 'loosen',
        description: '📚 学习模式 → 放松循环控制，允许更多探索',
        suggestedConfigOverrides: {
          maxIterations: Math.max(_config.maxIterations, 30),
        },
      }
    case 'fun':
      return {
        action: 'loosen',
        description: '🎮 娱乐模式 → 最宽松循环，不死板检查',
        suggestedConfigOverrides: {
          maxIterations: 40,
          completionRubric: {
            ..._config.completionRubric,
            enabled: false,
          },
        },
      }
    case 'idle':
      return {
        action: 'suspend',
        description: '😴 空闲模式 → 挂起循环，省 Token',
        suggestedConfigOverrides: {
          preset: 'off',
        },
      }
    default:
      return { action: 'none', description: '' }
  }
}

// ═══════════════════════════════════════════════════════════
// 4️⃣ agentSocialEngine.ts 集成 — 情绪影响循环行为
// ═══════════════════════════════════════════════════════════

export interface LuckyEmotionContext {
  /** 当前情绪标签 */
  mood: string
  /** 情绪强度 (0~1) */
  intensity: number
  /** 团队整体状态 */
  teamStatus?: string
}

export interface LuckyEmotionInfluence {
  /** 是否应该降低循环频率 */
  reduceLoopFrequency: boolean
  /** 是否应该增加主动性 */
  increaseProactiveness: boolean
  /** 建议的调整文案 */
  suggestion: string
}

// 🆕 Phase 3: 情绪策略 — 细粒度控制委托循环行为
export interface EmotionalLoopStrategy {
  /** 重试态度: 'forgiving' = 多给机会, 'strict' = 快速降级, 'neutral' = 正常 */
  retryAttitude: 'forgiving' | 'strict' | 'neutral'
  /** 任务复杂度偏好: 'simple' = 倾向简单方案, 'thorough' = 倾向完善方案 */
  complexityPreference: 'simple' | 'thorough'
  /** 反馈风格: 'encouraging' = 鼓励, 'direct' = 直接, 'warm' = 温和 */
  feedbackStyle: 'encouraging' | 'direct' | 'warm'
  /** 自主性: 'autonomous' = 少确认多执行, 'cautious' = 多确认再执行 */
  autonomyLevel: 'autonomous' | 'cautious'
  /** 文案 */
  description: string
}

/**
 * 根据 Agent 情绪返回循环行为建议
 *
 * 由 socialEngine 在情绪变化时调用
 */
export function getEmotionLoopInfluence(
  context: LuckyEmotionContext,
): LuckyEmotionInfluence {
  if (_config.preset === 'off') {
    return {
      reduceLoopFrequency: false,
      increaseProactiveness: false,
      suggestion: '',
    }
  }

  switch (context.mood) {
    case 'tired':
    case 'stressed':
      return {
        reduceLoopFrequency: true,
        increaseProactiveness: false,
        suggestion: context.intensity > 0.5
          ? '😴 Agent 较疲惫，已降低循环频率节省 Token'
          : '😊 Agent 稍累，适度减少循环',
      }
    case 'playful':
    case 'happy':
      return {
        reduceLoopFrequency: false,
        increaseProactiveness: true,
        suggestion: '🎉 Agent 状态很好，已提升主动性',
      }
    case 'impatient':
      return {
        reduceLoopFrequency: true,
        increaseProactiveness: false,
        suggestion: '⚡ Agent 显示不耐烦，减少冗余循环，快速交付结果',
      }
    case 'neutral':
    default:
      return {
        reduceLoopFrequency: false,
        increaseProactiveness: false,
        suggestion: '',
      }
  }
}

// 🆕 Phase 3: 情绪驱动的委托循环策略
//
// delegationManager 在构建委托重试策略时调用此函数，
// 获得当前情绪下最合适的循环行为参数。
//
// 决策矩阵:
//   mood        | retryAttitude | complexityPref | feedbackStyle | autonomy
//   ------------|--------------|----------------|---------------|--------
//   happy       | forgiving    | thorough       | encouraging   | autonomous
//   playful     | forgiving    | thorough       | encouraging   | autonomous
//   neutral     | neutral      | thorough       | warm          | cautious
//   tired       | strict       | simple         | direct        | cautious
//   stressed    | strict       | simple         | direct        | cautious
//   impatient   | strict       | simple         | direct        | autonomous
//   focused     | neutral      | thorough       | direct        | autonomous
//
export function getEmotionalLoopStrategy(mood?: string): EmotionalLoopStrategy {
  switch (mood) {
    case 'happy':
    case 'playful':
      return {
        retryAttitude: 'forgiving',
        complexityPreference: 'thorough',
        feedbackStyle: 'encouraging',
        autonomyLevel: 'autonomous',
        description: '情绪积极 → 多给重试机会，追求完善方案',
      }
    case 'tired':
      return {
        retryAttitude: 'strict',
        complexityPreference: 'simple',
        feedbackStyle: 'warm',
        autonomyLevel: 'cautious',
        description: '情绪疲惫 → 减少重试，倾向简单方案，温和沟通',
      }
    case 'stressed':
      return {
        retryAttitude: 'strict',
        complexityPreference: 'simple',
        feedbackStyle: 'direct',
        autonomyLevel: 'cautious',
        description: '情绪紧张 → 快速降级，少迭代，直接交付',
      }
    case 'impatient':
      return {
        retryAttitude: 'strict',
        complexityPreference: 'simple',
        feedbackStyle: 'direct',
        autonomyLevel: 'autonomous',
        description: '情绪不耐烦 → 快速出结果，不纠缠细节',
      }
    case 'focused':
      return {
        retryAttitude: 'neutral',
        complexityPreference: 'thorough',
        feedbackStyle: 'direct',
        autonomyLevel: 'autonomous',
        description: '情绪专注 → 正常重试，追求完善，少确认多做事',
      }
    case 'neutral':
    default:
      return {
        retryAttitude: 'neutral',
        complexityPreference: 'thorough',
        feedbackStyle: 'warm',
        autonomyLevel: 'cautious',
        description: '情绪平静 → 标准行为',
      }
  }
}

// ═══════════════════════════════════════════════════════════
// 初始化 — 监听子系统事件
// ═══════════════════════════════════════════════════════════

/**
 * 初始化 Luck 模式集成
 *
 * 在应用启动时调用一次
 */
export function initLuckyModeIntegration(): void {
  if (_integrationInitialized) {return}
  _integrationInitialized = true

  console.log('[LuckyIntegration] 🔌 深度集成已激活')

  // 监听场景模式变化 → 更新全局模式状态
  // modeManager 现已负责实际调整（emitModeChange），此处只更新状态变量
  globalEventBus.on('mode:changed', (payload: { mode: string; oldMode: string; luckyAdjustment?: string }) => {
    _currentMode = payload.mode  // 更新全局模式状态
    if (payload.luckyAdjustment) {
      console.log(`[LuckyIntegration] 🌐 场景感知: ${payload.luckyAdjustment}`)
    }
  })

  // 监听情绪变化 → 影响循环决策
  // socialEngine 或 emotionBridge 通过 'agent:mood_changed' 广播
  globalEventBus.on('agent:mood_changed', (payload: { mood: string; intensity: number }) => {
    _currentMood = payload.mood  // 更新全局情绪状态
    const influence = getEmotionLoopInfluence({
      mood: payload.mood,
      intensity: payload.intensity,
    })
    if (influence.suggestion) {
      console.log(`[LuckyIntegration] 💭 情绪影响: ${influence.suggestion}`)
    }
  })

  console.log(`[LuckyIntegration] ✅ 当前预设: ${_config.preset}`)
}
