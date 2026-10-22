// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/moodstats.test.ts — Mood × Productivity 看板核心逻辑测试
//
// 覆盖：
//   · 分桶边界与聚合正确性（确定假数据）
//   · 样本不足时的诚实降权（successRate=null）
//   · A/B 稳定分组 / 退出 / resolveGateFeature 干预面
//   · CSV 转义与 BOM、JSON 结构
//   · 包裹器：原方法调用与返回值不变、抛错原样抛出、采集失败不影响主链路
// ============================================================

import { describe, it, expect } from 'vitest'
import {
  bucketizeMood, bucketizeEnergy, aggregateBuckets, trendByDay, compareGroups,
  buildReport, honestyNote, MIN_SAMPLE, UNKNOWN_BUCKET,
} from '../electron/moodstats/stats'
import { AbGroup, fnv1aHash } from '../electron/moodstats/abGroup'
import { snapshotsToCsv, buildExportJson, escapeCsvCell, UTF8_BOM, SNAPSHOT_CSV_HEADER } from '../electron/moodstats/exporter'
import { MemorySnapshotStore, wrapToolExecutor, wrapAsyncCall } from '../electron/moodstats/snapshotStore'
import type { MoodSnapshot } from '../electron/moodstats/types'

// ═══════════════════════════════════════════════════════════
// 测试工具：造一条确定快照
// ═══════════════════════════════════════════════════════════

function makeSnapshot(overrides: Partial<MoodSnapshot> = {}): MoodSnapshot {
  return {
    ts: 1_700_000_000_000,
    kind: 'tool',
    agentId: 'lumina',
    targetAgent: null,
    action: 'file_read',
    mood: 0.5,
    energy: 0.5,
    affinity: 0.5,
    gateOn: true,
    gateSuppressed: [],
    gateRules: [],
    group: 'off',
    ok: true,
    errorSummary: null,
    retries: 0,
    durationMs: 100,
    ...overrides,
  }
}

// ═══════════════════════════════════════════════════════════
// 1. 分桶
// ═══════════════════════════════════════════════════════════

describe('分桶边界', () => {
  it('mood 五档：边界左闭右开，null/NaN 归未知', () => {
    expect(bucketizeMood(-1)).toBe('低落')
    expect(bucketizeMood(-0.8)).toBe('低落')
    expect(bucketizeMood(-0.6)).toBe('偏低')   // 左闭
    expect(bucketizeMood(-0.59)).toBe('偏低')
    expect(bucketizeMood(-0.2)).toBe('平静')
    expect(bucketizeMood(0.0)).toBe('平静')
    expect(bucketizeMood(0.2)).toBe('愉悦')
    expect(bucketizeMood(0.59)).toBe('愉悦')
    expect(bucketizeMood(0.6)).toBe('高涨')
    expect(bucketizeMood(1)).toBe('高涨')
    expect(bucketizeMood(null)).toBe(UNKNOWN_BUCKET)
    expect(bucketizeMood(NaN)).toBe(UNKNOWN_BUCKET)
  })

  it('energy 三档 + 越界钳制', () => {
    expect(bucketizeEnergy(0.1)).toBe('低能')
    expect(bucketizeEnergy(0.34)).toBe('中等')
    expect(bucketizeEnergy(0.66)).toBe('中等')
    expect(bucketizeEnergy(0.67)).toBe('高能')
    expect(bucketizeEnergy(1)).toBe('高能')
    expect(bucketizeEnergy(5)).toBe('高能')   // 越界钳到右端
    expect(bucketizeEnergy(null)).toBe(UNKNOWN_BUCKET)
  })
})

// ═══════════════════════════════════════════════════════════
// 2. 聚合正确性 + 诚实样本门槛
// ═══════════════════════════════════════════════════════════

describe('分桶聚合', () => {
  it('60 条：45 成功 15 失败 → 成功率 75%，可信', () => {
    const snaps: MoodSnapshot[] = []
    for (let i = 0; i < 60; i++) {
      snaps.push(makeSnapshot({ mood: 0.8, energy: 0.8, ok: i < 45, retries: i < 45 ? 0 : 2, durationMs: 200 }))
    }
    const rows = aggregateBuckets(snaps)
    const row = rows.find(r => r.moodBucket === '高涨' && r.energyBucket === '高能')!
    expect(row).toBeTruthy()
    expect(row.n).toBe(60)
    expect(row.successRate).toBe(75)
    expect(row.trustworthy).toBe(true)
    expect(row.avgRetries).toBeCloseTo(0.5)   // (45*0 + 15*2)/60
    expect(row.avgDurationMs).toBe(200)
  })

  it('样本不足 30：successRate=null、trustworthy=false，但 n 如实显示', () => {
    const snaps: MoodSnapshot[] = []
    for (let i = 0; i < 10; i++) {
      snaps.push(makeSnapshot({ mood: -0.9, energy: 0.1, ok: true }))
    }
    const rows = aggregateBuckets(snaps)
    const row = rows.find(r => r.moodBucket === '低落' && r.energyBucket === '低能')!
    expect(row.n).toBe(10)
    expect(row.successRate).toBeNull()       // 禁止小样本百分比
    expect(row.trustworthy).toBe(false)
    expect(honestyNote(10)).toContain('数据不足')
    expect(honestyNote(60)).toContain('60')
  })

  it('情绪缺失的快照归入「未知」桶且不被丢弃', () => {
    const snaps = [makeSnapshot({ mood: null, energy: null }), makeSnapshot({ mood: null, energy: null, ok: false })]
    const rows = aggregateBuckets(snaps)
    const unknown = rows.find(r => r.moodBucket === UNKNOWN_BUCKET)
    expect(unknown).toBeTruthy()
    expect(unknown!.n).toBe(2)
    expect(unknown!.successRate).toBeNull()
  })

  it('趋势按天分组，样本不足的天 successRate=null', () => {
    const day1 = new Date('2026-10-10T10:00:00Z').getTime()
    const day2 = new Date('2026-10-11T10:00:00Z').getTime()
    const snaps: MoodSnapshot[] = []
    for (let i = 0; i < 35; i++) {snaps.push(makeSnapshot({ ts: day1, ok: i < 28 }))}
    for (let i = 0; i < 5; i++) {snaps.push(makeSnapshot({ ts: day2, ok: false }))}
    const trend = trendByDay(snaps)
    expect(trend).toHaveLength(2)
    expect(trend[0].n).toBe(35)
    expect(trend[0].successRate).toBeCloseTo(80)   // 28/35
    expect(trend[1].n).toBe(5)
    expect(trend[1].successRate).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════
// 3. A/B 分组
// ═══════════════════════════════════════════════════════════

describe('A/B 稳定分组', () => {
  const stubPersistence = (userId: string, sink: Partial<{ enabled: boolean; optedOut: boolean }> = {}) => ({
    read: () => ({ userId, ...sink }),
    write: () => { /* noop */ },
  })

  it('同一 userId 永远同一组（两次实例化结果一致）', () => {
    const p1 = stubPersistence('u_stable_001')
    const a1 = new AbGroup({ persistence: p1 })
    const p2 = stubPersistence('u_stable_001')
    const a2 = new AbGroup({ persistence: p2 })
    expect(a1.snapshot().group).toBe(a2.snapshot().group)
  })

  it('未开启实验时 currentGroup=off，不干预门控', () => {
    const ab = new AbGroup({ persistence: stubPersistence('u_x') })
    expect(ab.currentGroup()).toBe('off')
    expect(ab.isRunning()).toBe(false)
    expect(ab.resolveGateFeature(true)).toBe(true)    // 透传
    expect(ab.resolveGateFeature(false)).toBe(false)
  })

  it('对照组：开启实验后门控被关掉；实验组原样透传', () => {
    // 找一个 hash 为奇数（control）与偶数（treatment）的 userId
    let controlId = 'u_c0'
    let treatmentId = 'u_t0'
    for (let i = 0; i < 1000; i++) {
      const id = `u_${i.toString(16)}`
      if (fnv1aHash(id) % 2 === 1) {controlId = id; break}
    }
    for (let i = 0; i < 1000; i++) {
      const id = `u_t${i.toString(16)}`
      if (fnv1aHash(id) % 2 === 0) {treatmentId = id; break}
    }

    const control = new AbGroup({ persistence: stubPersistence(controlId) })
    control.enableExperiment()
    expect(control.isControl()).toBe(true)
    expect(control.resolveGateFeature(true)).toBe(false)   // 干预：关闭门控
    expect(control.currentGroup()).toBe('control')

    const treatment = new AbGroup({ persistence: stubPersistence(treatmentId) })
    treatment.enableExperiment()
    expect(treatment.isControl()).toBe(false)
    expect(treatment.resolveGateFeature(true)).toBe(true)  // 透传
    expect(treatment.currentGroup()).toBe('treatment')
  })

  it('optOut 停止干预且不重洗分组', () => {
    const ab = new AbGroup({ persistence: stubPersistence('u_x') })
    ab.enableExperiment()
    const before = ab.snapshot().group
    ab.optOut()
    expect(ab.currentGroup()).toBe('off')
    expect(ab.isRunning()).toBe(false)
    expect(ab.resolveGateFeature(true)).toBe(true)         // 退出后门控恢复
    expect(ab.snapshot().group).toBe(before)              // 分组保留
  })
})

// ═══════════════════════════════════════════════════════════
// 4. 导出：CSV 转义/BOM、JSON 结构
// ═══════════════════════════════════════════════════════════

describe('导出', () => {
  it('CSV 以 BOM 开头、表头齐全', () => {
    const csv = snapshotsToCsv([makeSnapshot()])
    expect(csv.startsWith(UTF8_BOM)).toBe(true)
    expect(csv.slice(1)).toContain(SNAPSHOT_CSV_HEADER.join(','))
  })

  it('RFC4180 转义：逗号/引号/换行', () => {
    expect(escapeCsvCell('a,b')).toBe('"a,b"')
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""')
    expect(escapeCsvCell('line1\nline2')).toBe('"line1\nline2"')
    expect(escapeCsvCell(null)).toBe('')
    expect(escapeCsvCell(3.5)).toBe('3.5')
  })

  it('错误摘要含引号逗号时转义后仍可解析', () => {
    const csv = snapshotsToCsv([makeSnapshot({ errorSummary: 'fail, "boom"\nretry' })])
    // 手工按行/逗号粗验：转义后的引号翻倍
    expect(csv).toContain('""boom""')
  })

  it('JSON 导出可回读，含 report 与 snapshots', () => {
    const snaps = [makeSnapshot(), makeSnapshot({ ok: false, action: 'shell_exec' })]
    const json = buildExportJson(snaps, buildReport(snaps))
    const parsed = JSON.parse(json)
    expect(parsed.kind).toBe('moodstats-export')
    expect(parsed.snapshots).toHaveLength(2)
    expect(parsed.report.totalSnapshots).toBe(2)
    expect(parsed.report.honesty.minSample).toBe(MIN_SAMPLE)
  })
})

// ═══════════════════════════════════════════════════════════
// 5. 包裹器：采集失败绝不影响原调用
// ═══════════════════════════════════════════════════════════

describe('安全包裹器', () => {
  const ctx = {
    emotion: () => ({ mood: 0.3, energy: 0.6, affinity: 0.5 }),
    gate: () => ({ on: true, suppressed: [], rules: [] }),
    group: () => 'off' as const,
  }

  it('原方法被原样调用、返回值不变，同时记下快照', async () => {
    const store = new MemorySnapshotStore()
    let calledWith: any[] = []
    const original = async (name: string, args: Record<string, any>) => {
      calledWith = [name, args]
      return { callId: 'c1', ok: true, content: 'result', durationMs: 42 }
    }
    const wrapped = wrapToolExecutor(original, ctx, store, 'lumina')
    const res = await wrapped('file_read', { path: '/x' })

    expect(calledWith).toEqual(['file_read', { path: '/x' }])   // 参数原样
    expect(res).toEqual({ callId: 'c1', ok: true, content: 'result', durationMs: 42 })
    expect(store.count()).toBe(1)
    const snap = store.recent(1)[0]
    expect(snap.action).toBe('file_read')
    expect(snap.ok).toBe(true)
    expect(snap.durationMs).toBe(42)
    expect(snap.mood).toBe(0.3)                               // 情绪来自 ctx，非编造
    expect(snap.kind).toBe('tool')
  })

  it('原方法抛错时：异常原样抛出，但快照照记失败', async () => {
    const store = new MemorySnapshotStore()
    const original = async () => {throw new Error('network down')}
    const wrapped = wrapToolExecutor(original, ctx, store, 'lumina')
    await expect(wrapped('web_search', { q: 'x' })).rejects.toThrow('network down')
    expect(store.count()).toBe(1)
    const snap = store.recent(1)[0]
    expect(snap.ok).toBe(false)
    expect(snap.errorSummary).toContain('network down')
  })

  it('存储写入抛错时：原调用完全不受影响', async () => {
    const broken = new MemorySnapshotStore()
    broken.insert = () => { throw new Error('disk full') }
    const original = async () => ({ ok: true, content: 'still ok', durationMs: 1 })
    const wrapped = wrapToolExecutor(original, ctx, broken, 'lumina')
    const res = await wrapped('datetime', {})
    expect(res).toEqual({ ok: true, content: 'still ok', durationMs: 1 })
  })

  it('委托包裹：extractResult 正确映射 ok/error/retries', async () => {
    const store = new MemorySnapshotStore()
    const original = async (task: string) => ({ success: true, summary: `done: ${task}`, retries: 1 })
    const wrapped = wrapAsyncCall(original, ctx, store, {
      agentId: 'lumina',
      targetAgent: 'yak',
      action: 'delegate',
      extractResult: (r: any) => ({ ok: !!r?.success, errorSummary: r?.success ? null : 'failed', retries: r?.retries ?? 0 }),
    })
    const res = await wrapped('fix bug')
    expect(res.success).toBe(true)
    expect(store.count()).toBe(1)
    const snap = store.recent(1)[0]
    expect(snap.kind).toBe('delegate')
    expect(snap.targetAgent).toBe('yak')
    expect(snap.ok).toBe(true)
    expect(snap.retries).toBe(1)
  })
})
