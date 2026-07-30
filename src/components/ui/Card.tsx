// ============================================================
// ui/Card.tsx — shadcn/ui 风格卡片容器 (v2.0「换装」)
//
// 轻量容器，携带统一的背景/边框/圆角/阴影。
// 可选用 title/header 区域。
// ============================================================

import React from 'react'
import { clsx } from 'clsx'

export interface CardProps {
  children: React.ReactNode
  /** 卡片标题（可选）。提供后会自动渲染 header 行。 */
  title?: string
  /** 标题旁的说明/描述（仅在有 title 时显示） */
  desc?: string
  /** 额外 class */
  className?: string
  /** hover 时是否提升阴影 (默认 true) */
  hover?: boolean
  /** 内边距大小 (默认 md) */
  padding?: 'sm' | 'md' | 'lg'
  /** 自定义 header 右侧附加内容（仅在有 title 时显示） */
  extra?: React.ReactNode
  /** 点击事件 */
  onClick?: () => void
}

const paddingMap = {
  sm: 'p-3',
  md: 'p-4',
  lg: 'p-5',
}

/**
 * Card — 统一风格的卡片容器
 *
 * 用法：
 * ```tsx
 * <Card title="Agent LLM" desc="普通模式使用">
 *   <div>卡片内容</div>
 * </Card>
 *
 * <Card hover={false} padding="sm">
 *   简洁卡片，无标题，无 hover 效果
 * </Card>
 * ```
 */
export function Card({
  children,
  title,
  desc,
  className,
  hover = true,
  padding = 'md',
  extra,
  onClick,
}: CardProps) {
  const Comp = onClick ? 'button' : 'div'

  return (
    <Comp
      className={clsx(
        'bg-surface-0 border border-light rounded-lg shadow-xs',
        paddingMap[padding],
        hover && 'hover:shadow-md transition-shadow duration-200',
        onClick && 'cursor-pointer text-left w-full',
        className,
      )}
      onClick={onClick}
      {...(onClick ? { type: 'button' as const } : {})}
    >
      {/* 标题行（可选） */}
      {title && (
        <div
          className={clsx(
            'flex items-center justify-between gap-2',
            // 有 children 时加底部间距分离标题与内容
            React.Children.count(children) > 0 && 'mb-3',
          )}
        >
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-bold text-text-primary truncate">
              {title}
            </span>
            {desc && (
              <span className="text-2xs text-text-tertiary truncate hidden sm:inline">
                {desc}
              </span>
            )}
          </div>
          {extra && (
            <div className="flex-shrink-0">{extra}</div>
          )}
        </div>
      )}

      {/* 无标题但只有 desc 时，单独渲染 desc */}
      {!title && desc && (
        <div className="mb-3">
          <span className="text-xs text-text-tertiary">{desc}</span>
        </div>
      )}

      {/* 内容区域 */}
      {children}
    </Comp>
  )
}
