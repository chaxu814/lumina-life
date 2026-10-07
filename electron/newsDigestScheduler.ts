// ============================================================
// newsDigestScheduler.ts — 📡 新闻推送调度器 (v2.0)
//
// v2.0 相对 v1.0 的三项改造：
//   ① 频率：固定 4 个整点 → **可配置的间隔模式**（默认每 3 小时一次），
//      保留「同一时段冷却」防重复；顺带修掉 v1.0 里
//      checkAndPush() 硬编码 [8,12,18,22] 导致 enabledSlots 形同虚设的 bug。
//   ② 推送：新增**分级系统弹窗**——高优先级才弹，普通新闻保持
//      「仅桌宠气泡 + 侧边栏」的克制行为；未授权/聚焦中/限流时静默降级。
//   ③ 整理：新增**团队 agent 整理层**（默认关闭，开���有真实 token 成本），
//      走 delegationManager，失败自动回退到未整理列表。
//
// 依赖已有资产：
//   - newsCollector.collectAll()     — 多源采集
//   - newsFilter.filterWithLLM()     — LLM 筛选
//   - newsDigest.deduplicate()       — 去重
//   - mailStore.sendMail()           — 本地存储 + SMTP 外发
//   - news/scheduleSlots.ts          — 纯函数时段计算（v2.0 新增）
//   - news/newsPriority.ts           — 纯函数新闻分级（v2.0 新增）
//   - proactive/systemNotifier.ts    — 系统弹窗适配（v2.0 新增）
//   - tools/impl/newsOrganizer.ts    — agent 整理（v2.0 新增）
// ============================================================

import { collectAll, type NewsItem } from './tools/impl/newsCollector'
import { filterWithLLM, type FilteredItem, type LLMCallFn } from './tools/impl/newsFilter'
import { enrichItemsBackground } from './tools/impl/newsEnricher'
import { deduplicate, assembleDigestBody, assembleDigestHTML } from './tools/impl/newsDigest'
import { organizeNewsWithAgent } from './tools/impl/newsOrganizer'
import { narrateDigest, type DigestNarrative } from './tools/impl/newsNarrator'
import { sendMail } from './mailStore'
import { globalEventBus } from './eventBus'
import { getProviderManager } from './core/providerManager'
import { LLMProvider } from './core/llmProvider'
import { getSystemNotifier } from './proactive/systemNotifier'
import type { NotifyPriority } from './proactive/notificationPolicy'
import {
  resolveActiveSlots, sanitizeSlots, normalizeIntervalHours, normalizeHour,
  normalizeCooldownHours, isHourInQuietRange, describeSlot,
  DEFAULT_INTERVAL_HOURS, DEFAULT_ANCHOR_HOUR, LEGACY_SLOTS,
  type ScheduleMode, type QuietHours,
} from './news/scheduleSlots'
import { classifyBatch, DEFAULT_PRIORITY_OPTIONS } from './news/newsPriority'
import type { TeamMemberId } from './agentTeamTypes'
import * as path from 'path'
import * as fs from 'fs'
import { app } from 'electron'

// ═══════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════

/**
 * v1.0 里是 `8 | 12 | 18 | 22` 字面量联合。间隔模式下整点可任意，
 * 故放宽为 number；保留这个导出名是为了不破坏既有调用方与 IPC 签名。
 */
export type PushTimeSlot = number

/** ② 系统弹窗配置（全部可选，缺省即最克制） */
export interface SystemNotifyConfig {
  /** 系统弹窗总开关 */
  enabled: boolean
  /** 达到该优先级才弹窗（'high' = 只有高优先级弹） */
  minPriority: NotifyPriority
  /** 相关性评分阈值：超过即判为高优先级 */
  scoreThreshold: number
  /** 重大新闻分类（这些分类里热度达标也算高优先级） */
  majorCategories: string[]
  /** 重大新闻的热度阈值 */
  majorHotScore: number
  /** 同类通知最小间隔（毫秒）——防同类刷屏 */
  categoryCooldownMs: number
  /** 限流窗口（毫秒） */
  windowMs: number
  /** 窗口内最多弹几条 */
  maxPerWindow: number
}

/** ③ agent 整理配置 */
export interface AgentOrganizeConfig {
  /** 总开关。**默认 false** —— 每轮整理都是真实 LLM 调用，开着就一直烧 token */
  enabled: boolean
  /** 目标成员：热茶 recha（筛选挑错）/ lumina / yak */
  agentId: TeamMemberId
  /** 每次最多整理多少条（控制 token 成本） */
  maxItems: number
  /** 委托超时（毫秒） */
  timeoutMs: number
  /** 失败重试次数；0 = 不重试（省 token） */
  maxRetries: number
}

export interface NewsDigestConfig {
  /** 总开关 */
  enabled: boolean
  /** 启用推送的整点（仅 'slots' 模式使用；保留字段以兼容旧配置） */
  enabledSlots: PushTimeSlot[]
  /** ② 调度模式：'interval' 每 N 小时 / 'slots' 手挑整点 */
  scheduleMode: ScheduleMode
  /** 间隔小时数（1-24），仅 'interval' 模式生效 */
  intervalHours: number
  /** 间隔模式的起始整点（0-23），仅 'interval' 模式生效 */
  intervalAnchorHour: number
  /** 间隔模式的静默时段；null = 不静默 */
  intervalQuietHours: QuietHours | null
  /** 同一时段的冷却小时数（夹到 0-24；>24 会让该时段永久失效） */
  cooldownHours: number
  /** 用户兴趣描述（传给 LLM 筛选与 agent 整理） */
  interests: string
  /** 各新闻源开关 */
  sources: {
    rss: boolean
    zhihu: boolean
    finance: boolean
    github: boolean
    hackernews: boolean
    reddit: boolean
    baidu: boolean
  }
  /** 自定义 RSS 源列表（存 URL） */
  customRssSources?: string[]
  /** 每条推送最多条数 */
  maxItems: number
  /** 最低相关度阈值 */
  minScore: number
  /** 启用跨源去重（不同源报道同一件事只留一条） */
  crossSourceDedup?: boolean
  /** 启用背景信息补充（今日热点的来龙去脉） */
  enrichment?: boolean
  /** 启用双语总结（中文摘要 + 英文关键词） */
  bilingual?: boolean
  /** 分类配额：每类最多保留多少条（空对象=不限） */
  categoryQuota?: Record<string, number>
  /** 系统弹窗配置（v2.0） */
  systemNotify: SystemNotifyConfig
  /** agent 整理配置（v2.0） */
  agentOrganize: AgentOrganizeConfig
  /** 最近一次各时段的推送时间戳 */
  lastPushedAt: Record<number, number>
}

const DEFAULT_CATEGORY_QUOTA: Record<string, number> = {
  ai: 5,
  tech: 4,
  finance: 4,
  trending: 2,
  oss: 3,
  paper: 2,
  general: 3,
}

const DEFAULT_SYSTEM_NOTIFY: SystemNotifyConfig = {
  enabled: true,
  minPriority: 'high',
  scoreThreshold: DEFAULT_PRIORITY_OPTIONS.scoreThreshold,
  majorCategories: [...DEFAULT_PRIORITY_OPTIONS.majorCategories],
  majorHotScore: DEFAULT_PRIORITY_OPTIONS.majorHotScore,
  categoryCooldownMs: 30 * 60_000,
  windowMs: 60 * 60_000,
  maxPerWindow: 3,
}

const DEFAULT_AGENT_ORGANIZE: AgentOrganizeConfig = {
  // 默认关闭：无人值守的后台调度不该默认烧用户 token
  enabled: false,
  agentId: 'recha',
  maxItems: 12,
  timeoutMs: 120_000,
  maxRetries: 0,
}

const DEFAULT_CONFIG: NewsDigestConfig = {
  enabled: true,
  enabledSlots: [...LEGACY_SLOTS],
  scheduleMode: 'interval',
  intervalHours: DEFAULT_INTERVAL_HOURS,
  intervalAnchorHour: DEFAULT_ANCHOR_HOUR,
  intervalQuietHours: null,
  cooldownHours: 23,
  interests: 'AI大模型发布与更新、AI编程工具、半导体芯片、新能源汽车、A股美股港股、宏观经济政策、GitHub开源项目、科技公司动态',
  sources: { rss: true, zhihu: true, finance: true, github: true, hackernews: true, reddit: false, baidu: true },
  customRssSources: [],
  maxItems: 20,
  minScore: 50,
  crossSourceDedup: true,
  enrichment: true,
  bilingual: false,
  categoryQuota: { ...DEFAULT_CATEGORY_QUOTA },
  systemNotify: { ...DEFAULT_SYSTEM_NOTIFY },
  agentOrganize: { ...DEFAULT_AGENT_ORGANIZE },
  lastPushedAt: {},
}

// ═══════════════════════════════════════════════════════════
// 配置归一化
// ═══════════════════════════════════════════════════════════

const VALID_AGENT_IDS: TeamMemberId[] = ['lumina', 'yak', 'recha']

/**
 * 把（可能来自旧版本 JSON 文件 / IPC / 用户输入的）配置收敛成合法值。
 * 调度器是长驻进程，一个脏值就可能让它永远不推或疯狂推，必须在入口夹住。
 */
export function normalizeConfig(raw: Partial<NewsDigestConfig>): NewsDigestConfig {
  const merged: NewsDigestConfig = {
    ...DEFAULT_CONFIG,
    ...raw,
    sources: { ...DEFAULT_CONFIG.sources, ...(raw.sources || {}) },
    systemNotify: { ...DEFAULT_SYSTEM_NOTIFY, ...(raw.systemNotify || {}) },
    agentOrganize: { ...DEFAULT_AGENT_ORGANIZE, ...(raw.agentOrganize || {}) },
    categoryQuota: raw.categoryQuota ?? { ...DEFAULT_CATEGORY_QUOTA },
    lastPushedAt: { ...(raw.lastPushedAt || {}) },
  }

  merged.enabled = merged.enabled !== false
  merged.scheduleMode = merged.scheduleMode === 'slots' ? 'slots' : 'interval'
  merged.enabledSlots = sanitizeSlots(merged.enabledSlots)
  merged.intervalHours = normalizeIntervalHours(merged.intervalHours)
  merged.intervalAnchorHour = normalizeHour(merged.intervalAnchorHour)
  merged.cooldownHours = normalizeCooldownHours(merged.cooldownHours)
  merged.maxItems = Math.max(1, Math.min(100, Math.trunc(Number(merged.maxItems) || DEFAULT_CONFIG.maxItems)))
  merged.minScore = Math.max(0, Math.min(100, Number(merged.minScore) || 0))

  // 静默时段：形状不对就当没配
  const q = merged.intervalQuietHours
  if (q && (typeof q.start !== 'number' || typeof q.end !== 'number')) {
    merged.intervalQuietHours = null
  } else if (q) {
    merged.intervalQuietHours = { start: normalizeHour(q.start), end: normalizeHour(q.end) }
  }

  // 弹窗配置
  const sn = merged.systemNotify
  sn.enabled = sn.enabled !== false
  sn.minPriority = sn.minPriority === 'normal' ? 'normal' : 'high'
  sn.scoreThreshold = Math.max(0, Math.min(100, Number(sn.scoreThreshold) || DEFAULT_SYSTEM_NOTIFY.scoreThreshold))
  sn.majorHotScore = Math.max(0, Math.min(100, Number(sn.majorHotScore) || DEFAULT_SYSTEM_NOTIFY.majorHotScore))
  sn.majorCategories = Array.isArray(sn.majorCategories) ? sn.majorCategories.filter(c => typeof c === 'string') : []
  sn.categoryCooldownMs = Math.max(0, Number(sn.categoryCooldownMs) || 0)
  sn.windowMs = Math.max(0, Number(sn.windowMs) || 0)
  sn.maxPerWindow = Math.max(1, Math.trunc(Number(sn.maxPerWindow) || 1))

  // agent 整理配置
  const ao = merged.agentOrganize
  ao.enabled = ao.enabled === true // 只有显式 true 才开启
  ao.agentId = VALID_AGENT_IDS.includes(ao.agentId) ? ao.agentId : 'recha'
  ao.maxItems = Math.max(1, Math.min(100, Math.trunc(Number(ao.maxItems) || DEFAULT_AGENT_ORGANIZE.maxItems)))
  ao.timeoutMs = Math.max(5_000, Math.min(600_000, Math.trunc(Number(ao.timeoutMs) || DEFAULT_AGENT_ORGANIZE.timeoutMs)))
  ao.maxRetries = Math.max(0, Math.min(3, Math.trunc(Number(ao.maxRetries) || 0)))

  return merged
}

// ═══════════════════════════════════════════════════════════
// 调度器实现
// ═══════════════════════════════════════════════════════════

export class NewsDigestScheduler {
  private config: NewsDigestConfig
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly configPath: string
  /** 防止同一分钟内重复推送 */
  private lastPushMinute: number = -1
  /** 正在进行的推送（防重入：手动触发 + 定时触发可能撞车） */
  private inFlight = false

  constructor() {
    this.configPath = this.getConfigPath()
    this.config = this.loadConfig()
  }

  private getConfigPath(): string {
    try {
      return path.join(app.getPath('userData'), 'news-digest-config.json')
    } catch {
      return path.join(process.cwd(), 'news-digest-config.json')
    }
  }

  private loadConfig(): NewsDigestConfig {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'))
        // normalizeConfig 同时兼容「旧配置文件缺新字段」的情况
        return normalizeConfig({ ...DEFAULT_CONFIG, ...raw })
      }
    } catch (e) {
      console.warn('[NewsDigestScheduler] 配置加载失败，使用默认:', e)
    }
    return normalizeConfig({ ...DEFAULT_CONFIG })
  }

  private saveConfig(): void {
    try {
      const dir = path.dirname(this.configPath)
      if (!fs.existsSync(dir)) {fs.mkdirSync(dir, { recursive: true })}
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8')
    } catch (e) {
      console.warn('[NewsDigestScheduler] 配置保存失败:', e)
    }
  }

  // ── 公开配置 API ──

  getConfig(): NewsDigestConfig {
    // 深一层拷贝 lastPushedAt，避免调用方改到内部状态
    return { ...this.config, lastPushedAt: { ...this.config.lastPushedAt } }
  }

  updateConfig(partial: Partial<NewsDigestConfig>): void {
    this.config = normalizeConfig({ ...this.config, ...partial })
    this.saveConfig()
    this.logSchedule()
  }

  // ── 调度 ──

  /** 当前生效的整点集合（两种模式共用） */
  getActiveSlots(): number[] {
    return resolveActiveSlots({
      mode: this.config.scheduleMode,
      enabledSlots: this.config.enabledSlots,
      intervalHours: this.config.intervalHours,
      intervalAnchorHour: this.config.intervalAnchorHour,
      quietHours: this.config.intervalQuietHours,
    })
  }

  private logSchedule(): void {
    const slots = this.getActiveSlots()
    const mode = this.config.scheduleMode === 'interval'
      ? `每 ${this.config.intervalHours} 小时（起点 ${this.config.intervalAnchorHour}:00）`
      : '手挑整点'
    console.log(`[NewsDigestScheduler] 📡 调度模式=${mode} → ${slots.map(s => `${s}:00`).join(', ')}`)
  }

  start(): void {
    if (this.timer) {return}
    console.log('[NewsDigestScheduler] 📡 新闻推送调度器已启动')
    this.logSchedule()

    // 每 60 秒检查一次
    this.timer = setInterval(() => {
      this.checkAndPush()
    }, 60_000)

    // 启动后立即检测一次是否正好在推送窗口
    setTimeout(() => this.checkAndPush(), 5000)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /**
   * 检查当前时间是否在推送窗口内。
   * 纯判定，便于单测（通过参数注入时间）。
   */
  isDueAt(date: Date, lastPushMinute: number): { due: boolean; slot?: number; reason: string } {
    if (!this.config.enabled) {return { due: false, reason: '总开关关闭' }}

    const hour = date.getHours()
    const minute = date.getMinutes()

    // 只在整点后 5 分钟内触发（8:00-8:05、12:00-12:05 等）
    if (minute > 5) {return { due: false, reason: '不在整点窗口' }}

    const slots = this.getActiveSlots()
    if (!slots.includes(hour)) {return { due: false, reason: `${hour}:00 不在启用时段` }}

    // 静默时段
    if (isHourInQuietRange(hour, this.config.intervalQuietHours)) {
      return { due: false, reason: '静默时段' }
    }

    // 同一分钟不重复推
    const currentMinute = hour * 100 + minute
    if (currentMinute === lastPushMinute) {return { due: false, reason: '本分钟已检查过' }}

    // 冷却：同一时段 cooldownHours 内不重复
    const lastPushed = this.config.lastPushedAt[hour] || 0
    if (lastPushed > 0 && Date.now() - lastPushed < this.config.cooldownHours * 3600_000) {
      return { due: false, reason: '冷却中' }
    }

    return { due: true, slot: hour, reason: `命中时段 ${hour}:00` }
  }

  private checkAndPush(): void {
    if (this.inFlight) {return}
    const now = new Date()
    const check = this.isDueAt(now, this.lastPushMinute)
    if (!check.due || check.slot === undefined) {return}

    // 标记本分钟（无论后续成败，避免 60s 轮询在同分钟内重复进入）
    this.lastPushMinute = now.getHours() * 100 + now.getMinutes()

    console.log(`[NewsDigestScheduler] ⏰ ${check.reason}，开始推送`)
    void this.doPush(check.slot)
  }

  // ── ② 分级系统弹窗 ──

  /**
   * 对本批新闻分级，高优先级合并成 **一条** 系统通知（不做逐条弹窗）。
   * 任何异常都被吞掉 —— 通知失败不影响推送本身。
   */
  private notifyHighPriority(filtered: FilteredItem[], slotName: string): void {
    const sn = this.config.systemNotify
    if (!sn.enabled) {return}

    try {
      const { high } = classifyBatch(filtered, this.config.interests, {
        scoreThreshold: sn.scoreThreshold,
        majorCategories: sn.majorCategories,
        majorHotScore: sn.majorHotScore,
      })

      if (high.length === 0) {
        console.log('[NewsDigestScheduler] 🔕 无高优先级新闻，仅桌宠气泡 + 侧边栏')
        return
      }

      // 合并：同类通知合成一条，标题取首条，正文列前 3 条
      const top = high.slice(0, 3)
      const body = top
        .map((h, i) => `${i + 1}. ${h.item.item.title}\n   ${(h.item.oneLiner || h.item.item.summary || '').slice(0, 80)}`)
        .join('\n')
      const suffix = high.length > top.length ? `\n…等 ${high.length} 条重要新闻` : ''

      const notifier = getSystemNotifier()
      notifier.updateConfig({
        enabled: sn.enabled,
        minPriority: sn.minPriority,
        categoryCooldownMs: sn.categoryCooldownMs,
        windowMs: sn.windowMs,
        maxPerWindow: sn.maxPerWindow,
      })

      const outcome = notifier.notify({
        title: `📡 ${slotName} · ${high.length} 条重要新闻`,
        body: body + suffix,
        category: 'news',
        priority: 'high',
      })

      console.log(
        outcome.notified
          ? `[NewsDigestScheduler] 🔔 已弹系统通知（${high.length} 条高优先级）`
          : `[NewsDigestScheduler] 🔕 未弹系统通知: ${outcome.reason}`,
      )
    } catch (e: any) {
      console.warn('[NewsDigestScheduler] 系统通知异常（已忽略）:', e?.message || e)
    }
  }

  // ── ③ agent 整理 ──

  /**
   * 交给团队 agent 整理。开关关闭或失败 → 原样返回，不影响主流程。
   */
  private async organizeWithAgent(filtered: FilteredItem[]): Promise<FilteredItem[]> {
    const ao = this.config.agentOrganize
    if (!ao.enabled) {return filtered}

    try {
      const result = await organizeNewsWithAgent(filtered, {
        maxItems: ao.maxItems,
        agentId: ao.agentId,
        timeoutMs: ao.timeoutMs,
        maxRetries: ao.maxRetries,
        interests: this.config.interests,
      })

      if (result.organized) {
        console.log(`[NewsDigestScheduler] 🤖 ${ao.agentId} 整理完成: ${result.reason} (${result.elapsedMs}ms)`)
        return result.items
      }
      console.warn(`[NewsDigestScheduler] 🤖 agent 整理降级: ${result.reason}`)
      return filtered
    } catch (e: any) {
      console.warn('[NewsDigestScheduler] agent 整理异常，回退原始列表:', e?.message || e)
      return filtered
    }
  }

  /**
   * 执行一次推送
   */
  private async doPush(slot: PushTimeSlot): Promise<void> {
    if (this.inFlight) {
      console.log('[NewsDigestScheduler] 上一次推送尚未结束，跳过本次')
      return
    }
    this.inFlight = true

    const slotName = describeSlot(slot)
    console.log(`[NewsDigestScheduler] ${slotName}新闻推送开始...`)

    try {
      // 1. 采集
      const customSources = (this.config.customRssSources || [])
        .filter(Boolean)
        .map(url => ({
          url,
          name: new URL(url).hostname.replace(/^www\./, ''),
          category: 'tech' as const,
        }))
      const allItems = await collectAll({
        rss: this.config.sources.rss,
        baidu: this.config.sources.baidu || false,
        github: this.config.sources.github !== false,
        finance: this.config.sources.finance !== false,
        hn: this.config.sources.hackernews !== false,
        rssSources: customSources.length > 0 ? [
          ...(await import('./tools/impl/newsCollector')).DEFAULT_RSS_SOURCES,
          ...customSources,
        ] : undefined,
      })
      if (allItems.length === 0) {
        console.log('[NewsDigestScheduler] 无新闻内容')
        return
      }

      // 2. 去重（同源内）
      let newItems = deduplicate(allItems)

      // 2b. 跨源去重
      if (this.config.crossSourceDedup && newItems.length > 5) {
        try {
          const { mergeCrossSourceDuplicates } = await import('./tools/impl/newsDigest')
          const before = newItems.length
          newItems = mergeCrossSourceDuplicates(newItems)
          if (newItems.length < before) {
            console.log(`[NewsDigestScheduler] 跨源去重合并 ${before} → ${newItems.length} 条`)
          }
        } catch (e) {
          console.warn('[NewsDigestScheduler] 跨源去重失败，继续:', e)
        }
      }

      // 3. LLM 筛选
      let filtered: FilteredItem[]
      /** 本轮能不能调 LLM —— 决定邮件是「人话导读」还是「只有标题+网址」 */
      let llmCall: LLMCallFn | null = null
      try {
        const pm = getProviderManager()
        const activeConfig = pm?.getActiveConfig?.()
        if (activeConfig) {
          const provider = new LLMProvider({
            baseUrl: activeConfig.config.baseUrl,
            apiKey: activeConfig.config.apiKey,
            model: activeConfig.config.model,
            maxContextTokens: activeConfig.config.maxContextTokens || 256000,
          })
          llmCall = async (systemPrompt, userContent) => {
            const res = await provider.call({
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userContent },
              ],
              maxTokens: 4096,
              temperature: 0.3,
            })
            return res.text || ''
          }
          filtered = await filterWithLLM(newItems, llmCall, {
            interests: this.config.interests,
            maxItems: this.config.maxItems,
            minScore: this.config.minScore,
          })
        } else {
          filtered = buildHotnessFallback(newItems, this.config.maxItems, '热度排序')
        }
      } catch (e) {
        llmCall = null
        console.warn('[NewsDigestScheduler] LLM 筛选失败，使用热度降级:', e)
        filtered = buildHotnessFallback(newItems, this.config.maxItems, '热度排序（LLM 降级）')
      }

      if (filtered.length === 0) {
        console.log('[NewsDigestScheduler] 筛选后无推荐内容')
        return
      }

      // 3a. 分类配额平衡
      if (this.config.categoryQuota && Object.keys(this.config.categoryQuota).length > 0) {
        const quota = this.config.categoryQuota
        const grouped: Record<string, FilteredItem[]> = {}
        for (const f of filtered) {
          const cat = f.item.category
          if (!grouped[cat]) {grouped[cat] = []}
          grouped[cat].push(f)
        }
        const balanced: FilteredItem[] = []
        for (const [cat, items] of Object.entries(grouped)) {
          const limit = quota[cat]
          if (limit !== undefined && items.length > limit) {
            const sorted = items.sort((a, b) => b.relevanceScore - a.relevanceScore)
            balanced.push(...sorted.slice(0, limit))
            console.log(`[NewsDigestScheduler] 配额平衡: ${cat} ${items.length} → ${limit} 条`)
          } else {
            balanced.push(...items)
          }
        }
        const keptIds = new Set(balanced.map(f => f.item.id))
        filtered = filtered.filter(f => keptIds.has(f.item.id))
      }

      // 3b. 背景信息补充（异步，不阻塞推送）
      if (this.config.enrichment) {
        try {
          await enrichItemsBackground(filtered, this.config.interests)
        } catch (e) {
          console.warn('[NewsDigestScheduler] 背景补充失败:', e)
        }
      }

      // 3c. 🆕 团队 agent 整理（默认关闭；失败自动回退）
      filtered = await this.organizeWithAgent(filtered)

      if (filtered.length === 0) {
        console.log('[NewsDigestScheduler] 整理后无推荐内容，放弃本次推送')
        return
      }

      // 3d. 🆕 人性化叙述（仅在已接入 LLM 时跑；失败/没配 LLM → 退回极简）
      let narrative: DigestNarrative | null = null
      if (llmCall) {
        try {
          narrative = await narrateDigest(filtered, llmCall, {
            interests: this.config.interests,
            maxItems: this.config.maxItems,
          })
        } catch (e) {
          console.warn('[NewsDigestScheduler] 叙述异常，按简报发送:', e)
        }
      }
      console.log(
        narrative
          ? `[NewsDigestScheduler] ✍️ 叙述完成：导读 ${narrative.lead.length} 字 / 点评 ${narrative.items.length} 条`
          : '[NewsDigestScheduler] 本次按「标题+网址」简报发送（未接入 LLM 或叙述不可用）',
      )

      // 4. 组装邮件正文
      const dateStr = new Date().toLocaleDateString('zh-CN', {
        year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
      })
      const title = `📡 Lumina ${slotName}新闻 — ${dateStr}`

      const body = assembleDigestBody(filtered, {
        title, maxItems: this.config.maxItems, narrative,
      })
      const htmlBody = assembleDigestHTML(filtered, {
        title,
        maxItems: this.config.maxItems,
        bilingual: this.config.bilingual,
        narrative,
      })

      // 5. 发送到本地邮箱（自动触发 SMTP 外发）
      sendMail(title, body, 'normal', htmlBody)

      globalEventBus.emit('news:digest-pushed', {
        slot,
        slotName,
        title,
        count: filtered.length,
        time: new Date().toISOString(),
      })

      // 6. ② 系统弹窗（高优先级才弹；普通新闻保持气泡+侧边栏）
      this.notifyHighPriority(filtered, slotName)

      // 7. 更新推送记录
      this.config.lastPushedAt[slot] = Date.now()
      this.saveConfig()

      console.log(`[NewsDigestScheduler] ✅ ${slotName}推送完成 (${filtered.length} 条)`)
    } catch (err: any) {
      console.error(`[NewsDigestScheduler] ${slotName}推送失败:`, err.message)
    } finally {
      this.inFlight = false
    }
  }

  /**
   * 手动触发一次推送（供调试/测试/设置页「立即推送」用）
   */
  async triggerManualPush(slot?: PushTimeSlot): Promise<{ ok: boolean; count?: number; error?: string }> {
    const hour = normalizeHour(slot ?? new Date().getHours())
    try {
      await this.doPush(hour)
      return { ok: true }
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  }

  /** 重置推送冷却（允许立刻重推） */
  resetCooldown(): void {
    this.config.lastPushedAt = {}
    this.lastPushMinute = -1
    this.saveConfig()
  }
}

// ── 工具 ──

/** 无 LLM / LLM 失败时的热度降级列表 */
function buildHotnessFallback(items: NewsItem[], maxItems: number, reason: string): FilteredItem[] {
  return items
    .slice()
    .sort((a, b) => b.hotScore - a.hotScore)
    .slice(0, maxItems)
    .map(item => ({
      item,
      relevanceScore: item.hotScore,
      reason,
      oneLiner: item.summary.slice(0, 80),
      digest: item.summary,
      tags: [item.category],
    }))
}

// ── 单例 ──

let instance: NewsDigestScheduler | null = null

export function getNewsDigestScheduler(): NewsDigestScheduler {
  if (!instance) {
    instance = new NewsDigestScheduler()
  }
  return instance
}

export function initNewsDigestScheduler(): NewsDigestScheduler {
  const s = getNewsDigestScheduler()
  s.start()
  return s
}

/** 测试用：替换单例（不启动定时器） */
export function __setNewsDigestSchedulerForTest(s: NewsDigestScheduler | null): void {
  instance = s
}
