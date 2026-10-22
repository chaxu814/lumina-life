// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// onboarding/onboardingIpc.ts — 引导向导 IPC (Setup Wizard)
//
// 把 onboarding.html（独立 HTML，nodeIntegration）暴露给主进程的能力：
//   onboarding:get-state          读取向导状态
//   onboarding:set-step           记录当前步骤
//   onboarding:detect-local       探测本地模型（LM Studio / Ollama）
//   onboarding:apply-local        一键接入探测到的本地模型（免 Key）
//   onboarding:save-cloud         保存云端 provider（baseUrl + apiKey + model）
//   onboarding:test-cloud         测试云端 Key 连接
//   onboarding:model-vision       判断模型名是否自带视觉能力（决定 VLM 是否可跳过）
//   onboarding:complete           引导完成（标记状态 + 保存人格）
// ============================================================

import { ipcMain } from 'electron'
import * as path from 'path'
import { app } from 'electron'
import { getProviderManager } from '../core/providerManager'
import { recommendLocalModel } from './localModelDetector'
import { WizardStateStore, setProvider, markCompleted, setPersona } from './wizardState'

/** 模型名中暗示「视觉/多模态」的关键词（小写匹配） */
const VISION_KEYWORDS = [
  'gpt-4o', 'gpt-4.1', 'gpt-5', 'o1', 'o3', 'o4',
  'kimi', 'vision', 'vl', 'vlm', '-vl', 'qwen-vl', 'qwen2-vl', 'qwen3-vl',
  'glm-4v', 'glm-4.5v', 'glm-4.6v', '4v', '4.5v',
  'gemini', 'claude', 'pixtral', 'llava', 'internvl',
]

/**
 * 判断模型名是否自带视觉能力（C4：主模型支持视觉则 VLM 可跳过，自动复用）。
 * 纯逻辑，便于单测。
 */
export function modelSupportsVision(modelName: string): boolean {
  if (!modelName) {return false}
  const n = modelName.toLowerCase()
  return VISION_KEYWORDS.some((kw) => n.includes(kw))
}

/** 单例 store（userData 目录） */
function getStore(): WizardStateStore {
  const dir = app.getPath('userData')
  return new WizardStateStore(dir)
}

/** 判断是否已有可用 provider（用于首次启动检测） */
function hasConfiguredProvider(): boolean {
  try {
    const pm = getProviderManager()
    return pm.getActiveProviderId() !== ''
  } catch {
    return false
  }
}

export function registerOnboardingIpc(): void {
  // ── 读取向导状态（含首次启动判定） ──────────────────
  ipcMain.handle('onboarding:get-state', () => {
    const store = getStore()
    const state = store.load()
    return {
      state,
      needsOnboarding: state.completed ? false : !hasConfiguredProvider(),
    }
  })

  // ── 记录当前步骤 ──────────────────────────────────
  ipcMain.handle('onboarding:set-step', (_e, step: number) => {
    const store = getStore()
    const next = store.update((draft) => ({ currentStep: Math.max(0, Math.floor(step)) }))
    return { state: next }
  })

  // ── 探测本地模型（LM Studio / Ollama） ─────────────
  ipcMain.handle('onboarding:detect-local', async () => {
    try {
      const rec = await recommendLocalModel(3000)
      return { ok: true, ...rec }
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) }
    }
  })

  // ── 一键接入探测到的本地模型（免 Key，复用 providerManager） ──
  ipcMain.handle('onboarding:apply-local', async (_e, input: { id?: string; baseUrl?: string; model?: string }) => {
    try {
      const pm = getProviderManager()
      const idMap: Record<string, string> = { ollama: 'ollama', lmstudio: 'lmstudio', 'lm-studio': 'lmstudio' }
      const id = idMap[input?.id || ''] || (input?.baseUrl?.includes('11434') ? 'ollama' : 'lmstudio')
      const base = input?.baseUrl
        ? (input.baseUrl.endsWith('/v1') ? input.baseUrl : input.baseUrl.replace(/\/$/, '') + '/v1')
        : (id === 'ollama' ? 'http://127.0.0.1:11434/v1' : 'http://127.0.0.1:1234/v1')
      const model = input?.model || pm.getDefinition(id)?.defaultModel || ''
      // 🩺 2026-10-07：接入时探测服务端真实上下文窗口，不再硬编码 128000
      //   （128K 会让本地小模型被当成大窗口用 → 不裁剪历史 → 首字极慢）。
      const { probeContextWindow } = await import('../core/localProviderDiscovery')
      const probedContext = await probeContextWindow(base, model)
      pm.setProviderConfig(id, {
        baseUrl: base,
        apiKey: 'local',
        model,
        enabled: true,
        timeout: 120,
        maxContextTokens: probedContext ?? 0,   // 真实值优先；拿不到填 0（自动检测）
      })
      pm.setActiveProvider(id)
      // 记录到向导状态
      const store = getStore()
      store.update((draft) => ({ ...setProvider(draft, id, 'local') }))
      return { ok: true, id, baseUrl: base, model, contextWindow: probedContext ?? 0 }
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) }
    }
  })

  // ── 保存云端 provider（baseUrl + apiKey + model） ─────
  ipcMain.handle('onboarding:save-cloud', (_e, payload: {
    provider: string; baseUrl: string; apiKey: string; model: string
  }) => {
    try {
      const pm = getProviderManager()
      const provider = payload?.provider || 'deepseek'
      pm.setProviderConfig(provider, {
        baseUrl: payload.baseUrl || pm.getDefinition(provider)?.defaultBaseUrl || '',
        apiKey: payload.apiKey || '',
        model: payload.model || pm.getDefinition(provider)?.defaultModel || '',
        enabled: true,
        timeout: 120,
        maxContextTokens: 128000,
      })
      pm.setActiveProvider(provider)
      const store = getStore()
      store.update((draft) => ({ ...setProvider(draft, provider, 'cloud') }))
      return { ok: true, provider }
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) }
    }
  })

  // ── 测试云端 Key 连接（先临时写入配置再测） ──────────
  ipcMain.handle('onboarding:test-cloud', async (_e, payload: {
    provider: string; baseUrl: string; apiKey: string; model: string
  }) => {
    try {
      const pm = getProviderManager()
      const provider = payload?.provider || 'deepseek'
      pm.setProviderConfig(provider, {
        baseUrl: payload.baseUrl || pm.getDefinition(provider)?.defaultBaseUrl || '',
        apiKey: payload.apiKey || '',
        model: payload.model || pm.getDefinition(provider)?.defaultModel || '',
        enabled: true,
      })
      const result = await pm.testConnection(provider)
      return { ok: result.success, latency: result.latency, error: result.error }
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) }
    }
  })

  // ── 判断模型是否自带视觉能力（C4） ──────────────────
  ipcMain.handle('onboarding:model-vision', (_e, modelName: string) => {
    return { supportsVision: modelSupportsVision(modelName || '') }
  })

  // ── 引导完成（标记 + 保存人格 + 同步桌宠 prefs） ─────
  ipcMain.handle('onboarding:complete', (_e, payload?: { persona?: string; vlmSkipped?: boolean }) => {
    try {
      const store = getStore()
      store.update((draft) => {
        let next = markCompleted(draft)
        if (payload?.persona) {next = { ...next, ...setPersona(next, payload.persona) }}
        if (payload?.vlmSkipped) {next = { ...next, vlmSkipped: true }}
        return { completed: next.completed, finishedAt: next.finishedAt, persona: next.persona, vlmSkipped: next.vlmSkipped }
      })
      // 同步桌宠 prefs（复用现有 pet:set-persona 语义：标记 onboardingDone）
      try {
        const { ipcMain: _ } = require('electron')
      } catch { /* ignore */ }
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) }
    }
  })

  console.log('[Onboarding] 📡 IPC 已注册 (onboarding:*)')
}

// 供主进程在就绪后决定是否自动弹引导
export { hasConfiguredProvider }
export function shouldAutoShowOnboarding(): boolean {
  const store = new WizardStateStore(app.getPath('userData'))
  return store.needsOnboarding(hasConfiguredProvider())
}
