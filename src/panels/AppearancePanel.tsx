// ============================================================
// panels/AppearancePanel.tsx — 外观 / 主题选择
//
// 主题卡片列表（预览色）、点击切换、导入主题、删除自定义主题、
// 打开可视化主题编辑器。
// ============================================================

import React, { useEffect, useState } from 'react'
import ThemeEditorPanel from './ThemeEditorPanel'

interface ThemeItem {
  name: string
  version: string
  author: string
  description: string
  isDark: boolean
  builtIn?: boolean
  vars: Record<string, string>
  preview?: string
}

export default function AppearancePanel() {
  const [themes, setThemes] = useState<ThemeItem[]>([])
  const [current, setCurrent] = useState('')
  const [editing, setEditing] = useState(false)
  const [msg, setMsg] = useState('')

  const api = (window as any).luminaAPI

  const load = async () => {
    const [list, cur] = await Promise.all([api.themeList(), api.themeGetCurrent()])
    if (list?.ok) { setThemes(list.themes || []) }
    if (cur?.ok) { setCurrent(cur.theme?.name || '') }
  }

  useEffect(() => { load() }, [])

  const apply = async (name: string) => {
    const res = await api.themeApply(name)
    if (res?.ok) { setCurrent(name); setMsg(`已切换到「${name}」`) }
    else setMsg('切换失败：' + (res?.error || ''))
  }

  const importTheme = async () => {
    const res = await api.themeImport()
    if (res?.ok) { setMsg(`已导入「${res.theme?.name}」`); load() }
    else if (!res?.canceled) { setMsg('导入失败：' + (res?.error || '')) }
  }

  const remove = async (name: string) => {
    if (!confirm(`确定删除主题「${name}」？`)) { return }
    const res = await api.themeDelete(name)
    if (res?.ok) { setMsg(`已删除「${name}」`); load() }
    else setMsg('删除失败：' + (res?.error || ''))
  }

  if (editing) {
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
        <button
          onClick={() => { setEditing(false); load() }}
          style={{ alignSelf: 'flex-start', marginBottom: 8, fontSize: 12, color: 'var(--accent-primary)', background: 'none', border: 'none', cursor: 'pointer' }}
        >← 返回主题列表</button>
        <div style={{ flex: 1, minHeight: 0 }}><ThemeEditorPanel /></div>
      </div>
    )
  }

  return (
    <div style={{ padding: 16, overflowY: 'auto', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>🎨 外观主题</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={importTheme} style={btn('var(--bg-tertiary)', 'var(--text-primary)')}>导入主题</button>
          <button onClick={() => setEditing(true)} style={btn('var(--accent-primary)', '#fff')}>打开主题编辑器</button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
        {themes.map((t) => {
          const active = t.name === current
          return (
            <div
              key={t.name}
              onClick={() => apply(t.name)}
              style={{
                border: active ? '2px solid var(--accent-primary)' : '1px solid var(--border-color)',
                borderRadius: 12, padding: 12, cursor: 'pointer',
                background: 'var(--bg-primary)',
                boxShadow: active ? 'var(--shadow-md)' : 'var(--shadow-sm)',
                transition: 'box-shadow 0.15s',
              }}
            >
              {/* 预览色条 */}
              <div style={{ display: 'flex', height: 40, borderRadius: 8, overflow: 'hidden', marginBottom: 10, border: '1px solid var(--border-color)' }}>
                <div style={{ flex: 1, background: t.vars['--bg-primary'] }} />
                <div style={{ flex: 1, background: t.vars['--bg-secondary'] }} />
                <div style={{ flex: 1, background: t.vars['--accent-primary'] }} />
                <div style={{ flex: 1, background: t.vars['--text-primary'] }} />
              </div>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', display: 'flex', justifyContent: 'space-between' }}>
                <span>{t.name}</span>
                {active && <span style={{ color: 'var(--accent-primary)', fontSize: 11 }}>● 使用中</span>}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4, minHeight: 28 }}>{t.description || '—'}</div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>
                {t.isDark ? '深色' : '浅色'} · {t.builtIn ? '内置' : `作者：${t.author || '用户'}`}
              </div>
              {!t.builtIn && (
                <button
                  onClick={(e) => { e.stopPropagation(); remove(t.name) }}
                  style={{ marginTop: 8, fontSize: 11, color: '#ef4444', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                >删除</button>
              )}
            </div>
          )
        })}
      </div>
      {msg && <div style={{ marginTop: 14, fontSize: 12, color: 'var(--accent-secondary)' }}>{msg}</div>}
    </div>
  )
}

function btn(bg: string, color: string): React.CSSProperties {
  return {
    background: bg, color, border: '1px solid var(--border-color)', borderRadius: 8,
    padding: '6px 12px', fontSize: 12, cursor: 'pointer',
  }
}
