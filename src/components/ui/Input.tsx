// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// ui/Input.tsx — shadcn/ui 风格输入框 (v2.0「换装」)
// ============================================================

import React from 'react'
import { clsx } from 'clsx'

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string
  hint?: string
}

export function Input({ label, hint, className, id, ...props }: InputProps) {
  const inputId = id || label?.replace(/\s+/g, '-').toLowerCase()

  return (
    <div className="flex flex-col gap-1">
      {label && (
        <label htmlFor={inputId} className="text-xs font-medium text-text-secondary">
          {label}
        </label>
      )}
      <input
        id={inputId}
        className={clsx(
          'w-full px-2.5 py-1.5 text-sm rounded-md border border-light bg-surface-0 text-text-primary',
          'placeholder:text-text-tertiary',
          'focus:outline-none focus:border-accent-500 focus:ring-1 focus:ring-accent-500/30',
          'transition-all duration-200',
          className,
        )}
        {...props}
      />
      {hint && <span className="text-2xs text-text-tertiary">{hint}</span>}
    </div>
  )
}
