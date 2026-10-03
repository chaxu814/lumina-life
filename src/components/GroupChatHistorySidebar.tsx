// ============================================================
// GroupChatHistorySidebar.tsx — 群聊历史侧边栏 (v3.0)
// Redesigned to match ChatPanel conversation list style
// ============================================================

import React, { useState, useEffect } from 'react'
import { GCSession, loadGCSessions, saveGCSessions, newGCSessionId, formatDateLabel } from '../chat/chatShared'

export default function GroupChatHistorySidebar() {
  const [sessions, setSessions] = useState<GCSession[]>(() => {
    const raw = loadGCSessions()
    return raw.map(s => ({ ...s, pinned: (s as any).pinned || false }))
  })
  const [activeId, setActiveId] = useState(() => {
    const ss = loadGCSessions()
    return ss.length > 0 ? ss[0].id : ''
  })
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [hoveredId, setHoveredId] = useState<string | null>(null)

  useEffect(() => {
    const handler = () => {
      const raw = loadGCSessions()
      setSessions(raw.map(s => ({ ...s, pinned: (s as any).pinned || false })))
    }
    window.addEventListener('gc:sessions-updated', handler)
    return () => window.removeEventListener('gc:sessions-updated', handler)
  }, [])

  // Also sync activeId when a session is loaded externally
  useEffect(() => {
    const handler = (e: CustomEvent) => {
      setActiveId(e.detail)
    }
    window.addEventListener('gc:load-session', handler as any)
    return () => window.removeEventListener('gc:load-session', handler as any)
  }, [])

  const persistSessions = (updated: GCSession[]) => {
    setSessions(updated)
    saveGCSessions(updated)
    window.dispatchEvent(new Event('gc:sessions-updated'))
  }

  const handleLoad = (s: GCSession) => {
    setActiveId(s.id)
    window.dispatchEvent(new CustomEvent('gc:load-session', { detail: s.id }))
  }

  const handleNew = () => {
    const newId = newGCSessionId()
    // Auto-name: 团队群聊 #N
    const num = sessions.length + 1
    const newSession: GCSession = {
      id: newId,
      date: new Date().toLocaleDateString('zh-CN'),
      preview: `团队群聊 #${num}`,
      count: 0,
    }
    const updated = [newSession, ...sessions]
    persistSessions(updated)
    setActiveId(newId)
    window.dispatchEvent(new CustomEvent('gc:new-session', { detail: newId }))
  }

  const handleRename = (s: GCSession, e: React.MouseEvent) => {
    e.stopPropagation()
    setEditingId(s.id)
    setEditTitle(s.preview || s.date)
  }

  const commitRename = (s: GCSession) => {
    const updated = sessions.map(x => x.id === s.id ? { ...x, preview: editTitle || x.preview } : x)
    persistSessions(updated)
    setEditingId(null)
    window.dispatchEvent(new CustomEvent('gc:rename-session', { detail: { id: s.id, preview: editTitle } }))
  }

  const handleDelete = (s: GCSession, e: React.MouseEvent) => {
    e.stopPropagation()
    localStorage.removeItem(`lumina_gc_${s.id}`)
    const updated = sessions.filter(x => x.id !== s.id)
    persistSessions(updated)
    if (s.id === activeId) {
      const next = updated[0]
      if (next) {
        handleLoad(next)
      } else {
        handleNew()
      }
    }
  }

  const handlePin = (s: GCSession, e: React.MouseEvent) => {
    e.stopPropagation()
    const updated = sessions.map(x => x.id === s.id ? { ...x, pinned: !(x as any).pinned } : x)
    persistSessions(updated)
  }

  // Format time like ChatPanel: 只显示日期（今天 / 昨天 / MM-DD / YYYY-MM-DD），不显示时分
  const formatSessionTime = (dateStr: string): string => {
    // dateStr is like "2026/8/9" — try to parse and format
    try {
      const d = new Date(dateStr)
      if (isNaN(d.getTime())) {return dateStr}
      return formatDateLabel(d.getTime())
    } catch {
      return dateStr
    }
  }

  const sorted = [...sessions].sort((a, b) => {
    if ((a as any).pinned && !(b as any).pinned) {return -1}
    if (!(a as any).pinned && (b as any).pinned) {return 1}
    return 0
  })

  return (
    <div style={{
      flex: 1, overflowY: 'auto',
      borderTop: '1px solid var(--border-light)',
      paddingTop: 4, display: 'flex', flexDirection: 'column',
    }}>
      {/* Header */}
      <div style={{
        padding: '6px 12px',
        fontSize: 12, fontWeight: 700,
        color: 'var(--text-secondary)',
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 13 }}>💬</span>
          群聊记录
        </span>
        <button onClick={handleNew} title="新建群聊"
          style={{
            width: 22, height: 22, borderRadius: 6,
            border: '1px solid var(--border-light)',
            background: 'var(--surface-100)',
            cursor: 'pointer',
            fontSize: 14, color: 'var(--text-secondary)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            lineHeight: 1, transition: 'all 0.15s',
          }}
          onMouseEnter={e => {
            (e.currentTarget as HTMLElement).style.background = 'var(--accent-50, #eef2ff)'
            ;(e.currentTarget as HTMLElement).style.color = 'var(--accent-500, #6366f1)'
            ;(e.currentTarget as HTMLElement).style.borderColor = 'var(--accent-300, #a5b4fc)'
          }}
          onMouseLeave={e => {
            (e.currentTarget as HTMLElement).style.background = 'var(--surface-100)'
            ;(e.currentTarget as HTMLElement).style.color = 'var(--text-secondary)'
            ;(e.currentTarget as HTMLElement).style.borderColor = 'var(--border-light)'
          }}
        >
          +
        </button>
      </div>

      {/* Empty state */}
      {sorted.length === 0 && (
        <div style={{ padding: '16px 12px', fontSize: 11, color: 'var(--text-tertiary, #9ca3af)', textAlign: 'center' }}>
          暂无历史群聊
        </div>
      )}

      {/* Session list */}
      {sorted.slice(0, 20).map(s => {
        const isActive = s.id === activeId
        const isEditing = editingId === s.id
        const sessionTime = formatSessionTime(s.date)

        return (
          <div key={s.id}
            onClick={() => !isEditing && handleLoad(s)}
            onMouseEnter={() => setHoveredId(s.id)}
            onMouseLeave={() => setHoveredId(null)}
            style={{
              padding: '8px 10px',
              margin: '1px 6px',
              borderRadius: 6,
              cursor: 'pointer',
              background: isActive ? 'var(--accent-50, #eef2ff)' : 'transparent',
              border: isActive ? '1px solid var(--accent-200, #c7d2fe)' : '1px solid transparent',
              transition: 'all 0.12s',
              position: 'relative',
            }}
            onMouseOver={(e) => {
              if (!isActive) {
                (e.currentTarget as HTMLElement).style.background = 'var(--surface-100, #f3f4f6)'
              }
            }}
            onMouseOut={(e) => {
              if (!isActive) {
                (e.currentTarget as HTMLElement).style.background = 'transparent'
              }
            }}
          >
            {/* Pin indicator */}
            {(s as any).pinned && (
              <span style={{ position: 'absolute', top: 2, right: 4, fontSize: 9 }}>📌</span>
            )}

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                {/* Session title (editable) */}
                {isEditing ? (
                  <input
                    value={editTitle}
                    onChange={e => setEditTitle(e.target.value)}
                    onBlur={() => commitRename(s)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') {commitRename(s)}
                      if (e.key === 'Escape') { setEditingId(null) }
                    }}
                    autoFocus
                    onClick={e => e.stopPropagation()}
                    style={{
                      width: '100%', padding: '2px 4px', borderRadius: 4,
                      border: '1px solid var(--accent-400, #818cf8)', outline: 'none',
                      fontSize: 12, fontWeight: 600,
                      background: 'var(--surface-0, #fff)',
                      color: 'var(--text-primary, #111827)',
                    }}
                  />
                ) : (
                  <div style={{
                    fontSize: 13,
                    fontWeight: isActive ? 700 : 500,
                    color: isActive ? 'var(--accent-600, #4f46e5)' : 'var(--text-primary, #111827)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    lineHeight: 1.3,
                  }}>
                    {s.preview || `团队群聊`}
                  </div>
                )}

                {/* Meta line: time + message count */}
                <div style={{
                  fontSize: 10,
                  color: 'var(--text-secondary, #6b7280)',
                  marginTop: 2,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  display: 'flex', alignItems: 'center', gap: 4,
                }}>
                  <span>{sessionTime}</span>
                  <span style={{ opacity: 0.5 }}>·</span>
                  <span>{s.count || 0} 条消息</span>
                </div>
              </div>

              {/* Action buttons (on hover) */}
              {hoveredId === s.id && !isEditing && (
                <div style={{ display: 'flex', gap: 1, flexShrink: 0, marginLeft: 4 }}
                  onClick={e => e.stopPropagation()}>
                  <button
                    onClick={(e) => handlePin(s, e)}
                    title={(s as any).pinned ? '取消置顶' : '置顶'}
                    style={{
                      width: 20, height: 20, borderRadius: 4, border: 'none',
                      background: (s as any).pinned ? '#fef3c7' : 'transparent',
                      color: (s as any).pinned ? '#d97706' : 'var(--text-tertiary, #9ca3af)',
                      cursor: 'pointer', fontSize: 10,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}
                    onMouseEnter={e => {
                      if (!(s as any).pinned) {(e.currentTarget as HTMLElement).style.color = 'var(--text-primary, #111827)'}
                    }}
                    onMouseLeave={e => {
                      if (!(s as any).pinned) {(e.currentTarget as HTMLElement).style.color = 'var(--text-tertiary, #9ca3af)'}
                    }}
                  >
                    📌
                  </button>
                  <button
                    onClick={(e) => handleRename(s, e)}
                    title="重命名"
                    style={{
                      width: 20, height: 20, borderRadius: 4, border: 'none',
                      background: 'transparent',
                      color: 'var(--text-tertiary, #9ca3af)',
                      cursor: 'pointer', fontSize: 10,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}
                    onMouseEnter={e => {
                      (e.currentTarget as HTMLElement).style.color = 'var(--text-primary, #111827)'
                    }}
                    onMouseLeave={e => {
                      (e.currentTarget as HTMLElement).style.color = 'var(--text-tertiary, #9ca3af)'
                    }}
                  >
                    ✏️
                  </button>
                  <button
                    onClick={(e) => handleDelete(s, e)}
                    title="删除"
                    style={{
                      width: 20, height: 20, borderRadius: 4, border: 'none',
                      background: 'transparent',
                      color: 'var(--text-tertiary, #9ca3af)',
                      cursor: 'pointer', fontSize: 10,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}
                    onMouseEnter={e => {
                      (e.currentTarget as HTMLElement).style.color = '#ef4444'
                    }}
                    onMouseLeave={e => {
                      (e.currentTarget as HTMLElement).style.color = 'var(--text-tertiary, #9ca3af)'
                    }}
                  >
                    🗑
                  </button>
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
