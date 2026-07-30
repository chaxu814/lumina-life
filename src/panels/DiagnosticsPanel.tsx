import React, { useEffect, useState, useCallback } from 'react'

// ── IPC 调用 ──────────────────────────────────────────

async function ipcInvoke<T>(channel: string, ...args: any[]): Promise<T> {
  // @ts-ignore — window.electronAPI 由 preload.js 注入
  const api = (window as any).electronAPI || (window as any).ipcInvoke
  if (api?.ipcInvoke) {
    return api.ipcInvoke(channel, ...args)
  }
  if (typeof api === 'function') {
    return api(channel, ...args)
  }
  console.warn('[DiagnosticsPanel] IPC 不可用，使用模拟数据')
  return mockData(channel, ...args) as T
}

// ── 模拟数据（IPC 不可用时回退）────────────────────

function mockData(channel: string, ...args: any[]): any {
  if (channel === 'diagnostics:summary') {
    return {
      totalRequests: 0, totalTokens: 0, avgLatencyMs: 0,
      toolCalls: 0, toolSuccessRate: 100, errors: 0, topTools: [],
    }
  }
  if (channel === 'diagnostics:quick-check') {
    return [{ name: 'IPC 不可用', pass: true, detail: 'Electron IPC 未连接，使用模拟模式' }]
  }
  if (channel === 'diagnostics:timeline') return []
  if (channel === 'diagnostics:latency') return []
  if (channel === 'diagnostics:export-report') return { generatedAt: new Date().toISOString(), summary: {} }
  return null
}

// ── 类型 ──────────────────────────────────────────────

interface DiagSummary {
  totalRequests: number
  totalTokens: number
  avgLatencyMs: number
  toolCalls: number
  toolSuccessRate: number
  errors: number
  topTools: Array<{ name: string; count: number }>
}

interface DiagCheck {
  name: string
  pass: boolean
  detail: string
}

interface TimelineItem {
  type: 'llm' | 'tool' | 'error'
  timestamp: string
  detail: string
}

interface LatencyBucket {
  time: string
  avgMs: number
  maxMs: number
  count: number
}

// ═══════════════════════════════════════════════════════════

export default function DiagnosticsPanel() {
  const [summary, setSummary] = useState<DiagSummary | null>(null)
  const [checks, setChecks] = useState<DiagCheck[]>([])
  const [timeline, setTimeline] = useState<TimelineItem[]>([])
  const [latency, setLatency] = useState<LatencyBucket[]>([])
  const [tab, setTab] = useState<'overview' | 'latency' | 'timeline'>('overview')
  const [autoRefresh, setAutoRefresh] = useState(true)

  // ── 加载数据 ──────────────────────────────────────

  const loadAll = useCallback(async () => {
    const [sum, chk, tl, lat] = await Promise.all([
      ipcInvoke<DiagSummary>('diagnostics:summary'),
      ipcInvoke<DiagCheck[]>('diagnostics:quick-check'),
      ipcInvoke<TimelineItem[]>('diagnostics:timeline', 30),
      ipcInvoke<LatencyBucket[]>('diagnostics:latency', 60),
    ])
    setSummary(sum)
    setChecks(chk)
    setTimeline(tl)
    setLatency(lat)
  }, [])

  useEffect(() => {
    loadAll()
    if (!autoRefresh) return
    const interval = setInterval(loadAll, 3000)
    return () => clearInterval(interval)
  }, [loadAll, autoRefresh])

  // ── 导出报告 ──────────────────────────────────────

  const exportReport = async () => {
    const report = await ipcInvoke<any>('diagnostics:export-report')
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `diagnostics-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  // ── 清除 ──────────────────────────────────────────

  const clearData = async () => {
    await ipcInvoke('diagnostics:clear')
    loadAll()
  }

  // ── 工具函数 ──────────────────────────────────────

  const formatNum = (n: number) =>
    n >= 1000000 ? `${(n / 1000000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n)

  const timeAgo = (ts: string) => {
    const diff = Date.now() - new Date(ts).getTime()
    if (diff < 1000) return '刚刚'
    if (diff < 60000) return `${Math.round(diff / 1000)}秒前`
    if (diff < 3600000) return `${Math.round(diff / 60000)}分钟前`
    return `${Math.round(diff / 3600000)}小时前`
  }

  // ── 样式 ──────────────────────────────────────────

  const tabStyle = (active: boolean): React.CSSProperties => ({
    padding: '4px 12px', border: 'none', borderRadius: 6,
    cursor: 'pointer', fontSize: 12,
    background: active ? 'var(--accent)' : 'var(--bg-tertiary)',
    color: active ? '#fff' : 'var(--text-primary)',
  })

  const checkRowStyle = (pass: boolean): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '6px 0', borderBottom: '1px solid var(--border-color)',
    color: pass ? 'var(--text-primary)' : '#e74c3c',
  })

  const latencyBarStyle = (pct: number): React.CSSProperties => ({
    height: 6, borderRadius: 3,
    background: `linear-gradient(90deg, var(--accent) ${pct}%, var(--bg-tertiary) ${pct}%)`,
    marginTop: 2,
  })

  const styles: Record<string, React.CSSProperties> = {
    container: { padding: 12, height: '100%', overflow: 'auto', fontSize: 13 },
    tabs: { display: 'flex', gap: 4, marginBottom: 12 },
    card: {
      background: 'var(--bg-secondary)', borderRadius: 8, padding: 12,
      marginBottom: 8,
    },
    row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0' },
    label: { color: 'var(--text-secondary)', fontSize: 12 },
    value: { fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600 },
    btn: {
      padding: '4px 10px', border: '1px solid var(--border-color)', borderRadius: 6,
      background: 'var(--bg-tertiary)', cursor: 'pointer', fontSize: 11,
      color: 'var(--text-primary)',
    },
    timelineItem: {
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '4px 0', borderBottom: '1px solid var(--border-color)',
      fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 1.4,
    },
  }

  // ═══════════════════════════════════════════════════════════

  return (
    <div style={styles.container}>
      {/* ── 标题 + 操作 ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>🩺 系统诊断</h3>
        <div style={{ display: 'flex', gap: 6 }}>
          <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
            <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} />
            自动刷新
          </label>
          <button style={styles.btn} onClick={loadAll}>🔄 刷新</button>
          <button style={styles.btn} onClick={clearData}>🗑️ 清除</button>
          <button style={styles.btn} onClick={exportReport}>📥 导出</button>
        </div>
      </div>

      {/* ── Tab 切换 ── */}
      <div style={styles.tabs}>
        {(['overview', 'latency', 'timeline'] as const).map(t => (
          <button key={t} style={tabStyle(tab === t)} onClick={() => setTab(t)}>
            {t === 'overview' ? '概览' : t === 'latency' ? '耗时' : '时间线'}
          </button>
        ))}
      </div>

      {/* ═══════ 概览 ═══════ */}
      {tab === 'overview' && (
        <>
          {/* ── 实时检查 ── */}
          {checks.length > 0 && (
            <div style={styles.card}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>🩺 快速检查</div>
              {checks.map((c, i) => (
                <div key={i} style={checkRowStyle(c.pass)}>
                  <span>{c.pass ? '✅' : '❌'}</span>
                  <span style={{ flex: 1 }}>{c.name}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{c.detail}</span>
                </div>
              ))}
            </div>
          )}

          {/* ── 汇总统计 ── */}
          {summary && (
            <div style={styles.card}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>📊 汇总</div>
              <div style={styles.row}>
                <span style={styles.label}>LLM 请求</span>
                <span style={styles.value}>{summary.totalRequests}</span>
              </div>
              <div style={styles.row}>
                <span style={styles.label}>总 Token 消耗</span>
                <span style={styles.value}>{formatNum(summary.totalTokens)}</span>
              </div>
              <div style={styles.row}>
                <span style={styles.label}>平均响应延迟</span>
                <span style={{ ...styles.value, color: summary.avgLatencyMs > 10000 ? '#e74c3c' : undefined }}>
                  {summary.avgLatencyMs}ms
                </span>
              </div>
              <div style={styles.row}>
                <span style={styles.label}>工具调用</span>
                <span style={styles.value}>{summary.toolCalls}</span>
              </div>
              <div style={styles.row}>
                <span style={styles.label}>工具成功率</span>
                <span style={{ ...styles.value, color: summary.toolSuccessRate < 80 ? '#e74c3c' : undefined }}>
                  {summary.toolSuccessRate}%
                </span>
              </div>
              <div style={styles.row}>
                <span style={styles.label}>错误次数</span>
                <span style={{ ...styles.value, color: summary.errors > 0 ? '#e74c3c' : undefined }}>
                  {summary.errors}
                </span>
              </div>
            </div>
          )}

          {/* ── 高频工具 ── */}
          {summary && summary.topTools.length > 0 && (
            <div style={styles.card}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>🔧 高频工具 TOP 10</div>
              {summary.topTools.map((t, i) => (
                <div key={i} style={styles.row}>
                  <span style={styles.label}>#{i + 1} {t.name}</span>
                  <span style={styles.value}>{t.count} 次</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* ═══════ 耗时仪表盘 ═══════ */}
      {tab === 'latency' && (
        <div style={styles.card}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>📈 LLM 响应耗时趋势</div>
          {latency.length === 0 ? (
            <div style={{ color: 'var(--text-secondary)', padding: 12, textAlign: 'center' }}>
              暂无数据 — 开始对话后将自动记录
            </div>
          ) : (
            latency.map((b, i) => (
              <div key={i} style={{ marginBottom: 4 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
                  <span style={{ color: 'var(--text-secondary)' }}>{b.time}</span>
                  <span style={{ fontFamily: 'var(--font-mono)' }}>
                    {b.avgMs}ms avg / {b.maxMs}ms max ({b.count} req)
                  </span>
                </div>
                <div style={latencyBarStyle(Math.min(b.avgMs / 50, 100))} />
              </div>
            ))
          )}
        </div>
      )}

      {/* ═══════ 时间线 ═══════ */}
      {tab === 'timeline' && (
        <div style={styles.card}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>📋 事件时间线 (近 30 条)</div>
          {timeline.length === 0 ? (
            <div style={{ color: 'var(--text-secondary)', padding: 12, textAlign: 'center' }}>
              暂无事件记录
            </div>
          ) : (
            timeline.map((item, i) => (
              <div key={i} style={styles.timelineItem}>
                <span>{item.type === 'llm' ? '🤖' : item.type === 'tool' ? '🔧' : '❌'}</span>
                <span style={{ color: 'var(--text-secondary)', width: 70, flexShrink: 0 }}>
                  {timeAgo(item.timestamp)}
                </span>
                <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {item.detail}
                </span>
              </div>
            ))
          )}
        </div>
      )}

      {/* ── 提示 ── */}
      <div style={{ marginTop: 12, fontSize: 11, color: 'var(--text-tertiary)', textAlign: 'center' }}>
        实时数据通过 IPC 从主进程拉取 · 数据仅保留最近 200 条事件
      </div>
    </div>
  )
}
