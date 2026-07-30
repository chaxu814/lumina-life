import React from 'react'
import { useStore } from '../../stores/appStore'
import { SettingSection } from '../../components/SettingsUI'

/** 🎨 外观主题设置 */
export default function SettingsAppearance() {
  const theme = useStore(s => s.theme)
  const setTheme = useStore(s => s.setTheme)

  const options = [
    { id: 'light' as const, emoji: '☀️', label: '浅色', desc: '明亮清晰' },
    { id: 'dark' as const, emoji: '🌙', label: '深色', desc: '护眼夜间' },
    { id: 'system' as const, emoji: '💻', label: '跟随系统', desc: '自动匹配' },
  ]

  return (
    <SettingSection title="🎨 主题切换" desc="选择你偏好的显示主题。选择「跟随系统」后，Lumina 会自动匹配 Windows 的深浅色模式。">
      <div style={{ display: 'flex', gap: 10 }}>
        {options.map(opt => {
          const active = theme === opt.id
          return (
            <button key={opt.id} onClick={() => setTheme(opt.id)}
              style={{
                flex: 1, padding: '16px 12px', borderRadius: 10, cursor: 'pointer',
                border: `2px solid ${active ? '#a78bfa' : 'var(--border-light)'}`,
                background: active ? '#f5f3ff' : 'var(--surface-0)',
                transition: 'all 0.2s', textAlign: 'center',
              }}>
              <div style={{ fontSize: 28, marginBottom: 4 }}>{opt.emoji}</div>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{opt.label}</div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>{opt.desc}</div>
              {active && (
                <div style={{
                  marginTop: 8, fontSize: 10, fontWeight: 600, color: '#7c3aed',
                }}>
                  使用中 ✓
                </div>
              )}
            </button>
          )
        })}
      </div>
      <div style={{
        marginTop: 14, padding: 10, borderRadius: 8,
        background: 'linear-gradient(135deg, #ede9fe, #f5f3ff)',
        border: '1px solid #ddd6fe', fontSize: 11, color: '#6d28d9', lineHeight: 1.5,
      }}>
        💡 当前主题已自动保存，下次启动自动恢复。
      </div>
    </SettingSection>
  )
}
