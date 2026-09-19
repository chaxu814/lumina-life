import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useStore, type PanelType } from '../stores/appStore'
import {
  IconMessageCircle, IconMail, IconSettings,
  IconZap, IconGlobe, IconUser, IconStar, IconHeart,
} from './Icons'
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
        if (!api?.gamificationStats) {return}
        const s = await api.gamificationStats()
        if (s) {setStats(s)}
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
      if (unsubXp) {unsubXp()}
      if (unsubLv) {unsubLv()}
    }
  }, [])

  // XP 浮动提示自动消失
  useEffect(() => {
    if (!xpFloat) {return}
    const t = setTimeout(() => setXpFloat(null), 1800)
    return () => clearTimeout(t)
  }, [floatKey])

  if (!stats) {return null}

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

// ─── 桌宠快捷开关：放在左侧栏 ───
function PetSidebarToggle() {
  const [petRunning, setPetRunning] = useState(false)
  useEffect(() => {
    ;(async () => {
      try {
        const status = await (window as any).luminaAPI?.petStatus?.()
        setPetRunning(!!status)
      } catch {}
    })()
    // 主进程状态广播：开关即时同步，无需额外点击刷新
    const unsub = (window as any).luminaAPI?.onPetState?.((running: boolean) => {
      setPetRunning(!!running)
    })
    return () => { unsub?.() }
  }, [])
  const toggle = async () => {
    const next = !petRunning
    try {
      const res = await (window as any).luminaAPI?.petToggle?.(next)
      if (res?.ok) {setPetRunning(next)}
    } catch {}
  }
  return (
    <button
      onClick={toggle}
      title={petRunning ? '关闭 Lumina Virtual Pet' : '开启 Lumina Virtual Pet'}
      style={{
        display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px',
        margin: '0 6px 4px', background: 'var(--surface-100)',
        borderRadius: 'var(--radius-md)', border: '1px solid var(--border-light)',
        cursor: 'pointer', userSelect: 'none',
      }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>🐾 Lumina Virtual Pet</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 10, color: petRunning ? '#10b981' : 'var(--text-disabled, #9ca3af)' }}>
            {petRunning ? '运行中' : '已关闭'}
          </span>
          <div style={{
            width: 32, height: 18, borderRadius: 9,
            background: petRunning ? 'var(--accent-500, #ec4899)' : 'rgba(0,0,0,0.12)',
            position: 'relative', transition: 'background .2s',
          }}>
            <div style={{
              position: 'absolute', top: 2, width: 14, height: 14, borderRadius: 7,
              background: '#fff', transition: 'left .2s',
              left: petRunning ? 16 : 2, boxShadow: '0 1px 3px rgba(0,0,0,.3)',
            }} />
          </div>
        </div>
      </div>
    </button>
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
    { id: 'news', label: '📡 新闻', Icon: IconStar },
    { id: 'profile', label: '个性化', Icon: IconUser },
    { id: 'teamcommunity', label: 'Lumina团队社区', Icon: IconUser },
    { id: 'settings', label: '设置', Icon: IconSettings },
    { id: 'more', label: '更多设置', Icon: IconSettings },
    { id: 'deepresearch', label: '深度调研', Icon: IconGlobe },
    { id: 'skillmarket', label: '技能商店', Icon: IconZap },

  ]},
]

// 🆕 团队状态已移至 TopBar 顶部栏显示

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

  // 🆕 窄屏自适应：DevTools 打开或简约模式时只显示图标
  const compactMode = useStore((s) => s.compactMode)
  const [devtoolsOpen, setDevtoolsOpen] = useState(false)
  useEffect(() => {
    const api = (window as any).luminaAPI
    if (!api?.onDevToolsChanged) {return}
    return api.onDevToolsChanged((opened: boolean) => setDevtoolsOpen(opened))
  }, [])
  const compact = compactMode || devtoolsOpen

  return (
    <nav className={`sidebar${compact ? ' sidebar-compact' : ''}`}>
      {/* 滚动内容区 — TeamLiveFeed 和 footer 始终固定底部 */}
      <div className="sidebar-scroll">
      {/* 🆕 团队状态已移至 TopBar 顶部栏显示 */}

      {sections.map((section) => (
        <div key={section.label} className="sidebar-section">
          {section.items.map((item) => {
            const isActive = activePanel === item.id
            return (
              <button key={item.id}
                className={'sidebar-item' + (isActive ? ' active' : '')}
                onClick={() => setActivePanel(item.id)}
                style={{ position: 'relative' }}>
                <item.Icon size={18} />
                {!compact && <span>{item.label}</span>}
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

      {/* 🐱 桌宠快捷开关（左侧栏） */}
      <PetSidebarToggle />

        {/* spacer pushes everything below to the bottom */}
        <div className="sidebar-spacer" />
      </div>  {/* closes sidebar-scroll */}

      {/* 🆕 v1.0: 团队直播小窗 — 始终在底部可见 */}
      {!compact && <TeamLiveFeed />}

      {/* 🆕 v3.1: XP 进度条（游戏化青铜档） */}
      {!compact && <GamificationProgressBar />}

      {!compact && <div className="sidebar-footer">
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
      </div>}
    </nav>
  )
}
