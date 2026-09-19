// LuckyModeSelector.tsx — Lucky 模式选择器 (v1.1)
//
// 聊天输入框下方的控制栏组件
// 提供四种模式: Lucky Agent / 标准循环 / 目标驱动 / 任务拆解
// 默认显示 "🍀 Lucky Agent"，表示功能可用但未启用
// ============================================================

import React, { useState, useRef, useEffect } from 'react'
import { useStore } from '../stores/appStore'

export type LuckyModePreset = 'off' | 'default' | 'goal' | 'mission'

export interface LuckyModeInfo {
  preset: LuckyModePreset
  /** 是否正在活跃运行中 */
  isActive: boolean
  /** 当前迭代轮次 */
  currentIteration: number
  /** 最大迭代轮次 */
  maxIteration: number
  /** 是否已暂停（死循环检测触发） */
  isPaused: boolean
  /** 暂停原因 */
  pauseReason: string | null
  /** 目标模式：当前完成度 */
  completionPercent?: number
  /** 任务模式：已完成子任务数 */
  completedTasks?: number
  /** 任务模式：总子任务数 */
  totalTasks?: number
}

// ── 预设定义 ──

const PRESETS: Array<{
  id: LuckyModePreset
  icon: string
  label: string
  description: string
  color: string
}> = [
  { id: 'off',       icon: '🍀',  label: 'Lucky Agent', description: '不启用 Lucky 模式',         color: '#9ca3af' },
  { id: 'default',   icon: '🔄',  label: '标准循环',    description: '防死循环 + 自动完成检查',   color: '#3b82f6' },
  { id: 'goal',      icon: '🎯',  label: '目标驱动',    description: '设定目标→含子任务拆解→完成', color: '#8b5cf6' },
]

interface LuckyModeSelectorProps {
  /** 当前选中的预设 */
  currentPreset: LuckyModePreset
  /** 预设切换回调 */
  onPresetChange: (preset: LuckyModePreset) => void
  /** 运行时状态（可选） */
  runtimeInfo?: LuckyModeInfo
  /** 兼容别名：config（等同于 runtimeInfo） */
  config?: LuckyModeInfo
  /** 按钮大小（默认 small） */
  size?: 'small' | 'medium'
  /** 是否禁用 */
  disabled?: boolean
  /** 打开设置面板（完整配置弹窗） */
  onOpenSettings?: () => void
  /** 预设切换后是否立即应用 */
  instantApply?: boolean
}

export default function LuckyModeSelector({
  currentPreset,
  onPresetChange,
  runtimeInfo,
  size = 'small',
  disabled = false,
  onOpenSettings,
  instantApply = true,
}: LuckyModeSelectorProps) {
  const [showDropdown, setShowDropdown] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // 点击外部关闭下拉
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowDropdown(false)
      }
    }
    if (showDropdown) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showDropdown])

  const currentPresetInfo = PRESETS.find(p => p.id === currentPreset) || PRESETS[0]

  const isSmall = size === 'small'

  return (
    <div ref={containerRef} style={{ position: 'relative', flexShrink: 0 }}>
      {/* ── 主按钮（显示当前预设） ── */}
      <button
        onClick={() => !disabled && setShowDropdown(!showDropdown)}
        disabled={disabled}
        title={currentPresetInfo.description}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: isSmall ? 3 : 4,
          padding: isSmall ? '2px 8px' : '4px 12px',
          borderRadius: 6,
          border: `1.5px solid ${runtimeInfo?.isActive ? currentPresetInfo.color + '60' : 'var(--border-light)'}`,
          background: runtimeInfo?.isActive
            ? `${currentPresetInfo.color}18`
            : currentPreset === 'off'
              ? 'var(--surface-100)'
              : `${currentPresetInfo.color}12`,
          cursor: disabled ? 'default' : 'pointer',
          fontSize: isSmall ? 11 : 12,
          color: currentPreset === 'off' ? 'var(--text-secondary)' : currentPresetInfo.color,
          fontWeight: 500,
          transition: 'all 0.15s',
          opacity: disabled ? 0.5 : 1,
          position: 'relative',
          outline: 'none',
        }}
        onMouseEnter={e => {
          if (!disabled) {
            (e.currentTarget as HTMLElement).style.background =
              `${currentPresetInfo.color}22`
          }
        }}
        onMouseLeave={e => {
          if (!disabled) {
            (e.currentTarget as HTMLElement).style.background = runtimeInfo?.isActive
              ? `${currentPresetInfo.color}18`
              : currentPreset === 'off'
                ? 'var(--surface-100)'
                : `${currentPresetInfo.color}12`
          }
        }}
      >
        <span style={{ fontSize: isSmall ? 13 : 15 }}>{currentPresetInfo.icon}</span>
        <span>{currentPresetInfo.label}</span>

        {/* 运行时状态指示器 */}
        {runtimeInfo?.isActive && (
          <>
            <span style={{
              width: 6, height: 6, borderRadius: 3,
              background: currentPresetInfo.color,
              animation: 'pulse 1.2s ease-in-out infinite',
              marginLeft: 2,
            }} />
            <span style={{ fontSize: 9, color: currentPresetInfo.color + 'aa' }}>
              {runtimeInfo.currentIteration}/{runtimeInfo.maxIteration}
            </span>
          </>
        )}

        {/* 暂停状态 */}
        {runtimeInfo?.isPaused && (
          <span style={{
            fontSize: 9, marginLeft: 2, color: '#ef4444',
            fontWeight: 600,
          }}>
            ⏸️
          </span>
        )}

        {/* 下拉箭头 */}
        <span style={{
          fontSize: 8,
          marginLeft: isSmall ? 1 : 2,
          opacity: 0.6,
          transition: 'transform 0.2s',
          transform: showDropdown ? 'rotate(180deg)' : 'rotate(0deg)',
        }}>
          ▼
        </span>
      </button>

      {/* ── 下拉菜单 ── */}
      {showDropdown && (
        <div style={{
          position: 'absolute',
          bottom: 'calc(100% + 6px)',
          left: 0,
          zIndex: 1000,
          minWidth: 220,
          background: 'var(--surface-0)',
          border: '1px solid var(--border-light)',
          borderRadius: 10,
          padding: 6,
          boxShadow: '0 4px 20px rgba(0,0,0,0.12)',
          animation: 'fadeInUp 0.15s ease',
        }}>
          {/* 标题 */}
          <div style={{
            padding: '4px 8px 6px',
            fontSize: 10,
            fontWeight: 600,
            color: 'var(--text-secondary)',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            borderBottom: '1px solid var(--border-light)',
            marginBottom: 4,
          }}>
            🍀 Lucky 模式
          </div>

          {/* 预设选项列表 */}
          {PRESETS.map(preset => {
            const isSelected = currentPreset === preset.id
            return (
              <button
                key={preset.id}
                onClick={() => {
                  onPresetChange(preset.id)
                  if (instantApply) {setShowDropdown(false)}
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  padding: '8px 10px',
                  borderRadius: 8,
                  border: isSelected ? `1.5px solid ${preset.color}60` : '1px solid transparent',
                  background: isSelected ? `${preset.color}12` : 'transparent',
                  cursor: 'pointer',
                  fontSize: 12,
                  textAlign: 'left',
                  transition: 'all 0.1s',
                  marginBottom: 2,
                  color: isSelected ? preset.color : 'var(--text-primary)',
                  fontWeight: isSelected ? 600 : 400,
                }}
                onMouseEnter={e => {
                  if (!isSelected) {
                    (e.currentTarget as HTMLElement).style.background = 'var(--surface-100)'
                  }
                }}
                onMouseLeave={e => {
                  if (!isSelected) {
                    (e.currentTarget as HTMLElement).style.background = 'transparent'
                  }
                }}
              >
                <span style={{ fontSize: 18 }}>{preset.icon}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: 13,
                    fontWeight: isSelected ? 600 : 500,
                  }}>
                    {preset.label}
                  </div>
                  <div style={{
                    fontSize: 10,
                    color: 'var(--text-secondary)',
                    marginTop: 1,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>
                    {preset.description}
                  </div>
                </div>
                {isSelected && (
                  <span style={{
                    width: 8, height: 8, borderRadius: 4,
                    background: preset.color,
                    flexShrink: 0,
                  }} />
                )}
              </button>
            )
          })}

          {/* 底部操作 */}
          <div style={{
            borderTop: '1px solid var(--border-light)',
            marginTop: 4,
            paddingTop: 4,
            display: 'flex',
            gap: 4,
          }}>
            <button
              onClick={() => {
                onOpenSettings?.()
                setShowDropdown(false)
              }}
              style={{
                flex: 1,
                padding: '6px 8px',
                borderRadius: 6,
                border: '1px solid var(--border-light)',
                background: 'transparent',
                cursor: 'pointer',
                fontSize: 11,
                color: 'var(--text-secondary)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 4,
              }}
            >
              ⚙️ 详细设置
            </button>

            {currentPreset !== 'off' && runtimeInfo?.isActive && (
              <button
                onClick={() => {
                  onPresetChange('off')
                  setShowDropdown(false)
                }}
                style={{
                  flex: 1,
                  padding: '6px 8px',
                  borderRadius: 6,
                  border: '1px solid #fca5a5',
                  background: '#fef2f2',
                  cursor: 'pointer',
                  fontSize: 11,
                  color: '#dc2626',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 4,
                }}
              >
                ⏹️ 停止
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── 暂停提示 ── */}
      {runtimeInfo?.isPaused && runtimeInfo.pauseReason && (
        <div style={{
          position: 'absolute',
          bottom: 'calc(100% + 6px)',
          left: 0,
          zIndex: 999,
          background: '#fef2f2',
          border: '1px solid #fca5a5',
          borderRadius: 8,
          padding: '6px 10px',
          fontSize: 11,
          color: '#dc2626',
          minWidth: 200,
          maxWidth: 300,
          boxShadow: '0 2px 12px rgba(0,0,0,0.1)',
          animation: 'fadeInUp 0.2s ease',
        }}>
          <div style={{ fontWeight: 600, marginBottom: 2 }}>⏸️ Lucky 模式已暂停</div>
          <div style={{ color: '#b91c1c', fontSize: 10 }}>{runtimeInfo.pauseReason}</div>
        </div>
      )}
    </div>
  )
}
