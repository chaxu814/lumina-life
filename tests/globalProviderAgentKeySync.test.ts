import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as agentConfig from '../electron/agentConfig'
import { ProviderManager } from '../electron/core/providerManager'
import { encryptProviderApiKey } from '../electron/core/providerKeyCrypto'

const resetSingleton = () => { (agentConfig as any)._instance = null }

describe('全局 Provider → Team Agent API Key 同步', () => {
  let dir = ''
  afterEach(() => {
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } }
    dir = ''
    resetSingleton()
  })

  it('切换全局 Provider 时先解密再同步给 Team Agent，重启后仍是同一明文', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-global-agent-key-'))
    const agentPath = path.join(dir, 'agent-llm-configs.json')
    const providersPath = path.join(dir, 'lumina-providers.json')
    const savedKey = 'sk-lmstudio-team-real-key'

    const configured = {
      enabled: true,
      provider: 'legacy',
      model: 'legacy-model',
      endpoint: 'https://legacy.example/v1',
      apiKey: '',
      timeout: 600,
      maxContextTokens: 131072,
      configuredAt: 10,
    }
    fs.writeFileSync(agentPath, JSON.stringify({
      lumina: { ...configured }, yak: { ...configured }, recha: { ...configured },
    }), 'utf-8')
    fs.writeFileSync(providersPath, JSON.stringify({
      activeProviderId: 'lmstudio',
      providers: {
        lmstudio: {
          baseUrl: 'http://192.168.1.11:1234/v1',
          model: 'QwenPaw Flash 4B Q4',
          apiKey: encryptProviderApiKey(savedKey),
          enabled: true,
        },
      },
    }), 'utf-8')

    const manager = (agentConfig as any).initAgentConfig(agentPath)
    const providers = new ProviderManager(dir)
    await providers.initialize()
    // 真正复刻「切换全局激活供应商」：ProviderManager 会从磁盘同步至 Team Agent。
    providers.setActiveProvider('lmstudio')
    for (const id of ['lumina', 'yak', 'recha']) {
      const cfg = manager.get(id)
      expect(cfg.endpoint).toBe('http://192.168.1.11:1234/v1')
      expect(cfg.model).toBe('QwenPaw Flash 4B Q4')
      expect(cfg.apiKey, `${id} 的运行时 Key 必须是原始明文，而非全局 v1 密文`).toBe(savedKey)
    }

    // 模拟应用重启：Team Agent 文件二次加密后应正常还原成原始 key。
    resetSingleton()
    const restarted = (agentConfig as any).initAgentConfig(agentPath)
    for (const id of ['lumina', 'yak', 'recha']) {
      expect(restarted.get(id).apiKey, `${id} 重启后的 Key 不应二次加密/乱码`).toBe(savedKey)
    }
  })

  it('启动时自动修复旧版已双重加密的 Team API Key，不需要用户再点复制', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-repair-agent-key-'))
    const agentPath = path.join(dir, 'agent-llm-configs.json')
    const globalKey = 'sk-existing-global-key'
    const configured = {
      enabled: true,
      provider: 'lmstudio',
      model: 'QwenPaw Flash 4B Q4',
      endpoint: 'http://192.168.1.11:1234/v1',
      apiKey: '',
      timeout: 600,
      maxContextTokens: 131072,
      configuredAt: 10,
    }
    fs.writeFileSync(agentPath, JSON.stringify({
      lumina: { ...configured }, yak: { ...configured }, recha: { ...configured },
    }), 'utf-8')

    // 复现旧错误：Provider 密文被当成明文写入 per-agent 文件，再加密一层。
    const first = (agentConfig as any).initAgentConfig(agentPath)
    first.set('lumina', { ...configured, apiKey: encryptProviderApiKey(globalKey) })
    expect(first.get('lumina').apiKey).toMatch(/^v1:/)

    resetSingleton()
    const recovered = (agentConfig as any).initAgentConfig(agentPath)
    expect(recovered.get('lumina').apiKey).toBe(globalKey)

    // load() 应把历史错误格式规范化保存，后续重启也继续得到明文。
    resetSingleton()
    const normalized = (agentConfig as any).initAgentConfig(agentPath)
    expect(normalized.get('lumina').apiKey).toBe(globalKey)
  })
})
