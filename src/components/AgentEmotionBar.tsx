// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// AgentEmotionBar.tsx — Agent 情绪状态栏 (v2.13)
//
// v2.13 增强:
//   - 情绪标签可点击 → 手动选择 12 种情绪
//   - 20 种在线状态（会议/专注/休息/游戏/睡觉/写代码/旅行...）
//   - 自定义状态文本
//   - 手动自动切换开关
//   - 状态分组展示
// ============================================================

import React, { useState, useEffect, useCallback, useRef } from 'react'
import {
  getEmotion,
  getNamedEmotion,
  getAgentStatus,
  setAgentStatus,
  getStatusLabel,
  getCustomStatusText,
  setCustomStatusText,
  setManualEmotion,
  clearManualEmotion,
  isManualEmotion,
  getManualEmotion,
  onEmotionChange,
  EMOTION_LABELS,
  STATUS_LABELS,
  type AgentEmotion,
  type EmotionLabel,
  type AgentStatus,
  type StatusLabel,
  type NamedEmotion,
} from '../services/agentEmotion'

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

export interface AgentEmotionBarProps {
  agentIds?: string[]
  mode?: 'chat' | 'agent' | 'developer' | 'worker' | 'group'
  compact?: boolean
  onStatusChange?: (agentId: string, status: AgentStatus) => void
  style?: React.CSSProperties
}

interface AgentSlot { id: string; name: string; icon: string; color: string }

const AGENT_META: Record<string, AgentSlot> = {
  lumina: { id: 'lumina', name: 'Lumina', icon: '🐱', color: '#FF6B6B' },
  recha:  { id: 'recha', name: '热茶', icon: '🍵', color: '#448AFF' },
  yak:    { id: 'yak', name: 'Yak', icon: '📊', color: '#43A047' },
}

const MODE_AGENT_MAP: Record<string, string[]> = {
  chat:      ['lumina'],
  agent:     ['lumina'],
  developer: ['recha'],
  worker:    ['recha'],
  group:     ['lumina', 'recha', 'yak'],
}

// 状态分组
const STATUS_GROUPS: { label: string; items: AgentStatus[] }[] = [
  { label: '常用', items: ['online', 'away', 'busy', 'dnd'] },
  { label: '工作', items: ['meeting', 'focus', 'coding', 'studying'] },
  { label: '生活', items: ['break', 'eating', 'sleeping', 'commuting'] },
  { label: '娱乐', items: ['gaming', 'streaming', 'traveling', 'vacation'] },
  { label: '特殊', items: ['sick', 'invisible', 'offline', 'custom'] },
]

// ═══════════════════════════════════════════════════════════
// 情绪选择器弹窗
// ═══════════════════════════════════════════════════════════

const EmotionPicker: React.FC<{
  agentId: string
  current: EmotionLabel
  isManual: boolean
  onSelect: (emotion: NamedEmotion) => void
  onReset: () => void
  onClose: () => void
}> = ({ agentId, current, isManual, onSelect, onReset, onClose }) => {
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.emotion-picker')) {onClose()}
    }
    setTimeout(() => document.addEventListener('click', handler), 0)
    return () => document.removeEventListener('click', handler)
  }, [onClose])

  const emotions = Object.values(EMOTION_LABELS)

  return (
    <div className="emotion-picker" style={{
      position: 'absolute', top: '100%', left: 0, marginTop: 6, zIndex: 100,
      background: 'var(--surface-0)', borderRadius: 12,
      boxShadow: '0 12px 32px rgba(0,0,0,0.14), 0 4px 8px rgba(0,0,0,0.06)',
      border: '1px solid var(--border-light)', padding: 8,
      width: 280, maxHeight: 360, overflowY: 'auto',
    }}>
      {/* header */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '4px 8px 8px', borderBottom: '1px solid var(--border-light)', marginBottom: 6,
      }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>
          {isManual ? '🔧 手动模式' : '🤖 自动模式'}
        </span>
        <div style={{ display: 'flex', gap: 4 }}>
          {isManual && (
            <button onClick={(e) => { e.stopPropagation(); onReset() }} style={{
              padding: '3px 8px', borderRadius: 4, border: '1px solid #fca5a5',
              background: 'var(--red-100)', color: '#ef4444', cursor: 'pointer', fontSize: 11,
              fontFamily: 'inherit',
            }}>
              恢复自动
            </button>
          )}
          <button onClick={(e) => { e.stopPropagation(); onClose() }} style={{
            padding: '3px 6px', borderRadius: 4, border: 'none',
            background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 14,
          }}>✕</button>
        </div>
      </div>

      {/* emotion grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4 }}>
        {emotions.map(e => {
          const isActive = current.id === e.id
          return (
            <button
              key={e.id}
              onClick={(ev) => { ev.stopPropagation(); onSelect(e.id) }}
              style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
                padding: '8px 4px', borderRadius: 8,
                border: isActive ? `2px solid ${e.color}` : '1px solid transparent',
                background: isActive ? e.bg : 'transparent',
                cursor: 'pointer',
                transition: 'all 0.15s',
                fontFamily: 'inherit',
              }}
              onMouseEnter={ev => {
                if (!isActive) {(ev.currentTarget as HTMLElement).style.background = '#f9fafb'}
              }}
              onMouseLeave={ev => {
                if (!isActive) {(ev.currentTarget as HTMLElement).style.background = 'transparent'}
              }}
            >
              <span style={{ fontSize: 24 }}>{e.icon}</span>
              <span style={{ fontSize: 11, fontWeight: isActive ? 700 : 500, color: isActive ? e.color : 'var(--text-primary)' }}>
                {e.label}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// 增强状态选择器（分组 + 自定义文本）
// ═══════════════════════════════════════════════════════════

const StatusPicker: React.FC<{
  current: AgentStatus
  agentId: string
  onSelect: (status: AgentStatus) => void
  onClose: () => void
}> = ({ current, agentId, onSelect, onClose }) => {
  const [customText, setCustomText] = useState(getCustomStatusText(agentId))
  const [showCustomInput, setShowCustomInput] = useState(current === 'custom')

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.status-picker')) {onClose()}
    }
    setTimeout(() => document.addEventListener('click', handler), 0)
    return () => document.removeEventListener('click', handler)
  }, [onClose])

  return (
    <div className="status-picker" style={{
      position: 'absolute', top: '100%', left: 0, marginTop: 6, zIndex: 100,
      background: 'var(--surface-0)', borderRadius: 12,
      boxShadow: '0 12px 32px rgba(0,0,0,0.14), 0 4px 8px rgba(0,0,0,0.06)',
      border: '1px solid var(--border-light)', padding: 6,
      minWidth: 200, maxHeight: 420, overflowY: 'auto',
    }}>
      {STATUS_GROUPS.map(group => (
        <div key={group.label} style={{ marginBottom: 4 }}>
          <div style={{
            fontSize: 10, fontWeight: 600, color: 'var(--text-secondary)',
            padding: '4px 10px 2px', textTransform: 'uppercase', letterSpacing: 0.5,
          }}>
            {group.label}
          </div>
          {group.items.map(s => {
            const label = STATUS_LABELS[s]
            const isActive = current === s
            return (
              <button
                key={s}
                onClick={(e) => {
                  e.stopPropagation()
                  onSelect(s)
                  if (s === 'custom') {
                    setShowCustomInput(true)
                  } else {
                    setShowCustomInput(false)
                  }
                }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '6px 10px', borderRadius: 6,
                  border: 'none', background: isActive ? label.color + '14' : 'transparent',
                  cursor: 'pointer', fontSize: 12,
                  transition: 'background 0.15s',
                  width: '100%', textAlign: 'left',
                  fontFamily: 'inherit',
                }}
                onMouseEnter={ev => {
                  if (!isActive) {(ev.currentTarget as HTMLElement).style.background = '#f3f4f6'}
                }}
                onMouseLeave={ev => {
                  if (!isActive) {(ev.currentTarget as HTMLElement).style.background = 'transparent'}
                }}
              >
                <span style={{
                  width: 10, height: 10, borderRadius: 5,
                  background: label.color, boxShadow: `0 0 6px ${label.color}66`,
                  flexShrink: 0,
                }} />
                <span style={{ fontSize: 15, flexShrink: 0 }}>{label.emoji}</span>
                <span style={{ fontWeight: 600, color: 'var(--text-primary)', flex: 1 }}>{label.label}</span>
                {isActive && <span style={{ fontSize: 12, color: label.color }}>✓</span>}
              </button>
            )
          })}
        </div>
      ))}

      {/* custom text input */}
      {showCustomInput && (
        <div style={{ padding: '6px 10px', borderTop: '1px solid #f3f4f6' }}>
          <input
            value={customText}
            onChange={e => setCustomText(e.target.value)}
            onBlur={() => { if (customText.trim()) {setCustomStatusText(agentId, customText.trim())} }}
            onKeyDown={e => { if (e.key === 'Enter') { setCustomStatusText(agentId, customText.trim()); (e.target as HTMLInputElement).blur() } }}
            placeholder="输入自定义状态..."
            style={{
              width: '100%', padding: '4px 8px', fontSize: 12, borderRadius: 6,
              border: '1px solid var(--border-light)', outline: 'none', fontFamily: 'inherit',
            }}
            autoFocus
          />
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// 单个 Agent 情绪条
// ═══════════════════════════════════════════════════════════

const AgentEmotionChip: React.FC<{
  agent: AgentSlot
  emotion: AgentEmotion
  label: EmotionLabel
  status: AgentStatus
  statusLabel: StatusLabel
  isManual: boolean
  compact: boolean
  onToggleStatus: () => void
}> = ({ agent, emotion, label, status, statusLabel, isManual, compact, onToggleStatus }) => {
  const [showStatusPicker, setShowStatusPicker] = useState(false)
  const [showEmotionPicker, setShowEmotionPicker] = useState(false)
  const [animClass, setAnimClass] = useState('')
  const prevLabelRef = useRef(label.id)
  const customText = getCustomStatusText(agent.id)

  useEffect(() => {
    // 只有当这个 Agent 的情绪标签真正变化时才播放动画
    if (prevLabelRef.current !== label.id) {
      prevLabelRef.current = label.id
      setAnimClass('emotion-pop')
      const t = setTimeout(() => setAnimClass(''), 400)
      return () => clearTimeout(t)
    }
  }, [label.id])

  const moodPercent = Math.round((emotion.mood + 1) / 2 * 100)
  const energyPercent = Math.round(emotion.energy * 100)

  const handleEmotionSelect = (e: NamedEmotion) => {
    setManualEmotion(agent.id, e)
    setShowEmotionPicker(false)
    onToggleStatus()
  }

  const handleResetEmotion = () => {
    clearManualEmotion(agent.id)
    setShowEmotionPicker(false)
    onToggleStatus()
  }

  const handleStatusSelect = (s: AgentStatus) => {
    setAgentStatus(agent.id, s)
    setShowStatusPicker(false)
    onToggleStatus()
  }

  const effectiveLabel = status === 'custom' && customText
    ? customText
    : (status !== 'online' && status !== 'offline' ? statusLabel.label : label.label)

  if (compact) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '4px 10px', borderRadius: 8,
        background: isManual ? `${label.color}15` : label.bg,
        border: isManual ? `2px dashed ${label.color}40` : `1px solid ${label.color}20`,
        fontSize: 12, position: 'relative',
        transition: 'all 0.2s',
      }}>
        {/* status dot */}
        <div
          onClick={(e) => { e.stopPropagation(); setShowStatusPicker(!showStatusPicker) }}
          style={{
            width: 8, height: 8, borderRadius: 4,
            background: statusLabel.color,
            boxShadow: `0 0 6px ${statusLabel.color}99`,
            cursor: 'pointer', flexShrink: 0,
            transition: 'transform 0.2s',
          }}
          onMouseEnter={e2 => { (e2.currentTarget as HTMLElement).style.transform = 'scale(1.3)' }}
          onMouseLeave={e2 => { (e2.currentTarget as HTMLElement).style.transform = 'scale(1)' }}
          title={`${statusLabel.label}: ${statusLabel.desc}`}
        />
        <span>{agent.icon}</span>
        <span style={{ fontWeight: 600, color: agent.color }}>{agent.name}</span>

        {/* emotion label (clickable) */}
        <span
          className={animClass}
          onClick={(e) => { e.stopPropagation(); setShowEmotionPicker(!showEmotionPicker) }}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 3,
            padding: '1px 6px', borderRadius: 10,
            background: `${label.color}18`, border: `1px solid ${label.color}25`,
            cursor: 'pointer', fontSize: 11,
            transition: 'background 0.15s',
          }}
          title="点击切换情绪"
        >
          <span style={{ fontSize: 14 }}>{label.icon}</span>
          <span style={{ color: label.color, fontWeight: 500 }}>{effectiveLabel}</span>
          {isManual && <span style={{ fontSize: 9, color: label.color }}>🔧</span>}
        </span>

        {showStatusPicker && (
          <StatusPicker current={status} agentId={agent.id} onSelect={handleStatusSelect} onClose={() => setShowStatusPicker(false)} />
        )}
        {showEmotionPicker && (
          <EmotionPicker agentId={agent.id} current={label} isManual={isManual} onSelect={handleEmotionSelect} onReset={handleResetEmotion} onClose={() => setShowEmotionPicker(false)} />
        )}
      </div>
    )
  }

  // full mode
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '10px 16px',
      background: isManual
        ? `linear-gradient(135deg, ${label.bg}, ${label.color}10)`
        : label.gradient,
      borderRadius: 12,
      border: isManual ? `2px dashed ${label.color}40` : `1px solid ${label.color}25`,
      position: 'relative', overflow: 'visible',
      transition: 'all 0.3s ease',
    }}>
      {/* bg decoration — clipped to border radius */}
      <div style={{ position: 'absolute', inset: 0, borderRadius: 12, overflow: 'hidden', pointerEvents: 'none' }}>
        <div style={{ position: 'absolute', right: 16, top: -8, fontSize: 48, opacity: 0.12 }}>
          {label.icon}
        </div>
      </div>

      {/* manual badge */}
      {isManual && (
        <div style={{
          position: 'absolute', top: 4, right: 40,
          fontSize: 10, color: label.color, fontWeight: 600,
          background: `${label.color}15`, padding: '1px 6px', borderRadius: 8,
        }}>手动</div>
      )}

      {/* status dot */}
      <div style={{ position: 'relative' }}>
        <div
          onClick={() => setShowStatusPicker(!showStatusPicker)}
          style={{
            width: 14, height: 14, borderRadius: 7,
            background: statusLabel.color,
            boxShadow: `0 0 10px ${statusLabel.color}99`,
            cursor: 'pointer',
            transition: 'transform 0.2s',
            flexShrink: 0,
          }}
          onMouseEnter={e2 => { (e2.currentTarget as HTMLElement).style.transform = 'scale(1.2)' }}
          onMouseLeave={e2 => { (e2.currentTarget as HTMLElement).style.transform = 'scale(1)' }}
          title={`${statusLabel.label}: ${statusLabel.desc}\n点击切换状态`}
        />
        {showStatusPicker && (
          <StatusPicker current={status} agentId={agent.id} onSelect={handleStatusSelect} onClose={() => setShowStatusPicker(false)} />
        )}
      </div>

      {/* agent info */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        <span style={{ fontSize: 22 }}>{agent.icon}</span>
        <span style={{ fontWeight: 700, fontSize: 15, color: agent.color }}>{agent.name}</span>
      </div>

      {/* emotion label (clickable) */}
      <div style={{ position: 'relative' }}>
        <div
          className={animClass}
          onClick={() => setShowEmotionPicker(!showEmotionPicker)}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '5px 12px', borderRadius: 20,
            background: `${label.color}18`, border: `1px solid ${label.color}35`,
            fontSize: 13, fontWeight: 600, color: label.color,
            whiteSpace: 'nowrap', cursor: 'pointer',
            transition: 'all 0.15s',
          }}
          title="点击切换情绪（自动/手动）"
        >
          <span style={{ fontSize: 18 }}>{label.icon}</span>
          <span>{effectiveLabel}</span>
        </div>
        {showEmotionPicker && (
          <EmotionPicker agentId={agent.id} current={label} isManual={isManual} onSelect={handleEmotionSelect} onReset={handleResetEmotion} onClose={() => setShowEmotionPicker(false)} />
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-secondary)' }}>
        <span>⚡</span>
        <div style={{ width: 50, height: 4, borderRadius: 2, background: '#e5e7eb', overflow: 'hidden' }}>
          <div className="emotion-bar-progress" style={{
            width: `${energyPercent}%`, height: '100%',
            background: energyPercent > 50 ? '#22c55e' : energyPercent > 20 ? '#eab308' : '#ef4444',
            borderRadius: 2,
          }} />
        </div>
        <span style={{ color: energyPercent > 50 ? '#22c55e' : energyPercent > 20 ? '#eab308' : '#ef4444' }}>
          {energyPercent}%
        </span>
      </div>

      {/* mood bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-secondary)' }}>
        <span>💖</span>
        <div style={{ width: 50, height: 4, borderRadius: 2, background: '#e5e7eb', overflow: 'hidden' }}>
          <div className="emotion-bar-progress" style={{
            width: `${moodPercent}%`, height: '100%',
            background: label.color, borderRadius: 2,
          }} />
        </div>
        <span style={{ color: label.color }}>{moodPercent}%</span>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// 主组件
// ═══════════════════════════════════════════════════════════

export default function AgentEmotionBar({
  agentIds: propAgentIds, mode, compact: propCompact, onStatusChange, style,
}: AgentEmotionBarProps) {
  const agentIds = propAgentIds || (mode ? MODE_AGENT_MAP[mode] || ['lumina'] : ['lumina'])
  const compact = propCompact ?? (agentIds.length > 1)
  const [, setTick] = useState(0)
  const forceUpdate = useCallback(() => setTick(t => t + 1), [])

  useEffect(() => {
    const unsub = onEmotionChange(() => forceUpdate())
    return unsub
  }, [forceUpdate])

  useEffect(() => {
    const handlers = [
      ['agent:status-changed', forceUpdate],
      ['agent:emotion-manual', forceUpdate],
      ['agent:emotion-auto', forceUpdate],
    ] as const
    handlers.forEach(([event, fn]) => {
      window.addEventListener(event, fn as any)
    })
    return () => {
      handlers.forEach(([event, fn]) => {
        window.removeEventListener(event, fn as any)
      })
    }
  }, [forceUpdate])

  if (agentIds.length === 0) {return null}

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: compact ? 6 : 0,
      padding: compact ? '6px 8px' : '6px 0',
      flexWrap: 'wrap', flexShrink: 0, ...style,
    }}>
      {compact ? (
        agentIds.map(id => {
          const meta = AGENT_META[id]
          if (!meta) {return null}
          const emotion = getEmotion(id)
          const label = getNamedEmotion(id)
          const status = getAgentStatus(id)
          const statusLabel = getStatusLabel(status)
          const manual = isManualEmotion(id)
          return (
            <AgentEmotionChip key={id} agent={meta} emotion={emotion} label={label}
              status={status} statusLabel={statusLabel} isManual={manual}
              compact={true} onToggleStatus={() => { onStatusChange?.(id, status as AgentStatus); forceUpdate() }} />
          )
        })
      ) : (
        (() => {
          const id = agentIds[0]
          const meta = AGENT_META[id]
          if (!meta) {return null}
          const emotion = getEmotion(id)
          const label = getNamedEmotion(id)
          const status = getAgentStatus(id)
          const statusLabel = getStatusLabel(status)
          const manual = isManualEmotion(id)
          return (
            <div style={{ width: '100%' }}>
              <AgentEmotionChip agent={meta} emotion={emotion} label={label}
                status={status} statusLabel={statusLabel} isManual={manual}
                compact={false} onToggleStatus={() => { onStatusChange?.(id, status as AgentStatus); forceUpdate() }} />
            </div>
          )
        })()
      )}
    </div>
  )
}

export function injectEmotionStyles() {
  if (typeof document === 'undefined') {return}
  if (document.getElementById('emotion-bar-styles')) {return}
  const style = document.createElement('style')
  style.id = 'emotion-bar-styles'
  style.textContent = `
    @keyframes emotionPop {
      0%   { transform: scale(1); }
      30%  { transform: scale(1.15); }
      60%  { transform: scale(0.95); }
      100% { transform: scale(1); }
    }
    .emotion-pop { animation: emotionPop 0.4s cubic-bezier(0.34, 1.56, 0.64, 1); }
    .emotion-bar-progress { transition: width 0.6s cubic-bezier(0.34, 1.56, 0.64, 1); }
  `
  document.head.appendChild(style)
}
