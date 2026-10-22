// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
import React from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '../../stores/appStore'
import { SettingSection } from '../../components/SettingsUI'

/** 🎨 外观主题设置 */
export default function SettingsAppearance() {
  const { t } = useTranslation()
  const theme = useStore(s => s.theme)
  const setTheme = useStore(s => s.setTheme)
  const compactMode = useStore(s => s.compactMode)
  const setCompactMode = useStore(s => s.setCompactMode)

  const options = [
    { id: 'light' as const, emoji: '☀️', label: t('appearance.light'), desc: t('appearance.light_desc') },
    { id: 'dark' as const, emoji: '🌙', label: t('appearance.dark'), desc: t('appearance.dark_desc') },
    { id: 'system' as const, emoji: '💻', label: t('appearance.system'), desc: t('appearance.system_desc') },
  ]

  return (
    <SettingSection title={t('appearance.theme_title')} desc={t('appearance.theme_desc')}>
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
                  {t('appearance.in_use')}
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
        {t('appearance.saved_note')}
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
              <span>✨</span> {t('appearance.compact_mode')}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 3, lineHeight: 1.5 }}>
              {t('appearance.compact_desc')}
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
            {t('appearance.compact_on_note')}
          </div>
        )}
      </div>
    </SettingSection>
  )
}
