import React, { useState, useEffect, useCallback, useRef } from 'react'
import { clsx } from 'clsx'
import { IconRefresh, IconMail, IconSettings, IconCheck, IconPlay } from '../components/Icons'
import { Button, Switch, Input } from '../components/ui'

// ── 类型 ──

interface NewsItem {
  id: string
  title: string
  url: string
  source: string
  category: string
  pubDate: string
  summary: string
  hotScore: number
  /** 背景信息补充 */
  background?: string
  /** 社区讨论摘要（HN/Reddit 热评提炼）*/
  communitySummary?: string
  /** 英文关键词 */
  enKeywords?: string
}

interface NewsDigest {
  date: string
  items: NewsItem[]
  totalCollected: number
  filteredCount: number
  pushedToMail?: number
}

/** v2.0：间隔模式下整点可任意，不再是 4 个字面量 */
export type PushTimeSlot = number

/** v2.0：系统弹窗配置 */
interface SystemNotifyConfig {
  enabled: boolean
  minPriority: 'normal' | 'high'
  scoreThreshold: number
  majorCategories: string[]
  majorHotScore: number
  categoryCooldownMs: number
  windowMs: number
  maxPerWindow: number
}

/** v2.0：agent 整理配置 */
interface AgentOrganizeConfig {
  enabled: boolean
  agentId: 'lumina' | 'yak' | 'recha'
  maxItems: number
  timeoutMs: number
  maxRetries: number
}

interface NewsSourceMeta {
  id: string
  label: string
  description: string
  icon: string
  defaultEnabled: boolean
}

interface NewsDigestConfig {
  enabled: boolean
  enabledSlots: PushTimeSlot[]
  /** v2.0：'interval' 每 N 小时 / 'slots' 手挑整点 */
  scheduleMode: 'interval' | 'slots'
  /** v2.0：间隔小时数（1-24） */
  intervalHours: number
  /** v2.0：间隔模式起始整点 */
  intervalAnchorHour: number
  /** v2.0：静默时段（null = 不静默） */
  intervalQuietHours: { start: number; end: number } | null
  /** v2.0：同一时段冷却小时数 */
  cooldownHours: number
  interests: string
  sources: Record<string, boolean>
  customRssSources?: string[]
  maxItems: number
  minScore: number
  crossSourceDedup?: boolean
  enrichment?: boolean
  bilingual?: boolean
  /** 分类配额（v2.0「雷达」升级） */
  categoryQuota?: Record<string, number>
  /** v2.0：系统弹窗 */
  systemNotify?: SystemNotifyConfig
  /** v2.0：agent 整理 */
  agentOrganize?: AgentOrganizeConfig
  lastPushedAt: Record<number, number>
}

type CategoryFilter = 'all' | 'ai' | 'tech' | 'finance' | 'trending' | 'oss' | 'paper' | 'general'

// ── EMOJI 映射 ──

const CAT_EMOJI: Record<string, string> = {
  ai: '🤖', tech: '💻', finance: '💰', trending: '🔥', oss: '🔧', paper: '📄', general: '📰',
}

const CAT_LABEL: Record<string, string> = {
  ai: 'AI', tech: '科技', finance: '财经', trending: '热搜', oss: '开源', paper: '论文', general: '综合',
}

// ── v2.0「换装」：分类彩色标签 ──
const CAT_COLORS: Record<string, { bg: string; text: string; dot: string }> = {
  ai:       { bg: 'bg-purple-100', text: 'text-purple-600', dot: 'bg-purple-500' },
  tech:     { bg: 'bg-accent-50',  text: 'text-accent-600', dot: 'bg-accent-500' },
  finance:  { bg: 'bg-yellow-100', text: 'text-yellow-600', dot: 'bg-yellow-500' },
  trending: { bg: 'bg-red-100',    text: 'text-red-600',    dot: 'bg-red-500' },
  oss:      { bg: 'bg-green-100',  text: 'text-green-600',  dot: 'bg-green-500' },
  paper:    { bg: 'bg-blue-100',   text: 'text-blue-600',   dot: 'bg-blue-500' },
  general:  { bg: 'bg-surface-100',text: 'text-text-secondary', dot: 'bg-text-tertiary' },
}

/** UI 侧默认值，仅用于「未加载到配置」时保持控件可用（主进程才是权威） */
const DEFAULT_SYSTEM_NOTIFY: SystemNotifyConfig = {
  enabled: true, minPriority: 'high', scoreThreshold: 85,
  majorCategories: ['finance', 'trending'], majorHotScore: 90,
  categoryCooldownMs: 30 * 60_000, windowMs: 60 * 60_000, maxPerWindow: 3,
}

const DEFAULT_AGENT_ORGANIZE: AgentOrganizeConfig = {
  enabled: false, agentId: 'recha', maxItems: 12, timeoutMs: 120_000, maxRetries: 0,
}

/** v1.0 的四个固定时段（旧配置与旧数据仍可能出现） */
const LEGACY_SLOTS: PushTimeSlot[] = [8, 12, 18, 22]

const SLOT_LABEL: Record<number, string> = {
  8: '☀️ 早间 (8:00)', 12: '🌤️ 午间 (12:00)', 18: '🌆 傍晚 (18:00)', 22: '🌙 晚间 (22:00)',
}

/** 依据间隔 + 起点推导实际会推送的整点（与主进程 scheduleSlots.ts 保持一致） */function previewIntervalSlots(intervalHours: number, anchorHour: number): number[] {
  const step = Math.max(1, Math.min(24, Math.trunc(intervalHours) || 3))
  const anchor = ((Math.trunc(anchorHour) || 0) % 24 + 24) % 24
  const set = new Set<number>()
  for (let h = 0; h < 24; h += step) set.add((anchor + h) % 24)
  return [...set].sort((a, b) => a - b)
}

// ── 组件 ──

// 模块级缓存：切换面板时组件会卸载，用缓存保留已采集的新闻，避免重复采集
const NEWS_CACHE_TTL = 30 * 60 * 1000 // 30 分钟内有效
let _newsCache: { digest: NewsDigest; ts: number } | null = null
let _quotesCache: { data: { indices: any[]; stocks: any[]; updatedAt?: string }; ts: number } | null = null

export default function NewsPanel() {
  const [digest, setDigestState] = useState<NewsDigest | null>(_newsCache?.digest ?? null)
  const [loading, setLoading] = useState(!_newsCache)
  const [collecting, setCollecting] = useState(false)
  const [filter, setFilter] = useState<CategoryFilter>('all')
  const [error, setError] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  // 统一 setDigest：同时更新缓存
  const setDigest = useCallback((d: NewsDigest | null) => {
    if (d) {
      _newsCache = { digest: d, ts: Date.now() }
    }
    setDigestState(d)
  }, [])

  // 🐛 修复「闪一下」：采集操作防重复锁 + 组件挂载标记
  const fetchLockRef = useRef<'idle' | 'auto' | 'manual'>('idle')
  const mountedRef = useRef(true)
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false } }, [])

  // 「雷达」：行情 Tab
  const [activeTab, setActiveTab] = useState<'news' | 'quotes' | 'mcp'>('news')
  const [quotesData, setQuotesDataState] = useState<{
    indices: any[]; stocks: any[]; updatedAt?: string
  } | null>(_quotesCache?.data ?? null)
  const [quotesLoading, setQuotesLoading] = useState(false)

  const setQuotesData = useCallback((d: { indices: any[]; stocks: any[]; updatedAt?: string } | null) => {
    if (d) {
      _quotesCache = { data: d, ts: Date.now() }
    }
    setQuotesDataState(d)
  }, [])

  // ── 配置状态 ──
  const [showConfig, setShowConfig] = useState(false)
  const [config, setConfig] = useState<NewsDigestConfig | null>(null)
  const [availableSources, setAvailableSources] = useState<NewsSourceMeta[]>([])
  const [configSaved, setConfigSaved] = useState(false)

  // 🔔 v2.0: 系统通知权限（granted / denied / default）
  const [notifyPermission, setNotifyPermission] = useState<string>('default')
  const [notifyPermBusy, setNotifyPermBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(window.luminaAPI as any).newsDigestNotifyPermission?.()
      ?.then((r: any) => { if (!cancelled && r?.ok) setNotifyPermission(r.permission) })
      .catch(() => { /* 拿不到就保持 default，不影响其他功能 */ })
    return () => { cancelled = true }
  }, [])

  const handleRequestNotifyPermission = useCallback(async () => {
    setNotifyPermBusy(true)
    try {
      const r = await (window.luminaAPI as any).newsDigestRequestNotifyPermission?.()
      if (r?.ok) setNotifyPermission(r.permission)
    } catch {
      // 申请失败不弹错误：通知本就是可选增强
    } finally {
      setNotifyPermBusy(false)
    }
  }, [])

  // ── 加载配置 ──
  useEffect(() => {
    Promise.all([
      (window.luminaAPI as any).newsDigestGetConfig?.(),
      (window.luminaAPI as any).newsSourcesGetAvailable?.(),
    ]).then(([cfg, sources]) => {
      if (cfg) {setConfig(cfg)}
      if (sources) {setAvailableSources(sources)}
    }).catch(() => {})
  }, [])

  // ── 采集并筛选 ──
  const fetchNews = useCallback(async (force = false) => {
    // 如果手动采集正在进行，自动采集跳过
    if (fetchLockRef.current === 'manual') {
      console.log('[NewsPanel] 手动采集进行中，跳过自动加载')
      return
    }
    // 缓存命中且未过期：直接使用，不重新采集
    if (!force && _newsCache && Date.now() - _newsCache.ts < NEWS_CACHE_TTL) {
      if (mountedRef.current) {
        setDigestState(_newsCache.digest)
        setLoading(false)
      }
      return
    }
    fetchLockRef.current = 'auto'
    setLoading(true); setError(null)
    try {
      const result = await (window.luminaAPI as any).newsCollect()
      if (mountedRef.current && fetchLockRef.current === 'auto') {
        setDigest(result)
      }
    } catch (err: any) {
      console.warn('[NewsPanel] 采集失败:', err)
      if (mountedRef.current && fetchLockRef.current === 'auto') {
        setError(err.message || '采集失败')
      }
    } finally {
      if (fetchLockRef.current === 'auto') {fetchLockRef.current = 'idle'}
      if (mountedRef.current) {setLoading(false)}
    }
  }, [setDigest])

  useEffect(() => { fetchNews() }, [fetchNews])

  const handleCollect = async () => {
    // 抢锁：手动操作抢占，阻止后续自动加载覆盖
    fetchLockRef.current = 'manual'
    setCollecting(true); setError(null)
    try {
      const result = await (window.luminaAPI as any).newsCollectAndPush()
      if (mountedRef.current) {
        setDigest(result)
        if (result.pushedToMail > 0) {
          console.log(`[NewsPanel] ✅ 已推送 ${result.pushedToMail} 条新闻到邮箱`)
        }
      }
    } catch (err: any) {      if (mountedRef.current) {setError(err.message || '采集+推送失败')}
    } finally {
      fetchLockRef.current = 'idle'
      if (mountedRef.current) {setCollecting(false)}
    }
  }

  const handlePushToMail = async () => {
    if (!digest || digest.items.length === 0) {return}
    try { await (window.luminaAPI as any).newsPushToMail()
    } catch (err: any) { console.warn('[NewsPanel] 推送失败', err) }
  }

  const handleSaveConfig = async () => {
    if (!config) {return}
    try {
      await (window.luminaAPI as any).newsDigestUpdateConfig(config)
      setConfigSaved(true)
      setTimeout(() => setConfigSaved(false), 2000)
    } catch (err: any) { console.warn('[NewsPanel] 配置保存失败:', err) }
  }

  const handleManualTrigger = async (slot?: PushTimeSlot) => {
    try { await (window.luminaAPI as any).newsDigestTrigger(slot)
    } catch (err: any) { console.warn('[NewsPanel] 手动触发失败:', err) }
  }

  // 双语日报 + 订阅管理 + GitHub Pages 发布
  const [mcpTab, setMcpTab] = useState<'digest'|'subscription'|'publish'>('digest')
  const [bilingualDigest, setBilingualDigest] = useState<any>(null)
  const [digestLoading, setDigestLoading] = useState(false)
  const [subs, setSubs] = useState<any[]>([])
  const [subEmail, setSubEmail] = useState('')
  const [pubResult, setPubResult] = useState<any>(null)

  // 🎙️ Phase 2: AI 新闻主播
  const [anchorPlaying, setAnchorPlaying] = useState(false)
  const [anchorText, setAnchorText] = useState('')
  const [anchorIndex, setAnchorIndex] = useState(0)
  const [showAnchor, setShowAnchor] = useState(false)

  const playNewsItem = async (item: NewsItem) => {
    try {
      const text = `🎙️ 欢迎收听 Lumina 新闻播报。${item.title}。${item.summary.slice(0, 150)}`
      await (window as any).luminaAPI?.edgeTtsSpeak({ text, voice: 'zh-CN-XiaoxiaoNeural', rate: 0 })
    } catch (err) {
      console.warn('[NewsPanel] TTS 播报失败:', err)
    }
  }

  const playAllNews = async () => {
    const items = filteredItems
    if (items.length === 0) {return}
    setShowAnchor(true)
    setAnchorPlaying(true)
    setAnchorIndex(0)
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      setAnchorIndex(i)
      setAnchorText(item.title)
      await playNewsItem(item)
      // 播报间隔
      await new Promise(r => setTimeout(r, 1000))
    }
    setAnchorPlaying(false)
    setAnchorText('播报完毕！🎉')
    setTimeout(() => setShowAnchor(false), 2000)
  }

  const generateBilingual = async () => {
    setDigestLoading(true)
    try {
      const api = (window as any).luminaAPI
      const res = await api.newsMCPGenerateDigest(20, true)
      if (res?.ok) {setBilingualDigest(res)}
    } catch (e: any) { console.warn('[NewsPanel] 双语日报生成失败:', e) }
    finally { setDigestLoading(false) }
  }

  const handleSubscribe = async () => {
    if (!subEmail) {return}
    try {
      const api = (window as any).luminaAPI
      const res = await api.newsMCPManageSubscription('subscribe', subEmail)
      if (res?.ok) {setSubEmail('')}
      await loadSubscriptions()
    } catch (e: any) { console.warn('[NewsPanel] 订阅失败:', e) }
  }

  const handleUnsubscribe = async (email: string) => {
    try {
      const api = (window as any).luminaAPI
      await api.newsMCPManageSubscription('unsubscribe', email)
      await loadSubscriptions()
    } catch (e: any) { console.warn('[NewsPanel] 退订失败:', e) }
  }

  const loadSubscriptions = async () => {
    try {
      const api = (window as any).luminaAPI
      const res = await api.newsMCPManageSubscription('list')
      if (res?.subscribers) {setSubs(res.subscribers)}
    } catch {}
  }

  const handlePublish = async () => {
    try {
      const api = (window as any).luminaAPI
      const res = await api.newsMCPPublishSite('latest')
      setPubResult(res)
    } catch (e: any) { console.warn('[NewsPanel] 发布失败:', e) }
  }

  useEffect(() => { loadSubscriptions() }, [])

  // render MCP 面板
  const renderMCPPanel = () => (
    <div className="mt-4">
      <div className="flex gap-1 mb-3 bg-surface-1 rounded-lg p-0.5 inline-flex">
        {(['digest','subscription','publish'] as const).map(tab => (
          <button key={tab}
            className={clsx('btn btn-sm rounded-md border-none text-xs transition-all', mcpTab === tab && 'btn-active')}
            onClick={() => setMcpTab(tab)}
          >
            {tab === 'digest' ? '🌐 双语日报' : tab === 'subscription' ? '📧 订阅管理' : '🚀 发布'}
          </button>
        ))}
      </div>

      {mcpTab === 'digest' && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Button variant="primary" size="sm" onClick={generateBilingual} loading={digestLoading}>
              {digestLoading ? '生成中...' : '🌐 生成双语日报'}
            </Button>
            {bilingualDigest?.html && (
              <Button size="sm" onClick={() => {
                const blob = new Blob([bilingualDigest.html], { type: 'text/html' })
                const url = URL.createObjectURL(blob)
                window.open(url, '_blank')
              }}>
                📄 预览 HTML
              </Button>
            )}
          </div>
          {bilingualDigest?.ok ? (
            <div className="rounded-xl border border-light bg-surface-0 p-4">
              <div className="text-sm font-bold mb-1">{bilingualDigest.cnTitle}</div>
              <div className="text-xs text-accent-500 mb-3">{bilingualDigest.enTitle}</div>
              <div className="flex gap-4 mb-3 text-xs text-text-secondary">
                <span>📊 {bilingualDigest.cnSummary}</span>
                <span>🌐 {bilingualDigest.enSummary}</span>
              </div>
              <div className="space-y-2 max-h-96 overflow-y-auto">
                {bilingualDigest.items?.map((item: any, i: number) => (
                  <div key={i} className="p-3 rounded-lg bg-surface-100 border border-light">
                    <div className="text-xs font-semibold">{item.title}</div>
                    {item.enTitle && <div className="text-2xs text-accent-500 mt-0.5">{item.enTitle}</div>}
                    <div className="flex gap-1 mt-1">
                      <span className="text-2xs px-1.5 py-0.5 rounded bg-accent-50 text-accent-600">{item.source}</span>
                      <span className="text-2xs px-1.5 py-0.5 rounded bg-surface-200 text-text-secondary">{item.category}</span>
                    </div>
                    <p className="text-2xs text-text-secondary mt-1 line-clamp-2">{item.cnSummary}</p>
                    {item.enSummary && <p className="text-2xs text-text-tertiary mt-0.5 italic">{item.enSummary}</p>}
                    <a href={item.url} target="_blank" className="text-2xs text-accent-500 mt-1 inline-block" rel="noopener noreferrer">阅读原文 →</a>
                  </div>
                ))}
              </div>
            </div>
          ) : bilingualDigest && !bilingualDigest.ok ? (
            <div className="text-sm text-red-500">生成失败: {bilingualDigest.error}</div>
          ) : (
            <div className="text-sm text-text-tertiary text-center py-8">点击按钮生成今日中英双语日报</div>
          )}
        </div>
      )}

      {mcpTab === 'subscription' && (
        <div>
          <div className="flex gap-2 mb-3">
            <input type="email" value={subEmail}
              onChange={e => setSubEmail(e.target.value)}
              placeholder="输入邮箱地址..."
              className="flex-1 px-3 py-1.5 rounded-lg border border-light bg-surface-0 text-xs text-text-primary"
              onKeyDown={e => e.key === 'Enter' && handleSubscribe()}
            />
            <Button variant="primary" size="sm" onClick={handleSubscribe}>订阅</Button>
          </div>
          <div className="text-xs font-semibold text-text-primary mb-2">订阅列表 ({subs.filter(s => s.active).length} 活跃)</div>
          {subs.length === 0 ? (
            <div className="text-xs text-text-tertiary text-center py-4">暂无订阅</div>
          ) : (
            <div className="space-y-1">
              {subs.map((sub, i) => (
                <div key={i} className="flex items-center justify-between px-3 py-2 rounded-lg bg-surface-100 border border-light">
                  <div className="flex items-center gap-2">
                    <span>{sub.active ? '🟢' : '⚫'}</span>
                    <span className="text-xs">{sub.email}</span>
                    <span className="text-2xs text-text-tertiary">订阅于 {new Date(sub.subscribedAt).toLocaleDateString('zh-CN')}</span>
                  </div>
                  {sub.active && (
                    <button onClick={() => handleUnsubscribe(sub.email)}
                      className="text-2xs text-red-500 hover:underline">退订</button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {mcpTab === 'publish' && (
        <div>
          <div className="mb-3">
            <Button variant="primary" size="sm" onClick={handlePublish}>
              🚀 发布今日日报到 GitHub Pages
            </Button>
          </div>
          {pubResult && (
            <div className={`p-3 rounded-lg ${pubResult.ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-600'} text-xs`}>
              {pubResult.ok ? (
                <>
                  ✅ 发布成功！<br />
                  📅 日期: {pubResult.date}<br />
                  📄 路径: {pubResult.htmlPath}
                </>
              ) : (
                <>❌ 发布失败: {pubResult.error}</>
              )}
            </div>
          )}
          <div className="text-2xs text-text-tertiary mt-2">
            需要先配置 Git 远程仓库地址。日报站会自动生成 index.html 索引页和 daily/ 目录下的每期 HTML
          </div>
        </div>
      )}
    </div>
  )

  // ── 📡 v2.0「雷达」：行情数据 ──
  const QUOTES_CACHE_TTL = 5 * 60 * 1000 // 行情 5 分钟缓存
  const fetchQuotes = useCallback(async (force = false) => {
    // 缓存命中且未过期
    if (!force && _quotesCache && Date.now() - _quotesCache.ts < QUOTES_CACHE_TTL) {
      setQuotesDataState(_quotesCache.data)
      return
    }
    setQuotesLoading(true)
    try {
      const res = await (window.luminaAPI as any).newsFetchQuotes()
      if (res.ok) {setQuotesData({ indices: res.indices, stocks: res.stocks, updatedAt: res.updatedAt })}
    } catch (err: any) { console.warn('[NewsPanel] 行情获取失败:', err)
    } finally { setQuotesLoading(false) }
  }, [setQuotesData])

  useEffect(() => {
    if (activeTab === 'quotes') {fetchQuotes()}
  }, [activeTab, fetchQuotes])

  // ── 筛选 ──
  const filteredItems = digest?.items.filter(item => {
    if (filter === 'all') {return true}
    return item.category === filter
  }) || []
  const categoryCount = (cat: string) => digest?.items.filter(i => i.category === cat).length || 0

  // ── 渲染：配置面板 ──
  const renderConfig = () => (
    <div className="card mb-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-bold m-0">⚙️ 新闻推送配置</h3>
        <Button variant="ghost" size="sm" onClick={() => setShowConfig(false)}>✕ 收起</Button>
      </div>

      {config && (<>
        {/* 总开关 */}
        <div className="mb-3">
          <Switch
            checked={config.enabled}
            onChange={v => setConfig({ ...config, enabled: v })}
            label="📡 启用自动推送"
          />
        </div>

        {/* 新闻源选择 */}
        <div className="mb-3">
          <div className="text-xs font-semibold text-text-primary mb-1.5">🗂️ 新闻源选择</div>
          <div className="flex flex-wrap gap-2">
            {availableSources.map(s => (
              <label key={s.id} className={clsx(
                'flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-2xs cursor-pointer transition-all',
                config.sources[s.id]
                  ? 'bg-accent-50 border-accent-200 text-accent-600'
                  : 'bg-surface-1 border-light text-text-secondary',
              )}>
                <input type="checkbox" className="sr-only" checked={!!config.sources[s.id]}
                  onChange={e => setConfig({
                    ...config,
                    sources: { ...config.sources, [s.id]: e.target.checked }
                  })} />
                <span>{s.icon}</span>
                <span>{s.label}</span>
              </label>
            ))}
          </div>
          <div className="text-2xs text-text-tertiary mt-1">关闭的新闻源将不会被采集和推送</div>
        </div>

        {/* 🕐 v2.0 推送频率：间隔模式 / 手挑整点 */}
        <div className="mb-3">
          <div className="text-xs font-semibold text-text-primary mb-1.5">🕐 推送频率</div>

          <div className="flex gap-2 mb-2">
            {([['interval', '⏱ 固定间隔'], ['slots', '🕘 手挑整点']] as const).map(([mode, label]) => (
              <label key={mode} className={clsx(
                'flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-2xs cursor-pointer transition-all',
                (config.scheduleMode ?? 'interval') === mode
                  ? 'bg-accent-50 border-accent-200 text-accent-600'
                  : 'bg-surface-1 border-light text-text-secondary',
              )}>
                <input type="radio" className="sr-only" name="news-schedule-mode"
                  checked={(config.scheduleMode ?? 'interval') === mode}
                  onChange={() => setConfig({ ...config, scheduleMode: mode })} />
                <span>{label}</span>
              </label>
            ))}
          </div>

          {(config.scheduleMode ?? 'interval') === 'interval' ? (
            <>
              <div className="flex gap-6 mb-1.5">
                <div>
                  <label className="text-2xs text-text-secondary block mb-0.5">每隔（小时）</label>
                  <input type="number" min={1} max={24} value={config.intervalHours ?? 3}
                    onChange={e => setConfig({ ...config, intervalHours: Math.max(1, Math.min(24, +e.target.value || 3)) })}
                    className="w-18 px-2 py-1 rounded-md text-xs border border-light bg-surface-0 text-text-primary text-center" />
                </div>
                <div>
                  <label className="text-2xs text-text-secondary block mb-0.5">从几点开始</label>
                  <input type="number" min={0} max={23} value={config.intervalAnchorHour ?? 0}
                    onChange={e => setConfig({ ...config, intervalAnchorHour: Math.max(0, Math.min(23, +e.target.value || 0)) })}
                    className="w-18 px-2 py-1 rounded-md text-xs border border-light bg-surface-0 text-text-primary text-center" />
                </div>
                <div>
                  <label className="text-2xs text-text-secondary block mb-0.5">同段冷却（小时）</label>
                  <input type="number" min={0} max={24} value={config.cooldownHours ?? 23}
                    onChange={e => setConfig({ ...config, cooldownHours: Math.max(0, Math.min(24, +e.target.value || 0)) })}
                    className="w-18 px-2 py-1 rounded-md text-xs border border-light bg-surface-0 text-text-primary text-center" />
                </div>
              </div>
              <div className="text-2xs text-text-tertiary">
                实际推送：{previewIntervalSlots(config.intervalHours ?? 3, config.intervalAnchorHour ?? 0).map(s => `${s}:00`).join('、')}
              </div>
            </>
          ) : (
            <div className="flex flex-wrap gap-2">
              {LEGACY_SLOTS.map(slot => (
                <label key={slot} className={clsx(
                  'flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-2xs cursor-pointer transition-all',
                  config.enabledSlots.includes(slot)
                    ? 'bg-accent-50 border-accent-200 text-accent-600'
                    : 'bg-surface-1 border-light text-text-secondary',
                )}>
                  <input type="checkbox" className="sr-only" checked={config.enabledSlots.includes(slot)}
                    onChange={e => {
                      const newSlots = e.target.checked
                        ? [...config.enabledSlots, slot]
                        : config.enabledSlots.filter(s => s !== slot)
                      setConfig({ ...config, enabledSlots: newSlots })
                    }} />
                  <span>{SLOT_LABEL[slot]}</span>
                </label>
              ))}
            </div>
          )}
        </div>

        {/* 🔔 v2.0 系统弹窗通知（分级） */}
        <div className="mb-3 p-2.5 rounded-lg border border-light bg-surface-1">
          <div className="flex items-center justify-between mb-1.5">
            <div className="text-xs font-semibold text-text-primary">🔔 系统弹窗通知</div>
            <Switch checked={config.systemNotify?.enabled ?? true}
              onChange={v => setConfig({ ...config, systemNotify: { ...(config.systemNotify ?? DEFAULT_SYSTEM_NOTIFY), enabled: v } })} />
          </div>
          <div className="text-2xs text-text-tertiary mb-2">
            只有<strong>高优先级</strong>新闻（评分 ≥ {(config.systemNotify?.scoreThreshold ?? 85)}、命中你的订阅话题、或重大财经/热搜类）才弹系统通知；
            普通新闻仍只走桌宠气泡 + 侧边栏。
          </div>

          <div className="flex gap-6 mb-2">
            <div>
              <label className="text-2xs text-text-secondary block mb-0.5">高优先级评分线</label>
              <input type="number" min={0} max={100} value={config.systemNotify?.scoreThreshold ?? 85}
                onChange={e => setConfig({ ...config, systemNotify: { ...(config.systemNotify ?? DEFAULT_SYSTEM_NOTIFY), scoreThreshold: Math.max(0, Math.min(100, +e.target.value || 0)) } })}
                className="w-18 px-2 py-1 rounded-md text-xs border border-light bg-surface-0 text-text-primary text-center" />
              <input type="range" min={0} max={100} value={config.systemNotify?.scoreThreshold ?? 85}
                onChange={e => setConfig({ ...config, systemNotify: { ...(config.systemNotify ?? DEFAULT_SYSTEM_NOTIFY), scoreThreshold: +e.target.value } })}
                className="w-28" />
            </div>
            <div>
              <label className="text-2xs text-text-secondary block mb-0.5">1 小时内最多弹</label>
              <input type="number" min={1} max={20} value={config.systemNotify?.maxPerWindow ?? 3}
                onChange={e => setConfig({ ...config, systemNotify: { ...(config.systemNotify ?? DEFAULT_SYSTEM_NOTIFY), maxPerWindow: Math.max(1, +e.target.value || 1) } })}
                className="w-18 px-2 py-1 rounded-md text-xs border border-light bg-surface-0 text-text-primary text-center" />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className={clsx('text-2xs px-1.5 py-0.5 rounded',
              notifyPermission === 'granted' ? 'bg-green-100 text-green-600'
                : notifyPermission === 'denied' ? 'bg-red-100 text-red-600'
                : 'bg-yellow-100 text-yellow-600')}>
              通知权限：{notifyPermission === 'granted' ? '已授权' : notifyPermission === 'denied' ? '已被系统拒绝' : '未授权'}
            </span>
            {notifyPermission !== 'granted' && (
              <Button size="sm" onClick={handleRequestNotifyPermission} disabled={notifyPermBusy}>
                {notifyPermBusy ? '申请中…' : '申请通知权限'}
              </Button>
            )}
          </div>
          {notifyPermission !== 'granted' && (
            <div className="text-2xs text-text-tertiary mt-1">未授权时会静默降级（仅气泡+侧边栏），不会报错。</div>
          )}
        </div>

        {/* 🤖 v2.0 团队 agent 整理 */}
        <div className="mb-3 p-2.5 rounded-lg border border-light bg-surface-1">
          <div className="flex items-center justify-between mb-1.5">
            <div className="text-xs font-semibold text-text-primary">🤖 Agent 智能整理</div>
            <Switch checked={config.agentOrganize?.enabled ?? false}
              onChange={v => setConfig({ ...config, agentOrganize: { ...(config.agentOrganize ?? DEFAULT_AGENT_ORGANIZE), enabled: v } })} />
          </div>
          <div className="text-2xs text-text-tertiary mb-2">
            由团队 agent 归类打标签、生成 2-3 句中文摘要观点、剔除重复与低价值条目。
            <strong>默认关闭</strong>：每次整理都会消耗 LLM 调用额度。
          </div>
          {(config.agentOrganize?.enabled ?? false) && (
            <div className="flex gap-6">
              <div>
                <label className="text-2xs text-text-secondary block mb-0.5">整理成员</label>
                <select value={config.agentOrganize?.agentId ?? 'recha'}
                  onChange={e => setConfig({ ...config, agentOrganize: { ...(config.agentOrganize ?? DEFAULT_AGENT_ORGANIZE), agentId: e.target.value as any } })}
                  className="w-24 px-2 py-1 rounded-md text-xs border border-light bg-surface-0 text-text-primary">
                  <option value="recha">热茶（筛选）</option>
                  <option value="lumina">Lumina</option>
                  <option value="yak">阿yak</option>
                </select>
              </div>
              <div>
                <label className="text-2xs text-text-secondary block mb-0.5">每次最多整理</label>
                <input type="number" min={1} max={50} value={config.agentOrganize?.maxItems ?? 12}
                  onChange={e => setConfig({ ...config, agentOrganize: { ...(config.agentOrganize ?? DEFAULT_AGENT_ORGANIZE), maxItems: Math.max(1, Math.min(50, +e.target.value || 1)) } })}
                  className="w-18 px-2 py-1 rounded-md text-xs border border-light bg-surface-0 text-text-primary text-center" />
              </div>
            </div>
          )}
        </div>

        {/* 兴趣标签 */}
        <div className="mb-3">
          <Input
            label="🎯 兴趣标签"
            value={config.interests}
            onChange={e => setConfig({ ...config, interests: e.target.value })}
            placeholder="例：科技、AI、开源项目、前端开发"
            hint="用于 LLM 筛选个性化推荐内容"
          />
        </div>

        {/* 条数控制 */}
        <div className="flex gap-6 mb-3">
          <div>
            <label className="text-2xs text-text-secondary block mb-0.5">最大推送条数</label>
            <input type="number" min={1} max={50} value={config.maxItems}
              onChange={e => setConfig({ ...config, maxItems: Math.max(1, Math.min(50, +e.target.value)) })}
              className="w-18 px-2 py-1 rounded-md text-xs border border-light bg-surface-0 text-text-primary text-center" />
          </div>
          <div>
            <div className="text-2xs text-text-secondary mb-0.5">最低相关度</div>
            <div className="flex items-center gap-1.5">
              <input type="range" min={0} max={100} value={config.minScore}
                onChange={e => setConfig({ ...config, minScore: +e.target.value })}
                className="w-24 accent-accent-500" />
              <span className="text-2xs text-text-primary w-6 text-right">{config.minScore}</span>
            </div>
          </div>
        </div>

        {/* 分类配额 */}
        <div className="mb-3">
          <div className="text-xs font-semibold text-text-primary mb-1">📊 分类配额</div>
          <div className="flex flex-wrap gap-2">
            {(['tech','finance','trending','oss','general'] as const).map(cat => (
              <div key={cat} className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-light bg-surface-1 text-2xs">
                <span>{CAT_EMOJI[cat] || '📰'}</span>
                <span className="min-w-5">{CAT_LABEL[cat] || cat}</span>
                <input type="number" min={0} max={20}
                  value={config.categoryQuota?.[cat] ?? 5}
                  onChange={e => {
                    const v = Math.max(0, Math.min(20, +e.target.value))
                    setConfig({ ...config, categoryQuota: { ...(config.categoryQuota || {}), [cat]: v } })
                  }}
                  className="w-9 px-1 py-0.5 rounded text-2xs text-center border border-light bg-surface-0"
                />
              </div>
            ))}
          </div>
          <div className="text-2xs text-text-tertiary mt-0.5">每类新闻最多保留条数（0=不限制该分类）</div>
        </div>

        {/* 📧 SMTP 真实邮件推送配置（Horizon 式增强） */}
        <SMTPConfigSection />

        {/* 操作按钮 */}
        <div className="flex gap-2">
          <Button variant="primary" size="sm" onClick={handleSaveConfig}>
            <IconCheck /> {configSaved ? '✓ 已保存' : '保存配置'}
          </Button>
          <Button size="sm" onClick={() => handleManualTrigger()} title="立即执行一次推送">
            <IconPlay /> 立即推送
          </Button>
          <Button size="sm" onClick={async () => {
            await (window.luminaAPI as any).newsDigestResetCooldown?.()
          }} title="重置推送冷却">
            🔄 重置冷却
          </Button>
        </div>

        {/* 上次推送时间 */}
        {Object.keys(config.lastPushedAt).length > 0 && (
          <div className="text-2xs text-text-tertiary mt-2">
            上次推送：
            {Object.keys(config.lastPushedAt)
              .map(Number)
              .filter(s => config.lastPushedAt[s])
              .sort((a, b) => b - a)
              .map(s => (
                <span key={s} className="mr-2">
                  {SLOT_LABEL[s] ?? `${String(s).padStart(2, '0')}:00`} 于 {new Date(config.lastPushedAt[s]).toLocaleString('zh-CN')}
                </span>
              ))}
          </div>
        )}
      </>)}
    </div>
  )

  return (
    <div className="news-panel p-5" style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
      {/* ── 头部 Tab 切换 ── */}
      <div className="flex items-center gap-3 mb-3">
        <div className="flex gap-0.5 bg-surface-1 rounded-lg p-0.5">
          <button
            className={clsx('btn btn-sm rounded-md border-none text-xs transition-all', activeTab === 'news' && 'btn-active')}
            onClick={() => setActiveTab('news')}
          >📰 新闻</button>
          <button
            className={clsx('btn btn-sm rounded-md border-none text-xs transition-all', activeTab === 'quotes' && 'btn-active')}
            onClick={() => setActiveTab('quotes')}
          >📊 行情</button>
          <button
            className={clsx('btn btn-sm rounded-md border-none text-xs transition-all', activeTab === 'mcp' && 'btn-active')}
            onClick={() => setActiveTab('mcp')}
          >🌐 MCP</button>
        </div>
        {activeTab === 'news' && (
          <div className="flex gap-1.5">
            {/* 🎙️ Phase 2: AI 新闻主播 */}
            <Button variant="ghost" size="sm" onClick={playAllNews} disabled={anchorPlaying || !digest?.items?.length} title="Lumina 播报全部新闻">
              {anchorPlaying ? '🔊 播报中...' : '🎙️ Lumina 播报'}
            </Button>
            <Button variant={showConfig ? 'primary' : 'ghost'} size="sm" onClick={() => setShowConfig(!showConfig)} title="新闻推送配置">
              <IconSettings /> 配置
            </Button>
            <Button variant="primary" size="sm" onClick={handleCollect} loading={collecting}>
              <IconRefresh className={collecting ? 'animate-spin' : ''} /> {collecting ? '采集+推送中...' : '刷新'}
            </Button>
          </div>
        )}
        {activeTab === 'quotes' && (
          <Button variant="primary" size="sm" onClick={() => fetchQuotes(true)} loading={quotesLoading}>
            <IconRefresh className={quotesLoading ? 'animate-spin' : ''} /> {quotesLoading ? '加载...' : '刷新'}
          </Button>
        )}
      </div>

      {/* ── 配置面板 ── */}
      {activeTab === 'news' && showConfig && renderConfig()}

      {/* ── 新闻 Tab ── */}
      {activeTab === 'news' && (<>
        {/* 统计信息 */}
        {digest && (
          <div className="flex items-center gap-1.5 text-xs text-text-secondary mb-3 flex-wrap">
            <span>共采集 <strong className="text-text-primary">{digest.totalCollected}</strong> 条</span>
            <span>·</span>
            <span>精选 <strong className="text-text-primary">{digest.filteredCount}</strong> 条</span>
            {digest.pushedToMail != null && digest.pushedToMail > 0 && (
              <><span>·</span><span>📨 已推送 <strong className="text-text-primary">{digest.pushedToMail}</strong> 条到邮箱</span></>
            )}
            <span>·</span>
            <span>{digest.date}</span>
            {config && (
              <span className="text-2xs">
                · 推送 {config.enabled ? '🟢' : '🔴'} {config.enabled
                  ? (config.scheduleMode === 'slots'
                      ? `${config.enabledSlots.length}时段`
                      : `每${config.intervalHours ?? 3}小时`)
                  : '关闭'}
              </span>
            )}
          </div>
        )}

        {/* 分类筛选 chips */}
        <div className="flex gap-1.5 mb-3 flex-wrap">
          {(['all', 'ai', 'tech', 'finance', 'oss', 'trending', 'paper', 'general'] as CategoryFilter[]).map(cat => (
            <button key={cat}
              className={clsx('chip text-2xs', filter === cat && 'chip-active')}
              onClick={() => setFilter(cat)}
            >
              {cat === 'all' ? '📋 全部' : `${CAT_EMOJI[cat] || '📌'} ${CAT_LABEL[cat] || cat}`}
              {digest && <span className="ml-1 opacity-60">{cat === 'all' ? digest.items.length : categoryCount(cat)}</span>}
            </button>
          ))}
        </div>

        {/* 错误提示 */}
        {error && (
          <div className="flex items-center gap-2 px-3 py-2 mb-3 rounded-lg bg-red-100 text-red-600 text-xs">
            ⚠️ {error}
            <Button size="sm" variant="ghost" onClick={() => fetchNews(true)}>重试</Button>
          </div>
        )}

        {/* 加载中 */}
        {loading && (
          <div className="flex flex-col items-center justify-center py-16 gap-3 text-text-tertiary">
            <div className="spinner" />
            <p className="text-sm">正在采集新闻...</p>
          </div>
        )}

        {/* 新闻列表 */}
        {!loading && !error && (
          <div className="flex flex-col gap-2">
            {filteredItems.length === 0 ? (
              <div className="text-center py-12 text-text-tertiary text-sm">📭 暂无新闻</div>
            ) : (
              filteredItems.map(item => {
                const cc = CAT_COLORS[item.category] || CAT_COLORS.general
                const isExpanded = expandedId === item.id
                return (
                  <div key={item.id}
                    className={clsx(
                      'rounded-xl border border-light bg-surface-0 cursor-pointer transition-all duration-300 ease-out animate-fade-in-up',
                      isExpanded ? 'shadow-md' : 'shadow-sm hover:shadow-md hover:border-medium',
                    )}
                    onClick={() => setExpandedId(isExpanded ? null : item.id)}
                  >
                    {/* ── 头部：彩色分类标签 + 来源 + 热度 ── */}
                    <div className="flex items-center gap-2 px-4 pt-3 pb-1">
                      <span className={clsx('tag text-2xs font-medium', cc.bg, cc.text)}>
                        <span className={clsx('inline-block w-1.5 h-1.5 rounded-full mr-1', cc.dot)} />
                        {CAT_EMOJI[item.category] || '📌'} {CAT_LABEL[item.category] || item.category}
                      </span>
                      <span className="text-2xs text-text-tertiary">{item.source}</span>
                      <span className="ml-auto text-2xs text-text-disabled">
                        {'⭐'.repeat(Math.max(1, Math.round(item.hotScore / 25)))}
                      </span>
                    </div>

                    {/* ── 标题 ── */}
                    <h3 className="px-4 text-sm font-semibold text-text-primary leading-relaxed mb-1 flex items-center gap-1">
                      <span className="flex-1">{item.title}</span>
                      {/* 🎙️ AI 新闻主播播报按钮 */}
                      <button
                        onClick={async (e) => {
                          e.stopPropagation()
                          try {
                            const text = `🎙️ 欢迎收听 Lumina 新闻播报。${item.title}。${item.summary.slice(0, 150)}`
                            await (window as any).luminaAPI?.edgeTtsSpeak({ text, voice: 'zh-CN-XiaoxiaoNeural', rate: 0 })
                          } catch (err) {
                            console.warn('[NewsPanel] TTS 播报失败:', err)
                          }
                        }}
                        className="text-accent-500 hover:text-accent-600 opacity-60 hover:opacity-100 transition-all text-xs flex-shrink-0"
                        title="Lumina 播报此新闻"
                      >
                        🎙️
                      </button>
                    </h3>

                    {/* ── 摘要（展开前两行截断） ── */}
                    <p className="px-4 pb-3 text-xs text-text-secondary line-clamp-2 leading-relaxed">
                      {item.summary.slice(0, 200)}
                    </p>

                    {/* ── 展开详情（CSS 过渡动画） ── */}
                    <div className={clsx(
                      'overflow-hidden transition-all duration-300 ease-out',
                      isExpanded ? 'max-h-96 opacity-100' : 'max-h-0 opacity-0',
                    )}>
                      <div className="px-4 pb-4 space-y-3 border-t border-light pt-3">
                        <p className="text-xs text-text-secondary leading-relaxed">{item.summary}</p>

                        {/* 「Lumina 说」背景知识卡片 */}
                        {(item.background || item.communitySummary) && (
                          <div className="bg-gradient-to-br from-accent-50 to-surface-0 rounded-lg p-3 border border-accent-100/50">
                            <div className="flex items-center gap-1 mb-1.5">
                              <span className="text-xs">✨</span>
                              <span className="text-2xs font-semibold text-accent-600">Lumina 说</span>
                            </div>
                            {item.background && (
                              <p className="text-2xs text-text-secondary leading-relaxed">{item.background}</p>
                            )}
                            {item.communitySummary && (
                              <div className="flex items-start gap-1 mt-1.5 pt-1.5 border-t border-accent-100/30">
                                <span className="text-2xs">💬</span>
                                <p className="text-2xs text-text-tertiary leading-relaxed">{item.communitySummary}</p>
                              </div>
                            )}
                          </div>
                        )}

                        {/* 链接与时间 */}
                        <div className="flex items-center justify-between">
                          <a href={item.url} target="_blank" rel="noopener noreferrer"
                            className="text-2xs text-accent-500 hover:underline font-medium"
                            onClick={e => e.stopPropagation()}>
                            📎 阅读原文 →
                          </a>
                          {item.pubDate && (
                            <span className="text-2xs text-text-disabled">🕐 {new Date(item.pubDate).toLocaleString('zh-CN')}</span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        )}
      </>)}

      {/* ── MCP 双语日报 Tab ── */}
      {activeTab === 'mcp' && renderMCPPanel()}

      {/* ── 行情 Tab ── */}
      {activeTab === 'quotes' && (
        <div className="news-quotes">
          {quotesLoading && (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-text-tertiary">
              <div className="w-8 h-8 border-2 border-accent-500 border-t-transparent rounded-full animate-spin" />
              <p className="text-sm">正在加载行情...</p>
            </div>
          )}
          {!quotesLoading && quotesData && (
            <>
              {/* 大盘指数 */}
              <div className="mb-4">
                <div className="text-sm font-semibold text-text-primary mb-2">📈 大盘指数</div>
                <div className="flex gap-2.5">
                  {quotesData.indices.map((q: any) => (
                    <div key={q.code} className="flex-1 p-3 rounded-xl border border-light bg-surface-1">
                      <div className="text-2xs text-text-secondary mb-1">{q.name}</div>
                      <div className="text-xl font-bold text-text-primary">{(q.price ?? 0).toFixed(1)}</div>
                      <div className={clsx('text-sm font-semibold mt-0.5', {
                        'text-red-500': (q.changePercent ?? 0) > 0,
                        'text-green-500': (q.changePercent ?? 0) < 0,
                      })}>
                        {(q.changePercent ?? 0) > 0 ? '▲' : (q.changePercent ?? 0) < 0 ? '▼' : ''}
                        {' '}{Math.abs(q.changePercent ?? 0).toFixed(2)}%
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* 个股列表 */}
              <div>
                <div className="text-sm font-semibold text-text-primary mb-2">🏢 关注股票</div>
                <div className="rounded-xl border border-light overflow-hidden">
                  {quotesData.stocks.map((q: any) => {
                    const isUp = (q.changePercent ?? 0) > 0
                    const isDown = (q.changePercent ?? 0) < 0
                    return (
                      <div key={q.code}
                        className="flex items-center gap-3 px-3 py-2 text-xs border-b border-light last:border-b-0 hover:bg-surface-50 transition-colors">
                        <span className="font-semibold min-w-[80px] text-text-primary">{q.name}</span>
                        <span className="font-bold min-w-[60px] text-right text-text-primary">
                          {(q.price ?? 0).toFixed(2)}
                        </span>
                        <span className={clsx('min-w-[50px] text-right font-semibold', {
                          'text-red-500': isUp, 'text-green-500': isDown,
                        })}>
                          {isUp ? '+' : ''}{(q.changePercent ?? 0).toFixed(2)}%
                        </span>
                        <span className={clsx('min-w-[50px] text-right', {
                          'text-red-500': isUp, 'text-green-500': isDown,
                        })}>
                          {isUp ? '+' : ''}{(q.changeAmount ?? 0).toFixed(2)}
                        </span>
                        <span className="text-text-tertiary text-2xs flex-1 text-right">
                          高 {(q.high ?? 0).toFixed(2)} 低 {(q.low ?? 0).toFixed(2)}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>

              {quotesData.updatedAt && (
                <div className="text-2xs text-text-tertiary mt-2 text-right">
                  更新于 {new Date(quotesData.updatedAt).toLocaleTimeString('zh-CN')}
                </div>
              )}
            </>
          )}
          {!quotesLoading && !quotesData && (
            <div className="text-center py-12 text-text-tertiary text-sm">📊 暂无行情数据</div>
          )}
        </div>
      )}

      {/* 🎙️ Phase 2: AI 新闻主播覆盖层 */}
      {showAnchor && (
        <div style={{
          position: 'fixed', bottom: 20, right: 20,
          zIndex: 99999, padding: '12px 18px',
          borderRadius: 16,
          background: 'rgba(0,0,0,0.75)',
          backdropFilter: 'blur(12px)',
          border: '1px solid rgba(255,255,255,0.1)',
          color: '#fff',
          maxWidth: 320,
          fontFamily: "'Segoe UI', system-ui, sans-serif",
          display: 'flex', alignItems: 'center', gap: 10,
          animation: 'slideUp 0.3s ease-out',
          boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
        }}>
          <div style={{
            width: 36, height: 36, borderRadius: '50%',
            background: 'linear-gradient(135deg, #FF6B6B, #FF8E53)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 18, flexShrink: 0,
            animation: anchorPlaying ? 'pulse 1.5s ease-in-out infinite' : 'none',
          }}>
            {anchorPlaying ? '🔊' : '🎙️'}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 700, opacity: 0.7, marginBottom: 2 }}>
              新闻主播 · Lumina
              {anchorPlaying && ` ${anchorIndex + 1}/${filteredItems.length}`}
            </div>
            <div style={{
              fontSize: 12, lineHeight: 1.4,
              overflow: 'hidden', textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              opacity: anchorText ? 1 : 0.5,
            }}>
              {anchorText || '准备播报...'}
            </div>
            {/* 音频可视化条 */}
            {anchorPlaying && (
              <div style={{ display: 'flex', gap: 2, marginTop: 4, height: 12, alignItems: 'flex-end' }}>
                {[1,2,3,4,5,6].map(i => (
                  <div key={i} style={{
                    width: 3, borderRadius: 2,
                    background: 'linear-gradient(to top, #FF6B6B, #FF8E53)',
                    height: `${4 + Math.random() * 8}px`,
                    animation: `voiceBar ${0.3 + Math.random() * 0.3}s ease-in-out infinite alternate`,
                    transition: 'height 0.1s',
                  }}/>
                ))}
              </div>
            )}
          </div>
          <button onClick={() => { setShowAnchor(false); setAnchorPlaying(false) }} style={{
            background: 'rgba(255,255,255,0.1)', border: 'none',
            color: '#fff', fontSize: 14, width: 24, height: 24,
            borderRadius: 8, cursor: 'pointer', flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>✕</button>
        </div>
      )}
    </div>
  )
}

// ── 📧 SMTP 邮件配置组件（真实邮件推送） ──
function SMTPConfigSection() {
  const [smtp, setSmtp] = useState<{
    enabled: boolean
    host?: string
    port?: number
    secure?: boolean
    user?: string
    pass?: string
    from?: string
    to?: string
  } | null>(null)
  const [showSmtp, setShowSmtp] = useState(false)
  const [smtpTestResult, setSmtpTestResult] = useState<{ ok: boolean; msg: string } | null>(null)
  const [smtpSaving, setSmtpSaving] = useState(false)

  useEffect(() => {
    ;(window.luminaAPI as any).smtpGetConfig?.().then(setSmtp).catch(() => {})
  }, [])

  const saveSmtp = async (patch: Record<string, any>) => {
    setSmtpSaving(true)
    try {
      const res = await (window.luminaAPI as any).smtpSetConfig(patch)
      if (res.ok && res.config) {setSmtp(res.config)}
      setSmtpTestResult({ ok: true, msg: '已保存' })
    } catch (e: any) {
      setSmtpTestResult({ ok: false, msg: e.message })
    }
    setSmtpSaving(false)
    setTimeout(() => setSmtpTestResult(null), 3000)
  }

  if (!smtp) {return null}

  return (
    <div className="mb-3">
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-text-primary">📧 真实邮件推送 (SMTP)</span>
          <button
            className="text-2xs text-accent-500 hover:underline"
            onClick={() => setShowSmtp(!showSmtp)}
          >
            {showSmtp ? '收起' : '配置'}
          </button>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-2xs ${smtp.enabled ? 'text-green-600' : 'text-text-tertiary'}`}>
            {smtp.enabled ? '已启用' : '未启用'}
          </span>
          <label className="flex items-center gap-1 cursor-pointer">
            <input type="checkbox" checked={smtp.enabled}
              onChange={e => saveSmtp({ enabled: e.target.checked })}
              className="accent-accent-500" />
          </label>
        </div>
      </div>

      {showSmtp && (
        <div className="grid grid-cols-2 gap-2 p-3 rounded-lg bg-surface-1 border border-light">
          <div>
            <label className="text-2xs text-text-secondary">SMTP 服务器</label>
            <input type="text" value={smtp.host || ''}
              onChange={e => setSmtp(s => s ? { ...s, host: e.target.value } : null)}
              onBlur={e => saveSmtp({ host: e.target.value })}
              placeholder="smtp.example.com"
              className="w-full px-2 py-1 rounded text-2xs border border-light bg-surface-0" />
          </div>
          <div>
            <label className="text-2xs text-text-secondary">端口</label>
            <input type="number" value={smtp.port || 465}
              onChange={e => setSmtp(s => s ? { ...s, port: +e.target.value } : null)}
              onBlur={e => saveSmtp({ port: +e.target.value })}
              className="w-full px-2 py-1 rounded text-2xs border border-light bg-surface-0" />
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1 cursor-pointer text-2xs text-text-secondary">
              <input type="checkbox" checked={smtp.secure ?? true}
                onChange={e => saveSmtp({ secure: e.target.checked })}
                className="accent-accent-500" />
              SSL/TLS
            </label>
          </div>
          <div>
            <label className="text-2xs text-text-secondary">发件人邮箱</label>
            <input type="email" value={smtp.from || ''}
              onChange={e => setSmtp(s => s ? { ...s, from: e.target.value } : null)}
              onBlur={e => saveSmtp({ from: e.target.value })}
              placeholder="you@example.com"
              className="w-full px-2 py-1 rounded text-2xs border border-light bg-surface-0" />
          </div>
          <div>
            <label className="text-2xs text-text-secondary">收件人邮箱</label>
            <input type="email" value={smtp.to || ''}
              onChange={e => setSmtp(s => s ? { ...s, to: e.target.value } : null)}
              onBlur={e => saveSmtp({ to: e.target.value })}
              placeholder="News 实际送达邮箱"
              className="w-full px-2 py-1 rounded text-2xs border border-light bg-surface-0" />
          </div>
          <div>
            <label className="text-2xs text-text-secondary">登录用户名</label>
            <input type="text" value={smtp.user || ''}
              onChange={e => setSmtp(s => s ? { ...s, user: e.target.value } : null)}
              onBlur={e => saveSmtp({ user: e.target.value })}
              placeholder="通常同邮箱地址"
              className="w-full px-2 py-1 rounded text-2xs border border-light bg-surface-0" />
          </div>
          <div>
            <label className="text-2xs text-text-secondary">登录密码/授权码</label>
            <input type="password" value={smtp.pass || ''}
              onChange={e => setSmtp(s => s ? { ...s, pass: e.target.value } : null)}
              onBlur={e => saveSmtp({ pass: e.target.value })}
              placeholder="SMTP 授权码"
              className="w-full px-2 py-1 rounded text-2xs border border-light bg-surface-0" />
          </div>
          <div className="flex items-end gap-2">
            {smtpTestResult && (
              <span className={`text-2xs ${smtpTestResult.ok ? 'text-green-600' : 'text-red-500'}`}>
                {smtpTestResult.ok ? '✅ ' : '❌ '}{smtpTestResult.msg}
              </span>
            )}
            {smtpSaving && <span className="text-2xs text-text-tertiary">保存中...</span>}
          </div>
        </div>
      )}

      {smtp.enabled && smtp.host && !showSmtp && (
        <div className="text-2xs text-text-tertiary mt-0.5">
          📨 邮件将通过 {smtp.host}:{smtp.port} 发送至 {smtp.to || smtp.from || '未设置收件人'}
        </div>
      )}
    </div>
  )
}
