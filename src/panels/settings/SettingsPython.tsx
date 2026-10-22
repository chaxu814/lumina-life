// ============================================================
// panels/settings/SettingsPython.tsx — Python 运行时（语音/向量）状态
//
// 数据源：pythonGetStatus() 拉一次 + onPythonStatus 订阅实时推送。
// 展示：整体可用性（Python 是否存在）、TTS / STT / 向量 embedding
//       三项能力各自的可用开关、主进程 message 与文档链接。
// 原则：死功能必须有提示，不允许静默。
// ============================================================

import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

// 复用 src/types.d.ts 在 luminaAPI.pythonGetStatus 上声明的返回类型
type PythonStatus = Awaited<ReturnType<typeof window.luminaAPI.pythonGetStatus>>

export default function SettingsPython() {
  const { t } = useTranslation()
  const [status, setStatus] = useState<PythonStatus | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const api = window.luminaAPI

    const apply = (s: PythonStatus) => {
      if (cancelled) {return}
      setStatus(s)
      setLoading(false)
    }

    // 拉当前状态（preload 未暴露时静默降级为「检测中→不可用」展示）
    if (typeof api.pythonGetStatus === 'function') {
      api.pythonGetStatus().then(apply).catch(() => setLoading(false))
    } else {
      setLoading(false)
    }

    // 订阅后续推送
    let unsub: (() => void) | undefined
    if (typeof api.onPythonStatus === 'function') {
      unsub = api.onPythonStatus(apply)
    }

    return () => {
      cancelled = true
      if (typeof unsub === 'function') {unsub()}
    }
  }, [])

  const rows: Array<{ key: 'tts' | 'stt' | 'embedding'; labelKey: string }> = [
    { key: 'tts', labelKey: 'python.row_tts' },
    { key: 'stt', labelKey: 'python.row_stt' },
    { key: 'embedding', labelKey: 'python.row_embedding' },
  ]

  return (
    <div style={{ padding: '4px 2px' }}>
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4, color: 'var(--text-primary)' }}>
        {t('python.title')}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 16 }}>
        {t('python.desc')}
      </div>

      {/* 整体状态 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '10px 14px', borderRadius: 10, marginBottom: 12,
        background: status
          ? (status.pythonPresent ? 'var(--green-100)' : 'var(--red-100)')
          : 'var(--surface-100)',
      }}>
        <span style={{ fontSize: 16 }}>{loading ? '⏳' : status?.pythonPresent ? '✅' : '❌'}</span>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
            {loading ? t('python.loading')
              : status?.pythonPresent ? t('python.present_ok')
              : t('python.present_missing')}
          </div>
          {status?.message && (
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
              {status.message}
            </div>
          )}
        </div>
      </div>

      {/* 分项能力 */}
      {rows.map((row) => {
        const ok = status?.[row.key] === true
        return (
          <div key={row.key} style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '10px 14px', borderRadius: 10, marginBottom: 8,
            border: '1px solid var(--border-light)',
            background: 'var(--surface-0)',
          }}>
            <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>{t(row.labelKey)}</span>
            <span style={{
              fontSize: 11, fontWeight: 600, padding: '2px 10px', borderRadius: 10,
              background: ok ? 'var(--green-100)' : 'var(--red-100)',
              color: ok ? '#006644' : 'var(--red-500)',
            }}>
              {loading ? t('python.loading') : ok ? t('python.cap_on') : t('python.cap_off')}
            </span>
          </div>
        )
      })}

      {/* 文档链接：提到 const 便于在回调内保留真值收窄，无需 as 断言 */}
      {status?.docUrl && (
        <button
          onClick={() => window.luminaAPI.openExternal(status.docUrl as string)}
          style={{
            marginTop: 8, padding: '8px 14px', borderRadius: 8, cursor: 'pointer',
            border: '1px solid var(--border-medium)', background: 'var(--surface-100)',
            color: 'var(--accent-600)', fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
          }}
        >
          {t('python.doc_button')} ↗
        </button>
      )}
    </div>
  )
}
