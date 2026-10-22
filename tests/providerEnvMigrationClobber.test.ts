// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// providerEnvMigrationClobber.test.ts — .env 迁移覆盖激活供应商 (2026-10-11)
//
// 【真实故障】
// 用户实测反馈：「每次打开 Lumina 的模型供应商都是 DeepSeek 默认，不是我上次保存保留的对应供应商」
//
// 【根因】
//   electron/core/providerManager.ts 的 initialize() 流程：
//     1) 先 tryLoadFromQwenPawAgent (兼容旧版, 通常跳过)
//     2) !qpSynced 分支内：先从磁盘 lumina-providers.json 读 → this.store.activeProviderId='openai'
//     3) 接着无条件调 this._migrateFromEnv()
//     4) _migrateFromEnv() 只要读到**任何一个** .env baseUrl（用户的 .env 有 LMSTUDIO_BASE_URL）
//        → 进入 if (anyFound) 分支 → 没有 LUMINA_DEFAULT_PROVIDER → 走 cloudOrder
//        → cloudOrder = ['deepseek', 'qwen', 'openai', 'zhipu', 'siliconflow']
//        → 第一个在 this.store.providers 里存在的是 'deepseek'
//        → this.store.activeProviderId = 'deepseek'  ← 用户刚保存的 openai 被覆盖！
//     5) _save() 把 deepseek 落盘
//
// 【修法（2026-10-11）】
//   _migrateFromEnv() 只在「磁盘没有激活项」时才决定激活哪个；
//   磁盘已有合法激活项时，仅**补全** .env 里出现但磁盘里没有的供应商，
//   **不动** activeProviderId。
//
// 【本测试钉住的】
//   A. 磁盘 activeProviderId=openai + .env 有 LMSTUDIO_BASE_URL → 重启后仍是 openai
//   B. 磁盘 activeProviderId=lmstudio + .env 有 LMSTUDIO_BASE_URL → 重启后仍是 lmstudio
//   C. 磁盘 activeProviderId=qwen + .env 有 LMSTUDIO_BASE_URL + LUMINA_DEFAULT_PROVIDER=openai
//      → 显式设置优先，仍按 openai 激活
//   D. 磁盘 activeProviderId=''（首次运行）+ .env 有 LMSTUDIO_BASE_URL → 走 cloudOrder → deepseek
//      （保护"首次启动"路径不被改坏）
//   E. 磁盘没有文件 + .env 有 LMSTUDIO_BASE_URL → 走 cloudOrder → deepseek（首次运行迁移）
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ProviderManager } from '../electron/core/providerManager'

/**
 * 在隔离进程环境里操作 .env 变量。
 * 注意：process.env 是模块级共享，必须 restore。
 */
function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>) {
  const saved: Record<string, string | undefined> = {}
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k]
    if (vars[k] === undefined) {delete process.env[k]}
    else {process.env[k] = vars[k]}
  }
  return fn().finally(() => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) {delete process.env[k]}
      else {process.env[k] = saved[k]}
    }
  })
}

describe('ProviderManager · .env 迁移不覆盖已保存的激活供应商', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-envclob-')) })
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } })

  /**
   * 把「磁盘上已有合法配置」模拟出来：写一个完整的 lumina-providers.json
   */
  function seedDiskConfig(activeId: string) {
    const data = {
      activeProviderId: activeId,
      providers: {
        deepseek: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'v1:x:d', model: 'deepseek-chat', enabled: true, timeout: 600, maxContextTokens: 131072 },
        openai:   { baseUrl: 'https://api.openai.com/v1',  apiKey: 'v1:x:o', model: 'gpt-4o',         enabled: true, timeout: 600, maxContextTokens: 131072 },
        lmstudio: { baseUrl: 'http://127.0.0.1:1234/v1',  apiKey: 'v1:x:l', model: 'qwen2.5:7b',     enabled: true, timeout: 600, maxContextTokens: 131072 },
        qwen:     { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: '', model: 'qwen-plus', enabled: true, timeout: 600, maxContextTokens: 131072 },
      },
    }
    fs.writeFileSync(path.join(dir, 'lumina-providers.json'), JSON.stringify(data, null, 2), 'utf-8')
  }

  it('A. 磁盘 active=openai + .env 有 LMSTUDIO_BASE_URL → 重启后仍是 openai（不被 env migration 覆盖）', async () => {
    seedDiskConfig('openai')
    await withEnv(
      { LMSTUDIO_BASE_URL: 'http://127.0.0.1:1234/v1', LMSTUDIO_API_KEY: 'sk-lm', LUMINA_DEFAULT_PROVIDER: undefined },
      async () => {
        const pm = new ProviderManager(dir)
        await pm.initialize()
        expect(pm.getActiveProviderId(), '用户保存的 openai 绝不能被 .env 迁移覆盖').toBe('openai')
        // 磁盘也被写回 openai（不是 deepseek）
        const disk = JSON.parse(fs.readFileSync(path.join(dir, 'lumina-providers.json'), 'utf-8'))
        expect(disk.activeProviderId).toBe('openai')
      },
    )
  })

  it('B. 磁盘 active=lmstudio + .env 有 LMSTUDIO_BASE_URL → 重启后仍是 lmstudio', async () => {
    seedDiskConfig('lmstudio')
    await withEnv(
      { LMSTUDIO_BASE_URL: 'http://127.0.0.1:1234/v1', LMSTUDIO_API_KEY: 'sk-lm', LUMINA_DEFAULT_PROVIDER: undefined },
      async () => {
        const pm = new ProviderManager(dir)
        await pm.initialize()
        expect(pm.getActiveProviderId()).toBe('lmstudio')
      },
    )
  })

  it('C. LUMINA_DEFAULT_PROVIDER=openai + 磁盘 active=qwen → 磁盘优先（不再被 env 覆盖）', async () => {
    seedDiskConfig('qwen')
    await withEnv(
      { LMSTUDIO_BASE_URL: 'http://127.0.0.1:1234/v1', LMSTUDIO_API_KEY: 'sk-lm', LUMINA_DEFAULT_PROVIDER: 'openai' },
      async () => {
        const pm = new ProviderManager(dir)
        await pm.initialize()
        expect(pm.getActiveProviderId(), '磁盘已有合法激活项时不再被任何 env 设置覆盖').toBe('qwen')
      },
    )
  })

  it('D. 磁盘 active=""（首次运行）+ .env 有 LMSTUDIO_BASE_URL + 磁盘预置 deepseek → 走 cloudOrder → deepseek（首次迁移路径保留）', async () => {
    fs.writeFileSync(
      path.join(dir, 'lumina-providers.json'),
      JSON.stringify({ activeProviderId: '', providers: { deepseek: { baseUrl: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-chat', enabled: true, timeout: 600, maxContextTokens: 131072 } } }, null, 2),
      'utf-8',
    )
    await withEnv(
      { LMSTUDIO_BASE_URL: 'http://127.0.0.1:1234/v1', LMSTUDIO_API_KEY: 'sk-lm', LUMINA_DEFAULT_PROVIDER: undefined },
      async () => {
        const pm = new ProviderManager(dir)
        await pm.initialize()
        expect(pm.getActiveProviderId(), '首次运行迁移路径仍要工作').toBe('deepseek')
      },
    )
  })

  it('E. 磁盘没有文件 + .env 只有 LMSTUDIO_BASE_URL（无任何 cloud provider） → 走 localOrder → lmstudio', async () => {
    expect(fs.existsSync(path.join(dir, 'lumina-providers.json'))).toBe(false)
    await withEnv(
      { LMSTUDIO_BASE_URL: 'http://127.0.0.1:1234/v1', LMSTUDIO_API_KEY: 'sk-lm', LUMINA_DEFAULT_PROVIDER: undefined },
      async () => {
        const pm = new ProviderManager(dir)
        await pm.initialize()
        expect(pm.getActiveProviderId()).toBe('lmstudio')
        // 迁移也会写一份文件
        expect(fs.existsSync(path.join(dir, 'lumina-providers.json'))).toBe(true)
      },
    )
  })

  it('E2. 磁盘没有文件 + .env 有 DEEPSEEK_BASE_URL → 走 cloudOrder → deepseek（首次迁移到云端）', async () => {
    expect(fs.existsSync(path.join(dir, 'lumina-providers.json'))).toBe(false)
    await withEnv(
      { DEEPSEEK_BASE_URL: 'https://api.deepseek.com/v1', DEEPSEEK_API_KEY: 'sk-d', LMSTUDIO_BASE_URL: undefined, LUMINA_DEFAULT_PROVIDER: undefined },
      async () => {
        const pm = new ProviderManager(dir)
        await pm.initialize()
        expect(pm.getActiveProviderId()).toBe('deepseek')
      },
    )
  })

  it('F. 保存 openai → 切到 lmstudio → 重启（.env 有 LMSTUDIO_BASE_URL）→ 仍是 lmstudio', async () => {
    await withEnv(
      { LMSTUDIO_BASE_URL: 'http://127.0.0.1:1234/v1', LMSTUDIO_API_KEY: 'sk-lm', LUMINA_DEFAULT_PROVIDER: undefined },
      async () => {
        const pm = new ProviderManager(dir)
        await pm.initialize()
        pm.setProviderConfig('openai', { baseUrl: 'https://api.openai.com/v1', apiKey: 'k-o', model: 'gpt-4o', enabled: true })
        pm.setActiveProvider('openai')
        pm.setProviderConfig('lmstudio', { baseUrl: 'http://192.168.1.2:1234/v1', apiKey: 'k-l', model: 'qwen2.5:7b', enabled: true })
        pm.setActiveProvider('lmstudio')

        const pm2 = new ProviderManager(dir)
        await pm2.initialize()
        expect(pm2.getActiveProviderId(), '最后一次 setActiveProvider 的选择必须在重启后存活').toBe('lmstudio')
      },
    )
  })
})