// ============================================================
// hooks/useNewsRecommendations.ts — 「为你推荐」数据源（两段式）
//
// 2026-10-20：用户反馈空对话那三个写死的气泡「太死板」，要求像豆包那样
// 打开就能看到最近/最新资讯。
//
// 【两段式设计】
//   ① 快段：news:recommend —— 原始热榜 + 分类热度排序，10 分钟缓存，
//      不跑 LLM，保证打开就有（毫秒级）；
//   ② 慢段：news:recommend:smart —— 后台用 LLM 按用户兴趣重排并给
//      推荐理由（2–20s），拿到后**原地替换**，不阻塞输入栏。
//   慢段失败（没配模型/超时/离线）就保留快段结果，用户无感。
//
// 为什么抽成 hook：Agent 聊天与团队群聊两个面板都要用，逻辑（延迟拉取、
// 并发锁、失败清空、手动换一批）完全一致，复制两份必然漂移。
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react'

export interface RecommendationItem {
  title: string
  url: string
  source: string
  /** AI 精选给出的推荐理由（慢段才有；快段为空） */
  reason?: string
}

export interface UseNewsRecommendations {
  items: RecommendationItem[]
  loading: boolean
  /** 是否已拿到 AI 精选结果（用于在标题旁标「AI 精选」） */
  smart: boolean
  /** 手动换一批（force=true 绕过主进程缓存，两段都重跑） */
  reload: (force?: boolean) => Promise<void>
}

export function useNewsRecommendations(limit = 5, autoDelay = 800): UseNewsRecommendations {
  const [items, setItems] = useState<RecommendationItem[]>([])
  const [loading, setLoading] = useState(false)
  const [smart, setSmart] = useState(false)
  // 用 ref 做并发锁与「只自动拉一次」的标记：state 异步生效，挡不住同 tick 重入
  const loadingRef = useRef(false)
  const loadedRef = useRef(false)
  const smartRef = useRef(false)

  /** 慢段：LLM 按兴趣重排 + 推荐理由（后台跑，失败静默保留快段结果） */
  const loadSmart = useCallback(async (force = false) => {
    if (smartRef.current) {return}
    smartRef.current = true
    try {
      const r = await window.luminaAPI?.newsRecommendSmart?.({ limit, force })
      if (r?.ok && Array.isArray(r.items) && r.items.length > 0) {
        setItems(r.items.map(i => ({
          title: i.title,
          url: i.url,
          source: i.source,
          reason: i.reason || '',
        })))
        setSmart(true)
      }
    } catch {
      // 保留快段结果，不打扰用户
    }
  }, [limit])

  const reload = useCallback(async (force = false) => {
    if (loadingRef.current) {return}
    loadingRef.current = true
    setLoading(true)
    if (force) {
      smartRef.current = false
      setSmart(false)
    }
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
      // 快段渲染完再跑慢段（不 await：不阻塞 UI）
      void loadSmart(force)
    }
  }, [limit, loadSmart])

  // 延迟拉取：不和首屏渲染抢资源；只自动拉一次，之后靠 ↻
  useEffect(() => {
    if (loadedRef.current) {return}
    const t = setTimeout(() => { void reload() }, autoDelay)
    return () => clearTimeout(t)
  }, [reload, autoDelay])

  return { items, loading, smart, reload }
}
