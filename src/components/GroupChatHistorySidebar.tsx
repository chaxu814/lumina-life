// ============================================================
// GroupChatHistorySidebar.tsx — 群聊历史侧边栏 (v2.11)
// Extracted from ChatPanel.tsx (was lines ~1664-1812)
// Communicates with parent via window events to avoid prop drilling
// ============================================================

import React, { useState, useEffect } from 'react'
import { GCSession, loadGCSessions, saveGCSessions, newGCSessionId } from '../chat/chatShared'

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
    const newSession: GCSession = { id: newId, date: new Date().toLocaleDateString('zh-CN'), preview: '\u65B0\u7FA4\u804A', count: 0 }
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

  const sorted = [...sessions].sort((a, b) => {
    if ((a as any).pinned && !(b as any).pinned) return -1
    if (!(a as any).pinned && (b as any).pinned) return 1
    return 0
  })

  return (
    <div style={{ flex: 1, overflowY: 'auto', borderTop: '1px solid #e5e7eb', paddingTop: 4, display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '6px 12px', fontSize: 10, fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 1, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>{'\u7FA4\u804A\u8BB0\u5F55'}</span>
        <button onClick={handleNew} title={'\u65B0\u5EFA\u7FA4\u804A'}
          style={{ width: 20, height: 20, borderRadius: 4, border: '1px solid var(--border-light)', background: 'var(--surface-100)', cursor: 'pointer', fontSize: 14, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 }}>
          +
        </button>
      </div>
      {sorted.length === 0 && (
        <div style={{ padding: '12px', fontSize: 11, color: '#d1d5db', textAlign: 'center' }}>
          {'\u6682\u65E0\u5386\u53F2\u7FA4\u804A'}
        </div>
      )}
      {sorted.slice(0, 20).map(s => (
        <div key={s.id}
          className={'gc-history-item' + (s.id === activeId ? ' active' : '')}
          onClick={() => handleLoad(s)}
          onMouseEnter={() => setHoveredId(s.id)}
          onMouseLeave={() => setHoveredId(null)}
          style={{ display: 'flex', alignItems: 'center', gap: 4 }}
        >
          {(s as any).pinned && <span style={{ fontSize: 9, flexShrink: 0 }}>{'\uD83D\uDCCC'}</span>}
          <div style={{ flex: 1, minWidth: 0 }}>
            {editingId === s.id ? (
              <input
                value={editTitle}
                onChange={e => setEditTitle(e.target.value)}
                onBlur={() => commitRename(s)}
                onKeyDown={e => { if (e.key === 'Enter') commitRename(s) }}
                autoFocus
                onClick={e => e.stopPropagation()}
                style={{ width: '100%', fontSize: 11, padding: '2px 4px', border: '1px solid #3b82f6', borderRadius: 4, outline: 'none' }}
              />
            ) : (
              <>
                <div style={{ marginBottom: 1, fontSize: 11, fontWeight: (s as any).pinned ? 600 : 400 }}>{s.date}</div>
                <div style={{ fontSize: 10, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {s.preview || `${s.count} \u6761\u6D88\u606F`}
                </div>
              </>
            )}
          </div>
          {hoveredId === s.id && editingId !== s.id && (
            <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
              <button onClick={(e) => handlePin(s, e)} title={(s as any).pinned ? '\u53D6\u6D88\u7F6E\u9876' : '\u7F6E\u9876'}
                style={{ width: 18, height: 18, borderRadius: 3, border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 10, padding: 0 }}>
                {'\uD83D\uDCCC'}
              </button>
              <button onClick={(e) => handleRename(s, e)} title={'\u91CD\u547D\u540D'}
                style={{ width: 18, height: 18, borderRadius: 3, border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 10, padding: 0 }}>
                {'\u270F\uFE0F'}
              </button>
              <button onClick={(e) => handleDelete(s, e)} title={'\u5220\u9664'}
                style={{ width: 18, height: 18, borderRadius: 3, border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 10, padding: 0, color: '#ef4444' }}>
                {'\uD83D\uDDD1'}
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
