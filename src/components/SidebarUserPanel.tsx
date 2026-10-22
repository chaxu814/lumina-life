// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
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
import { useTranslation } from 'react-i18next'
import { useStore } from '../stores/appStore'
import { showToast } from './Toast'
import { IconBrain, IconMessageCircle, IconRefresh, IconSun, IconX } from './Icons'

export default function SidebarUserPanel() {
  const { t } = useTranslation()
  const profile = useStore(s => s.profile)
  const theme = useStore(s => s.theme)
  const setTheme = useStore(s => s.setTheme)
  const setActivePanel = useStore(s => s.setActivePanel)

  const [expanded, setExpanded] = useState(false)

  const nickname = profile?.nickname || t('userpanel.default_nickname')
  const initial = nickname.trim().charAt(0).toUpperCase() || '?'

  const close = () => setExpanded(false)

  // ⚠️ openSettings / openMore 已随「设置 / 更多设置」移至侧栏常驻项而移除。
  //   这里刻意不保留转发：留一个没人调用的 setter 只会在下次重构时
  //   被误当成「用户面板也能进设置」，把刚消除的重复入口又加回来。
  // 记忆与进化 → 打开设置页的「记忆与进化」分区
  const openMemory = () => {
    close()
    window.dispatchEvent(new CustomEvent('lumina:open-settings', { detail: { tab: 'memory' } }))
  }
  const onFeedback = () => { showToast(t('userpanel.feedback_toast'), 'info'); close() }
  const onCheckUpdate = async () => {
    try {
      const r = await (window as any).luminaAPI?.updateCheck?.()
      if (r?.available) { showToast(t('userpanel.update_available', { version: r.version }), 'success') }
      else { showToast(t('userpanel.update_latest'), 'success') }
    } catch { showToast(t('userpanel.update_failed'), 'warning') }
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
      {(['light', 'dark'] as const).map(mode => {
        const active = (mode === 'dark' ? theme === 'dark' : theme === 'light')
        return (
          <button key={mode} onClick={() => setTheme(mode as 'light' | 'dark')} style={{
            padding: '3px 10px', border: 'none', cursor: 'pointer',
            background: active ? 'var(--surface-200, rgba(255,255,255,0.10))' : 'transparent',
            color: active ? 'var(--text-primary)' : 'var(--text-tertiary)',
            fontWeight: active ? 600 : 400,
          }}>{mode === 'dark' ? t('userpanel.theme_dark') : t('userpanel.theme_light')}</button>
        )
      })}
    </div>
  )

  const itemRow = (icon: React.ReactNode, label: string, right?: React.ReactNode, onClick?: () => void) => (
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
        <span style={{
          width: 16, display: 'inline-flex', alignItems: 'center',
          justifyContent: 'center', opacity: 0.85, flex: 'none',
        }}>{icon}</span>
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
        title={expanded ? t('userpanel.collapse') : t('userpanel.expand')}
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
      {/* 🔧 2026-10-15：「设置 / 更多设置」已移出本菜单，改为侧栏常驻项（见 Sidebar.tsx）。
          留在这里会造成同一个入口在侧栏与折叠区各出现一次 —— 用户改完主题再展开用户
          面板看到另一个「外观」，会怀疑自己没保存成功。设置类入口应当只有一个位置。
          本菜单只保留「侧栏放不下」的轻量项：快捷切换、反馈与账号操作。 */}
      <div style={{
        maxHeight: expanded ? 240 : 0,
        opacity: expanded ? 1 : 0,
        overflow: 'hidden',
        transition: 'max-height 0.28s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.22s ease',
      }}>
        <div style={{ paddingTop: 4 }}>
          {itemRow(<IconSun size={14} />, t('userpanel.appearance'), Segmented)}
          {itemRow(<IconBrain size={14} />, t('userpanel.memory'), undefined, openMemory)}
          {itemRow(<IconMessageCircle size={14} />, t('userpanel.feedback'), undefined, onFeedback)}
          {itemRow(<IconRefresh size={14} />, t('userpanel.check_update'), undefined, onCheckUpdate)}
          {itemRow(<IconX size={14} />, t('userpanel.logout'), undefined, onLogout)}
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
