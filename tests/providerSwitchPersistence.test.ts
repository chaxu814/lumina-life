// ============================================================
// providerSwitchPersistence.test.ts — 切换供应商不丢旧配置（2026-10-10）
//
// 【回答用户的两个问题】
//   ① 配置好后会保存吗？→ 落盘到 userData/lumina-providers.json，重启可读回
//   ② 切换其它供应商后，原来那家的 API/密钥还在吗？→ 在
//
// 依据：ProviderManager._save() 写的是**全部** provider（各自 key 加密），
//       setActiveProvider() 只改 activeProviderId + 全量落盘，不删其它项。
// 本测试用真实 ProviderManager + 临时目录做「保存 → 切换 → 重载」往返验证。
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ProviderManager } from '../electron/core/providerManager'

describe('供应商配置持久化 · 切换不丢旧配置', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-prov-')) })
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } })

  it('保存的供应商配置会落盘到 lumina-providers.json', async () => {
    const pm = new ProviderManager(dir)
    await pm.initialize()
    pm.setProviderConfig('deepseek', {
      baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-deepseek-REAL', model: 'deepseek-chat', enabled: true,
    })
    pm.setActiveProvider('deepseek')
    expect(fs.existsSync(path.join(dir, 'lumina-providers.json'))).toBe(true)
  })

  it('切换供应商后，原来那家的 API 地址与密钥仍保留', async () => {
    const pm = new ProviderManager(dir)
    await pm.initialize()
    // 1) 配好 deepseek 并激活
    pm.setProviderConfig('deepseek', {
      baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-deepseek-REAL', model: 'deepseek-chat', enabled: true,
    })
    pm.setActiveProvider('deepseek')
    // 2) 再配 lmstudio 并切过去
    pm.setProviderConfig('lmstudio', {
      baseUrl: 'http://192.168.1.2:1234/v1', apiKey: 'lm-key-abc', model: 'QwenPaw Flash 4B Q4', enabled: true,
    })
    pm.setActiveProvider('lmstudio')

    // 3) 模拟"重启"：全新实例从同一目录加载
    const pm2 = new ProviderManager(dir)
    await pm2.initialize()

    expect(pm2.getActiveProviderId(), '激活的应是最后切换的 lmstudio').toBe('lmstudio')
    const deepseek = pm2.getProviderConfig('deepseek')
    expect(deepseek, 'deepseek 配置不该因为切走而消失').not.toBeNull()
    expect(deepseek!.apiKey, 'deepseek 的密钥必须还在').toBe('sk-deepseek-REAL')
    expect(deepseek!.baseUrl).toBe('https://api.deepseek.com/v1')

    const lm = pm2.getProviderConfig('lmstudio')
    expect(lm!.apiKey).toBe('lm-key-abc')
    expect(lm!.baseUrl).toBe('http://192.168.1.2:1234/v1')
    expect(lm!.model).toBe('QwenPaw Flash 4B Q4')
  })

  it('连续切换三家，三家配置都在（不是只留最后一家）', async () => {
    const pm = new ProviderManager(dir)
    await pm.initialize()
    pm.setProviderConfig('deepseek', { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'k-ds', model: 'deepseek-chat', enabled: true })
    pm.setActiveProvider('deepseek')
    pm.setProviderConfig('qwen', { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: 'k-qw', model: 'qwen-plus', enabled: true })
    pm.setActiveProvider('qwen')
    pm.setProviderConfig('lmstudio', { baseUrl: 'http://192.168.1.2:1234/v1', apiKey: 'k-lm', model: 'QwenPaw Flash 4B Q4', enabled: true })
    pm.setActiveProvider('lmstudio')

    const pm2 = new ProviderManager(dir)
    await pm2.initialize()
    expect(pm2.getProviderConfig('deepseek')?.apiKey).toBe('k-ds')
    expect(pm2.getProviderConfig('qwen')?.apiKey).toBe('k-qw')
    expect(pm2.getProviderConfig('lmstudio')?.apiKey).toBe('k-lm')
    expect(pm2.getActiveProviderId()).toBe('lmstudio')
  })

  it('密钥以加密形式落盘（明文不直接出现在文件里）', async () => {
    const pm = new ProviderManager(dir)
    await pm.initialize()
    pm.setProviderConfig('deepseek', { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-SECRET-PLAINTEXT', model: 'deepseek-chat', enabled: true })
    pm.setActiveProvider('deepseek')
    const raw = fs.readFileSync(path.join(dir, 'lumina-providers.json'), 'utf-8')
    expect(raw, '明文密钥不应原样出现在配置文件里').not.toContain('sk-SECRET-PLAINTEXT')
    // 但重新加载必须能解回明文（否则等于丢了）
    const pm2 = new ProviderManager(dir)
    await pm2.initialize()
    expect(pm2.getProviderConfig('deepseek')?.apiKey).toBe('sk-SECRET-PLAINTEXT')
  })
})
