// ============================================================
// PersonalityConflictAlert.tsx — 副人格觉醒弹幕组件 v1.0
//
// 当人格冲突发生时，在聊天窗口显示一段"抢麦"动画
// ============================================================

import React, { useEffect, useState } from 'react'

export interface ConflictEvent {
  id: string
  currentMode: string
  challengerMode: string
  reason: string
  challengerLine: string
  currentLine: string
  intensity: number
  timestamp: number
}

// 人格配置（用于显示）
const MODE_META: Record<string, { name: string; icon: string; color: string }> = {
  chat: { name: 'Lumina', icon: '🐱', color: '#FF6B6B' },
  code: { name: '工作助手', icon: '💼', color: '#448AFF' },
  analyze: { name: 'Yak', icon: '📊', color: '#43A047' },
  creative: { name: '创意助手', icon: '🎨', color: '#AB47BC' },
}

interface Props {
  conflict: ConflictEvent | null
  onDismiss: () => void
}

export default function PersonalityConflictAlert({ conflict, onDismiss }: Props) {
  const [visible, setVisible] = useState(false)
  const [animPhase, setAnimPhase] = useState<'enter' | 'show' | 'exit'>('enter')

  useEffect(() => {
    if (!conflict) {
      setVisible(false)
      return
    }

    setVisible(true)
    setAnimPhase('enter')

    // 进入动画
    const enterTimer = setTimeout(() => setAnimPhase('show'), 50)
    // 显示时间
    const showTimer = setTimeout(() => {
      setAnimPhase('exit')
      setTimeout(() => {
        setVisible(false)
        onDismiss()
      }, 500)
    }, 5000)

    return () => {
      clearTimeout(enterTimer)
      clearTimeout(showTimer)
    }
  }, [conflict])

  if (!visible || !conflict) return null

  const challenger = MODE_META[conflict.challengerMode] || { name: conflict.challengerMode, icon: '❓', color: '#888' }
  const current = MODE_META[conflict.currentMode] || { name: conflict.currentMode, icon: '❓', color: '#888' }

  const opacity = animPhase === 'enter' ? 0 : animPhase === 'exit' ? 0 : 1
  const translateY = animPhase === 'enter' ? -20 : 0

  return (
    <div style={{
      position: 'fixed', top: 80, left: '50%', transform: 'translateX(-50%)',
      zIndex: 9999, opacity, transition: 'all 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)',
      translate: `0 ${translateY}px`,
      pointerEvents: 'none',
    }}>
      <div style={{
        background: 'linear-gradient(135deg, #1e1e2e, #2d2d44)',
        border: `2px solid ${challenger.color}`,
        borderRadius: 16, padding: '16px 24px',
        boxShadow: `0 8px 32px ${challenger.color}33`,
        maxWidth: 420,
        backdropFilter: 'blur(12px)',
      }}>
        {/* 冲突标题 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 28, height: 28, borderRadius: '50%',
            background: challenger.color + '22',
            fontSize: 16,
          }}>{challenger.icon}</span>
          <span style={{ color: challenger.color, fontWeight: 700, fontSize: 13 }}>
            {challenger.name} 抢麦！
          </span>
          <span style={{ fontSize: 10, color: '#888', marginLeft: 'auto' }}>
            ⚡ 冲突等级 {Math.round(conflict.intensity * 100)}%
          </span>
        </div>

        {/* 挑战者台词 */}
        <div style={{
          background: challenger.color + '15',
          borderRadius: 10, padding: '10px 14px', marginBottom: 6,
          borderLeft: `3px solid ${challenger.color}`,
        }}>
          <span style={{ color: challenger.color, fontSize: 11, fontWeight: 600 }}>{challenger.icon} 说：</span>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#e0e0e0', lineHeight: 1.5 }}>
            {conflict.challengerLine}
          </p>
        </div>

        {/* 当前人格回应 */}
        <div style={{
          background: current.color + '15',
          borderRadius: 10, padding: '10px 14px',
          borderLeft: `3px solid ${current.color}`,
        }}>
          <span style={{ color: current.color, fontSize: 11, fontWeight: 600 }}>{current.icon} 回应：</span>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#ccc', lineHeight: 1.5, fontStyle: 'italic' }}>
            {conflict.currentLine}
          </p>
        </div>
      </div>
    </div>
  )
}
