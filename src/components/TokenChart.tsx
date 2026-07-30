import React, { useMemo } from 'react'
import { useStore } from '../stores/appStore'

interface DayStats {
  date: string       // MM-DD
  fullDate: string   // YYYY-MM-DD
  tokens: number
  requests: number
}

export default function TokenChart({ onClose }: { onClose: () => void }) {
  const tokenUsage = useStore(s => s.tokenUsage)

  const { daily, maxTokens, maxReqs } = useMemo(() => {
    const map = new Map<string, DayStats>()
    for (const h of tokenUsage.history) {
      const day = h.date.slice(0, 10)   // YYYY-MM-DD
      const short = day.slice(5)        // MM-DD
      if (!map.has(day)) {
        map.set(day, { date: short, fullDate: day, tokens: 0, requests: 0 })
      }
      const s = map.get(day)!
      s.tokens += h.tokens
      s.requests += 1
    }
    const daily = [...map.values()].slice(-14) // 最近14天
    const maxTokens = Math.max(1, ...daily.map(d => d.tokens))
    const maxReqs   = Math.max(1, ...daily.map(d => d.requests))
    return { daily, maxTokens, maxReqs }
  }, [tokenUsage.history])

  const W = 340;  const H = 160;  const PAD = { top: 16, right: 16, bottom: 28, left: 44 }
  const chartW = W - PAD.left - PAD.right
  const chartH = H - PAD.top - PAD.bottom
  const barW  = Math.max(4, Math.min(12, chartW / daily.length * 0.7))
  const gap   = chartW / daily.length

  // Y 轴刻度
  const yTicksTokens = [0, maxTokens * 0.5, maxTokens].map(v => Math.round(v))
  const yTicksReqs   = [0, maxReqs * 0.5, maxReqs].map(v => Math.round(v))

  const formatNum = (n: number) => n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n)

  const barX = (i: number, offset: number) => PAD.left + i * gap + offset

  return (
    <div style={{
      position: 'absolute', top: 36, right: 12,
      background: 'var(--surface-0)', borderRadius: 12,
      boxShadow: '0 8px 32px rgba(0,0,0,.12)', border: '1px solid var(--border-light)',
      padding: 16, zIndex: 999, minWidth: W + 32,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div>
          <span style={{ fontWeight: 600, fontSize: 14 }}>📊 Token 用量</span>
          <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-secondary)' }}>近{daily.length}天</span>
        </div>
        <button onClick={onClose} style={{
          background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: 'var(--text-secondary)',
          lineHeight: 1, padding: '2px 6px', borderRadius: 4,
        }}>✕</button>
      </div>

      {/* Stats row */}
      <div style={{ display: 'flex', gap: 24, marginBottom: 12, fontSize: 12 }}>
        <div>
          <span style={{ color: 'var(--text-secondary)' }}>总计 </span>
          <b style={{ color: '#3b82f6' }}>{formatNum(tokenUsage.total)}</b>
        </div>
        <div>
          <span style={{ color: 'var(--text-secondary)' }}>今日 </span>
          <b style={{ color: '#f472b6' }}>{formatNum(tokenUsage.today)}</b>
        </div>
        <div>
          <span style={{ color: 'var(--text-secondary)' }}>请求 </span>
          <b>{tokenUsage.history.length}</b>
        </div>
      </div>

      {daily.length === 0 ? (
        <div style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: 24, fontSize: 13 }}>
          暂无数据，开始对话后自动记录
        </div>
      ) : (
        <svg width={W} height={H} style={{ display: 'block' }}>
          {/* Grid lines */}
          {[0, 0.5, 1].map(pct => (
            <line key={pct}
              x1={PAD.left} y1={PAD.top + chartH * (1 - pct)}
              x2={PAD.left + chartW} y2={PAD.top + chartH * (1 - pct)}
              stroke="#f3f4f6" strokeWidth={1}
            />
          ))}

          {/* Left Y: tokens */}
          {yTicksTokens.map((v, i) => (
            <text key={'t' + i} x={PAD.left - 6} y={PAD.top + chartH * (1 - i * 0.5) + 4}
              textAnchor="end" fontSize={9} fill="#9ca3af"
            >{formatNum(v)}</text>
          ))}
          <text x={-PAD.top - chartH / 2} y={12}
            transform={`rotate(-90)`} fontSize={9} fill="#3b82f6"
            textAnchor="middle"
          >Tokens</text>

          {/* Right Y: requests */}
          {yTicksReqs.map((v, i) => (
            <text key={'r' + i} x={PAD.left + chartW + 6} y={PAD.top + chartH * (1 - i * 0.5) + 4}
              textAnchor="start" fontSize={9} fill="#d1d5db"
            >{v}</text>
          ))}
          <text x={W - 10} y={12}
            transform={`rotate(90 ${W - 10} 12)`} fontSize={9} fill='#f472b6'
            textAnchor="middle"
          >请求</text>

          {/* Bars */}
          {daily.map((d, i) => {
            const tokenH = (d.tokens / maxTokens) * chartH
            const reqH   = (d.requests / maxReqs) * chartH

            return (
              <g key={d.fullDate}>
                {/* Token bar */}
                <rect
                  x={barX(i, -barW * 0.6)} y={PAD.top + chartH - tokenH}
                  width={barW} height={tokenH || 1} rx={2}
                  fill="#3b82f6" opacity={0.85}
                />
                {/* Request bar */}
                <rect
                  x={barX(i, barW * 0.4)} y={PAD.top + chartH - reqH}
                  width={barW} height={reqH || 1} rx={2}
                  fill="#f472b6" opacity={0.85}
                />
                {/* Date label */}
                <text x={barX(i, 0)} y={H - 8}
                  textAnchor="middle" fontSize={9} fill="#9ca3af"
                >{d.date}</text>
              </g>
            )
          })}
        </svg>
      )}

      {/* Legend */}
      <div style={{ display: 'flex', gap: 16, marginTop: 6, fontSize: 10, color: 'var(--text-secondary)', justifyContent: 'center' }}>
        <span><span style={{ color: '#3b82f6' }}>■</span> tokens</span>
        <span><span style={{ color: '#f472b6' }}>■</span> 请求数</span>
      </div>
    </div>
  )
}
