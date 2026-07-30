// ============================================================
// Toast.tsx — 轻量提示组件 (v2.14)
// ============================================================
import React, { useEffect, useState, useCallback } from 'react'

export interface ToastItem { id: number; message: string; type?: 'success' | 'error' | 'info' | 'warning' }

let _addToast: ((msg: string, type?: 'success' | 'error' | 'info' | 'warning') => void) | null = null
let _id = 0

/** 外部调用：弹出提示 */
export function showToast(message: string, type?: 'success' | 'error' | 'info' | 'warning') {
  _addToast?.(message, type)
}

export default function Toast() {
  const [toasts, setToasts] = useState<ToastItem[]>([])

  const addToast = useCallback((message: string, type: 'success' | 'error' | 'info' | 'warning' = 'info') => {
    const id = ++_id
    setToasts(prev => [...prev, { id, message, type }])
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id))
    }, 2500)
  }, [])

  useEffect(() => {
    _addToast = addToast
    return () => { _addToast = null }
  }, [addToast])

  if (toasts.length === 0) return null

  return (
    <div style={{
      position: 'fixed', bottom: 80, left: '50%', transform: 'translateX(-50%)',
      zIndex: 99999, display: 'flex', flexDirection: 'column', gap: 6,
      pointerEvents: 'none',
    }}>
      {toasts.map(t => (
        <div key={t.id} style={{
          padding: '8px 20px', borderRadius: 10, fontSize: 13, fontWeight: 500,
          background: t.type === 'success' ? '#10b981' : t.type === 'error' ? '#ef4444' : '#6366f1',
          color: '#fff', boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
          animation: 'toastIn 0.3s ease',
          whiteSpace: 'nowrap',
        }}>{t.message}</div>
      ))}
      <style>{`
        @keyframes toastIn {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// Confirm 对话框
// ═══════════════════════════════════════════════════════════

interface ConfirmProps {
  visible: boolean
  title: string
  message: string
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({ visible, title, message, onConfirm, onCancel }: ConfirmProps) {
  if (!visible) return null

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 100000,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.3)',
    }} onClick={onCancel}>
      <div style={{
        background: 'var(--surface-0)', borderRadius: 14, padding: 24,
        minWidth: 280, maxWidth: 360,
        boxShadow: '0 8px 30px rgba(0,0,0,0.15)',
      }} onClick={e => e.stopPropagation()}>
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8, color: 'var(--text-primary)' }}>{title}</div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 20, lineHeight: 1.5 }}>{message}</div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={{
            padding: '7px 16px', borderRadius: 8, border: '1px solid var(--border-light)',
            background: 'var(--surface-100)', cursor: 'pointer', fontSize: 13, color: 'var(--text-secondary)',
          }}>取消</button>
          <button onClick={onConfirm} style={{
            padding: '7px 16px', borderRadius: 8, border: 'none',
            background: '#ef4444', cursor: 'pointer', fontSize: 13, fontWeight: 600,
            color: '#fff',
          }}>确认删除</button>
        </div>
      </div>
    </div>
  )
}
