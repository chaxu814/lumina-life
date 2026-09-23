// ============================================================
// onboarding/wizardState.ts — 引导向导状态机与持久化 (Setup Wizard)
//
// 首次启动引导（C3）：
//   - 管理引导状态（是否完成、当前步骤、已选 provider / 人格）
//   - 持久化到 userData/onboarding-state.json
//   - 首次启动检测：未完成 且 没有任何已配置 provider → 需要引导
//
// 设计：fs / 路径根 全部可注入，单测用内存 fs，不碰真实磁盘。
// 安全：API Key 不落盘到本文件（由 providerManager 加密存储），这里只存非敏感元数据。
// ============================================================

import * as fs from 'fs'
import * as path from 'path'

/** 向导状态（只存非敏感元数据） */
export interface WizardState {
  /** 引导是否已完成 */
  completed: boolean
  /** 当前停留在第几步（0-based） */
  currentStep: number
  /** 用户选择的 provider id（lmstudio / ollama / deepseek / ...） */
  provider: string
  /** provider 类别：本地 / 云端 */
  providerKind: 'local' | 'cloud' | ''
  /** 选择的人格 id */
  persona: string
  /** VLM 是否被跳过（主模型支持视觉时自动跳过） */
  vlmSkipped: boolean
  /** 完成时间（ISO） */
  finishedAt: string
}

export const WIZARD_STATE_FILE = 'onboarding-state.json'

export const DEFAULT_WIZARD_STATE: WizardState = {
  completed: false,
  currentStep: 0,
  provider: '',
  providerKind: '',
  persona: '',
  vlmSkipped: false,
  finishedAt: '',
}

/** 可注入的 fs 接口（Node fs 子集），便于测试 */
export interface WizardFs {
  readFileSync(p: string, enc: 'utf-8'): string
  writeFileSync(p: string, data: string, enc: 'utf-8'): void
  existsSync(p: string): boolean
  mkdirSync(p: string, opts: { recursive: boolean }): void
}

const realFs: WizardFs = {
  readFileSync: (p, enc) => fs.readFileSync(p, enc),
  writeFileSync: (p, data, enc) => fs.writeFileSync(p, data, enc),
  existsSync: (p) => fs.existsSync(p),
  mkdirSync: (p, opts) => fs.mkdirSync(p, opts),
}

/** 状态机：合法的步骤推进范围（0..MAX_STEP）。引导共 6 步。 */
export const WIZARD_STEP_COUNT = 6

/**
 * 引导是否需要展示。
 * 规则：引导未完成 且 当前没有任何已配置可用的 provider。
 * @param state 已加载的向导状态
 * @param hasConfiguredProvider 是否已有可用 provider（由 providerManager 注入）
 */
export function needsOnboarding(state: WizardState, hasConfiguredProvider: boolean): boolean {
  if (state.completed) {return false}
  if (hasConfiguredProvider) {return false}
  return true
}

/** 加载状态；文件不存在或损坏时返回默认状态（不抛错） */
export function loadWizardState(configDir: string, fsImpl: WizardFs = realFs): WizardState {
  const file = path.join(configDir, WIZARD_STATE_FILE)
  if (!fsImpl.existsSync(file)) {return { ...DEFAULT_WIZARD_STATE }}
  try {
    const raw = fsImpl.readFileSync(file, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<WizardState>
    return { ...DEFAULT_WIZARD_STATE, ...parsed }
  } catch {
    return { ...DEFAULT_WIZARD_STATE }
  }
}

/** 保存状态到磁盘（自动建目录） */
export function saveWizardState(configDir: string, state: WizardState, fsImpl: WizardFs = realFs): void {
  if (!fsImpl.existsSync(configDir)) {
    fsImpl.mkdirSync(configDir, { recursive: true })
  }
  const file = path.join(configDir, WIZARD_STATE_FILE)
  fsImpl.writeFileSync(file, JSON.stringify(state, null, 2), 'utf-8')
}

/** 推进步骤（带边界钳制），返回新状态（不原地改） */
export function setStep(state: WizardState, step: number): WizardState {
  const clamped = Math.max(0, Math.min(WIZARD_STEP_COUNT - 1, Math.floor(step)))
  return { ...state, currentStep: clamped }
}

/** 记录用户选择的 provider */
export function setProvider(state: WizardState, provider: string, kind: 'local' | 'cloud'): WizardState {
  return { ...state, provider, providerKind: kind }
}

/** 记录人格选择 */
export function setPersona(state: WizardState, persona: string): WizardState {
  return { ...state, persona }
}

/** 标记引导完成 */
export function markCompleted(state: WizardState): WizardState {
  return { ...state, completed: true, finishedAt: new Date().toISOString() }
}

/**
 * 便捷类：绑定一个 configDir 的状态读写器。
 * 主进程用真实 userData，测试可注入内存 fs。
 */
export class WizardStateStore {
  constructor(
    private readonly configDir: string,
    private readonly fsImpl: WizardFs = realFs,
  ) {}

  load(): WizardState {
    return loadWizardState(this.configDir, this.fsImpl)
  }

  save(state: WizardState): void {
    saveWizardState(this.configDir, state, this.fsImpl)
  }

  /** 当前是否需要引导（结合 providerManager 注入的检测结果） */
  needsOnboarding(hasConfiguredProvider: boolean): boolean {
    return needsOnboarding(this.load(), hasConfiguredProvider)
  }

  /** 读-改-写：对状态应用更新函数并落盘，返回新状态 */
  update(mutate: (draft: WizardState) => Partial<WizardState>): WizardState {
    const cur = this.load()
    const patch = mutate(cur)
    const next = { ...cur, ...patch }
    this.save(next)
    return next
  }
}
