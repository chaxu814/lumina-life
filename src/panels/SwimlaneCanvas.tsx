// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// SwimlaneCanvas.tsx — 团队可观测性 · 依赖泳道画布
//
// 【这个模块要解决什么】
// agentRunner.ts 有 3,239 行，内部编排复杂到「只有作者自己看得懂」。
// 用户想知道「Yak 到底在干什么、卡在哪、还要多久」时，只能等一句最终回复。
//
// 参考业界常见的「Agent 依赖泳道画布」设计，但 Lumina 的差异是：
// **泳道上跑的不只是 agent，还有 git worktree 隔离与对抗评审的投票过程**。
// 也就是说，这条画布同时是「进度条」和「审计轨迹」——
// 出了问题可以回看是哪一步、哪个模型、哪棵工作树出的问题。
//
// 【为什么 layoutOf 是纯函数、导出去、还放在 UI 文件里】
// 1. 纯函数：可单测。泳道图最容易写错的不是画得好看，是「重叠节点压成一坨」
//    和「回折边画到空气里」这两件事，它们必须有回归测试兜住。
// 2. 放在本文件：布局与渲染是同一套坐标计算的两种消费方式，分开放必然漂移
//    （本项目在 XML 工具调用上已经吃过一次「提示词说 A、解析器只认 B」的亏）。
// ============================================================

import React, { useEffect, useMemo, useState } from 'react'
import {
  LANE_LABELS,
  laneLabel,
  formatDuration,
  type LaneKind,
  type NodeStatus,
  type SwimlaneModel,
} from '../../electron/team/swimlane'

// ═══════════════════════════════════════════════════════════
// 布局几何（纯函数 · 可单测）
// ═══════════════════════════════════════════════════════════

/** 画布内边距 */
const PAD_LEFT = 76
const PAD_RIGHT = 16
const PAD_TOP = 12
const PAD_BOTTOM = 20
/** 泳道高度 */
const LANE_H = 64
/** 同泳道内子行高度（小于 LANE_H，行间留缝） */
const SUB_H = 26
/** 节点最小宽度：极短任务（如 10ms）也要看得见 */
const MIN_W = 8
/** 节点宽度占时间跨度的比例。留出 15% 是为了「相邻不接壤」 */
const W_RATIO = 0.85
/** 刻度数量上限（测试要求 ≤ 8；再多会挤成一团） */
const MAX_TICKS = 5

export interface LayoutNode {
  id: string
  label: string
  status: NodeStatus
  /** 是否在关键路径上 */
  onPath: boolean
  x: number
  y: number
  w: number
  h: number
  /** 原始节点，画详情用 */
  source: SwimlaneModel['nodes'][number]
}

export interface LayoutLane {
  lane: LaneKind
  label: string
  icon: string
  y: number
  h: number
  nodes: LayoutNode[]
}

export interface LayoutEdge {
  /** 形如 `a->b` */
  key: string
  /** SVG path 串（`M … C …`） */
  d: string
  critical: boolean
  from: string
  to: string
}

export interface LayoutTick {
  x: number
  label: string
}

export interface SwimlaneLayout {
  byId: Map<string, LayoutNode>
  lanes: LayoutLane[]
  edges: LayoutEdge[]
  ticks: LayoutTick[]
  width: number
  height: number
}

const STATUS_COLOR: Record<NodeStatus, string> = {
  pending: 'var(--border-heavy, #94a3b8)',
  running: '#3b82f6',
  blocked: 'var(--yellow-500, #eab308)',
  done: 'var(--green-500, #22c55e)',
  failed: 'var(--red-500, #ef4444)',
}

/** 四舍五入到 1 位小数：避免 path 里出现 12.000000000000002 这类数字，污染测试的数字提取 */
function r1(n: number): number {
  return Math.round(n * 10) / 10
}

/**
 * 计算整张泳道图的布局。
 *
 * 【子行为什么自下而上分配】
 * 这是被依赖边的形状逼出来的，不是随手选的：
 * 后继任务比前驱先结束（回折边）时，视觉上必须「从源节点下方绕出、走到目标上方进入」。
 * 若子行自上而下排，最早开始的任务永远在最上，回折边就得从上方节点绕到下方节点，
 * 那不是「下-横-上」，而是「上-横-下」——两种都能画，但前者才符合人读流水线的直觉：
 * **基线是主流程，分叉往上长。**
 */
export function layoutOf(model: SwimlaneModel): SwimlaneLayout {
  const byId = new Map<string, LayoutNode>()
  const nodes = Array.isArray(model?.nodes) ? model.nodes.filter(n => n && typeof n.id === 'string') : []
  const critical = new Set(Array.isArray(model?.criticalPath) ? model.criticalPath : [])

  // ── 1. 时间轴范围 ──
  // span=0（所有节点同一时刻完成）时给一个人造窗口，
  // 否则除零会让全部坐标变 NaN —— NaN 坐标在 SVG 里不报错，只是整张图空白。
  let t0 = Number.POSITIVE_INFINITY
  let t1 = Number.NEGATIVE_INFINITY
  for (const n of nodes) {
    const s = Number.isFinite(n.startAt) ? n.startAt : 0
    const e = Number.isFinite(n.endAt) ? Math.max(n.endAt, s) : s
    if (s < t0) {t0 = s}
    if (e > t1) {t1 = e}
  }
  if (!nodes.length) {t0 = 0; t1 = 0}
  const rawSpan = t1 - t0
  const span = rawSpan > 0 ? rawSpan : 1

  // ── 2. 泳道列表（lanes 被清空时回退到节点实际所在泳道）──
  let lanes: LaneKind[] = Array.isArray(model?.lanes) && model.lanes.length > 0
    ? model.lanes.filter(l => LANE_LABELS[l])
    : []
  if (lanes.length === 0) {
    const seen = new Set<LaneKind>()
    for (const n of nodes) {
      if (n.lane && !seen.has(n.lane)) {seen.add(n.lane)}
    }
    lanes = Array.from(seen)
  }
  if (lanes.length === 0) {lanes = ['lumina']}

  // ── 3. 画布尺寸（空图也要有正值，UI 不能塌成 0 高度）──
  const plotW = 600
  const width = PAD_LEFT + plotW + PAD_RIGHT
  const height = PAD_TOP + lanes.length * LANE_H + PAD_BOTTOM

  const xOf = (t: number): number => PAD_LEFT + ((t - t0) / span) * plotW

  // ── 4. 逐泳道做子行分配（贪心区间着色，O(n log n)）──
  const layoutLanes: LayoutLane[] = []
  for (let li = 0; li < lanes.length; li++) {
    const lane = lanes[li]
    const laneTop = PAD_TOP + li * LANE_H
    const laneNodes = nodes.filter(n => n.lane === lane)
    // 起点早的排前面；同起点按结束早的排前面，短任务先占低行、主流程保持基线
    const sorted = [...laneNodes].sort((a, b) => (a.startAt - b.startAt) || (a.endAt - b.endAt))

    // rowEnds[r] = 该子行当前已排到的最右时间
    const rowEnds: number[] = []
    const rowOf = new Map<string, number>()
    for (const n of sorted) {
      const s = Number.isFinite(n.startAt) ? n.startAt : t0
      const e = Number.isFinite(n.endAt) ? Math.max(n.endAt, s) : s
      let row = rowEnds.findIndex(end => end <= s)
      if (row === -1) {row = rowEnds.length; rowEnds.push(e)} else {rowEnds[row] = e}
      rowOf.set(n.id, row)
    }

    const placed: LayoutNode[] = sorted.map(n => {
      const s = Number.isFinite(n.startAt) ? n.startAt : t0
      const e = Number.isFinite(n.endAt) ? Math.max(n.endAt, s) : s
      const row = rowOf.get(n.id) ?? 0
      const x = xOf(s)
      const rawW = xOf(e) - x
      const w = Math.max(MIN_W, rawW * W_RATIO)
      const h = SUB_H - 6
      // 子行自下而上：行 0 贴在泳道底部，行号越大越靠上
      const y = laneTop + (LANE_H - PAD_BOTTOM * 0 - h) - (row + 1) * SUB_H + 6
      const node: LayoutNode = {
        id: n.id,
        label: n.label || n.id,
        status: n.status,
        onPath: critical.has(n.id),
        x: r1(x),
        y: r1(y),
        w: r1(w),
        h,
        source: n,
      }
      byId.set(n.id, node)
      return node
    })

    layoutLanes.push({
      lane,
      label: laneLabel(lane),
      icon: LANE_LABELS[lane]?.icon || '•',
      y: laneTop,
      h: LANE_H,
      nodes: placed,
    })
  }

  // ── 5. 依赖边 ──
  const edges: LayoutEdge[] = []
  for (const n of nodes) {
    const to = byId.get(n.id)
    if (!to) {continue}
    for (const dep of (Array.isArray(n.dependsOn) ? n.dependsOn : [])) {
      const from = byId.get(dep)
      // 悬空依赖（指向不存在的节点）不出边：画到空气里的箭头比没有箭头更糟
      if (!from) {continue}
      edges.push({
        key: `${dep}->${n.id}`,
        from: dep,
        to: n.id,
        critical: from.onPath && to.onPath,
        d: edgePath(from, to),
      })
    }
  }

  // ── 6. 时间刻度 ──
  const ticks: LayoutTick[] = []
  if (nodes.length > 0) {
    const count = Math.max(1, Math.min(MAX_TICKS, Math.ceil(span / 1500)))
    for (let i = 0; i <= count; i++) {
      const ratio = i / count
      const t = t0 + span * ratio
      ticks.push({
        x: r1(xOf(t)),
        label: `+${formatDuration(span * ratio)}`,
      })
    }
  }

  return { byId, lanes: layoutLanes, edges, ticks, width, height }
}

/**
 * 依赖边的 SVG 路径。
 *
 * 两种形状：
 * 1. **正向**（目标在源之后）：源右缘 → 目标左缘，水平切线三次贝塞尔。
 * 2. **回折**（目标在源之前结束 / 在源上方）：源底缘 → 目标顶缘，
 *    控制点一沉到源之下、控制点二升到目标之上，形成「下-横-上」回折。
 *    若目标反而在源下方，则镜像为「上-横-下」——视觉上仍是绕行，不会穿过节点。
 */
function edgePath(from: LayoutNode, to: LayoutNode): string {
  const fromCx = from.x + from.w / 2
  const toCx = to.x + to.w / 2
  const forward = toCx > fromCx + from.w / 2

  if (forward) {
    const mx = from.x + from.w
    const my = from.y + from.h / 2
    const tx = to.x
    const ty = to.y + to.h / 2
    const dx = Math.max(12, (tx - mx) / 2)
    return `M ${r1(mx)},${r1(my)} C ${r1(mx + dx)},${r1(my)} ${r1(tx - dx)},${r1(ty)} ${r1(tx)},${r1(ty)}`
  }

  // 回折：走外侧绕行
  const above = to.y < from.y
  const my = above ? from.y + from.h : from.y
  const ty = above ? to.y : to.y + to.h
  const mx = from.x + from.w
  const tx = Math.max(to.x + to.w, mx + 18)
  const bulge = Math.max(14, Math.abs(ty - my) / 2)
  const dir = above ? 1 : -1
  return `M ${r1(mx)},${r1(my)} C ${r1(mx + bulge)},${r1(my + bulge * dir)} ${r1(tx - bulge)},${r1(ty - bulge * dir)} ${r1(tx)},${r1(ty)}`
}

// ═══════════════════════════════════════════════════════════
// React 组件
// ═══════════════════════════════════════════════════════════

/** 泳道画布的数据源（IPC 尚未接线时为 null，UI 走降级分支） */
type SwimlaneApi = {
  get?: () => Promise<SwimlaneModel | null>
}

function useSwimlane(): { model: SwimlaneModel | null; error: string | null; loading: boolean } {
  const [model, setModel] = useState<SwimlaneModel | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    const api = (window as unknown as { luminaAPI?: SwimlaneApi }).luminaAPI
    if (!api?.get) {
      setLoading(false)
      setError('接口未接线（swimlane IPC 待补）')
      return () => {alive = false}
    }
    api.get()
      .then(m => {if (alive) {setModel(m); setError(null)}})
      .catch((e: unknown) => {if (alive) {setError(e instanceof Error ? e.message : String(e))}})
      .finally(() => {if (alive) {setLoading(false)}})
    return () => {alive = false}
  }, [])

  return { model, error, loading }
}

export default function SwimlaneCanvas() {
  const { model, error, loading } = useSwimlane()
  const [selected, setSelected] = useState<string | null>(null)

  const layout = useMemo(() => layoutOf(model ?? { lanes: [], nodes: [], criticalPath: [], wallClockMs: 0, generatedAt: Date.now() }), [model])

  const markdown = useMemo(() => {
    if (!model) {return ''}
    const lines = [`### 团队协作泳道 · ${formatDuration(model.wallClockMs)}`, '']
    for (const lane of layout.lanes) {
      const ns = lane.nodes.slice().sort((a, b) => a.x - b.x)
      if (ns.length === 0) {continue}
      lines.push(`**${lane.icon} ${lane.label}**`)
      for (const n of ns) {
        lines.push(`- \`${n.id}\` ${n.label} · ${n.status}${n.onPath ? ' · 关键路径' : ''} · ${formatDuration(n.source.durationMs)}`)
      }
      lines.push('')
    }
    return lines.join('\n')
  }, [model, layout])

  if (loading) {
    return <div style={{ padding: 16, fontSize: 12, color: 'var(--text-tertiary)' }}>正在加载泳道图…</div>
  }

  if (error) {
    return (
      <div style={{ padding: 16, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.8 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>暂时看不到泳道图</div>
        <div>{error}</div>
        <div style={{ color: 'var(--text-tertiary)', marginTop: 6 }}>
          布局引擎已就绪，接上 <code>window.luminaAPI.swimlane.get()</code> 即可显示真实数据。
        </div>
      </div>
    )
  }

  if (!model || model.nodes.length === 0) {
    return (
      <div style={{ padding: 24, textAlign: 'center', fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.8 }}>
        还没有可画的协作任务。<br />
        <span style={{ fontSize: 11 }}>当 Lumina 派出 Yak 或热茶干活时，这里会实时显示他们各自的进度与依赖关系。</span>
      </div>
    )
  }

  const sel = selected ? layout.byId.get(selected) : null
  const slowest = layout.lanes.reduce((acc, l) => {
    const span = l.nodes.reduce((m, n) => Math.max(m, n.source.durationMs), 0)
    return span > acc.span ? { lane: l, span } : acc
  }, { lane: null as LayoutLane | null, span: 0 })

  return (
    <div style={{ padding: 12, fontSize: 12, color: 'var(--text-primary)' }}>
      {/* 概览 */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 10, alignItems: 'center' }}>
        <span>总耗时 <b>{formatDuration(model.wallClockMs)}</b></span>
        <span style={{ color: 'var(--text-tertiary)' }}>·</span>
        <span>节点 <b>{model.nodes.length}</b></span>
        <span style={{ color: 'var(--text-tertiary)' }}>·</span>
        <span>最慢泳道 <b>{slowest.lane ? `${slowest.lane.icon} ${slowest.lane.label}` : '—'}</b></span>
        <span style={{ flex: 1 }} />
        <button
          onClick={() => {void navigator.clipboard?.writeText(markdown)}}
          style={{
            padding: '3px 8px', fontSize: 11, cursor: 'pointer', fontFamily: 'inherit',
            borderRadius: 6, border: '1px solid var(--border-medium)',
            background: 'var(--surface-0)', color: 'var(--text-secondary)',
          }}
        >复制为 Markdown</button>
      </div>

      {/* 画布 */}
      <div style={{ overflowX: 'auto', border: '1px solid var(--border-light)', borderRadius: 8, background: 'var(--surface-0)' }}>
        <svg width={layout.width} height={layout.height} style={{ display: 'block' }}>
          {/* 泳道底纹 */}
          {layout.lanes.map((l, i) => (
            <g key={l.lane}>
              <rect
                x={0} y={l.y} width={layout.width} height={l.h}
                fill={i % 2 === 0 ? 'var(--surface-0)' : 'var(--surface-50, var(--surface-0))'}
              />
              <text x={8} y={l.y + l.h / 2 + 4} fontSize={11} fill="var(--text-secondary)">
                {l.icon} {l.label}
              </text>
            </g>
          ))}

          {/* 刻度 */}
          {layout.ticks.map((t, i) => (
            <g key={i}>
              <line x1={t.x} y1={PAD_TOP} x2={t.x} y2={layout.height - PAD_BOTTOM}
                stroke="var(--border-light)" strokeWidth={1} strokeDasharray="2 3" />
              <text x={t.x} y={layout.height - 6} fontSize={9} fill="var(--text-tertiary)" textAnchor="middle">
                {t.label}
              </text>
            </g>
          ))}

          {/* 依赖边（先画，避免盖住节点） */}
          {layout.edges.map(e => (
            <path
              key={e.key} d={e.d} fill="none"
              stroke={e.critical ? 'var(--accent-500)' : 'var(--border-heavy, #94a3b8)'}
              strokeWidth={e.critical ? 2 : 1.2}
              strokeDasharray={e.critical ? undefined : '4 3'}
              markerEnd="url(#sw-arrow)"
            />
          ))}
          <defs>
            <marker id="sw-arrow" markerWidth={7} markerHeight={7} refX={6} refY={3} orient="auto">
              <path d="M0,0 L6,3 L0,6 z" fill="var(--border-heavy, #94a3b8)" />
            </marker>
          </defs>

          {/* 节点 */}
          {layout.lanes.flatMap(l => l.nodes.map(n => (
            <g key={n.id} onClick={() => setSelected(prev => (prev === n.id ? null : n.id))} style={{ cursor: 'pointer' }}>
              <rect
                x={n.x} y={n.y} width={n.w} height={n.h} rx={4}
                fill={STATUS_COLOR[n.status]}
                fillOpacity={n.status === 'pending' ? 0.25 : 0.85}
                stroke={n.onPath ? 'var(--accent-600)' : 'none'}
                strokeWidth={2}
              >
                {n.status === 'running' && (
                  <animate attributeName="fillOpacity" values="0.85;0.45;0.85" dur="1.4s" repeatCount="indefinite" />
                )}
              </rect>
              {n.w > 44 && (
                <text x={n.x + 5} y={n.y + n.h / 2 + 3} fontSize={9} fill="#fff" pointerEvents="none">
                  {n.label.length > 6 ? `${n.label.slice(0, 6)}…` : n.label}
                </text>
              )}
            </g>
          )))}
        </svg>
      </div>

      {/* 图例 */}
      <div style={{ display: 'flex', gap: 12, marginTop: 8, flexWrap: 'wrap', fontSize: 10, color: 'var(--text-tertiary)' }}>
        {(['pending', 'running', 'blocked', 'done', 'failed'] as NodeStatus[]).map(s => (
          <span key={s} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 9, height: 9, borderRadius: 2, background: STATUS_COLOR[s], display: 'inline-block' }} />
            {s}
          </span>
        ))}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span style={{ width: 9, height: 9, borderRadius: 2, border: '2px solid var(--accent-600)', display: 'inline-block' }} />
          关键路径
        </span>
      </div>

      {/* 详情 */}
      {sel && (
        <div style={{
          marginTop: 10, padding: '8px 10px', borderRadius: 8,
          background: 'var(--surface-50, var(--surface-0))', border: '1px solid var(--border-light)',
          fontSize: 11, lineHeight: 1.8,
        }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{sel.label} <code style={{ opacity: 0.6 }}>{sel.id}</code></div>
          <div>状态：{sel.status}{sel.onPath ? ' · 关键路径' : ''}</div>
          <div>耗时：{formatDuration(sel.source.durationMs)}</div>
          {sel.source.detail?.model && <div>模型：{sel.source.detail.model}</div>}
          {sel.source.detail?.worktree && <div>工作树：<code>{sel.source.detail.worktree}</code></div>}
          {sel.source.detail?.tool && <div>工具：{sel.source.detail.tool}</div>}
        </div>
      )}
    </div>
  )
}
