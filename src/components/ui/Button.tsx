// ============================================================
// ui/Button.tsx — shadcn/ui 风格按钮 (v2.0「换装」)
// ============================================================

import React from 'react'
import { clsx } from 'clsx'

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'ghost' | 'outline' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  loading?: boolean
}

const variantClasses: Record<string, string> = {
  default: 'bg-surface-100 text-text-primary hover:bg-surface-200 active:bg-surface-300',
  primary: 'bg-accent-500 text-white hover:bg-accent-600 active:bg-accent-700',
  ghost: 'bg-transparent text-text-secondary hover:bg-surface-100 active:bg-surface-200',
  outline: 'bg-transparent text-text-primary border border-light hover:bg-surface-50 active:bg-surface-100',
  danger: 'bg-red-500 text-white hover:bg-red-600 active:bg-red-700',
}

const sizeClasses: Record<string, string> = {
  sm: 'px-2 py-1 text-xs rounded-md gap-1',
  md: 'px-3 py-1.5 text-sm rounded-md gap-1.5',
  lg: 'px-4 py-2 text-base rounded-lg gap-2',
}

export function Button({
  variant = 'default',
  size = 'md',
  loading = false,
  className,
  disabled,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      className={clsx(
        'inline-flex items-center justify-center font-medium cursor-pointer border-none transition-all duration-200 select-none',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        variantClasses[variant],
        sizeClasses[size],
        className,
      )}
      disabled={disabled || loading}
      {...props}
    >
      {loading && <span className="inline-block w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />}
      {children}
    </button>
  )
}
