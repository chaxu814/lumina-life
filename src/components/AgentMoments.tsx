// ============================================================
// AgentMoments.tsx — 朋友圈 (v2.2)
// 存储: SQLite（主）+ localStorage（备份兜底）
// 加载: 先 SQLite → 再 localStorage → 最后默认种子
// ============================================================

import React, { useState, useEffect } from 'react'
import { showToast } from './Toast'
import { isImeComposing } from '../lib/ime'

// ─── 类型 ──────────────────────────────────────────
interface MomentPost {
  id: number | string
  author: string
  authorName: string
  content: string
  timestamp: number
  likes: number
  likedByMe: boolean
}

// ─── Agent 元数据 ──────────────────────────────────
const AGENT_META: Record<string, { name: string; icon: string; color: string }> = {
  lumina: { name: 'Lumina', icon: '🐱', color: '#FF6B6B' },
  recha:  { name: '热茶',   icon: '🍵', color: '#448AFF' },
  yak:    { name: 'Yak',    icon: '📊', color: '#43A047' },
  user:   { name: '我',      icon: '👤', color: 'var(--text-primary)' },
}

const FALLBACK_SEED: MomentPost[] = [
  { id: 'fallback_1', author: 'lumina', authorName: 'Lumina', content: '☀️ 新的一天开始啦～有什么需要帮忙的吗？', timestamp: Date.now() - 3600000, likes: 2, likedByMe: false },
  { id: 'fallback_2', author: 'recha',  authorName: '热茶',   content: '🍵 刚完成代码审查，一切运行良好 👍', timestamp: Date.now() - 7200000, likes: 1, likedByMe: false },
  { id: 'fallback_3', author: 'yak',    authorName: 'Yak',    content: '📊 本周项目进度：任务完成率 78%，比上周提升 12% 🚀', timestamp: Date.now() - 10800000, likes: 3, likedByMe: false },
]

const STORAGE_KEY = 'lumina_moments'
function loadLocalSeed(): MomentPost[] {
  try { const raw = localStorage.getItem(STORAGE_KEY); return raw ? JSON.parse(raw) : [] }
  catch { return [] }
}
function saveLocalSeed(posts: MomentPost[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(posts)) } catch {}
}

// ─── 工具函数 ──────────────────────────────────────
function fmtTime(ts: number) {
  if (!ts) {return '刚刚'}
  const d = new Date(ts)
  if (isNaN(d.getTime())) {return '刚刚'}
  const diff = Date.now() - ts
  if (diff < 60000) {return '刚刚'}
  if (diff < 3600000) {return `${Math.floor(diff / 60000)}分钟前`}
  if (diff < 86400000) {return `${Math.floor(diff / 3600000)}小时前`}
  const yesterday = new Date(Date.now() - 86400000)
  if (d.toDateString() === yesterday.toDateString()) {return '昨天'}
  if (d.getFullYear() === new Date().getFullYear())
    {return `${d.getMonth() + 1}月${d.getDate()}日`}
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}

// ═══════════════════════════════════════════════════
// 主组件
// ═══════════════════════════════════════════════════
export default function AgentMoments() {
  const [posts, setPosts] = useState<MomentPost[]>([])
  const [loading, setLoading] = useState(true)
  const [input, setInput] = useState('')
  const [showCompose, setShowCompose] = useState(false)

  // ── 加载：SQLite → localStorage → 默认种子 ────
  useEffect(() => {
    (async () => {
      setLoading(true)
      let merged: MomentPost[] = []

      // 1️⃣ 先读 SQLite（社交引擎发的内容）
      try {
        const result = await window.luminaAPI.momentsTimeline({ limit: 50 })
        if (result?.moments && Array.isArray(result.moments) && result.moments.length > 0) {
          merged = result.moments.map((m: any) => ({
            id: m.id,
            author: m.agentId,
            authorName: m.agentName,
            content: m.content,
            timestamp: typeof m.createdAt === 'number' && m.createdAt < 1e11 ? m.createdAt * 1000 : (m.createdAt || Date.now()),
            likes: m.likeCount || 0,
            likedByMe: false,
          }))
        }
      } catch (e) {
        console.warn('[AgentMoments] SQLite 加载失败:', e)
      }

      // 2️⃣ 如果 SQLite 没数据，从 localStorage 补
      if (merged.length === 0) {
        const local = loadLocalSeed()
        if (local.length > 0) {
          merged = local
        }
      }

      // 3️⃣ 还是没有？用默认种子
      if (merged.length === 0) {
        merged = [...FALLBACK_SEED]
        // 把默认种子也存进 localStorage
        saveLocalSeed(merged)
      }

      setPosts(merged)
      setLoading(false)
    })()
  }, [])

  // ── 发布 (→ SQLite) ───────────────────────────
  const postMoment = async () => {
    const text = input.trim()
    if (!text) {return}
    try {
      const result = await window.luminaAPI.momentsPost({
        agentId: 'user', agentName: '我', content: text, type: 'thought',
      })
      if (result?.ok) {
        // 刷新列表
        const r = await window.luminaAPI.momentsTimeline({ limit: 50 })
        if (r?.moments) {
          const updated = r.moments.map((m: any) => ({
            id: m.id, author: m.agentId, authorName: m.agentName,
            content: m.content,
            timestamp: typeof m.createdAt === 'number' && m.createdAt < 1e11 ? m.createdAt * 1000 : (m.createdAt || Date.now()),
            likes: m.likeCount || 0, likedByMe: false,
          }))
          setPosts(updated)
          // 同步到 localStorage
          saveLocalSeed(updated)
        }
        setInput(''); setShowCompose(false)
        showToast('📸 已发布')
      }
    } catch (e: any) {
      showToast('❌ 发布失败: ' + (e.message || e))
    }
  }

  // ── 点赞 ────────────────────────────────────────
  const toggleLike = async (id: number | string) => {
    const numId = typeof id === 'number' ? id : parseInt(String(id).replace('fallback_', ''), 10)
    if (!isNaN(numId) && numId > 0) {
      try {
        const result = await window.luminaAPI.momentsLike(numId, 'user')
        setPosts(prev => prev.map(p => {
          if (p.id !== numId) {return p}
          return { ...p, likes: result.likeCount, likedByMe: result.liked }
        }))
        return
      } catch {}
    }
    // fallback ID: localStorage 模式
    setPosts(prev => prev.map(p => {
      if (p.id !== id) {return p}
      return { ...p, likes: p.likedByMe ? p.likes - 1 : p.likes + 1, likedByMe: !p.likedByMe }
    }))
  }

  // ── 删除 ────────────────────────────────────────
  const deletePost = async (id: number | string) => {
    const numId = typeof id === 'number' ? id : parseInt(String(id).replace('fallback_', ''), 10)
    if (!isNaN(numId) && numId > 0) {
      try {
        await window.luminaAPI.momentsDelete(numId)
        setPosts(prev => { const u = prev.filter(p => p.id !== numId); saveLocalSeed(u); return u })
        showToast('🗑️ 已删除')
        return
      } catch {}
    }
    setPosts(prev => { const u = prev.filter(p => p.id !== id); saveLocalSeed(u); return u })
    showToast('🗑️ 已删除')
  }

  if (loading) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)', fontSize: 13 }}>
        🌸 加载中...
      </div>
    )
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* ═══ 顶部栏 ═══ */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '12px 16px',
        background: 'var(--surface-0)',
        borderBottom: '1px solid #f0f0f0',
      }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: '#1a1a1a' }}>
          朋友圈
          {posts.length > 0 && (
            <span style={{ fontSize: 11, color: '#999', fontWeight: 400, marginLeft: 4 }}>
              {posts.length}
            </span>
          )}
        </span>
        <button onClick={() => { setShowCompose(!showCompose) }}
          style={{
            padding: '5px 14px', borderRadius: 6, fontSize: 11, fontWeight: 600,
            border: 'none', background: '#3b82f6', color: '#fff', cursor: 'pointer',
          }}
        >
          {showCompose ? '收起' : '+ 发布'}
        </button>
      </div>

      {/* ═══ 发布框 ═══ */}
      {showCompose && (
        <div style={{
          padding: '10px 14px', borderBottom: '1px solid #f0f0f0',
          background: '#fafbff',
        }}>
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="说点什么吧..."
            rows={3}
            style={{
              width: '100%', border: '1px solid #e2e8f0', borderRadius: 8,
              padding: '8px 10px', fontSize: 13, resize: 'none',
              fontFamily: 'inherit', outline: 'none',
              background: '#fff',
            }}
            onKeyDown={e => {
              if (isImeComposing(e)) {return}
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); postMoment() }
            }}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
            <button onClick={postMoment}
              style={{
                padding: '5px 16px', borderRadius: 6, fontSize: 12, fontWeight: 600,
                border: 'none', background: '#3b82f6', color: '#fff', cursor: 'pointer',
              }}
            >发布</button>
          </div>
        </div>
      )}

      {/* ═══ 朋友圈列表 ═══ */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '10px 14px' }}>
        {posts.map(p => {
          const meta = AGENT_META[p.author] || AGENT_META.user
          return (
            <div key={p.id} style={{
              display: 'flex', gap: 10,
              padding: '12px 0',
              borderBottom: '1px solid #f5f5f5',
            }}>
              {/* 头像 */}
              <div style={{
                width: 36, height: 36, borderRadius: '50%',
                background: meta.color + '18',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 18, flexShrink: 0,
              }}>
                {meta.icon}
              </div>
              {/* 内容 */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: meta.color }}>
                    {p.authorName || meta.name}
                  </span>
                  <span style={{ fontSize: 10, color: '#bbb' }}>
                    {fmtTime(p.timestamp)}
                  </span>
                </div>
                <div style={{
                  fontSize: 13, color: '#1a1a1a', lineHeight: 1.6,
                  marginTop: 4, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                }}>
                  {p.content}
                </div>
                {/* 操作栏 */}
                <div style={{ display: 'flex', gap: 16, marginTop: 6 }}>
                  <button onClick={() => toggleLike(p.id)} style={{
                    background: 'none', border: 'none', cursor: 'pointer',
                    display: 'flex', alignItems: 'center', gap: 3,
                    fontSize: 11, color: p.likedByMe ? '#ef4444' : '#999',
                    padding: 0,
                  }}>
                    {p.likedByMe ? '❤️' : '🤍'} {p.likes || 0}
                  </button>
                  {p.author === 'user' && (
                    <button onClick={() => deletePost(p.id)} style={{
                      background: 'none', border: 'none', cursor: 'pointer',
                      fontSize: 11, color: '#ccc', padding: 0,
                    }}>
                      🗑️ 删除
                    </button>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
