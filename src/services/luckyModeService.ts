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

// ── 从后端加载配置 ──

export async function loadFromBackend() {
  try {
    // 🐛 修复：preload 导出的是 luckyModeGetConfig，不是 luckyModeLoadConfig
    const config = await window.luminaAPI?.luckyModeGetConfig?.()
    if (config) {
      _state = {
        ..._state,
        settings: config,
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
