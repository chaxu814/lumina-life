// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
/**
 * teamAgentRestartSim.test.ts — 模拟「保存 → 重启 → 重读」
 *
 * 用 ESM 兼容写法（vitest 默认 import），避免 require 在 ESM 下挂掉。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as agentConfig from '../electron/agentConfig'

describe('Team Agent 配置 — 保存 → 重启 → 重读 端到端', () => {
  let root: string
  let configPath: string

  const resetSingleton = () => {
    ;(agentConfig as any)._instance = null
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-team-restart-'))
    configPath = path.join(root, 'agent-llm-configs.json')
    resetSingleton()
  })

  afterEach(() => {
    try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
    resetSingleton()
  })

  it('A. 在实例 c1 配置三个 agent，模拟重启后 c2 仍能拿到完整配置', () => {
    const c1 = (agentConfig as any).initAgentConfig(configPath)
    c1.set('lumina', {
      provider: 'deepseek', model: 'deepseek-chat',
      endpoint: 'https://api.deepseek.com/v1', apiKey: 'sk-deepseek-real',
      maxContextTokens: 131072, timeout: 600,
    } as any)
    c1.set('yak', {
      provider: 'lmstudio', model: 'qwen2.5-32b',
      endpoint: 'http://192.168.1.11:1234/v1', apiKey: '',
      maxContextTokens: 131072, timeout: 600,
    } as any)
    c1.set('recha', {
      provider: 'ollama', model: 'qwen3:14b',
      endpoint: 'http://127.0.0.1:11434/v1', apiKey: '',
      maxContextTokens: 131072, timeout: 600,
    } as any)

    // 模拟进程退出：清空模块单例
    resetSingleton()
    const c2 = (agentConfig as any).initAgentConfig(configPath)

    expect(c2.isConfigured('lumina')).toBe(true)
    expect(c2.isConfigured('yak')).toBe(true)
    expect(c2.isConfigured('recha')).toBe(true)

    expect(c2.get('lumina').provider).toBe('deepseek')
    expect(c2.get('lumina').model).toBe('deepseek-chat')
    expect(c2.get('lumina').endpoint).toBe('https://api.deepseek.com/v1')

    expect(c2.get('yak').provider).toBe('lmstudio')
    expect(c2.get('yak').endpoint).toBe('http://192.168.1.11:1234/v1')

    expect(c2.get('recha').provider).toBe('ollama')
    expect(c2.get('recha').endpoint).toBe('http://127.0.0.1:11434/v1')
  })

  it('B. 重启后再改一个 agent，其它两个保持原样', () => {
    const c1 = (agentConfig as any).initAgentConfig(configPath)
    c1.set('lumina', { provider: 'deepseek', model: 'deepseek-chat', endpoint: 'https://api.deepseek.com/v1', apiKey: 'sk-1' } as any)
    c1.set('yak',    { provider: 'deepseek', model: 'deepseek-chat', endpoint: 'https://api.deepseek.com/v1', apiKey: 'sk-2' } as any)
    c1.set('recha',  { provider: 'lmstudio', model: 'qwen2.5-7b',    endpoint: 'http://127.0.0.1:1234/v1', apiKey: '' } as any)

    resetSingleton()
    const c2 = (agentConfig as any).initAgentConfig(configPath)
    c2.set('recha', { provider: 'ollama', model: 'qwen3:14b', endpoint: 'http://127.0.0.1:11434/v1', apiKey: '' } as any)

    resetSingleton()
    const c3 = (agentConfig as any).initAgentConfig(configPath)
    expect(c3.get('lumina').apiKey).toBe('sk-1')
    expect(c3.get('yak').apiKey).toBe('sk-2')
    expect(c3.get('recha').provider).toBe('ollama')
    expect(c3.get('recha').model).toBe('qwen3:14b')
  })

  it('C. userData 目录里已有合法文件时，重启不会触发「全未配置 → 自动检测」覆写', () => {
    // 预先放一份已经配置好的文件（模拟重启时磁盘上已经存在数据）
    const pre = {
      lumina: { enabled: true, provider: 'deepseek', model: 'deepseek-chat', endpoint: 'https://api.deepseek.com/v1', apiKey: 'sk-existing', maxContextTokens: 131072, timeout: 600 },
      yak:    { enabled: true, provider: 'deepseek', model: 'deepseek-chat', endpoint: 'https://api.deepseek.com/v1', apiKey: 'sk-existing', maxContextTokens: 131072, timeout: 600 },
      recha:  { enabled: true, provider: 'deepseek', model: 'deepseek-chat', endpoint: 'https://api.deepseek.com/v1', apiKey: 'sk-existing', maxContextTokens: 131072, timeout: 600 },
    }
    fs.writeFileSync(configPath, JSON.stringify(pre, null, 2), 'utf8')

    const c = (agentConfig as any).initAgentConfig(configPath)

    // 关键不变式：磁盘已存 enabled=true 时，load() 不应被「全未配置」分支触发
    // （因为实际并非全未配置，而是磁盘里三个都 enabled）。
    expect(c.isConfigured('lumina')).toBe(true)
    expect(c.isConfigured('yak')).toBe(true)
    expect(c.isConfigured('recha')).toBe(true)
    expect(c.get('lumina').apiKey).toBe('sk-existing')

    // load 完后，磁盘文件不应被自动检测路径改写
    const after = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    expect(after.lumina.apiKey).toBe('sk-existing')
    expect(after.yak.apiKey).toBe('sk-existing')
    expect(after.recha.apiKey).toBe('sk-existing')
  })
})
