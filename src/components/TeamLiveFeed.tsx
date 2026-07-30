// ============================================================
// TeamLiveFeed.tsx — 团队直播小窗 (v1.0)
//
// 在侧边栏底部显示 3-5 条最近的团队动态，实时滚动更新
// 无需额外 IPC — 自动监听情绪变化和状态变更
// ============================================================

import React, { useState, useEffect, useRef } from 'react'
import { onEmotionChange } from '../services/agentEmotion'

interface TeamActivity {
  id: string
  agentId: string
  agentName: string
  agentIcon: string
  action: string
  timestamp: number
}

// ─── Agent 元数据 ──────────────────────────────────────
const AGENT_META: Record<string, { name: string; icon: string; color: string }> = {
  lumina: { name: 'Lumina', icon: '🐱', color: '#FF6B6B' },
  recha:  { name: '热茶',   icon: '🍵', color: '#448AFF' },
  yak:    { name: 'Yak',    icon: '📊', color: '#43A047' },
}

const AGENT_IDS = ['lumina', 'recha', 'yak']

// ─── 情绪 → 动态文案 ──────────────────────────────────
const MOOD_ACTIONS: Record<string, string[]> = {
  high:  ['心情超好！😄', '正在哼歌～🎵', '元气满满 ✨'],
  good:  ['状态不错 👍', '随时准备帮忙', '一切顺利～'],
  low:   ['有点低落...', '需要一点鼓励 💪', '默默工作中'],
  upset: ['不太开心 😔', '需要休息一下', '情绪有点低落'],
}
function randomAction(mood: number): string {
  if (mood > 0.6) return MOOD_ACTIONS.high[Math.floor(Math.random() * MOOD_ACTIONS.high.length)]
  if (mood > 0.2) return MOOD_ACTIONS.good[Math.floor(Math.random() * MOOD_ACTIONS.good.length)]
  if (mood > -0.3) return MOOD_ACTIONS.low[Math.floor(Math.random() * MOOD_ACTIONS.low.length)]
  return MOOD_ACTIONS.upset[Math.floor(Math.random() * MOOD_ACTIONS.upset.length)]
}

let idCounter = 0
function nextId() { return `feed_${Date.now()}_${++idCounter}` }

export default function TeamLiveFeed() {
  const [activities, setActivities] = useState<TeamActivity[]>([])
  const containerRef = useRef<HTMLDivElement>(null)

  // ── 监听情绪变化（对话时触发） ──────────────────────
  useEffect(() => {
    // 初始欢迎动态
    const init: TeamActivity[] = AGENT_IDS.map((id, i) => {
      const meta = AGENT_META[id]
      return {
        id: `init_${id}`,
        agentId: id,
        agentName: meta.name,
        agentIcon: meta.icon,
        action: '已就绪 ✅',
        timestamp: Date.now() - (AGENT_IDS.length - i) * 1000,
      }
    })
    setActivities(init)

    const unsub = onEmotionChange((agentId, emotion) => {
      const meta = AGENT_META[agentId]
      if (!meta) return
      const entry: TeamActivity = {
        id: nextId(),
        agentId,
        agentName: meta.name,
        agentIcon: meta.icon,
        action: randomAction(emotion.mood),
        timestamp: Date.now(),
      }
      setActivities(prev => {
        const next = [...prev, entry]
        return next.length > 20 ? next.slice(-20) : next
      })
    })

    return unsub
  }, [])

  // ── 监听状态变更 ────────────────────────────────────
  useEffect(() => {
    const onStatus = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (!detail?.agentId) return
      const meta = AGENT_META[detail.agentId]
      if (!meta) return
      const status = detail.status || ''
      const statusLabels: Record<string, string> = {
        busy: '忙碌中 ⏰', away: '暂时离开 🚶', focus: '专注模式 🎯',
        coding: '正在写代码 💻', meeting: '会议中 📋', break: '休息中 ☕',
        sleeping: '休息中 😴', dnd: '请勿打扰 🔕',
      }
      const entry: TeamActivity = {
        id: nextId(),
        agentId: detail.agentId,
        agentName: meta.name,
        agentIcon: meta.icon,
        action: statusLabels[status] || `状态 → ${status}`,
        timestamp: Date.now(),
      }
      setActivities(prev => {
        const next = [...prev, entry]
        return next.length > 20 ? next.slice(-20) : next
      })
    }
    window.addEventListener('agent:status-changed', onStatus)
    return () => window.removeEventListener('agent:status-changed', onStatus)
  }, [])

  // ── 新条目自动滚到底 ─────────────────────────────────
  useEffect(() => {
    const el = containerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [activities])

  // ── 显示最新的 5 条 ──────────────────────────────────
  const visible = activities.slice(-5).reverse()

  return (
    <div className="team-live-feed" ref={containerRef}>
      <div className="team-live-feed-title">
        <span>📡</span> 团队直播
      </div>
      {visible.map(entry => {
        const meta = AGENT_META[entry.agentId]
        const icon = meta?.icon || entry.agentIcon
        const color = meta?.color || 'var(--text-secondary)'
        return (
          <div key={entry.id} className="team-live-entry" title={entry.action}>
            <span style={{ flexShrink: 0, fontSize: 12 }}>{icon}</span>
            <span style={{
              flexShrink: 0, fontWeight: 600, color, fontSize: 11,
            }}>{entry.agentName}</span>
            <span style={{
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              color: 'var(--text-tertiary)', fontSize: 11,
            }}>{entry.action}</span>
          </div>
        )
      })}
      {visible.length === 0 && (
        <div style={{ fontSize: 11, color: 'var(--text-disabled)', textAlign: 'center', padding: '8px 0' }}>
          暂无团队动态
        </div>
      )}
    </div>
  )
}
