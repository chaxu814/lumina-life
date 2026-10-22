// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// tests/agentRelationships.test.ts — Agent 动态关系演化单测
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs'

// 把 userData 指向临时目录，避免在仓库根写脏文件
const tmp = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => tmp.dir },
}))

import { getRelationshipStore } from '../electron/agentRelationships'

beforeAll(() => {
  tmp.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-rel-'))
})

describe('agentRelationships 动态关系', () => {
  beforeEach(() => {
    getRelationshipStore().reset()
  })

  it('首次启动以三对出厂关系播种，并按 pairKey 排序', () => {
    const all = getRelationshipStore().getAll()
    const keys = all.map(r => r.pairKey)
    expect(keys).toContain('lumina-recha')
    expect(keys).toContain('lumina-yak')
    expect(keys).toContain('recha-yak')
    expect(keys).toEqual([...keys].sort())
  })

  it('委托成功：协作数+1、信任/亲密度上升', () => {
    const store = getRelationshipStore()
    const before = { ...store.getAll().find(r => r.pairKey === 'lumina-yak')! }
    store.recordInteraction('lumina', 'yak', 'delegation_ok', 'code_write')
    const after = store.getAll().find(r => r.pairKey === 'lumina-yak')!
    expect(after.collaborationCount).toBe(before.collaborationCount + 1)
    expect(after.trust).toBeGreaterThanOrEqual(before.trust)
    expect(after.affinity).toBeGreaterThan(before.affinity)
    expect(after.lastInteraction).toBeTruthy()
  })

  it('委托失败：信任下降', () => {
    const store = getRelationshipStore()
    const beforeTrust = store.getAll().find(r => r.pairKey === 'lumina-yak')!.trust
    store.recordInteraction('lumina', 'yak', 'delegation_fail')
    const after = store.getAll().find(r => r.pairKey === 'lumina-yak')!
    expect(after.trust).toBeLessThan(beforeTrust)
  })

  it('群聊：亲密度小幅上升但不刷协作数', () => {
    const store = getRelationshipStore()
    const before = { ...store.getAll().find(r => r.pairKey === 'recha-yak')! }
    store.recordInteraction('recha', 'yak', 'chat')
    const after = store.getAll().find(r => r.pairKey === 'recha-yak')!
    expect(after.affinity).toBeGreaterThanOrEqual(before.affinity)
    expect(after.collaborationCount).toBe(before.collaborationCount)
  })

  it('建设性分歧（反方论证/风险评估）：争执数+1', () => {
    const store = getRelationshipStore()
    const beforeArgs = store.getAll().find(r => r.pairKey === 'recha-yak')!.argumentCount
    store.recordInteraction('recha', 'yak', 'delegation_ok', 'counter_argument')
    const after = store.getAll().find(r => r.pairKey === 'recha-yak')!
    expect(after.argumentCount).toBe(beforeArgs + 1)
  })

  it('pairKey 顺序无关：yak-lumina 与 lumina-yak 是同一条', () => {
    const store = getRelationshipStore()
    const beforeCol = store.getAll().find(r => r.pairKey === 'lumina-yak')!.collaborationCount
    store.recordInteraction('yak', 'lumina', 'delegation_ok')
    store.recordInteraction('lumina', 'yak', 'delegation_ok')
    const after = store.getAll().find(r => r.pairKey === 'lumina-yak')!
    expect(after.collaborationCount).toBe(beforeCol + 2)
  })

  it('动态成员（如实习生）之间从中性基线 50 起', () => {
    const store = getRelationshipStore()
    store.recordInteraction('intern_1', 'intern_2', 'chat')
    const rel = store.getAll().find(r => r.pairKey === 'intern_1-intern_2')!
    expect(rel).toBeTruthy()
    expect(rel.affinity).toBeGreaterThanOrEqual(50)
    expect(rel.trust).toBe(50)
  })

  it('忽略自互动与非法输入', () => {
    const store = getRelationshipStore()
    const count = store.getAll().length
    store.recordInteraction('lumina', 'lumina', 'chat')
    store.recordInteraction('', 'yak', 'chat')
    expect(store.getAll().length).toBe(count)
  })

  it('数值始终钳制在 0~100，演化日志有上限', () => {
    const store = getRelationshipStore()
    for (let i = 0; i < 200; i++) {
      store.recordInteraction('lumina', 'recha', 'delegation_ok')
    }
    const rel = store.getAll().find(r => r.pairKey === 'lumina-recha')!
    expect(rel.affinity).toBeLessThanOrEqual(100)
    expect(rel.trust).toBeLessThanOrEqual(100)
    expect(rel.evolutionLog.length).toBeLessThanOrEqual(40)
  })
})
