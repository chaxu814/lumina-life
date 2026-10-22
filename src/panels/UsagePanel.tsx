// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
import React, { useMemo, useState } from 'react'
import { useStore } from '../stores/appStore'

export default function UsagePanel({ embedded }: { embedded?: boolean } = {}) {
  const tokenUsage = useStore((s) => s.tokenUsage)
  const setTokenLimit = useStore((s) => s.setTokenLimit)
  const resetDailyTokens = useStore((s) => s.resetDailyTokens)
  const removeHistoryEntry = useStore((s) => s.removeHistoryEntry)
  const clearTokenHistory = useStore((s) => s.clearTokenHistory)
  const llmConfig = useStore((s) => s.llmConfig)

  const [editingLimit, setEditingLimit] = useState(false)
  const [limitInput, setLimitInput] = useState('')
  const [limitEnabled, setLimitEnabled] = useState(true)

  const effectiveLimit = limitEnabled ? tokenUsage.limit : Infinity
  const todayPct = limitEnabled ? Math.min((tokenUsage.today / (tokenUsage.limit || 1)) * 100, 100) : 0

  const formatNum = (n: number) => n >= 1000000 ? `${(n / 1000000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n)

  const startEditLimit = () => {
    setLimitInput(String(tokenUsage.limit))
    setEditingLimit(true)
  }
  const saveLimit = () => {
    const val = parseInt(limitInput, 10)
    if (!isNaN(val) && val >= 0) {setTokenLimit(val)}
    setEditingLimit(false)
  }
  const cancelEditLimit = () => setEditingLimit(false)

  // ── 柱状图数据 ──────────────────────────────────

  const { daily, maxTokens } = useMemo(() => {
    interface DayStats { date: string; fullDate: string; tokens: number; requests: number }
    const map = new Map<string, DayStats>()
    for (const h of tokenUsage.history) {
      const day = h.date.slice(0, 10)
      const short = day.slice(5)
      if (!map.has(day)) {map.set(day, { date: short, fullDate: day, tokens: 0, requests: 0 })}
      const s = map.get(day)!
      s.tokens += h.tokens
      s.requests += 1
    }
    const daily = [...map.values()].slice(-14)
    const maxT = Math.max(1, ...daily.map(d => d.tokens))
    return { daily, maxTokens: maxT }
  }, [tokenUsage.history])

  const chartData = useMemo(() => {
    const W = 320; const H = 140
    const PAD = { top: 12, right: 12, bottom: 22, left: 36 }
    const chartW = W - PAD.left - PAD.right
    const chartH = H - PAD.top - PAD.bottom
    const barW = Math.max(4, Math.min(12, chartW / Math.max(daily.length, 1) * 0.7))
    const gap = chartW / Math.max(daily.length, 1)
    const yTicks = [0, Math.round(maxTokens * 0.5), Math.round(maxTokens)].map(v => Math.round(v))
    return { W, H, PAD, chartW, chartH, barW, gap, yTicks }
  }, [daily, maxTokens])

  const renderContent = () => (
    <div>
      {!embedded && (
        <div className="panel-header">
          <div className="panel-title">📊 用量</div>
          <div className="panel-subtitle">当前模型：{llmConfig.model} · 实时 Token 统计</div>
        </div>
      )}

      {/* 概览卡片 — 4列 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 24 }}>
        {[
          {
            label: '今日消耗', value: formatNum(tokenUsage.today),
            sub: limitEnabled ? `${todayPct.toFixed(1)}% 日限额` : '限额已禁用',
            color: limitEnabled
              ? (todayPct > 80 ? 'var(--red-500)' : todayPct > 50 ? 'var(--yellow-500)' : 'var(--green-500)')
              : 'var(--text-tertiary)',
          },
          { label: '累计总量', value: formatNum(tokenUsage.total), sub: '全部 Token 消耗' },
          { label: '使用模型', value: String((tokenUsage.byModel || []).length), sub: '不同模型数' },
          { label: '日限额', value: formatNum(tokenUsage.limit), sub: limitEnabled ? '已启用' : '已禁用' },
        ].map((s) => (
          <div key={s.label} className="card" style={{ padding: 16, textAlign: 'center' }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6 }}>{s.label}</div>
            <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: -0.5, color: s.color || 'var(--text-primary)' }}>{s.value}</div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>{s.sub}</div>
          </div>
        ))}
      </div>

      {/* 日限额自定义 — 可编辑 + 开关 */}
      <div className="card" style={{ marginBottom: 24, padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 600 }}>日限额设置</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {/* 启用/禁用开关 */}
            <button
              onClick={() => setLimitEnabled(!limitEnabled)}
              style={{
                padding: '3px 10px', borderRadius: 12, border: '1px solid var(--border)',
                background: limitEnabled ? 'var(--green-100)' : 'var(--surface-200)',
                color: limitEnabled ? 'var(--green-700)' : 'var(--text-tertiary)',
                fontSize: 11, fontWeight: 600, cursor: 'pointer', transition: 'all .15s',
              }}
            >
              {limitEnabled ? '✅ 已启用' : '⏸ 已禁用'}
            </button>
            <button
              onClick={resetDailyTokens}
              style={{
                padding: '3px 10px', borderRadius: 12, border: '1px solid var(--border)',
                background: 'var(--surface-100)', color: 'var(--text-secondary)',
                fontSize: 11, fontWeight: 600, cursor: 'pointer',
              }}
            >
              🔄 重置今日
            </button>
          </div>
        </div>

        {editingLimit ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <input
              type="number"
              value={limitInput}
              onChange={(e) => setLimitInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') {saveLimit();} if (e.key === 'Escape') {cancelEditLimit()} }}
              autoFocus
              style={{
                width: 120, padding: '4px 8px', borderRadius: 6,
                border: '1px solid var(--accent-500)', outline: 'none',
                fontSize: 13, fontFamily: 'var(--font-mono)',
              }}
            />
            <button onClick={saveLimit} style={{
              padding: '4px 10px', borderRadius: 6, border: 'none',
              background: 'var(--accent-500)', color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 600,
            }}>保存</button>
            <button onClick={cancelEditLimit} style={{
              padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)',
              background: 'var(--surface-0)', cursor: 'pointer', fontSize: 12,
            }}>取消</button>
          </div>
        ) : (
          <div
            onClick={startEditLimit}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6,
              cursor: 'pointer', padding: '4px 0',
            }}
            title="点击编辑日限额"
          >
            <span style={{ fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
              {tokenUsage.today.toLocaleString()} / {limitEnabled ? tokenUsage.limit.toLocaleString() : '∞'}
            </span>
            <span style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>✎ 点击修改</span>
          </div>
        )}

        {/* 进度条 (仅启用时限时显示) */}
        {limitEnabled && (
          <div className="progress-bar" style={{ height: 10, borderRadius: 5 }}>
            <div className="progress-bar-fill" style={{
              width: `${todayPct}%`, borderRadius: 5,
              background: todayPct > 80 ? 'var(--red-500)' : todayPct > 50 ? 'var(--yellow-500)' : 'var(--green-500)',
            }} />
          </div>
        )}
      </div>

      {/* 按模型分布 */}
      <div className="card" style={{ marginBottom: 24 }}>
        <div className="card-header">
          <span style={{ fontSize: 16 }}>🧩</span>
          <span className="card-title">按模型分布</span>
        </div>
        {tokenUsage.byModel.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 13 }}>
            暂无数据 — 开始对话后将自动统计
          </div>
        ) : (
          tokenUsage.byModel.sort((a, b) => b.tokens - a.tokens).map((m) => {
            const pct = tokenUsage.total > 0 ? (m.tokens / tokenUsage.total) * 100 : 0
            return (
              <div key={m.model} style={{ marginBottom: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{m.model}</span>
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
                    {m.tokens.toLocaleString()} · {pct.toFixed(1)}%
                  </span>
                </div>
                <div className="progress-bar">
                  <div className="progress-bar-fill" style={{ width: `${pct}%`, background: 'var(--accent-500)' }} />
                </div>
              </div>
            )
          })
        )}
      </div>

      {/* 用量趋势柱状图 — 内嵌 */}
      <div className="card" style={{ marginBottom: 24 }}>
        <div className="card-header" style={{ marginBottom: 12 }}>
          <span style={{ fontSize: 16 }}>📈</span>
          <span className="card-title">用量趋势</span>
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)', marginLeft: 8 }}>
            近{daily.length}天
          </span>
          {tokenUsage.lastResetDate && (
            <span style={{ fontSize: 10, color: 'var(--text-tertiary)', marginLeft: 8 }}>
              (今日重置: {tokenUsage.lastResetDate})
            </span>
          )}
        </div>
        {daily.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 13 }}>暂无数据</div>
        ) : (
          <div>
            {/* 柱状图 SVG */}
            <svg
              viewBox={`0 0 ${chartData.W} ${chartData.H}`}
              style={{ width: '100%', maxWidth: chartData.W, display: 'block', margin: '0 auto' }}
            >
              {/* Y 轴网格线 */}
              {chartData.yTicks.map((tick) => {
                const y = chartData.PAD.top + chartData.chartH
                  - (maxTokens > 0 ? (tick / maxTokens) * chartData.chartH : 0)
                return (
                  <g key={tick}>
                    <line x1={chartData.PAD.left} y1={y}
                      x2={chartData.PAD.left + chartData.chartW} y2={y}
                      stroke="#f3f4f6" strokeWidth={0.5} />
                    <text x={chartData.PAD.left - 6} y={y + 4}
                      textAnchor="end" fontSize={9} fill="#9ca3af" fontFamily="var(--font-mono)">
                      {tick >= 1000 ? `${(tick / 1000).toFixed(0)}K` : tick}
                    </text>
                  </g>
                )
              })}

              {/* 柱状条 */}
              {daily.map((d, i) => {
                const barH = maxTokens > 0 ? (d.tokens / maxTokens) * chartData.chartH : 0
                const x = chartData.PAD.left + i * chartData.gap + (chartData.gap - chartData.barW) / 2
                const y = chartData.PAD.top + chartData.chartH - barH
                return (
                  <g key={d.fullDate}>
                    <rect x={x} y={y} width={chartData.barW} height={Math.max(barH, 1)}
                      rx={2} fill="#3b82f6" opacity={0.85} />
                    <text x={x + chartData.barW / 2} y={chartData.PAD.top + chartData.chartH + 14}
                      textAnchor="middle" fontSize={8} fill="#9ca3af" fontFamily="var(--font-mono)">
                      {d.date}
                    </text>
                  </g>
                )
              })}
            </svg>

            {/* 统计摘要 */}
            <div style={{ display: 'flex', gap: 24, marginTop: 8, justifyContent: 'center', fontSize: 11 }}>
              <span><span style={{ color: 'var(--text-secondary)' }}>总计 </span>
                <b style={{ color: '#3b82f6' }}>{formatNum(tokenUsage.total)}</b></span>
              <span><span style={{ color: 'var(--text-secondary)' }}>今日 </span>
                <b style={{ color: '#f472b6' }}>{formatNum(tokenUsage.today)}</b></span>
              <span><span style={{ color: 'var(--text-secondary)' }}>请求 </span>
                <b>{tokenUsage.history.length}</b></span>
            </div>
          </div>
        )}
      </div>

      {/* 🆕 v5.3: 按 Agent 与按模型拆分 */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24 }}>
        {/* 按模型 */}
        <div className="card" style={{ padding: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 10 }}>
            🧩 按模型
          </div>
          {(!tokenUsage.byModel || tokenUsage.byModel.length === 0) ? (
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>暂无数据</div>
          ) : (
            tokenUsage.byModel
              .sort((a, b) => b.tokens - a.tokens)
              .slice(0, 8)
              .map((m) => {
                const pct = tokenUsage.total > 0 ? (m.tokens / tokenUsage.total * 100) : 0
                return (
                  <div key={m.model} style={{ marginBottom: 6 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 2 }}>
                      <span style={{ color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 120 }}>{m.model}</span>
                      <span style={{ fontWeight: 600, fontFamily: 'var(--font-mono)', fontSize: 10 }}>{formatNum(m.tokens)}</span>
                    </div>
                    <div style={{ height: 4, borderRadius: 2, background: 'var(--surface-200)', overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${Math.min(pct, 100)}%`, background: 'linear-gradient(90deg, #3b82f6, #8b5cf6)', borderRadius: 2, transition: 'width .3s' }} />
                    </div>
                  </div>
                )
              })
          )}
        </div>

        {/* 🆕 v5.3: 按 Agent */}
        <div className="card" style={{ padding: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 10 }}>
            👥 按 Agent
          </div>
          {(!tokenUsage.byAgent || tokenUsage.byAgent.length === 0) ? (
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>使用 search/chat 模式追踪…</div>
          ) : (
            tokenUsage.byAgent
              .sort((a, b) => b.tokens - a.tokens)
              .slice(0, 8)
              .map((a) => {
                const pct = tokenUsage.total > 0 ? (a.tokens / tokenUsage.total * 100) : 0
                const colors: Record<string, string> = { lumina: '#f472b6', recha: '#f97316', yak: '#3b82f6', user: '#10b981' }
                return (
                  <div key={a.agentId} style={{ marginBottom: 6 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 2 }}>
                      <span style={{ color: 'var(--text-secondary)' }}>{a.agentId}</span>
                      <span style={{ fontWeight: 600, fontFamily: 'var(--font-mono)', fontSize: 10 }}>{formatNum(a.tokens)}</span>
                    </div>
                    <div style={{ height: 4, borderRadius: 2, background: 'var(--surface-200)', overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${Math.min(pct, 100)}%`, background: colors[a.agentId] || 'var(--text-tertiary)', borderRadius: 2, transition: 'width .3s' }} />
                    </div>
                  </div>
                )
              })
          )}
        </div>
      </div>

      {/* 最近消耗历史 */}
      <div className="card">
        <div className="card-header">
          <span style={{ fontSize: 16 }}>📜</span>
          <span className="card-title">最近消耗记录</span>
          {tokenUsage.history.length > 0 && (
            <button
              onClick={clearTokenHistory}
              style={{
                marginLeft: 'auto', padding: '2px 8px', borderRadius: 10,
                border: '1px solid var(--red-200)', background: 'var(--red-50)',
                color: 'var(--red-500)', fontSize: 10, fontWeight: 600, cursor: 'pointer',
              }}
              title="清空全部记录"
            >🗑 清空</button>
          )}
        </div>
        {tokenUsage.history.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 13 }}>暂无记录</div>
        ) : (
          <div style={{ maxHeight: 200, overflowY: 'auto' }}>
            {[...tokenUsage.history].reverse().slice(0, 20).map((h, i) => {
              const originalIndex = tokenUsage.history.length - 1 - i
              return (
                <div key={originalIndex} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '6px 0', borderBottom: '1px solid var(--border-light)', fontSize: 12,
                }}>
                  <span style={{ color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)', fontSize: 11, width: 100 }}>{h.date}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)', width: 100 }}>{h.model}</span>
                  <span style={{ fontWeight: 600, fontFamily: 'var(--font-mono)', fontSize: 11 }}>{h.tokens.toLocaleString()} tokens</span>
                  <button
                    onClick={() => removeHistoryEntry(originalIndex)}
                    style={{
                      marginLeft: 8, padding: '0 4px', border: 'none', background: 'none',
                      color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: 14,
                      lineHeight: 1, borderRadius: 4,
                    }}
                    title="删除此记录"
                  >×</button>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )

  if (embedded) {return renderContent()}
  return <div className="panel">{renderContent()}</div>
}
