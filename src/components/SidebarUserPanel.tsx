// ============================================================
// SidebarUserPanel.tsx — 侧栏底部用户面板（可折叠）
//
// 行为：
//   · 默认**折叠**：只显示头像 + 昵称 + 一个 ▸ 提示可展开
//   · 点击头部展开：露出菜单列表（设置/外观/记忆与进化/意见反馈/检查更新/退出登录）
//   · 底部始终保留一行 "Lumina Life 1.0" 小字
//   · 点菜单项后自动折叠（避免占着空间）
// 数据源：profile.nickname/avatar → appStore；主题 → setTheme；
//         面板跳转 → setActivePanel；更新 → updateCheck；退出 → windowClose。
// ============================================================

import React, { useState } from 'react'
import { useStore } from '../stores/appStore'
import { showToast } from './Toast'

export default function SidebarUserPanel() {
  const profile = useStore(s => s.profile)
  const theme = useStore(s => s.theme)
  const setTheme = useStore(s => s.setTheme)
  const setActivePanel = useStore(s => s.setActivePanel)

  const [expanded, setExpanded] = useState(false)

  const nickname = profile?.nickname || '用户'
  const initial = nickname.trim().charAt(0).toUpperCase() || '?'

  const close = () => setExpanded(false)

  const openSettings = () => { setActivePanel('settings'); close() }
  const openMore = () => { setActivePanel('more'); close() }
  // 记忆与进化 → 打开设置页的「记忆与进化」分区（不再只是跳到记忆浏览器）
  const openMemory = () => {
    close()
    window.dispatchEvent(new CustomEvent('lumina:open-settings', { detail: { tab: 'memory' } }))
  }
  const onFeedback = () => { showToast('意见反馈：请通过 设置 → 意见反馈 提交', 'info'); close() }
  const onCheckUpdate = async () => {
    try {
      const r = await (window as any).luminaAPI?.updateCheck?.()
      if (r?.available) { showToast(`🎉 发现新版本 ${r.version}，正在准备更新…`, 'success') }
      else { showToast('已是最新版本 ✓', 'success') }
    } catch { showToast('检查更新失败', 'warning') }
    close()
  }
  const onLogout = () => {
    try { (window as any).luminaAPI?.windowClose?.() } catch {}
  }

  // 浅色/深色内联分段控件
  const Segmented = (
    <div onClick={e => e.stopPropagation()} style={{
      display: 'inline-flex', borderRadius: 6, overflow: 'hidden',
      border: '1px solid var(--border-light)', fontSize: 11,
    }}>
      {(['light', 'dark'] as const).map(t => {
        const active = (t === 'dark' ? theme === 'dark' : theme === 'light')
        return (
          <button key={t} onClick={() => setTheme(t as 'light' | 'dark')} style={{
            padding: '3px 10px', border: 'none', cursor: 'pointer',
            background: active ? 'var(--surface-200, rgba(255,255,255,0.10))' : 'transparent',
            color: active ? 'var(--text-primary)' : 'var(--text-tertiary)',
            fontWeight: active ? 600 : 400,
          }}>{t === 'dark' ? '深色' : '浅色'}</button>
        )
      })}
    </div>
  )

  const itemRow = (icon: string, label: string, right?: React.ReactNode, onClick?: () => void) => (
    <div
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e => { if (e.key === 'Enter' || e.key === ' ') onClick() }) : undefined}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '7px 4px', borderRadius: 6, cursor: onClick ? 'pointer' : 'default',
        fontSize: 12, color: 'var(--text-secondary)',
        transition: 'background .12s',
      }}
      onMouseEnter={e => { if (onClick) (e.currentTarget as HTMLElement).style.background = 'var(--surface-200, rgba(255,255,255,0.04))' }}
      onMouseLeave={e => { if (onClick) (e.currentTarget as HTMLElement).style.background = 'transparent' }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 16, textAlign: 'center', opacity: 0.85 }}>{icon}</span>
        <span>{label}</span>
      </span>
      {right && <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{right}</span>}
    </div>
  )

  return (
    <div style={{
      margin: '6px 8px 0',
      padding: '8px 10px 6px',
      borderRadius: 10,
      background: 'var(--surface-100, #1c1d22)',
      border: '1px solid var(--border-light, rgba(255,255,255,0.06))',
      boxShadow: '0 1px 0 rgba(0,0,0,.2)',
    }}>
      {/* 头部：头像 + 昵称 + 折叠指示（点击切换） */}
      <div
        onClick={() => setExpanded(v => !v)}
        role="button"
        aria-expanded={expanded}
        tabIndex={0}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setExpanded(v => !v) }}
        title={expanded ? '收起' : '展开'}
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '4px 2px', borderRadius: 6, cursor: 'pointer', userSelect: 'none',
          outline: 'none',
        }}
      >
        {profile?.avatar && profile.avatar.startsWith('data:image/') ? (
          <img src={profile.avatar} alt="" style={{ width: 28, height: 28, borderRadius: 14, objectFit: 'cover', flexShrink: 0 }} />
        ) : (
          <div style={{
            width: 28, height: 28, borderRadius: 14,
            background: 'linear-gradient(135deg, #f59e0b, #ec4899)',
            color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontWeight: 700, fontSize: 13, flexShrink: 0,
          }}>{initial}</div>
        )}
        <div style={{ flex: 1, fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {nickname}
        </div>
        <span style={{
          fontSize: 10, color: 'var(--text-tertiary)',
          transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
          transition: 'transform .15s',
          display: 'inline-block', padding: '0 4px',
        }}>▸</span>
      </div>

      {/* 展开：菜单列表（CSS 动画过渡） */}
      <div style={{
        maxHeight: expanded ? 300 : 0,
        opacity: expanded ? 1 : 0,
        overflow: 'hidden',
        transition: 'max-height 0.28s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.22s ease',
      }}>
        <div style={{ paddingTop: 4 }}>
          {itemRow('⚙️', '设置', <span>Ctrl+,</span>, openSettings)}
          {itemRow('⚙️', '更多设置', undefined, openMore)}
          {itemRow('🎨', '外观', Segmented)}
          {itemRow('💡', '记忆与进化', undefined, openMemory)}
          {itemRow('💬', '意见反馈', undefined, onFeedback)}
          {itemRow('🔄', '检查更新', undefined, onCheckUpdate)}
          {itemRow('⏏️', '退出登录', undefined, onLogout)}
        </div>
      </div>

      {/* 底部：Lumina Life 1.0（始终显示） */}
      <div style={{
        marginTop: expanded ? 6 : 0,
        paddingTop: expanded ? 6 : 0,
        borderTop: expanded ? '1px solid var(--border-light, rgba(255,255,255,0.06))' : 'none',
        textAlign: 'center', fontSize: 10, color: 'var(--text-tertiary)', letterSpacing: 0.5,
      }}>
        Lumina Life 1.0
      </div>
    </div>
  )
}
