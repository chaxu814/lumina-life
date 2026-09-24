// ============================================================
// panels/ThemeEditorPanel.tsx — 可视化主题编辑器
//
// 左侧：分组变量列表（原生 <input type="color">，无新增依赖）
// 右侧：实时预览（模拟聊天界面 / 按钮 / 卡片）
// 修改即时注入 <html>，全应用实时生效。
// ============================================================

import React, { useEffect, useMemo, useState } from 'react'
import { injectThemeVars } from '../services/themeClient'

type Vars = Record<string, string>

const GROUPS: Array<{ label: string; vars: string[] }> = [
  { label: '背景', vars: ['--bg-primary', '--bg-secondary', '--bg-tertiary', '--bg-hover'] },
  { label: '文字', vars: ['--text-primary', '--text-secondary', '--text-muted'] },
  { label: '强调', vars: ['--accent-primary', '--accent-secondary', '--accent-hover'] },
  { label: '边框', vars: ['--border-color'] },
  { label: '桌宠气泡', vars: ['--bubble-bg', '--bubble-text', '--bubble-border'] },
]

const SHADOW_VARS = ['--shadow-sm', '--shadow-md', '--shadow-lg']

const LABELS: Record<string, string> = {
  '--bg-primary': '主背景',
  '--bg-secondary': '次级背景',
  '--bg-tertiary': '三级背景',
  '--bg-hover': '悬停背景',
  '--text-primary': '主文字',
  '--text-secondary': '次要文字',
  '--text-muted': '弱化文字',
  '--accent-primary': '主强调',
  '--accent-secondary': '次强调',
  '--accent-hover': '强调悬停',
  '--border-color': '边框色',
  '--bubble-bg': '气泡背景',
  '--bubble-text': '气泡文字',
  '--bubble-border': '气泡边框',
  '--shadow-sm': '小阴影',
  '--shadow-md': '中阴影',
  '--shadow-lg': '大阴影',
}

function isHex(v: string): boolean {
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v.trim())
}

export default function ThemeEditorPanel() {
  const [vars, setVars] = useState<Vars>({})
  const [baseVars, setBaseVars] = useState<Vars>({})
  const [themeName, setThemeName] = useState('')
  const [isDark, setIsDark] = useState(false)
  const [builtIn, setBuiltIn] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [msg, setMsg] = useState('')

  const api = (window as any).luminaAPI

  useEffect(() => {
    api.themeGetCurrent().then((res: any) => {
      if (res?.ok) {
        setVars({ ...res.theme.vars })
        setBaseVars({ ...res.resolvedVars })
        setThemeName(res.theme.name)
        setIsDark(!!res.theme.isDark)
        setBuiltIn(!!res.theme.builtIn)
      }
    })
  }, [])

  /** 修改某个变量，立即全应用实时预览 */
  const updateVar = (key: string, value: string) => {
    const next = { ...vars, [key]: value }
    setVars(next)
    // 只注入当前编辑的变量，其余沿用已有样式
    injectThemeVars({ [key]: value }, isDark)
  }

  const applyAll = () => {
    injectThemeVars({ ...baseVars, ...vars }, isDark)
  }

  const handleSaveAsNew = async () => {
    const name = saveName.trim()
    if (!name) { setMsg('请输入新主题名称'); return }
    const res = await api.themeSave({
      name, version: '1.0.0', author: '用户', description: '自定义主题',
      isDark, vars,
    })
    if (res?.ok) { setMsg(`已保存「${name}」`); setThemeName(name); setBuiltIn(false) }
    else setMsg('保存失败：' + (res?.error || ''))
  }

  const handleOverwrite = async () => {
    if (builtIn) { setMsg('内置主题不能覆盖，请用「保存为新主题」'); return }
    const res = await api.themeSave({
      name: themeName, version: '1.0.0', author: '用户', description: '自定义主题',
      isDark, vars,
    })
    if (res?.ok) { setMsg(`已覆盖「${themeName}」`) }
    else setMsg('覆盖失败：' + (res?.error || ''))
  }

  const handleExport = async () => {
    const res = await api.themeExport(themeName)
    if (res?.ok) setMsg('已导出主题文件')
    else if (!res?.canceled) setMsg('导出失败：' + (res?.error || ''))
  }

  const colorRows = useMemo(() => {
    const rows: Array<{ group: string; key: string; value: string }> = []
    for (const g of GROUPS) {
      for (const k of g.vars) rows.push({ group: g.label, key: k, value: vars[k] || '' })
    }
    return rows
  }, [vars])

  return (
    <div style={{ display: 'flex', gap: 16, height: '100%', padding: 16, overflow: 'hidden' }}>
      {/* ═══ 左：变量列表 ═══ */}
      <div style={{ width: 300, flexShrink: 0, overflowY: 'auto', paddingRight: 8 }}>
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 12, color: 'var(--text-primary)' }}>
          🎨 主题编辑器 — {themeName}
        </div>

        {colorRows.map(({ group, key, value }) => (
          <div key={key} style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>{group}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 80, fontSize: 12, color: 'var(--text-secondary)' }}>{LABELS[key] || key}</span>
              {isHex(value) ? (
                <input
                  type="color"
                  value={value}
                  onChange={(e) => updateVar(key, e.target.value)}
                  style={{ width: 36, height: 24, border: '1px solid var(--border-color)', borderRadius: 6, padding: 0, cursor: 'pointer', background: 'none' }}
                />
              ) : (
                <input
                  type="text"
                  value={value}
                  onChange={(e) => updateVar(key, e.target.value)}
                  style={{ flex: 1, fontSize: 11, padding: '3px 6px', border: '1px solid var(--border-color)', borderRadius: 6, background: 'var(--bg-primary)', color: 'var(--text-primary)' }}
                />
              )}
              <span style={{ flex: 1, fontSize: 10, color: 'var(--text-muted)', fontFamily: 'monospace' }}>{value}</span>
            </div>
          </div>
        ))}

        {/* 阴影（文本，无法用色盘） */}
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>阴影（CSS box-shadow，文本编辑）</div>
          {SHADOW_VARS.map((k) => (
            <div key={k} style={{ marginBottom: 6 }}>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 2 }}>{LABELS[k] || k}</div>
              <input
                type="text"
                value={vars[k] || ''}
                onChange={(e) => updateVar(k, e.target.value)}
                style={{ width: '100%', fontSize: 10, padding: '3px 6px', border: '1px solid var(--border-color)', borderRadius: 6, background: 'var(--bg-primary)', color: 'var(--text-primary)' }}
              />
            </div>
          ))}
        </div>
      </div>

      {/* ═══ 右：实时预览 ═══ */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10, color: 'var(--text-primary)' }}>实时预览</div>
        <div style={{
          background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
          borderRadius: 12, padding: 16, boxShadow: 'var(--shadow-md)',
        }}>
          {/* 模拟聊天界面 */}
          <div style={{ background: 'var(--bg-primary)', borderRadius: 10, padding: 12, border: '1px solid var(--border-color)' }}>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>Lumina</div>
            <div style={{
              background: 'var(--bubble-bg)', color: 'var(--bubble-text)',
              border: '1px solid var(--bubble-border)', borderRadius: 12,
              padding: '8px 12px', fontSize: 12, maxWidth: 240, display: 'inline-block',
            }}>
              你好呀，今天过得怎么样？
            </div>
          </div>
          {/* 按钮行 */}
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button style={{
              background: 'var(--accent-primary)', color: '#fff', border: 'none',
              borderRadius: 8, padding: '6px 14px', fontSize: 12, cursor: 'pointer',
            }}>主要按钮</button>
            <button style={{
              background: 'var(--bg-tertiary)', color: 'var(--text-primary)',
              border: '1px solid var(--border-color)', borderRadius: 8, padding: '6px 14px',
              fontSize: 12, cursor: 'pointer',
            }}>次要按钮</button>
          </div>
          {/* 卡片 */}
          <div style={{
            marginTop: 12, background: 'var(--bg-primary)', border: '1px solid var(--border-color)',
            borderRadius: 10, padding: 12, boxShadow: 'var(--shadow-sm)',
          }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>卡片标题</div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>这是一段次要说明文字，用来测试文字对比度。</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>弱化的辅助信息。</div>
          </div>
        </div>

        {/* ═══ 操作 ═══ */}
        <div style={{ marginTop: 16, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <input
            type="text"
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            placeholder="新主题名称"
            style={{ padding: '6px 10px', border: '1px solid var(--border-color)', borderRadius: 8, background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 12, width: 140 }}
          />
          <button onClick={handleSaveAsNew} style={btn('var(--accent-primary)', '#fff')}>保存为新主题</button>
          <button onClick={handleOverwrite} style={btn('var(--bg-tertiary)', 'var(--text-primary)')}>覆盖当前主题</button>
          <button onClick={handleExport} style={btn('var(--bg-tertiary)', 'var(--text-primary)')}>导出</button>
          <button onClick={applyAll} style={btn('var(--bg-tertiary)', 'var(--text-primary)')}>重新应用</button>
        </div>
        {msg && <div style={{ marginTop: 10, fontSize: 12, color: 'var(--accent-secondary)' }}>{msg}</div>}
        <div style={{ marginTop: 12, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>
          说明：色盘使用浏览器原生 <code>&lt;input type="color"&gt;</code>，只支持 hex；rgba 等值请用文本框编辑。
          部分边缘组件颜色尚未迁移到主题变量，后续可逐步替换。
        </div>
      </div>
    </div>
  )
}

function btn(bg: string, color: string): React.CSSProperties {
  return {
    background: bg, color, border: '1px solid var(--border-color)', borderRadius: 8,
    padding: '6px 12px', fontSize: 12, cursor: 'pointer',
  }
}
