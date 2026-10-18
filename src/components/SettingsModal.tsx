import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  IconBell, IconBot, IconBrain, IconClock, IconGlobe, IconHeart, IconLink, IconMobile,
  IconPalette, IconSearch, IconShield, IconSpeaker,
} from './Icons'
import SettingsPanel from '../panels/SettingsPanel'
import SettingsLLM from '../panels/settings/SettingsLLM'
import SettingsTTS from '../panels/settings/SettingsTTS'
import SettingsNotifications from '../panels/settings/SettingsNotifications'
import SettingsAppearance from '../panels/settings/SettingsAppearance'
import SettingsLanguage from '../panels/settings/SettingsLanguage'
import SettingsPush from '../panels/settings/SettingsPush'
import SettingsPet from '../panels/settings/SettingsPet'
import SettingsMemory from '../panels/settings/SettingsMemory'
// 🔧 2026-10-15：外观 / 浏览器 从「更多设置」搬到这里。
//   此前两个弹窗并存导致同一个「外观」有两套完全不同的实现：
//     · 这里 → SettingsAppearance（浅色/深色/跟随系统 + 简约模式）
//     · 更多设置 → AppearancePanel（主题卡片 / 导入 / 删除 / 可视化编辑器）
//   用户在两个弹窗之间来回找同一个功能，是典型的「设置没有单一事实源」。
//   现在合并到一处：主题切换与简约模式在上，主题卡片与编辑器在下，
//   两套能力都在「设置 → 外观」里，浏览器同理。
import AppearancePanel from '../panels/AppearancePanel'
import BrowserLinksPanel from '../panels/settings/BrowserLinksPanel'

/* ── 侧边栏导航项（label 走 i18n） ──
   2026-10-18：图标从 emoji 改为线性 SVG，尺寸由 size 精确控制。 */
const SIDEBAR_ITEMS = [
  { id: 'llm', icon: <IconBot size={16} />, labelKey: 'settings.nav_llm' },
  { id: 'tts', icon: <IconSpeaker size={16} />, labelKey: 'settings.nav_tts' },
  { id: 'notifications', icon: <IconBell size={16} />, labelKey: 'settings.nav_notifications' },
  { id: 'appearance', icon: <IconPalette size={16} />, labelKey: 'settings.nav_appearance' },
  { id: 'language', icon: <IconGlobe size={16} />, labelKey: 'settings.nav_language' },
  { id: 'push', icon: <IconMobile size={16} />, labelKey: 'settings.nav_push' },
  { id: 'channels', icon: <IconLink size={16} />, labelKey: 'settings.nav_channels' },
  { id: 'browser', icon: <IconSearch size={16} />, labelKey: 'settings.nav_browser' },
  { id: 'security', icon: <IconShield size={16} />, labelKey: 'settings.nav_security' },
  { id: 'tasks', icon: <IconClock size={16} />, labelKey: 'settings.nav_tasks' },
  { id: 'pet', icon: <IconHeart size={16} />, labelKey: 'settings.nav_pet' },
  { id: 'memory', icon: <IconBrain size={16} />, labelKey: 'settings.nav_memory' },
] as const

type SidebarId = (typeof SIDEBAR_ITEMS)[number]['id']

interface SettingsModalProps {
  open: boolean
  onClose: () => void
  initialTab?: string
}

export default function SettingsModal({ open, onClose, initialTab }: SettingsModalProps) {
  const { t } = useTranslation()
  const [activeSection, setActiveSection] = useState<SidebarId>((initialTab as SidebarId) || 'llm')

  // 当 initialTab 变化时同步
  React.useEffect(() => {
    if (initialTab) {setActiveSection(initialTab as SidebarId)}
  }, [initialTab])

  if (!open) {return null}

  return (
    /* ── 背景遮罩 ── */
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10000,
        backgroundColor: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        animation: 'fadeIn 0.15s ease-out',
        fontFamily: '"Microsoft YaHei", "微软雅黑", sans-serif',
      }}
      onClick={onClose}
    >
      {/* ── 弹窗主体 ── */}
      <div
        style={{
          display: 'flex',
          width: 960,
          maxWidth: '92vw',
          height: '85vh',
          maxHeight: 720,
          backgroundColor: 'var(--surface-0)',
          borderRadius: 12,
          boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
          overflow: 'hidden',
          animation: 'fadeInDown 0.2s ease-out',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ═══ 左侧导航栏 ═══ */}
        <div
          style={{
            width: 200,
            flexShrink: 0,
            backgroundColor: 'var(--surface-50)',
            borderRight: '1px solid var(--border-light)',
            display: 'flex',
            flexDirection: 'column',
            padding: '16px 0 12px',
          }}
        >
          {/* 标题 */}
          <div
            style={{
              padding: '0 16px 14px',
              fontSize: 16,
              fontWeight: 700,
              color: 'var(--text-primary)',
              borderBottom: '1px solid var(--border-light)',
              marginBottom: 8,
              fontFamily: '"Microsoft YaHei", "微软雅黑", sans-serif',
            }}
          >
            {t('settings.title')}
          </div>

          {/* 导航项列表 */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '4px 8px' }}>
            {SIDEBAR_ITEMS.map((item) => {
              const active = activeSection === item.id
              return (
                <button
                  key={item.id}
                  onClick={() => setActiveSection(item.id)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    width: '100%',
                    padding: '8px 12px',
                    borderRadius: 8,
                    border: 'none',
                    fontSize: 13,
                    fontWeight: active ? 600 : 400,
                    color: active ? 'var(--accent-600)' : 'var(--text-secondary)',
                    backgroundColor: active ? 'var(--accent-50)' : 'transparent',
                    cursor: 'pointer',
                    transition: 'all 0.12s',
                    textAlign: 'left',
                    marginBottom: 1,
                    fontFamily: '"Microsoft YaHei", "微软雅黑", sans-serif',
                  }}
                  onMouseEnter={(e) => {
                    if (!active) {
                      e.currentTarget.style.backgroundColor = 'var(--surface-100)'
                      e.currentTarget.style.color = 'var(--text-primary)'
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!active) {
                      e.currentTarget.style.backgroundColor = 'transparent'
                      e.currentTarget.style.color = 'var(--text-secondary)'
                    }
                  }}
                >
                  <span style={{
                    width: 22, flexShrink: 0, display: 'inline-flex',
                    alignItems: 'center', justifyContent: 'center',
                  }}>
                    {item.icon}
                  </span>
                  <span style={{ lineHeight: 1.3 }}>{t(item.labelKey)}</span>
                </button>
              )
            })}
          </div>

          {/* 底部版本信息 */}
          <div
            style={{
              padding: '8px 16px 0',
              fontSize: 10,
              color: 'var(--text-secondary)',
              borderTop: '1px solid var(--border-light)',
              marginTop: 4,
              paddingTop: 10,
              opacity: 0.6,
              fontFamily: '"Microsoft YaHei", "微软雅黑", sans-serif',
            }}
          >
            Lumina Life v1.0.0
          </div>
        </div>

        {/* ═══ 右侧内容区 ═══ */}
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            position: 'relative',
          }}
        >
          {/* 顶部栏：标题 + 关闭按钮 */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '14px 20px 12px',
              borderBottom: '1px solid var(--border-light)',
              flexShrink: 0,
            }}
          >
            <div style={{
              fontSize: 15, fontWeight: 700, color: 'var(--text-primary)',
              display: 'flex', alignItems: 'center', gap: 7,
            }}>
              {SIDEBAR_ITEMS.find((i) => i.id === activeSection)?.icon}
              <span>
                {t(SIDEBAR_ITEMS.find((i) => i.id === activeSection)?.labelKey ?? 'settings.title')}
              </span>
            </div>
            <button
              onClick={onClose}
              style={{
                width: 30,
                height: 30,
                borderRadius: 8,
                border: 'none',
                background: 'transparent',
                color: 'var(--text-secondary)',
                fontSize: 18,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'all 0.12s',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--surface-100)'
                e.currentTarget.style.color = 'var(--text-primary)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent'
                e.currentTarget.style.color = 'var(--text-secondary)'
              }}
              title={t('settings.close')}
            >
              ✕
            </button>
          </div>

          {/* 内容主体（可滚动） */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px 20px' }}>
            {activeSection === 'llm' && <SettingsLLM />}
            {activeSection === 'tts' && <SettingsTTS />}
            {activeSection === 'notifications' && <SettingsNotifications />}
            {activeSection === 'browser' && <BrowserLinksPanel />}
            {/* 外观 = 主题切换 + 简约模式 + 主题卡片/导入/编辑器（两套能力合并到一处） */}
            {activeSection === 'appearance' && (
              <>
                <SettingsAppearance />
                <div style={{ marginTop: 20 }}>
                  <AppearancePanel />
                </div>
              </>
            )}
            {activeSection === 'push' && <SettingsPush />}
            {activeSection === 'language' && <SettingsLanguage />}
            {activeSection === 'pet' && <SettingsPet />}
            {activeSection === 'memory' && <SettingsMemory onClose={onClose} />}
            {(activeSection === 'channels' || activeSection === 'security' || activeSection === 'tasks') && (
              <SettingsPanel embedded activeTab={activeSection} onNotice={null} />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
