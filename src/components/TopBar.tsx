// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
import React, { useEffect, useRef, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '../stores/appStore'
import { getPersona } from '../data/personas'
import { IconSmile, IconWifi, IconWifiOff } from './Icons'
import PersonaAvatar from './PersonaAvatar'
import ModeIndicator from './ModeIndicator'  // 🆕 v2.0: 场景模式指示器
import {
  getEmotion, getNamedEmotion, setEmotion, getAgentStatus, getStatusLabel,
  onEmotionChange, type AgentStatus,
} from '../services/agentEmotion'

export default function TopBar() {
  const { t } = useTranslation()
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

  // 🔥 实时消息数
  const activeConv = conversations.find((c) => c.id === activeConversationId)
  const msgCount = activeConv?.messages.filter((m) => m.role !== 'system').length || 0

  // 🎭 情绪自定义弹窗
  const [emotionPickerAgent, setEmotionPickerAgent] = useState<string | null>(null)
  const [emotionPickerPos, setEmotionPickerPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [emotionLocalTick, setEmotionLocalTick] = useState(0)

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
    if (effectiveApiKey) {headers['Authorization'] = `Bearer ${effectiveApiKey}`}

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
        if (res.ok) {online = true}
        // LM Studio 没加载模型时返回 400，但服务在线
        else if (res.status === 400) {online = true}
      } catch { /* offline */ }
    }

    setLlmOnline(online)
    setLlmChecked(true)
  }

  // 🔥 当前人格
  const persona = getPersona(activePersona, agentConfig.customPersonas)
  // 2026-10-19：Lumina 用立绘头像（emoji 在正式立绘面前显得敷衍），其余成员不变
  const personaLabel = persona ? `${persona.icon} ${persona.name}` : '🐱 Lumina'

  // 🆕 团队状态（从 Sidebar 搬过来）
  const [, setTick] = useState(0)
  const forceUpdate = useCallback(() => setTick(t => t + 1), [])
  useEffect(() => {
    const unsub = onEmotionChange(() => forceUpdate())
    const onStatus = () => forceUpdate()
    window.addEventListener('agent:status-changed', onStatus)
    window.addEventListener('agent:emotion-manual', onStatus)
    window.addEventListener('agent:emotion-auto', onStatus)
    return () => {
      unsub()
      window.removeEventListener('agent:status-changed', onStatus)
      window.removeEventListener('agent:emotion-manual', onStatus)
      window.removeEventListener('agent:emotion-auto', onStatus)
    }
  }, [forceUpdate])

  // Agent 元数据
  const AGENT_META: Record<string, { id: string; name: string; icon: string; color: string }> = {
    lumina: { id: 'lumina', name: 'Lumina', icon: '🐱', color: '#FF6B6B' },
    recha:  { id: 'recha',  name: '热茶',   icon: '🍵', color: '#448AFF' },
    yak:    { id: 'yak',    name: 'Yak',    icon: '📊', color: '#43A047' },
  }
  const TEAM_AGENTS = ['lumina', 'recha', 'yak']

  const handleMinimize = () => window.luminaAPI?.windowMinimize()
  const handleMaximize = () => window.luminaAPI?.windowMaximize()
  const handleClose = () => window.luminaAPI?.windowClose()

  const formatTokens = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n)

  // 🆕 DevTools 紧凑模式（DevTools 打开 OR 简约模式）
  const compactMode = useStore(s => s.compactMode)
  const [devtoolsOpen, setDevtoolsOpen] = useState(false)
  const compact = compactMode || devtoolsOpen
  useEffect(() => {
    const api = (window as any).luminaAPI
    if (!api?.onDevToolsChanged) {return}
    return api.onDevToolsChanged((opened: boolean) => setDevtoolsOpen(opened))
  }, [])

  return (
    <header className="topbar">
      <div className="topbar-left">
        <span className="topbar-logo brand-logo"><span>✦</span> Lumina Life</span>
        <span className="topbar-version">1.0</span>
        {/* 语言切换已移至「设置 → 语言」，顶部不再显示 EN/中 徽章 */}
      </div>

      <div className="topbar-center">
        {/* LLM 在线状态 — 手动点击检测 */}
        <div className="topbar-stat" role="button" tabIndex={0}
          aria-label={t('topbar.health_title')}
          style={{
          background: llmChecked ? (llmOnline ? 'var(--green-100)' : 'var(--red-100)') : 'var(--surface-100)',
          color: llmChecked ? (llmOnline ? '#006644' : 'var(--red-500)') : 'var(--text-tertiary)',
          cursor: 'pointer',
        }} onClick={checkLLMHealth} title={t('topbar.health_title')}>
          {llmChecked && llmOnline ? <IconWifi size={12} /> : <IconWifiOff size={12} />}
          <span style={{ fontSize: 'var(--font-size-2xs)' }}>
            {llmChecked ? (llmOnline ? t('topbar.online') : t('topbar.offline')) : t('topbar.checking')}
          </span>
        </div>

        {/* 🆕 v2.0: 场景模式指示器 */}
        <ModeIndicator />

        {/* 🆕 v2.0: 🛡️ 沙箱状态指示器 — compact 隐藏 */}
        {!compact && <div
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
          title={t('topbar.sandbox_title')}
          onMouseEnter={e => { e.currentTarget.style.background = '#dcfce7' }}
          onMouseLeave={e => { e.currentTarget.style.background = 'var(--green-100)' }}
        >
          <span style={{ fontSize: 12, lineHeight: 1 }}>🛡️</span>
          <span>{t('topbar.sandbox')}</span>
        </div>}
        {!compact && <div className="topbar-stat" style={{ background: 'var(--accent-50)', color: 'var(--accent-600)', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          {persona?.id === 'lumina'
            ? <><PersonaAvatar personaId="lumina" size={20} /><span style={{ fontSize: 12 }}>{persona.name}</span></>
            : <span style={{ fontSize: 12 }}>{personaLabel}</span>}
        </div>}

        {/* 🆕 团队状态（名字+情绪上下对齐） */}
        <div style={{
          display: 'flex', gap: compact ? 0 : 2,
          padding: compact ? '2px 6px' : '2px 8px', borderRadius: 8,
          background: 'var(--surface-100)',
          border: '1px solid var(--border-light)',
          transition: 'all 0.2s',
        }}>
          {/* Agent 列表：名字 + 情绪标签上下对齐 */}
          <div style={{ display: 'flex', gap: compact ? 4 : 8, alignItems: 'flex-start' }}>
            {TEAM_AGENTS.map(id => {
              const meta = AGENT_META[id]
              if (!meta) {return null}
              const status = getAgentStatus(id) as AgentStatus
              const statusLabel = getStatusLabel(status)
              const statusColor = statusLabel.color
              const label = getNamedEmotion(id)
              if (compact) {
                return (
                  <div key={id} style={{
                    display: 'flex', alignItems: 'center', gap: 2,
                    fontSize: 10,
                  }} title={`${meta.name}: ${statusLabel.label}`}>
                    <div style={{
                      width: 5, height: 5, borderRadius: 3,
                      background: statusColor,
                      boxShadow: `0 0 6px ${statusColor}66`,
                    }} />
                    <span style={{ fontSize: 11 }}>{meta.icon}</span>
                  </div>
                )
              }
              return (
                <div key={id} style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1,
                }} title={`${meta.name}: ${statusLabel.label}`}>
                  {/* 名字行：状态点 + 图标 + 名字 */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 2, fontSize: 11 }}>
                    <div style={{
                      width: 6, height: 6, borderRadius: 3,
                      background: statusColor,
                      boxShadow: `0 0 6px ${statusColor}66`,
                    }} />
                    <span style={{ fontSize: 13 }}>{meta.icon}</span>
                    <span style={{ fontWeight: 700, color: meta.color }}>{meta.name}</span>
                  </div>
                  {/* 情绪行 — 点击可自定义 */}
                  <span
                    onClick={(e) => {
                      e.stopPropagation()
                      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                      setEmotionPickerAgent(id)
                      setEmotionPickerPos({ x: rect.left, y: rect.bottom + 6 })
                    }}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 1,
                      padding: '1px 6px', borderRadius: 6,
                      background: `${label.color}18`,
                      border: `1px solid ${label.color}25`,
                      fontWeight: 600, color: label.color, fontSize: 10,
                      whiteSpace: 'nowrap', cursor: 'pointer',
                      transition: 'all 0.15s',
                    }}
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = `${label.color}30` }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = `${label.color}18` }}
                    title={`${meta.name}${t('topbar.emotion_click_hint')}`}
                  >
                    {label.icon} {label.label}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
        <div className="topbar-stat" style={{ cursor: 'pointer' }}
          onClick={() => window.luminaAPI?.navigatePanel?.('usage')} title={t('topbar.usage_title')}>
          <span style={{ fontSize: 11 }}>📊</span>
          <span>{formatTokens(tokenUsage.today)} {t('topbar.tokens')}</span>
        </div>

        {/* 消息数 — compact 隐藏 */}
        {!compact && <div className="topbar-stat">
          <IconSmile size={14} />
          <span>{msgCount} {t('topbar.messages')}</span>
        </div>}
      </div>

      <div className="topbar-right">
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
        <button className="window-btn" onClick={handleMinimize} title={t('topbar.minimize')} aria-label={t('topbar.minimize')}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><rect x="1" y="5" width="10" height="1.5" rx="0.75" /></svg>
        </button>
        <button className="window-btn" onClick={handleMaximize} title={t('topbar.maximize')} aria-label={t('topbar.maximize')}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><rect x="1.5" y="1.5" width="9" height="9" rx="1.5" /></svg>
        </button>
        <button className="window-btn window-btn-close" onClick={handleClose} title={t('topbar.close')} aria-label={t('topbar.close')}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5"><line x1="2" y1="2" x2="10" y2="10" /><line x1="10" y1="2" x2="2" y2="10" /></svg>
        </button>
      </div>

      {/* 🎭 情绪自定义弹窗 */}
      {emotionPickerAgent && (
        <div
          style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            zIndex: 9999,
          }}
          onClick={() => setEmotionPickerAgent(null)}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              position: 'fixed',
              top: emotionPickerPos.y,
              left: Math.min(emotionPickerPos.x, window.innerWidth - 240),
              background: 'var(--surface-100)',
              border: '1px solid var(--border-light)',
              borderRadius: 12, padding: '12px 14px',
              boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
              minWidth: 220, zIndex: 10000,
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8, color: 'var(--text-primary)' }}>
              {t('topbar.emotion_title', { name: AGENT_META[emotionPickerAgent]?.name ?? 'Agent' })}
            </div>
            {(['mood', 'energy', 'affinity'] as const).map(dim => {
              const labels: Record<string, { name: string; min: string; max: string }> = {
                mood: { name: t('topbar.dim_mood'), min: t('topbar.mood_min'), max: t('topbar.mood_max') },
                energy: { name: t('topbar.dim_energy'), min: t('topbar.energy_min'), max: t('topbar.energy_max') },
                affinity: { name: t('topbar.dim_affinity'), min: t('topbar.affinity_min'), max: t('topbar.affinity_max') },
              }
              const meta = labels[dim]
              const emotion = getEmotion(emotionPickerAgent)
              const val = emotion[dim]
              return (
                <div key={dim} style={{ marginBottom: 6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-secondary)', marginBottom: 2 }}>
                    <span>{meta.name}</span>
                    <span>{((val as number) * 100).toFixed(0)}%</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 9 }}>{meta.min}</span>
                    <input
                      type="range"
                      min={dim === 'mood' ? -100 : 0}
                      max={100}
                      value={(val as number) * 100}
                      onChange={e => {
                        const v = Number(e.target.value) / 100
                        setEmotion(emotionPickerAgent, { [dim]: v })
                        setEmotionLocalTick(t => t + 1)
                      }}
                      style={{ flex: 1, height: 4, accentColor: 'var(--accent-500)' }}
                    />
                    <span style={{ fontSize: 9 }}>{meta.max}</span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </header>
  )
}
