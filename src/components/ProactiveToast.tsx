// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// ProactiveToast.tsx — 主动引擎右上角弹窗 (v3.8.1)
//
// 显示 ProactiveEngine 的触发事件 (idle-10min, screen_watch, hot_topic...)
// 位置: 屏幕右上角，类似 macOS 通知中心风格
// ============================================================
import React, { useEffect, useState, useCallback } from 'react'

export interface ProactivePopupItem {
  id: string
  message: string
  type: string
  timestamp: number
  /** 自动消失倒计时 */
  closing?: boolean
}

const POPUP_DURATION_MS = 8000   // 8s 后自动消失
const MAX_VISIBLE = 3             // 最多同时显示 3 条

export default function ProactiveToast() {
  const [popups, setPopups] = useState<ProactivePopupItem[]>([])
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())

  // 监听来自主进程的 proactive:popup IPC
  useEffect(() => {
    const cleanup = window.luminaAPI?.onProactivePopup?.((payload: ProactivePopupItem) => {
      if (dismissed.has(payload.id)) {return}

      setPopups(prev => {
        const next = [...prev, { ...payload, closing: false }]
        if (next.length > MAX_VISIBLE) {next.shift()}
        return next
      })

      setTimeout(() => {
        setPopups(prev =>
          prev.map(p => p.id === payload.id ? { ...p, closing: true } : p)
        )
        setTimeout(() => {
          setPopups(prev => prev.filter(p => p.id !== payload.id))
        }, 300)
      }, POPUP_DURATION_MS)
    })

    return cleanup
  }, [dismissed])

  const dismiss = useCallback((id: string) => {
    setDismissed(prev => new Set([...prev, id]))
    setPopups(prev => prev.filter(p => p.id !== id))
  }, [])

  if (popups.length === 0) {return null}

  // 类型图标映射
  const typeIcons: Record<string, string> = {
    idle: '💤',
    screen_watch: '👀',
    hot_topic: '🔥',
    time: '⏰',
    event: '📢',
    opportunity: '💡',
    personal_rhythm: '🕐',
  }

  return (
    <div style={{
      position: 'fixed',
      top: 16,
      right: 16,
      zIndex: 100000,
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      pointerEvents: 'auto',
    }}>
      {popups.map(p => (
        <div
          key={p.id}
          onClick={() => dismiss(p.id)}
          style={{
            maxWidth: 340,
            padding: '14px 18px',
            borderRadius: 14,
            background: 'rgba(30, 30, 46, 0.95)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(99, 102, 241, 0.1)',
            cursor: 'pointer',
            opacity: p.closing ? 0 : 1,
            transform: p.closing ? 'translateX(20px)' : 'translateX(0)',
            transition: 'all 0.3s ease',
            color: '#e2e8f0',
            fontSize: 13,
            lineHeight: 1.5,
            display: 'flex',
            gap: 10,
            alignItems: 'flex-start',
          }}
        >
          <span style={{ fontSize: 18, flexShrink: 0, marginTop: 1 }}>
            {typeIcons[p.type] || '💬'}
          </span>
          <div style={{ flex: 1 }}>
            <div style={{
              fontSize: 10,
              color: 'rgba(255,255,255,0.4)',
              marginBottom: 4,
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
            }}>
              {p.type.replace(/_/g, ' ')}
            </div>
            <div>{p.message}</div>
          </div>
          <button
            onClick={(e) => { e.stopPropagation(); dismiss(p.id) }}
            style={{
              background: 'none',
              border: 'none',
              color: 'rgba(255,255,255,0.3)',
              cursor: 'pointer',
              fontSize: 16,
              padding: 0,
              lineHeight: 1,
              flexShrink: 0,
            }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
