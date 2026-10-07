// ============================================================
// components/PermissionSelector.tsx — 三档权限选择器 + 风险确认框
//
// 位置：发送栏下方（图 3 那一行）。
// 为什么在发送栏而不是「安全中心」里：
//   权限是**当下这件事**的决定，不是全局偏好。放在发消息的地方，
//   用户每次都知道「我现在给她的权限是什么」——这和图 1 的产品逻辑一致。
//
// 两处都是**真拦截**，不是装饰：
//   · 后端 reactEngine.checkPermission() 按档位放行/拦截（见 permission/）
//   · 切到「完全权限」必须勾选风险确认框才能生效，且**主进程会校验**，
//     绕过 UI 直接调 IPC 也会被 setTier() 拒掉
// ============================================================

import React, { useCallback, useEffect, useRef, useState } from 'react'

export type TierId = 'read_only' | 'workspace_write' | 'full'

interface TierMeta {
  label: string
  short: string
  desc: string
  color: string
}

interface PermSnapshot {
  tier: TierId
  workspaceRoot: string | null
  effectiveWorkspaceRoot: string
  fullAcknowledged: boolean
  needsAcknowledgement: boolean
  meta: Record<TierId, TierMeta>
  tiers: TierId[]
}

interface PermResponse extends PermSnapshot { ok: boolean }

const FALLBACK_META: Record<TierId, TierMeta> = {
  read_only: {
    label: '仅可查看', short: '👁 仅查看', color: '#64748b',
    desc: '只读不改。她可以看文件、读网页、回答问题，但不会写入或执行任何东西。',
  },
  workspace_write: {
    label: '工作区内修改', short: '📁 工作区内修改', color: '#2563eb',
    desc: '可以在工作目录内创建和修改文件；执行命令、操控鼠标、访问工作区外仍需你点头。',
  },
  full: {
    label: '完全权限', short: '⚡ 完全权限', color: '#dc2626',
    desc: '不再逐步确认，直接执行更多操作，包括敏感操作、文件修改与外部命令。仅建议在信任当前任务时使用。',
  },
}

const ORDER: TierId[] = ['read_only', 'workspace_write', 'full']

export function usePermission(): {
  perm: PermSnapshot | null
  setTier: (t: TierId, acknowledged?: boolean) => Promise<{ ok: boolean; error?: string }>
  reload: () => void
} {
  const [perm, setPerm] = useState<PermSnapshot | null>(null)

  const reload = useCallback(() => {
    const api = (window as unknown as { luminaAPI?: Record<string, unknown> }).luminaAPI
    ;(api?.permGet as (() => Promise<PermResponse>) | undefined)?.()
      .then((r) => { if (r && r.ok) { setPerm(r) } })
      .catch(() => { /* 主进程未就绪 */ })
  }, [])

  useEffect(() => {
    reload()
    const api = (window as unknown as { luminaAPI?: Record<string, unknown> }).luminaAPI
    const on = api?.permOnChanged as ((cb: () => void) => (() => void)) | undefined
    return on ? on(reload) : undefined
  }, [reload])

  const setTier = useCallback(async (t: TierId, acknowledged = false) => {
    const api = (window as unknown as { luminaAPI?: Record<string, unknown> }).luminaAPI
    const r = await (api?.permSetTier as ((t: TierId, a: boolean) => Promise<{ ok: boolean; error?: string }>) | undefined)?.(t, acknowledged)
    reload()
    return r ?? { ok: false, error: 'IPC 不可用' }
  }, [reload])

  return { perm, setTier, reload }
}

// ═══════════════════════════════════════════════════════════
// 图 2 的还原：启用完全权限的风险确认
// ═══════════════════════════════════════════════════════════

function FullPermissionDialog({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void
  onConfirm: () => void
}) {
  const [ack, setAck] = useState(false)

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="确认启用完全权限"
      style={{
        position: 'fixed', inset: 0, zIndex: 10000,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => { e.stopPropagation() }}
        style={{
          width: 420, maxWidth: '90vw', background: 'var(--bg-primary, #fff)',
          borderRadius: 12, padding: '20px 22px 18px', color: 'var(--text-primary, #111)',
          boxShadow: '0 18px 48px rgba(0,0,0,0.3)', border: '1px solid var(--border-light, #e5e7eb)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>确认启用完全权限？</div>
          <button onClick={onCancel} aria-label="关闭"
            style={{ background: 'none', border: 'none', fontSize: 17, cursor: 'pointer', color: 'var(--text-secondary, #666)', lineHeight: 1 }}>
            ✕
          </button>
        </div>

        <div style={{
          marginTop: 14, padding: 12, borderRadius: 8,
          background: 'var(--red-100, #fef2f2)', border: '1px solid var(--red-500, #ef4444)',
          color: 'var(--red-500, #ef4444)', fontSize: 12.5, lineHeight: 1.65,
          display: 'flex', gap: 9,
        }}>
          <span style={{ flexShrink: 0, fontWeight: 700 }}>ⓘ</span>
          <span>
            启用完全权限后，智能体将<b>减少确认步骤</b>，并且可以直接执行更多操作，
            包括<b>敏感操作</b>、<b>文件修改</b>或<b>外部命令</b>。仅建议在你信任当前任务时使用。
          </span>
        </div>

        <label style={{
          marginTop: 14, display: 'flex', gap: 9, alignItems: 'flex-start',
          fontSize: 12.5, cursor: 'pointer', lineHeight: 1.5, userSelect: 'none',
        }}>
          <input
            type="checkbox"
            checked={ack}
            onChange={(e) => { setAck(e.target.checked) }}
            style={{ marginTop: 2, width: 15, height: 15, cursor: 'pointer', flexShrink: 0 }}
          />
          <span>我已知晓风险，并愿意继续</span>
        </label>

        <div style={{ marginTop: 18, display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button
            onClick={onCancel}
            style={{
              padding: '7px 20px', borderRadius: 7, fontSize: 13, cursor: 'pointer',
              background: 'var(--surface-0, #fff)', color: 'var(--text-primary, #111)',
              border: '1px solid var(--border-light, #d1d5db)', minWidth: 78,
            }}
          >
            取消
          </button>
          <button
            disabled={!ack}
            onClick={onConfirm}
            style={{
              padding: '7px 20px', borderRadius: 7, fontSize: 13, fontWeight: 500, cursor: ack ? 'pointer' : 'not-allowed',
              background: ack ? '#6b7280' : '#9ca3af', color: '#fff', border: 'none', minWidth: 110,
            }}
          >
            启用完全权限
          </button>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// 图 1 的还原：三档下拉
// ═══════════════════════════════════════════════════════════

export default function PermissionSelector({
  perm,
  onChange,
}: {
  perm: PermSnapshot | null
  onChange: (t: TierId, acknowledged?: boolean) => Promise<{ ok: boolean; error?: string }>
}) {
  const [open, setOpen] = useState(false)
  const [showFullDialog, setShowFullDialog] = useState(false)
  const [err, setErr] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  const meta = perm?.meta ?? FALLBACK_META
  const current: TierId = perm?.tier ?? 'workspace_write'
  const cur = meta[current] ?? FALLBACK_META.workspace_write

  // 点击外部关闭
  useEffect(() => {
    if (!open) { return }
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) { setOpen(false) }
    }
    document.addEventListener('mousedown', onDoc)
    return () => { document.removeEventListener('mousedown', onDoc) }
  }, [open])

  const pick = async (t: TierId) => {
    setOpen(false)
    if (t === current) { return }
    if (t === 'full') {
      // 必须先过风险确认框；主进程也会再校验一次
      setShowFullDialog(true)
      return
    }
    setErr('')
    const r = await onChange(t)
    if (!r.ok) { setErr(r.error || '切换失败') }
  }

  const confirmFull = async () => {
    setShowFullDialog(false)
    setErr('')
    const r = await onChange('full', true)
    if (!r.ok) { setErr(r.error || '切换失败') }
  }

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <button
        onClick={() => { setOpen(!open); setErr('') }}
        title={cur.desc}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: '2px 9px', borderRadius: 6, fontSize: 11, fontFamily: 'inherit',
          border: `1px solid ${current === 'full' ? '#dc2626' : 'var(--border-light)'}`,
          background: current === 'full' ? 'var(--red-100)' : 'var(--surface-0)',
          color: current === 'full' ? '#dc2626' : 'var(--text-secondary)',
          cursor: 'pointer', whiteSpace: 'nowrap',
        }}
      >
        {cur.short}
        <span style={{ fontSize: 8, opacity: 0.7 }}>▾</span>
      </button>

      {err && (
        <span style={{ fontSize: 10, color: '#dc2626', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {err}
        </span>
      )}

      {open && (
        <div style={{
          position: 'absolute', bottom: '100%', left: 0, marginBottom: 4, zIndex: 10001,
          background: 'var(--bg-primary, #fff)', border: '1px solid var(--border-light, #e5e7eb)',
          borderRadius: 9, boxShadow: '0 10px 30px rgba(0,0,0,0.18)',
          padding: 5, minWidth: 300,
        }}>
          {ORDER.map((t) => {
            const m = meta[t] ?? FALLBACK_META[t]
            const active = t === current
            return (
              <button
                key={t}
                onClick={() => { void pick(t) }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                  padding: '7px 9px', borderRadius: 6, border: 'none', cursor: 'pointer',
                  background: active ? 'var(--accent-50)' : 'transparent',
                  color: 'var(--text-primary)', textAlign: 'left', fontFamily: 'inherit',
                }}
                onMouseEnter={(e) => { if (!active) { e.currentTarget.style.background = 'var(--surface-100)' } }}
                onMouseLeave={(e) => { if (!active) { e.currentTarget.style.background = 'transparent' } }}
              >
                <span style={{ fontSize: 13, width: 14, textAlign: 'center' }}>
                  {active ? '✓' : '○'}
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 12.5, fontWeight: active ? 600 : 400, display: 'block' }}>{m.label}</span>
                  <span style={{ fontSize: 10.5, color: 'var(--text-muted, #888)', display: 'block', lineHeight: 1.4, whiteSpace: 'normal' }}>
                    {m.desc}
                  </span>
                </span>
                {t === 'full' && (
                  <span style={{
                    fontSize: 9, fontWeight: 700, color: '#fff', background: '#dc2626',
                    borderRadius: 3, padding: '1px 5px', flexShrink: 0,
                  }}>高风险</span>
                )}
              </button>
            )
          })}
          {perm?.workspaceRoot && (
            <div style={{
              marginTop: 4, padding: '6px 9px', borderTop: '1px solid var(--border-light)',
              fontSize: 10, color: 'var(--text-muted, #888)', wordBreak: 'break-all',
            }}>
              📁 工作区：{perm.workspaceRoot}
            </div>
          )}
        </div>
      )}

      {showFullDialog && <FullPermissionDialog onCancel={() => { setShowFullDialog(false) }} onConfirm={() => { void confirmFull() }} />}
    </div>
  )
}
