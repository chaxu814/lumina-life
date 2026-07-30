// ============================================================
// BookmarksPanel.tsx — 收藏夹面板 (v2.14)
// ============================================================
import React, { useEffect, useState, useCallback } from 'react'
import { loadBookmarks, removeBookmark, exportBookmarks, type BookmarkedMessage } from '../services/messageBookmarks'
import { showToast } from '../components/Toast'

export default function BookmarksPanel() {
  const [bookmarks, setBookmarks] = useState<BookmarkedMessage[]>([])
  const [search, setSearch] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<BookmarkedMessage | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const refresh = useCallback(() => {
    setBookmarks(loadBookmarks())
  }, [])

  useEffect(() => {
    refresh()
    const handler = () => refresh()
    window.addEventListener('bookmarks:changed', handler)
    return () => window.removeEventListener('bookmarks:changed', handler)
  }, [refresh])

  const filtered = search.trim()
    ? bookmarks.filter(b =>
        b.content.includes(search) ||
        b.fromName.includes(search) ||
        (b.tags || []).some(t => t.includes(search))
      )
    : bookmarks

  const handleCopy = async (content: string, id: string) => {
    try {
      await navigator.clipboard.writeText(content)
      setCopiedId(id)
      showToast('✅ 已复制到剪贴板', 'success')
      setTimeout(() => setCopiedId(null), 2000)
    } catch {
      showToast('复制失败', 'error')
    }
  }

  const handleDeleteConfirm = (bm: BookmarkedMessage) => {
    removeBookmark(bm.id)
    refresh()
    setDeleteTarget(null)
    showToast('已取消收藏', 'success')
  }

  const handleExport = () => {
    const json = exportBookmarks()
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `Lumina收藏_${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
    showToast('已导出 JSON', 'success')
  }

  const formatTime = (ts: number) => {
    const d = new Date(ts)
    return d.toLocaleString('zh-CN', {
      month: 'numeric', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 12px', borderRadius: 8,
    border: '1px solid var(--border-light)', fontSize: 13,
    background: 'var(--surface-100)', outline: 'none',
    boxSizing: 'border-box',
  }

  const actionBtn: React.CSSProperties = {
    padding: '3px 8px', borderRadius: 5, border: '1px solid var(--border-light)',
    background: 'var(--surface-0)', cursor: 'pointer', fontSize: 11,
    display: 'flex', alignItems: 'center', gap: 3,
    transition: 'background 0.15s',
  }

  return (
    <div style={{ padding: 20, height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexShrink: 0 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>⭐ 收藏夹</h2>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={refresh} style={actionBtn} title="刷新">🔄</button>
          <button onClick={handleExport} style={actionBtn} title="导出 JSON">📥 导出</button>
        </div>
      </div>

      {/* Search */}
      <div style={{ marginBottom: 12, flexShrink: 0 }}>
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="🔍 搜索收藏内容..."
          style={inputStyle}
        />
      </div>

      {/* List */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {bookmarks.length === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--text-secondary)', marginTop: 60 }}>
            <div style={{ fontSize: 40, marginBottom: 8 }}>📭</div>
            <div style={{ fontSize: 13 }}>还没有收藏任何消息</div>
            <div style={{ fontSize: 11, marginTop: 4 }}>
              在聊天中点击消息下方的 ⭐ 按钮即可收藏
            </div>
          </div>
        )}

        {filtered.length === 0 && search.trim() && (
          <div style={{ textAlign: 'center', color: 'var(--text-secondary)', marginTop: 40, fontSize: 13 }}>
            没有匹配的收藏
          </div>
        )}

        {filtered.map(bm => (
          <div key={bm.id} style={{
            background: 'var(--surface-100)', borderRadius: 10, padding: 12,
            marginBottom: 8, border: '1px solid var(--border-light)',
            transition: 'box-shadow 0.15s',
          }}
            onMouseEnter={e => (e.currentTarget as HTMLElement).style.boxShadow = '0 2px 8px rgba(0,0,0,0.06)'}
            onMouseLeave={e => (e.currentTarget as HTMLElement).style.boxShadow = 'none'}
          >
            {/* Header row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ fontSize: 16 }}>{bm.fromIcon}</span>
              <span style={{ fontWeight: 600, fontSize: 12, color: 'var(--text-primary)' }}>{bm.fromName}</span>
              <span style={{ fontSize: 10, color: 'var(--text-secondary)', flex: 1 }}>{formatTime(bm.timestamp)}</span>
              <span style={{
                fontSize: 10, padding: '1px 6px', borderRadius: 4,
                background: bm.source.startsWith('group:') ? '#ede9fe' : '#dbeafe',
                color: bm.source.startsWith('group:') ? '#7c3aed' : '#2563eb',
              }}>
                {bm.source.startsWith('group:') ? '群聊' : '对话'}
              </span>
            </div>

            {/* Content — 完整显示 */}
            <div style={{
              fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap',
              wordBreak: 'break-word', color: '#4b5563',
            }}>
              {bm.content}
            </div>

            {/* Actions */}
            <div style={{ display: 'flex', gap: 4, marginTop: 8 }}>
              <button onClick={() => handleCopy(bm.content, bm.id)}
                style={{ ...actionBtn, color: copiedId === bm.id ? '#059669' : 'var(--text-secondary)' }}>
                {copiedId === bm.id ? '✅ 已复制' : '📋 复制'}
              </button>
              <button onClick={() => setDeleteTarget(bm)} style={{
                ...actionBtn, color: 'var(--text-secondary)',
              }}>
                🗑️ 取消收藏
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Confirm dialog */}
      {deleteTarget && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 100000,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(0,0,0,0.3)',
        }} onClick={() => setDeleteTarget(null)}>
          <div style={{
            background: 'var(--surface-0)', borderRadius: 14, padding: 24,
            minWidth: 280, maxWidth: 400,
            boxShadow: '0 8px 30px rgba(0,0,0,0.15)',
          }} onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8, color: 'var(--text-primary)' }}>
              取消收藏
            </div>
            <div style={{
              fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6,
              maxHeight: 100, overflow: 'hidden', lineHeight: 1.5,
            }}>
              {deleteTarget.content.slice(0, 200)}{deleteTarget.content.length > 200 ? '...' : ''}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 20 }}>
              确定要取消收藏这条消息吗？
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setDeleteTarget(null)} style={{
                padding: '7px 16px', borderRadius: 8, border: '1px solid var(--border-light)',
                background: 'var(--surface-100)', cursor: 'pointer', fontSize: 13, color: 'var(--text-secondary)',
              }}>取消</button>
              <button onClick={() => handleDeleteConfirm(deleteTarget)} style={{
                padding: '7px 16px', borderRadius: 8, border: 'none',
                background: '#ef4444', cursor: 'pointer', fontSize: 13, fontWeight: 600,
                color: '#fff',
              }}>确认删除</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
