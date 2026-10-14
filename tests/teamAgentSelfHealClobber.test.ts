// ============================================================
// teamAgentSelfHealClobber.test.ts — 启动自愈反被全局同步覆盖（回归）
//
// 【用户实测】
//   「每次重新打开 Lumina，team agent 配置每次都需要设置。」
//
// 【怀疑的因果链】
//   1. 用户把 Team Agent 配成自己的本地 LM Studio（agents = lmstudio），
//      而全局激活供应商仍是旧的 deepseek（providers.activeProviderId = deepseek）。
//   2. 重启时 appStore.syncProviderFromBackend 的「启动自愈」检测到漂移：
//        curActive(deepseek) !== agentLumina(lmstudio)
//      于是调用 providerSaveConfig(agentLumina.provider='lmstudio', ...)。
//   3. providerManager.setProviderConfig('lmstudio') 落盘后**无条件**调用
//      agentConfig.syncFromGlobalProvider()。
//   4. syncFromGlobalProvider 读到的 activeProviderId 仍是 **deepseek**（因为
//      自愈并没有调 providerSetActive），于是把 lumina/yak/recha 三个 Agent
//      全部改回 deepseek —— 用户刚配好的 LM Studio 被抹掉。
//
//   这就是「每次重启都要重配一遍」的根因。
//
// 本文件锁住不变式：
//   setProviderConfig(非激活供应商) 不得把 Team Agent 覆盖成「当前激活供应商」。
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as agentConfig from '../electron/agentConfig'
import { ProviderManager } from '../electron/core/providerManager'

describe('启动自愈不应把 Team Agent 覆盖回全局激活供应商', () => {
  let root: string
  let providersPath: string
  let agentsPath: string

  const writeJson = (p: string, obj: any) => fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8')
  const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'))

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-selfheal-'))
    providersPath = path.join(root, 'lumina-providers.json')
    agentsPath = path.join(root, 'agent-llm-configs.json')
    process.env.LUMINA_USER_DATA = root
    ;(agentConfig as any)._instance = null
  })

  afterEach(() => {
    try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
    delete process.env.LUMINA_USER_DATA
    ;(agentConfig as any)._instance = null
  })

  it('用户把 Agent 配成 LM Studio、全局激活仍是 DeepSeek → 自愈不应抹掉 LM Studio', async () => {
    // ── 磁盘状态：全局激活 deepseek；lmstudio 槽位有配置 ──
    writeJson(providersPath, {
      activeProviderId: 'deepseek',
      providers: {
        deepseek: {
          baseUrl: 'https://api.deepseek.com/v1',
          apiKey: 'sk-deepseek',
          model: 'deepseek-chat',
          enabled: true,
          timeout: 600,
          maxContextTokens: 131072,
        },
        lmstudio: {
          baseUrl: 'http://192.168.1.11:1234/v1',
          apiKey: '',
          model: 'qwen2.5-32b-instruct',
          enabled: true,
          timeout: 600,
          maxContextTokens: 131072,
        },
      },
    })

    // ── 磁盘状态：三个 Agent 都是用户配的 LM Studio ──
    const lmAgent = {
      enabled: true,
      provider: 'lmstudio',
      model: 'qwen2.5-32b-instruct',
      endpoint: 'http://192.168.1.11:1234/v1',
      apiKey: '',
      maxContextTokens: 131072,
      timeout: 600,
    }
    writeJson(agentsPath, { lumina: lmAgent, yak: lmAgent, recha: lmAgent })

    // 让 AgentConfigManager 单例指向这个临时目录
    const ac = (agentConfig as any).initAgentConfig(agentsPath)
    expect(ac.get('lumina').provider).toBe('lmstudio')

    // ── 模拟启动自愈：providerSaveConfig('lmstudio', {…agentLumina 的值…}) ──
    const pm = new ProviderManager(root)
    await pm.initialize()
    pm.setProviderConfig('lmstudio', {
      baseUrl: 'http://192.168.1.11:1234/v1',
      apiKey: '',
      model: 'qwen2.5-32b-instruct',
      enabled: true,
      maxContextTokens: 131072,
    })

    // ── 关键断言：Agent 仍是用户配的 LM Studio，没被回退成 deepseek ──
    expect(ac.get('lumina').provider, 'lumina 被自愈覆盖回全局激活供应商了').toBe('lmstudio')
    expect(ac.get('lumina').endpoint).toBe('http://192.168.1.11:1234/v1')
    expect(ac.get('yak').provider, 'yak 被自愈覆盖回全局激活供应商了').toBe('lmstudio')
    expect(ac.get('recha').provider, 'recha 被自愈覆盖回全局激活供应商了').toBe('lmstudio')

    // 磁盘上也不应被改写
    const onDisk = readJson(agentsPath)
    expect(onDisk.lumina.provider).toBe('lmstudio')
    expect(onDisk.yak.provider).toBe('lmstudio')
    expect(onDisk.recha.provider).toBe('lmstudio')
  })

  it('反向不变式：保存「当前激活供应商」时，仍应同步到 Team Agent', async () => {
    writeJson(providersPath, {
      activeProviderId: 'deepseek',
      providers: {
        deepseek: {
          baseUrl: 'https://api.deepseek.com/v1',
          apiKey: 'sk-old',
          model: 'deepseek-chat',
          enabled: true,
          timeout: 600,
          maxContextTokens: 131072,
        },
      },
    })
    writeJson(agentsPath, {
      lumina: { enabled: true, provider: 'lmstudio', model: 'qwen2.5-32b-instruct', endpoint: 'http://192.168.1.11:1234/v1', apiKey: '', maxContextTokens: 131072, timeout: 600 },
      yak: { enabled: true, provider: 'lmstudio', model: 'qwen2.5-32b-instruct', endpoint: 'http://192.168.1.11:1234/v1', apiKey: '', maxContextTokens: 131072, timeout: 600 },
      recha: { enabled: true, provider: 'lmstudio', model: 'qwen2.5-32b-instruct', endpoint: 'http://192.168.1.11:1234/v1', apiKey: '', maxContextTokens: 131072, timeout: 600 },
    })

    const ac = (agentConfig as any).initAgentConfig(agentsPath)
    const pm = new ProviderManager(root)
    await pm.initialize()

    // 保存的正是激活供应商 deepseek → 应把它同步给 Team Agent（既有意图不变）
    pm.setProviderConfig('deepseek', {
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-new',
      model: 'deepseek-reasoner',
      enabled: true,
      maxContextTokens: 131072,
    })

    expect(ac.get('lumina').provider).toBe('deepseek')
    expect(ac.get('lumina').model).toBe('deepseek-reasoner')
    expect(ac.get('yak').provider).toBe('deepseek')
    expect(ac.get('recha').provider).toBe('deepseek')
  })

  it('反向不变式：显式切换激活供应商（setActiveProvider）仍同步到 Team Agent', async () => {
    writeJson(providersPath, {
      activeProviderId: 'deepseek',
      providers: {
        deepseek: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-ds', model: 'deepseek-chat', enabled: true, timeout: 600, maxContextTokens: 131072 },
        lmstudio: { baseUrl: 'http://192.168.1.11:1234/v1', apiKey: '', model: 'qwen2.5-32b-instruct', enabled: true, timeout: 600, maxContextTokens: 131072 },
      },
    })
    writeJson(agentsPath, {
      lumina: { enabled: true, provider: 'deepseek', model: 'deepseek-chat', endpoint: 'https://api.deepseek.com/v1', apiKey: 'sk-ds', maxContextTokens: 131072, timeout: 600 },
      yak: { enabled: true, provider: 'deepseek', model: 'deepseek-chat', endpoint: 'https://api.deepseek.com/v1', apiKey: 'sk-ds', maxContextTokens: 131072, timeout: 600 },
      recha: { enabled: true, provider: 'deepseek', model: 'deepseek-chat', endpoint: 'https://api.deepseek.com/v1', apiKey: 'sk-ds', maxContextTokens: 131072, timeout: 600 },
    })

    const ac = (agentConfig as any).initAgentConfig(agentsPath)
    const pm = new ProviderManager(root)
    await pm.initialize()

    pm.setActiveProvider('lmstudio')

    expect(ac.get('lumina').provider).toBe('lmstudio')
    expect(ac.get('lumina').endpoint).toBe('http://192.168.1.11:1234/v1')
    expect(ac.get('yak').provider).toBe('lmstudio')
    expect(ac.get('recha').provider).toBe('lmstudio')
  })
})
