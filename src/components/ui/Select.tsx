// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// ui/Select.tsx — shadcn/ui 风格下拉选择器 (v2.0「换装」)
//
// 包裹原生 <select>，支持一致的标签/提示/占位样式。
// 配合 global.css 的 [data-theme="dark"] 覆盖，暗色主题自动生效。
// ============================================================

import React from 'react'
import { clsx } from 'clsx'

export interface SelectOption {
  value: string
  label: string
}

export interface SelectProps {
  options: SelectOption[]
  value: string
  onChange: (value: string) => void
  label?: string
  placeholder?: string
  hint?: string
  disabled?: boolean
  className?: string
}

/**
 * Select — 统一风格的下拉选择器
 *
 * 用法：
 * ```tsx
 * <Select
 *   label="音色"
 *   options={VOICES}
 *   value={voice}
 *   onChange={v => setVoice(v)}
 *   hint="选择 TTS 朗读音色"
 * />
 * ```
 */
export function Select({
  options,
  value,
  onChange,
  label,
  placeholder,
  hint,
  disabled,
  className,
}: SelectProps) {
  const selectId = label ? label.replace(/\s+/g, '-').toLowerCase() : undefined

  return (
    <div className={clsx('flex flex-col gap-1', className)}>
      {label && (
        <label
          htmlFor={selectId}
          className="text-xs font-medium text-text-secondary"
        >
          {label}
        </label>
      )}

      <div className="relative">
        {/* 原生 select */}
        <select
          id={selectId}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className={clsx(
            'w-full appearance-none px-2.5 py-1.5 pr-8 text-sm rounded-md',
            'border border-light bg-surface-0 text-text-primary',
            'focus:outline-none focus:border-accent-500 focus:ring-1 focus:ring-accent-500/30',
            'disabled:opacity-50 disabled:cursor-not-allowed',
            'transition-all duration-200',
            !value && placeholder ? 'text-text-tertiary' : 'text-text-primary',
          )}
        >
          {/* 占位选项 */}
          {placeholder && (
            <option value="" disabled>
              {placeholder}
            </option>
          )}

          {/* 选项列表 */}
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>

        {/* 自定义下拉箭头 */}
        <span
          className={clsx(
            'absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none',
            'text-text-tertiary text-xs',
            'transition-colors duration-200',
          )}
          aria-hidden="true"
        >
          <svg
            width="10"
            height="6"
            viewBox="0 0 10 6"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className="inline-block"
          >
            <path
              d="M1 1l4 4 4-4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </div>

      {hint && (
        <span className="text-2xs text-text-tertiary">{hint}</span>
      )}
    </div>
  )
}
