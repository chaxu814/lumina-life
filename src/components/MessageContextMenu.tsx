// ============================================================
// MessageContextMenu.tsx — 消息气泡右键菜单 (v2.14)
//
// 功能: 复制 / 重新输入 / 收藏 / 删除
// ============================================================

import React, { useState, useEffect, useRef } from 'react'

export interface MessageMenuAction {
  id: string
  label: string
  icon: string
  color?: string
  danger?: boolean
}

const ACTIONS: MessageMenuAction[] = [
  { id: 'copy',   label: '复制',     icon: '📋' },
  { id: 'resend', label: '重新输入', icon: '↩️' },
  { id: 'bookmark', label: '收藏',   icon: '⭐', color: '#f59e0b' },
  { id: 'delete', label: '删除',     icon: '🗑️', danger: true },
]

export interface MessageContextMenuProps {
  x: number
  y: number
  visible: boolean
  messageContent: string
  onCopy: () => void
  onResend: () => void
  onBookmark: () => void
  onDelete: () => void
  onClose: () => void
}

const MessageContextMenu: React.FC<MessageContextMenuProps> = ({
  x, y, visible, messageContent,
  onCopy, onResend, onBookmark, onDelete, onClose,
}) => {
  const menuRef = useRef<HTMLDivElement>(null)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({})

  useEffect(() => {
    if (!visible) {
      setShowDeleteConfirm(false)
      return
    }

    // 计算菜单位置，防止溢出视口
    const menuW = 180, menuH = showDeleteConfirm ? 130 : 165
    const vw = window.innerWidth, vh = window.innerHeight
    setMenuStyle({
      position: 'fixed',
      left: x + menuW > vw ? x - menuW : x,
      top: y + menuH > vh ? y - menuH : y,
      zIndex: 1000,
    })

    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    // 延迟绑定避免触发自身的 click 立刻关闭
    const t = setTimeout(() => document.addEventListener('click', handler), 0)
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', k)
    return () => {
      clearTimeout(t)
      document.removeEventListener('click', handler)
      document.removeEventListener('keydown', k)
    }
  }, [visible, x, y, showDeleteConfirm, onClose])

  if (!visible) return null

  const handleAction = (actionId: string) => {
    switch (actionId) {
      case 'copy': onCopy(); onClose(); break
      case 'resend': onResend(); onClose(); break
      case 'bookmark': onBookmark(); onClose(); break
      case 'delete': setShowDeleteConfirm(true); break
    }
  }

  const handleConfirmDelete = () => {
    onDelete()
    onClose()
  }

  return (
    <div ref={menuRef} style={menuStyle}>
      <div style={{
        background: 'var(--surface-0)',
        borderRadius: 12,
        boxShadow: '0 8px 32px rgba(0,0,0,0.14), 0 2px 8px rgba(0,0,0,0.08)',
        border: '1px solid var(--border-light)',
        padding: 6,
        minWidth: 170,
        overflow: 'hidden',
      }}>
        {!showDeleteConfirm ? (
          <>
            <div style={{
              padding: '4px 10px 6px', fontSize: 11, color: 'var(--text-secondary)',
              borderBottom: '1px solid var(--border-light)', marginBottom: 2,
            }}>
              消息操作
            </div>
            {ACTIONS.map(action => (
              <button
                key={action.id}
                onClick={() => handleAction(action.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  width: '100%', padding: '8px 10px', borderRadius: 6,
                  border: 'none', background: 'transparent',
                  cursor: 'pointer', fontSize: 13,
                  color: action.danger ? '#ef4444' : '#374151',
                  transition: 'background 0.1s',
                  fontFamily: 'inherit', textAlign: 'left',
                }}
                onMouseEnter={e => {
                  (e.currentTarget as HTMLElement).style.background = action.danger ? '#fef2f2' : '#f3f4f6'
                }}
                onMouseLeave={e => {
                  (e.currentTarget as HTMLElement).style.background = 'transparent'
                }}
              >
                <span style={{ fontSize: 15, width: 20, textAlign: 'center' }}>{action.icon}</span>
                <span>{action.label}</span>
              </button>
            ))}
          </>
        ) : (
          <div style={{ padding: '8px 10px' }}>
            <div style={{ fontSize: 13, marginBottom: 8, color: 'var(--text-primary)' }}>
              ⚠️ 确定要删除这条消息吗？
            </div>
            <div style={{
              padding: '6px 10px', borderRadius: 6, background: 'var(--surface-100)',
              fontSize: 12, color: 'var(--text-secondary)', maxHeight: 60, overflow: 'hidden',
              marginBottom: 8, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
            }}>
              {messageContent.slice(0, 150)}{messageContent.length > 150 ? '...' : ''}
            </div>
            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setShowDeleteConfirm(false)}
                style={{
                  padding: '5px 12px', borderRadius: 6, border: '1px solid var(--border-light)',
                  background: 'var(--surface-0)', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 12,
                  fontFamily: 'inherit',
                }}
              >
                取消
              </button>
              <button
                onClick={handleConfirmDelete}
                style={{
                  padding: '5px 12px', borderRadius: 6, border: 'none',
                  background: '#ef4444', color: '#fff', cursor: 'pointer', fontSize: 12,
                  fontFamily: 'inherit', fontWeight: 600,
                }}
              >
                确认删除
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default MessageContextMenu
