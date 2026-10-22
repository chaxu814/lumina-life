// ============================================================
// components/SearchModeBadge.tsx — 搜索结果模式小标签
//
// 搜索工具（web_search / web_search_multi）的结果在离线兜底或别名重定向
// 时，主进程会在结果对象上带 mode 字段（'offline' | 'alias'）。
// 用户应当一眼看出「这次搜索不是真联网搜的」，而不是拿着一堆看起来
// 正常、实则来自本地缓存/别名解析的结果当真。
// ============================================================

import React from 'react'
import { useTranslation } from 'react-i18next'

export type SearchMode = 'offline' | 'alias'

/** 从工具结果里抽取 mode 字段（容忍 result 是对象或 JSON 字符串） */
export function extractSearchMode(result: unknown): SearchMode | null {
  if (result === null || result === undefined) {return null}
  let obj: unknown = result
  if (typeof result === 'string') {
    try {obj = JSON.parse(result)} catch {return null}
  }
  if (typeof obj !== 'object' || obj === null) {return null}
  // 动态结果对象：仅收窄出需要的 mode 字段，值逐个比对
  const mode = (obj as { mode?: unknown }).mode
  if (mode === 'offline' || mode === 'alias') {return mode}
  return null
}

/** 工具名是否属于搜索类 */
export function isSearchTool(name: string): boolean {
  return /web_?search/i.test(name) || /^search$/i.test(name)
}

export default function SearchModeBadge({ mode }: { mode: SearchMode }) {
  const { t } = useTranslation()
  return (
    <span
      style={{
        display: 'inline-block',
        marginLeft: 6,
        padding: '1px 7px',
        borderRadius: 8,
        fontSize: 10,
        fontWeight: 600,
        whiteSpace: 'nowrap',
        background: mode === 'offline' ? 'var(--yellow-100)' : 'var(--accent-100)',
        color: mode === 'offline' ? '#854d0e' : 'var(--accent-600)',
        border: `1px solid ${mode === 'offline' ? 'var(--yellow-300)' : 'var(--accent-200)'}`,
      }}
      title={t('search.mode_title', { mode: t(`search.mode_${mode}`) })}
    >
      {mode === 'offline' ? '📴 ' : '↪️ '}{t(`search.mode_${mode}`)}
    </span>
  )
}
