// ============================================================
// hooks/useNewsRecommendations.ts — 「为你推荐」数据源（两段式 + 话题画像）
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
// 【话题画像（2026-10-20 补）】
//   传入 topic（任务类型 id，如 'code'/'intel'，或 Agent 角色 id 经 ALIAS
//   归一）后，快段按该话题的分类偏好加权排序、慢段按该话题的兴趣描述打分，
//   从而「选代码开发」和「选情报监控」看到的推荐是不同的。
//   不同话题分缓存（主进程按 topic 分 Map），切换角色会重新拉取对应榜单。
//
// 为什么抽成 hook：Agent 聊天与团队群聊两个面板都要用，逻辑（延迟拉取、
// 并发锁、失败清空、手动换一批、话题切换重置）完全一致，复制两份必然漂移。
// 【开关（2026-10-20 补）】
//   整个功能挂在 featureFlag `news.recommend` 下（默认开）。关闭后：
//   渲染层清空榜单不再拉取，主进程 news:recommend* 直接回 disabled ——
//   离线/计量网络/隐私敏感用户不会因为「打开聊天页」而被外联。
//   设置页改动会通过 `lumina:flag-changed` 事件即时广播，无需重开窗口。
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react'
import { getFlag, onFlagChanged } from '../services/featureFlagsClient'

export interface RecommendationItem {
  title: string
  url: string
  source: string
  /** 新闻分类（快段也有，可用于调试/未来展示） */
  category?: string
  /** AI 精选给出的推荐理由（慢段才有；快段为空） */
  reason?: string
}

export interface UseNewsRecommendations {
  items: RecommendationItem[]
  loading: boolean
  /** 是否已拿到 AI 精选结果（用于在标题旁标「AI 精选」） */
  smart: boolean
  /** 当前生效的话题画像标签（如「代码开发」），无话题为 null */
  topicLabel: string | null
  /** 手动换一批（force=true 绕过主进程缓存，两段都重跑） */
  reload: (force?: boolean) => Promise<void>
}

export function useNewsRecommendations(
  limit = 5,
  topic?: string,
  autoDelay = 800,
): UseNewsRecommendations {
  const [items, setItems] = useState<RecommendationItem[]>([])
  const [loading, setLoading] = useState(false)
  const [smart, setSmart] = useState(false)
  const [topicLabel, setTopicLabel] = useState<string | null>(null)
  // 用 ref 做并发锁与「只自动拉一次」的标记：state 异步生效，挡不住同 tick 重入
  const loadingRef = useRef(false)
  const loadedRef = useRef(false)
  const smartRef = useRef(false)
  // topic 用 ref 读取，保证 reload/loadSmart 闭包永远拿到最新话题，
  // 即便它们因 limit 变化被重建，topic 也不会过期。
  const topicRef = useRef(topic)
  topicRef.current = topic
  /** 上次拿到 AI 精选的时间：超过 10 分钟允许静默重跑（与主进程缓存 TTL 对齐） */
  const smartAtRef = useRef(0)
  const SMART_TTL_MS = 10 * 60 * 1000
  /** 功能开关：关闭时不发任何 IPC（主进程也会再拦一层） */
  const [enabled, setEnabled] = useState<boolean>(() => getFlag('news.recommend'))

  // 设置页改了开关 → 立刻生效：关掉清空榜单并置 smartRef 阻止慢段；
  // 重新打开则把状态复位，让下面的 effect 重新拉一轮。
  useEffect(() => onFlagChanged('news.recommend', v => {
    setEnabled(v)
    if (!v) {
      setItems([])
      setSmart(false)
      setTopicLabel(null)
      smartRef.current = true
      loadedRef.current = false
    } else {
      smartRef.current = false
      loadedRef.current = false
    }
  }), [])

  /** 慢段：LLM 按兴趣重排 + 推荐理由（后台跑，失败静默保留快段结果） */
  const loadSmart = useCallback(async (force = false) => {
    if (!getFlag('news.recommend')) {return}
    if (smartRef.current) {return}
    smartRef.current = true
    try {
      const r = await window.luminaAPI?.newsRecommendSmart?.({ limit, force, topic: topicRef.current })
      if (!getFlag('news.recommend')) {return}
      if (r?.ok && Array.isArray(r.items) && r.items.length > 0) {
        setItems(r.items.map(i => ({
          title: i.title,
          url: i.url,
          source: i.source,
          category: i.category,
          reason: i.reason || '',
        })))
        setSmart(true)
        if (r.topic) {setTopicLabel(r.topic)}
        smartAtRef.current = Date.now()
      }
    } catch {
      // 保留快段结果，不打扰用户
    }
  }, [limit])

  const reload = useCallback(async (force = false) => {
    if (!getFlag('news.recommend')) {setItems([]); return}
    if (loadingRef.current) {return}
    loadingRef.current = true
    setLoading(true)
    if (force) {
      smartRef.current = false
      setSmart(false)
    }
    try {
      const r = await window.luminaAPI?.newsRecommend?.({ limit, force, topic: topicRef.current })
      if (r?.ok && Array.isArray(r.items) && r.items.length > 0) {
        // 快段返回类型无 reason 字段（只有慢段 AI 精选才有），这里只取基础字段
        setItems(r.items.map(i => ({
          title: i.title,
          url: i.url,
          source: i.source,
          category: i.category,
        })))
        if (r.topic) {setTopicLabel(r.topic)}
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
      // 非强制刷新时，慢段结果超过 10 分钟才重跑（与主进程缓存 TTL 对齐）
      if (Date.now() - smartAtRef.current > SMART_TTL_MS) {smartRef.current = false}
      void loadSmart(force)
    }
  }, [limit, loadSmart])

  // 延迟拉取 / 话题切换：不和首屏渲染抢资源；话题变化（切角色）时清空旧榜单重拉。
  // 只自动拉一次（per topic），之后靠 ↻ / 回到窗口。
  // 开关关闭时直接 return：不设 timer、不发 IPC，等于这个功能不存在。
  useEffect(() => {
    if (!enabled) {return}
    // 话题切换：清掉上一个话题的榜单与标记，确保重新拉到对应榜单
    loadedRef.current = false
    smartRef.current = false
    setSmart(false)
    setItems([])
    setTopicLabel(null)
    const t = setTimeout(() => { void reload() }, autoDelay)
    return () => clearTimeout(t)
  }, [enabled, topic, reload, autoDelay])

  // 回到窗口时静默刷新：用户切出去再回来，看到的是「当前」而不是几小时前的榜单。
  // 不强制（force=false）：主进程有 10 分钟缓存，新鲜时直接返回缓存，不会真的重抓。
  useEffect(() => {
    if (!enabled) {return}
    const onVisible = () => {
      if (document.visibilityState !== 'visible') {return}
      if (!loadedRef.current) {return}
      void reload(false)
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [enabled, reload])

  return { items, loading, smart, topicLabel, reload }
}
