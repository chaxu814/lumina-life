// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../stores/appStore'
import { switchAndPersist } from '../services/llmPersist'

// 快速切换用的供应商列表
const QUICK_PROVIDERS = [
  { id: 'lmstudio', label: '🧠 LM Studio', nameCn: 'LM Studio (本地)', url: 'http://127.0.0.1:1234/v1', model: '' },
  { id: 'openai', label: '☁️ OpenAI', nameCn: 'OpenAI', url: 'https://api.openai.com/v1', model: 'gpt-4o' },
  { id: 'deepseek', label: '☁️ DeepSeek', nameCn: 'DeepSeek', url: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'qwen', label: '☁️ 通义千问', nameCn: '通义千问', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { id: 'custom', label: '⚙️ 自定义', nameCn: '自定义', url: '', model: '' },
]

function findProviderLabel(provider: string): string {
  for (const p of QUICK_PROVIDERS) {
    if (p.id === provider || provider === p.nameCn || provider.includes(p.id)) {return p.label}
  }
  return provider || 'LLM'
}

// 提取纯文字标签（去掉 emoji 前缀）
function plainLabel(label: string): string {
  return label.replace(/^[\p{Emoji}\u200d\ufe0f]+\s*/u, '').trim()
}

export default function ModelSelector() {
  const llmConfig = useStore((s) => s.llmConfig)
  const switchLLMProvider = useStore((s) => s.switchLLMProvider)
  const setLLMConfig = useStore((s) => s.setLLMConfig)

  const [showProviderMenu, setShowProviderMenu] = useState(false)
  const providerMenuRef = useRef<HTMLDivElement>(null)
  const portalMenuRef = useRef<HTMLDivElement>(null)
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null)
  const [providerModels, setProviderModels] = useState<Record<string, Array<{ id: string }>>>({})
  const [providerLoading, setProviderLoading] = useState<Record<string, boolean>>({})

  // 点击外部关闭下拉（同时判断选择器本体与 portal 菜单）
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      const inside =
        (providerMenuRef.current && providerMenuRef.current.contains(target)) ||
        (portalMenuRef.current && portalMenuRef.current.contains(target))
      if (!inside) {
        setShowProviderMenu(false)
        setExpandedProvider(null)
      }
    }
    if (showProviderMenu) {document.addEventListener('mousedown', handler)}
    return () => document.removeEventListener('mousedown', handler)
  }, [showProviderMenu])

  // 获取供应商模型列表
  const fetchModelsForProvider = async (providerId: string) => {
    if (providerModels[providerId]?.length) {return}
    const pInfo = QUICK_PROVIDERS.find(p => p.id === providerId)
    if (!pInfo) {return}

    const store = useStore.getState()
    const savedCfg = store.providerConfigs?.[pInfo.nameCn || pInfo.label]
    const currentBase = store.llmConfig.baseUrl
    const isLmStudioMatch = providerId === 'lmstudio' && currentBase && (currentBase.includes(':1234') || currentBase.includes('/v1'))
    const isCurrentMatch = isLmStudioMatch
    const baseUrl = savedCfg?.baseUrl || (isCurrentMatch ? currentBase : (providerId === 'custom' ? currentBase : pInfo.url))
    const apiKey = savedCfg?.apiKey || store.llmConfig.apiKey || ''

    setProviderLoading(prev => ({ ...prev, [providerId]: true }))
    try {
      const r = await window.luminaAPI.llmFetchModels({ baseUrl, apiKey })
      if (!r.error && r.models) {
        setProviderModels(prev => ({ ...prev, [providerId]: r.models }))
      }
    } catch {}
    setProviderLoading(prev => ({ ...prev, [providerId]: false }))
  }

  // 当前供应商的显示名
  const providerName = plainLabel(findProviderLabel(llmConfig.provider))
  const modelName = llmConfig.model || '—'

  // 记录选择器在视口中的位置（用于 portal 定位下拉菜单）
  const [anchorRect, setAnchorRect] = useState<{ left: number; bottom: number; width: number } | null>(null)

  const toggleMenu = (e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setAnchorRect({ left: rect.left, bottom: rect.bottom, width: rect.width })
    setShowProviderMenu(v => !v)
    if (!showProviderMenu) {setExpandedProvider(null)}
  }

  return (
    <div ref={providerMenuRef}
      style={{
        display: 'flex', alignItems: 'center', gap: 3,
        padding: '2px 6px', borderRadius: 4, cursor: 'pointer',
        fontSize: 11, color: 'var(--text-tertiary, #9ca3af)',
        position: 'relative', userSelect: 'none',
        background: showProviderMenu ? 'rgba(128,128,128,0.1)' : 'transparent',
        transition: 'background 0.15s',
        whiteSpace: 'nowrap',
        flexShrink: 1,
        minWidth: 0,
        maxWidth: 160,
        overflow: 'hidden',
      }}
      onClick={toggleMenu}>
      {/* 供应商小圆点 */}
      <span style={{
        width: 5, height: 5, borderRadius: '50%', flexShrink: 0,
        background: '#22c55e',
      }} />
      <span style={{
        fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis',
        whiteSpace: 'nowrap', minWidth: 0,
      }}>{modelName}</span>
      <span style={{
        fontSize: 8, opacity: 0.4, flexShrink: 0,
        transition: 'transform 0.2s',
        transform: showProviderMenu ? 'rotate(180deg)' : 'none',
      }}>▾</span>

      {/* ───── 下拉菜单（portal 到 body，向上弹出，不受父容器裁剪） ───── */}
      {showProviderMenu && anchorRect && createPortal(
        <div ref={portalMenuRef} onClick={e => e.stopPropagation()}
          style={{
          position: 'fixed', zIndex: 99999,
          left: anchorRect.left,
          bottom: window.innerHeight - anchorRect.bottom + 8,
          background: 'var(--surface-0)', border: '1px solid var(--border-light)', borderRadius: 10,
          boxShadow: '0 8px 32px rgba(0,0,0,0.18)', minWidth: 220, maxWidth: 280,
          padding: 4, maxHeight: 380, overflowY: 'auto',
          animation: 'fadeInUp 0.15s ease-out',
        }}>
          {/* 其他 */}
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)', letterSpacing: '0.5px', padding: '4px 10px 2px' }}>
            其他
          </div>
          {QUICK_PROVIDERS.map(p => {
            const active = p.id === llmConfig.provider || llmConfig.provider === p.nameCn
            const isExpanded = expandedProvider === p.id
            const models = providerModels[p.id]
            const loading = providerLoading[p.id]
            return (
              <div key={p.id}>
                <div onClick={() => { setExpandedProvider(isExpanded ? null : p.id); if (!isExpanded) {fetchModelsForProvider(p.id)} }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '6px 10px', borderRadius: 6, cursor: 'pointer',
                    background: active ? '#eff6ff' : 'transparent',
                    color: active ? '#2563eb' : '#374151',
                    fontWeight: active ? 600 : 400, fontSize: 12,
                    transition: 'background 0.1s',
                  }}
                  onMouseEnter={e => { if (!active) {e.currentTarget.style.background = '#f9fafb'} }}
                  onMouseLeave={e => { if (!active) {e.currentTarget.style.background = 'transparent'} }}>
                  <span style={{ flex: 1 }}>{plainLabel(p.label)}</span>
                  {active && <span style={{ fontSize: 8, color: '#3b82f6' }}>●</span>}
                  <span style={{ fontSize: 8, opacity: 0.3, transition: 'transform 0.2s', transform: isExpanded ? 'rotate(90deg)' : 'none' }}>▶</span>
                </div>
                {isExpanded && (
                  <div style={{ paddingLeft: 20, paddingBottom: 4 }}>
                    {loading ? (
                      <div style={{ padding: '6px 8px', fontSize: 10, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', border: '2px solid #e5e7eb', borderTopColor: '#3b82f6', animation: 'spin 0.7s linear infinite' }} />
                        加载中…
                      </div>
                    ) : models && models.length > 0 ? (
                      models.map(m => (
                        <div key={m.id} onClick={() => {
                          const store = useStore.getState()
                          const actualUrl = (p.id === 'custom' ? store.llmConfig.baseUrl : p.url)
                          const syncedUrl = (p.id === 'lmstudio' && store.llmConfig.baseUrl?.includes(':1234'))
                            ? store.llmConfig.baseUrl : actualUrl
          // 🔧 修复：同上，必须落盘
          void switchAndPersist(store, p.id || p.nameCn || p.label, syncedUrl || '', m.id)
                          setShowProviderMenu(false)
                          setExpandedProvider(null)
                        }}
                          style={{
                            padding: '4px 8px', borderRadius: 4, cursor: 'pointer',
                            fontSize: 11, color: 'var(--text-secondary)',
                            background: active && llmConfig.model === m.id ? '#f0f7ff' : 'transparent',
                            fontWeight: active && llmConfig.model === m.id ? 600 : 400,
                            display: 'flex', alignItems: 'center', gap: 4,
                          }}
                          onMouseEnter={e => { e.currentTarget.style.background = '#f3f4f6' }}
                          onMouseLeave={e => { e.currentTarget.style.background = active && llmConfig.model === m.id ? '#f0f7ff' : 'transparent' }}>
                          {active && llmConfig.model === m.id && <span style={{ color: '#3b82f6', fontSize: 7 }}>●</span>}
                          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.id}</span>
                        </div>
                      ))
                    ) : (
                      <div style={{ padding: '6px 8px', fontSize: 10, color: 'var(--text-secondary)', fontStyle: 'italic' }}>
                        {p.id === 'custom' ? '输入自定义模型名' : '暂无模型'}
                        <span style={{ marginLeft: 4, cursor: 'pointer', color: '#3b82f6' }}
                          onClick={e => { e.stopPropagation(); fetchModelsForProvider(p.id) }}>
                          重试
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>,
        document.body
      )}
    </div>
  )
}
