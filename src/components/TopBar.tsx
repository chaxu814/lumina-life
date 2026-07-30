import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '../stores/appStore'
import { getPersona } from '../data/personas'
import { IconSmile, IconWifi, IconWifiOff } from './Icons'
import ModeIndicator from './ModeIndicator'  // 🆕 v2.0: 场景模式指示器

// 快速切换用的供应商列表
const QUICK_PROVIDERS = [
  // 🆕 免费 API（无需 API Key，开箱即用）
  { id: 'opencode-zen', label: '🎯 OpenCode Zen', nameCn: 'OpenCode Zen (免费)', url: 'https://opencode.ai/zen/v1', model: 'deepseek-v4-flash-free' },
  { id: 'lmstudio', label: '🧠 LM Studio', nameCn: 'LM Studio (本地)', url: 'http://127.0.0.1:1234/v1', model: '' },
  { id: 'openai', label: '☁️ OpenAI', nameCn: 'OpenAI', url: 'https://api.openai.com/v1', model: 'gpt-4o' },
  { id: 'deepseek', label: '☁️ DeepSeek', nameCn: 'DeepSeek', url: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'qwen', label: '☁️ 通义千问', nameCn: '通义千问', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { id: 'custom', label: '⚙️ 自定义', nameCn: '自定义', url: '', model: '' },
]

function findProviderLabel(provider: string): string {
  for (const p of QUICK_PROVIDERS) {
    if (p.id === provider || provider === p.nameCn || provider.includes(p.id)) return p.label
  }
  return provider || 'LLM'
}

export default function TopBar() {
  const { t, i18n } = useTranslation()
  const conversations = useStore((s) => s.conversations)
  const activeConversationId = useStore((s) => s.activeConversationId)
  const activePanel = useStore((s) => s.activePanel)
  const isProcessing = useStore((s) => s.isProcessing)
  const tokenUsage = useStore((s) => s.tokenUsage)
  const llmOnline = useStore((s) => s.llmOnline)
  const llmChecked = useStore((s) => s.llmChecked)
  const setLlmOnline = useStore((s) => s.setLlmOnline)
  const setLlmChecked = useStore((s) => s.setLlmChecked)
  const llmConfig = useStore((s) => s.llmConfig)
  const switchLLMProvider = useStore((s) => s.switchLLMProvider)
  const setLLMConfig = useStore((s) => s.setLLMConfig)
  const activePersona = useStore((s) => s.activePersona)
  const agentConfig = useStore((s) => s.agentConfig)
  // 游戏化状态
  const gamification = useStore((s) => s.gamification)
  const setProfileTab = useStore((s) => s.setProfileTab)

  // 🔥 LLM 快速切换下拉
  const [showProviderMenu, setShowProviderMenu] = useState(false)
  const providerMenuRef = useRef<HTMLDivElement>(null)
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null)
  const [providerModels, setProviderModels] = useState<Record<string, Array<{ id: string }>>>({})
  const [providerLoading, setProviderLoading] = useState<Record<string, boolean>>({})

  // 🔥 生成完毕动画
  const [showDone, setShowDone] = useState(false)
  const prevProcessing = useRef(isProcessing)
  useEffect(() => {
    if (prevProcessing.current && !isProcessing && activePanel !== 'chat') {
      setShowDone(true)
      const t = setTimeout(() => setShowDone(false), 2500)
      return () => clearTimeout(t)
    }
    prevProcessing.current = isProcessing
  }, [isProcessing, activePanel])

  // 点击外部关闭下拉
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (providerMenuRef.current && !providerMenuRef.current.contains(e.target as Node)) {
        setShowProviderMenu(false)
        setExpandedProvider(null)
      }
    }
    if (showProviderMenu) document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showProviderMenu])

  // 🔥 实时消息数
  const activeConv = conversations.find((c) => c.id === activeConversationId)
  const msgCount = activeConv?.messages.filter((m) => m.role !== 'system').length || 0

  // ?? 启动时不自检了，syncProviderFromBackend 会负责检测并设在线状态
  // 用户可手动点击 LLM 状态指示器触发 checkLLMHealth

  const checkLLMHealth = async () => {
    setLlmChecked(false)
    const { baseUrl, apiKey, model } = useStore.getState().llmConfig
    const agentLumina = useStore.getState().agentConfig
    const effectiveBaseUrl = baseUrl || ''  // AgentConfig has no endpoint field
    const effectiveApiKey = apiKey || ''
    if (!effectiveBaseUrl) { setLlmChecked(true); setLlmOnline(false); return }

    const cleanBase = effectiveBaseUrl.replace(/\/+$/, '')
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (effectiveApiKey) headers['Authorization'] = `Bearer ${effectiveApiKey}`

    // 1) 先试轻量 GET（快，4s）
    const getEndpoints = [...new Set([
      cleanBase.endsWith('/v1') ? `${cleanBase}/models` : `${cleanBase}/v1/models`,
      `${cleanBase}/models`,
      `${cleanBase}/v1/models`,
    ])]
    let online = false
    for (const url of getEndpoints) {
      try {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(4000),
          headers: effectiveApiKey ? { 'Authorization': `Bearer ${effectiveApiKey}` } : {},
        })
        if (res.ok) { online = true; break }
      } catch { /* try next */ }
    }

    // 2) GET 全失败 → 试 POST chat completion（更可靠）
    if (!online) {
      try {
        const res = await fetch(cleanBase + '/chat/completions', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: model || 'test',
            messages: [{ role: 'user', content: 'Hi' }],
            max_tokens: 5,
          }),
          signal: AbortSignal.timeout(8000),
        })
        if (res.ok) online = true
        // LM Studio 没加载模型时返回 400，但服务在线
        else if (res.status === 400) online = true
      } catch { /* offline */ }
    }

    setLlmOnline(online)
    setLlmChecked(true)
  }

  // 🔥 获取供应商模型列表（缓存 + 加载状态）
  const fetchModelsForProvider = async (providerId: string) => {
    if (providerModels[providerId]?.length) return
    const pInfo = QUICK_PROVIDERS.find(p => p.id === providerId)
    if (!pInfo) return

    const store = useStore.getState()
    // 优先使用用户已保存的配置中的 baseUrl，否则用默认 URL
    const savedCfg = store.providerConfigs?.[pInfo.nameCn || pInfo.label]
    // 如果用户当前的 llmConfig.baseUrl 与当前 provider 匹配（如 LM Studio 的 :1234 端口），
    // 则使用用户实际配的 URL 而非硬编码的默认 URL，实现数据同步
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

  // 🔥 当前人格
  const persona = getPersona(activePersona, agentConfig.customPersonas)
  const personaLabel = persona ? `${persona.icon} ${persona.name}` : '🐱 Lumina'

  const handleMinimize = () => window.luminaAPI?.windowMinimize()
  const handleMaximize = () => window.luminaAPI?.windowMaximize()
  const handleClose = () => window.luminaAPI?.windowClose()

  const formatTokens = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n)

  return (
    <header className="topbar">
      <div className="topbar-left">
        <span className="topbar-logo"><span>✦</span> Lumina Life</span>
        <span className="topbar-version">1.0</span>
        {/* 语言切换 */}
        <button onClick={() => {
          const next = i18n.language?.startsWith('zh') ? 'en-US' : 'zh-CN'
          i18n.changeLanguage(next)
        }} title={i18n.language?.startsWith('zh') ? 'Switch to English' : '切换到中文'}
          style={{
            background: 'none', border: '1px solid var(--border-light)', borderRadius: 4,
            cursor: 'pointer', fontSize: 10, fontWeight: 600, padding: '1px 6px',
            color: 'var(--text-secondary)', marginLeft: 6,
          }}>
          {i18n.language?.startsWith('zh') ? 'EN' : '中'}
        </button>
      </div>

      <div className="topbar-center">
        {/* LLM 在线状态 — 手动点击检测 */}
        <div className="topbar-stat" style={{
          background: llmChecked ? (llmOnline ? 'var(--green-100)' : 'var(--red-100)') : 'var(--surface-100)',
          color: llmChecked ? (llmOnline ? '#006644' : 'var(--red-500)') : 'var(--text-tertiary)',
          cursor: 'pointer',
        }} onClick={checkLLMHealth} title={t('topbar.health_title')}>
          {llmChecked && llmOnline ? <IconWifi size={12} /> : <IconWifiOff size={12} />}
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>
            {llmChecked ? (llmOnline ? t('topbar.online') : t('topbar.offline')) : t('topbar.checking')}
          </span>
        </div>

        {/* 🆕 v2.0: 场景模式指示器 */}
        <ModeIndicator />

        {/* 🆕 v2.0: 🛡️ 沙箱状态指示器 */}
        <div
          onClick={() => window.luminaAPI?.navigatePanel?.('security')}
          style={{
            display: 'flex', alignItems: 'center', gap: 4,
            padding: '2px 8px', borderRadius: 12,
            background: 'var(--green-100)',
            color: '#166534',
            fontSize: 11, fontWeight: 600,
            cursor: 'pointer', userSelect: 'none',
            border: '1px solid #86efac',
            transition: 'all 0.2s ease',
          }}
          title="沙箱防护已开启 — 点击查看安全中心"
          onMouseEnter={e => { e.currentTarget.style.background = '#dcfce7' }}
          onMouseLeave={e => { e.currentTarget.style.background = 'var(--green-100)' }}
        >
          <span style={{ fontSize: 12, lineHeight: 1 }}>🛡️</span>
          <span>沙箱</span>
        </div>

        {/* 当前人格 */}
        <div className="topbar-stat" style={{ background: 'var(--accent-50)', color: 'var(--accent-600)' }}>
          <span style={{ fontSize: 12 }}>{personaLabel}</span>
        </div>

        {/* Token 用量 */}
        <div className="topbar-stat" style={{ cursor: 'pointer' }}
          onClick={() => window.luminaAPI?.navigatePanel?.('usage')} title={t('topbar.usage_title')}>
          <span style={{ fontSize: 11 }}>📊</span>
          <span>{formatTokens(tokenUsage.today)} {t('topbar.tokens')}</span>
        </div>

        {/* 消息数 */}
        <div className="topbar-stat">
          <IconSmile size={14} />
          <span>{msgCount} {t('topbar.messages')}</span>
        </div>
      </div>

      <div className="topbar-right">
        {/* 🆕 v3.0: 等级 + 成就徽章 */}
        <div
          onClick={() => {
            setProfileTab('achievements')
            window.luminaAPI?.navigatePanel?.('profile')
          }}
          style={{
            display: 'flex', alignItems: 'center', gap: 4,
            padding: '2px 8px', borderRadius: 12,
            background: 'linear-gradient(135deg, #fbbf24, #f59e0b)',
            color: '#fff', fontSize: 11, fontWeight: 600,
            cursor: 'pointer', marginRight: 4, userSelect: 'none',
            boxShadow: '0 1px 3px rgba(245,158,11,0.3)',
            transition: 'transform 0.15s, box-shadow 0.15s',
          }}
          title={`Lv.${gamification.level} ${gamification.title} · ${gamification.unlockedAchievements.length} 成就`}
          onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.05)'; e.currentTarget.style.boxShadow = '0 2px 8px rgba(245,158,11,0.4)' }}
          onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; e.currentTarget.style.boxShadow = '0 1px 3px rgba(245,158,11,0.3)' }}
        >
          <span>⭐ Lv.{gamification.level}</span>
          {gamification.unlockedAchievements.length > 0 && (
            <span style={{ fontSize: 9, opacity: 0.9 }}>🏆{gamification.unlockedAchievements.length}</span>
          )}
        </div>

        {/* ════════════════════════════════════════════════
             快速 LLM 切换（右上角，QwenPaw 风格）
             点击按钮 → 弹出供应商列表（带动画）
             点击供应商行 → 展开该供应商的模型列表
             点击模型 → 立即切换（setLLMConfig）
             ════════════════════════════════════════════════ */}
        <div ref={providerMenuRef}
          style={{
            display: 'flex', alignItems: 'center', gap: 4,
            padding: '3px 8px', borderRadius: 5, cursor: 'pointer',
            fontSize: 11, color: 'var(--text-primary)', marginRight: 4,
            position: 'relative', userSelect: 'none',
            background: showProviderMenu ? '#f3f4f6' : 'transparent',
            transition: 'background 0.15s',
          }}
          onClick={() => {
            setShowProviderMenu(v => !v)
            if (!showProviderMenu) setExpandedProvider(null)
          }}>
          <span>{findProviderLabel(llmConfig.provider)}</span>
          <span style={{ fontSize: 11, marginLeft: 2, opacity: 0.4 }}>·</span>
          <span style={{ maxWidth: 90, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.6 }}>
            {llmConfig.model || '—'}
          </span>
          <span style={{
            fontSize: 8, opacity: 0.5, marginLeft: 2,
            transition: 'transform 0.2s',
            transform: showProviderMenu ? 'rotate(180deg)' : 'none',
          }}>▾</span>

          {/* ───── 下拉菜单 ───── */}
          {showProviderMenu && (
            <div onClick={e => e.stopPropagation()}
              style={{
              position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 1000,
              background: 'var(--surface-0)', border: '1px solid var(--border-light)', borderRadius: 8,
              boxShadow: '0 8px 24px rgba(0,0,0,0.14)', minWidth: 240, maxWidth: 300,
              padding: 4, maxHeight: 400, overflowY: 'auto',
              animation: 'fadeInDown 0.18s ease-out',
            }}>
              {/* ──── 🎯 免费模型（单独区域，不与付费混在一起） ──── */}
              <div style={{
                fontSize: 10, fontWeight: 700, color: '#22c55e', textTransform: 'uppercase',
                letterSpacing: '1px', padding: '6px 10px 2px',
              }}>
                🎯 免费（开箱即用）
              </div>
              {QUICK_PROVIDERS.filter(p => p.id === 'opencode-zen').map(p => {
                const active = p.id === llmConfig.provider || llmConfig.provider === p.nameCn
                const isExpanded = expandedProvider === p.id

                // 免费模型列表硬编码，不调 API，确保只出现免费模型
                const FREE_MODELS: Record<string, Array<{ id: string; label: string }>> = {
                  'opencode-zen': [
                    { id: 'deepseek-v4-flash-free', label: 'DeepSeek V4 Flash Free' },
                  ],
                }
                const models = FREE_MODELS[p.id] || []

                return (
                  <div key={p.id}>
                    <div
                      onClick={() => {
                        const next = isExpanded ? null : p.id
                        setExpandedProvider(next)
                      }}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 6,
                        padding: '8px 10px', borderRadius: 5, cursor: 'pointer',
                        background: active ? '#f0fdf4' : 'transparent',
                        color: active ? '#16a34a' : '#374151',
                        fontWeight: active ? 600 : 400,
                        fontSize: 12,
                        transition: 'background 0.12s',
                      }}
                      onMouseEnter={e => { if (!active) e.currentTarget.style.background = '#f9fafb' }}
                      onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent' }}>
                      <span style={{ flex: 1 }}>{p.label}</span>
                      <span style={{
                        fontSize: 8, fontWeight: 700, background: '#22c55e', color: '#fff',
                        borderRadius: 4, padding: '0 5px', lineHeight: '16px', marginRight: 4,
                      }}>免费</span>
                      {active && <span style={{ fontSize: 9, color: '#16a34a' }}>●</span>}
                      <span style={{
                        fontSize: 8, opacity: 0.35,
                        transition: 'transform 0.2s',
                        transform: isExpanded ? 'rotate(90deg)' : 'none',
                      }}>▶</span>
                    </div>
                    {isExpanded && (
                      <div style={{ paddingLeft: 24, paddingBottom: 4, animation: 'fadeIn 0.12s ease-out' }}>
                        {models.map(m => (
                          <div key={m.id} onClick={() => {
                            const store = useStore.getState()
                            switchLLMProvider(p.nameCn || p.label, p.url, m.id)
                            store.setLLMConfig({ model: m.id })
                            // 免费 API 自动填入匿名 Key
                            if (p.id === 'opencode-zen') {
                              store.setLLMConfig({ apiKey: 'public' })
                            }
                            setShowProviderMenu(false)
                            setExpandedProvider(null)
                          }}
                            style={{
                              padding: '5px 8px', borderRadius: 4, cursor: 'pointer',
                              fontSize: 10, color: 'var(--text-secondary)',
                              background: active && llmConfig.model === m.id ? '#f0fdf4' : 'transparent',
                              fontWeight: active && llmConfig.model === m.id ? 600 : 400,
                              display: 'flex', alignItems: 'center', gap: 4,
                              transition: 'background 0.1s',
                            }}
                            onMouseEnter={e => { e.currentTarget.style.background = '#f3f4f6' }}
                            onMouseLeave={e => { e.currentTarget.style.background = active && llmConfig.model === m.id ? '#f0fdf4' : 'transparent' }}>
                            {active && llmConfig.model === m.id && <span style={{ color: '#16a34a', fontSize: 8 }}>●</span>}
                            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.label}</span>
                            <span style={{
                              fontSize: 8, fontWeight: 700, background: '#22c55e', color: '#fff',
                              borderRadius: 3, padding: '0 4px', lineHeight: '14px',
                            }}>免费</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}

              {/* ──── 分隔线 ──── */}
              <div style={{ borderTop: '1px solid var(--border-light)', margin: '4px 8px' }} />

              {/* ──── 其他模型 ──── */}
              <div style={{
                fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase',
                letterSpacing: '1px', padding: '4px 10px 2px',
              }}>
                其他
              </div>
              {QUICK_PROVIDERS.filter(p => p.id !== 'opencode-zen').map(p => {
                const active = p.id === llmConfig.provider || llmConfig.provider === p.nameCn
                const isExpanded = expandedProvider === p.id
                const models = providerModels[p.id]
                const loading = providerLoading[p.id]

                return (
                  <div key={p.id}>
                    <div
                      onClick={() => {
                        const next = isExpanded ? null : p.id
                        setExpandedProvider(next)
                        if (next) fetchModelsForProvider(p.id)
                      }}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 6,
                        padding: '8px 10px', borderRadius: 5, cursor: 'pointer',
                        background: active ? '#eff6ff' : 'transparent',
                        color: active ? '#2563eb' : '#374151',
                        fontWeight: active ? 600 : 400,
                        fontSize: 12,
                        transition: 'background 0.12s',
                      }}
                      onMouseEnter={e => { if (!active) e.currentTarget.style.background = '#f9fafb' }}
                      onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent' }}>
                      <span style={{ flex: 1 }}>{p.label}</span>
                      {active && <span style={{ fontSize: 9, color: '#3b82f6' }}>●</span>}
                      <span style={{
                        fontSize: 8, opacity: 0.35,
                        transition: 'transform 0.2s',
                        transform: isExpanded ? 'rotate(90deg)' : 'none',
                      }}>▶</span>
                    </div>
                    {isExpanded && (
                      <div style={{ paddingLeft: 24, paddingBottom: 4, animation: 'fadeIn 0.12s ease-out' }}>
                        {loading ? (
                          <div style={{ padding: '6px 8px', fontSize: 10, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ display: 'inline-block', width: 12, height: 12, borderRadius: '50%', border: '2px solid #e5e7eb', borderTopColor: '#3b82f6', animation: 'spin 0.7s linear infinite' }} />
                            获取模型列表…
                          </div>
                        ) : models && models.length > 0 ? (
                          models.map(m => (
                            <div key={m.id} onClick={() => {
                              const store = useStore.getState()
                              const actualUrl = (p.id === 'custom' ? store.llmConfig.baseUrl : p.url)
                              const syncedUrl = (p.id === 'lmstudio' && store.llmConfig.baseUrl?.includes(':1234'))
                                ? store.llmConfig.baseUrl
                                : actualUrl
                              switchLLMProvider(p.nameCn || p.label, syncedUrl, m.id)
                              store.setLLMConfig({ model: m.id })
                              setShowProviderMenu(false)
                              setExpandedProvider(null)
                            }}
                              style={{
                                padding: '5px 8px', borderRadius: 4, cursor: 'pointer',
                                fontSize: 10, color: 'var(--text-secondary)',
                                background: active && llmConfig.model === m.id ? '#f0f7ff' : 'transparent',
                                fontWeight: active && llmConfig.model === m.id ? 600 : 400,
                                display: 'flex', alignItems: 'center', gap: 4,
                                transition: 'background 0.1s',
                              }}
                              onMouseEnter={e => { e.currentTarget.style.background = '#f3f4f6' }}
                              onMouseLeave={e => { e.currentTarget.style.background = active && llmConfig.model === m.id ? '#f0f7ff' : 'transparent' }}>
                              {active && llmConfig.model === m.id && <span style={{ color: '#3b82f6', fontSize: 8 }}>●</span>}
                              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.id}</span>
                              {(m as any).multimodal && <span style={{ fontSize: 8, opacity: 0.4 }}>📷</span>}
                            </div>
                          ))
                        ) : (
                          <div style={{ padding: '6px 8px', fontSize: 10, color: 'var(--text-secondary)', fontStyle: 'italic' }}>
                            {p.id === 'custom' ? '输入自定义模型名' : '暂无模型数据'}
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
            </div>
          )}
        </div>

        {/* ═══ LLM 生成中 / 完成提示 ═══ */}
        {activePanel !== 'chat' && (isProcessing || showDone) && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            background: showDone ? '#f0fdf4' : '#eff6ff',
            border: `1px solid ${showDone ? '#86efac' : '#93c5fd'}`,
            borderRadius: 6, padding: '3px 10px',
            fontSize: 11, color: showDone ? '#16a34a' : '#2563eb',
            fontWeight: 500, marginRight: 6, userSelect: 'none',
            animation: showDone
              ? 'popIn 0.3s ease-out, fadeOut 0.4s 2.1s ease-out forwards'
              : 'fadeInRight 0.2s ease-out',
          }}>
            {showDone ? (
              <>{t('topbar.done')}</>
            ) : (
              <>
                <span style={{
                  width: 14, height: 14, borderRadius: '50%',
                  border: '2px solid rgba(59,130,246,.25)',
                  borderTopColor: '#3b82f6',
                  display: 'inline-block', flexShrink: 0,
                  animation: 'spin 0.7s linear infinite',
                }} />
                <span>{t('topbar.generating')}</span>
              </>
            )}
          </div>
        )}
        <button className="window-btn" onClick={handleMinimize} title={t('topbar.minimize')}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><rect x="1" y="5" width="10" height="1.5" rx="0.75" /></svg>
        </button>
        <button className="window-btn" onClick={handleMaximize} title={t('topbar.maximize')}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><rect x="1.5" y="1.5" width="9" height="9" rx="1.5" /></svg>
        </button>
        <button className="window-btn window-btn-close" onClick={handleClose} title={t('topbar.close')}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5"><line x1="2" y1="2" x2="10" y2="10" /><line x1="10" y1="2" x2="2" y2="10" /></svg>
        </button>
      </div>
    </header>
  )
}
