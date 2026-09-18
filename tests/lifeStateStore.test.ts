import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs'

const tmp = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => tmp.dir },
}))

import {
  loadLifeState, scheduleLifeStateSave, saveLifeStateNow, resetLifeState,
  applyOfflineGap, __resetLifeStateForTest,
} from '../electron/pet/lifeStateStore'
import { DEFAULT_DRIVES } from '../electron/pet/life/drives'

beforeAll(() => {
  tmp.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-life-'))
})

describe('lifeStateStore 内驱力/情绪持久化', () => {
  beforeEach(() => {
    try { fs.rmSync(path.join(tmp.dir, 'pet-life-state.json'), { force: true }) } catch {}
    __resetLifeStateForTest()
  })

  it('首次启动返回默认基线', () => {
    const s = loadLifeState()
    expect(s.drives.energy).toBeCloseTo(DEFAULT_DRIVES.energy, 2)
    expect(s.emotion.label).toBe('平静 😐')
  })

  it('写入后再次读取能恢复（重启不回基线）', () => {
    const drives = { ...DEFAULT_DRIVES, social: 0.9, comfort: 0.2 }
    scheduleLifeStateSave(drives, { v: 0.7, a: 0.6, label: '开心 😊' }, 42)
    saveLifeStateNow()
    __resetLifeStateForTest()
    const reloaded = loadLifeState()
    expect(reloaded.drives.social).toBeCloseTo(0.9, 2)
    expect(reloaded.drives.comfort).toBeCloseTo(0.2, 2)
    expect(reloaded.emotion.label).toBe('开心 😊')
    expect(reloaded.interactionCount).toBe(42)
  })

  it('离线冷落一段时间：社交需求与好奇上升（她会想你）', () => {
    const after = applyOfflineGap(DEFAULT_DRIVES, 120, new Date('2026-09-18T14:00:00'))
    expect(after.social).toBeGreaterThan(DEFAULT_DRIVES.social)
    expect(after.curiosity).toBeGreaterThan(DEFAULT_DRIVES.curiosity)
  })

  it('夜间离线按睡眠恢复精力', () => {
    const tired = { ...DEFAULT_DRIVES, energy: 0.1 }
    const after = applyOfflineGap(tired, 120, new Date('2026-09-18T03:00:00'))
    expect(after.energy).toBeGreaterThan(0.5)
  })

  it('离线时长有上限，不会一次性拉满', () => {
    const after = applyOfflineGap(DEFAULT_DRIVES, 999999, new Date('2026-09-18T14:00:00'))
    expect(after.social).toBeLessThanOrEqual(1)
    expect(after.energy).toBeGreaterThanOrEqual(0)
  })

  it('reset 恢复出厂', () => {
    scheduleLifeStateSave({ ...DEFAULT_DRIVES, social: 0.95 }, { v: 0.9, a: 0.9, label: '兴奋 🤩' })
    saveLifeStateNow()
    const r = resetLifeState()
    expect(r.drives.social).toBeCloseTo(DEFAULT_DRIVES.social, 2)
  })
})
