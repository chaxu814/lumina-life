// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore, type PanelType } from '../stores/appStore'
import {
  IconMessageCircle, IconMail, IconSettings, IconSliders,
  IconZap, IconGlobe, IconUser, IconStar, IconHeart, IconShield,
} from './Icons'
import TeamLiveFeed from './TeamLiveFeed'  // 🆕 v1.0: 团队直播小窗
import SidebarUserPanel from './SidebarUserPanel'  // 🆕 用户面板（仿 chaxu814 风格）
import { loadFlags } from '../services/featureFlagsClient'  // I7 精简模式

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
        // 🔧 2026-10-09 修复：后端返回 { ok, data: {...} }，必须解包 .data。
        //   之前直接 setStats(s) → level/totalXp/currentXp 全 undefined，
        //   侧栏只剩 "Lv." / "XP" / "0 / 100" 的兜底值（而个人中心弹窗解包了，所以显示正常）。
        const st = s?.data ?? s
        if (st) {setStats(st)}
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
  const { t } = useTranslation()
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
      title={petRunning ? t('sidebar.pet_toggle_off') : t('sidebar.pet_toggle_on')}
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
            {petRunning ? t('sidebar.pet_running') : t('sidebar.pet_off')}
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
  id: PanelType; labelKey: string; Icon: React.FC<{ size?: number }>
}

const sections: { labelKey: string; items: NavItem[] }[] = [
  { labelKey: 'sidebar.section_main', items: [
    { id: 'chat', labelKey: 'sidebar.nav_chat', Icon: IconMessageCircle },
    { id: 'mail', labelKey: 'sidebar.nav_mail', Icon: IconMail },
    { id: 'news', labelKey: 'sidebar.nav_news', Icon: IconStar },
    { id: 'profile', labelKey: 'sidebar.nav_profile', Icon: IconUser },
    { id: 'deepresearch', labelKey: 'sidebar.nav_deepresearch', Icon: IconGlobe },
    { id: 'skillmarket', labelKey: 'sidebar.nav_skillmarket', Icon: IconZap },
    { id: 'sandbox', labelKey: 'sidebar.nav_sandbox', Icon: IconShield },  // I5

  ]},
  // 🔧 2026-10-15：设置 / 更多设置提到侧栏常驻。
  //   此前它们只存在于底部**可折叠**的用户面板里（SidebarUserPanel，默认收起），
  //   于是「改主题」「换模型」这类高频操作要先点开用户头像、展开菜单、再点一项 ——
  //   三步才能到。设置类入口藏在折叠区里，是「功能存在但等于不存在」的典型形态。
  //   现在与聊天/邮件同级常驻可见，用户一眼就知道去哪配置。
  { labelKey: 'sidebar.section_settings', items: [
    { id: 'settings', labelKey: 'sidebar.nav_settings', Icon: IconSettings },
    { id: 'more', labelKey: 'sidebar.nav_more', Icon: IconSliders },
  ]},
]

// 🆕 团队状态已移至 TopBar 顶部栏显示

// ═══════════════════════════════════════════════════════════
// 主组件
// ═══════════════════════════════════════════════════════════
export default function Sidebar() {
  const { t } = useTranslation()
  const activePanel = useStore((s) => s.activePanel)
  const setActivePanel = useStore((s) => s.setActivePanel)
  const [mailUnread, setMailUnread] = useState(0)
  // I7 精简模式：主进程开关加载后决定侧边栏显隐（只露 聊天/设置 + 一键办事）
  const [minimal, setMinimal] = useState(false)
  useEffect(() => { loadFlags().then(f => setMinimal(!!f['mode.minimal'])) }, [])
  const organizeDownloads = () => { (window as any).luminaAPI?.commandExecute?.('帮我把下载文件夹里的文件按类型整理到对应子文件夹') }

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

      {sections.map((section) => {
        // 精简模式（mode.minimal）：只保留「聊天 / 设置 / 更多设置」。
        // 这三项是产品的最小可用闭环 —— 能对话、能配置、能进高级设置。
        // 其余（邮件/新闻/技能商店…）在精简模式下隐藏。
        const visibleItems = section.items.filter(
          (item) => !minimal || item.id === 'chat' || item.id === 'settings' || item.id === 'more',
        )
        // 整个分组被清空时不要留一个空的「设置」标题，否则侧栏会出现只有标题没有内容的怪区块
        if (visibleItems.length === 0) {return null}
        return (
        <div key={section.labelKey} className="sidebar-section">
          {visibleItems.map((item) => {
            const isActive = activePanel === item.id
            return (
              <button key={item.id}
                className={'sidebar-item' + (isActive ? ' active' : '')}
                onClick={() => setActivePanel(item.id)}
                style={{ position: 'relative' }}>
                <item.Icon size={18} />
                {!compact && <span>{t(item.labelKey)}</span>}
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
        )
      })}

      {/* 🐱 桌宠快捷开关（左侧栏） */}
      <PetSidebarToggle />
      {/* I7 精简模式：唯一露出的「一键办事」入口 */}
      {minimal && !compact && (
        <button onClick={organizeDownloads} title={t('sidebar.organize_downloads_title')}
          style={{
            margin: '6px 8px', padding: '8px 6px', borderRadius: 8, cursor: 'pointer',
            border: '1px solid var(--border-light)', background: 'var(--surface-1)',
            fontSize: 12, color: 'var(--text-primary)',
          }}>{t('sidebar.organize_downloads')}</button>
      )}

        {/* spacer pushes everything below to the bottom */}
        <div className="sidebar-spacer" />
      </div>  {/* closes sidebar-scroll */}

      {/* 🆕 v1.0: 团队直播小窗 — 始终在底部可见 */}
      {!compact && <TeamLiveFeed />}

      {/* 🆕 v3.1: XP 进度条（游戏化青铜档） */}
      {!compact && <GamificationProgressBar />}

      {!compact && <SidebarUserPanel />}
    </nav>
  )
}
