// 回归覆盖：群聊就绪状态必须校验 Lumina Team Agent 的真实配置，
// 本地可免 Key，但不能拿全局供应商或其它 Agent 的 Key 冒充。
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const src = fs.readFileSync(
  path.join(process.cwd(), 'src', 'panels', 'GroupChatView.tsx'),
  'utf-8',
)

describe('群聊 LLM 就绪判据', () => {
  it('就绪状态取 Lumina Team 自己的 Agent 配置，不取全局供应商配置', () => {
    expect(src).toMatch(/const luminaTeamConfig = agentLlmConfigs\.lumina/)
    expect(src).toMatch(/baseUrl: luminaTeamConfig\?\.endpoint/)
    expect(src).toMatch(/apiKey: luminaTeamConfig\?\.apiKey/)
  })

  it('llmConfigured 允许「本地 + 有模型」而没有 Key，但需要 Team Agent 已启用', () => {
    expect(src).toMatch(/luminaTeamConfig\?\.enabled/)
    expect(src).toMatch(/readinessConfig\.apiKey \|\| isLocalLLM/)
  })

  it('本地模型额外要求真的加载了；探测未完成时不阻塞', () => {
    // null（探测中）不能判为未就绪，否则刚打开界面会闪一下「模拟模式」
    expect(src).toMatch(/const llmReady = llmConfigured && \(isLocalLLM \? localModelReady !== false : true\)/)
  })

  it('探测 effect 依赖 llmConfigured 而不是 llmReady（避免自引用）', () => {
    const dep = src.slice(src.indexOf('probeLocal().then((ready) => { if (alive)'))
    const line = dep.split('\n').slice(0, 4).join('\n')
    expect(line).toMatch(/\}, \[llmConfigured, isLocalLLM, readinessConfig\.baseUrl, readinessConfig\.model, readinessConfig\.apiKey, readinessConfig\.provider\]\)/)
  })

  it('探测与「重新检测」按钮共用同一套判定', () => {
    expect(src).toMatch(/const probeLocal = \(\) => \{/)
    expect(src).toMatch(/const retryLocalDetect = \(\) => \{ probeLocal\(\)/)
  })

  it('就绪探测只使用 Lumina Team → Lumina 的端点、供应商与 API Key', () => {
    expect(src).toMatch(/providerProbeLocalConfig\?\.\(\{/)
    expect(src).toMatch(/baseUrl: readinessConfig\.baseUrl/)
    expect(src).toMatch(/provider: readinessConfig\.provider/)
    expect(src).toMatch(/apiKey: readinessConfig\.apiKey/)
    expect(src).not.toMatch(/providerDiscoverLocal\?\.\(\{ baseUrl: llmConfig\.baseUrl \}\)/)
  })

  it('本地未就绪时文案指向 Lumina Team 配置，并说明开启鉴权时需要匹配的 Key', () => {
    expect(src).toMatch(/设置 → Lumina Team 供应商配置 → Lumina/)
    expect(src).toMatch(/服务启用了鉴权/)
    expect(src).toMatch(/isLocalLLM\s*\n?\s*\?/)
  })

  it('两个提示框都给了「去设置」/「重新检测」入口', () => {
    expect(src).toMatch(/⚙️ 去设置/)
    expect(src).toMatch(/↻ 重新检测/)
  })

  it('云端判据按 Lumina Team 的实际配置识别（sk- / openai / moonshot / deepseek）', () => {
    expect(src).toMatch(/isCloudAPI = readinessConfig\.apiKey\?\.startsWith\('sk-'\)/)
    expect(src).toMatch(/api\.deepseek/)
  })

  it('全局 API 已配置时提供显式复制到 Lumina Team 的操作，不静默覆盖独立配置', () => {
    expect(src).toMatch(/syncGlobalConfigToLumina = async/)
    expect(src).toMatch(/agentLlmSetConfig\?\.\('lumina'/)
    expect(src).toMatch(/将普通模式 API 复制给 Lumina Team/)
    expect(src).toMatch(/覆盖 Lumina Team → Lumina 独立配置/)
    expect(src).toMatch(/await loadAgentLlmConfigs\(\)/)
  })
})
