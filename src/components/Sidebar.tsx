import React, { useState, useEffect, useCallback } from 'react'
import { useStore, type PanelType } from '../stores/appStore'
import {
  IconMessageCircle, IconMail, IconSettings,
  IconZap, IconGlobe, IconUser, IconStar,
} from './Icons'
import {
  getEmotion, getNamedEmotion, getAgentStatus, getStatusLabel,
  onEmotionChange, type AgentEmotion, type EmotionLabel, type AgentStatus,
} from '../services/agentEmotion'
import type { StatusLabel } from '../services/agentEmotion'
import TeamLiveFeed from './TeamLiveFeed'  // 🆕 v1.0: 团队直播小窗

// Sidebar XP 游戏化进度条组件
function GamificationProgressBar() {
  const [stats, setStats] = useState<{ level: number; totalXp: number; title: string; progress: number; nextLevelXp: number; currentXp: number } | null>(null)
  const [xpFloat, setXpFloat] = useState<{ amount: number; reason: string; multiplier: number } | null>(null)
  const [floatKey, setFloatKey] = useState(0)

  useEffect(() => {
    const load = async () => {
      try {
        const api = (window as any).luminaAPI
        if (!api?.gamificationStats) return
        const s = await api.gamificationStats()
        if (s) setStats(s)
      } catch {}
    }
    load()
    const api = (window as any).luminaAPI
    let unsubXp: (() => void) | undefined
    let unsubLv: (() => void) | undefined
    if (api?.onXpGained) {
      unsubXp = api.onXpGained((data: any) => {
        setXpFloat({ amount: data.amount || 0, reason: data.reason || '', multiplier: data.multiplier || 1 })
        setFloatKey(k => k + 1)
        load()
      })
    }
    if (api?.onLevelUp) {
      unsubLv = api.onLevelUp(() => { load() })
    }
    const iv = setInterval(load, 60000)
    return () => {
      clearInterval(iv)
      if (unsubXp) unsubXp()
      if (unsubLv) unsubLv()
    }
  }, [])

  // XP 浮动提示自动消失
  useEffect(() => {
    if (!xpFloat) return
    const t = setTimeout(() => setXpFloat(null), 1800)
    return () => clearTimeout(t)
  }, [floatKey])

  if (!stats) return null

  const tierEmoji = stats.level >= 16 ? '💎' : stats.level >= 11 ? '🥇' : stats.level >= 6 ? '🥈' : '🥉'
  const pct = Math.min(100, (stats.progress || 0) * 100)

  return (
    <div style={{
      padding: '8px 10px 6px',
      margin: '0 6px 4px',
      background: 'var(--surface-100)',
      borderRadius: 'var(--radius-md)',
      border: '1px solid var(--border-light)',
      position: 'relative',
      overflow: 'visible',
    }}>
      {/* 🆕 XP 浮动提示：获得 XP 时闪现 */}
      {xpFloat && (
        <div key={floatKey} style={{
          position: 'absolute', bottom: '100%', left: '50%', transform: 'translateX(-50%)',
          padding: '2px 10px', borderRadius: 8,
          background: 'linear-gradient(135deg, #f59e0b, #ffd700)',
          color: '#1a1a1a', fontSize: 11, fontWeight: 700,
          whiteSpace: 'nowrap', pointerEvents: 'none',
          boxShadow: '0 2px 8px rgba(245,158,11,0.4)',
          animation: 'xpFloatUp 1.8s ease-out forwards',
          zIndex: 100,
        }}>
          ✨ +{xpFloat.amount} XP
          {xpFloat.multiplier > 1 && <span style={{ fontSize: 9, marginLeft: 3 }}>×{xpFloat.multiplier.toFixed(1)}</span>}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-tertiary)', letterSpacing: 0.5 }}>
          {tierEmoji} Lv.{stats.level} · {stats.title}
        </div>
        <div style={{ fontSize: 9, color: 'var(--text-disabled)' }}>
          {stats.totalXp} XP
        </div>
      </div>
      <div style={{
        width: '100%', height: 4, borderRadius: 2,
        background: 'rgba(0,0,0,0.06)',
        overflow: 'hidden',
      }}>
        <div style={{
          width: `${pct}%`, height: '100%',
          borderRadius: 2,
          background: stats.level >= 11
            ? 'linear-gradient(90deg, #f59e0b, #ffd700)'
            : stats.level >= 6
              ? 'linear-gradient(90deg, #a8a8a8, #c0c0c0)'
              : 'linear-gradient(90deg, #cd7f32, #e8a85c)',
          transition: 'width 0.8s cubic-bezier(0.4,0,0.2,1)',
          boxShadow: stats.level >= 11 ? '0 0 6px rgba(255,215,0,0.4)' : 'none',
        }} />
      </div>
      <div style={{ fontSize: 8, color: 'var(--text-disabled)', textAlign: 'right', marginTop: 2 }}>
        {stats.currentXp || 0} / {stats.nextLevelXp || 100}
      </div>
    </div>
  )
}

// ─── 导航项类型 ───

interface NavItem {
  id: PanelType; label: string; Icon: React.FC<{ size?: number }>
}

const sections: { label: string; items: NavItem[] }[] = [
  { label: '主要', items: [
    { id: 'chat', label: '聊天', Icon: IconMessageCircle },
    { id: 'mail', label: '邮件', Icon: IconMail },
    { id: 'settings', label: '设置', Icon: IconSettings },
  ]},
  { label: '管理', items: [
    { id: 'more', label: '更多设置', Icon: IconSettings },
    { id: 'plugins', label: '📦 插件面板', Icon: IconStar },
    { id: 'news', label: '📡 新闻', Icon: IconStar },
  ]},
  { label: '个人', items: [
    { id: 'profile', label: '个性化', Icon: IconUser },
    { id: 'dream', label: '梦境', Icon: IconStar },
    { id: 'bookmarks', label: '收藏夹', Icon: IconStar },
  ]},
  { label: '扩展', items: [
    { id: 'knowledge', label: '知识库', Icon: IconStar },
    { id: 'reality', label: '真人秀', Icon: IconGlobe },
    { id: 'skilldev', label: '技能开发', Icon: IconZap },
    { id: 'social', label: '社区', Icon: IconGlobe },
    { id: 'familytree', label: '家谱', Icon: IconStar },
    { id: 'deepresearch', label: '深度调研', Icon: IconGlobe },
    { id: 'skillmarket', label: '技能商店', Icon: IconZap },
  ]},
]

// ─── Agent 元数据 ──────────────────────────────────────
const AGENT_META: Record<string, { id: string; name: string; icon: string; color: string }> = {
  lumina: { id: 'lumina', name: 'Lumina', icon: '🐱', color: '#FF6B6B' },
  recha:  { id: 'recha',  name: '热茶',   icon: '🍵', color: '#448AFF' },
  yak:    { id: 'yak',    name: 'Yak',    icon: '📊', color: '#43A047' },
}
const SIDEBAR_AGENTS = ['lumina', 'recha', 'yak']

// ─── 单 Agent 状态行 ─────────────────────────────────────
function AgentStatusRow({
  agentId, meta, emotion, label, status, statusLabel,
}: {
  agentId: string
  meta: typeof AGENT_META['lumina']
  emotion: AgentEmotion
  label: EmotionLabel
  status: AgentStatus
  statusLabel: StatusLabel
}) {
  // 情绪值 → 横向进度条宽度
  const moodPct = ((emotion.mood + 1) / 2 * 100).toFixed(0)
  const energyPct = (emotion.energy * 100).toFixed(0)
  const statusColor = statusLabel.color

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6,
      padding: '5px 6px', borderRadius: 6,
      background: `${label.color}10`,
      border: `1px solid ${label.color}18`,
      fontSize: 12, lineHeight: 1.3,
      width: '100%',
    }}>
      {/* 状态点 */}
      <div style={{
        width: 8, height: 8, borderRadius: 4,
        background: statusColor,
        boxShadow: `0 0 8px ${statusColor}88`,
        flexShrink: 0,
      }} title={statusLabel.label} />
      {/* 图标 */}
      <span style={{ fontSize: 15, flexShrink: 0 }}>{meta.icon}</span>
      {/* 名称 */}
      <span style={{ fontWeight: 700, color: meta.color, flexShrink: 0, fontSize: 12 }}>
        {meta.name}
      </span>
      {/* 情绪标签 */}
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 2,
        padding: '0 5px', borderRadius: 8,
        background: `${label.color}18`,
        border: `1px solid ${label.color}25`,
        fontSize: 10, fontWeight: 600, color: label.color,
        whiteSpace: 'nowrap', flexShrink: 0,
      }}>
        {label.icon} {label.label}
      </span>
      {/* 弹性空间 */}
      <div style={{ flex: 1 }} />
      {/* 微能量条（2px 高细条） */}
      <div style={{
        width: 28, height: 3, borderRadius: 2,
        background: 'var(--border-light)',
        overflow: 'hidden', flexShrink: 0,
      }}>
        <div style={{
          width: `${energyPct}%`, height: '100%',
          borderRadius: 2,
          background: `linear-gradient(90deg, ${statusColor}88, ${statusColor})`,
          transition: 'width 0.4s ease',
        }} />
      </div>
    </div>
  )
}

// ─── 团队状态面板 ───────────────────────────────────────
function TeamStatusPanel() {
  const [, setTick] = useState(0)
  const forceUpdate = useCallback(() => setTick(t => t + 1), [])

  useEffect(() => {
    const unsub = onEmotionChange(() => forceUpdate())
    // 同时监听状态变更（setAgentStatus 触发的是 DOM 事件）
    const onStatus = () => forceUpdate()
    window.addEventListener('agent:status-changed', onStatus)
    window.addEventListener('agent:emotion-manual', onStatus)
    window.addEventListener('agent:emotion-auto', onStatus)
    return () => {
      unsub()
      window.removeEventListener('agent:status-changed', onStatus)
      window.removeEventListener('agent:emotion-manual', onStatus)
      window.removeEventListener('agent:emotion-auto', onStatus)
    }
  }, [forceUpdate])

  return (
    <div style={{
      marginBottom: 6, padding: '8px 6px 6px',
      background: 'var(--surface-100)',
      borderRadius: 'var(--radius-md)',
      border: '1px solid var(--border-light)',
    }}>
      {/* 标题 */}
      <div style={{
        fontSize: 10, fontWeight: 700, color: 'var(--text-tertiary)',
        letterSpacing: 1, textTransform: 'uppercase',
        padding: '0 2px 5px',
        display: 'flex', alignItems: 'center', gap: 4,
      }}>
        <span>🤖 团队状态</span>
      </div>
      {/* Agent 列表（垂直排列） */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {SIDEBAR_AGENTS.map(id => {
          const meta = AGENT_META[id]
          if (!meta) return null
          const emotion = getEmotion(id)
          const label = getNamedEmotion(id)
          const status = getAgentStatus(id) as AgentStatus
          const statusLabel = getStatusLabel(status)
          return (
            <AgentStatusRow key={id}
              agentId={id} meta={meta}
              emotion={emotion} label={label}
              status={status} statusLabel={statusLabel}
            />
          )
        })}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// 主组件
// ═══════════════════════════════════════════════════════════
export default function Sidebar() {
  const activePanel = useStore((s) => s.activePanel)
  const setActivePanel = useStore((s) => s.setActivePanel)
  const [mailUnread, setMailUnread] = useState(0)

  useEffect(() => {
    // 初始化时获取未读数
    window.luminaAPI?.mailUnreadCount().then(r => setMailUnread(r.count)).catch(() => {})
    // 监听邮件变化
    const cleanup = window.luminaAPI?.onMailChanged((data) => setMailUnread(data.unread))
    return cleanup
  }, [])

  return (
    <nav className="sidebar">
      {/* 滚动内容区 — TeamLiveFeed 和 footer 始终固定底部 */}
      <div className="sidebar-scroll">
      {/* ═══ 团队状态 ═══ */}
      <TeamStatusPanel />

      {sections.map((section) => (
        <div key={section.label} className="sidebar-section">
          <div className="sidebar-label">{section.label}</div>
          {section.items.map((item) => {
            const isActive = activePanel === item.id
            return (
              <button key={item.id}
                className={'sidebar-item' + (isActive ? ' active' : '')}
                onClick={() => setActivePanel(item.id)}
                style={{ position: 'relative' }}>
                <item.Icon size={18} />
                <span>{item.label}</span>
                {/* 未读邮件角标 */}
                {item.id === 'mail' && mailUnread > 0 && (
                  <span style={{
                    position: 'absolute',
                    top: 4, right: 6,
                    background: 'var(--accent-500)',
                    color: '#fff',
                    fontSize: 10,
                    fontWeight: 700,
                    minWidth: 18,
                    height: 18,
                    borderRadius: 9,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: '0 4px',
                    lineHeight: 1,
                  }}>
                    {mailUnread > 99 ? '99+' : mailUnread}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      ))}

        {/* spacer pushes everything below to the bottom */}
        <div className="sidebar-spacer" />
      </div>  {/* closes sidebar-scroll */}

      {/* 🆕 v1.0: 团队直播小窗 — 始终在底部可见 */}
      <TeamLiveFeed />

      {/* 🆕 v3.1: XP 进度条（游戏化青铜档） */}
      <GamificationProgressBar />

      <div className="sidebar-footer">
        <div className="sidebar-footer-box">
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>Lumina Life 1.0</span>
        </div>

        {/* ═══ 系统入口 ═══ */}
        <div style={{ display: 'flex', justifyContent: 'center', gap: 2, marginTop: 6, paddingTop: 6, borderTop: '1px solid var(--border-light, #e5e7eb)' }}>
          <button
            onClick={() => (window as any).luminaAPI?.showAbout()}
            title="关于 Lumina"
            style={{
              background: 'transparent', border: 'none',
              color: 'var(--text-disabled, #9ca3af)', cursor: 'pointer',
              fontSize: 10, padding: '2px 6px', borderRadius: 3,
              fontWeight: 400,
            }}
            onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-secondary, #6b7280)'}
            onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-disabled, #9ca3af)'}
          >
            关于 Lumina
          </button>
          <button
            onClick={() => (window as any).luminaAPI?.toggleDevTools()}
            title="开发者工具 (F12)"
            style={{
              background: 'transparent', border: 'none',
              color: 'var(--text-disabled, #9ca3af)', cursor: 'pointer',
              fontSize: 10, padding: '2px 6px', borderRadius: 3,
              fontWeight: 400,
            }}
            onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-secondary, #6b7280)'}
            onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-disabled, #9ca3af)'}
          >
            开发者工具
          </button>
        </div>
      </div>
    </nav>
  )
}
