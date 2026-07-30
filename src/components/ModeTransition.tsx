// ============================================================
// ModeTransition.tsx — 场景模式平滑过渡动画容器 (v1.0)
//
// 包裹整个应用主体，在模式切换时应用渐变色背景动画
// 以及可选的场景感知色彩微调
// ============================================================

import React, { useEffect, useState, useRef } from 'react'
import { useStore, type LuminaMode } from '../stores/appStore'

// 模式 → 背景色/强调色映射
const MODE_AMBIENT: Record<LuminaMode, { bg: string; accent: string; gradient: string }> = {
  work:  { bg: 'rgba(74,144,217,0.03)', accent: '#4A90D9', gradient: 'linear-gradient(180deg, rgba(74,144,217,0.04) 0%, transparent 30%)' },
  study: { bg: 'rgba(123,104,238,0.03)', accent: '#7B68EE', gradient: 'linear-gradient(180deg, rgba(123,104,238,0.04) 0%, transparent 30%)' },
  fun:   { bg: 'rgba(255,107,107,0.03)', accent: '#FF6B6B', gradient: 'linear-gradient(180deg, rgba(255,107,107,0.04) 0%, transparent 30%)' },
  idle:  { bg: 'rgba(149,165,166,0.02)', accent: '#95A5A6', gradient: 'linear-gradient(180deg, rgba(149,165,166,0.02) 0%, transparent 20%)' },
}

interface ModeTransitionProps {
  children: React.ReactNode
}

export default function ModeTransition({ children }: ModeTransitionProps) {
  const luminaMode = useStore((s) => s.luminaMode)
  const current = luminaMode.current
  const ambient = MODE_AMBIENT[current] || MODE_AMBIENT.work

  const [transitionStyle, setTransitionStyle] = useState<React.CSSProperties>({})
  const prevMode = useRef<LuminaMode>(current)

  useEffect(() => {
    if (prevMode.current !== current) {
      // 触发过渡动画
      setTransitionStyle({
        transition: 'background 0.8s ease, box-shadow 0.8s ease',
        background: ambient.gradient,
      })
      prevMode.current = current

      const t = setTimeout(() => {
        setTransitionStyle({
          transition: 'background 0.8s ease',
          background: ambient.gradient,
        })
      }, 800)
      return () => clearTimeout(t)
    } else {
      setTransitionStyle({ background: ambient.gradient })
    }
  }, [current])

  return (
    <div style={{
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      position: 'relative',
      ...transitionStyle,
    }}>
      {/* 顶部氛围光晕 */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: 3,
        background: `linear-gradient(90deg, ${ambient.accent}00, ${ambient.accent}60, ${ambient.accent}00)`,
        transition: 'background 0.8s ease',
        pointerEvents: 'none',
        zIndex: 1,
      }} />

      {children}
    </div>
  )
}
