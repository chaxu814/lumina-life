// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
import React, { useEffect, useState, useCallback } from 'react'

// ── IPC 调用 ──────────────────────────────────────────
//
// 🔧 2026-10-07：原先走 `window.electronAPI.ipcInvoke` —— 这个通用通道
//   preload 里**从不存在**，于是面板一直静默退回 mockData（假数据），
//   用户看到的"诊断"全是编的。现在改为调用正式暴露的
//   `window.luminaAPI.diagnostics.*`（见 preload.ts 的 diagnostics 命名空间）。

const CHANNEL_TO_METHOD: Record<string, string> = {
  'diagnostics:summary': 'summary',
  'diagnostics:quick-check': 'quickCheck',
  'diagnostics:timeline': 'timeline',
  'diagnostics:latency': 'latency',
  'diagnostics:tool-calls': 'toolCalls',
  'diagnostics:clear': 'clear',
  'diagnostics:export-report': 'exportReport',
}

async function ipcInvoke<T>(channel: string, ...args: any[]): Promise<T> {
  const api = (window as any).luminaAPI?.diagnostics
  const method = CHANNEL_TO_METHOD[channel]
  if (api && method && typeof api[method] === 'function') {
    return api[method](...args) as Promise<T>
  }
  // 兜底：某些环境可能仍暴露通用通道
  const generic = (window as any).electronAPI || (window as any).ipcInvoke
  if (generic?.ipcInvoke) {return generic.ipcInvoke(channel, ...args)}
  if (typeof generic === 'function') {return generic(channel, ...args)}
  console.warn('[DiagnosticsPanel] diagnostics IPC 不可用，使用模拟数据')
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
  if (channel === 'diagnostics:timeline') {return []}
  if (channel === 'diagnostics:latency') {return []}
  if (channel === 'diagnostics:export-report') {return { generatedAt: new Date().toISOString(), summary: {} }}
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

// ── 🩺 模型体检报告（对应 electron/core/modelHealthReport.ts）──
//   「本地 LLM 自适应容错」的对外窗口：把 modelServerFacts / modelCompat /
//   xmlToolCall 已经做到的兼容能力，翻译成用户能看懂的一句话结论。

type HealthLevel = 'ok' | 'notice' | 'warn' | 'blocker'

interface HealthCheck {
  id: string
  label: string
  level: HealthLevel
  summary: string
  advice?: string
  /** 结论来源（服务端报告 / 运行时实测 / 按模型名推测…）——决定可信度 */
  source: string
}

interface ModelHealthReport {
  modelName: string
  baseUrl: string
  isLocal: boolean
  level: HealthLevel
  headline: string
  capabilities: {
    contextWindow: number
    outputBudget: number
    supportsTools: boolean
    supportsVision: boolean
    isReasoning: boolean
    tier: string
    paramSizeB: number | null
  }
  userConfiguredContext: number | null
  checks: HealthCheck[]
  actions: string[]
  generatedAt: string
  error?: string
}

const LEVEL_META: Record<HealthLevel, { icon: string; label: string; color: string; bg: string }> = {
  blocker: { icon: '⛔', label: '阻断', color: '#e74c3c', bg: 'rgba(231,76,60,0.12)' },
  warn: { icon: '⚠️', label: '注意', color: '#e67e22', bg: 'rgba(230,126,34,0.12)' },
  notice: { icon: '💡', label: '提示', color: '#3498db', bg: 'rgba(52,152,219,0.12)' },
  ok: { icon: '✅', label: '正常', color: '#27ae60', bg: 'rgba(39,174,96,0.12)' },
}

// ═══════════════════════════════════════════════════════════

export default function DiagnosticsPanel() {
  const [summary, setSummary] = useState<DiagSummary | null>(null)
  const [checks, setChecks] = useState<DiagCheck[]>([])
  const [timeline, setTimeline] = useState<TimelineItem[]>([])
  const [latency, setLatency] = useState<LatencyBucket[]>([])
  const [tab, setTab] = useState<'overview' | 'latency' | 'timeline' | 'health'>('health')
  const [autoRefresh, setAutoRefresh] = useState(true)

  // 🩺 模型体检
  const [health, setHealth] = useState<ModelHealthReport | null>(null)
  const [healthLoading, setHealthLoading] = useState(false)
  const [healthCopied, setHealthCopied] = useState(false)

  /**
   * 加载模型体检报告。
   * 模型与端点取 **agent 配置**（lumina 那一份），因为它才是真正发请求的配置 ——
   * 设置面板的 provider 配置可能与之漂移（这正是 providerPersistence 测试守的点）。
   */
  const loadHealth = useCallback(async () => {
    setHealthLoading(true)
    try {
      const api = (window as any).luminaAPI
      let modelName = ''
      let baseUrl = ''
      let userContextWindow: number | null = null
      try {
        const all = await api?.agentLlmGetAllConfigs?.()
        const lumina = all?.lumina || all?.lumina?.config || null
        if (lumina) {
          modelName = lumina.model || ''
          baseUrl = lumina.endpoint || lumina.baseUrl || ''
          const ctx = Number(lumina.maxContextTokens ?? lumina.contextWindow ?? 0)
          userContextWindow = Number.isFinite(ctx) && ctx > 0 ? ctx : null
        }
      } catch { /* 读配置失败 → 让主进程给出「请先配置模型」 */ }

      const report = await api?.diagnostics?.modelHealth?.({ modelName, baseUrl, userContextWindow })
      setHealth(report || { error: '体检接口不可用' } as ModelHealthReport)
    } catch (e: any) {
      setHealth({ error: e?.message || String(e) } as ModelHealthReport)
    } finally {
      setHealthLoading(false)
    }
  }, [])

  const copyHealthText = useCallback(async () => {
    try {
      const api = (window as any).luminaAPI
      const all = await api?.agentLlmGetAllConfigs?.()
      const lumina = all?.lumina || null
      const text = await api?.diagnostics?.modelHealthText?.({
        modelName: lumina?.model || '',
        baseUrl: lumina?.endpoint || '',
        userContextWindow: Number(lumina?.maxContextTokens) > 0 ? Number(lumina.maxContextTokens) : null,
      })
      if (typeof text === 'string' && text) {
        await navigator.clipboard.writeText(text)
        setHealthCopied(true)
        setTimeout(() => setHealthCopied(false), 2000)
      }
    } catch (e) { console.warn('[DiagnosticsPanel] 复制体检报告失败', e) }
  }, [])

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
    if (!autoRefresh) {return}
    const interval = setInterval(loadAll, 3000)
    return () => clearInterval(interval)
  }, [loadAll, autoRefresh])

  // 🩺 体检报告按需加载：切到该 tab 时拉一次（不参与 3s 轮询 —— 它不随时间变）
  useEffect(() => {
    if (tab === 'health') {loadHealth()}
  }, [tab, loadHealth])

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
    if (diff < 1000) {return '刚刚'}
    if (diff < 60000) {return `${Math.round(diff / 1000)}秒前`}
    if (diff < 3600000) {return `${Math.round(diff / 60000)}分钟前`}
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
          <button style={styles.btn} onClick={() => { loadAll(); if (tab === 'health') {loadHealth()} }}>🔄 刷新</button>
          <button style={styles.btn} onClick={clearData}>🗑️ 清除</button>
          <button style={styles.btn} onClick={exportReport}>📥 导出</button>
        </div>
      </div>

      {/* ── Tab 切换 ── */}
      <div style={styles.tabs}>
        {(['health', 'overview', 'latency', 'timeline'] as const).map(t => (
          <button key={t} style={tabStyle(tab === t)} onClick={() => setTab(t)}>
            {t === 'health' ? '🩺 模型体检' : t === 'overview' ? '概览' : t === 'latency' ? '耗时' : '时间线'}
          </button>
        ))}
      </div>

      {/* ═══════ 🩺 模型体检 ═══════ */}
      {tab === 'health' && (
        <>
          {healthLoading && (
            <div style={{ padding: 16, fontSize: 12, color: 'var(--text-tertiary)' }}>正在生成体检报告…</div>
          )}

          {!healthLoading && health?.error && (
            <div style={styles.card}>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.8 }}>
                {health.error}
              </div>
            </div>
          )}

          {!healthLoading && health && !health.error && (
            <>
              {/* 结论卡 */}
              <div style={{
                ...styles.card,
                borderLeft: `3px solid ${LEVEL_META[health.level].color}`,
                background: LEVEL_META[health.level].bg,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <span style={{ fontSize: 16 }}>{LEVEL_META[health.level].icon}</span>
                  <span style={{ fontWeight: 600, fontSize: 13 }}>{health.headline}</span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
                  {health.modelName} · {health.baseUrl}{health.isLocal ? '（本地）' : ''}
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                  <button style={styles.btn} onClick={loadHealth}>重新体检</button>
                  <button style={styles.btn} onClick={copyHealthText}>
                    {healthCopied ? '✅ 已复制' : '📋 复制报告'}
                  </button>
                </div>
              </div>

              {/* 能力快照 */}
              <div style={styles.card}>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>🧬 能力画像</div>
                <div style={styles.row}>
                  <span style={styles.label}>上下文窗口</span>
                  <span style={styles.value}>{health.capabilities.contextWindow.toLocaleString()} tokens</span>
                </div>
                <div style={styles.row}>
                  <span style={styles.label}>单次输出上限</span>
                  <span style={styles.value}>{health.capabilities.outputBudget.toLocaleString()} tokens</span>
                </div>
                <div style={styles.row}>
                  <span style={styles.label}>原生工具调用</span>
                  <span style={{ ...styles.value, color: health.capabilities.supportsTools ? '#27ae60' : '#e67e22' }}>
                    {health.capabilities.supportsTools ? '支持' : '不支持（已自动切 XML 兼容）'}
                  </span>
                </div>
                <div style={styles.row}>
                  <span style={styles.label}>图片理解</span>
                  <span style={{ ...styles.value, color: health.capabilities.supportsVision ? '#27ae60' : 'var(--text-secondary)' }}>
                    {health.capabilities.supportsVision ? '支持' : '不支持'}
                  </span>
                </div>
                <div style={styles.row}>
                  <span style={styles.label}>模型档位</span>
                  <span style={styles.value}>
                    {health.capabilities.tier}
                    {health.capabilities.paramSizeB ? ` · ${health.capabilities.paramSizeB}B` : ''}
                    {health.capabilities.isReasoning ? ' · 推理模型' : ''}
                  </span>
                </div>
              </div>

              {/* 体检项 */}
              <div style={styles.card}>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>📋 逐项体检</div>
                {health.checks.map(c => (
                  <div key={c.id} style={{ padding: '7px 0', borderBottom: '1px solid var(--border-color)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span>{LEVEL_META[c.level].icon}</span>
                      <span style={{ fontWeight: 600, fontSize: 12 }}>{c.label}</span>
                      <span style={{
                        fontSize: 10, padding: '1px 6px', borderRadius: 4,
                        color: LEVEL_META[c.level].color, background: LEVEL_META[c.level].bg,
                      }}>{LEVEL_META[c.level].label}</span>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-primary)', marginTop: 3, lineHeight: 1.6 }}>
                      {c.summary}
                    </div>
                    {c.advice && (
                      <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2, lineHeight: 1.6 }}>
                        → {c.advice}
                      </div>
                    )}
                    <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 2 }}>
                      依据：{c.source}
                    </div>
                  </div>
                ))}
              </div>

              {/* 行动建议 */}
              {health.actions.length > 0 && (
                <div style={styles.card}>
                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>🎯 建议行动</div>
                  {health.actions.map((a, i) => (
                    <div key={i} style={{ fontSize: 12, color: 'var(--text-primary)', padding: '3px 0', lineHeight: 1.6 }}>
                      · {a}
                    </div>
                  ))}
                </div>
              )}

              <div style={{ fontSize: 10, color: 'var(--text-tertiary)', textAlign: 'center', padding: '4px 0' }}>
                生成于 {new Date(health.generatedAt).toLocaleString()}
              </div>
            </>
          )}
        </>
      )}

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
