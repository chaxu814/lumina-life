// ============================================================
// panels/DreamPanel.tsx — 梦境日记面板 v1.0
//
// 展示 Lumina 每天生成的"梦境日记"
// 支持按日期查看、删除、统计信息
// ============================================================

import React, { useState, useEffect, useCallback } from 'react'

// ═══════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════

interface DreamEntry {
  id: string
  date: string
  title: string
  content: string
  mood: string
  tags: string[]
  createdAt: string
  source?: 'llm' | 'template'
}

interface DreamStats {
  total: number
  streak: number
  latestDate: string | null
}

// ═══════════════════════════════════════════════════════════
// DreamPanel 组件
// ═══════════════════════════════════════════════════════════

export default function DreamPanel() {
  const [dreams, setDreams] = useState<DreamEntry[]>([])
  const [stats, setStats] = useState<DreamStats>({ total: 0, streak: 0, latestDate: null })
  const [loading, setLoading] = useState(true)
  const [selectedDream, setSelectedDream] = useState<DreamEntry | null>(null)
  const [filter, setFilter] = useState<'all' | 'recent'>('all')

  // 加载数据
  const loadData = useCallback(async () => {
    try {
      const [dreamResult, statsResult] = await Promise.all([
        window.luminaAPI?.dreamList?.() ?? Promise.resolve({ dreams: [] }),
        window.luminaAPI?.dreamStats?.() ?? Promise.resolve({ total: 0, streak: 0, latestDate: null }),
      ])
      setDreams(dreamResult?.dreams ?? [])
      setStats(statsResult as any)
    } catch (e) {
      console.error('[DreamPanel] 加载梦境失败:', e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadData() }, [loadData])

  // 监听新梦境事件
  useEffect(() => {
    const handler = (dream: DreamEntry) => {
      setDreams(prev => [dream, ...prev])
      setStats(s => ({ ...s, total: s.total + 1, latestDate: dream.date }))
    }
    const cleanup = window.luminaAPI?.onDreamNew?.(handler)
    return () => { cleanup?.() }
  }, [])

  // 删除梦境
  const handleDelete = async (id: string) => {
    try {
      const ok = await window.luminaAPI?.dreamDelete?.(id)
      if (ok) {
        setDreams(prev => prev.filter(d => d.id !== id))
        if (selectedDream?.id === id) setSelectedDream(null)
      }
    } catch (e) {
      console.error('[DreamPanel] 删除失败:', e)
    }
  }

  // 手动生成
  const handleGenerate = async () => {
    try {
      const result = await window.luminaAPI?.dreamGenerate?.()
      if (result?.ok) {
        await loadData()
      }
    } catch (e) {
      console.error('[DreamPanel] 生成失败:', e)
    }
  }

  const displayDreams = filter === 'recent' ? dreams.slice(0, 7) : dreams

  // ── 加载中 ──
  if (loading) {
    return (
      <div style={{ padding: 20, display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
        <div style={{ fontSize: 14, color: 'var(--text-secondary)' }}>🌙 加载梦境日记中...</div>
      </div>
    )
  }

  return (
    <div style={{ padding: 20, height: '100%', overflowY: 'auto' }}>
      {/* ── 头部 ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>🌙 梦境日记 <span style={{ fontSize: 11, fontWeight: 600, padding: '1px 8px', borderRadius: 999, background: 'rgba(139,92,246,0.15)', color: '#a78bfa', verticalAlign: 'middle' }}>🧪 实验彩蛋</span></h2>
          <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '4px 0 0 0' }}>
            每天 03:00 由记忆片段编织。配置大脑模型后由模型自由生成（标 ✨），否则用叙事模板兜底（标 模板）
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button onClick={handleGenerate} style={{
            padding: '6px 14px', borderRadius: 6, border: 'none',
            background: '#8b5cf6', color: '#fff', cursor: 'pointer', fontSize: 12,
          }}>✨ 立即入梦</button>
        </div>
      </div>

      {/* ── 统计栏 ── */}
      <div style={{
        display: 'flex', gap: 16, marginBottom: 20, padding: 16,
        background: 'linear-gradient(135deg, #1e1b4b, #312e81)',
        borderRadius: 12, color: '#e0e7ff',
      }}>
        <div style={{ flex: 1, textAlign: 'center' }}>
          <div style={{ fontSize: 28, fontWeight: 700 }}>{stats.total}</div>
          <div style={{ fontSize: 11, opacity: 0.8 }}>梦境总数</div>
        </div>
        <div style={{ flex: 1, textAlign: 'center' }}>
          <div style={{ fontSize: 28, fontWeight: 700 }}>{stats.streak}</div>
          <div style={{ fontSize: 11, opacity: 0.8 }}>连续天数</div>
        </div>
        <div style={{ flex: 1, textAlign: 'center' }}>
          <div style={{ fontSize: 28, fontWeight: 700 }}>
            {stats.latestDate ? new Date(stats.latestDate).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) : '--'}
          </div>
          <div style={{ fontSize: 11, opacity: 0.8 }}>最近梦境</div>
        </div>
      </div>

      {/* ── 过滤器 ── */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {[
          { key: 'all', label: '全部梦境' },
          { key: 'recent', label: '最近7天' },
        ].map(f => (
          <button key={f.key} onClick={() => setFilter(f.key as any)}
            style={{
              padding: '4px 12px', borderRadius: 12, fontSize: 12, border: 'none',
              background: filter === f.key ? '#8b5cf6' : 'var(--surface-100)',
              color: filter === f.key ? '#fff' : 'var(--text-secondary)',
              cursor: 'pointer',
            }}>{f.label}</button>
        ))}
      </div>

      {/* ── 梦境列表 ── */}
      {displayDreams.length === 0 ? (
        <div style={{
          textAlign: 'center', padding: 40, color: 'var(--text-secondary)',
          background: 'var(--surface-0)', borderRadius: 12,
        }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>😴</div>
          <div style={{ fontSize: 14, fontWeight: 500 }}>还没有梦境记录</div>
          <div style={{ fontSize: 12, marginTop: 4 }}>今晚好好休息，Lumina 会为你编织第一个梦</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {displayDreams.map(dream => (
            <div key={dream.id} onClick={() => setSelectedDream(selectedDream?.id === dream.id ? null : dream)}
              style={{
                padding: '12px 16px', borderRadius: 10, cursor: 'pointer',
                background: selectedDream?.id === dream.id ? 'var(--accent-50)' : 'var(--surface-0)',
                border: selectedDream?.id === dream.id ? '1px solid #8b5cf6' : '1px solid transparent',
                transition: 'all 0.15s',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#8b5cf6' }}>
                  {dream.mood} {dream.title}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{
                    padding: '1px 6px', borderRadius: 6, fontSize: 9,
                    background: dream.source === 'llm' ? 'rgba(34,197,94,0.15)' : 'rgba(107,114,128,0.12)',
                    color: dream.source === 'llm' ? '#22c55e' : 'var(--text-secondary)',
                  }}>{dream.source === 'llm' ? '✨ AI 生成' : '模板'}</span>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                    {new Date(dream.date).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })}
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {dream.tags.map(tag => (
                  <span key={tag} style={{
                    padding: '1px 8px', borderRadius: 8, fontSize: 10,
                    background: 'rgba(139, 92, 246, 0.1)', color: '#a78bfa',
                  }}>#{tag}</span>
                ))}
              </div>

              {/* 展开内容 */}
              {selectedDream?.id === dream.id && (
                <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border-light)' }}>
                  <div style={{ fontSize: 13, lineHeight: 1.8, color: 'var(--text-primary)', whiteSpace: 'pre-wrap' }}>
                    {dream.content}
                  </div>
                  <div style={{ marginTop: 12, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    <button onClick={(e) => { e.stopPropagation(); handleDelete(dream.id) }} style={{
                      padding: '4px 12px', borderRadius: 6, border: '1px solid #fca5a5',
                      background: 'transparent', color: '#ef4444', cursor: 'pointer', fontSize: 11,
                    }}>🗑️ 删除</button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
