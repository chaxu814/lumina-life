// ============================================================
// ui/Switch.tsx — shadcn/ui 风格开关 (v2.0「换装」)
// ============================================================

import React from 'react'
import { clsx } from 'clsx'

export interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  label?: string
  size?: 'sm' | 'md'
}

export function Switch({ checked, onChange, disabled, label, size = 'md' }: SwitchProps) {
  const h = size === 'sm' ? 'h-4 w-7' : 'h-5 w-9'
  const dot = size === 'sm' ? 'h-3 w-3' : 'h-4 w-4'
  const translateX = size === 'sm' ? 'translate-x-3' : 'translate-x-4'

  return (
    <label className={clsx('inline-flex items-center gap-2 cursor-pointer', disabled && 'opacity-50 cursor-not-allowed')}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className={clsx(
          'relative inline-flex items-center rounded-full border-none transition-colors duration-200',
          h,
          checked ? 'bg-accent-500' : 'bg-surface-300',
        )}
      >
        <span
          className={clsx(
            'inline-block bg-white rounded-full shadow-sm transform transition-transform duration-200',
            dot,
            checked && translateX,
            !checked && 'translate-x-0.5',
          )}
        />
      </button>
      {label && <span className="text-sm text-text-secondary select-none">{label}</span>}
    </label>
  )
}
