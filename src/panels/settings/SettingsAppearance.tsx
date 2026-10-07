import React from 'react'
import { useStore } from '../../stores/appStore'
import { SettingSection } from '../../components/SettingsUI'

/** 🎨 外观主题设置 */
export default function SettingsAppearance() {
  const theme = useStore(s => s.theme)
  const setTheme = useStore(s => s.setTheme)
  const compactMode = useStore(s => s.compactMode)
  const setCompactMode = useStore(s => s.setCompactMode)

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
                border: `2px solid ${active ? 'var(--accent-500)' : 'var(--border-light)'}`,
                background: active ? 'var(--accent-50)' : 'var(--surface-0)',
                transition: 'all 0.2s', textAlign: 'center',
              }}>
              <div style={{ fontSize: 28, marginBottom: 4 }}>{opt.emoji}</div>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{opt.label}</div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>{opt.desc}</div>
              {active && (
                <div style={{
                  marginTop: 8, fontSize: 10, fontWeight: 600, color: 'var(--accent-600)',
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
        background: 'var(--accent-50)',
        border: '1px solid var(--accent-100)', fontSize: 11, color: 'var(--text-primary)', lineHeight: 1.5,
      }}>
        💡 当前主题已自动保存，下次启动自动恢复。
      </div>

      {/* 🆕 简约模式开关 */}
      <div style={{
        marginTop: 20, padding: 14, borderRadius: 10,
        border: '1px solid var(--border-light)',
        background: 'var(--surface-0)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <span>✨</span> 简约模式
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 3, lineHeight: 1.5 }}>
              隐藏侧边栏文字、历史列表和次要按钮，让界面更清爽简洁。
            </div>
          </div>
          <button
            onClick={() => setCompactMode(!compactMode)}
            style={{
              width: 44, height: 24, borderRadius: 12, border: 'none', cursor: 'pointer',
              background: compactMode ? 'var(--accent-600)' : 'var(--surface-300)',
              position: 'relative', transition: 'background 0.2s', flexShrink: 0,
            }}
          >
            <div style={{
              width: 18, height: 18, borderRadius: '50%', background: 'var(--bg-primary)',
              position: 'absolute', top: 3,
              left: compactMode ? 23 : 3,
              transition: 'left 0.2s',
              boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
            }} />
          </button>
        </div>
        {compactMode && (
          <div style={{
            marginTop: 8, padding: '6px 10px', borderRadius: 6,
            background: 'var(--accent-50)', border: '1px solid var(--accent-100)',
            fontSize: 11, color: 'var(--text-primary)',
          }}>
            ✓ 简约模式已开启 — 效果等同于打开开发者工具时的紧凑布局
          </div>
        )}
      </div>
    </SettingSection>
  )
}
