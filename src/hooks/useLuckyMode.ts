// ============================================================
// useLuckyMode.ts — Lucky 模式 React Hook
//
// 为 ChatPanel 和 GroupChatView 提供统一的状态管理与集成
// ============================================================

import { useState, useEffect, useCallback, useRef } from 'react'
import type { LuckyModePreset } from '../components/LuckyModeSelector'
import type { LuckyRuntimeInfo } from '../services/luckyModeService'
import type { LuckySettingsConfig } from '../components/LuckyModeSettings'
import { getDefaultSettings } from '../components/LuckyModeSettings'

export interface UseLuckyModeReturn {
  /** 当前预设 */
  preset: LuckyModePreset
  /** 运行时信息 */
  runtime: LuckyRuntimeInfo
  /** 详细配置 */
  settings: LuckySettingsConfig
  /** 更改预设 */
  setPreset: (preset: LuckyModePreset) => void
  /** 保存完整设置 */
  saveSettings: (settings: LuckySettingsConfig) => void
  /** 开启/继续 */
  activate: (preset?: LuckyModePreset) => void
  /** 关闭/停止 */
  deactivate: () => void
  /** 暂停（死循环等触发） */
  pause: (reason: string) => void
  /** 继续 */
  resume: () => void
  /** 递增迭代计数 */
  incrementIteration: () => void
  /** 是否活跃 */
  isActive: boolean
  /** 是否暂停 */
  isPaused: boolean
  /** 打开设置面板 */
  showSettings: boolean
  setShowSettings: (show: boolean) => void
}

export function useLuckyMode(): UseLuckyModeReturn {
  const [preset, setPresetState] = useState<LuckyModePreset>('off')
  const [settings, setSettingsState] = useState<LuckySettingsConfig>(getDefaultSettings())
  const [runtime, setRuntime] = useState<LuckyRuntimeInfo>({
    preset: 'off',
    isActive: false,
    currentIteration: 0,
    maxIteration: 25,
    isPaused: false,
    pauseReason: null,
  })
  const [showSettings, setShowSettings] = useState(false)
  const loadedRef = useRef(false)
  const userChangedRef = useRef(false)

  // 初始加载
  useEffect(() => {
    if (loadedRef.current) {return}
    loadedRef.current = true

    const load = async () => {
      try {
        const savedConfig = await (window as any).luminaAPI?.luckyModeGetConfig?.()
        if (savedConfig) {
          // 🐛 v3.7.2: 如果用户已经手动切换过预设，忽略异步加载结果避免覆盖
          if (userChangedRef.current) {return}

          setSettingsState(savedConfig)
          setPresetState(savedConfig.preset)
          setRuntime((prev: LuckyRuntimeInfo) => ({
            ...prev,
            preset: savedConfig.preset,
            isActive: savedConfig.preset !== 'off',
            maxIteration: getMaxIteration(savedConfig),
          }))
        }
      } catch { /* defaults ok */ }
    }
    load()
  }, [])

  // 监听自定义事件（跨面板同步）
  useEffect(() => {
    const handler = (e: CustomEvent) => {
      userChangedRef.current = true
      if (e.detail?.preset) {setPresetState(e.detail.preset)}
      if (e.detail?.runtime) {setRuntime(e.detail.runtime)}
    }
    window.addEventListener('lucky-mode:sync' as any, handler as any)
    return () => window.removeEventListener('lucky-mode:sync' as any, handler as any)
  }, [])

  const getMaxIteration = (cfg: LuckySettingsConfig): number => {
    if (cfg.preset === 'goal') {return cfg.goal.maxIterations}
    if (cfg.preset === 'mission') {return cfg.goal.bypassIterationLimit ? cfg.maxIterations * 2 : cfg.maxIterations}
    return cfg.maxIterations
  }

  const setPreset = useCallback((p: LuckyModePreset) => {
    userChangedRef.current = true
    setPresetState(p)
    setRuntime((prev: LuckyRuntimeInfo) => ({
      ...prev,
      preset: p,
      isActive: p !== 'off',
      currentIteration: p !== preset ? 0 : prev.currentIteration,
      maxIteration: p === 'goal' ? settings.goal.maxIterations : p === 'mission' ? (settings.goal.bypassIterationLimit ? settings.maxIterations * 2 : settings.maxIterations) : settings.maxIterations,
      isPaused: false,
      pauseReason: null,
    }))
    
    // 持久化到后端
    const updatedConfig = { ...settings, preset: p }
    setSettingsState(updatedConfig)
    try {
      (window as any).luminaAPI?.luckyModeSaveConfig?.(updatedConfig)
    } catch {}

    // 同步事件
    window.dispatchEvent(new CustomEvent('lucky-mode:sync', {
      detail: { preset: p, runtime: { ...runtime, preset: p, isActive: p !== 'off' } },
    }))
  }, [settings, preset, runtime])

  const saveSettings = useCallback((s: LuckySettingsConfig) => {
    userChangedRef.current = true
    setSettingsState(s)
    setPresetState(s.preset)
    setRuntime((prev: LuckyRuntimeInfo) => ({
      ...prev,
      preset: s.preset,
      isActive: s.preset !== 'off',
      maxIteration: getMaxIteration(s),
    }))

    try {
      (window as any).luminaAPI?.luckyModeSaveConfig?.(s)
    } catch {}
  }, [])

  const activate = useCallback((p?: LuckyModePreset) => {
    const target = p || 'default'
    setPreset(target)
  }, [setPreset])

  const deactivate = useCallback(() => {
    setPreset('off')
  }, [setPreset])

  const pause = useCallback((reason: string) => {
    setRuntime((prev: LuckyRuntimeInfo) => ({ ...prev, isPaused: true, pauseReason: reason }))
    try { (window as any).luminaAPI?.luckyModePause?.(reason) } catch {}
  }, [])

  const resume = useCallback(() => {
    setRuntime((prev: LuckyRuntimeInfo) => ({ ...prev, isPaused: false, pauseReason: null }))
    try { (window as any).luminaAPI?.luckyModeResume?.() } catch {}
  }, [])

  const incrementIteration = useCallback(() => {
    setRuntime((prev: LuckyRuntimeInfo) => ({ ...prev, currentIteration: prev.currentIteration + 1 }))
    try { (window as any).luminaAPI?.luckyModeIncrementIteration?.() } catch {}
  }, [])

  return {
    preset,
    runtime,
    settings,
    setPreset,
    saveSettings,
    activate,
    deactivate,
    pause,
    resume,
    incrementIteration,
    isActive: preset !== 'off',
    isPaused: runtime.isPaused,
    showSettings,
    setShowSettings,
  }
}
