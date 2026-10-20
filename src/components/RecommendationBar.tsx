// ============================================================
// components/RecommendationBar.tsx — 输入栏上方的「为你推荐」
//
// 2026-10-20：替代原来写死的三个快捷气泡（用户评价「太死板」）。
// 有真实资讯就展示资讯（标题 + 来源，点一条让 Lumina 去读）；
// 没有（离线/采集失败）就回落到动态快捷指令，保证这一栏不空着。
//
// 只负责展示与回调，数据来自 useNewsRecommendations，样式在 composer.css。
// ============================================================

import React from 'react'
import type { RecommendationItem } from '../hooks/useNewsRecommendations'

export interface RecommendationBarProps {
  items: RecommendationItem[]
  loading: boolean
  onReload: (force?: boolean) => void
  /** 点一条资讯 */
  onPickNews: (item: RecommendationItem) => void
  /** 点一条回落提示词（无资讯时） */
  onPickPrompt: (text: string) => void
  /** 无资讯时的回落提示词 */
  fallbackPrompts?: string[]
}

export default function RecommendationBar(props: RecommendationBarProps) {
  const { items, loading, onReload, onPickNews, onPickPrompt, fallbackPrompts = [] } = props

  return (
    <div className="cc-recs">
      <div className="cc-recs-head">
        <span>为你推荐</span>
        <button type="button" className="cc-recs-refresh" title="换一批"
          disabled={loading}
          onClick={() => onReload(true)}>↻</button>
      </div>
      {loading && items.length === 0 ? (
        <div className="cc-recs-skel">正在收集最近的资讯…</div>
      ) : items.length > 0 ? (
        <div className="cc-recs-list">
          {items.map((rec, i) => (
            <button type="button" className="cc-rec" key={`${rec.title}-${i}`}
              title={rec.title} onClick={() => onPickNews(rec)}>
              <span className="cc-rec-title">{rec.title}</span>
              {rec.source && <span className="cc-rec-src">{rec.source}</span>}
            </button>
          ))}
        </div>
      ) : (
        <div className="cc-recs-list">
          {fallbackPrompts.map((p, i) => (
            <button type="button" className="cc-rec" key={`fallback-${i}`}
              title={p} onClick={() => onPickPrompt(p)}>
              <span className="cc-rec-title">{p}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
