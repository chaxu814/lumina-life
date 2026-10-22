// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/llmReachability.test.ts — 运行时 LLM 可达性预检单测
// ============================================================

import { describe, it, expect } from 'vitest'
import {
  modelsProbeUrl,
  classifyFetchError,
  probeEndpoint,
  buildUnreachableGuidance,
} from '../electron/onboarding/llmReachability'

describe('modelsProbeUrl', () => {
  it('普通端点追加 /models', () => {
    expect(modelsProbeUrl('http://127.0.0.1:1234/v1')).toBe('http://127.0.0.1:1234/v1/models')
  })
  it('去掉尾部斜杠后追加', () => {
    expect(modelsProbeUrl('http://127.0.0.1:1234/v1/')).toBe('http://127.0.0.1:1234/v1/models')
  })
  it('已含 /models 不重复', () => {
    expect(modelsProbeUrl('http://x/v1/models')).toBe('http://x/v1/models')
  })
})

describe('classifyFetchError', () => {
  it('AbortError → timeout', () => {
    expect(classifyFetchError({ name: 'AbortError' })).toBe('timeout')
  })
  it('ECONNREFUSED → refused', () => {
    expect(classifyFetchError({ message: 'fetch failed', cause: { code: 'ECONNREFUSED' } })).toBe('refused')
  })
  it('fetch failed → refused', () => {
    expect(classifyFetchError({ message: 'TypeError: fetch failed' })).toBe('refused')
  })
  it('401 → auth', () => {
    expect(classifyFetchError({ message: '401 Unauthorized' })).toBe('auth')
  })
  it('无法识别 → unknown', () => {
    expect(classifyFetchError({ message: 'something else' })).toBe('unknown')
  })
})

describe('probeEndpoint', () => {
  it('无效地址 → 不可达', async () => {
    const r = await probeEndpoint('not-a-url', undefined, 100)
    expect(r.reachable).toBe(false)
    expect(r.errorKind).toBe('unknown')
  })

  it('200 → 可达', async () => {
    const r = await probeEndpoint('http://127.0.0.1:1234/v1', undefined, 100, async () => 200)
    expect(r.reachable).toBe(true)
    expect(r.status).toBe(200)
  })

  it('404 → 视为可达（服务在监听）', async () => {
    const r = await probeEndpoint('http://127.0.0.1:1234/v1', undefined, 100, async () => 404)
    expect(r.reachable).toBe(true)
  })

  it('401 → 不可达 auth', async () => {
    const r = await probeEndpoint('http://127.0.0.1:1234/v1', undefined, 100, async () => 401)
    expect(r.reachable).toBe(false)
    expect(r.errorKind).toBe('auth')
  })

  it('连接拒绝 → 不可达 refused', async () => {
    const r = await probeEndpoint(
      'http://127.0.0.1:1234/v1', undefined, 100,
      async () => { throw { message: 'fetch failed', cause: { code: 'ECONNREFUSED' } } },
    )
    expect(r.reachable).toBe(false)
    expect(r.errorKind).toBe('refused')
  })
})

describe('buildUnreachableGuidance', () => {
  it('本地拒绝 → 给出启动本地模型 + 云端两条路径', () => {
    const g = buildUnreachableGuidance('http://127.0.0.1:1234/v1', 'refused')
    expect(g).toContain('启动本地模型')
    expect(g).toContain('云端')
  })
  it('鉴权失败 → 引导修 Key', () => {
    const g = buildUnreachableGuidance('http://127.0.0.1:1234/v1', 'auth')
    expect(g).toContain('鉴权')
  })
  it('非本地端点 → 包含地址与网络提示', () => {
    const g = buildUnreachableGuidance('https://api.example.com/v1', 'refused')
    expect(g).toContain('api.example.com')
  })
})
