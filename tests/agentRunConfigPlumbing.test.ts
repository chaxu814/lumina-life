// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// agentRunConfigPlumbing.test.ts — 「Agent 的上下文窗口真的传下去了吗」
//
// 【来源】2026-10-10 **运行时验证**（真实构建产物 + mock 模型服务）
//
// 静态审计没发现、跑起来才暴露的 bug 链：
//
//   跑 `electron out/main/index.js --cli chat` 时，配置里写 maxContextTokens=32768，
//   但 AgentRunner 日志显示 `context=256000`（provider profile 的兜底猜测）。
//   顺着查下去发现三层问题：
//
//   ① `AgentRunner` 构造器用 profile 的 maxContextTokens（本地兜底 **256000**）
//      **无条件覆盖** `config.contextWindow` —— 把 `_applyAgentLlmConfig()`
//      刚根据用户配置算好的值冲掉了。（已修：只在用户未设时才用 profile）
//   ② `callLLM` 里另算了一个 `maxContextTokens` 局部变量，只读 env/profile，
//      无视已解析出的有效窗口 → 日志与「预检超预算」都按 256000 判断，
//      对 32K 模型**永远不会告警**。（已修：优先取有效窗口）
//   ③ 字段语义在四处不一致：`maxContextTokens` 的**值语义是上下文窗口**
//      （默认 262144、`_applyAgentLlmConfig` 用 `explicitContextWindow` 消费它），
//      但 UI 标成「最大输出」、`buildRunConfig`/CLI/REST 又把它映射成 `maxTokens`。
//      （已修：统一映射到 contextWindow；UI 标签纠正）
//
// 本文件用**真行为**（真的调 buildRunConfig / 真的落盘再读回）守住 ①③，
// ② 由 `chatQualityFixes.test.ts` 的源码不变式守。
// ============================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// AgentConfigManager 顶层 require('electron') 只为取 userData；
// 这里给个空壳，配合 LUMINA_USER_DATA 走捷径。
vi.mock('electron', () => ({ app: { getPath: () => process.cwd() } }))

import * as agentConfigModule from '../electron/agentConfig'

describe('buildRunConfig 必须把「上下文窗口」映射到正确的字段', () => {
  let root: string
  let configPath: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-runcfg-'))
    configPath = path.join(root, 'agent-llm-configs.json')
    ;(agentConfigModule as any)._instance = null
  })

  afterEach(() => {
    try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
    ;(agentConfigModule as any)._instance = null
  })

  /** 写一份三 Agent 相同的配置 */
  const writeConfig = (maxContextTokens: number) => {
    const lumina: any = {
      enabled: true, provider: 'custom', model: 'mock-model-1',
      endpoint: 'http://127.0.0.1:18099/v1', apiKey: '',
      maxContextTokens, timeout: 600,
    }
    fs.writeFileSync(configPath, JSON.stringify({ lumina, yak: lumina, recha: lumina }, null, 2), 'utf8')
  }

  it('maxContextTokens 应映射到 contextWindow（它的值语义就是上下文窗口）', () => {
    writeConfig(32768)
    const ac: any = (agentConfigModule as any).initAgentConfig(configPath)
    const run = ac.buildRunConfig('lumina')

    expect(run.contextWindow, '上下文窗口没被传下去 → AgentRunner 会退回 profile 的 256000 兜底').toBe(32768)
  })

  it('maxContextTokens **不得**再被当成 maxTokens（输出上限）', () => {
    writeConfig(262144)
    const ac: any = (agentConfigModule as any).initAgentConfig(configPath)
    const run = ac.buildRunConfig('lumina')

    // 若回退：输出上限会被写成 262144（一个输出上限不可能这么大），
    //         紧接着被构造器 clamp 成 8192，语义完全错位。
    expect(run.maxTokens, 'maxContextTokens 又被当成输出上限了').not.toBe(262144)
    expect(run.contextWindow).toBe(262144)
  })

  it('两个字段互不顶替（contextWindow 与 maxTokens 不是同一个值）', () => {
    writeConfig(131072)
    const ac: any = (agentConfigModule as any).initAgentConfig(configPath)
    const run = ac.buildRunConfig('lumina')
    expect(run.contextWindow).toBe(131072)
    expect(run.contextWindow).not.toBe(run.maxTokens)
  })

  it('未配置（0）时 contextWindow 为 0（= 交给能力画像/自动检测）', () => {
    writeConfig(0)
    const ac: any = (agentConfigModule as any).initAgentConfig(configPath)
    const run = ac.buildRunConfig('lumina')
    expect(run.contextWindow).toBe(0)
  })

  it('经过 set() 落盘后仍能读回（不会被 _save 丢掉）', () => {
    writeConfig(262144)
    const ac: any = (agentConfigModule as any).initAgentConfig(configPath)
    ac.set('lumina', { maxContextTokens: 16384 } as any)
    ac._save()

    ;(agentConfigModule as any)._instance = null
    const ac2: any = (agentConfigModule as any).initAgentConfig(configPath)
    expect(ac2.get('lumina').maxContextTokens).toBe(16384)
    expect(ac2.buildRunConfig('lumina').contextWindow).toBe(16384)
  })
})
