// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
import React from 'react'
import { useTranslation } from 'react-i18next'
import { SettingSection } from '../../components/SettingsUI'

/**
 * 🌐 语言设置
 * 从顶部栏的 EN 徽章迁移到这里：语言切换属于「设置」范畴，不应占据顶栏。
 * 默认语言为简体中文（zh-CN），切换后写入 localStorage.lumina_lang 持久化。
 */
export default function SettingsLanguage() {
  const { t, i18n } = useTranslation()

  const current = (i18n.language || 'zh-CN').startsWith('zh') ? 'zh-CN' : 'en-US'

  const options = [
    {
      id: 'zh-CN' as const,
      emoji: '🇨🇳',
      label: t('settings.lang_zh'),
      desc: t('settings.lang_zh_desc'),
    },
    {
      id: 'en-US' as const,
      emoji: '🇺🇸',
      label: t('settings.lang_en'),
      desc: t('settings.lang_en_desc'),
    },
  ]

  return (
    <SettingSection title={t('settings.lang_title')} desc={t('settings.lang_desc')}>
      <div style={{ display: 'flex', gap: 10 }}>
        {options.map(opt => {
          const active = current === opt.id
          return (
            <button
              key={opt.id}
              onClick={() => i18n.changeLanguage(opt.id)}
              style={{
                flex: 1, padding: '16px 12px', borderRadius: 10, cursor: 'pointer',
                border: `2px solid ${active ? 'var(--accent-500)' : 'var(--border-light)'}`,
                background: active ? 'var(--accent-50)' : 'var(--surface-0)',
                transition: 'all 0.2s', textAlign: 'center',
              }}
            >
              <div style={{ fontSize: 28, marginBottom: 4 }}>{opt.emoji}</div>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{opt.label}</div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>{opt.desc}</div>
              {active && (
                <div style={{
                  marginTop: 8, fontSize: 10, fontWeight: 600, color: 'var(--accent-600)',
                }}>
                  {t('settings.lang_active')}
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
        {t('settings.lang_note')}
      </div>
    </SettingSection>
  )
}
