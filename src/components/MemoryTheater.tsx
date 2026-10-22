// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// MemoryTheater.tsx — Agent 记忆剧场 (v2.14 中文化)
// ============================================================

import React, { useState, useMemo } from 'react'
import { useStore } from '../stores/appStore'
import { AGENTS } from '../chat/chatShared'

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

interface MemoryEpisode {
  id: string
  title: string
  date: string
  type: 'milestone' | 'memory' | 'discovery' | 'humor'
  mood: string
  agents: string[]
  summary: string
  impact: string
  quote?: { agentId: string; text: string }
}

const TYPE_CFG: Record<string, { label: string; color: string; bg: string; icon: string }> = {
  milestone: { label: '里程碑', color: '#8b5cf6', bg: '#f5f3ff', icon: '🏆' },
  memory: { label: '回忆', color: '#ec4899', bg: '#fdf2f8', icon: '💖' },
  discovery: { label: '发现', color: '#f59e0b', bg: '#fffbeb', icon: '💡' },
  humor: { label: '趣事', color: '#10b981', bg: '#f0fdf4', icon: '😂' },
}

export default function MemoryTheater() {
  const conversations = useStore(s => s.conversations)
  const structuredMemory = useStore(s => s.structuredMemory)
  const auditLogs = useStore(s => s.auditLogs)
  const teamState = useStore(s => s.teamState)
  const [selectedEpisode, setSelectedEpisode] = useState<string | null>(null)

  const episodes = useMemo<MemoryEpisode[]>(() => {
    const fmtDate = (ts: number) => {
      const d = new Date(ts)
      return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
    }
    const now = Date.now()
    const result: MemoryEpisode[] = []

    // ── 起源故事 ──────────────────────────────────────────
    const sortedConvs = [...(conversations || [])].sort(
      (a, b) => (a.createdAt || 0) - (b.createdAt || 0)
    )
    if (sortedConvs.length > 0) {
      const first = sortedConvs[0]
      const daysAgo = Math.round((now - (first.createdAt || now)) / 86400000)
      result.push({
        id: 'mem_origin',
        title: '一切的开始',
        date: fmtDate(first.createdAt || now),
        type: 'milestone',
        mood: '🌟',
        agents: ['lumina', 'recha', 'yak'],
        summary:
          `第一次对话"${first.name || '未命名'}"开始了。` +
          `从这一刻起，三个 Agent 开始了解它们的主人。` +
          (daysAgo > 0 ? `那是 ${daysAgo} 天前的事了。` : '就在今天！'),
        impact:
          daysAgo > 0
            ? `团队已经陪伴了 ${daysAgo} 天，共 ${sortedConvs.length} 次对话。`
            : '团队刚刚成立，未来还有很长的路。',
      })
    }

    // ── 消息里程碑 ────────────────────────────────────────
    const totalMsgs = (conversations || []).reduce(
      (sum, c) => sum + (c.messages?.length || 0),
      0
    )
    if (totalMsgs >= 5) {
      result.push({
        id: 'mem_msgs',
        title: `已交流 ${totalMsgs} 条消息`,
        date: fmtDate(now),
        type: 'milestone',
        mood: '💬',
        agents: ['lumina', 'recha', 'yak'],
        summary:
          `团队已经交换了 ${totalMsgs} 条消息。` +
          `每一条都帮助我们更了解主人。`,
        impact:
          totalMsgs >= 100
            ? '已经很了解主人了，每个小习惯都逃不过我们的眼睛。'
            : '正在一点一点地了解主人，每句话都是珍贵的记忆。',
      })
    }

    // ── 结构化记忆 ────────────────────────────────────────
    if (structuredMemory?.memory?.lessons) {
      const lessons = structuredMemory.memory.lessons as string[]
      for (let i = 0; i < Math.min(lessons.length, 5); i++) {
        result.push({
          id: `mem_lesson_${i}`,
          title: `学到的经验`,
          date: fmtDate(now),
          type: 'discovery',
          mood: '💡',
          agents: ['lumina', 'recha', 'yak'],
          summary: String(lessons[i]).slice(0, 120),
          impact: '已存入团队知识库，下次遇到类似情况就有经验了。',
        })
      }
    }

    // ── 趣事日志 ──────────────────────────────────────────
    const funLogs = (auditLogs || [])
      .filter(l => {
        const type = (l as unknown as Record<string, unknown>).type as string || ''
        return type.includes('chat') || type === 'tool_use'
      })
      .slice(-3)

    for (const log of funLogs) {
      const entry = log as unknown as Record<string, unknown>
      const name = entry.name as string || entry.type as string || '操作'
      const time = entry.time as number
      result.push({
        id: `fun_${(log as any).id || Math.random()}`,
        title: `活跃记录: ${String(name).slice(0, 30)}`,
        date: time ? fmtDate(time) : fmtDate(now),
        type: 'humor',
        mood: '😄',
        agents: ['recha', 'lumina'],
        summary:
          '热茶："又来一个？行吧。" ' +
          'Lumina："热茶好可靠呀~ ✨" ' +
          '热茶："……赶紧干活。别废话。"',
        impact: '经典团队日常，永远不会腻。',
        quote: { agentId: 'recha', text: '……赶紧干活。别废话。' },
      })
    }

    return result
  }, [conversations, structuredMemory, auditLogs])

  // ═══════════════════════════════════════════════════════════
  // Render
  // ═══════════════════════════════════════════════════════════

  const selected = episodes.find(e => e.id === selectedEpisode)

  return (
    <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div style={{
        padding: '8px 12px', fontSize: 12, fontWeight: 700,
        color: '#8b5cf6', borderBottom: '1px solid var(--border-light)',
        background: 'linear-gradient(180deg, #f5f3ff, #fff)',
        position: 'sticky', top: 0, zIndex: 1,
        display: 'flex', alignItems: 'center', gap: 6,
      }}>
        🎭 记忆剧场
        <span style={{ fontSize: 10, color: 'var(--text-secondary)', fontWeight: 400 }}>
          — 团队的回忆与里程碑
        </span>
      </div>

      {/* Episode detail */}
      {selected && (
        <div style={{
          margin: '8px 12px', padding: 12, borderRadius: 10,
          border: '1px solid var(--border-light)', background: 'var(--surface-0)',
          boxShadow: '0 4px 12px rgba(0,0,0,0.06)',
        }}>
          <div style={{
            display: 'flex', justifyContent: 'space-between',
            alignItems: 'center', marginBottom: 8,
          }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>
              {selected.mood} {selected.title}
            </span>
            <button
              onClick={() => setSelectedEpisode(null)}
              style={{
                border: 'none', background: 'none', cursor: 'pointer',
                fontSize: 16, color: 'var(--text-secondary)', padding: 0, lineHeight: 1,
              }}
            >
              ✕
            </button>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 8 }}>
            {selected.date} · {TYPE_CFG[selected.type]?.label || selected.type}
          </div>
          <div style={{
            fontSize: 12, lineHeight: 1.7, color: 'var(--text-primary)',
            marginBottom: 8, whiteSpace: 'pre-wrap',
          }}>
            {selected.summary}
          </div>
          <div style={{
            padding: '6px 10px', borderRadius: 6,
            background: 'var(--surface-100)', fontSize: 11, color: 'var(--text-secondary)',
            marginBottom: 8,
          }}>
            💡 {selected.impact}
          </div>
          {selected.quote && (
            <div style={{
              padding: '6px 10px', borderRadius: 6,
              background: 'var(--yellow-100)', fontSize: 11, fontStyle: 'italic',
              color: '#92400e', borderLeft: '3px solid #f59e0b',
            }}>
              {(() => {
                const a = AGENTS.find(ag => ag.id === selected.quote!.agentId)
                return (
                  <>
                    <span style={{ fontWeight: 600 }}>
                      {a?.icon} {a?.name}:
                    </span>{' '}
                    "{selected.quote.text}"
                  </>
                )
              })()}
            </div>
          )}
          {/* Agent avatars */}
          <div style={{
            display: 'flex', gap: 4, marginTop: 8, flexWrap: 'wrap',
          }}>
            {selected.agents.map(aid => {
              const a = AGENTS.find(ag => ag.id === aid)
              return a ? (
                <span key={aid} style={{
                  fontSize: 10, padding: '2px 8px', borderRadius: 10,
                  background: `${a.color}15`, color: a.color,
                  border: `1px solid ${a.color}30`,
                }}>
                  {a.icon} {a.name}
                </span>
              ) : null
            })}
          </div>
        </div>
      )}

      {/* Episode list */}
      <div style={{ padding: '4px 12px', flex: 1 }}>
        {episodes.length === 0 && (
          <div style={{
            textAlign: 'center', color: '#d1d5db', fontSize: 12,
            padding: '32px 0',
          }}>
            🎭 还没有记忆 — 开始聊天来创建属于你们的故事吧！
          </div>
        )}

        {episodes.map(ep => {
          const cfg = TYPE_CFG[ep.type]
          const isSelected = ep.id === selectedEpisode
          return (
            <div
              key={ep.id}
              onClick={() => setSelectedEpisode(isSelected ? null : ep.id)}
              style={{
                padding: '8px 10px', borderRadius: 8,
                border: '1px solid',
                borderColor: isSelected ? (cfg?.color || '#e5e7eb') : '#f3f4f6',
                background: isSelected ? (cfg?.bg || '#f9fafb') : '#fff',
                marginBottom: 6, cursor: 'pointer',
                transition: 'all 0.15s',
                boxShadow: isSelected ? '0 2px 8px rgba(0,0,0,0.06)' : 'none',
              }}
            >
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6,
                marginBottom: 4,
              }}>
                <span style={{
                  width: 24, height: 24, borderRadius: 6,
                  background: cfg?.bg || '#f3f4f6',
                  display: 'flex', alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 13,
                }}>
                  {cfg?.icon || '📌'}
                </span>
                <span style={{
                  fontSize: 12, fontWeight: 600, color: 'var(--text-primary)',
                  flex: 1,
                }}>
                  {ep.mood} {ep.title}
                </span>
                <span style={{
                  fontSize: 9, padding: '1px 6px', borderRadius: 4,
                  background: `${cfg?.color || '#9ca3af'}15`,
                  color: cfg?.color || '#9ca3af',
                }}>
                  {cfg?.label || ep.type}
                </span>
              </div>
              <div style={{
                fontSize: 10, color: 'var(--text-secondary)', marginBottom: 4,
              }}>
                {ep.date}
              </div>
              <div style={{
                fontSize: 11, color: '#4b5563', lineHeight: 1.5,
              }}>
                {ep.summary.slice(0, 100)}
                {ep.summary.length > 100 ? '...' : ''}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
