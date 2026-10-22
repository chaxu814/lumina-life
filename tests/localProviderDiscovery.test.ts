// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/localProviderDiscovery.test.ts — 本地模型探测的纯逻辑
// ============================================================

import { describe, it, expect } from 'vitest'
import { extractModels, pickRecommendedModel, LOCAL_CANDIDATES } from '../electron/core/localProviderDiscovery'

describe('extractModels', () => {
  it('Ollama /api/tags 响应解析', () => {
    const data = { models: [{ name: 'qwen2.5:7b' }, { name: 'llama3.1:8b' }, { model: 'glm4:9b' }] }
    expect(extractModels('ollama', data)).toEqual(['qwen2.5:7b', 'llama3.1:8b', 'glm4:9b'])
  })

  it('OpenAI /v1/models 响应解析', () => {
    const data = { data: [{ id: 'gpt-4o' }, { id: 'qwen2.5-7b' }] }
    expect(extractModels('openai', data)).toEqual(['gpt-4o', 'qwen2.5-7b'])
  })

  it('畸形响应返回空数组（不抛异常）', () => {
    expect(extractModels('ollama', null)).toEqual([])
    expect(extractModels('openai', {})).toEqual([])
    expect(extractModels('ollama', { models: 'x' as any })).toEqual([])
  })
})

describe('pickRecommendedModel 中文友好优先', () => {
  const kws = ['qwen', 'glm', 'deepseek', 'llama']
  it('优先选中文模型（qwen/glm）', () => {
    expect(pickRecommendedModel(['llama3.1:8b', 'qwen2.5:7b'], kws)).toBe('qwen2.5:7b')
  })
  it('无偏好命中时取第一个', () => {
    expect(pickRecommendedModel(['foo', 'bar'], kws)).toBe('foo')
  })
  it('空列表返回空串', () => {
    expect(pickRecommendedModel([], kws)).toBe('')
  })
})

describe('LOCAL_CANDIDATES 候选表', () => {
  it('包含 Ollama 与 LM Studio 端点', () => {
    const ids = LOCAL_CANDIDATES.map(c => c.id)
    expect(ids).toContain('ollama')
    expect(ids).toContain('lm-studio')
  })
})
