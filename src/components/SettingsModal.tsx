import React, { useState } from 'react'
import SettingsPanel from '../panels/SettingsPanel'
import SettingsLLM from '../panels/settings/SettingsLLM'
import SettingsTTS from '../panels/settings/SettingsTTS'
import SettingsNotifications from '../panels/settings/SettingsNotifications'
import SettingsAppearance from '../panels/settings/SettingsAppearance'
import SettingsPush from '../panels/settings/SettingsPush'
import SettingsPet from '../panels/settings/SettingsPet'

/* ── 侧边栏导航项 ── */
const SIDEBAR_ITEMS = [
  { id: 'llm', icon: '🤖', label: 'LLM 模型' },
  { id: 'tts', icon: '🔊', label: 'TTS 语音' },
  { id: 'notifications', icon: '🔔', label: '通知' },
  { id: 'appearance', icon: '🎨', label: '外观' },
  { id: 'push', icon: '📱', label: '推送' },
  { id: 'channels', icon: '🔗', label: '渠道' },
  { id: 'security', icon: '🛡️', label: '安全中心' },
  { id: 'tasks', icon: '⏰', label: '定时任务' },
  { id: 'pet', icon: '🐱', label: '桌宠' },
] as const

type SidebarId = (typeof SIDEBAR_ITEMS)[number]['id']

interface SettingsModalProps {
  open: boolean
  onClose: () => void
}

export default function SettingsModal({ open, onClose }: SettingsModalProps) {
  const [activeSection, setActiveSection] = useState<SidebarId>('llm')

  if (!open) return null

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
            ⚙️ 设置
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
                  <span style={{ fontSize: 16, width: 22, textAlign: 'center', flexShrink: 0 }}>
                    {item.icon}
                  </span>
                  <span style={{ lineHeight: 1.3 }}>{item.label}</span>
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
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>
              {SIDEBAR_ITEMS.find((i) => i.id === activeSection)?.icon}{' '}
              {SIDEBAR_ITEMS.find((i) => i.id === activeSection)?.label}
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
              title="关闭设置"
            >
              ✕
            </button>
          </div>

          {/* 内容主体（可滚动） */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px 20px' }}>
            {activeSection === 'llm' && <SettingsLLM />}
            {activeSection === 'tts' && <SettingsTTS />}
            {activeSection === 'notifications' && <SettingsNotifications />}
            {activeSection === 'appearance' && <SettingsAppearance />}
            {activeSection === 'push' && <SettingsPush />}
            {activeSection === 'pet' && <SettingsPet />}
            {(activeSection === 'channels' || activeSection === 'security' || activeSection === 'tasks') && (
              <SettingsPanel embedded activeTab={activeSection} onNotice={null} />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
