// ============================================================
// TeamTopologyView.tsx — v3.32 团队实时拓扑图（对标 cc-haha 工作台）
//
// 布局：
//   上：Lumina（队长/唯一对外窗口）
//   中：任务按依赖波次分列；成员头像直接「站」在自己的任务卡上（红色脉冲=执行中）
//   下：待命区长凳（手上没有活的成员）
// 右侧：通讯流（全部 / 指派 / 私信，成员信箱过滤）
// 顶栏：播放 / 0.5× 1× 2× 4× / 可点击时间轴（快照回放，localStorage 持久化）
// ============================================================

import React, { useMemo, useEffect, useRef, useState } from 'react'

const ROLE_CN: Record<string, string> = {
  research: '调研', search: '检索', data: '数据',
  code: '工程', review: '复核', test: '测试', general: '协作',
}

const STATUS_META: Record<string, { label: string; bg: string; fg: string; dot: string }> = {
  pending_approval: { label: '待批准', bg: '#fef3c7', fg: '#92400e', dot: '#f59e0b' },
  pending: { label: '待领', bg: '#f3f4f6', fg: '#6b7280', dot: '#9ca3af' },
  claimed: { label: '已认领', bg: '#dbeafe', fg: '#1d4ed8', dot: '#3b82f6' },
  running: { label: '执行中', bg: '#fee2e2', fg: '#b91c1c', dot: '#dc2626' },
  blocked: { label: '阻塞', bg: '#ffedd5', fg: '#c2410c', dot: '#f59e0b' },
  done: { label: '完成', bg: '#d1fae5', fg: '#047857', dot: '#10b981' },
  failed: { label: '失败', bg: '#fecaca', fg: '#991b1b', dot: '#ef4444' },
}

// ── 布局常量 ──
const CARD_W = 104
const CARD_H = 78
const TASK_W = 216
const TASK_H = 108
const COL_DX = 240
const ROW_DY = 132
const BOSS_Y = 8
const HEADER_Y = 120
const TASK_Y0 = 152
const BENCH_CHIP_W = 106
const BENCH_CHIP_H = 50
const BENCH_GAP = 10

const SNAP_KEY = 'lumina:topo-snapshots:v1'
const SNAP_CAP = 240
const SNAP_TTL_MS = 60 * 60 * 1000

interface CompactTask {
  id: string; title: string; kind: string; status: string
  owner: string | null; blockedBy: string[]; requireApproval?: boolean
}
interface CompactWorker {
  id: string; name: string; role: string; icon: string; state: string
  modelTier?: string; model?: string | null; workdir?: string; busy?: boolean
}
interface Snap { ts: number; tasks: CompactTask[]; workers: CompactWorker[] }

interface MemberNode {
  id: string
  icon: string
  name: string
  title: string
  boss?: boolean
  dynamic?: boolean
  busy?: boolean
}

interface Edge {
  key: string
  d: string
  color: string
  dashed?: string
  active?: boolean
}

interface BoardLike {
  tasks?: any[]
  lanes?: Record<string, any[]>
  counts?: Record<string, number>
  total?: number
}

interface Props {
  board: BoardLike | null
  workers: any[]
  counts: Record<string, number>
  onAction: (action: string, payload: any) => void
  /** v3.30 状态变更历史（拓扑回放） */
  history?: any[]
  /** v3.30 关停 idle/忙 worker */
  onShutdown?: (id: string) => void
  /** v3.32 聚合通讯流（全部信箱去重后，时间倒序） */
  mailStream?: any[]
}

/** 依依赖计算波次：0=无依赖，N=第 N+1 波，-1=依赖缺失 */
function computeColumns(tasks: any[]): { wave: number; items: any[] }[] {
  const byId = new Map(tasks.map(t => [t.id, t]))
  const waveMemo = new Map<string, number>()

  function wave(id: string, stack: Set<string>): number {
    if (waveMemo.has(id)) {return waveMemo.get(id)!}
    if (stack.has(id)) {return -2} // 环
    const t = byId.get(id)
    if (!t) {return -1}
    const deps: string[] = t.blockedBy || []
    if (deps.length === 0) {waveMemo.set(id, 0); return 0}
    let max = -1
    for (const d of deps) {
      if (!byId.has(d)) {max = -1; break}
      const w = wave(d, new Set(stack).add(id))
      if (w < 0) {max = -1; break}
      max = Math.max(max, w)
    }
    const res = max < 0 ? -1 : max + 1
    waveMemo.set(id, res)
    return res
  }

  const buckets = new Map<number, any[]>()
  for (const t of tasks) {
    const w = wave(t.id, new Set())
    if (!buckets.has(w)) {buckets.set(w, [])}
    buckets.get(w)!.push(t)
  }
  const order: Record<string, number> = { running: 0, blocked: 1, claimed: 2, pending: 3, pending_approval: 3.5, failed: 4, done: 5 }
  const numId = (id: string) => Number(String(id).replace(/^t/, '')) || 0
  const cols = [...buckets.entries()]
    .sort((a, b) => {
      if (a[0] < 0 && b[0] < 0) {return a[0] - b[0]}
      if (a[0] < 0) {return 1}
      if (b[0] < 0) {return -1}
      return a[0] - b[0]
    })
    .map(([w, items]) => ({
      wave: w,
      items: items.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || numId(a.id) - numId(b.id)),
    }))
  return cols
}

function lanesFromTasks(tasks: any[]): BoardLike {
  const lanes: Record<string, any[]> = {
    pending: [], pending_approval: [], claimed: [], running: [],
    blocked: [], done: [], failed: [],
  }
  for (const t of tasks) {(lanes[t.status] || lanes.failed).push(t)}
  const counts: Record<string, number> = {}
  for (const k of Object.keys(lanes)) {counts[k] = lanes[k].length}
  return { lanes, counts, total: tasks.length }
}

const compactTask = (t: any): CompactTask => ({
  id: t.id, title: t.title, kind: t.kind, status: t.status,
  owner: t.owner, blockedBy: t.blockedBy || [], requireApproval: !!t.requireApproval,
})
const compactWorker = (w: any): CompactWorker => ({
  id: w.id, name: w.name, role: w.role, icon: w.icon, state: w.state,
  modelTier: w.modelTier, model: w.model ?? null, workdir: w.workdir, busy: w.busy,
})
const snapKey = (s: Snap) =>
  JSON.stringify(s.tasks.map(t => [t.id, t.status, t.owner]))
  + '|' + JSON.stringify(s.workers.map(w => [w.id, w.state]))

function loadSnaps(): Snap[] {
  try {
    const raw = localStorage.getItem(SNAP_KEY)
    if (!raw) {return []}
    const arr = JSON.parse(raw) as Snap[]
    const now = Date.now()
    return arr.filter(s => now - s.ts < SNAP_TTL_MS)
  } catch {return []}
}

const HHMMSS = (ts: number) => new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })

export default function TeamTopologyView({ board, workers, counts, onAction, history, onShutdown, mailStream }: Props) {
  // ── v3.32 1s 轮询（比父面板 5s 更细，快照才有回放颗粒度）──
  const [liveBoard, setLiveBoard] = useState<BoardLike | null>(null)
  const [liveWorkers, setLiveWorkers] = useState<any[]>([])
  useEffect(() => {
    let alive = true
    const a = () => (window as any).luminaAPI
    const poll = async () => {
      const b = await a()?.collabBoard?.().catch(() => null)
      const w = await a()?.collabWorkers?.().catch(() => [])
      if (!alive) {return}
      if (b) {setLiveBoard(b)}
      if (w) {setLiveWorkers(w)}
    }
    poll()
    const t = setInterval(poll, 1000)
    return () => {alive = false; clearInterval(t)}
  }, [])

  const effBoard = liveBoard || board
  const effWorkers = liveWorkers.length ? liveWorkers : workers
  const liveTasks: any[] = useMemo(
    () => Object.values(effBoard?.lanes || {}).flat() as any[],
    [effBoard],
  )

  // ── v3.32 快照录制（状态变化才录，localStorage 持久化）──
  const [snaps, setSnaps] = useState<Snap[]>(loadSnaps)
  const liveSig = JSON.stringify(liveTasks.map(t => [t.id, t.status, t.owner]))
    + '|' + JSON.stringify(effWorkers.map((w: any) => [w.id, w.state]))
  const writeT = useRef<any>(null)
  useEffect(() => {
    if (!effBoard) {return}
    const snap: Snap = { ts: Date.now(), tasks: liveTasks.map(compactTask), workers: effWorkers.map(compactWorker) }
    setSnaps(prev => {
      const now = Date.now()
      const base = prev.filter(s => now - s.ts < SNAP_TTL_MS)
      const last = base[base.length - 1]
      if (last && snapKey(last) === snapKey(snap)) {return base}
      const next = [...base, snap]
      const trimmed = next.length > SNAP_CAP ? next.slice(next.length - SNAP_CAP) : next
      clearTimeout(writeT.current)
      writeT.current = setTimeout(() => {
        try {localStorage.setItem(SNAP_KEY, JSON.stringify(trimmed))} catch { /* 配额满就不写 */ }
      }, 800)
      return trimmed
    })
  }, [liveSig])

  // ── 回放状态 ──
  const [playIdx, setPlayIdx] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const replay = playIdx !== null ? snaps[playIdx] : null
  useEffect(() => {
    if (!playing || playIdx === null) {return}
    const t = setInterval(() => {
      setPlayIdx(i => {
        if (i === null) {return i}
        if (i >= snaps.length - 1) {setPlaying(false); return i}
        return i + 1
      })
    }, 1000 / speed)
    return () => clearInterval(t)
  }, [playing, speed, playIdx, snaps.length])

  const viewTasks: any[] = replay ? replay.tasks : liveTasks
  const viewWorkers: any[] = replay ? replay.workers : effWorkers
  const viewBoard = useMemo(() => lanesFromTasks(viewTasks), [viewTasks])
  const cols = useMemo(() => computeColumns(viewTasks), [viewTasks])

  // 成员节点（内置 3 人 + 动态 worker）
  const members = useMemo<MemberNode[]>(() => [
    { id: 'lumina', icon: '🐱', name: 'Lumina', title: '协调 · 唯一对外', boss: true },
    { id: 'yak', icon: '📊', name: 'Yak', title: '工程' },
    { id: 'recha', icon: '🍵', name: '热茶', title: '审查' },
    ...viewWorkers.map((w: any): MemberNode => ({
      id: w.id, icon: w.icon || '👷', name: w.name,
      title: ROLE_CN[w.role] ? `${ROLE_CN[w.role]} · 临时工` : '临时工',
      dynamic: true, busy: w.busy,
    })),
  ], [viewWorkers])

  const memberMeta = useMemo(() => {
    const m = new Map<string, { icon: string; name: string; dynamic?: boolean }>()
    members.forEach(x => m.set(x.id, { icon: x.icon, name: x.name, dynamic: x.dynamic }))
    m.set('lumina', { icon: '🐱', name: 'Lumina' })
    return m
  }, [members])

  // 每个成员当前的活跃任务（claimed/running/blocked 才算「站在任务上」）
  const activeTaskOf = new Map<string, any>()
  for (const t of viewTasks) {
    if (t.owner && ['claimed', 'running', 'blocked'].includes(t.status) && !activeTaskOf.has(t.owner)) {
      activeTaskOf.set(t.owner, t)
    }
  }

  const memberState = (id: string): { label: string; color: string } => {
    const owned = viewTasks.filter(t => t.owner === id)
    const running = owned.find(t => t.status === 'running')
    if (running) {return { label: `执行中 #${running.id.replace(/^t/, '')}`, color: '#dc2626' }}
    const blocked = owned.find(t => t.status === 'blocked')
    if (blocked) {return { label: `阻塞 #${blocked.id.replace(/^t/, '')}`, color: '#d97706' }}
    const claimed = owned.find(t => t.status === 'claimed')
    if (claimed) {return { label: `已认领 #${claimed.id.replace(/^t/, '')}`, color: '#2563eb' }}
    if (id === 'lumina') {return { label: '协调中', color: '#ec4899' }}
    if (id.startsWith('tmp_')) {
      const w = viewWorkers.find((x: any) => x.id === id)
      if (w?.state === 'shutdown_requested') {return { label: '待关停', color: '#9ca3af' }}
      if (w?.state === 'idle') {return { label: 'idle 待命', color: '#7c3aed' }}
      return { label: '在岗待命', color: '#7c3aed' }
    }
    return { label: '在线', color: '#10b981' }
  }

  // 任务坐标
  const taskPos = new Map<string, { x: number; y: number; col: number }>()
  cols.forEach((col, ci) => {
    col.items.forEach((t, ri) => {
      taskPos.set(t.id, { x: 16 + ci * COL_DX, y: TASK_Y0 + ri * ROW_DY, col: ci })
    })
  })

  const maxRows = Math.max(...cols.map(c => c.items.length), 1)
  const benchList = members.filter(m => !m.boss && !activeTaskOf.has(m.id))
  const benchWidth = Math.max(
    720,
    (cols.length || 1) * COL_DX + 40,
    benchList.length * (BENCH_CHIP_W + BENCH_GAP) + 40,
  )
  const width = Math.max(720, (cols.length || 1) * COL_DX + 40, benchWidth)
  const benchY = TASK_Y0 + maxRows * ROW_DY + 18
  const height = benchY + BENCH_CHIP_H + 28
  const bossCx = width / 2

  const benchPos = new Map<string, { x: number; y: number }>()
  benchList.forEach((m, i) => {
    benchPos.set(m.id, { x: 16 + i * (BENCH_CHIP_W + BENCH_GAP), y: benchY })
  })

  // 队长→成员通讯虚线（工作中→任务卡，待命→长凳）
  const commEdges: Edge[] = members.filter(m => !m.boss).map(m => {
    let x2: number; let y2: number
    if (activeTaskOf.has(m.id)) {
      const t = activeTaskOf.get(m.id)!
      const p = taskPos.get(t.id)!
      x2 = p.x + TASK_W - 30
      y2 = p.y - 10
    } else {
      const bp = benchPos.get(m.id)
      if (!bp) {return null as any}
      x2 = bp.x + BENCH_CHIP_W / 2
      y2 = bp.y
    }
    const d = `M ${bossCx} ${BOSS_Y + CARD_H} C ${bossCx} ${BOSS_Y + CARD_H + 40}, ${x2} ${y2 - 46}, ${x2} ${y2}`
    return { key: `comm-${m.id}`, d, color: '#d1d5db' }
  }).filter(Boolean)

  // 任务→任务依赖线
  const depEdges: Edge[] = viewTasks.flatMap(t => {
    const tp = taskPos.get(t.id)
    if (!tp) {return []}
    return (t.blockedBy || []).filter((d: string) => taskPos.has(d)).map((depId: string): Edge => {
      const dp = taskPos.get(depId)!
      const dep = viewTasks.find(x => x.id === depId)!
      const color = dep.status === 'done' ? '#a16207'
        : dep.status === 'running' || dep.status === 'claimed' ? '#dc2626' : '#9ca3af'
      return {
        key: `dep-${depId}-${t.id}`,
        d: `M ${dp.x + TASK_W} ${dp.y + TASK_H / 2} C ${dp.x + TASK_W + 26} ${dp.y + TASK_H / 2}, ${tp.x - 26} ${tp.y + TASK_H / 2}, ${tp.x} ${tp.y + TASK_H / 2}`,
        color,
        dashed: dep.status === 'done' ? '7 4' : '5 5',
      }
    })
  })

  const c = viewBoard.counts || {}
  const total = viewBoard.total ?? viewTasks.length
  const idleCount = members.filter(m => !m.boss && !activeTaskOf.has(m.id)).length
  const stats = [
    { label: '完成', value: `${c.done || 0}/${total}`, color: '#047857' },
    { label: '进行中', value: c.running || 0, color: '#b91c1c' },
    { label: '待批准', value: c.pending_approval || 0, color: '#92400e' },
    { label: '待领', value: c.pending || 0, color: '#6b7280' },
    { label: '待命', value: idleCount, color: '#6d28d9' },
    { label: '阻塞', value: c.blocked || 0, color: '#c2410c' },
  ]

  const colHeader = (wave: number, maxWave: number) => {
    if (wave === -1) {return '⛔ 依赖缺失'}
    if (wave === -2) {return '🔁 循环依赖'}
    if (wave === 0) {return '无依赖 · 立即做'}
    if (wave === maxWave && maxWave >= 2) {return '收尾'}
    return `第 ${wave + 1} 波`
  }
  const maxWave = Math.max(0, ...cols.map(x => x.wave).filter(w => w >= 0))

  // ── 通讯流 ──
  const [streamTab, setStreamTab] = useState<'all' | 'assign' | 'dm'>('all')
  const [memberFilter, setMemberFilter] = useState<string | null>(null)
  const untilTs = replay?.ts ?? null
  const mails = (mailStream || []).filter(m => !untilTs || m.ts <= untilTs)
  const events = (history || []).filter((e: any) => !untilTs || e.ts <= untilTs)
  const streamItems = useMemo<any[]>(() => {
    const mailItems: any[] = mails.map((m: any) => ({
      kind: 'mail', ts: m.ts,
      icon: m.kind === 'broadcast' ? '📣' : m.kind === 'system' ? '⚙️' : '✉️',
      from: m.from, to: m.to, subject: m.subject, body: m.body, id: m.id,
      cc: (m.cc || []) as string[],
    }))
    const assignItems: any[] = events.map((e: any) => ({
      kind: 'assign', ts: e.ts, id: `ev-${e.ts}-${e.taskId}`,
      taskId: e.taskId, title: e.title, from: e.from, to: e.to, by: e.by,
    }))
    const list = streamTab === 'assign' ? assignItems
      : streamTab === 'dm' ? mailItems
        : [...mailItems, ...assignItems]
    const filtered = memberFilter
      ? list.filter(it => it.kind === 'mail'
        ? it.from === memberFilter || it.to === memberFilter || it.cc.includes(memberFilter)
        : it.by === memberFilter)
      : list
    return filtered.sort((a, b) => b.ts - a.ts).slice(0, 120)
  }, [mails, events, streamTab, memberFilter])

  const seekTo = (idx: number) => {
    setPlayIdx(idx)
    setPlaying(false)
  }
  const seekEvent = (e: any) => {
    if (snaps.length === 0) {return}
    let best = 0; let bestDiff = Infinity
    snaps.forEach((s, i) => {
      const d = Math.abs(s.ts - e.ts)
      if (d < bestDiff) {bestDiff = d; best = i}
    })
    if (bestDiff > 15000 && e.ts < snaps[0].ts) {
      window.alert(`该事件发生在 ${HHMMSS(e.ts)}，早于可回放录制起点 ${HHMMSS(snaps[0].ts)}`)
      return
    }
    seekTo(best)
  }

  const streamPanel = (
    <div style={{
      width: 284, flexShrink: 0, border: '1px solid var(--border-light)', borderRadius: 10,
      background: '#fcfcfd', display: 'flex', flexDirection: 'column',
      maxHeight: 720, alignSelf: 'flex-start',
    }}>
      <div style={{ padding: '8px 10px 6px', borderBottom: '1px solid #eef0f2' }}>
        <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>
          通讯 <span style={{ color: '#9ca3af', fontWeight: 400 }}>{streamTab === 'assign' ? events.length : streamTab === 'dm' ? mails.length : mails.length + events.length} 条</span>
        </div>
        <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
          {([['all', '全部'], ['assign', '指派'], ['dm', '私信']] as const).map(([k, l]) => (
            <button key={k} onClick={() => setStreamTab(k)} style={{
              flex: 1, fontSize: 10.5, padding: '3px 0', borderRadius: 6, cursor: 'pointer',
              border: streamTab === k ? 'none' : '1px solid #d1d5db',
              background: streamTab === k ? '#ec4899' : '#fff',
              color: streamTab === k ? '#fff' : '#374151',
            }}>{l}</button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          <button onClick={() => setMemberFilter(null)} style={{
            fontSize: 9.5, padding: '1px 7px', borderRadius: 8, cursor: 'pointer',
            border: memberFilter === null ? 'none' : '1px solid #d1d5db',
            background: memberFilter === null ? '#374151' : '#fff',
            color: memberFilter === null ? '#fff' : '#6b7280',
          }}>全部成员</button>
          {members.filter(m => !m.boss).map(m => {
            const n = counts[m.id] || 0
            const active = memberFilter === m.id
            return (
              <button key={m.id} onClick={() => setMemberFilter(active ? null : m.id)} style={{
                fontSize: 9.5, padding: '1px 7px', borderRadius: 8, cursor: 'pointer',
                border: active ? 'none' : '1px solid #d1d5db',
                background: active ? '#374151' : n ? '#ecfdf5' : '#fff',
                color: active ? '#fff' : n ? '#059669' : '#6b7280',
              }}>{m.icon} {m.name}{n ? ` ${n}` : ''}</button>
            )
          })}
        </div>
      </div>
      <div style={{ overflowY: 'auto', flex: 1, padding: '6px 8px', minHeight: 200 }}>
        {streamItems.length === 0 && (
          <div style={{ fontSize: 11, color: '#9ca3af', textAlign: 'center', padding: '24px 0' }}>
            {replay ? '该时刻暂无通讯' : '暂无通讯——成员私信/广播/任务指派都会出现在这里'}
          </div>
        )}
        {streamItems.map(it => (
          <div key={it.id} style={{
            fontSize: 10.5, padding: '6px 7px', borderRadius: 7, marginBottom: 5,
            background: it.kind === 'assign' ? '#f5f3ff'
              : it.icon === '📣' ? '#fef2f2' : '#fff',
            border: '1px solid #eef0f2',
          }}>
            <div style={{ fontWeight: 600, lineHeight: 1.35, color: '#374151' }}>
              {it.kind === 'assign'
                ? <>📌 <span style={{ color: '#6d28d9' }}>#{String(it.taskId).replace(/^t/, '')} {it.title}</span>
                  <span style={{ color: '#9ca3af', fontWeight: 400 }}> · {it.from}→{it.to}（{it.by}）</span></>
                : <>{it.icon} {it.from} → {it.to}：{it.subject}</>}
            </div>
            {it.kind === 'mail' && it.body && (
              <div style={{
                color: '#6b7280', marginTop: 2, lineHeight: 1.4,
                display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                whiteSpace: 'pre-wrap',
              }}>{it.body}</div>
            )}
            <div style={{ color: '#b0b4bb', fontSize: 9, marginTop: 2 }}>{HHMMSS(it.ts)}</div>
          </div>
        ))}
      </div>
    </div>
  )

  return (
    <div style={{ fontSize: 12, display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <div style={{ flex: 1, minWidth: 460 }}>
        {/* 顶部统计 + 回放控制 */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 8, fontSize: 11, flexWrap: 'wrap', alignItems: 'center' }}>
          {stats.map(s => (
            <div key={s.label} style={{
              background: 'var(--surface-100)', border: '1px solid var(--border-light)',
              borderRadius: 8, padding: '4px 10px', textAlign: 'center',
            }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: s.color }}>{s.value}</div>
              <div style={{ color: '#9ca3af' }}>{s.label}</div>
            </div>
          ))}
          <div style={{ flex: 1, minWidth: 120 }} />

          {/* v3.32 回放控制 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 5,
            background: replay ? '#fef3c7' : 'var(--surface-100)',
            border: `1px solid ${replay ? '#fde68a' : 'var(--border-light)'}`,
            borderRadius: 8, padding: '4px 8px' }}>
            <button
              className="lumina-mini-btn"
              style={{ fontSize: 11, padding: '2px 8px' }}
              disabled={snaps.length < 2}
              title={snaps.length < 2 ? '正在录制快照…' : '播放/暂停回放'}
              onClick={() => {
                if (playIdx === null) {setPlayIdx(snaps.length - 1)}
                setPlaying(p => !p)
              }}>
              {playing ? '⏸' : '▶'}
            </button>
            {[0.5, 1, 2, 4].map(s => (
              <button key={s} className="lumina-mini-btn"
                style={{
                  fontSize: 10, padding: '2px 5px',
                  background: speed === s && replay ? '#374151' : '#fff',
                  color: speed === s && replay ? '#fff' : '#374151',
                  border: '1px solid #d1d5db',
                }}
                onClick={() => setSpeed(s)}>{s}×</button>
            ))}
            <input
              type="range" min={0} max={Math.max(0, snaps.length - 1)}
              value={playIdx ?? Math.max(0, snaps.length - 1)}
              disabled={snaps.length < 2}
              onChange={e => seekTo(Number(e.target.value))}
              style={{ width: 120, margin: '0 4px' }}
              title="回放时间轴 · 点击跳转"
            />
            <span style={{ fontSize: 10, color: '#6b7280', minWidth: 56 }}>
              {snaps.length ? HHMMSS((replay || snaps[snaps.length - 1]).ts) : '--:--:--'}
            </span>
            {replay && (
              <button className="lumina-mini-btn" style={{ fontSize: 10, padding: '2px 7px', borderColor: '#f59e0b', color: '#92400e' }}
                onClick={() => {setPlayIdx(null); setPlaying(false)}}>
                回到实时
              </button>
            )}
          </div>
        </div>

        {replay && (
          <div style={{ fontSize: 10, color: '#92400e', marginBottom: 6, background: '#fffbeb',
            border: '1px solid #fde68a', borderRadius: 6, padding: '3px 8px' }}>
            🕘 回放中（{HHMMSS(replay.ts)}）：画面冻结为历史快照，通讯流也只显示该时刻之前；点「回到实时」返回直播。
          </div>
        )}

        <div style={{ overflowX: 'auto', border: '1px solid var(--border-light)', borderRadius: 10, background: '#fcfcfd' }}>
          <div style={{ position: 'relative', width, height }}>
            {/* 连线层 */}
            <svg width={width} height={height} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
              {commEdges.map(e => (
                <path key={e.key} d={e.d} fill="none" stroke="#c7cbd1" strokeWidth={1.2}
                  strokeDasharray="3 5" />
              ))}
              {depEdges.map(e => (
                <path key={e.key} d={e.d} fill="none" stroke={e.color} strokeWidth={1.8}
                  strokeDasharray={e.dashed} strokeLinecap="round" />
              ))}
            </svg>

            {/* 队长节点 */}
            <MemberCard m={members[0]} x={bossCx - CARD_W / 2} y={BOSS_Y}
              state={memberState('lumina')} unread={counts.lumina || 0} boss />

            {/* 任务列（成员头像站在卡上） */}
            {cols.map((col, ci) => (
              <div key={col.wave}>
                <div style={{
                  position: 'absolute', top: HEADER_Y, left: 16 + ci * COL_DX, width: TASK_W,
                  fontSize: 11, fontWeight: 700, color: col.wave < 0 ? '#c2410c' : '#374151',
                  borderBottom: '2px solid #e5e7eb', paddingBottom: 4,
                }}>
                  {colHeader(col.wave, maxWave)}
                  <span style={{ color: '#9ca3af', fontWeight: 400 }}>（{col.items.length}）</span>
                </div>
                {col.items.map(t => {
                  const p = taskPos.get(t.id)!
                  const meta = STATUS_META[t.status] || STATUS_META.pending
                  const ownerMeta = t.owner ? memberMeta.get(t.owner) : null
                  const standing = ownerMeta && ['claimed', 'running', 'blocked'].includes(t.status)
                  const unmet = (t.blockedBy || []).filter((d: string) => {
                    const dt = viewTasks.find(x => x.id === d)
                    return !dt || dt.status !== 'done'
                  })
                  const justUnlocked = t.status === 'pending'
                    && (t.blockedBy || []).length > 0 && unmet.length === 0
                  const active = t.status === 'running'
                  return (
                    <div key={t.id} style={{
                      position: 'absolute', left: p.x, top: p.y, width: TASK_W, minHeight: TASK_H,
                      background: '#fff', border: `1.5px solid ${meta.dot}`,
                      borderLeft: `4px solid ${meta.dot}`,
                      borderRadius: 8, padding: standing ? '20px 9px 7px' : '7px 9px',
                      boxShadow: active ? '0 0 0 3px rgba(220,38,38,0.12)' : '0 1px 2px rgba(0,0,0,0.05)',
                    }}>
                      {/* 站在任务卡上的成员头像 */}
                      {standing && (
                        <div style={{ position: 'absolute', top: -13, right: 8, display: 'flex', alignItems: 'center', gap: 3 }}>
                          <span title={`${ownerMeta!.name} · ${memberState(t.owner!).label}`} style={{
                            width: 26, height: 26, borderRadius: 26, fontSize: 15, lineHeight: '26px',
                            textAlign: 'center', background: '#fff',
                            border: `2px solid ${active ? '#dc2626' : meta.dot}`,
                            boxShadow: active ? '0 0 0 3px rgba(220,38,38,0.15)' : '0 1px 2px rgba(0,0,0,0.12)',
                            animation: active ? 'luminaPulse 0.9s ease-in-out infinite' : undefined,
                          }}>{ownerMeta!.icon}</span>
                          <span style={{
                            fontSize: 9, fontWeight: 700, color: meta.dot,
                            background: '#fff', padding: '0 4px', borderRadius: 6,
                            border: `1px solid ${meta.dot}`,
                          }}>{ownerMeta!.name}</span>
                        </div>
                      )}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 10, color: '#9ca3af', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 4 }}>
                          {justUnlocked && <span title="前置依赖已全部完成，可领取" style={{
                            width: 7, height: 7, borderRadius: 7, background: '#10b981',
                            boxShadow: '0 0 0 2px rgba(16,185,129,0.2)',
                          }} />}
                          #{t.id.replace(/^t/, '')}
                        </span>
                        <span style={{
                          fontSize: 10, padding: '1px 7px', borderRadius: 8,
                          background: meta.bg, color: meta.fg, fontWeight: 600,
                        }}>{meta.label}</span>
                      </div>
                      <div style={{
                        fontSize: 11, fontWeight: 600, margin: '3px 0', lineHeight: 1.35,
                        display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                      }}>{t.title}</div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 10, color: '#6b7280' }}>
                          {!standing && ownerMeta ? `${ownerMeta.icon} ${ownerMeta.name}` : !standing ? '无人认领' : ''}
                        </span>
                        <span style={{ display: 'flex', gap: 3 }}>
                          {t.status === 'pending_approval' && (
                            <>
                              <button className="lumina-mini-btn lumina-mini-ok"
                                onClick={() => onAction('approve', { id: t.id, owner: 'lumina' })}>批准</button>
                              <button className="lumina-mini-btn"
                                onClick={() => onAction('reject', { id: t.id, owner: 'lumina' })}>驳回</button>
                            </>
                          )}
                          {t.status === 'pending' && (
                            <button className="lumina-mini-btn"
                              onClick={() => onAction('claim', { id: t.id, owner: 'lumina' })}>认领</button>
                          )}
                          {t.owner === 'lumina' && (t.status === 'claimed' || t.status === 'running') && (
                            <>
                              <button className="lumina-mini-btn"
                                onClick={() => onAction('complete', { id: t.id, owner: 'lumina' })}>完成</button>
                              <button className="lumina-mini-btn"
                                onClick={() => onAction('release', { id: t.id, owner: 'lumina' })}>释放</button>
                            </>
                          )}
                        </span>
                      </div>
                      {unmet.length > 0 && (
                        <div style={{ fontSize: 9, color: '#9ca3af', marginTop: 3 }}>
                          依赖 {unmet.map((d: string) => `#${d.replace(/^t/, '')}`).join(' ')}
                        </div>
                      )}
                      {justUnlocked && (
                        <div style={{ fontSize: 9, color: '#059669', marginTop: 3, fontWeight: 600 }}>
                          ● 前置依赖已完成，可领取
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            ))}

            {/* 待命区长凳 */}
            <div style={{
              position: 'absolute', left: 0, top: benchY - 22, width,
              fontSize: 11, fontWeight: 700, color: '#6d28d9',
            }}>
              <span style={{ marginLeft: 16 }}>🪑 待命区（{benchList.length}）— 任务板出现可认领任务时，成员会主动查看并认领</span>
            </div>
            {benchList.map(m => {
              const bp = benchPos.get(m.id)!
              const st = memberState(m.id)
              return (
                <div key={m.id} style={{
                  position: 'absolute', left: bp.x, top: bp.y, width: BENCH_CHIP_W, minHeight: BENCH_CHIP_H,
                  borderRadius: 10, background: '#faf8ff',
                  border: '1.5px solid #ddd6fe', padding: '5px 6px', textAlign: 'center',
                }}>
                  {m.dynamic && onShutdown && (
                    <button title="解散" onClick={e => {e.stopPropagation(); onShutdown(m.id)}}
                      style={{
                        position: 'absolute', top: -7, left: -7, width: 17, height: 17, borderRadius: 9,
                        border: '1px solid #d1d5db', background: '#fff', color: '#6b7280',
                        fontSize: 10, lineHeight: '14px', padding: 0, cursor: 'pointer',
                      }}>×</button>
                  )}
                  {(counts[m.id] || 0) > 0 && (
                    <span style={{
                      position: 'absolute', top: -7, right: -7, minWidth: 18, height: 18, padding: '0 4px',
                      borderRadius: 9, background: '#10b981', color: '#fff', fontSize: 10, fontWeight: 700,
                      lineHeight: '18px', boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                    }}>{counts[m.id]}</span>
                  )}
                  <div style={{ fontSize: 20, lineHeight: 1.1 }}>{m.icon}</div>
                  <div style={{ fontWeight: 700, fontSize: 10.5 }}>{m.name}</div>
                  <div style={{ fontSize: 9, color: st.color, fontWeight: 600 }}>{st.label}</div>
                </div>
              )
            })}

            {viewTasks.length === 0 && (
              <div style={{
                position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: '#9ca3af', fontSize: 12,
              }}>
                还没有任务——去「任务板」挂一个，或直接让 Lumina 派单
              </div>
            )}
          </div>
        </div>

        {/* 图例 */}
        <div style={{
          display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 8,
          fontSize: 10, color: '#6b7280', alignItems: 'center',
        }}>
          <span><svg width="26" height="8"><line x1="0" y1="4" x2="26" y2="4" stroke="#9ca3af" strokeWidth="1.8" strokeDasharray="5 5" /></svg> 依赖未满足</span>
          <span><svg width="26" height="8"><line x1="0" y1="4" x2="26" y2="4" stroke="#a16207" strokeWidth="1.8" strokeDasharray="7 4" /></svg> 依赖已满足</span>
          <span><svg width="26" height="8"><line x1="0" y1="4" x2="26" y2="4" stroke="#c7cbd1" strokeWidth="1.2" strokeDasharray="3 5" /></svg> 队长通讯链路</span>
          <span><span style={{
            display: 'inline-block', width: 14, height: 14, borderRadius: 14, background: '#fff',
            border: '2px solid #dc2626', fontSize: 9, lineHeight: '12px', textAlign: 'center',
          }}>👷</span> 成员站在任务上</span>
          <span><span style={{
            display: 'inline-block', width: 8, height: 8, borderRadius: 8, background: '#10b981',
          }} /> 刚解锁</span>
          <span><span style={{
            display: 'inline-block', width: 10, height: 10, borderRadius: 10, background: '#10b981',
            color: '#fff', fontSize: 8, textAlign: 'center', lineHeight: '10px',
          }}>3</span> 信箱未读</span>
        </div>

        {/* v3.30 成员检查器（动态 worker 详情） */}
        {viewWorkers.length > 0 && (
          <div style={{
            marginTop: 10, border: '1px solid var(--border-light)', borderRadius: 8,
            background: 'var(--surface-0)', padding: '8px 10px',
          }}>
            <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 6 }}>
              🧑‍🔧 临时工检查器（{viewWorkers.length} 位）
            </div>
            {viewWorkers.map((w: any) => (
              <div key={w.id} style={{
                display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
                fontSize: 10.5, padding: '3px 0', borderBottom: '1px dashed #f3f4f6',
              }}>
                <span>{w.icon} <b>{w.name}</b></span>
                <span style={{
                  padding: '0 6px', borderRadius: 8,
                  background: w.state === 'working' ? '#fee2e2'
                    : w.state === 'idle' ? '#ede9fe'
                      : w.state === 'shutdown_requested' ? '#f3f4f6' : '#f3f4f6',
                  color: w.state === 'working' ? '#b91c1c'
                    : w.state === 'idle' ? '#6d28d9' : '#6b7280',
                }}>{w.state}</span>
                <span style={{ color: '#6b7280' }}>
                  模型：{w.modelTier || 'strong'}{w.model ? `（${w.model}）` : '（主力）'}
                </span>
                {w.workdir && (
                  <span title={w.workdir} style={{
                    color: '#0369a1', maxWidth: 240,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>📁 {w.workdir}</span>
                )}
                {counts[w.id] ? <span style={{ color: '#059669' }}>未读 {counts[w.id]}</span> : null}
                <span style={{ flex: 1 }} />
                {!replay && onShutdown && (
                  <button className="lumina-mini-btn" onClick={() => onShutdown(w.id)}>解散</button>
                )}
              </div>
            ))}
          </div>
        )}

        {/* v3.32 事件时间轴（点击跳转到最近快照） */}
        {history && history.length > 0 && (
          <div style={{
            marginTop: 10, border: '1px solid var(--border-light)', borderRadius: 8,
            background: 'var(--surface-0)', padding: '8px 10px',
          }}>
            <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 6 }}>
              🕘 指派事件时间轴（最近 14 条，点击跳转回放）
            </div>
            <div style={{ display: 'flex', gap: 0, overflowX: 'auto', paddingBottom: 4 }}>
              {history.slice(-14).map((e, i, arr) => (
                <div key={i}
                  onClick={() => seekEvent(e)}
                  title="点击跳到该时刻"
                  style={{
                    display: 'flex', alignItems: 'flex-start', flex: '1, 0, 150px', minWidth: 150,
                    cursor: 'pointer', borderRadius: 6,
                  }}
                  onMouseEnter={(ev) => {ev.currentTarget.style.background = '#f3f4f6'}}
                  onMouseLeave={(ev) => {ev.currentTarget.style.background = 'transparent'}}>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 22 }}>
                    <span style={{
                      width: 9, height: 9, borderRadius: 9, marginTop: 2,
                      background: STATUS_META[e.to]?.dot || '#9ca3af',
                    }} />
                    {i < arr.length - 1 && <span style={{ width: 2, flex: 1, background: '#e5e7eb', minHeight: 12 }} />}
                  </div>
                  <div style={{ fontSize: 9.5, paddingBottom: 8, paddingRight: 6 }}>
                    <div style={{ color: '#9ca3af' }}>{HHMMSS(e.ts)}</div>
                    <div style={{ fontWeight: 600, lineHeight: 1.3 }}>
                      #{String(e.taskId).replace(/^t/, '')} {e.title}
                    </div>
                    <div style={{ color: '#6b7280' }}>{e.from} → {e.to} · {e.by}</div>
                  </div>
                </div>
              ))}
            </div>
            <div style={{ fontSize: 9, color: '#b0b4bb', marginTop: 2 }}>
              快照只在拓扑面板打开时录制（每秒检查，状态变化才存），保留最近 60 分钟 / 240 帧，跨重启保留。
            </div>
          </div>
        )}

        <style>{`
          .lumina-mini-btn {
            font-size: 10px; padding: 1px 6px; border-radius: 4px;
            border: 1px solid #d1d5db; background: #fff; cursor: pointer;
          }
          .lumina-mini-btn:disabled { opacity: 0.5; cursor: not-allowed; }
          .lumina-mini-btn:hover { background: #f9fafb; }
          .lumina-mini-ok { border-color: #6ee7b7; background: #ecfdf5; color: #047857; }
        `}</style>
      </div>

      {streamPanel}
    </div>
  )
}

function MemberCard({ m, x, y, state, unread, boss }: {
  m: { id: string; icon: string; name: string; title: string; dynamic?: boolean }
  x: number; y: number; state: { label: string; color: string }; unread: number; boss?: boolean
}) {
  const active = state.label.startsWith('执行中')
  return (
    <div style={{
      position: 'absolute', left: x, top: y, width: CARD_W, minHeight: CARD_H,
      borderRadius: 12, padding: '7px 6px', textAlign: 'center',
      background: boss ? 'linear-gradient(160deg,#fff1f7,#fce7f3)' : '#fff',
      border: `1.5px solid ${boss ? '#f9a8d4' : active ? '#dc2626' : '#e5e7eb'}`,
      boxShadow: active ? '0 0 0 3px rgba(220,38,38,0.12)' : '0 1px 3px rgba(0,0,0,0.06)',
    }}>
      {unread > 0 && (
        <span style={{
          position: 'absolute', top: -7, right: -7, minWidth: 18, height: 18, padding: '0 4px',
          borderRadius: 9, background: '#10b981', color: '#fff', fontSize: 10, fontWeight: 700,
          lineHeight: '18px', boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
        }}>{unread}</span>
      )}
      <div style={{ fontSize: 26, lineHeight: 1.1 }}>{m.icon}</div>
      <div style={{ fontWeight: 700, fontSize: 12, marginTop: 2 }}>{m.name}</div>
      <div style={{ fontSize: 9, color: '#9ca3af' }}>{m.title}</div>
      <div style={{
        fontSize: 9.5, marginTop: 3, color: state.color, fontWeight: 600,
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3,
      }}>
        <span style={{
          width: 6, height: 6, borderRadius: 6, background: state.color,
          animation: active ? 'luminaPulse 0.9s ease-in-out infinite' : undefined,
        }} />
        {state.label}
      </div>
      <style>{`@keyframes luminaPulse { 50% { opacity: 0.25; } }`}</style>
    </div>
  )
}
