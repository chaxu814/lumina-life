// ============================================================
// components/RecommendationBar.tsx — 输入栏上方的「为你推荐」
//
// 2026-10-20：替代原来写死的三个快捷气泡（用户评价「太死板」）。
// 两段式展示：先出原始热榜（秒开），LLM 精选返回后原地替换，
// 每条带一句「为什么推荐给你」，标题旁标「AI 精选」。
// 没有资讯（离线/采集失败）时回落到动态快捷指令，保证这一栏不空着。
//
// 只负责展示与回调，数据来自 useNewsRecommendations，样式在 composer.css。
// ============================================================

import React from 'react'
import type { RecommendationItem } from '../hooks/useNewsRecommendations'
import { getFlag } from '../services/featureFlagsClient'

export interface RecommendationBarProps {
  items: RecommendationItem[]
  loading: boolean
  /** 是否已拿到 AI 精选结果 */
  smart?: boolean
  /** 当前话题画像标签（如「代码开发」）；无话题为 null */
  topicLabel?: string | null
  onReload: (force?: boolean) => void
  /** 点一条资讯 */
  onPickNews: (item: RecommendationItem) => void
  /** 点一条回落提示词（无资讯时） */
  onPickPrompt: (text: string) => void
  /** 无资讯时的回落提示词 */
  fallbackPrompts?: string[]
}

export default function RecommendationBar(props: RecommendationBarProps) {
  const { items, loading, smart, topicLabel, onReload, onPickNews, onPickPrompt, fallbackPrompts = [] } = props

  // 开关关闭（设置 → 隐私与开关 → 为你推荐）：不再展示资讯与刷新按钮，
  // 只保留几条静态提示词，避免这一栏整个消失、输入区上方突然空一块。
  // 注意：真正的网络拦截在主进程与 hook 里各有一道，这里只是不渲染。
  if (!getFlag('news.recommend')) {
    if (fallbackPrompts.length === 0) {return null}
    return (
      <div className="cc-recs">
        <div className="cc-recs-list">
          {fallbackPrompts.map((p, i) => (
            <button type="button" className="cc-rec" key={`fallback-off-${i}`}
              title={p} onClick={() => onPickPrompt(p)}>
              <span className="cc-rec-title">{p}</span>
            </button>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="cc-recs">
      <div className="cc-recs-head">
        <span className="cc-recs-title">
          为你推荐
          {topicLabel && <em className="cc-recs-topic">{topicLabel}</em>}
          {smart && <em className="cc-recs-badge">AI 精选</em>}
        </span>
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
              title={rec.reason ? `${rec.title}\n${rec.reason}${rec.source ? `\n—— ${rec.source}` : ''}` : rec.title}
              onClick={() => onPickNews(rec)}>
              <span className="cc-rec-title">{rec.title}</span>
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
