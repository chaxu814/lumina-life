// ============================================================
// panels/RealityShowPanel.tsx — Agent 真人秀面板 v1.0
//
// 像一档 24/7 的真人秀节目，展示 Agent 们的"幕后生活"
// 包括：内心独白、互相互动、冲突、成就、梦境
// ============================================================

import React, { useState, useEffect, useRef, useCallback } from 'react'

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

interface ShowEvent {
  id: string
  type: string
  timestamp: number
  agents: string[]
  icon: string
  title: string
  content: string
  severity?: 'info' | 'notice' | 'drama'
}

// ═══════════════════════════════════════════════════════════
// 配置
// ═══════════════════════════════════════════════════════════

const SEVERITY_COLORS: Record<string, string> = {
  info: '#6b7280',
  notice: '#f59e0b',
  drama: '#ef4444',
}

const SEVERITY_BG: Record<string, string> = {
  info: 'var(--surface-0)',
  notice: 'var(--yellow-50)',
  drama: 'var(--red-50)',
}

const TYPE_LABELS: Record<string, string> = {
  'agent:thought': '💭 内心独白',
  'agent:interaction': '💬 互动',
  'agent:conflict': '⚡ 摩擦',
  'agent:achievement': '🏆 成就',
  'agent:dream': '🌙 梦境',
  'system:milestone': '🎬 里程碑',
}

// ═══════════════════════════════════════════════════════════
// RealityShowPanel
// ═══════════════════════════════════════════════════════════

export default function RealityShowPanel() {
  const [events, setEvents] = useState<ShowEvent[]>([])
  const [live, setLive] = useState(true)
  const [running, setRunning] = useState(true)
  const containerRef = useRef<HTMLDivElement>(null)

  // 加载历史
  const loadHistory = useCallback(async () => {
    try {
      const result = await window.luminaAPI?.realityHistory?.(100) ?? { events: [] }
      setEvents((result as any)?.events ?? [])
    } catch {}
  }, [])

  useEffect(() => { loadHistory() }, [loadHistory])

  // 检查运行状态
  useEffect(() => {
    window.luminaAPI?.realityStatus?.().then((r: any) => setRunning(r?.running ?? false)).catch(() => {})
  }, [])

  // 监听新事件
  useEffect(() => {
    const cleanup = window.luminaAPI?.onRealityEvent?.((event: ShowEvent) => {
      setEvents(prev => [event, ...prev].slice(0, 200))
      // 自动滚动到顶部
      if (live && containerRef.current) {
        containerRef.current.scrollTop = 0
      }
    })
    return () => { cleanup?.() }
  }, [live])

  // 手动触发事件
  const handleTrigger = async () => {
    try {
      const evt = await window.luminaAPI?.realityTrigger?.()
      if (evt) setEvents(prev => [evt as any, ...prev].slice(0, 200))
    } catch {}
  }

  // 切换运行状态
  const handleToggleRun = async () => {
    try {
      if (running) {
        await window.luminaAPI?.realityRestart?.(999999) // 很长的间隔 ≈ 暂停
        setRunning(false)
      } else {
        await window.luminaAPI?.realityRestart?.(60_000)
        setRunning(true)
      }
    } catch {}
  }

  const formatTime = (ts: number) => {
    const d = new Date(ts)
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }

  return (
    <div style={{ padding: 0, height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* ── 头部 ── */}
      <div style={{
        padding: '12px 16px', borderBottom: '1px solid var(--border-light)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        background: 'linear-gradient(135deg, #1e1b4b, #312e81)',
        color: '#e0e7ff',
      }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>🎬 Agent 真人秀 <span style={{ fontSize: 10, fontWeight: 600, padding: '1px 7px', borderRadius: 999, background: 'rgba(255,255,255,0.18)', color: '#fff' }}>🧪 实验彩蛋</span></div>
          <div style={{ fontSize: 10, opacity: 0.7, marginTop: 2 }}>
            实验彩蛋 · 由预设事件库随机生成的幕后日常（非模型自由发挥）· {events.length} 条记录
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={handleTrigger} style={{
            padding: '4px 10px', borderRadius: 6, border: 'none',
            background: 'rgba(255,255,255,0.15)', color: '#e0e7ff',
            cursor: 'pointer', fontSize: 11,
          }}>🎬 导播切一条</button>
          <button onClick={handleToggleRun} style={{
            padding: '4px 10px', borderRadius: 6, border: 'none',
            background: running ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.3)',
            color: running ? '#6ee7b7' : '#fca5a5',
            cursor: 'pointer', fontSize: 11,
          }}>{running ? '🔴 直播中' : '⏸ 已暂停'}</button>
        </div>
      </div>

      {/* ── 事件流 ── */}
      <div ref={containerRef} style={{
        flex: 1, overflowY: 'auto', padding: '12px 16px',
        display: 'flex', flexDirection: 'column', gap: 6,
      }}>
        {events.length === 0 ? (
          <div style={{
            textAlign: 'center', padding: 40, color: 'var(--text-secondary)',
          }}>
            <div style={{ fontSize: 40, marginBottom: 8 }}>🎬</div>
            <div style={{ fontSize: 14 }}>真人秀尚未开播</div>
            <div style={{ fontSize: 12, marginTop: 4 }}>点击「导播切一条」手动触发第一条</div>
          </div>
        ) : (
          events.map(evt => (
            <div key={evt.id} style={{
              padding: '8px 12px', borderRadius: 8,
              background: SEVERITY_BG[evt.severity ?? 'info'] ?? 'var(--surface-0)',
              borderLeft: `3px solid ${SEVERITY_COLORS[evt.severity ?? 'info'] ?? '#6b7280'}`,
              fontSize: 12,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                  {evt.icon} {evt.title}
                </span>
                <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
                  {formatTime(evt.timestamp)}
                </span>
              </div>
              <div style={{ color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                {evt.content}
              </div>
              <div style={{ marginTop: 4, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                <span style={{
                  padding: '1px 6px', borderRadius: 4, fontSize: 9,
                  background: 'rgba(107,114,128,0.1)', color: 'var(--text-secondary)',
                }}>
                  {TYPE_LABELS[evt.type] ?? evt.type}
                </span>
                {evt.agents.map(a => (
                  <span key={a} style={{
                    padding: '1px 6px', borderRadius: 4, fontSize: 9,
                    background: 'rgba(139,92,246,0.1)', color: '#a78bfa',
                  }}>{a}</span>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
