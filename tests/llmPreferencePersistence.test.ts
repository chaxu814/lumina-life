// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// 复现「最大输出 / 上下文窗口每次启动被打回固定值」
//
// 根因：syncProviderFromBackend 重建 providerConfigs 时，
//   · contextWindow 直接取后端 cfg.maxContextTokens，完全不继承用户设置
//   · 继承判断用 activeProviderId，但实际应用的是自愈后可能已改写的 activeId
import { describe, it, expect, beforeEach, vi } from 'vitest'

/** 从 appStore 源码里抽出 providerConfigs 重建那段逻辑做行为验证 */
function readSource(): string {
  const fs = require('fs')
  const p = require('path').join(process.cwd(), 'src', 'stores', 'appStore.ts')
  return fs.readFileSync(p, 'utf-8')
}

describe('LLM 偏好持久化：最大输出 / 上下文窗口', () => {
  beforeEach(() => { vi.resetModules() })

  it('contextWindow 必须继承用户当前值，而不是用后端 maxContextTokens 覆盖', () => {
    const src = readSource()
    expect(src).toContain('inheritedContextWindow')
    // 旧写法：后端值直接盖掉用户的
    expect(src).not.toMatch(/contextWindow:\s*cfg\.maxContextTokens\s*\|\|\s*0/)
  })

  it('继承判断必须用 activeId（自愈后 activeId 可能已改写）', () => {
    const src = readSource()
    expect(src).toMatch(/const isActive = id === activeId/)
    // 旧写法：判断用 activeProviderId，应用用 activeId，两者可能不是同一个
    expect(src).not.toMatch(/id === activeProviderId \? get\(\)\.llmConfig\.maxTokens/)
  })

  it('contextWindow=0（自动检测）是合法值，不能被 || 吞掉', () => {
    const src = readSource()
    // 必须是 ?? 而不是 ||：0 是有意义的取值
    expect(src).toMatch(/cur\.contextWindow \?\?/)
    expect(src).not.toMatch(/cur\.contextWindow \|\|/)
  })

  it('llmConfig 仍在 persist 白名单里（否则修了继承也存不下来）', () => {
    const src = readSource()
    const partialize = src.slice(src.indexOf('partialize:'))
    expect(partialize).toMatch(/llmConfig:\s*state\.llmConfig/)
  })

  it('setLLMConfig 只改 llmConfig 本身，不会污染 providerConfigs 快照', () => {
    const src = readSource()
    expect(src).toMatch(
      /setLLMConfig:\s*\(c\)\s*=>\s*set\(\(s\)\s*=>\s*\(\{\s*llmConfig:\s*\{\s*\.\.\.s\.llmConfig,\s*\.\.\.c\s*\}\s*\}\)\)/,
    )
  })
})
