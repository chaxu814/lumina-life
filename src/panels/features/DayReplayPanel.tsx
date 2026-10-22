// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// panels/features/DayReplayPanel.tsx — Day Replay（可回放的一天）
//
// 【这个面板回答的问题】
//   今天这一天到底干了什么：跑了多少轮、花了多少钱、委托了谁、
//   改了哪些文件 —— 聚合成一条可回看的时间线，可导出朋友圈素材。
//
// 【依赖】
//   数据走 IPC（dayreplay: 前缀，见 electron/dayreplay/ipc.ts 头注释）。
//   preload 白名单由集成阶段接入；未接线时面板显示「未启用」而不是白屏。
//   样式沿用 TheaterPanel / MoodProductivityPanel 的 CSS 变量，不引图表库。
// ============================================================

import React, { useCallback, useEffect, useState } from 'react'

// ── 样式 ──────────────────────────────────────────────────────

const card: React.CSSProperties = {
  borderRadius: 12,
  border: '1px solid var(--border-light)',
  padding: 20,
  marginBottom: 16,
  background: 'var(--surface-0)',
  fontFamily: '"Microsoft YaHei", "微软雅黑", sans-serif',
}
const title: React.CSSProperties = { fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }
const desc: React.CSSProperties = { fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.7, marginBottom: 12 }
const row: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }
const statBox: React.CSSProperties = {
  flex: '1 1 80px', minWidth: 90, borderRadius: 8,
  border: '1px solid var(--border-light)', padding: '8px 10px',
}
const statNum: React.CSSProperties = { fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }
const statLabel: React.CSSProperties = { fontSize: 10.5, color: 'var(--text-secondary)', marginTop: 2 }
const timeline: React.CSSProperties = { listStyle: 'none', padding: 0, margin: 0, maxHeight: 360, overflowY: 'auto' }
const itemRow: React.CSSProperties = { display: 'flex', gap: 8, padding: '5px 0', borderBottom: '1px dashed var(--border-light)', fontSize: 11.5, alignItems: 'baseline' }
const tsStyle: React.CSSProperties = { color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums', minWidth: 42 }
const empty: React.CSSProperties = { fontSize: 12, color: 'var(--text-secondary)', padding: '12px 0' }
const btn: React.CSSProperties = {
  fontSize: 11.5, padding: '5px 12px', borderRadius: 6, cursor: 'pointer',
  border: '1px solid var(--border-light)', background: 'var(--surface-1)', color: 'var(--text-primary)',
}

// ── 运行时类型（与主进程 DailyReplay 形状一致，不引入 electron） ──

type TimelineKind = 'command' | 'task' | 'delegate' | 'pet' | 'llm' | 'file' | 'todo' | 'system'

interface TimelineItemView {
  ts: number
  kind: TimelineKind
  title: string
  detail?: string
  actor?: string
  filesChanged?: string[]
}

interface DailyReplayView {
  date: string
  items: TimelineItemView[]
  stats: {
    commands: number; filesChanged: number; turns: number
    delegates: number; llmCalls: number
    costYuan: number; promptTokens: number; completionTokens: number
    byAgent: Record<string, number>; byPurpose: Record<string, number>
  }
  generatedAt: number
}

/** 防御性取 API：preload 白名单接入前也不报错 */
function api(): any {
  return (window as any).luminaAPI ?? {}
}

const KIND_META: Record<TimelineKind, { icon: string; color: string }> = {
  command: { icon: '⌘', color: '#64748b' },
  task: { icon: '✓', color: '#2563eb' },
  delegate: { icon: '👤', color: '#9333ea' },
  pet: { icon: '🐾', color: '#db2777' },
  llm: { icon: '🤖', color: '#16a34a' },
  file: { icon: '📄', color: '#ca8a04' },
  todo: { icon: '☑', color: '#ea580c' },
  system: { icon: '⚙', color: '#64748b' },
}

function todayLocal(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function hhmm(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export default function DayReplayPanel() {
  const [date, setDate] = useState(todayLocal())
  const [replay, setReplay] = useState<DailyReplayView | null>(null)
  const [notRegistered, setNotRegistered] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [exportMsg, setExportMsg] = useState<string | null>(null)

  const load = useCallback(async (d: string) => {
    setBusy(true)
    setError(null)
    try {
      const r = await api().dayreplayGet?.(d)
      if (r?.ok) {
        setReplay(r.replay)
        setNotRegistered(false)
      } else {
        setReplay(null)
        setNotRegistered(true)
        setError(r?.error ?? undefined)
      }
    } catch (e: any) {
      setError(String(e?.message || e))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {load(date)}, [date, load])

  const exportAs = useCallback(async (format: 'markdown' | 'text') => {
    setExportMsg(null)
    try {
      const r = await api().dayreplayExport?.({ date, format })
      if (r?.ok) {setExportMsg(`已导出：${r.path}`)}
      else {setExportMsg(r?.error ?? '导出失败')}
    } catch (e: any) {
      setExportMsg(String(e?.message || e))
    }
  }, [date])

  const s = replay?.stats

  return (
    <div style={card}>
      <div style={title}>Day Replay · 可回放的一天</div>
      <div style={desc}>
        把这一天做了什么、花了多少、委托了谁，聚合成一条时间线。
        数据全部来自本地记录，拿不到的部分不会补。
      </div>

      <div style={row}>
        <label style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>日期</label>
        <input
          type="date"
          value={date}
          onChange={e => setDate(e.target.value || todayLocal())}
          style={{ fontSize: 12, padding: '4px 8px' }}
        />
        <button style={btn} onClick={() => load(date)} disabled={busy}>
          {busy ? '加载中…' : '刷新'}
        </button>
        <button style={btn} onClick={() => exportAs('markdown')}>导出 Markdown</button>
        <button style={btn} onClick={() => exportAs('text')}>导出文本</button>
      </div>

      {notRegistered && (
        <div style={{ fontSize: 12, color: '#991b1b', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
          功能未启用{error ? `：${error}` : ''}
        </div>
      )}

      {replay && s && (
        <>
          <div style={row}>
            <div style={statBox}>
              <div style={statNum}>¥{s.costYuan.toFixed(4)}</div>
              <div style={statLabel}>花费</div>
            </div>
            <div style={statBox}>
              <div style={statNum}>{s.turns}</div>
              <div style={statLabel}>跑了几轮（共 {s.llmCalls} 次调用）</div>
            </div>
            <div style={statBox}>
              <div style={statNum}>{s.commands}</div>
              <div style={statLabel}>命令</div>
            </div>
            <div style={statBox}>
              <div style={statNum}>{s.filesChanged}</div>
              <div style={statLabel}>变更文件</div>
            </div>
            <div style={statBox}>
              <div style={statNum}>{s.delegates}</div>
              <div style={statLabel}>委托临时工</div>
            </div>
            <div style={statBox}>
              <div style={statNum}>{s.promptTokens + s.completionTokens}</div>
              <div style={statLabel}>tokens（{s.promptTokens}+{s.completionTokens}）</div>
            </div>
          </div>

          {Object.keys(s.byAgent).length > 0 && (
            <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginBottom: 12 }}>
              谁在出力：
              {Object.entries(s.byAgent)
                .sort((a, b) => b[1] - a[1])
                .map(([k, v]) => `${k} ${v} 轮`)
                .join(' ｜ ')}
            </div>
          )}

          {replay.items.length === 0 ? (
            <div style={empty}>这一天没有活动记录。</div>
          ) : (
            <ul style={timeline}>
              {replay.items.map((it, i) => {
                const meta = KIND_META[it.kind] ?? KIND_META.system
                return (
                  <li key={i} style={itemRow}>
                    <span style={tsStyle}>{hhmm(it.ts)}</span>
                    <span style={{ color: meta.color }}>{meta.icon}</span>
                    <span style={{ color: 'var(--text-primary)', flex: 1 }}>
                      {it.title}
                      {it.detail ? <span style={{ color: 'var(--text-secondary)' }}>（{it.detail}）</span> : null}
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
        </>
      )}

      {exportMsg && (
        <div style={{ fontSize: 11.5, color: '#166534', marginTop: 8 }}>{exportMsg}</div>
      )}
    </div>
  )
}
