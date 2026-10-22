// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// components/LoopToast.tsx — Loop 完成 Toast 通知（Phase 4）
//
// 轻量浮窗：Loop 每轮完成后从屏幕底部弹出，5 秒后自动消失。
// 点击「查看」可展开详情，点击 ✕ 立即关闭。
// ============================================================

import React, { useEffect, useState, useCallback } from 'react'
import { useLoopStore, type LoopToast } from '../stores/loopStore'

export default function LoopToast() {
  const pendingToasts = useLoopStore(s => s.pendingToasts)
  const dismissToast = useLoopStore(s => s.dismissToast)
  const [visible, setVisible] = useState<LoopToast | null>(null)
  const [exiting, setExiting] = useState(false)

  // 取队列第一个展示
  useEffect(() => {
    if (pendingToasts.length > 0 && !visible) {
      const next = pendingToasts[0]
      setVisible(next)
      setExiting(false)
    }
  }, [pendingToasts, visible])

  // 5 秒自动消失
  useEffect(() => {
    if (!visible) {return}
    const timer = setTimeout(() => handleClose(), 8000)
    return () => clearTimeout(timer)
  }, [visible])

  const handleClose = useCallback(() => {
    if (!visible) {return}
    setExiting(true)
    setTimeout(() => {
      dismissToast(visible.id)
      setVisible(null)
      setExiting(false)
    }, 300) // 动画时间
  }, [visible, dismissToast])

  if (!visible) {return null}

  const elapsed = Math.round((Date.now() - visible.createdAt) / 1000)
  const elapsedStr = elapsed < 60 ? `${elapsed}s 前` : `${Math.round(elapsed / 60)}m 前`

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 20,
        right: 20,
        zIndex: 9999,
        maxWidth: 380,
        background: 'var(--surface-0, #fff)',
        border: '1px solid var(--border-light, #e5e7eb)',
        borderRadius: 12,
        padding: '12px 16px',
        boxShadow: '0 8px 32px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.06)',
        opacity: exiting ? 0 : 1,
        transform: exiting ? 'translateY(20px) scale(0.95)' : 'translateY(0) scale(1)',
        transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
        cursor: 'default',
      }}
      onMouseEnter={() => { /* 悬停暂停自动关闭 */ }}
    >
      {/* 头部 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 20 }}>🔁</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 13, fontWeight: 700, color: 'var(--text-primary, #111827)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {visible.goal}
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-secondary, #6b7280)' }}>
            第 {visible.runCount} 轮完成 · {elapsedStr}
          </div>
        </div>
        <button
          onClick={handleClose}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            fontSize: 14, color: 'var(--text-secondary, #9ca3af)',
            padding: 2, lineHeight: 1,
          }}
          title="关闭"
        >✕</button>
      </div>

      {/* 产出摘要 */}
      <div style={{
        fontSize: 11, color: 'var(--text-secondary, #6b7280)',
        lineHeight: 1.5, marginBottom: 8,
        maxHeight: 48, overflow: 'hidden',
      }}>
        📋 {visible.summary}…
      </div>

      {/* 操作按钮 */}
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={() => {
            // 切换到 Loop 视图（由 AgentTaskBoard 处理）
            // 这里通过事件通知：未来可加 router.navigate
            handleClose()
          }}
          style={{
            flex: 1, padding: '5px 0', borderRadius: 6, fontSize: 11, fontWeight: 600,
            background: '#eef2ff', color: '#4f46e5', border: '1px solid #c7d2fe',
            cursor: 'pointer', transition: 'background 0.15s',
          }}
        >
          👁 查看详情
        </button>
        <button
          onClick={handleClose}
          style={{
            padding: '5px 12px', borderRadius: 6, fontSize: 11,
            background: 'var(--surface-50, #f9fafb)', color: 'var(--text-secondary, #6b7280)',
            border: '1px solid var(--border-light, #e5e7eb)',
            cursor: 'pointer',
          }}
        >
          稍后
        </button>
      </div>
    </div>
  )
}
