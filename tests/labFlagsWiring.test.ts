// =============================================================
// tests/labFlagsWiring.test.ts — 实验功能「开关读写闭环」针对性测试
//
// 验证：
//  1. 六个实验 flag 在 featureFlags 里登记且默认全关
//  2. dayreplay IPC 门控读 featureFlags：关→disabledReply；开→放行（尝试真实服务）
//  3. moodstats 总开关：apply(true) 立即重建采集；apply(false) 立即撤销
//  4. A/B 干预未运行时 resolveGateFeature 原样透传（默认行为不变）
// =============================================================
import { describe, it, expect, afterEach } from 'vitest'
import { allFlags, isEnabled, setFlag } from '../electron/core/featureFlags'
import { registerDayReplayIpc, type IpcBus } from '../electron/dayreplay/ipc'
import {
  configureMoodStatsCollection,
  applyMoodStatsMaster,
  moodStatsMasterEnabled,
} from '../electron/moodstats/masterSwitch'
import { AbGroup } from '../electron/moodstats/abGroup'

const EXPERIMENT_KEYS = [
  'dayreplay.enabled',
  'moodstats.enabled',
  'rituals.nightReview',
  'rituals.morningBriefing',
  'decision.enabled',
  'handover.enabled',
] as const

describe('实验功能 · flag 登记与默认值', () => {
  it('六个 key 都在 allFlags() 里且默认 false', () => {
    const all = allFlags() as Record<string, boolean>
    for (const k of EXPERIMENT_KEYS) {
      expect(all, `${k} 未登记进 FeatureKey/DEFAULTS`).toHaveProperty(k)
      expect(all[k], `${k} 默认应为关`).toBe(false)
      expect(isEnabled(k as any), `${k} isEnabled 默认应为 false`).toBe(false)
    }
  })
})

describe('dayreplay IPC 门控读写闭环', () => {
  const handlers = new Map<string, (...args: any[]) => unknown>()
  const fakeBus: IpcBus = {
    handle: (channel: string, handler: (...args: any[]) => unknown) => {
      handlers.set(channel, handler)
    },
  }

  afterEach(() => { setFlag('dayreplay.enabled', false) })

  it('flag 关 → today 频道返回 disabledReply（不是白屏/不是数据）', () => {
    registerDayReplayIpc(fakeBus)
    expect(handlers.has('dayreplay:today')).toBe(true)
    setFlag('dayreplay.enabled', false)
    const r = handlers.get('dayreplay:today')!() as any
    expect(r.ok).toBe(false)
    expect(String(r.error)).toContain('未开启')
  })

  it('flag 开 → 不再返回 disabledReply（进入真实服务路径）', () => {
    registerDayReplayIpc(fakeBus)
    setFlag('dayreplay.enabled', true)
    const r = handlers.get('dayreplay:today')!() as any
    // 不要求成功（默认 adapters 在测试环境可能降级），只要求不再被门控拦下
    expect(String(r.error ?? '')).not.toContain('未开启')
  })
})

describe('moodstats 总开关 · 立即撤销/重建', () => {
  afterEach(() => { applyMoodStatsMaster(false) })

  it('apply(true) → flag 开 + 立即调用采集重建器', () => {
    let rebuilt = 0
    configureMoodStatsCollection(() => {rebuilt += 1})
    applyMoodStatsMaster(true)
    expect(moodStatsMasterEnabled()).toBe(true)
    expect(rebuilt).toBeGreaterThanOrEqual(1)
  })

  it('apply(false) → flag 关 + 不触发重建', () => {
    let rebuilt = 0
    configureMoodStatsCollection(() => {rebuilt += 1})
    applyMoodStatsMaster(true)
    expect(rebuilt).toBe(1)
    const before = rebuilt
    applyMoodStatsMaster(false)
    expect(moodStatsMasterEnabled()).toBe(false)
    expect(rebuilt).toBe(before) // 关的动作本身不重建
  })
})

describe('A/B 干预 · 默认未运行时原样透传', () => {
  it('实验未开启：resolveGateFeature 恒等返回（与 readFeatureFlag 等价）', () => {
    const ab = new AbGroup()
    expect(ab.resolveGateFeature(true)).toBe(true)
    expect(ab.resolveGateFeature(false)).toBe(false)
  })

  it('即便分到 control 组但实验未开，也原样透传', () => {
    const ab = new AbGroup({ initial: { enabled: false, group: 'control' } })
    expect(ab.resolveGateFeature(true)).toBe(true)
  })
})
