// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// ModeIndicator.tsx — 场景模式指示器 (v1.0)
//
// 在 TopBar 上显示当前模式，点击弹出模式切换面板
// 支持模式切换、手动/自动状态显示、场景透明度感知
// ============================================================

import React, { useState, useRef, useEffect } from 'react'
import { useStore, type LuminaMode } from '../stores/appStore'
import { useTranslation } from 'react-i18next'

// ═══════════════════════════════════════════════════════════
// 模式配置（与后端一致）
// ═══════════════════════════════════════════════════════════

const MODE_META: Record<LuminaMode, { label: string; emoji: string; color: string; desc: string }> = {
  work:  { label: '工作', emoji: '💼', color: '#4A90D9', desc: '高效专注，少打扰' },
  study: { label: '学习', emoji: '📚', color: '#7B68EE', desc: '知识辅助，深度模式' },
  fun:   { label: '娱乐', emoji: '🎮', color: '#FF6B6B', desc: '轻松陪伴，主动推荐' },
  idle:  { label: '空闲', emoji: '😴', color: '#95A5A6', desc: '低功耗待机' },
}

const ALL_MODES: LuminaMode[] = ['work', 'study', 'fun', 'idle']

// ═══════════════════════════════════════════════════════════
// 组件
// ═══════════════════════════════════════════════════════════

export default function ModeIndicator() {
  const { t } = useTranslation()
  const luminaMode = useStore((s) => s.luminaMode)
  const setLuminaMode = useStore((s) => s.setLuminaMode)

  const [showMenu, setShowMenu] = useState(false)
  const [animating, setAnimating] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  const current = luminaMode.current
  const meta = MODE_META[current] || MODE_META.work
  const isManual = luminaMode.manualOverride

  // 点击外部关闭
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false)
      }
    }
    if (showMenu) {document.addEventListener('mousedown', handler)}
    return () => document.removeEventListener('mousedown', handler)
  }, [showMenu])

  // 模式变化时闪一下
  useEffect(() => {
    setAnimating(true)
    const t = setTimeout(() => setAnimating(false), 600)
    return () => clearTimeout(t)
  }, [current])

  const handleSwitchMode = async (mode: LuminaMode) => {
    if (mode === current) {return}
    try {
      await (window as any).luminaAPI?.modeSet(mode)
    } catch {
      // fallback: 本地直接更新
      setLuminaMode({ current: mode, manualOverride: true })
    }
    setShowMenu(false)
  }

  const handleReleaseOverride = async () => {
    try {
      await (window as any).luminaAPI?.modeReleaseOverride()
    } catch {
      setLuminaMode({ manualOverride: false })
    }
    setShowMenu(false)
  }

  const sceneLabel = luminaMode.lastScene
    ? `${luminaMode.lastScene.windowTitle.slice(0, 20)}`
    : ''

  return (
    <div ref={menuRef} style={{ position: 'relative', display: 'inline-flex' }}>
      {/* 模式指示器按钮 */}
      <div
        className={`mode-indicator-btn ${animating ? 'mode-indicator-flash' : ''}`}
        onClick={() => setShowMenu(!showMenu)}
        title={`当前模式: ${meta.label}${sceneLabel ? ` · ${sceneLabel}` : ''}`}
        style={{
          display: 'flex', alignItems: 'center', gap: 4,
          padding: '2px 8px', borderRadius: 12,
          background: `${meta.color}18`,
          color: meta.color,
          fontSize: 11, fontWeight: 600,
          cursor: 'pointer', userSelect: 'none',
          border: `1px solid ${meta.color}30`,
          transition: 'all 0.3s ease',
        }}
      >
        <span style={{ fontSize: 13, lineHeight: 1 }}>{meta.emoji}</span>
        <span>{meta.label}</span>
        {isManual && (
          <span style={{ fontSize: 9, opacity: 0.6, marginLeft: 2 }}>📌</span>
        )}
      </div>

      {/* 下拉菜单 */}
      {showMenu && (
        <div
          style={{
            position: 'absolute', top: 'calc(100% + 4px)', left: 0,
            background: 'var(--surface-200)', borderRadius: 10,
            border: '1px solid var(--border-light)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
            zIndex: 1000,
            minWidth: 180,
            padding: 4,
            backdropFilter: 'blur(12px)',
          }}
        >
          {/* 标题 */}
          <div style={{ padding: '6px 10px 4px', fontSize: 10, color: 'var(--text-tertiary)', fontWeight: 600 }}>
            🎯 场景模式
          </div>

          {/* 模式列表 */}
          {ALL_MODES.map((mode) => {
            const m = MODE_META[mode]
            const isActive = mode === current
            return (
              <div
                key={mode}
                onClick={() => handleSwitchMode(mode)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '7px 10px', borderRadius: 8,
                  cursor: 'pointer',
                  background: isActive ? `${m.color}20` : 'transparent',
                  color: isActive ? m.color : 'var(--text-primary)',
                  fontWeight: isActive ? 600 : 400,
                  fontSize: 12,
                  transition: 'background 0.15s',
                }}
                onMouseEnter={(e) => {
                  if (!isActive) {e.currentTarget.style.background = 'var(--hover-bg)'}
                }}
                onMouseLeave={(e) => {
                  if (!isActive) {e.currentTarget.style.background = 'transparent'}
                }}
              >
                <span style={{ fontSize: 15 }}>{m.emoji}</span>
                <div style={{ flex: 1 }}>
                  <div>{m.label}</div>
                  <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 1 }}>{m.desc}</div>
                </div>
                {isActive && <span style={{ fontSize: 12 }}>✓</span>}
              </div>
            )
          })}

          {/* 分隔线 */}
          <div style={{ height: 1, background: 'var(--border-light)', margin: '4px 10px' }} />

          {/* 场景信息 */}
          {luminaMode.lastScene && (
            <div style={{ padding: '6px 10px', fontSize: 10, color: 'var(--text-tertiary)' }}>
              <div>📋 {luminaMode.lastScene.windowTitle.slice(0, 28)}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
                <span>🔄 {luminaMode.lastScene.processName}</span>
                <span style={{ opacity: 0.6 }}>| {luminaMode.lastScene.confidence}%</span>
              </div>
            </div>
          )}

          {/* 手动覆盖状态 */}
          {isManual && (
            <div
              onClick={handleReleaseOverride}
              style={{
                padding: '6px 10px', fontSize: 10, color: 'var(--blue-500)',
                cursor: 'pointer', textAlign: 'center', borderRadius: 6,
              }}
              onMouseEnter={(e) => e.currentTarget.style.background = 'var(--hover-bg)'}
              onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
            >
              🔓 恢复自动检测
            </div>
          )}
        </div>
      )}

      <style>{`
        .mode-indicator-flash {
          animation: modePulse 0.6s ease-out;
        }
        @keyframes modePulse {
          0% { transform: scale(1); }
          30% { transform: scale(1.12); }
          100% { transform: scale(1); }
        }
      `}</style>
    </div>
  )
}
