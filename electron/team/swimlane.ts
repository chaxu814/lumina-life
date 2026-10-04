// ============================================================
// swimlane.ts — 团队可观测性：依赖泳道画布 + Worktree 并行进度
//
// agentRunner 之所以难读，是因为「谁在等谁」只活在一次 Promise.all 里，
// 日志里全是并发的乱序片段。这个模块把编排压成一张**纯数据图**：
//   节点 = 一次任务 / 一个隔离 worktree / 对抗评审的一票
//   边   = dependsOn
// UI 只负责画，算全在这里，所以能被单测钉住。
//
// 三个刻意的约束：
//   1. **不 import electron**。同目录的 teamSharedBoard / llmTrace 顶部就是
//      `import { app } from 'electron'`，一旦引用它们，本文件既没法被 vitest
//      直接单测，也没法被渲染进程安全复用。所以这里用结构等价的最小接口
//      （BoardLikeTask / TraceLikeEntry）接收数据，字段名与真实模块对齐，
//      接线时直接传进去即可，零成本转换。
//   2. **墙钟取 max 不取 sum**。并行分支的时间是重叠的，累加会把
//      「3 个人同时干 1 小时」报成 3 小时 —— 泳道图最容易写错的就是这里。
//   3. **依赖图默认可能有环**。agent 动态派单、评审回流、worktree 合并
//      都会产生真实环，所以关键路径走 Kahn 拓扑排序 + DP，环上节点不参与 DP，
//      并用 visited/上限兜底保证任何输入都不会死循环或栈溢出。
// ============================================================

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

export type LaneKind = 'lumina' | 'yak' | 'recha' | 'dynamic' | 'worktree'

/** 泳道固定顺序：队长在前、隔离区在后，画布与序列化都靠它保证输出稳定 */
export const LANE_ORDER: readonly LaneKind[] = ['lumina', 'yak', 'recha', 'dynamic', 'worktree']

/** 角色图标与中文名放在后端，是为了让画布和「复制为 Markdown」用同一份文案 */
export const LANE_LABELS: Record<LaneKind, { icon: string; name: string }> = {
  lumina: { icon: '🐱', name: '流明' },
  yak: { icon: '🐂', name: '牦牛' },
  recha: { icon: '🍵', name: '热茶' },
  dynamic: { icon: '🛠', name: '临时工' },
  worktree: { icon: '🌿', name: '隔离工作区' },
}

export type NodeStatus = 'pending' | 'running' | 'blocked' | 'done' | 'failed'

/** 与 BoardTaskKind 对齐，另加 Lumina 编排独有的动作（隔离 worktree / 投票 / 合并） */
export type NodeKind =
  | 'research' | 'search' | 'data' | 'code' | 'review' | 'test'
  | 'worktree' | 'vote' | 'merge' | 'other'

/** 节点详情：点击节点后弹出的内容，字段都是「用户真的会想去点开」的 */
export interface SwimlaneDetail {
  model?: string
  worktree?: string
  tool?: string
  output?: string
  note?: string
}

export interface SwimlaneNode {
  id: string
  label: string
  lane: LaneKind
  kind: NodeKind
  status: NodeStatus
  startAt: number
  endAt: number
  dependsOn: string[]
  detail?: SwimlaneDetail
  progress: number
  /** 归一化后的耗时（ms），负数已夹到 0；前端不必自己减 */
  durationMs: number
}

export interface SwimlaneModel {
  lanes: LaneKind[]
  nodes: SwimlaneNode[]
  criticalPath: string[]
  wallClockMs: number
  generatedAt: number
}

// ═══════════════════════════════════════════════════════════
// 输入（容忍脏数据：接线方给什么都能吃）
// ═══════════════════════════════════════════════════════════

export interface RawNodeInput {
  id: string
  label?: string
  title?: string
  lane?: LaneKind | string
  kind?: NodeKind | string
  status?: NodeStatus | string
  startAt?: number | null
  endAt?: number | null
  dependsOn?: string[] | null
  /** teamSharedBoard 的字段名，blockedBy 是这里的依赖来源 */
  blockedBy?: string[] | null
  detail?: SwimlaneDetail | string | null
  progress?: number | null
}

export interface SwimlaneInput {
  nodes?: readonly RawNodeInput[]
  lanes?: readonly (LaneKind | string)[]
  /** 兜底时间基准，测试与回放时必须显式传入，否则结果不可复现 */
  now?: number
}

// ═══════════════════════════════════════════════════════════
// 小工具
// ═══════════════════════════════════════════════════════════

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

const num = (v: unknown, fallback: number): number => (isNum(v) ? v : fallback)

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

function isLaneKind(v: unknown): v is LaneKind {
  return typeof v === 'string' && (LANE_ORDER as readonly string[]).includes(v)
}

function normalizeLane(v: unknown): LaneKind {
  if (isLaneKind(v)) {return v}
  const s = typeof v === 'string' ? v.toLowerCase() : ''
  // workerId 常带角色前缀（recha_worker_3），子串兜底比严格等值更抗造
  for (const lane of LANE_ORDER) {
    if (s.includes(lane)) {return lane}
  }
  return 'dynamic'
}

const STATUS_ALIAS: Record<string, NodeStatus> = {
  pending: 'pending',
  pending_approval: 'pending',
  queued: 'pending',
  todo: 'pending',
  running: 'running',
  claimed: 'running',
  active: 'running',
  blocked: 'blocked',
  stalled: 'blocked',
  done: 'done',
  completed: 'done',
  success: 'done',
  failed: 'failed',
  error: 'failed',
}

function normalizeStatus(v: unknown): NodeStatus {
  if (typeof v !== 'string') {return 'pending'}
  return STATUS_ALIAS[v.toLowerCase()] || 'pending'
}

const KIND_ALIAS: Record<string, NodeKind> = {
  research: 'research', search: 'search', data: 'data', code: 'code',
  review: 'review', test: 'test', worktree: 'worktree', vote: 'vote',
  merge: 'merge', other: 'other',
}

function normalizeKind(v: unknown): NodeKind {
  if (typeof v !== 'string') {return 'other'}
  return KIND_ALIAS[v.toLowerCase()] || 'other'
}

function normalizeDetail(d: SwimlaneDetail | string | null | undefined): SwimlaneDetail | undefined {
  if (!d) {return undefined}
  if (typeof d === 'string') {return d.trim() ? { note: d.trim() } : undefined}
  const out: SwimlaneDetail = {}
  if (typeof d.model === 'string' && d.model.trim()) {out.model = d.model.trim()}
  if (typeof d.worktree === 'string' && d.worktree.trim()) {out.worktree = d.worktree.trim()}
  if (typeof d.tool === 'string' && d.tool.trim()) {out.tool = d.tool.trim()}
  if (typeof d.output === 'string' && d.output.trim()) {out.output = d.output.trim()}
  if (typeof d.note === 'string' && d.note.trim()) {out.note = d.note.trim()}
  return Object.keys(out).length ? out : undefined
}

function normalizeDeps(raw: RawNodeInput): string[] {
  const src = Array.isArray(raw.dependsOn)
    ? raw.dependsOn
    : Array.isArray(raw.blockedBy) ? raw.blockedBy : []
  const seen = new Set<string>()
  const out: string[] = []
  for (const d of src) {
    if (typeof d !== 'string') {continue}
    const id = d.trim()
    // 自依赖不去掉：让它进拓扑排序被当成环处理，比在这里悄悄吞掉更诚实
    if (!id || seen.has(id)) {continue}
    seen.add(id)
    out.push(id)
  }
  return out
}

/**
 * running 不编造百分比：trace 只知道「开始了」，不知道总量，
 * 猜一个 0.5 只会让画布撒谎。运行中用脉冲动画表达，静态数据留给调用方显式传。
 */
function normalizeProgress(raw: unknown, status: NodeStatus): number {
  if (isNum(raw)) {return clamp01(raw)}
  return status === 'done' || status === 'failed' ? 1 : 0
}

function normalizeNode(raw: RawNodeInput, now: number): SwimlaneNode {
  const status = normalizeStatus(raw.status)
  // endAt 缺失一律用 now 兜底：正在跑的节点必须有个「当下」的右边界，否则画不出进行中
  const endAt = num(raw.endAt, now)
  // startAt 缺失时贴到 endAt（而不是 now），这样缺失 start 的历史任务仍落在正确的时间位置
  const startAt = Math.min(num(raw.startAt, endAt), endAt)
  const detail = normalizeDetail(raw.detail)
  return {
    id: raw.id,
    label: (raw.label || raw.title || raw.id).trim() || raw.id,
    lane: normalizeLane(raw.lane),
    kind: normalizeKind(raw.kind),
    status,
    startAt,
    endAt,
    dependsOn: normalizeDeps(raw),
    ...(detail ? { detail } : {}),
    progress: normalizeProgress(raw.progress, status),
    durationMs: Math.max(0, endAt - startAt),
  }
}

/** 去重按 id，保留先出现的那条：节点顺序本身是画布的稳定输出依据 */
function dedupe(nodes: SwimlaneNode[]): SwimlaneNode[] {
  const seen = new Set<string>()
  const out: SwimlaneNode[] = []
  for (const n of nodes) {
    if (!n || typeof n.id !== 'string' || !n.id || seen.has(n.id)) {continue}
    seen.add(n.id)
    out.push(n)
  }
  return out
}

/** 墙钟 = 最晚结束 - 最早开始。**绝不累加**：并行分支的时间是重叠的 */
function wallClockOf(nodes: SwimlaneNode[]): number {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const n of nodes) {
    if (n.startAt < min) {min = n.startAt}
    if (n.endAt > max) {max = n.endAt}
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {return 0}
  return Math.max(0, max - min)
}

// ═══════════════════════════════════════════════════════════
// 关键路径
// ═══════════════════════════════════════════════════════════

const nodeDuration = (n: SwimlaneNode): number => Math.max(0, num(n.endAt, 0) - num(n.startAt, 0))

/**
 * 找出处于环上（或被环挡住）的节点。
 *
 * 用的是 Kahn 拓扑排序的「出队不完」性质：既不需要额外的强连通分量算法
 * （那份代码要写 60 行递归，对 1000 节点图也不值当），也天然覆盖
 * 「环的下游节点」—— 它们的入度永远降不下来，同样不可信。
 */
export function findCyclicNodeIds(nodes: SwimlaneNode[]): string[] {
  const { order, byId } = topoOrder(nodes)
  const done = new Set(order)
  const out: string[] = []
  for (const id of byId.keys()) {
    if (!done.has(id)) {out.push(id)}
  }
  return out
}

interface TopoResult {
  /** 拓扑序（确定的：按输入顺序推进队列），只含可解节点 */
  order: string[]
  byId: Map<string, SwimlaneNode>
  /** 邻接表一次建好，拓扑序和 DP 共用，省掉每节点重扫全图的 O(V²) */
  dependents: Map<string, string[]>
}

/** Kahn 拓扑排序 */
function topoOrder(nodes: SwimlaneNode[]): TopoResult {
  const byId = new Map<string, SwimlaneNode>()
  for (const n of Array.isArray(nodes) ? nodes : []) {
    if (n && typeof n.id === 'string' && n.id && !byId.has(n.id)) {byId.set(n.id, n)}
  }
  const dependents = new Map<string, string[]>()
  const inDegree = new Map<string, number>()
  for (const id of byId.keys()) {
    dependents.set(id, [])
    inDegree.set(id, 0)
  }
  for (const n of byId.values()) {
    const deps = Array.isArray(n.dependsOn) ? n.dependsOn : []
    for (const dep of deps) {
      // 悬空依赖（依赖了不在图里的任务）不建边：那是图外的等待，算进关键路径会失真
      if (typeof dep !== 'string' || !byId.has(dep)) {continue}
      dependents.get(dep)!.push(n.id)
      inDegree.set(n.id, (inDegree.get(n.id) ?? 0) + 1)
    }
  }
  const ready: string[] = []
  for (const [id, deg] of inDegree) {
    if (deg === 0) {ready.push(id)}
  }
  const order: string[] = []
  let qi = 0
  while (qi < ready.length) {
    const id = ready[qi++]
    order.push(id)
    for (const next of dependents.get(id)!) {
      const deg = (inDegree.get(next) ?? 0) - 1
      inDegree.set(next, deg)
      if (deg === 0) {ready.push(next)}
    }
  }
  return { order, byId, dependents }
}

/**
 * 依赖图上的最长路径（以耗时为权重）。
 *
 * 为什么用拓扑序 + DP 而不是 DFS 记忆化：
 *   · 记忆化递归在 1000 级链上会递归 1000 层，而且遇到环会直接爆栈；
 *   · 拓扑序迭代是 O(V+E)，无递归深度风险，环天然被挡在外面。
 *
 * 环的处理：Kahn 出队不完的节点（环上节点及其下游）一律不参与 DP，
 * 它们的耗时既不会被算进关键路径，也不会被当成别人的前置条件 ——
 * 依赖一个「不可信」的节点算出来的关键路径没有意义。
 */
export function computeCriticalPath(nodes: SwimlaneNode[]): string[] {
  if (!Array.isArray(nodes) || nodes.length === 0) {return []}
  const { order, byId, dependents } = topoOrder(nodes)
  if (order.length === 0) {return []}

  const best = new Map<string, number>()
  const parent = new Map<string, string | null>()
  /** best 路径上的节点数：用于并列时的深链优先（见下） */
  const depth = new Map<string, number>()
  for (const id of order) {
    best.set(id, nodeDuration(byId.get(id)!))
    parent.set(id, null)
    depth.set(id, 1)
  }
  // order 是拓扑序：处理 u 时，它的所有前驱都已经 relax 完 u 了
  for (const id of order) {
    const base = best.get(id)!
    const baseDepth = depth.get(id)!
    for (const next of dependents.get(id)!) {
      const cand = base + nodeDuration(byId.get(next)!)
      const candDepth = baseDepth + 1
      const prev = best.get(next) ?? Number.NEGATIVE_INFINITY
      // 【并列时为什么要比深度】
      // 真实图里打平很常见：一条 a→b→c 依赖链与一个独立长任务常常总耗时相同。
      // 若只看总耗时，平局会取到拓扑序里更靠前的那个 —— 往往是一条**孤立的并行任务**，
      // 于是「关键路径」画出来是一条没有任何依赖边的单点，调试价值为零。
      // 而排期风险恰恰在**串行的顺序工作**上：它才是延迟无法被并行的部分。
      // 所以并列时取更长的那条链，输出才稳定且有信息量。
      const better = cand > prev || (cand === prev && candDepth > (depth.get(next) ?? 0))
      if (better) {
        best.set(next, cand)
        parent.set(next, id)
        depth.set(next, candDepth)
      }
    }
  }

  let endId: string | null = null
  let endVal = Number.NEGATIVE_INFINITY
  let endDepth = 0
  for (const id of order) {
    const v = best.get(id)!
    const d = depth.get(id) ?? 0
    // 同样的深链优先规则，保证终点选中也一致
    if (v > endVal || (v === endVal && d > endDepth)) {
      endVal = v
      endId = id
      endDepth = d
    }
  }
  if (!endId) {return []}

  const path: string[] = []
  let cur: string | null = endId
  // parent 只回指拓扑序更靠前的节点，本不可能成环；这里仍留一道上限，
  // 代价是常数级的，换掉「万一就成环了呢」的栈溢出
  let guard = order.length + 1
  while (cur && guard-- > 0) {
    path.push(cur)
    cur = parent.get(cur) ?? null
  }
  path.reverse()
  return path
}

// ═══════════════════════════════════════════════════════════
// 构建
// ═══════════════════════════════════════════════════════════

/**
 * 组装一张泳道图。空输入是合法输入，返回一张空图而不是抛错 ——
 * 接线方在「还没有任何任务」时也一定会调它。
 */
export function buildSwimlane(input: SwimlaneInput = {}): SwimlaneModel {
  const now = num(input?.now, Date.now())
  const raw = Array.isArray(input?.nodes) ? input.nodes : []
  const nodes = dedupe(raw.map(n => normalizeNode(n, now)))
  const lanes: LaneKind[] = []
  const wanted = new Set<LaneKind>()
  for (const l of Array.isArray(input?.lanes) ? input.lanes : []) {
    if (isLaneKind(l)) {wanted.add(l)}
  }
  for (const n of nodes) {wanted.add(n.lane)}
  // 按 LANE_ORDER 固定顺序输出，画布行序与 Markdown 表格才会稳定
  for (const lane of LANE_ORDER) {
    if (wanted.has(lane)) {lanes.push(lane)}
  }
  return {
    lanes,
    nodes,
    criticalPath: computeCriticalPath(nodes),
    wallClockMs: wallClockOf(nodes),
    generatedAt: now,
  }
}

// ═══════════════════════════════════════════════════════════
// 瓶颈分析
// ═══════════════════════════════════════════════════════════

export interface LaneLoad {
  lane: LaneKind
  nodeCount: number
  busyMs: number
  /** 该泳道从最早开始到最晚结束的跨度 */
  spanMs: number
  /** 跨度里没在干活的时间 = 在等依赖 */
  idleMs: number
  /** idleMs / spanMs，空等占比 */
  waitRatio: number
  firstAt: number | null
  lastAt: number | null
}

export interface PeakParallel {
  /** 并行度达到峰值那一刻的时间戳（最早的一次） */
  at: number
  /** 同时进行的节点数 */
  count: number
  /** 那一刻有几条泳道在同时干活 */
  lanes: number
}

export interface BottleneckReport {
  laneLoads: LaneLoad[]
  slowestLane: LaneLoad | null
  peakParallel: PeakParallel
  /** 是否有泳道超过阈值时间在空等依赖 */
  hasSerialWait: boolean
  /** 全图最严重的空等占比 */
  serialWaitRatio: number
  hints: string[]
}

/** 空等超过这个比例才算「串行等待」，否则正常的任务间隙会被误报 */
const SERIAL_WAIT_THRESHOLD = 0.35

function analyzeLane(lane: LaneKind, nodes: SwimlaneNode[]): LaneLoad {
  let busy = 0
  let first: number | null = null
  let last: number | null = null
  for (const n of nodes) {
    busy += nodeDuration(n)
    if (first === null || n.startAt < first) {first = n.startAt}
    if (last === null || n.endAt > last) {last = n.endAt}
  }
  const span = first === null || last === null ? 0 : Math.max(0, last - first)
  const idle = Math.max(0, span - busy)
  return {
    lane,
    nodeCount: nodes.length,
    busyMs: busy,
    spanMs: span,
    idleMs: idle,
    waitRatio: span > 0 ? idle / span : 0,
    firstAt: first,
    lastAt: last,
  }
}

/**
 * 只统计「真正在干活」的节点：pending 还没开始，blocked 是卡住不产出，
 * 把它们算进并行度会让峰值虚高。
 */
function countsAsBusy(status: NodeStatus): boolean {
  return status === 'running' || status === 'done' || status === 'failed'
}

function peakParallelOf(nodes: SwimlaneNode[]): PeakParallel {
  const spans = nodes.filter(n => countsAsBusy(n.status) && nodeDuration(n) > 0)
  if (!spans.length) {return { at: 0, count: 0, lanes: 0 }}
  const events: Array<{ at: number; d: number }> = []
  for (const n of spans) {
    events.push({ at: n.startAt, d: 1 })
    events.push({ at: n.endAt, d: -1 })
  }
  // 同一时刻先出后进：半开区间 [start, end)，相邻的两个任务不算并行
  events.sort((a, b) => (a.at - b.at) || (a.d - b.d))
  let cur = 0
  let best = 0
  let bestAt = events[0].at
  for (const e of events) {
    cur += e.d
    if (cur > best) {
      best = cur
      bestAt = e.at
    }
  }
  // 峰值时刻的泳道数单独扫一遍：维护「哪条 lane 有几个在跑」需要额外的 per-lane 计数，
  // 但峰值时刻只可能有一次值得算，所以这里用一次 O(n) 扫描换掉全程的 per-lane 状态
  const lanesAtPeak = new Set<LaneKind>()
  for (const n of spans) {
    if (n.startAt <= bestAt && n.endAt > bestAt) {lanesAtPeak.add(n.lane)}
  }
  return { at: bestAt, count: best, lanes: lanesAtPeak.size }
}

export function detectBottleneck(model: SwimlaneModel): BottleneckReport {
  const nodes = Array.isArray(model?.nodes) ? model.nodes : []
  // LANE_ORDER 是 readonly 数组，这里跟着放宽成 readonly，否则赋不进去
  const lanes: readonly LaneKind[] = Array.isArray(model?.lanes) ? model.lanes : LANE_ORDER

  const laneLoads = lanes.map(lane => analyzeLane(lane, nodes.filter(n => n.lane === lane)))
  const peakParallel = peakParallelOf(nodes)

  // 最慢泳道按忙碌时间排：跨度大但大半时间在等的泳道不是瓶颈
  let slowestLane: LaneLoad | null = null
  for (const l of laneLoads) {
    if (!slowestLane || l.busyMs > slowestLane.busyMs) {slowestLane = l}
  }
  if (slowestLane && slowestLane.nodeCount === 0) {slowestLane = null}

  let serialWaitRatio = 0
  let worstWait: LaneLoad | null = null
  for (const l of laneLoads) {
    if (l.nodeCount === 0) {continue}
    if (l.waitRatio > serialWaitRatio) {
      serialWaitRatio = l.waitRatio
      worstWait = l
    }
  }

  const hints: string[] = []
  if (!nodes.length) {
    hints.push('暂无任务节点')
  } else {
    if (slowestLane) {
      const label = laneLabel(slowestLane.lane)
      hints.push(`最慢泳道：${label}，忙碌 ${formatDuration(slowestLane.busyMs)}`)
    }
    hints.push(`并行峰值：${peakParallel.count} 个节点同时进行，横跨 ${peakParallel.lanes} 条泳道`)
    if (peakParallel.count <= 1 && nodes.length > 1) {
      hints.push('全程只有一个节点在推进，其余时间都在等 —— 依赖没有被并行派发出去')
    }
    if (serialWaitRatio >= SERIAL_WAIT_THRESHOLD && worstWait) {
      hints.push(
        `串行等待：${laneLabel(worstWait.lane)} 有 ${formatPercent(serialWaitRatio)} 的时间空等依赖`,
      )
    }
  }

  return {
    laneLoads,
    slowestLane,
    peakParallel,
    hasSerialWait: serialWaitRatio >= SERIAL_WAIT_THRESHOLD,
    serialWaitRatio,
    hints,
  }
}

// ═══════════════════════════════════════════════════════════
// 展示辅助（后端与画布共用同一份文案，免得两边各写一套）
// ═══════════════════════════════════════════════════════════

export function laneLabel(lane: LaneKind): string {
  const meta = LANE_LABELS[lane]
  return meta ? `${meta.icon} ${meta.name}` : String(lane)
}

/** 确定性格式化：不碰 toLocale，避免同一份数据在不同机器上导出不同文本 */
export function formatDuration(ms: number): string {
  const v = isNum(ms) && ms > 0 ? ms : 0
  if (v < 1000) {return `${Math.round(v)}ms`}
  const s = v / 1000
  if (s < 60) {return `${s.toFixed(1)}s`}
  const m = Math.floor(s / 60)
  if (m < 60) {return `${m}m ${String(Math.round(s % 60)).padStart(2, '0')}s`}
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

export function formatPercent(ratio: number): string {
  return `${Math.round(clamp01(isNum(ratio) ? ratio : 0) * 100)}%`
}

// ═══════════════════════════════════════════════════════════
// 序列化
// ═══════════════════════════════════════════════════════════

const STATUS_CN: Record<NodeStatus, string> = {
  pending: '待领取', running: '进行中', blocked: '阻塞', done: '完成', failed: '失败',
}

const KIND_CN: Record<NodeKind, string> = {
  research: '调研', search: '检索', data: '数据', code: '编码',
  review: '复核', test: '测试', worktree: '隔离工作区', vote: '投票', merge: '合并', other: '杂活',
}

/**
 * 输出可直接贴进 README / 汇报的 Markdown。
 *
 * 稳定性是硬要求（测试会断言同输入两次调用完全一致），所以：
 *   · 不读时钟、不用本地化格式化；
 *   · 相对时间（+0.0s）而不是墙钟时间戳，贴进文档不会显得很吵；
 *   · 顺序完全由 model 自带顺序决定。
 */
export function serializeSwimlane(model: SwimlaneModel): string {
  const safe: SwimlaneModel = model && Array.isArray(model.nodes)
    ? model
    : { lanes: [], nodes: [], criticalPath: [], wallClockMs: 0, generatedAt: 0 }
  const lines: string[] = []
  lines.push('# 团队依赖泳道')
  lines.push('')

  if (isNum(safe.generatedAt) && safe.generatedAt > 0) {
    lines.push(`- 生成时间：${new Date(safe.generatedAt).toISOString()}`)
  }
  lines.push(`- 墙钟耗时：${formatDuration(num(safe.wallClockMs, 0))}（最晚结束 - 最早开始，并行任务不累加）`)
  lines.push(`- 节点 ${safe.nodes.length} 个 / 泳道 ${safe.lanes.length} 条`)
  lines.push('')

  if (!safe.nodes.length) {
    lines.push('> 暂无任务节点。')
    return lines.join('\n')
  }

  const report = detectBottleneck(safe)
  const t0 = safe.nodes.reduce((m, n) => Math.min(m, num(n.startAt, 0)), Number.POSITIVE_INFINITY)
  const rel = (t: number): string => (Number.isFinite(t0) ? `+${formatDuration(Math.max(0, t - t0))}` : '+0ms')

  lines.push('## 泳道负载')
  lines.push('')
  lines.push('| 泳道 | 节点 | 忙碌 | 空等 | 空等占比 |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const l of report.laneLoads) {
    lines.push(`| ${laneLabel(l.lane)} | ${l.nodeCount} | ${formatDuration(l.busyMs)} | ${formatDuration(l.idleMs)} | ${formatPercent(l.waitRatio)} |`)
  }
  lines.push('')

  lines.push('## 关键路径')
  lines.push('')
  if (safe.criticalPath.length) {
    const byId = new Map(safe.nodes.map(n => [n.id, n]))
    lines.push(safe.criticalPath.map(id => `\`${id}\`${byId.has(id) ? `（${byId.get(id)!.label}）` : ''}`).join(' → '))
  } else {
    lines.push('（依赖成环或无可解路径）')
  }
  lines.push('')

  lines.push('## 瓶颈')
  lines.push('')
  for (const h of report.hints) {lines.push(`- ${h}`)}
  lines.push('')

  lines.push('## 节点明细')
  lines.push('')
  lines.push('| 状态 | 泳道 | 节点 | 类型 | 开始 | 耗时 | 进度 | 详情 |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |')
  const onPath = new Set(safe.criticalPath)
  for (const n of safe.nodes) {
    const bits: string[] = []
    if (n.detail?.model) {bits.push(`模型 ${n.detail.model}`)}
    if (n.detail?.worktree) {bits.push(`worktree ${n.detail.worktree}`)}
    if (n.detail?.tool) {bits.push(`工具 ${n.detail.tool}`)}
    if (n.detail?.output) {bits.push(`产出 ${n.detail.output.replace(/\s+/g, ' ').slice(0, 60)}`)}
    const star = onPath.has(n.id) ? '★ ' : ''
    lines.push(
      `| ${STATUS_CN[n.status]} | ${laneLabel(n.lane)} | ${star}\`${n.id}\` ${n.label} | ${KIND_CN[n.kind]} | ${rel(n.startAt)} | ${formatDuration(n.durationMs)} | ${formatPercent(n.progress)} | ${bits.join('；') || '—'} |`,
    )
  }
  lines.push('')
  return lines.join('\n')
}

// ═══════════════════════════════════════════════════════════
// 接线适配器
// ═══════════════════════════════════════════════════════════

/** teamSharedBoard.BoardTask 的结构化子集（字段名与真实类型一一对应） */
export interface BoardLikeTask {
  id: string
  title?: string
  detail?: string
  kind?: string
  status?: string
  owner?: string | null
  blockedBy?: string[] | null
  workdir?: string | null
  result?: string | null
  createdAt?: number | null
  claimedAt?: number | null
  completedAt?: number | null
  updatedAt?: number | null
}

export interface SwimlaneFromBoardOptions {
  now?: number
  lanes?: readonly LaneKind[]
}

/** 看板任务 → 泳道节点。有 workdir 的任务单独挂到「隔离工作区」泳道 */
export function swimlaneFromBoard(
  tasks: readonly BoardLikeTask[],
  opts: SwimlaneFromBoardOptions = {},
): SwimlaneModel {
  const now = num(opts.now, Date.now())
  const nodes: RawNodeInput[] = (Array.isArray(tasks) ? tasks : []).map((t, i) => ({
    id: t && typeof t.id === 'string' && t.id ? t.id : `t${i}`,
    label: t?.title || t?.id || `任务${i + 1}`,
    lane: t?.workdir ? 'worktree' : laneForRole(t?.owner),
    kind: t?.kind,
    status: t?.status,
    startAt: t?.claimedAt ?? t?.updatedAt ?? now,
    endAt: t?.completedAt ?? now,
    dependsOn: t?.blockedBy,
    detail: {
      ...(t?.detail ? { note: t.detail.slice(0, 200) } : {}),
      ...(t?.workdir ? { worktree: t.workdir } : {}),
      ...(t?.result ? { output: t.result } : {}),
    },
  }))
  return buildSwimlane({ nodes, lanes: opts.lanes, now })
}

/** llmTrace.TraceEntry 的结构化子集 */
export interface TraceLikeEntry {
  at: number
  phase: 'start' | 'end'
  source?: string
  role?: string
  workerId?: string
  title?: string
  /** TraceEntry 只有 modelTier，这里允许接线方补上真实模型名 */
  model?: string
  modelTier?: string
  durationMs?: number
  ok?: boolean
  error?: string
}

export interface SwimlaneFromTraceOptions {
  now?: number
  lanes?: readonly LaneKind[]
  /** 只看这个时间点之后开始的条目 */
  since?: number
}

/** 配对键用 \u0000 分隔：workerId 和 title 里都可能带 @，用可见字符会歧义 */
const tracePairKey = (e: TraceLikeEntry): string => `${e.workerId || ''}\u0000${e.title || ''}`

/** 节点 id 保留中文：只清控制字符与多余空白，之前的 \w 白名单会把标题洗成下划线 */
const traceNodeId = (e: TraceLikeEntry): string =>
  `${e.workerId || 'w'}@${e.title || 'task'}`.replace(/[\s\u0000-\u001f]+/g, ' ').trim()

/**
 * trace 条目 → 泳道节点。按 `workerId@title` 把 start/end 配对。
 *
 * 这里刻意**不 import llmTrace**：那个文件顶部就 `import { app } from 'electron'`，
 * 引进来本模块就失去「无 Electron 依赖、可单测、可被渲染进程复用」这三条性质。
 * 需要 LONG_TASK_MS 高亮的话，请在主进程侧用它给节点补 detail.note。
 */
export function swimlaneFromTrace(
  entries: readonly TraceLikeEntry[],
  opts: SwimlaneFromTraceOptions = {},
): SwimlaneModel {
  const now = num(opts.now, Date.now())
  const since = num(opts.since, 0)
  const nodes: RawNodeInput[] = []
  const open = new Map<string, RawNodeInput>()

  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || !isNum(e.at) || e.at < since) {continue}
    if (!e.workerId && !e.title) {continue}
    const key = tracePairKey(e)
    if (e.phase === 'start') {
      // 重复 start 取第一条：trace 环形缓冲里同一次任务可能被重复写入
      if (open.has(key)) {continue}
      const node: RawNodeInput = {
        id: traceNodeId(e),
        label: e.title || key,
        lane: e.source === 'workflow' ? 'worktree' : laneForRole(e.role),
        kind: 'other',
        status: 'running',
        startAt: e.at,
        detail: { ...(e.model || e.modelTier ? { model: e.model || e.modelTier } : {}) },
      }
      open.set(key, node)
      nodes.push(node)
      continue
    }
    const node = open.get(key)
    if (!node) {continue}
    node.status = e.ok === false ? 'failed' : 'done'
    node.endAt = e.at
    node.progress = 1
    // RawNodeInput.detail 允许传字符串，这里只接对象分支（我们自己写进去的就是对象）
    const detail: SwimlaneDetail = (typeof node.detail === 'object' ? node.detail : {}) || {}
    if (e.error) {detail.note = e.error.slice(0, 200)}
    node.detail = detail
    // 结束条目比开始条目晚是常态；倒挂说明 trace 被截断，用上报的 durationMs 兜底
    if (e.at < num(node.startAt, e.at) && isNum(e.durationMs)) {node.endAt = node.startAt + e.durationMs}
  }
  return buildSwimlane({ nodes, lanes: opts.lanes, now })
}

/** workerId / role → 泳道。认不出来的都归「临时工」，因为那才是兜底真相 */
export function laneForRole(role: unknown): LaneKind {
  if (typeof role !== 'string' || !role.trim()) {return 'dynamic'}
  const s = role.toLowerCase()
  if (s.includes('worktree') || s.includes('workdir')) {return 'worktree'}
  if (s.includes('dynamic') || s.includes('temp') || s.includes('临时')) {return 'dynamic'}
  for (const lane of LANE_ORDER) {
    if (lane !== 'worktree' && s.includes(lane)) {return lane}
  }
  return 'dynamic'
}
