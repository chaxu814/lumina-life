// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// PluginPanelContainer.tsx — 面板插件查看器 (v8.1)
//
// 显示插件/技能注册的自定义面板
//   支持 iframe 加载和消息型面板
// ============================================================

import React, { useState, useEffect } from 'react'

interface PanelDef {
  id: string
  name: string
  icon: string
  description: string
  source: 'plugin' | 'skill' | 'user'
  renderType: 'iframe' | 'content' | 'component'
  content: string
  placement: string[]
  preferredSize: string
  tags: string[]
  enabled: boolean
}

export default function PluginPanelContainer() {
  const api = (window as any).luminaAPI

  const [panels, setPanels] = useState<PanelDef[]>([])
  const [activePanel, setActivePanel] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadPanels()
  }, [])

  const loadPanels = async () => {
    setLoading(true)
    try {
      const result = await api?.panelList?.('sidebar')
      if (result?.ok) {
        setPanels(result.panels || [])
        if (result.panels?.length > 0 && !activePanel) {
          setActivePanel(result.panels[0].id)
        }
      }
    } catch (e) {
      console.error('加载面板失败:', e)
    } finally {
      setLoading(false)
    }
  }

  const activePanelData = panels.find(p => p.id === activePanel)

  // 渲染面板内容
  const renderContent = () => {
    if (!activePanelData) {
      return (
        <div style={{
          textAlign: 'center', padding: 40, fontSize: 13,
          color: 'var(--text-tertiary)',
        }}>
          {loading ? '加载面板中...' : '选择一个面板查看'}
        </div>
      )
    }

    if (activePanelData.renderType === 'content') {
      return (
        <div
          style={{ padding: 16, fontSize: 12, lineHeight: 1.6 }}
          dangerouslySetInnerHTML={{ __html: activePanelData.content }}
        />
      )
    }

    if (activePanelData.renderType === 'iframe') {
      return (
        <iframe
          src={activePanelData.content}
          style={{
            width: '100%', flex: 1, border: 'none', borderRadius: 8,
          }}
          title={activePanelData.name}
          sandbox="allow-scripts allow-same-origin"
        />
      )
    }

    return (
      <div style={{ padding: 16, fontSize: 12, color: 'var(--text-tertiary)' }}>
        ⚠️ 面板类型「{activePanelData.renderType}」暂不支持
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', height: '100%', background: 'var(--surface-bg)' }}>
      {/* 侧栏 — 面板列表 */}
      <div style={{
        width: 200, borderRight: '1px solid var(--border-light)',
        padding: '12px 0', overflowY: 'auto', flexShrink: 0,
      }}>
        <div style={{ padding: '0 12px 8px', fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>
          📦 插件面板
        </div>
        {loading ? (
          <div style={{ padding: '0 12px', fontSize: 11, color: 'var(--text-tertiary)' }}>加载中...</div>
        ) : panels.length === 0 ? (
          <div style={{ padding: '0 12px', fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
            暂无插件面板
            <br />技能/插件注册后自动出现
          </div>
        ) : (
          panels.map(p => (
            <button key={p.id} onClick={() => setActivePanel(p.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                width: '100%', padding: '8px 12px',
                border: 'none', borderLeft: activePanel === p.id ? '3px solid #4A90D9' : '3px solid transparent',
                background: activePanel === p.id ? 'var(--surface-100)' : 'transparent',
                cursor: 'pointer', fontSize: 12, textAlign: 'left',
                color: 'var(--text-primary)',
                transition: 'all 0.15s',
              }}>
              <span style={{ fontSize: 16 }}>{p.icon}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: activePanel === p.id ? 600 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {p.name}
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>
                  {p.source === 'plugin' ? '插件' : p.source === 'skill' ? '技能' : '用户'}
                </div>
              </div>
            </button>
          ))
        )}

        {/* 面板管理入口 */}
        <div style={{ padding: '8px 12px', marginTop: 8 }}>
          <button onClick={() => window.open('#/settings/panels', '_self')}
            style={{
              width: '100%', padding: '6px', borderRadius: 6,
              border: '1px solid var(--border-light)',
              background: 'var(--surface-100)', fontSize: 11, cursor: 'pointer',
              color: 'var(--text-secondary)',
            }}>
            ⚙️ 管理面板
          </button>
        </div>
      </div>

      {/* 主内容区域 — 面板内容 */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {activePanelData && (
          <div style={{
            padding: '10px 16px', borderBottom: '1px solid var(--border-light)',
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <span style={{ fontSize: 20 }}>{activePanelData.icon}</span>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{activePanelData.name}</div>
              <div style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>{activePanelData.description}</div>
            </div>
          </div>
        )}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
          {renderContent()}
        </div>
      </div>
    </div>
  )
}
