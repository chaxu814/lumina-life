// ============================================================
// tests/providerPersistence.test.ts — LLM 配置持久化回归
//
// 【对应真实故障】
// 用户反馈：每次打开 Lumina，设置里的模型都固定显示同一个
// （第一次配的 QwenPaw Flash 4B Q4），换成别的也不生效。
//
// 【根因】
// 「一键检测本地模型」这条路径（applyLocal）只调 switchLLMProvider()，
// 它**仅改内存里的 Zustand store，从不写盘**。
// 于是：
//   点接入 → 界面变了、提示成功 → 重启 → 读 lumina-providers.json 旧值 → 复原
//
// 由此还派生出第二个问题：两个配置源漂移
//   · lumina-providers.json   → 设置面板显示它
//   · agent-llm-configs.json  → Agent 实际调用它
// 用户看到的模型和实际跑的模型可能不是同一个。
//
// 【本测试钉住的】
// 1. applyLocal 必须落盘（不再只改内存）
// 2. 落盘失败必须告知用户（不能假装成功）
// 3. 启动时两源漂移要自愈，且以 agent 配置为准
// ============================================================

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), ...rel.split('/')), 'utf-8')
}

describe('providerPersistence · applyLocal 必须落盘', () => {
  const src = readSrc('src/panels/settings/SettingsLLM.tsx')

  it('applyLocal 必须落盘（经统一入口即可）', () => {
    // 不再要求直接写 providerSaveConfig——已重构到 llmPersist 单一入口，
    // 断言「有无落盘行为」而非「用了哪个 API 名」
    expect(src).toMatch(/import \{[^}]*persistLLMConfig[^}]*\} from '\.\.\/\.\.\/services\/llmPersist'/)
    const applyLocal = src.slice(src.indexOf('const applyLocal'), src.indexOf('const [maxTokensDraft'))
    expect(applyLocal).toMatch(/persistLLMConfig/)
  })

  it('统一入口内部包含 setActive（切激活供应商）', () => {
    const p = readSrc('src/services/llmPersist.ts')
    expect(p).toMatch(/providerSaveConfig/)
    expect(p).toMatch(/providerSetActive/)
  })

  it('落盘失败必须告知用户（不能假装成功）', () => {
    const applyLocal = src.slice(src.indexOf('const applyLocal'), src.indexOf('const [maxTokensDraft'))
    expect(applyLocal).toMatch(/if \(!saved\.ok\)/)
    // 且提示里要说明会失效
    expect(applyLocal).toMatch(/重启后会失效|保存到配置失败/)
  })

  it('保留了本地模型可能需要的 apiKey（不强行清空）', () => {
    const applyLocal = src.slice(src.indexOf('const applyLocal'), src.indexOf('const [maxTokensDraft'))
    expect(applyLocal).toMatch(/apiKey:\s*st\.llmConfig\.apiKey/)
  })

  it('🔑 供应商快捷按钮也落盘（曾遗漏，与 applyLocal 同一个洞）', () => {
    // 这三处曾长期只改内存：applyLocal 修好了，旁边的按钮没跟上。
    // 断言：不得存在裸的 switchLLMProvider(p.id ...) 调用点。
    const bare = (src.match(/switchLLMProvider\(p\.id/g) || []).length
    expect(bare, '仍有 ProviderBtn 只改内存不落盘').toBe(0)

    // 2026-10-04：移除「免费模型（OpenCode Zen）」入口后，主区供应商按钮组从 3 组变 2 组
    // （本地：LM Studio / Ollama；云端：其余）。原先的 `>= 3` 把「按钮数量」当成了
    // 「落盘覆盖」的代理指标 —— 但真正的不变式是「每个按钮组都走落盘入口」，
    // 而上面那条零裸调用才是它的硬保证。这里改为精确断言，不再随按钮增删而失效。
    const mainPersist = (src.match(/switchAndPersist\(useStore\.getState\(\)/g) || []).length
    expect(mainPersist, '主区供应商按钮应改走 switchAndPersist').toBe(2)

    // Team Agent 区的按钮组按设计走 handleAgentProvider（独立落盘路径），也不能丢。
    const agentPersist = (src.match(/handleAgentProvider\(p\.id/g) || []).length
    expect(agentPersist, 'Team Agent 供应商按钮应走 handleAgentProvider').toBe(2)
  })

  it('🔑 保存按钮不再硬编码上下文窗口（曾丢弃用户设置）', () => {
    // 原来写死 maxContextTokens: 256000
    expect(src).not.toMatch(/maxContextTokens:\s*256000,/)
    expect(src).toMatch(/maxContextTokens:\s*st\.llmConfig\.contextWindow\s*\|\|\s*256000/)
  })
})

describe('providerPersistence · 启动自愈', () => {
  const src = readSrc('src/stores/appStore.ts')

  it('启动时读取 agent 配置用于比对', () => {
    expect(src).toMatch(/agentLlmGetAllConfigs/)
  })

  it('检测漂移（baseUrl 或 model 不同）', () => {
    expect(src).toMatch(/drifted/)
    expect(src).toMatch(/curActive\.baseUrl\s*!==\s*agentLumina\.endpoint/)
    expect(src).toMatch(/curActive\.model\s*!==\s*agentLumina\.model/)
  })

  it('以 agent 配置为准修正 provider（agent 才是真正发请求的那份）', () => {
    expect(src).toMatch(/baseUrl:\s*agentLumina\.endpoint/)
    expect(src).toMatch(/model:\s*agentLumina\.model/)
  })

  it('自愈失败不阻塞启动', () => {
    const heal = src.slice(src.indexOf('启动自愈'), src.indexOf('更新 providerConfigs'))
    expect(heal).toMatch(/catch/)
    expect(heal).toMatch(/不阻塞/)
  })

  it('后续逻辑用的是自愈后的 activeId（而非旧值）', () => {
    // 关键：providerConfigs 构建与测试连接都要用 activeId
    const after = src.slice(src.indexOf('启动自愈'))
    expect(after).toMatch(/id === activeId/)
    expect(after).toMatch(/newProviderConfigs\[activeId\]/)
    expect(after).toMatch(/providerTestConnection\?\.\(activeId\)/)
  })
})

describe('providerPersistence · 当前机器配置一致性', () => {
  it('两个配置文件不再漂移（若都在本机）', () => {
    const base = process.env.APPDATA
    if (!base) { return }   // 非 Windows 跳过
    const p1 = path.join(base, 'lumina-life', 'lumina-providers.json')
    const p2 = path.join(base, 'lumina-life', 'agent-llm-configs.json')
    if (!fs.existsSync(p1) || !fs.existsSync(p2)) { return }

    const providers = JSON.parse(fs.readFileSync(p1, 'utf-8'))
    const agents = JSON.parse(fs.readFileSync(p2, 'utf-8'))
    const activeId = providers.activeProviderId
    const p = providers.providers?.[activeId]
    const a = agents.lumina
    if (!p || !a?.endpoint) { return }

    // 设置面板显示的，必须就是 Agent 实际会用的
    expect(p.baseUrl, 'provider 与 agent 的 endpoint 漂移了').toBe(a.endpoint)
    expect(p.model, 'provider 与 agent 的 model 漂移了').toBe(a.model)
  })
})
