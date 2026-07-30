// ============================================================
// panels/SocialPanel.tsx — 跨用户社交面板 v1.0
//
// 展示 Lumina 社区的动态：梦境分享、成就展示、时光胶囊
// 当前为本地模式，未来可对接后端实现真实的跨用户社交
// ============================================================

import React, { useState, useEffect, useCallback } from 'react'
// DreamEntry is not exported as a named type — use any here
type DreamEntry = any

export default function SocialPanel() {
  const [dreams, setDreams] = useState<any[]>([])
  const [activeTab, setActiveTab] = useState<'feed' | 'share'>('feed')
  const [shareText, setShareText] = useState('')
  const [shareType, setShareType] = useState<'achievement' | 'dream' | 'thought'>('thought')

  useEffect(() => {
    // 加载最近的梦境作为"动态"
    window.luminaAPI?.dreamRecent?.(5).then((r: any) => setDreams(r?.dreams ?? [])).catch(() => {})
  }, [])

  const handleShare = () => {
    if (!shareText.trim()) return
    // 本地模式：将分享内容作为一条新动态加入列表
    const newPost = {
      id: `share_${Date.now()}`,
      type: 'user:share',
      timestamp: Date.now(),
      author: { name: '我', icon: '👤' },
      title: shareType === 'achievement' ? '🏆 成就分享' : shareType === 'dream' ? '🌙 梦境分享' : '💭 心情分享',
      content: shareText.trim(),
    }
    setDreams(prev => [newPost, ...prev])
    setShareText('')
  }

  const formatTime = (ts: number | string) => {
    const d = typeof ts === 'string' ? new Date(ts) : new Date(ts)
    return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
  }

  return (
    <div style={{ padding: 20, height: '100%', overflowY: 'auto' }}>
      {/* ── 头部 ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>🌐 社区动态</h2>
          <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '4px 0 0' }}>
            与你的 Agent 们分享生活点滴
          </p>
        </div>
      </div>

      {/* ── Tab ── */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button onClick={() => setActiveTab('feed')} style={{
          padding: '6px 14px', borderRadius: 6, border: 'none', fontSize: 12, cursor: 'pointer',
          background: activeTab === 'feed' ? '#8b5cf6' : 'var(--surface-100)',
          color: activeTab === 'feed' ? '#fff' : 'var(--text-secondary)',
        }}>📰 动态</button>
        <button onClick={() => setActiveTab('share')} style={{
          padding: '6px 14px', borderRadius: 6, border: 'none', fontSize: 12, cursor: 'pointer',
          background: activeTab === 'share' ? '#8b5cf6' : 'var(--surface-100)',
          color: activeTab === 'share' ? '#fff' : 'var(--text-secondary)',
        }}>✍️ 分享</button>
      </div>

      {/* ── 分享Tab ── */}
      {activeTab === 'share' && (
        <div style={{
          padding: 16, borderRadius: 8, marginBottom: 16,
          background: 'var(--surface-0)', border: '1px solid var(--border-light)',
        }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>分享你的故事</div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            {[
              { key: 'thought', label: '💭 心情' },
              { key: 'achievement', label: '🏆 成就' },
              { key: 'dream', label: '🌙 梦境' },
            ].map(t => (
              <button key={t.key} onClick={() => setShareType(t.key as any)} style={{
                padding: '3px 10px', borderRadius: 10, border: 'none', fontSize: 11, cursor: 'pointer',
                background: shareType === t.key ? '#8b5cf6' : 'var(--surface-100)',
                color: shareType === t.key ? '#fff' : 'var(--text-secondary)',
              }}>{t.label}</button>
            ))}
          </div>
          <textarea value={shareText} onChange={e => setShareText(e.target.value)}
            placeholder={shareType === 'achievement' ? '分享你解锁的成就...' : shareType === 'dream' ? '分享你的梦境...' : '此刻你的心情是...'}
            style={{
              width: '100%', minHeight: 80, padding: 8, borderRadius: 6, border: '1px solid #d1d5db',
              fontSize: 12, resize: 'vertical', boxSizing: 'border-box',
            }} />
          <button onClick={handleShare} disabled={!shareText.trim()} style={{
            marginTop: 8, padding: '6px 16px', borderRadius: 6, border: 'none',
            background: shareText.trim() ? '#8b5cf6' : '#d1d5db', color: '#fff', cursor: shareText.trim() ? 'pointer' : 'not-allowed',
            fontSize: 12,
          }}>📤 发布</button>
        </div>
      )}

      {/* ── 动态流 ── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {dreams.length === 0 ? (
          <div style={{
            textAlign: 'center', padding: 40, color: 'var(--text-secondary)',
          }}>
            <div style={{ fontSize: 40, marginBottom: 8 }}>🌐</div>
            <div style={{ fontSize: 14 }}>暂无动态</div>
            <div style={{ fontSize: 12, marginTop: 4 }}>分享你的第一条动态吧~</div>
          </div>
        ) : (
          dreams.map((item: any) => (
            <div key={item.id} style={{
              padding: '12px 16px', borderRadius: 8,
              background: 'var(--surface-0)', border: '1px solid var(--border-light)',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 16 }}>{item.author?.icon || '🌙'}</span>
                  <span style={{ fontSize: 12, fontWeight: 600 }}>{item.author?.name || 'Lumina'}</span>
                  {item.mood && <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{item.mood}</span>}
                </div>
                <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
                  {formatTime(item.timestamp || item.date || item.createdAt)}
                </span>
              </div>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#8b5cf6', marginBottom: 4 }}>
                {item.title || (item as any).name || '动态'}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                {item.content || '(无内容)'}
              </div>
              {item.tags && item.tags.length > 0 && (
                <div style={{ marginTop: 6, display: 'flex', gap: 4 }}>
                  {item.tags.map((tag: string) => (
                    <span key={tag} style={{
                      padding: '1px 6px', borderRadius: 6, fontSize: 9,
                      background: 'rgba(139,92,246,0.1)', color: '#a78bfa',
                    }}>#{tag}</span>
                  ))}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
