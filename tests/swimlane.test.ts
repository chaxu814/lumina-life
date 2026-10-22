// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/swimlane.test.ts — 依赖泳道画布 / Worktree 并行进度 单测
//
// 重点保护三条最容易回归的语义：
//   1. 并行分支的墙钟是 max 不是 sum
//   2. 依赖成环时关键路径不能栈溢出、不能死循环
//   3. 序列化输出必须稳定（用户会把它贴进 README，不能每次导出都不一样）
// ============================================================

import { describe, it, expect } from 'vitest'
import {
  buildSwimlane,
  computeCriticalPath,
  detectBottleneck,
  findCyclicNodeIds,
  serializeSwimlane,
  swimlaneFromBoard,
  swimlaneFromTrace,
  formatDuration,
  formatPercent,
  laneForRole,
  LANE_ORDER,
} from '../electron/team/swimlane'
import type { SwimlaneModel, SwimlaneNode, RawNodeInput } from '../electron/team/swimlane'
// 直接盯画布的几何计算：贝塞尔路由、子行装箱、刻度边界这些错了不会报错，
// 只会「看着有点怪」，没测试就永远发现不了
import { layoutOf } from '../src/panels/SwimlaneCanvas'

// 固定基准时间：所有断言只关心相对关系，不关心「现在几点」
const T0 = 1_700_000_000_000

/** 直接构造已归一化的节点，绕过 buildSwimlane，专测算法本身 */
const node = (o: Partial<SwimlaneNode> & { id: string }): SwimlaneNode => {
  const startAt = o.startAt ?? T0
  const endAt = o.endAt ?? startAt + 1000
  return {
    id: o.id,
    label: o.label ?? o.id,
    lane: o.lane ?? 'lumina',
    kind: o.kind ?? 'other',
    status: o.status ?? 'done',
    startAt,
    endAt,
    dependsOn: o.dependsOn ?? [],
    ...(o.detail ? { detail: o.detail } : {}),
    progress: o.progress ?? 1,
    durationMs: Math.max(0, endAt - startAt),
  }
}

/** [id, 耗时ms] → 串行节点，依赖自动串成链 */
const chain = (ids: string[], durs: number[], lane: SwimlaneNode['lane'] = 'lumina'): SwimlaneNode[] => {
  let t = T0
  return ids.map((id, i) => {
    const n = node({
      id,
      lane,
      startAt: t,
      endAt: t + durs[i],
      dependsOn: i === 0 ? [] : [ids[i - 1]],
    })
    t += durs[i]
    return n
  })
}

// ═══════════════════════════════════════════════════════════
// buildSwimlane：边界与归一化
// ═══════════════════════════════════════════════════════════

describe('buildSwimlane 边界兜底', () => {
  it('空输入返回空图而不是抛错', () => {
    const m = buildSwimlane()
    expect(m.nodes).toEqual([])
    expect(m.lanes).toEqual([])
    expect(m.criticalPath).toEqual([])
    expect(m.wallClockMs).toBe(0)
    expect(Number.isFinite(m.generatedAt)).toBe(true)
  })

  it('显式空数组与 now 兜底', () => {
    const m = buildSwimlane({ nodes: [], now: T0 })
    expect(m.nodes).toHaveLength(0)
    expect(m.generatedAt).toBe(T0)
  })

  it('缺 startAt/endAt 时贴到 now，耗时为 0', () => {
    const m = buildSwimlane({ nodes: [{ id: 'a' }], now: T0 + 5000 })
    expect(m.nodes[0].startAt).toBe(T0 + 5000)
    expect(m.nodes[0].endAt).toBe(T0 + 5000)
    expect(m.nodes[0].durationMs).toBe(0)
  })

  it('只有 endAt 时 startAt 贴到 endAt，历史节点不会漂到当下', () => {
    const m = buildSwimlane({ nodes: [{ id: 'a', endAt: T0 + 100 }], now: T0 + 9999 })
    expect(m.nodes[0].startAt).toBe(T0 + 100)
    expect(m.nodes[0].durationMs).toBe(0)
  })

  it('负数耗时夹到 0，不产生负的墙钟', () => {
    const m = buildSwimlane({
      now: T0,
      nodes: [{ id: 'a', startAt: T0 + 500, endAt: T0 }],
    })
    expect(m.nodes[0].durationMs).toBe(0)
    expect(m.wallClockMs).toBe(0)
  })

  it('未知 lane/kind/status 兜底到可渲染的默认值', () => {
    const m = buildSwimlane({
      now: T0,
      nodes: [{ id: 'a', lane: '外星人', kind: '外星活', status: '外星状态' }],
    })
    expect(m.nodes[0].lane).toBe('dynamic')
    expect(m.nodes[0].kind).toBe('other')
    expect(m.nodes[0].status).toBe('pending')
    expect(m.lanes).toEqual(['dynamic'])
  })

  it('泳道顺序固定按 LANE_ORDER，不受输入顺序影响', () => {
    const m = buildSwimlane({
      now: T0,
      nodes: [
        { id: 'a', lane: 'worktree' },
        { id: 'b', lane: 'lumina' },
        { id: 'c', lane: 'dynamic' },
      ],
    })
    expect(m.lanes).toEqual(['lumina', 'dynamic', 'worktree'])
    expect(LANE_ORDER.indexOf('dynamic')).toBeGreaterThan(LANE_ORDER.indexOf('lumina'))
  })

  it('id 重复只保留先出现的一条，节点顺序即画布顺序', () => {
    const m = buildSwimlane({
      now: T0,
      nodes: [
        { id: 'a', label: '先来的' },
        { id: 'a', label: '后来的' },
        { id: 'b' },
      ],
    })
    expect(m.nodes.map(n => n.id)).toEqual(['a', 'b'])
    expect(m.nodes[0].label).toBe('先来的')
  })

  it('没有 id 的条目被丢弃，不会污染画布', () => {
    const m = buildSwimlane({ now: T0, nodes: [{ id: '' }, { id: 'ok' } as RawNodeInput] })
    expect(m.nodes.map(n => n.id)).toEqual(['ok'])
  })

  it('progress 夹到 0~1，缺失时按状态给终值', () => {
    const m = buildSwimlane({
      now: T0,
      nodes: [
        { id: 'p1', progress: 1.7 },
        { id: 'p2', progress: -3 },
        { id: 'd', status: 'done' },
        { id: 'f', status: 'failed' },
        { id: 'r', status: 'running' },
        { id: 'q', status: 'pending' },
      ],
    })
    const by = new Map(m.nodes.map(n => [n.id, n.progress]))
    expect(by.get('p1')).toBe(1)
    expect(by.get('p2')).toBe(0)
    expect(by.get('d')).toBe(1)
    expect(by.get('f')).toBe(1)
    // 运行中不编造百分比：画布用脉冲动画表达，静态百分比会骗人
    expect(by.get('r')).toBe(0)
    expect(by.get('q')).toBe(0)
  })

  it('dependsOn / blockedBy 都接受，重复与自依赖去重但不自删', () => {
    const m = buildSwimlane({
      now: T0,
      nodes: [{ id: 'a', blockedBy: ['b', 'b', 'a'] }, { id: 'b' }],
    })
    const a = m.nodes.find(n => n.id === 'a')!
    expect(a.dependsOn).toEqual(['b', 'a'])
  })

  it('detail 传字符串时降级为 note，空对象不产出 detail', () => {
    const m = buildSwimlane({
      now: T0,
      nodes: [
        { id: 'a', detail: '在跑模型' },
        { id: 'b', detail: { model: 'gpt-4o-mini', tool: 'read' } },
        { id: 'c', detail: { model: '  ' } },
      ],
    })
    expect(m.nodes[0].detail?.note).toBe('在跑模型')
    expect(m.nodes[1].detail).toEqual({ model: 'gpt-4o-mini', tool: 'read' })
    expect(m.nodes[2].detail).toBeUndefined()
  })
})

// ═══════════════════════════════════════════════════════════
// 墙钟：并行取 max 不累加（最容易写错的一条）
// ═══════════════════════════════════════════════════════════

describe('墙钟耗时', () => {
  it('并行分支取最大值而非累加', () => {
    const nodes: SwimlaneNode[] = [
      node({ id: 'a', startAt: T0, endAt: T0 + 1000 }),
      node({ id: 'b', startAt: T0 + 500, endAt: T0 + 1500 }),
    ]
    // 两个人各干 1 秒、重叠 0.5 秒 → 全程 1.5 秒，不是 2 秒也不是 2.5 秒
    expect(buildSwimlane({ nodes, now: T0 + 9999 }).wallClockMs).toBe(1500)
  })

  it('完全重叠的两个 1 小时任务，墙钟是 1 小时', () => {
    const H = 3_600_000
    const nodes: SwimlaneNode[] = [
      node({ id: 'a', startAt: T0, endAt: T0 + H }),
      node({ id: 'b', startAt: T0, endAt: T0 + H }),
      node({ id: 'c', startAt: T0, endAt: T0 + H }),
    ]
    expect(buildSwimlane({ nodes, now: T0 + H }).wallClockMs).toBe(H)
  })

  it('串行任务才是累加', () => {
    const m = buildSwimlane({ nodes: chain(['a', 'b'], [1000, 2000]), now: T0 + 9999 })
    expect(m.wallClockMs).toBe(3000)
  })
})

// ═══════════════════════════════════════════════════════════
// 关键路径
// ═══════════════════════════════════════════════════════════

describe('computeCriticalPath', () => {
  it('线性依赖链：路径即链本身', () => {
    const nodes = chain(['a', 'b', 'c'], [100, 200, 50])
    expect(computeCriticalPath(nodes)).toEqual(['a', 'b', 'c'])
  })

  it('单个孤立节点就是自己的关键路径', () => {
    expect(computeCriticalPath([node({ id: 'solo' })])).toEqual(['solo'])
  })

  it('空数组返回空路径', () => {
    expect(computeCriticalPath([])).toEqual([])
  })

  it('分支里挑最长的那支，而不是第一条或最后一条', () => {
    const nodes: SwimlaneNode[] = [
      node({ id: 'a', startAt: T0, endAt: T0 + 100 }),
      node({ id: 'b', startAt: T0 + 100, endAt: T0 + 400, dependsOn: ['a'] }),
      node({ id: 'c', startAt: T0 + 100, endAt: T0 + 200, dependsOn: ['a'] }),
      node({ id: 'd', startAt: T0 + 400, endAt: T0 + 450, dependsOn: ['b', 'c'] }),
    ]
    // a-b-d = 450 > a-c-d = 250
    expect(computeCriticalPath(nodes)).toEqual(['a', 'b', 'd'])
  })

  it('孤立节点与链共存时，链更长则取链', () => {
    const nodes: SwimlaneNode[] = [
      node({ id: 'lonely', startAt: T0, endAt: T0 + 10 }),
      ...chain(['a', 'b'], [500, 500]),
    ]
    expect(computeCriticalPath(nodes)).toEqual(['a', 'b'])
  })

  it('悬空依赖（依赖了图外的任务）不参与路径', () => {
    const nodes = [node({ id: 'a', dependsOn: ['幽灵任务'] })]
    expect(computeCriticalPath(nodes)).toEqual(['a'])
  })

  it('关键路径节点必须首尾相接（结构自洽）', () => {
    const nodes: SwimlaneNode[] = [
      node({ id: 'a', startAt: T0, endAt: T0 + 100 }),
      node({ id: 'b', startAt: T0 + 100, endAt: T0 + 900, dependsOn: ['a'] }),
      node({ id: 'c', startAt: T0 + 900, endAt: T0 + 1000, dependsOn: ['b'] }),
    ]
    const path = computeCriticalPath(nodes)
    const byId = new Map(nodes.map(n => [n.id, n]))
    for (let i = 1; i < path.length; i++) {
      expect(byId.get(path[i])!.dependsOn).toContain(path[i - 1])
    }
  })
})

describe('依赖成环', () => {
  it('两节点互依赖：不栈溢出、不死循环，环外节点仍可解', () => {
    const nodes: SwimlaneNode[] = [
      node({ id: 'a', dependsOn: ['b'], startAt: T0, endAt: T0 + 10 }),
      node({ id: 'b', dependsOn: ['a'], startAt: T0 + 10, endAt: T0 + 20 }),
      node({ id: 'free', startAt: T0 + 20, endAt: T0 + 900 }),
    ]
    let path: string[] = []
    expect(() => { path = computeCriticalPath(nodes) }).not.toThrow()
    // 环上的 a/b 及其下游不可信，只有孤立节点能算出路径
    expect(path).toEqual(['free'])
    expect(findCyclicNodeIds(nodes).sort()).toEqual(['a', 'b'])
  })

  it('自依赖：节点把自己当前置，视为环', () => {
    const nodes: SwimlaneNode[] = [node({ id: 'self', dependsOn: ['self'] })]
    expect(() => computeCriticalPath(nodes)).not.toThrow()
    expect(computeCriticalPath(nodes)).toEqual([])
    expect(findCyclicNodeIds(nodes)).toEqual(['self'])
  })

  it('全图成环时返回空路径而不是抛错', () => {
    const nodes: SwimlaneNode[] = [
      node({ id: 'a', dependsOn: ['c'] }),
      node({ id: 'b', dependsOn: ['a'] }),
      node({ id: 'c', dependsOn: ['b'] }),
    ]
    expect(computeCriticalPath(nodes)).toEqual([])
    expect(findCyclicNodeIds(nodes)).toHaveLength(3)
  })

  it('环的下游节点同样不可信（入度永远降不下来）', () => {
    const nodes: SwimlaneNode[] = [
      node({ id: 'a', dependsOn: ['b'] }),
      node({ id: 'b', dependsOn: ['a'] }),
      node({ id: 'down', dependsOn: ['a'], startAt: T0 + 5000, endAt: T0 + 9000 }),
    ]
    expect(computeCriticalPath(nodes)).toEqual([])
    expect(findCyclicNodeIds(nodes).sort()).toEqual(['a', 'b', 'down'])
  })

  it('buildSwimlane 遇到成环也不抛，criticalPath 降级为空', () => {
    const m = buildSwimlane({
      now: T0,
      nodes: [
        { id: 'a', blockedBy: ['b'] },
        { id: 'b', blockedBy: ['a'] },
      ],
    })
    expect(m.criticalPath).toEqual([])
    expect(m.nodes).toHaveLength(2)
  })

  it('1000 节点的环也瞬间返回（拓扑排序是 O(V+E)，不是递归）', () => {
    const nodes: SwimlaneNode[] = []
    for (let i = 0; i < 1000; i++) {
      // 首尾相接成一个大环
      nodes.push(node({ id: `n${i}`, dependsOn: [`n${(i + 999) % 1000}`] }))
    }
    const t = Date.now()
    const path = computeCriticalPath(nodes)
    expect(Date.now() - t).toBeLessThan(1000)
    expect(path).toEqual([])
    expect(findCyclicNodeIds(nodes)).toHaveLength(1000)
  })
})

// ═══════════════════════════════════════════════════════════
// 瓶颈分析
// ═══════════════════════════════════════════════════════════

describe('detectBottleneck', () => {
  it('最慢泳道按忙碌时间判定（跨度大但在等的不算瓶颈）', () => {
    const m: SwimlaneModel = buildSwimlane({
      now: T0 + 10_000,
      nodes: [
        { id: 'l1', lane: 'lumina', startAt: T0, endAt: T0 + 900 },
        { id: 'l2', lane: 'lumina', startAt: T0 + 900, endAt: T0 + 1800 },
        { id: 'y1', lane: 'yak', startAt: T0, endAt: T0 + 300 },
        { id: 'i1', lane: 'recha', startAt: T0, endAt: T0 + 10 },
        { id: 'i2', lane: 'recha', startAt: T0 + 5000, endAt: T0 + 5010 },
      ],
    })
    const r = detectBottleneck(m)
    expect(r.slowestLane?.lane).toBe('lumina')
    expect(r.slowestLane?.busyMs).toBe(1800)
    // 热茶跨度 5.01 秒但只干了 20ms，空等占比接近 100%
    const recha = r.laneLoads.find(l => l.lane === 'recha')!
    expect(recha.spanMs).toBe(5010)
    expect(recha.busyMs).toBe(20)
    expect(recha.idleMs).toBe(4990)
    expect(recha.waitRatio).toBeGreaterThan(0.9)
  })

  it('并行峰值取同时进行节点数的最大值', () => {
    const m = buildSwimlane({
      now: T0 + 5000,
      nodes: [
        { id: 'a', lane: 'lumina', startAt: T0, endAt: T0 + 1000, status: 'done' },
        { id: 'b', lane: 'yak', startAt: T0 + 500, endAt: T0 + 2000, status: 'done' },
        { id: 'c', lane: 'recha', startAt: T0 + 700, endAt: T0 + 900, status: 'done' },
        { id: 'd', lane: 'dynamic', startAt: T0 + 3000, endAt: T0 + 3500, status: 'done' },
      ],
    })
    const r = detectBottleneck(m)
    expect(r.peakParallel.count).toBe(3)
    expect(r.peakParallel.lanes).toBe(3)
    expect(r.peakParallel.at).toBe(T0 + 700)
  })

  it('首尾相接（end == 下一个 start）不算并行', () => {
    const m = buildSwimlane({
      now: T0 + 5000,
      nodes: [
        { id: 'a', startAt: T0, endAt: T0 + 1000, status: 'done' },
        { id: 'b', startAt: T0 + 1000, endAt: T0 + 2000, status: 'done' },
      ],
    })
    expect(detectBottleneck(m).peakParallel.count).toBe(1)
  })

  it('pending / blocked 不计入并行度（没在干活）', () => {
    const m = buildSwimlane({
      now: T0 + 5000,
      nodes: [
        { id: 'run', startAt: T0, endAt: T0 + 1000, status: 'running' },
        { id: 'wait', startAt: T0, endAt: T0 + 1000, status: 'blocked' },
        { id: 'todo', startAt: T0 + 100, endAt: T0 + 200, status: 'pending' },
      ],
    })
    expect(detectBottleneck(m).peakParallel.count).toBe(1)
  })

  it('串行等待：单节点完成的泳道不算，要多节点之间有明显空档才算', () => {
    const serial = buildSwimlane({
      now: T0 + 10_000,
      nodes: [
        { id: 's1', lane: 'yak', startAt: T0, endAt: T0 + 1000, status: 'done' },
        { id: 's2', lane: 'yak', startAt: T0 + 9000, endAt: T0 + 10_000, status: 'done' },
      ],
    })
    const r = detectBottleneck(serial)
    expect(r.hasSerialWait).toBe(true)
    expect(r.serialWaitRatio).toBeCloseTo(0.8, 5)

    const tight = buildSwimlane({
      now: T0 + 5000,
      nodes: [
        { id: 't1', lane: 'yak', startAt: T0, endAt: T0 + 1000, status: 'done' },
        { id: 't2', lane: 'yak', startAt: T0 + 1000, endAt: T0 + 2000, status: 'done' },
      ],
    })
    expect(detectBottleneck(tight).hasSerialWait).toBe(false)
  })

  it('全程串行时给出「依赖没并行派发」的提示', () => {
    const m = buildSwimlane({
      now: T0 + 3000,
      nodes: [
        { id: 'a', startAt: T0, endAt: T0 + 1000, status: 'done' },
        { id: 'b', startAt: T0 + 1000, endAt: T0 + 2000, status: 'done', dependsOn: ['a'] },
        { id: 'c', startAt: T0 + 2000, endAt: T0 + 3000, status: 'done', dependsOn: ['b'] },
      ],
    })
    expect(detectBottleneck(m).hints.join('\n')).toContain('依赖没有被并行派发')
  })

  it('空图不炸，给出可读提示', () => {
    const r = detectBottleneck(buildSwimlane({ now: T0 }))
    expect(r.laneLoads).toEqual([])
    expect(r.slowestLane).toBeNull()
    expect(r.peakParallel).toEqual({ at: 0, count: 0, lanes: 0 })
    expect(r.hasSerialWait).toBe(false)
    expect(r.hints).toEqual(['暂无任务节点'])
  })
})

// ═══════════════════════════════════════════════════════════
// 序列化
// ═══════════════════════════════════════════════════════════

describe('serializeSwimlane', () => {
  const model = (): SwimlaneModel => buildSwimlane({
    now: T0 + 4000,
    nodes: [
      { id: 't1', label: '拆需求', lane: 'lumina', kind: 'research', status: 'done', startAt: T0, endAt: T0 + 500 },
      {
        id: 't2', label: '写实现', lane: 'dynamic', kind: 'code', status: 'done',
        startAt: T0 + 500, endAt: T0 + 2500, dependsOn: ['t1'],
        detail: { model: 'gpt-4o-mini', worktree: 'K:/repo/.lumina-worktrees/x', output: '3 个文件' },
      },
      {
        id: 't3', label: '对抗评审', lane: 'recha', kind: 'review', status: 'failed',
        startAt: T0 + 2500, endAt: T0 + 4000, dependsOn: ['t2'], detail: '高危一票否决',
      },
    ],
  })

  it('同一输入两次调用输出完全一致（用户会把它贴进 README）', () => {
    const m = model()
    expect(serializeSwimlane(m)).toBe(serializeSwimlane(m))
    // 换一份等价但不同引用顺序构造的图，输出也应一致 —— 稳定性不能依赖对象身份
    expect(serializeSwimlane(model())).toBe(serializeSwimlane(m))
  })

  it('包含泳道负载、关键路径、节点明细', () => {
    const text = serializeSwimlane(model())
    expect(text).toContain('# 团队依赖泳道')
    expect(text).toContain('| 泳道 | 节点 | 忙碌 | 空等 | 空等占比 |')
    expect(text).toContain('`t1`（拆需求） → `t2`（写实现） → `t3`（对抗评审）')
    expect(text).toContain('worktree K:/repo/.lumina-worktrees/x')
    expect(text).toContain('并行任务不累加')
  })

  it('成环时关键路径段落给出降级说明而不是空白', () => {
    const m = buildSwimlane({
      now: T0,
      nodes: [{ id: 'a', blockedBy: ['b'] }, { id: 'b', blockedBy: ['a'] }],
    })
    expect(serializeSwimlane(m)).toContain('（依赖成环或无可解路径）')
  })

  it('空图也能导出，且不崩', () => {
    const text = serializeSwimlane(buildSwimlane({ now: T0 }))
    expect(text).toContain('暂无任务节点')
    expect(text).not.toContain('Invalid Date')
  })

  it('垃圾输入不崩（缺字段 / 空对象）', () => {
    expect(() => serializeSwimlane(undefined as unknown as SwimlaneModel)).not.toThrow()
    expect(() => serializeSwimlane({} as SwimlaneModel)).not.toThrow()
  })
})

// ═══════════════════════════════════════════════════════════
// 接线适配器
// ═══════════════════════════════════════════════════════════

describe('swimlaneFromBoard', () => {
  it('看板任务映射到泳道节点，workdir 单独占一条泳道', () => {
    const m = swimlaneFromBoard([
      { id: 't1', title: '调研', kind: 'research', status: 'done', owner: 'yak_worker', createdAt: T0, completedAt: T0 + 300 },
      {
        id: 't2', title: '编码', kind: 'code', status: 'running', owner: 'temp_1',
        workdir: 'K:/repo/.lumina-worktrees/a', blockedBy: ['t1'], result: 'done',
        createdAt: T0, claimedAt: T0 + 300,
      },
    ], { now: T0 + 600 })

    expect(m.nodes).toHaveLength(2)
    expect(m.lanes).toEqual(['yak', 'worktree'])
    expect(m.nodes[0].status).toBe('done')
    expect(m.nodes[1].dependsOn).toEqual(['t1'])
    expect(m.nodes[1].detail?.worktree).toBe('K:/repo/.lumina-worktrees/a')
    // 未完成任务的 endAt 兜底到 now，画布上才有「进行中」的右边界
    expect(m.nodes[1].endAt).toBe(T0 + 600)
    expect(m.nodes[1].status).toBe('running')
  })

  it('空看板返回空图', () => {
    expect(swimlaneFromBoard([]).nodes).toEqual([])
    expect(swimlaneFromBoard(undefined as unknown as []).nodes).toEqual([])
  })
})

describe('swimlaneFromTrace', () => {
  it('按 workerId@title 配对 start/end', () => {
    const m = swimlaneFromTrace([
      { at: T0, phase: 'start', role: 'recha', workerId: 'w1', title: '挑刺', modelTier: 'strong' },
      { at: T0 + 800, phase: 'end', role: 'recha', workerId: 'w1', title: '挑刺', ok: true },
      { at: T0 + 900, phase: 'start', role: 'research', workerId: 'w2', title: '检索' },
      { at: T0 + 1000, phase: 'end', role: 'research', workerId: 'w2', title: '检索', ok: false, error: '超时' },
      { at: T0 + 1100, phase: 'start', role: 'code', workerId: 'w3', title: '还在跑' },
    ], { now: T0 + 2000 })

    expect(m.nodes).toHaveLength(3)
    const w1 = m.nodes.find(n => n.id.includes('挑刺'))!
    expect(w1.status).toBe('done')
    expect(w1.durationMs).toBe(800)
    expect(w1.detail?.model).toBe('strong')
    const w2 = m.nodes.find(n => n.id.includes('检索'))!
    expect(w2.status).toBe('failed')
    expect(w2.detail?.note).toBe('超时')
    // 没有 end 的条目保持 running，endAt 兜底到 now
    const w3 = m.nodes.find(n => n.id.includes('还在跑'))!
    expect(w3.status).toBe('running')
    expect(w3.endAt).toBe(T0 + 2000)
  })

  it('重复 start 取第一条，孤儿 end 忽略', () => {
    const m = swimlaneFromTrace([
      { at: T0, phase: 'start', workerId: 'w', title: 't' },
      { at: T0 + 5, phase: 'start', workerId: 'w', title: 't' },
      { at: T0, phase: 'end', workerId: 'ghost', title: 'nobody', ok: true },
    ], { now: T0 + 100 })
    expect(m.nodes).toHaveLength(1)
    expect(m.nodes[0].startAt).toBe(T0)
  })

  it('since 之前的条目被过滤', () => {
    const m = swimlaneFromTrace([
      { at: T0, phase: 'start', workerId: 'w', title: 'old' },
      { at: T0 + 5000, phase: 'start', workerId: 'w2', title: 'new' },
    ], { now: T0 + 6000, since: T0 + 1000 })
    expect(m.nodes.map(n => n.id)).toHaveLength(1)
  })
})

describe('laneForRole / 格式化', () => {
  it('角色映射泳道', () => {
    expect(laneForRole('lumina')).toBe('lumina')
    expect(laneForRole('recha_worker_3')).toBe('recha')
    expect(laneForRole('yak')).toBe('yak')
    expect(laneForRole('/repo/.lumina-worktrees/x')).toBe('worktree')
    expect(laneForRole('临时工')).toBe('dynamic')
    expect(laneForRole(undefined)).toBe('dynamic')
  })

  it('耗时格式确定且对负数兜底', () => {
    expect(formatDuration(0)).toBe('0ms')
    expect(formatDuration(-5)).toBe('0ms')
    expect(formatDuration(999)).toBe('999ms')
    expect(formatDuration(1500)).toBe('1.5s')
    expect(formatDuration(65_000)).toBe('1m 05s')
    expect(formatDuration(3_720_000)).toBe('1h 02m')
  })

  it('百分比夹到 0~100', () => {
    expect(formatPercent(0.345)).toBe('35%')
    expect(formatPercent(1.9)).toBe('100%')
    expect(formatPercent(Number.NaN)).toBe('0%')
  })
})

// ═══════════════════════════════════════════════════════════
// 性能
// ═══════════════════════════════════════════════════════════

describe('性能：1000 节点不退化', () => {
  const bigGraph = (n: number): SwimlaneNode[] => {
    const lanes: SwimlaneNode['lane'][] = ['lumina', 'yak', 'recha', 'dynamic', 'worktree']
    const out: SwimlaneNode[] = []
    for (let i = 0; i < n; i++) {
      out.push(node({
        id: `n${i}`,
        lane: lanes[i % lanes.length],
        kind: i % 7 === 0 ? 'review' : 'code',
        startAt: T0 + (i % 97) * 10,
        endAt: T0 + (i % 97) * 10 + 200 + (i % 13) * 7,
        // 每 5 个挂一个前驱，形成宽而不深的图
        dependsOn: i >= 5 ? [`n${i - 5}`] : [],
      }))
    }
    return out
  }

  it('1000 节点线性链：关键路径完整且耗时可控', () => {
    const nodes: SwimlaneNode[] = []
    for (let i = 0; i < 1000; i++) {
      nodes.push(node({
        id: `c${i}`,
        startAt: T0 + i * 100,
        endAt: T0 + (i + 1) * 100,
        dependsOn: i === 0 ? [] : [`c${i - 1}`],
      }))
    }
    const t = Date.now()
    const path = computeCriticalPath(nodes)
    const cost = Date.now() - t
    // 长度等于节点数：证明是 O(V+E) 的拓扑序 DP，而不是被指数级剪枝或提前截断
    expect(path).toHaveLength(1000)
    expect(path[0]).toBe('c0')
    expect(path[999]).toBe('c999')
    expect(cost).toBeLessThan(2000)
  })

  it('1000 节点宽图：buildSwimlane 全流程 < 3s', () => {
    const nodes = bigGraph(1000)
    const t = Date.now()
    const m = buildSwimlane({ nodes, now: T0 + 100_000 })
    const report = detectBottleneck(m)
    const cost = Date.now() - t
    expect(m.nodes).toHaveLength(1000)
    expect(m.lanes).toHaveLength(5)
    expect(report.laneLoads).toHaveLength(5)
    expect(m.criticalPath.length).toBeGreaterThan(0)
    expect(m.criticalPath.length).toBeLessThanOrEqual(1000)
    expect(cost).toBeLessThan(3000)
  })

  it('1000 节点混合乱序 + 环：不崩、不慢', () => {
    const nodes = bigGraph(1000)
    // 制造一个 500 节点的环：依赖指到环尾，形成首尾闭环
    for (let i = 500; i < 1000; i++) {
      nodes[i] = { ...nodes[i], dependsOn: [...nodes[i].dependsOn, `n${i === 999 ? 500 : i + 1}`] }
    }
    const t = Date.now()
    const m = buildSwimlane({ nodes, now: T0 + 100_000 })
    const cost = Date.now() - t
    expect(m.nodes).toHaveLength(1000)
    expect(cost).toBeLessThan(3000)
    // 环上的节点不能出现在关键路径里
    const onPath = new Set(m.criticalPath)
    expect(onPath.has('n999')).toBe(false)
    expect(onPath.has('n500')).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════
// 画布几何（布局/贝塞尔箭头）
// ═══════════════════════════════════════════════════════════

describe('SwimlaneCanvas 布局几何', () => {
  const modelOf = (): SwimlaneModel => buildSwimlane({
    now: T0 + 4000,
    nodes: [
      { id: 'a', label: 'A', lane: 'lumina', startAt: T0, endAt: T0 + 1000, status: 'done' },
      { id: 'b', label: 'B', lane: 'lumina', startAt: T0 + 1000, endAt: T0 + 2000, status: 'done', dependsOn: ['a'] },
      { id: 'c', label: 'C', lane: 'yak', startAt: T0, endAt: T0 + 2000, status: 'done' },
    ],
  })

  it('每个节点都有落位，且不超出画布宽度', () => {
    const l = layoutOf(modelOf())
    expect(l.byId.size).toBe(3)
    for (const p of l.byId.values()) {
      expect(p.x).toBeGreaterThanOrEqual(0)
      expect(p.w).toBeGreaterThan(0)
      expect(p.x + p.w).toBeLessThanOrEqual(l.width)
      expect(p.y).toBeGreaterThanOrEqual(0)
      expect(p.y + p.h).toBeLessThanOrEqual(l.height)
    }
  })

  /** 从 path 串里抽出坐标数字，便于断言控制点相对起终点的高低 */
  const nums = (d: string): number[] => (d.match(/-?\d+(?:\.\d+)?/g) || []).map(Number)

  it('依赖关系画成贝塞尔曲线（M + 单个三次 C）', () => {
    const l = layoutOf(modelOf())
    expect(l.edges).toHaveLength(1)
    const e = l.edges[0]
    expect(e.key).toBe('a->b')
    expect(e.d.startsWith('M ')).toBe(true)
    expect(e.d).toContain(' C ')
    // M 给 2 个数，每个 C 给 6 个：正向直连就是一段水平切线三次曲线
    const v = nums(e.d)
    expect(v).toHaveLength(8)
    const [mx, my, c1x, c1y, c2x, c2y, tx, ty] = v
    expect(c1y).toBeCloseTo(my, 1)
    expect(c2y).toBeCloseTo(ty, 1)
    expect(c1x).toBeGreaterThan(mx)
    expect(c2x).toBeLessThan(tx)
    expect(tx).toBeGreaterThan(mx)
  })

  it('后继比前驱早结束时改走「下-横-上」回折曲线', () => {
    const m = buildSwimlane({
      now: T0 + 2000,
      nodes: [
        { id: 'long', startAt: T0, endAt: T0 + 2000, status: 'running' },
        { id: 'short', startAt: T0 + 100, endAt: T0 + 200, status: 'done', dependsOn: ['long'] },
      ],
    })
    const l = layoutOf(m)
    expect(l.edges).toHaveLength(1)
    const [mx, my, c1x, c1y, c2x, c2y, tx, ty] = nums(l.edges[0].d)
    // 控制点一沉到源节点之下、控制点二升到目标节点之上 —— 这是回折的形状特征
    expect(c1y).toBeGreaterThan(my)
    expect(c2y).toBeLessThan(ty)
    // 且它确实是从源底边绕到目标顶边，不是水平直连
    expect(my).toBeGreaterThan(ty)
    expect(mx).not.toBeCloseTo(tx, 1)
  })

  it('同泳道内时间重叠的节点被摊到不同子行，不会压成一坨', () => {
    const m = buildSwimlane({
      now: T0 + 1000,
      nodes: [
        { id: 'x', lane: 'lumina', startAt: T0, endAt: T0 + 1000, status: 'running' },
        { id: 'y', lane: 'lumina', startAt: T0 + 100, endAt: T0 + 900, status: 'running' },
      ],
    })
    const l = layoutOf(m)
    const px = l.byId.get('x')!
    const py = l.byId.get('y')!
    expect(px.y).not.toBe(py.y)
    // 同一子行内不能垂直重叠
    const lane = l.lanes[0]
    expect(lane.nodes).toHaveLength(2)
  })

  it('悬空依赖不出边（画布上不会指向空气）', () => {
    const m = buildSwimlane({
      now: T0,
      nodes: [{ id: 'only', dependsOn: ['幽灵'], startAt: T0, endAt: T0 + 100, status: 'done' }],
    })
    expect(layoutOf(m).edges).toHaveLength(0)
  })

  it('关键路径节点被标出来，且边也标成关键', () => {
    const l = layoutOf(modelOf())
    expect(l.byId.get('a')!.onPath).toBe(true)
    expect(l.byId.get('b')!.onPath).toBe(true)
    expect(l.byId.get('c')!.onPath).toBe(false)
    expect(l.edges[0].critical).toBe(true)
  })

  it('刻度落在画布内，且标签数量合理', () => {
    const l = layoutOf(modelOf())
    expect(l.ticks.length).toBeGreaterThan(0)
    expect(l.ticks.length).toBeLessThanOrEqual(8)
    for (const t of l.ticks) {
      expect(t.x).toBeGreaterThan(0)
      expect(t.x).toBeLessThanOrEqual(l.width)
      expect(t.label.startsWith('+')).toBe(true)
    }
  })

  it('空图也不炸（宽度/高度为正，没有 NaN）', () => {
    const l = layoutOf(buildSwimlane({ now: T0 }))
    expect(Number.isFinite(l.width)).toBe(true)
    expect(l.width).toBeGreaterThan(0)
    expect(l.height).toBeGreaterThan(0)
    expect(l.edges).toEqual([])
    expect(l.ticks).toEqual([])
  })

  it('全部节点同一时刻完成（span=0）时也给出有限坐标', () => {
    const m = buildSwimlane({
      now: T0,
      nodes: [
        { id: 'p', startAt: T0, endAt: T0, status: 'done' },
        { id: 'q', startAt: T0, endAt: T0, status: 'done', dependsOn: ['p'] },
      ],
    })
    const l = layoutOf(m)
    for (const p of l.byId.values()) {
      expect(Number.isFinite(p.x)).toBe(true)
      expect(Number.isFinite(p.y)).toBe(true)
      expect(p.w).toBeGreaterThan(0)
    }
  })

  it('泳道数为 0（lanes 被清空）时回退到节点实际所在泳道', () => {
    const m = buildSwimlane({
      now: T0,
      nodes: [{ id: 'z', lane: 'recha', startAt: T0, endAt: T0 + 10, status: 'done' }],
    })
    const stripped: SwimlaneModel = { ...m, lanes: [] }
    expect(layoutOf(stripped).lanes.map(l => l.lane)).toEqual(['recha'])
  })
})

// 防呆：确认 helper 本身自洽，免得断言的是 helper 的 bug
describe('测试自身前置校验', () => {
  it('chain() 生成的节点耗时与端点一致', () => {
    const nodes = chain(['a', 'b'], [100, 200])
    expect(nodes[0].durationMs).toBe(100)
    expect(nodes[1].durationMs).toBe(200)
    expect(nodes[1].dependsOn).toEqual(['a'])
    expect(nodes[1].startAt - nodes[0].endAt).toBe(0)
  })
})
