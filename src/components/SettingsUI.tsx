import React from 'react'

/* ═══════════════════════════════════════════════
 * 设置面板共用 UI 组件
 * 目标：统一的卡片/行/控件风格，类似 LobsterAI
 * ═══════════════════════════════════════════════ */

/* ── 分组卡片容器 ── */
export function SettingSection({
  title,
  desc,
  children,
  badge,
}: {
  title: string
  desc?: string
  children: React.ReactNode
  badge?: string
}) {
  return (
    <div
      style={{
        borderRadius: 10,
        border: '1px solid var(--border-light)',
        padding: '18px 20px',
        marginBottom: 16,
        background: 'var(--surface-0)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: desc ? 4 : 14,
        }}
      >
        <span
          style={{
            fontSize: 14,
            fontWeight: 700,
            color: 'var(--text-primary)',
            fontFamily: '"Microsoft YaHei", "微软雅黑", sans-serif',
          }}
        >
          {title}
        </span>
        {badge && (
          <span
            style={{
              fontSize: 10,
              fontWeight: 600,
              padding: '1px 8px',
              borderRadius: 10,
              background: 'var(--green-100)',
              color: '#065f46',
            }}
          >
            {badge}
          </span>
        )}
      </div>
      {desc && (
        <div
          style={{
            fontSize: 11,
            color: 'var(--text-secondary)',
            marginBottom: 14,
            lineHeight: 1.5,
            fontFamily: '"Microsoft YaHei", "微软雅黑", sans-serif',
          }}
        >
          {desc}
        </div>
      )}
      {children}
    </div>
  )
}

/* ── 单行设置项：标签在左，控制在右 ── */
export function SettingRow({
  label,
  desc,
  children,
  indent,
}: {
  label: string
  desc?: string
  children: React.ReactNode
  indent?: boolean
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: desc ? 'flex-start' : 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '8px 0',
        borderBottom: '1px solid var(--border-light)',
        marginLeft: indent ? 16 : 0,
      }}
    >
      <div style={{ flex: '1 1 auto', minWidth: 0 }}>
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--text-primary)',
            fontFamily: '"Microsoft YaHei", "微软雅黑", sans-serif',
          }}
        >
          {label}
        </div>
        {desc && (
          <div
            style={{
              fontSize: 10,
              color: 'var(--text-secondary)',
              marginTop: 2,
              lineHeight: 1.4,
              fontFamily: '"Microsoft YaHei", "微软雅黑", sans-serif',
            }}
          >
            {desc}
          </div>
        )}
      </div>
      <div
        style={{
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        {children}
      </div>
    </div>
  )
}

/* ── 最后一行无边框 ── */
export function SettingRowLast({
  label,
  desc,
  children,
}: {
  label: string
  desc?: string
  children: React.ReactNode
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: desc ? 'flex-start' : 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '8px 0',
        marginLeft: 0,
      }}
    >
      <div style={{ flex: '1 1 auto', minWidth: 0 }}>
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--text-primary)',
            fontFamily: '"Microsoft YaHei", "微软雅黑", sans-serif',
          }}
        >
          {label}
        </div>
        {desc && (
          <div
            style={{
              fontSize: 10,
              color: 'var(--text-secondary)',
              marginTop: 2,
              lineHeight: 1.4,
              fontFamily: '"Microsoft YaHei", "微软雅黑", sans-serif',
            }}
          >
            {desc}
          </div>
        )}
      </div>
      <div
        style={{
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        {children}
      </div>
    </div>
  )
}

/* ── Toggle 开关 ── */
export function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <button
      onClick={() => !disabled && onChange(!checked)}
      style={{
        width: 40,
        height: 22,
        borderRadius: 11,
        border: 'none',
        background: checked ? 'var(--accent-500)' : 'var(--border-light)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        position: 'relative',
        transition: 'background 0.2s',
        padding: 0,
        flexShrink: 0,
      }}
      disabled={disabled}
      role="switch"
      aria-checked={checked}
    >
      <span
        style={{
          position: 'absolute',
          top: 2,
          left: checked ? 20 : 2,
          width: 18,
          height: 18,
          borderRadius: '50%',
          background: '#fff',
          boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
          transition: 'left 0.2s',
        }}
      />
    </button>
  )
}

/* ── 设置输入框 ── */
export function SettingInput({
  value,
  onChange,
  placeholder,
  type,
  monospace,
  style,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  type?: string
  monospace?: boolean
  style?: React.CSSProperties
}) {
  return (
    <input
      type={type || 'text'}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      style={{
        padding: '6px 10px',
        borderRadius: 6,
        fontSize: 'var(--font-size-xs)',
        border: '1.5px solid var(--border-light)',
        outline: 'none',
        background: 'var(--surface-0)',
        color: 'var(--text-primary)',
        // 仅代码/路径类输入用等宽，其余一律微软雅黑
        fontFamily: monospace ? 'var(--font-mono)' : 'var(--font-sans)',
        boxSizing: 'border-box',
        width: '100%',
        transition: 'border-color 0.15s',
        ...style,
      }}
      onFocus={(e) => {
        e.currentTarget.style.borderColor = 'var(--accent-500)'
      }}
      onBlur={(e) => {
        e.currentTarget.style.borderColor = 'var(--border-light)'
      }}
    />
  )
}

/* ── 设置按钮 ── */
export function SettingBtn({
  children,
  onClick,
  variant,
  disabled,
  loading,
  style,
}: {
  children: React.ReactNode
  onClick?: () => void
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost' | 'success'
  disabled?: boolean
  loading?: boolean
  style?: React.CSSProperties
}) {
  const colors: Record<string, { bg: string; hover: string; color: string; border?: string }> = {
    primary: { bg: 'var(--accent-500)', hover: 'var(--accent-600)', color: '#fff' },
    secondary: {
      bg: 'var(--surface-0)',
      hover: 'var(--surface-100)',
      color: 'var(--text-secondary)',
      border: '1px solid var(--border-light)',
    },
    danger: { bg: '#ef444420', hover: '#ef444430', color: '#dc2626' },
    ghost: { bg: 'transparent', hover: 'var(--surface-100)', color: 'var(--text-secondary)' },
    success: { bg: '#10b981', hover: '#059669', color: '#fff' },
  }
  const c = colors[variant || 'secondary']
  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      style={{
        padding: '5px 12px',
        borderRadius: 6,
        fontSize: 11,
        fontWeight: 600,
        border: c.border || 'none',
        background: c.bg,
        color: c.color,
        cursor: disabled ? 'not-allowed' : 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        opacity: disabled ? 0.5 : 1,
        transition: 'all 0.12s',
        fontFamily: '"Microsoft YaHei", "微软雅黑", sans-serif',
        ...style,
      }}
      onMouseEnter={(e) => {
        if (!disabled) {e.currentTarget.style.background = c.hover}
      }}
      onMouseLeave={(e) => {
        if (!disabled) {e.currentTarget.style.background = c.bg}
      }}
    >
      {loading ? (
        <span
          style={{
            width: 12,
            height: 12,
            borderRadius: '50%',
            border: '2px solid currentColor',
            borderTopColor: 'transparent',
            animation: 'spin 0.6s linear infinite',
            display: 'inline-block',
          }}
        />
      ) : null}
      {children}
    </button>
  )
}

/* ── 分隔线 ── */
export function SettingDivider() {
  return (
    <div
      style={{
        height: 1,
        background: 'var(--border-light)',
        margin: '12px 0',
      }}
    />
  )
}

/* ── 标签选择器（按钮组） ── */
export function ButtonGroup<T extends string>({
  options,
  value,
  onChange,
  size,
}: {
  options: { id: T; label: string; icon?: string }[]
  value: T
  onChange: (id: T) => void
  size?: 'sm' | 'md'
}) {
  const s = size === 'sm' ? { py: '4px 10px', fs: 10 } : { py: '6px 14px', fs: 11 }
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      {options.map((opt) => {
        const active = value === opt.id
        return (
          <button
            key={opt.id}
            onClick={() => onChange(opt.id)}
            style={{
              padding: s.py,
              borderRadius: 6,
              fontSize: s.fs,
              fontWeight: active ? 600 : 400,
              border: `1.5px solid ${active ? 'var(--accent-500)' : 'var(--border-light)'}`,
              background: active ? 'var(--accent-50)' : 'var(--surface-0)',
              color: active ? 'var(--accent-600)' : 'var(--text-secondary)',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              transition: 'all 0.12s',
              fontFamily: '"Microsoft YaHei", "微软雅黑", sans-serif',
            }}
          >
            {active && <span style={{ fontSize: 8, color: 'var(--accent-500)' }}>●</span>}
            {opt.icon && <span>{opt.icon}</span>}
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

/* ── 状态徽章 ── */
export function StatusBadge({
  status,
  label,
}: {
  status: 'running' | 'stopped' | 'ok' | 'error' | 'warning'
  label: string
}) {
  const colors: Record<string, { bg: string; color: string; dot: string }> = {
    running: { bg: 'var(--green-100)', color: '#065f46', dot: '#10b981' },
    stopped: { bg: 'var(--red-100)', color: '#991b1b', dot: '#ef4444' },
    ok: { bg: 'var(--green-100)', color: '#065f46', dot: '#10b981' },
    error: { bg: 'var(--red-100)', color: '#991b1b', dot: '#ef4444' },
    warning: { bg: '#fef3c7', color: '#92400e', dot: '#f59e0b' },
  }
  const c = colors[status] || colors.stopped
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '2px 10px',
        borderRadius: 12,
        fontSize: 10,
        fontWeight: 600,
        background: c.bg,
        color: c.color,
        fontFamily: '"Microsoft YaHei", "微软雅黑", sans-serif',
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: c.dot,
        }}
      />
      {label}
    </span>
  )
}
