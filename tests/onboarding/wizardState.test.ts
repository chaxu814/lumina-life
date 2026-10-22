// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// tests/onboarding/wizardState.test.ts — 向导状态机与持久化单测（内存 fs）
import { describe, it, expect } from 'vitest'
import {
  needsOnboarding,
  loadWizardState,
  saveWizardState,
  setStep,
  setProvider,
  markCompleted,
  WizardStateStore,
  DEFAULT_WIZARD_STATE,
  type WizardState,
  type WizardFs,
} from '../../electron/onboarding/wizardState'

/** 内存 fs：把文件内容存在 Map 里 */
function makeMemFs(): { fs: WizardFs; files: Map<string, string> } {
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  const fs: WizardFs = {
    readFileSync: (p) => {
      if (!files.has(p)) {throw new Error('ENOENT ' + p)}
      return files.get(p)!
    },
    writeFileSync: (p, data) => { files.set(p, data) },
    existsSync: (p) => files.has(p) || dirs.has(p),
    mkdirSync: (p, opts) => { if (opts.recursive) {dirs.add(p)} },
  }
  return { fs, files }
}

describe('needsOnboarding', () => {
  it('未完成且无 provider → 需要引导', () => {
    expect(needsOnboarding(DEFAULT_WIZARD_STATE, false)).toBe(true)
  })
  it('已完成 → 不需要', () => {
    expect(needsOnboarding({ ...DEFAULT_WIZARD_STATE, completed: true }, false)).toBe(false)
  })
  it('有 provider 但未完成 → 不需要', () => {
    expect(needsOnboarding(DEFAULT_WIZARD_STATE, true)).toBe(false)
  })
})

describe('状态流转纯函数', () => {
  it('setStep 钳制边界', () => {
    expect(setStep(DEFAULT_WIZARD_STATE, 99).currentStep).toBe(5)
    expect(setStep(DEFAULT_WIZARD_STATE, -3).currentStep).toBe(0)
  })
  it('setProvider / setPersona / markCompleted 链式', () => {
    let s: WizardState = DEFAULT_WIZARD_STATE
    s = setProvider(s, 'deepseek', 'cloud')
    expect(s.provider).toBe('deepseek')
    s = markCompleted(s)
    expect(s.completed).toBe(true)
    expect(s.finishedAt).toBeTruthy()
  })
})

describe('持久化', () => {
  it('写入后能读回', () => {
    const { fs, files } = makeMemFs()
    const dir = '/userdata/test'
    const state: WizardState = { ...DEFAULT_WIZARD_STATE, completed: true, provider: 'lmstudio', persona: 'zhixin' }
    saveWizardState(dir, state, fs)
    expect(files.size).toBe(1)
    const loaded = loadWizardState(dir, fs)
    expect(loaded.completed).toBe(true)
    expect(loaded.provider).toBe('lmstudio')
    expect(loaded.persona).toBe('zhixin')
  })
  it('文件损坏返回默认状态', () => {
    const { fs } = makeMemFs()
    const dir = '/userdata/bad'
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(dir + '/onboarding-state.json', '{{{not json', 'utf-8')
    const loaded = loadWizardState(dir, fs)
    expect(loaded.completed).toBe(false)
  })
  it('WizardStateStore 读-改-写', () => {
    const { fs } = makeMemFs()
    const store = new WizardStateStore('/ud', fs)
    expect(store.load().completed).toBe(false)
    store.update((d) => ({ ...setProvider(d, 'ollama', 'local'), currentStep: 2 }))
    expect(store.load().provider).toBe('ollama')
    expect(store.load().currentStep).toBe(2)
  })
})
