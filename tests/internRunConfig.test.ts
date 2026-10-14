// ============================================================
// tests/internRunConfig.test.ts — 缺口1: intern 路由到 buildRunConfig 不崩
//   ① intern ID 能解析出 owner
//   ② LLM 配置来自 owner（不崩、拿得到 model/endpoint）
//   ③ 工具边界继承 owner：recha intern 只读 / yak intern 可写可跑
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest'
import * as path from 'path'
import * as os from 'os'
import { initAgentConfig } from '../electron/agentConfig'

function freshManager() {
  // 传 configPath → 不触发 electron.app / userData 探测
  const cfgPath = path.join(os.tmpdir(), `agent-cfg-test-${Date.now()}-${Math.random()}.json`)
  const mgr = initAgentConfig(cfgPath)
  // 给三个 owner 塞可识别的 LLM 凭证
  const c = mgr as any
  c._configs.yak = { enabled: true, provider: 'deepseek', model: 'YAK-SENTINEL', endpoint: 'http://yak.local/v1', apiKey: 'yak-key' }
  c._configs.recha = { enabled: true, provider: 'zhipu', model: 'RECHA-SENTINEL', endpoint: 'http://recha.local/v1', apiKey: 'recha-key' }
  c._configs.lumina = { enabled: true, provider: 'siliconflow', model: 'LUMINA-SENTINEL', endpoint: 'http://lumina.local/v1', apiKey: 'lumina-key' }
  return mgr
}

describe('缺口1: intern 路由到 buildRunConfig 不崩', () => {
  beforeEach(() => { /* 每次新建独立 manager */ })

  it('intern_yak_* 不崩，且 LLM 配置来自 yak owner', () => {
    const mgr = freshManager()
    const cfg = mgr.buildRunConfig('intern_yak_小陈' as any, undefined, { personaId: 'intern_yak_小陈' })
    expect(cfg.model).toBe('YAK-SENTINEL')
    expect(cfg.baseUrl).toBe('http://yak.local/v1')
    expect(cfg.apiKey).toBe('yak-key')
    expect(cfg.isChildAgent).toBe(true)   // intern = worker
    expect(cfg.personaId).toBe('intern_yak_小陈')
  })

  it('intern_recha_* LLM 配置来自 recha owner', () => {
    const mgr = freshManager()
    const cfg = mgr.buildRunConfig('intern_recha_小李' as any, undefined, { personaId: 'intern_recha_小李' })
    expect(cfg.model).toBe('RECHA-SENTINEL')
    expect(cfg.baseUrl).toBe('http://recha.local/v1')
    expect(cfg.isChildAgent).toBe(true)
  })

  it('intern_lumina_* LLM 配置来自 lumina owner', () => {
    const mgr = freshManager()
    const cfg = mgr.buildRunConfig('intern_lumina_小王' as any, undefined, { personaId: 'intern_lumina_小王' })
    expect(cfg.model).toBe('LUMINA-SENTINEL')
    expect(cfg.isChildAgent).toBe(true)
  })

  it('recha intern 的模板 whitelist 默认留空（真实边界由 rolePolicy 硬隔离：recha 只读）', () => {
    const mgr = freshManager()
    const profile = (mgr as any)._buildDefaultProfile('intern_recha_小李')
    expect(profile.role).toBe('worker')
    // P2-9: 模板白名单不再写装饰性条目 —— 默认不生效（enforceWhitelist 未开），
    // 真实权限边界由 rolePolicy.ts 硬隔离（recha 只读：禁 file_write/shell_exec/git_commit）决定；
    // 如需进一步收窄，在 agent.json 配 tools.whitelist 并显式设 tools.enforceWhitelist=true。
    expect(profile.tools.whitelist).toEqual([])
  })

  it('yak intern 的模板 whitelist 默认留空（真实边界由 rolePolicy 硬隔离：yak 可写可跑）', () => {
    const mgr = freshManager()
    const profile = (mgr as any)._buildDefaultProfile('intern_yak_小陈')
    expect(profile.role).toBe('worker')
    // P2-9: 同上 —— 白名单默认留空，真实边界在 rolePolicy（yak 放行 file_write/shell_exec/git_commit）。
    expect(profile.tools.whitelist).toEqual([])
  })

  it('普通 owner ID 行为不受影响（回归）', () => {
    const mgr = freshManager()
    const cfg = mgr.buildRunConfig('yak' as any)
    expect(cfg.model).toBe('YAK-SENTINEL')
    expect(cfg.mode).toBe('agent')
  })
})
