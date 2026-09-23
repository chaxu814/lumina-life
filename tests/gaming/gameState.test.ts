// ============================================================
// tests/gaming/gameState.test.ts — VLM 输出解析为结构化 GameState
// ============================================================

import { describe, it, expect } from 'vitest'
import { parseVlmGameState, formatGameState, GAME_VLM_SYSTEM_PROMPT } from '../../electron/gaming/gameState'

describe('parseVlmGameState', () => {
  it('解析完整合法 JSON', () => {
    const raw = JSON.stringify({
      detected: true,
      window_title: 'Minecraft 1.20.4',
      health: 18,
      max_health: 20,
      food: 16,
      xp_level: 7,
      yaw: -45.5,
      pitch: 10,
      position: { x: 12.5, y: 64, z: -300 },
      gamemode: 'survival',
      hotbar: [
        { slot: 1, name: 'diamond_sword', count: 1 },
        { slot: 2, name: 'cobblestone', count: 64 },
      ],
      near_entities: ['zombie', 'cow'],
      summary: '玩家在平原生存',
    })
    const s = parseVlmGameState(raw)
    expect(s.detected).toBe(true)
    expect(s.health).toBe(18)
    expect(s.food).toBe(16)
    expect(s.yaw).toBe(-45.5)
    expect(s.position?.x).toBe(12.5)
    expect(s.hotbar).toHaveLength(2)
    expect(s.hotbar[0].name).toBe('diamond_sword')
    expect(s.nearEntities).toEqual(['zombie', 'cow'])
  })

  it('容忍 markdown 代码块包裹', () => {
    const raw = '```json\n{"detected": true, "health": 10}\n```'
    const s = parseVlmGameState(raw)
    expect(s.detected).toBe(true)
    expect(s.health).toBe(10)
  })

  it('解析失败返回 detected:false', () => {
    const s = parseVlmGameState('这不是JSON')
    expect(s.detected).toBe(false)
    expect(s.hotbar).toEqual([])
  })

  it('空输入返回 detected:false', () => {
    expect(parseVlmGameState('').detected).toBe(false)
  })

  it('数值越界钳制', () => {
    const raw = JSON.stringify({ detected: true, health: 99, food: -5, pitch: 200, yaw: 500 })
    const s = parseVlmGameState(raw)
    expect(s.health).toBe(20)
    expect(s.food).toBe(0)
    expect(s.pitch).toBe(90)
    expect(s.yaw).toBe(180)
  })

  it('hotbar 按槽位排序', () => {
    const raw = JSON.stringify({
      detected: true,
      hotbar: [
        { slot: 9, name: 'apple' },
        { slot: 1, name: 'sword' },
      ],
    })
    const s = parseVlmGameState(raw)
    expect(s.hotbar[0].slot).toBe(1)
    expect(s.hotbar[1].slot).toBe(9)
  })

  it('detected:false 时不抛错', () => {
    const s = parseVlmGameState(JSON.stringify({ detected: false }))
    expect(s.detected).toBe(false)
  })
})

describe('formatGameState', () => {
  it('未识别时给出提示', () => {
    const txt = formatGameState({ detected: false, hotbar: [] })
    expect(txt).toContain('未识别')
  })

  it('识别后渲染关键字段', () => {
    const txt = formatGameState({
      detected: true,
      health: 18,
      maxHealth: 20,
      food: 16,
      hotbar: [{ slot: 1, name: 'sword', count: 1 }],
    })
    expect(txt).toContain('Minecraft')
    expect(txt).toContain('18/20')
    expect(txt).toContain('sword')
  })
})

describe('GAME_VLM_SYSTEM_PROMPT', () => {
  it('提示词包含关键字段要求', () => {
    expect(GAME_VLM_SYSTEM_PROMPT).toContain('health')
    expect(GAME_VLM_SYSTEM_PROMPT).toContain('hotbar')
    expect(GAME_VLM_SYSTEM_PROMPT).toContain('JSON')
  })
})
