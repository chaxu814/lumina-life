// ============================================================
// hooks/useNewsRecommendations.ts — 「为你推荐」数据源
//
// 2026-10-20：用户反馈空对话那三个写死的气泡「太死板」，要求像豆包那样
// 打开就能看到最近/最新资讯。数据走主进程 news:recommend（10 分钟缓存、
// 不跑 LLM 筛选），拿不到就留空，由调用方回落到动态快捷指令。
//
// 为什么抽成 hook：Agent 聊天与团队群聊两个面板都要用，逻辑（延迟拉取、
// 并发锁、失败清空、手动换一批）完全一致，复制两份必然漂移。
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react'

export interface RecommendationItem {
  title: string
  url: string
  source: string
}

export interface UseNewsRecommendations {
  items: RecommendationItem[]
  loading: boolean
  /** 手动换一批（force=true 绕过主进程缓存） */
  reload: (force?: boolean) => Promise<void>
}

export function useNewsRecommendations(limit = 5, autoDelay = 800): UseNewsRecommendations {
  const [items, setItems] = useState<RecommendationItem[]>([])
  const [loading, setLoading] = useState(false)
  // 用 ref 做并发锁与「只自动拉一次」的标记：state 异步生效，挡不住同 tick 重入
  const loadingRef = useRef(false)
  const loadedRef = useRef(false)

  const reload = useCallback(async (force = false) => {
    if (loadingRef.current) {return}
    loadingRef.current = true
    setLoading(true)
    try {
      const r = await window.luminaAPI?.newsRecommend?.({ limit, force })
      if (r?.ok && Array.isArray(r.items) && r.items.length > 0) {
        setItems(r.items.map(i => ({ title: i.title, url: i.url, source: i.source })))
      } else {
        setItems([])
      }
    } catch {
      setItems([])
    } finally {
      loadingRef.current = false
      setLoading(false)
      loadedRef.current = true
    }
  }, [limit])

  // 延迟拉取：不和首屏渲染抢资源；只自动拉一次，之后靠 ↻
  useEffect(() => {
    if (loadedRef.current) {return}
    const t = setTimeout(() => { void reload() }, autoDelay)
    return () => clearTimeout(t)
  }, [reload, autoDelay])

  return { items, loading, reload }
}
