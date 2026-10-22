// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// qwenPawClobber.test.ts — QwenPaw 兼容不覆盖磁盘激活供应商 / 不污染 Team Agent (2026-10-11)
//
// 【真实故障（用户报）】
//   「每次我打开 Lumina 这里的供应商，API 每次都会变了，之前是不变的，
//    而且 team agent 也收到影响了」
//
// 【根因】
//   electron/core/providerManager.ts 旧 initialize() 流程：
//     1) 先 tryLoadFromQwenPawAgent()（读 workspaces/<id>/agent.json 的 active_model）
//     2) `qpSynced = tryLoadFromQwenPawAgent()` 成功后，整个「从磁盘 lumina-providers.json
//        加载」的块被 `if (!qpSynced)` 条件跳过 → 磁盘配置完全失效
//     3) tryLoadFromQwenPawAgent() 又**无条件** `this.store.activeProviderId = luminaId`
//        → 激活项被 QwenPaw 的 active_model 接管
//   QwenPaw 的 agent.json 在不同机器/版本里 active_model 不稳定（一会儿 deepseek、一会儿 qwen），
//   于是 Lumina 每次启动激活项都变；并且 active 变了 → setActiveProvider → syncFromGlobalProvider
//   → 三个 Team Agent (lumina/yak/recha) 全部被改写成那个不稳定的供应商。
//
// 【修法（2026-10-11，与 _migrateFromEnv 的磁盘优先原则一致）】
//   1) initialize() 永远先无条件从磁盘加载（不再因 qpSynced 跳过）。
//   2) tryLoadFromQwenPawAgent() 仅在「磁盘没有合法激活项」时才采用 QwenPaw 默认；
//      磁盘已有激活项时，QwenPaw 只**补全缺失的 provider 配置**，绝不动 activeProviderId。
//
// 【本测试钉住的】
//   A. 磁盘 active=openai + QwenPaw active_model=deepseek → 重启后仍是 openai（QwenPaw 被磁盘压制）
//   B. 磁盘 active=openai + QwenPaw=deepseek → 写回磁盘仍是 openai（不落 deepseek）
//   C. 磁盘无文件 + QwenPaw=deepseek → 首次运行仍采用 QwenPaw（不破坏首次迁移路径）
//   D. 磁盘 active=openai + QwenPaw 指向磁盘缺失的 zhipu → 仅补全 zhipu 配置，激活仍是 openai
//   E. 端到端：磁盘 active=openai + QwenPaw=deepseek → 以实际激活项重同步 Team Agent，
//      Team Agent 落到用户选择的 openai（不被 deepseek 污染）。
//      ★ 旧实现会因 getActiveProviderId()==='deepseek' 把 Team Agent 全部改成 deepseek。
// ============================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ProviderManager } from '../electron/core/providerManager'
import { initAgentConfig, getAgentConfig } from '../electron/agentConfig'

const PROVIDERS_SEED = {
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'v1:x:d', model: 'deepseek-chat', enabled: true, timeout: 600, maxContextTokens: 131072 },
  openai:   { baseUrl: 'https://api.openai.com/v1',  apiKey: 'v1:x:o', model: 'gpt-4o',       enabled: true, timeout: 600, maxContextTokens: 131072 },
  qwen:     { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: '', model: 'qwen-plus', enabled: true, timeout: 600, maxContextTokens: 131072 },
}

describe('ProviderManager · QwenPaw 兼容不覆盖磁盘激活供应商 / 不污染 Team Agent', () => {
  let dir: string
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-qp-')) })
  afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } })

  const providerPath = () => path.join(dir, 'lumina-providers.json')
  const agentCfgPath = () => path.join(dir, 'agent-llm-configs.json')

  /** 把「磁盘上已有合法配置」模拟出来 */
  function seedDisk(activeId: string, providers: Record<string, any> = PROVIDERS_SEED) {
    const data = { activeProviderId: activeId, providers }
    fs.writeFileSync(providerPath(), JSON.stringify(data, null, 2), 'utf-8')
  }

  /** 写一个 QwenPaw 风格的 agent.json（active_model） */
  function seedQwenPaw(providerId: string, model: string) {
    const agentId = process.env.LUMINA_AGENT_ID || 'lumina'
    const p = path.join(dir, 'workspaces', agentId, 'agent.json')
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify({ active_model: { provider_id: providerId, model } }), 'utf-8')
  }

  /** 预置 Team Agent 配置（哨兵值，便于检测是否被改写） */
  function seedTeamAgentsSentinel() {
    const sentinel = { enabled: true, provider: 'qwen', model: 'qwen-sentinel', endpoint: 'http://sentinel.local/v1', apiKey: 'sk-sentinel', maxContextTokens: 131072, timeout: 600, configuredAt: 1 }
    const data = { lumina: { ...sentinel }, yak: { ...sentinel }, recha: { ...sentinel } }
    fs.writeFileSync(agentCfgPath(), JSON.stringify(data, null, 2), 'utf-8')
  }

  it('A. 磁盘 active=openai + QwenPaw active_model=deepseek → 重启后仍是 openai（QwenPaw 被磁盘压制）', async () => {
    seedDisk('openai')
    seedQwenPaw('deepseek', 'deepseek-chat')
    const pm = new ProviderManager(dir)
    await pm.initialize()
    expect(pm.getActiveProviderId(), '用户保存的 openai 绝不能被 QwenPaw 的 active_model 覆盖').toBe('openai')
  })

  it('B. 磁盘 active=openai + QwenPaw=deepseek → 写回磁盘仍是 openai（不落 deepseek）', async () => {
    seedDisk('openai')
    seedQwenPaw('deepseek', 'deepseek-chat')
    const pm = new ProviderManager(dir)
    await pm.initialize()
    const disk = JSON.parse(fs.readFileSync(providerPath(), 'utf-8'))
    expect(disk.activeProviderId, '落盘激活项必须保留用户选择').toBe('openai')
  })

  it('C. 磁盘无文件 + QwenPaw=deepseek → 首次运行仍采用 QwenPaw（不破坏首次迁移路径）', async () => {
    // 确保没有磁盘文件
    fs.rmSync(providerPath(), { force: true })
    expect(fs.existsSync(providerPath())).toBe(false)
    seedQwenPaw('deepseek', 'deepseek-chat')
    const pm = new ProviderManager(dir)
    await pm.initialize()
    expect(pm.getActiveProviderId(), '首次运行无磁盘时应采纳 QwenPaw 默认').toBe('deepseek')
  })

  it('D. 磁盘 active=openai + QwenPaw 指向磁盘缺失的 zhipu → 仅补全 zhipu，激活仍是 openai', async () => {
    // 磁盘里没有 zhipu
    seedDisk('openai')
    seedQwenPaw('zhipu', 'glm-4')
    const pm = new ProviderManager(dir)
    await pm.initialize()
    expect(pm.getActiveProviderId(), '激活项保持用户选择 openai').toBe('openai')
    const disk = JSON.parse(fs.readFileSync(providerPath(), 'utf-8'))
    // QwenPaw 配置了磁盘缺失的 zhipu → 应被补全进来，但不应抢占激活位
    expect(disk.providers.zhipu, 'QwenPaw 缺失 provider 应被补全').toBeTruthy()
    expect(disk.providers.zhipu.model).toBe('glm-4')
    expect(disk.activeProviderId).toBe('openai')
  })

  it('E. 端到端：磁盘 active=openai + QwenPaw=deepseek → Team Agent 同步到 openai（不被 deepseek 污染）', async () => {
    seedDisk('openai')
    seedQwenPaw('deepseek', 'deepseek-chat')
    seedTeamAgentsSentinel()

    const pm = new ProviderManager(dir)
    await pm.initialize()

    // 用「实际激活项」重新同步 Team Agent —— 复刻启动自愈/setActiveProvider 的真实调用链
    initAgentConfig(agentCfgPath()) // 显式把单例指到临时目录，避免触碰真实用户文件
    const active = pm.getActiveProviderId()
    pm.setActiveProvider(active)

    const ac = getAgentConfig()
    for (const id of ['lumina', 'yak', 'recha'] as const) {
      const cfg = ac.getEffectiveConfig(id)
      expect(cfg.provider, `[${id}] Team Agent 应反映用户选择的 openai，而非 QwenPaw 的 deepseek`).toBe('openai')
      expect(cfg.model).toBe('gpt-4o')
      expect(cfg.endpoint).toBe('https://api.openai.com/v1')
      // 确认不是旧哨兵值（证明确实被改写成了用户选择，而不是停留在预置）
      expect(cfg.provider, 'Team Agent 不应停留在预置哨兵 qwen').not.toBe('qwen')
    }

    // 同时确认磁盘 Team Agent 配置也写成 openai
    const teamDisk = JSON.parse(fs.readFileSync(agentCfgPath(), 'utf-8'))
    for (const id of ['lumina', 'yak', 'recha']) {
      expect(teamDisk[id].provider, `[${id}] 落盘 Team Agent 应为 openai`).toBe('openai')
    }
  })
})
