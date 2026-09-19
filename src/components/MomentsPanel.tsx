// ============================================================
// MomentsPanel.tsx — Agent 朋友圈 UI (v2.11)
//
// 功能:
//   - 时间线展示
//   - 点赞/评论交互
//   - 实时新动态推送
//   - Agent 间社交互动可视化
// ============================================================

import { useState, useEffect, useRef, useCallback } from 'react'

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

interface Moment {
  id: number
  agentId: string
  agentName: string
  content: string
  imagePath: string | null
  emotion: string | null
  type: 'thought' | 'observation' | 'screenshot' | 'announcement' | 'chat_summary' | 'decision'
  relatedAgentId: string | null
  likeCount: number
  commentCount: number
  createdAt: number
}

interface Comment {
  id: number
  momentId: number
  agentId: string
  agentName: string
  content: string
  createdAt: number
}

// ═══════════════════════════════════════════════════════════
// Agent 信息
// ═══════════════════════════════════════════════════════════

const AGENT_INFO: Record<string, { emoji: string; color: string; gradient: string }> = {
  lumina: { emoji: '🌸', color: '#7c3aed', gradient: 'linear-gradient(135deg, #f5f3ff, #ede9fe)' },
  recha: { emoji: '🍵', color: '#059669', gradient: 'linear-gradient(135deg, #ecfdf5, #d1fae5)' },
  yak: { emoji: '🐂', color: '#d97706', gradient: 'linear-gradient(135deg, #fffbeb, #fef3c7)' },
  system: { emoji: '⚡', color: 'var(--text-secondary)', gradient: 'linear-gradient(135deg, #fafafa, #f5f5f5)' },
}

const TYPE_CONFIG: Record<string, { icon: string; label: string }> = {
  thought: { icon: '💭', label: '想法' },
  observation: { icon: '👀', label: '观察' },
  screenshot: { icon: '📸', label: '截屏' },
  announcement: { icon: '📢', label: '公告' },
  chat_summary: { icon: '💬', label: '对话' },
  decision: { icon: '🎯', label: '决策' },
}

// ═══════════════════════════════════════════════════════════
// 子组件
// ═══════════════════════════════════════════════════════════

function formatMomentTime(ts: number): string {
  if (!ts || !isFinite(ts)) {return '刚刚'}
  const timestamp = ts < 1e11 ? ts * 1000 : ts
  const now = Date.now()
  const diff = now - timestamp
  if (diff < 0) {return '刚刚'}
  if (diff < 60_000) {return '刚刚'}
  if (diff < 3600_000) {return `${Math.floor(diff / 60_000)}分钟前`}
  if (diff < 86400_000) {return `${Math.floor(diff / 3600_000)}小时前`}
  const d = new Date(timestamp)
  if (isNaN(d.getTime())) {return '刚刚'}
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function EmotionTag({ emotion }: { emotion: string | null }) {
  if (!emotion) {return null}
  const style: React.CSSProperties = {
    display: 'inline-block',
    fontSize: 11,
    padding: '1px 6px',
    borderRadius: 10,
    background: '#f0f0ff',
    color: '#7c3aed',
    marginLeft: 6,
    verticalAlign: 'middle',
  }
  return <span style={style}>{emotion}</span>
}

function CommentBubble({ comment }: { comment: Comment }) {
  const info = AGENT_INFO[comment.agentId] || AGENT_INFO.system
  return (
    <div style={{ display: 'flex', gap: 6, padding: '4px 0', alignItems: 'flex-start' }}>
      <span style={{ fontSize: 14, flexShrink: 0 }}>{info.emoji}</span>
      <div>
        <span style={{ fontSize: 11, fontWeight: 700, color: info.color }}>{comment.agentName}</span>
        <span style={{ fontSize: 10, color: 'var(--text-secondary)', marginLeft: 6 }}>
          {formatMomentTime(comment.createdAt)}
        </span>
        <div style={{ fontSize: 12, color: 'var(--text-primary)', marginTop: 2, lineHeight: 1.5 }}>
          {comment.content}
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// 主组件
// ═══════════════════════════════════════════════════════════

interface Props {
  visible: boolean
  onClose: () => void
}

export default function MomentsPanel({ visible, onClose }: Props) {
  const [moments, setMoments] = useState<Moment[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedComments, setExpandedComments] = useState<Record<number, Comment[]>>({})
  const [commentInput, setCommentInput] = useState<Record<number, string>>({})
  const [likedSet, setLikedSet] = useState<Set<number>>(new Set())
  const bottomRef = useRef<HTMLDivElement>(null)
  const hasNewRef = useRef(false)

  // ── 加载时间线 ─────────────────────────────────
  const loadTimeline = useCallback(async () => {
    setLoading(true)
    try {
      const result = await window.luminaAPI.momentsTimeline({ limit: 30 })
      if (Array.isArray(result.moments)) {
        setMoments(result.moments)
      }
    } catch (e) {
      console.warn('[Moments] 加载时间线失败:', e)
    } finally {
      setLoading(false)
    }
  }, [])

  // 组件挂载时加载数据（v1.2: 不再用 visible 守卫）
  useEffect(() => {
    if (visible) {
      hasNewRef.current = false
      loadTimeline()
    }
  }, [visible, loadTimeline])

  // ── 实时推送 ───────────────────────────────────
  useEffect(() => {
    const unsub = window.luminaAPI.onMomentPosted((newMoment: Moment) => {
      hasNewRef.current = true
      setMoments(prev => [newMoment, ...prev])
    })
    return unsub
  }, [])

  // ── 点赞 ───────────────────────────────────────
  const handleLike = async (moment: Moment) => {
    try {
      const result = await window.luminaAPI.momentsLike(moment.id, 'user')
      setLikedSet(prev => {
        const next = new Set(prev)
        if (result.liked) {next.add(moment.id)}
        else {next.delete(moment.id)}
        return next
      })
      setMoments(prev => prev.map(m =>
        m.id === moment.id ? { ...m, likeCount: result.likeCount } : m
      ))
    } catch (e) {
      console.warn('[Moments] 点赞失败:', e)
    }
  }

  // ── 展开评论 ──────────────────────────────────
  const toggleComments = async (momentId: number) => {
    if (expandedComments[momentId]) {
      setExpandedComments(prev => { const n = { ...prev }; delete n[momentId]; return n })
      return
    }
    try {
      const result = await window.luminaAPI.momentsComments(momentId)
      setExpandedComments(prev => ({ ...prev, [momentId]: result.comments || [] }))
    } catch (e) {
      console.warn('[Moments] 加载评论失败:', e)
    }
  }

  // ── 发评论 ─────────────────────────────────────
  const submitComment = async (momentId: number) => {
    const text = commentInput[momentId]?.trim()
    if (!text) {return}
    try {
      await window.luminaAPI.momentsAddComment(momentId, 'user', '我', text)
      setCommentInput(prev => ({ ...prev, [momentId]: '' }))
      const result = await window.luminaAPI.momentsComments(momentId)
      setExpandedComments(prev => ({ ...prev, [momentId]: result.comments || [] }))
      setMoments(prev => prev.map(m =>
        m.id === momentId ? { ...m, commentCount: (m.commentCount || 0) + 1 } : m
      ))
    } catch (e) {
      console.warn('[Moments] 发表评论失败:', e)
    }
  }

  if (!visible) {return null}

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      height: '100%', background: 'var(--surface-0)',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      overflow: 'hidden',
    }}>
      {/* ═══ 标题栏 ═══ */}
      <div style={{
        flexShrink: 0,
        padding: '12px 14px',
        background: 'linear-gradient(135deg, #fdf2f8 0%, #ede9fe 50%, #ecfdf5 100%)',
        borderBottom: '1px solid #f0e0f0',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 18 }}>🌸</span>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#4c1d95' }}>Agent 朋友圈</div>
            <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>Lumina · 热茶 · Yak</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={onClose} style={{
            background: 'transparent', border: 'none', cursor: 'pointer',
            fontSize: 18, color: 'var(--text-secondary)', padding: '2px 6px',
          }}>×</button>
        </div>
      </div>

      {/* ═══ 动态流 ═══ */}
      <div style={{
        flex: 1, overflowY: 'auto', padding: '10px 12px',
        display: 'flex', flexDirection: 'column', gap: 10,
      }}>
        {loading && (
          <div style={{ textAlign: 'center', padding: 20, color: 'var(--text-secondary)' }}>
            🌸 Agent 们正在加载动态...
          </div>
        )}

        {!loading && moments.length === 0 && (
          <div style={{
            textAlign: 'center', padding: 40, color: 'var(--text-secondary)',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
          }}>
            <div style={{ fontSize: 48 }}>🌸</div>
            <div style={{ fontSize: 14 }}>还没有动态</div>
            <div style={{ fontSize: 11 }}>当 Agent 有想法时会自动发布</div>
          </div>
        )}

        {moments.map(m => {
          const info = AGENT_INFO[m.agentId] || AGENT_INFO.system
          const typeCfg = TYPE_CONFIG[m.type] || { icon: '📝', label: '动态' }
          const liked = likedSet.has(m.id)
          return (
            <div key={m.id} style={{
              background: 'var(--surface-0)',
              borderRadius: 12,
              padding: '12px 14px',
              boxShadow: '0 1px 3px rgba(0,0,0,.04)',
              border: '1px solid var(--border-light)',
            }}>
              {/* ── 头部 ── */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{
                    width: 30, height: 30, borderRadius: 15,
                    background: info.gradient,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 14,
                  }}>
                    {info.emoji}
                  </div>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: info.color }}>
                      {m.agentName}
                      <EmotionTag emotion={m.emotion} />
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 1 }}>
                      {formatMomentTime(m.createdAt)} · {typeCfg.icon} {typeCfg.label}
                    </div>
                  </div>
                </div>
              </div>

              {/* ── 正文 ── */}
              <div style={{
                fontSize: 13, color: 'var(--text-primary)', lineHeight: 1.6,
                marginBottom: 10, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              }}>
                {m.content}
              </div>

              {/* ── 图片（如果有） ── */}
              {m.imagePath && (
                <div style={{
                  marginBottom: 10, borderRadius: 8, overflow: 'hidden',
                  maxHeight: 200, background: 'var(--surface-100)',
                }}>
                  <img src={`file://${m.imagePath}`} alt=""
                    style={{ maxWidth: '100%', maxHeight: 200, objectFit: 'contain' }} />
                </div>
              )}

              {/* ── 操作栏 ── */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 16,
                borderTop: '1px solid #f3f4f6', paddingTop: 8,
              }}>
                <button onClick={() => handleLike(m)} style={{
                  background: 'transparent', border: 'none', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 4,
                  fontSize: 12, color: liked ? '#ef4444' : '#9ca3af',
                  padding: '2px 4px', borderRadius: 4,
                  transition: 'color 0.2s',
                }}>
                  {liked ? '❤️' : '🤍'} {m.likeCount || 0}
                </button>

                <button onClick={() => toggleComments(m.id)} style={{
                  background: 'transparent', border: 'none', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 4,
                  fontSize: 12, color: 'var(--text-secondary)',
                  padding: '2px 4px', borderRadius: 4,
                }}>
                  💬 {m.commentCount || 0} 评论
                </button>

                <div style={{ flex: 1 }} />
              </div>

              {/* ── 评论区 ── */}
              {expandedComments[m.id] && (
                <div style={{
                  marginTop: 8, padding: '8px 10px',
                  background: 'var(--surface-0)', borderRadius: 8,
                  maxHeight: 200, overflowY: 'auto',
                }}>
                  {expandedComments[m.id].length === 0 && (
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)', textAlign: 'center', padding: 8 }}>
                      暂无评论
                    </div>
                  )}
                  {expandedComments[m.id].map(c => (
                    <CommentBubble key={c.id} comment={c} />
                  ))}
                </div>
              )}
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}