// ============================================================
// abGroupDesign.test.ts — 情绪门控分组的设计纪律
//
// 【这个文件钉住的是什么】
// 一条容易被绕过去的假严谨：**单机单用户 App 里不存在 A/B 对照实验。**
// 分组是对持久化 userId 的稳定哈希，一个安装里 treatment / control
// 永远只有一个非空。把两列并排画出来，用户就会读成「有对照组」，
// 而他其实看到的是同一个人前后两个时间段的对比 —— 中间混着他自己生活里
// 发生的一切变化，任何统计手段都扣不掉（缺的不是样本，是「同时两组」）。
//
// 所以这里钉三件事：
//   ① 默认稳定：退出/重进/开关实验都不许偷偷换组；
//   ② 换组只能由用户显式发起，且必须留时间戳（否则事后无法把快照切回正确的臂）；
//   ③ 措辞由数据判定：只有一臂数据时，任何地方都不许叫它「A/B 对照」。
// ============================================================

import { describe, it, expect } from 'vitest'
import { AbGroup, fnv1aHash, type AbGroupState } from '../electron/moodstats/abGroup'
import {
  buildReport,
  compareGroups,
  comparisonDesign,
  honestyNote,
  MIN_SAMPLE,
  type GroupComparison,
} from '../electron/moodstats/stats'
import type { MoodSnapshot } from '../electron/moodstats/types'

// ═══════════════════════════════════════════════════════════
// 测试脚手架
// ═══════════════════════════════════════════════════════════

/** 内存持久化：可以反复重建实例，模拟「重启后读回同一份状态」 */
function memPersistence(initial: Partial<AbGroupState> | null = null) {
  let store: Partial<AbGroupState> | null = initial
  return {
    get: () => store,
    read: () => store,
    write: (s: AbGroupState) => { store = s },
  }
}

function makeSnapshot(group: MoodSnapshot['group'], ts: number, ok = true): MoodSnapshot {
  return {
    ts,
    kind: 'tool',
    agentId: 'lumina',
    targetAgent: null,
    action: 'file_read',
    mood: 0,
    energy: 0.5,
    affinity: 0.5,
    gateOn: group !== 'control',
    gateSuppressed: [],
    gateRules: [],
    group,
    ok,
    errorSummary: ok ? null : 'boom',
    retries: 0,
    durationMs: 100,
  }
}

function rows(group: MoodSnapshot['group'], n: number): GroupComparison[] {
  return compareGroups(Array.from({ length: n }, (_, i) => makeSnapshot(group, i)))
}

// ═══════════════════════════════════════════════════════════
// ① 默认稳定：绝不自动换组
// ═══════════════════════════════════════════════════════════

describe('abGroup · 默认稳定分配（单机无法真正随机化）', () => {
  it('同一 userId 在不同实例里永远落在同一组', () => {
    // 换两次 random 实现、两次实例化，分组必须一致
    const a = new AbGroup({ initial: { userId: 'u_fixed' } })
    const b = new AbGroup({ initial: { userId: 'u_fixed' }, random: () => 0.999 })
    expect(b.snapshot().group).toBe(a.snapshot().group)
  })

  it('optOut → rejoin 往返不换组（否则前后两段数据互相污染）', () => {
    const ab = new AbGroup({ initial: { userId: 'u_fixed', enabled: true } })
    const before = ab.snapshot().group
    ab.optOut()
    ab.rejoin()
    expect(ab.snapshot().group).toBe(before)
    expect(ab.assignmentCount()).toBe(0)
  })

  it('开启/关闭实验不换组', () => {
    const ab = new AbGroup({ initial: { userId: 'u_fixed' } })
    const before = ab.snapshot().group
    ab.enableExperiment()
    expect(ab.snapshot().group).toBe(before)
    ab.disableExperiment()
    expect(ab.snapshot().group).toBe(before)
    expect(ab.assignmentCount()).toBe(0)
  })

  it('重启（重建实例）后分组与历史都从持久化读回', () => {
    const p = memPersistence()
    const first = new AbGroup({ persistence: p, initial: { userId: 'u_fixed', enabled: true } })
    const before = first.snapshot().group
    const second = new AbGroup({ persistence: p })
    expect(second.snapshot().group).toBe(before)
    expect(second.snapshot().userId).toBe('u_fixed')
  })

  it('默认关闭：没显式开启时不干预、不打标', () => {
    const ab = new AbGroup({ initial: { userId: 'u_fixed' } })
    expect(ab.isRunning()).toBe(false)
    expect(ab.currentGroup()).toBe('off')
  })
})

// ═══════════════════════════════════════════════════════════
// ② 换组必须显式、必须留时间戳
// ═══════════════════════════════════════════════════════════

describe('abGroup · rerandomize（用户显式换组）', () => {
  it('未开启实验时拒绝换组（否则写出一条没人看得懂的 history）', () => {
    const ab = new AbGroup({ initial: { userId: 'u_fixed' } })
    expect(ab.canRandomize()).toBe(false)
    expect(ab.rerandomize()).toBeNull()
    expect(ab.assignmentCount()).toBe(0)
  })

  it('已退出实验时拒绝换组（此时 currentGroup 恒为 off，换了也没有意义）', () => {
    const ab = new AbGroup({ initial: { userId: 'u_fixed', enabled: true } })
    ab.optOut()
    expect(ab.canRandomize()).toBe(false)
    expect(ab.rerandomize()).toBeNull()
  })

  it('开启后可以换到另一个臂，且留下带时间戳的历史', () => {
    const ab = new AbGroup({
      initial: { userId: 'u_fixed', enabled: true, group: 'treatment' },
      random: () => 0.9, // 0.9 → control
      now: () => 1_700_000_000_000,
    })
    expect(ab.rerandomize()).toBe('control')
    expect(ab.currentGroup()).toBe('control')
    expect(ab.assignmentCount()).toBe(1)
    expect(ab.currentAssignment()).toEqual({ group: 'control', since: 1_700_000_000_000 })
    expect(ab.snapshot().history.map(h => h.group)).toEqual(['treatment', 'control'])
  })

  it('换组不碰 enabled / optedOut / userId', () => {
    const ab = new AbGroup({
      initial: { userId: 'u_fixed', enabled: true, group: 'treatment' },
      random: () => 0.9,
    })
    ab.rerandomize()
    const s = ab.snapshot()
    expect(s.enabled).toBe(true)
    expect(s.optedOut).toBe(false)
    expect(s.userId).toBe('u_fixed')
  })

  it('抽到同一个臂时不追加历史（否则 history 会假装换过组）', () => {
    const ab = new AbGroup({
      initial: { userId: 'u_fixed', enabled: true, group: 'control' },
      random: () => 0.9, // 还是 control
    })
    expect(ab.rerandomize()).toBe('control')
    expect(ab.assignmentCount()).toBe(0)
    expect(ab.snapshot().history).toHaveLength(1)
  })

  it('hasSeenBothArms 只有两个臂都出现过才为真', () => {
    const ab = new AbGroup({
      initial: { userId: 'u_fixed', enabled: true, group: 'treatment' },
      random: () => 0.9,
    })
    expect(ab.hasSeenBothArms()).toBe(false)
    ab.rerandomize()
    expect(ab.hasSeenBothArms()).toBe(true)
  })

  it('老持久化文件（无 history）补一条起点未知的记录，而不是假装知道起点', () => {
    const p = memPersistence({ enabled: true, userId: 'u_legacy', group: 'control' })
    const ab = new AbGroup({ persistence: p })
    expect(ab.snapshot().history).toEqual([{ group: 'control', since: 0 }])
    expect(ab.currentAssignment()).toEqual({ group: 'control', since: 0 })
  })

  it('hash 仍然是稳定的（换组不依赖哈希）', () => {
    expect(fnv1aHash('u_fixed')).toBe(fnv1aHash('u_fixed'))
  })
})

// ═══════════════════════════════════════════════════════════
// ③ 措辞：只有一臂数据时绝不叫「A/B 对照」
// ═══════════════════════════════════════════════════════════

describe('stats · 对照形态由数据判定，不得自称 A/B', () => {
  it('空数据 → none', () => {
    const d = comparisonDesign([])
    expect(d.kind).toBe('none')
    expect(d.twoArms).toBe(false)
    expect(d.title).not.toContain('A/B')
  })

  it('只有 off → observation（未开启实验，没有任何对照可言）', () => {
    const d = comparisonDesign(rows('off', 40))
    expect(d.kind).toBe('observation')
    expect(d.twoArms).toBe(false)
    expect(d.disclosure).toContain('只观测')
  })

  it('只有一个臂 → single-arm，标题与免责声明都写明「非对照实验」', () => {
    for (const g of ['treatment', 'control'] as const) {
      const d = comparisonDesign(rows(g, 40))
      expect(d.kind).toBe('single-arm')
      expect(d.twoArms).toBe(false)
      expect(d.title).toContain('前后对比')
      expect(d.title).toContain('非对照实验')
      expect(d.title).not.toContain('A/B')
      expect(d.disclosure).toContain('不是严格对照实验')
    }
  })

  it('两个臂都有 → crossover，并明说仍然被时间混杂', () => {
    const snaps = [
      ...Array.from({ length: 40 }, (_, i) => makeSnapshot('treatment', i)),
      ...Array.from({ length: 40 }, (_, i) => makeSnapshot('control', 1000 + i)),
    ]
    const d = comparisonDesign(compareGroups(snaps))
    expect(d.kind).toBe('crossover')
    expect(d.twoArms).toBe(true)
    expect(d.title).not.toContain('A/B')
    expect(d.disclosure).toContain('依然不是严格对照实验')
  })

  it('任何形态下标题都不得出现「A/B」', () => {
    const shapes: GroupComparison[][] = [
      [],
      rows('off', 5),
      rows('treatment', 5),
      rows('control', 5),
      [...rows('treatment', 5), ...rows('control', 5)],
    ]
    for (const s of shapes) {
      expect(comparisonDesign(s).title).not.toContain('A/B')
    }
  })
})

// ═══════════════════════════════════════════════════════════
// 诚实纪律不许被「修文案」顺手放松
// ═══════════════════════════════════════════════════════════

describe('stats · 诚实纪律保持不变', () => {
  it('分组行同样受 MIN_SAMPLE 约束（样本不足不给成功率）', () => {
    const few = rows('treatment', MIN_SAMPLE - 1)
    expect(few[0].n).toBe(MIN_SAMPLE - 1)
    expect(few[0].successRate).toBeNull()
    expect(few[0].trustworthy).toBe(false)

    const enough = rows('treatment', MIN_SAMPLE)
    expect(enough[0].n).toBe(MIN_SAMPLE)
    expect(enough[0].successRate).not.toBeNull()
    expect(enough[0].trustworthy).toBe(true)
  })

  it('honestyNote 仍然报出「不构成结论」', () => {
    expect(honestyNote(MIN_SAMPLE - 1)).toContain('不构成结论')
  })

  it('buildReport 带上 groupsDesign（UI 无权自撰标题）', () => {
    const report = buildReport(rows('control', 40))
    expect(report.groupsDesign.kind).toBe('single-arm')
    expect(report.groupsDesign.twoArms).toBe(false)
    expect(report.groupsDesign.title).not.toContain('A/B')
  })
})
