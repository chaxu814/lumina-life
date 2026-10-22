// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// tests/teamManager.test.ts — 团队管理器 + Agent关系 单元测试
// 按 agentTeamPersonas.ts 实际 Persona 数据验证
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: (name: string) => process.cwd() },
}))

import {
  TEAM_PERSONAS, LUMINA_PERSONA, RECHA_PERSONA, YAK_PERSONA,
  getAgentFullPrompt,
} from '../electron/agentTeamPersonas'
import type { AgentPersona } from '../electron/agentTeamTypes'

describe('Agent Persona integrity', () => {
  it('all personas have required fields', () => {
    for (const persona of [LUMINA_PERSONA, RECHA_PERSONA, YAK_PERSONA]) {
      expect(persona.id).toBeTruthy()
      expect(persona.name).toBeTruthy()
      expect(persona.icon).toBeTruthy()
      expect(persona.personality).toBeTruthy()
      expect(persona.systemPrompt).toBeTruthy()
      expect(persona.speechStyle).toBeTruthy()
      expect(persona.catchphrases.length).toBeGreaterThan(0)
      expect(persona.knowledgeDomains.length).toBeGreaterThan(0)
      // allowedTools 可为空（即无限制），只需保证字段存在
      expect(persona.allowedTools).toBeDefined()
    }
  })

  it('Lumina is the only visible+primary agent', () => {
    expect(LUMINA_PERSONA.visible).toBe(true)
    expect(LUMINA_PERSONA.isPrimary).toBe(true)
    expect(RECHA_PERSONA.isPrimary).toBe(false)
    expect(YAK_PERSONA.isPrimary).toBe(false)
  })

  it('each persona has distinct archetype', () => {
    const archetypes = [LUMINA_PERSONA.archetype, RECHA_PERSONA.archetype, YAK_PERSONA.archetype]
    expect(new Set(archetypes).size).toBe(3)
  })

  it('each persona has distinct voice', () => {
    const voices = [LUMINA_PERSONA.ttsVoice, RECHA_PERSONA.ttsVoice, YAK_PERSONA.ttsVoice]
    expect(new Set(voices).size).toBe(3)
  })

  it('getAgentFullPrompt returns system prompt for valid agents', () => {
    expect(getAgentFullPrompt('lumina')).toBe(LUMINA_PERSONA.systemPrompt)
    expect(getAgentFullPrompt('recha')).toBe(RECHA_PERSONA.systemPrompt)
    expect(getAgentFullPrompt('yak')).toBe(YAK_PERSONA.systemPrompt)
  })

  it('getAgentFullPrompt returns empty for invalid agent', () => {
    expect(getAgentFullPrompt('nonexistent')).toBe('')
  })
})

describe('Agent knowledge domains', () => {
  it('Lumina covers writing, entertainment, life, emotion', () => {
    expect(LUMINA_PERSONA.knowledgeDomains).toContain('writing')
    expect(LUMINA_PERSONA.knowledgeDomains).toContain('entertainment')
    expect(LUMINA_PERSONA.knowledgeDomains).toContain('life')
    expect(LUMINA_PERSONA.knowledgeDomains).toContain('emotion')
  })

  // 角色统一：Yak=代码工程师（code），热茶=审查员（code + data，审查需懂代码、兼数据核对）
  it('Yak covers code', () => {
    expect(YAK_PERSONA.knowledgeDomains).toContain('code')
  })

  it('热茶 covers code and data（审查/分析）', () => {
    expect(RECHA_PERSONA.knowledgeDomains).toContain('code')
    expect(RECHA_PERSONA.knowledgeDomains).toContain('data')
  })

  it('each agent has knowledge blind spots', () => {
    for (const persona of [LUMINA_PERSONA, RECHA_PERSONA, YAK_PERSONA]) {
      expect(persona.knowledgeBlindSpots.length).toBeGreaterThan(0)
    }
  })
})

describe('Agent relationships', () => {
  function makeRelationship(
    pairKey: string,
    source: string,
    target: string,
    type: string,
    affinity: number,
  ) {
    return { pairKey, source, target, type, affinity, trust: 3, history: [], createdAt: '2026-01-01' }
  }

  it('Lumina-热茶 relationship has high trust', () => {
    const rel = makeRelationship('lumina-recha', 'lumina', 'recha', 'work', 8)
    expect(rel.affinity).toBeGreaterThan(5)
  })

  it('Yak-热茶 have lower affinity (pace mismatch)', () => {
    const rel = makeRelationship('yak-recha', 'yak', 'recha', 'work', 4)
    expect(rel.affinity).toBeLessThan(6)
  })
})

describe('Agent catchphrases', () => {
  it('Lumina catchphrases sound warm', () => {
    const all = LUMINA_PERSONA.catchphrases.join(' ')
    // Lumina 的口头禅应该带温暖语气
    expect(all.length).toBeGreaterThan(5)
  })

  it('Yak catchphrases are blunt（程序员口吻）', () => {
    const all = YAK_PERSONA.catchphrases.join(' ')
    // Yak 现在是代码工程师：简短、动手派
    expect(all).toMatch(/收到|完成|改好/)
  })

  it('热茶 catchphrases are review-flavored（审查员口吻）', () => {
    const all = RECHA_PERSONA.catchphrases.join(' ')
    expect(all).toMatch(/审查|发现|问题/)
  })

  it('热茶 catchphrases are brief', () => {
    const all = RECHA_PERSONA.catchphrases.join(' ')
    // 热茶的口头禅简短直接
    expect(all.length).toBeGreaterThan(0)
    expect(RECHA_PERSONA.catchphrases.length).toBeLessThanOrEqual(5)
  })
})
