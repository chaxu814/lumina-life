// ============================================================
// newsDigestScheduler.ts — 📡 新闻推送调度器 (v1.0)
//
// 覆盖原始蓝图 1.3 "邮件模板 + 推送逻辑" 的调度缺失部分。
//
// 功能：
//   1. 每天 8:00 / 12:00 / 18:00 / 22:00 四个时段自动推送
//   2. 采集 → LLM 筛选 → 去重 → HTML 邮件 → 本地邮箱 + SMTP 外发
//   3. 用户可配置：推送开关、时段选择、兴趣标签、新闻源开关
//
// 依赖已有资产：
//   - newsCollector.collectAll()     — 四源采集
//   - newsFilter.filterWithLLM()     — LLM 智能筛选
//   - newsDigest.dedup()             — 去重
//   - newsDigest.assembleDigestHTML  — HTML 模板
//   - mailStore.sendMail()           — 本地存储 + SMTP 自动外发
// ============================================================

import { collectAll, type NewsItem } from './tools/impl/newsCollector'
import { filterWithLLM, type FilteredItem, type LLMCallFn } from './tools/impl/newsFilter'
import { enrichItemsBackground } from './tools/impl/newsEnricher'
import { deduplicate, assembleDigestBody, assembleDigestHTML } from './tools/impl/newsDigest'
import { sendMail } from './mailStore'
import { globalEventBus, BusEvents } from './eventBus'
import { getProviderManager } from './core/providerManager'
import { LLMProvider } from './core/llmProvider'
import * as path from 'path'
import * as fs from 'fs'
import { app } from 'electron'

// ═══════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════

export type PushTimeSlot = 8 | 12 | 18 | 22

export interface NewsDigestConfig {
  /** 总开关 */
  enabled: boolean
  /** 启用推送的时段（默认全部开启） */
  enabledSlots: PushTimeSlot[]
  /** 用户兴趣描述（传给 LLM 筛选） */
  interests: string
  /** 各新闻源开关 */
  sources: {
    rss: boolean
    zhihu: boolean
    finance: boolean
    github: boolean
    hackernews: boolean
    reddit: boolean
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
  /** 最近一次各时段的推送时间戳 */
  lastPushedAt: Record<number, number>
}

const DEFAULT_CATEGORY_QUOTA: Record<string, number> = {
  tech: 5,
  finance: 3,
  trending: 4,
  oss: 3,
  general: 5,
}

const DEFAULT_CONFIG: NewsDigestConfig = {
  enabled: true,
  enabledSlots: [8, 12, 18, 22],
  interests: 'AI科技、财经股市、热搜、开源项目、综合新闻',
  sources: { rss: true, zhihu: true, finance: true, github: true, hackernews: true, reddit: false },
  customRssSources: [],
  maxItems: 15,
  minScore: 20,
  crossSourceDedup: true,
  enrichment: true,
  bilingual: false,
  categoryQuota: { ...DEFAULT_CATEGORY_QUOTA },
  lastPushedAt: {},
}

// ═══════════════════════════════════════════════════════════
// 调度器实现
// ═══════════════════════════════════════════════════════════

class NewsDigestScheduler {
  private config: NewsDigestConfig
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly configPath: string
  /** 防止同一分钟内重复推送 */
  private lastPushMinute: number = -1

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
        const raw = fs.readFileSync(this.configPath, 'utf-8')
        const parsed = JSON.parse(raw)
        return { ...DEFAULT_CONFIG, ...parsed, lastPushedAt: { ...DEFAULT_CONFIG.lastPushedAt, ...parsed.lastPushedAt } }
      }
    } catch (e) {
      console.warn('[NewsDigestScheduler] 配置加载失败，使用默认:', e)
    }
    return { ...DEFAULT_CONFIG }
  }

  private saveConfig(): void {
    try {
      const dir = path.dirname(this.configPath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8')
    } catch (e) {
      console.warn('[NewsDigestScheduler] 配置保存失败:', e)
    }
  }

  // ── 公开配置 API ──

  getConfig(): NewsDigestConfig {
    return { ...this.config }
  }

  updateConfig(partial: Partial<NewsDigestConfig>): void {
    this.config = { ...this.config, ...partial }
    if (partial.lastPushedAt) {
      this.config.lastPushedAt = { ...this.config.lastPushedAt, ...partial.lastPushedAt }
    }
    this.saveConfig()
  }

  // ── 调度 ──

  start(): void {
    if (this.timer) return
    console.log('[NewsDigestScheduler] 📡 新闻推送调度器已启动 (8:00/12:00/18:00/22:00)')

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
   * 检查当前时间是否在推送窗口内
   */
  private checkAndPush(): void {
    if (!this.config.enabled) return

    const now = new Date()
    const hour = now.getHours()
    const minute = now.getMinutes()

    // 只在整点后 5 分钟内触发（8:00-8:05、12:00-12:05 等）
    if (minute > 5) return

    const slot = hour as PushTimeSlot
    if (![8, 12, 18, 22].includes(slot)) return
    if (!this.config.enabledSlots.includes(slot)) return

    // 同一分钟不重复推
    const currentMinute = hour * 100 + minute
    if (currentMinute === this.lastPushMinute) return
    this.lastPushMinute = currentMinute

    // 检查冷却：同一时段 23 小时内不重复
    const lastPushed = this.config.lastPushedAt[slot] || 0
    if (Date.now() - lastPushed < 23 * 3600_000) return

    this.doPush(slot)
  }

  /**
   * 执行一次推送
   */
  private async doPush(slot: PushTimeSlot): Promise<void> {
    const slotLabels: Record<number, string> = {
      8: '☀️ 早间', 12: '🌤️ 午间', 18: '🌆 傍晚', 22: '🌙 晚间',
    }
    const slotName = slotLabels[slot] || '📡'
    console.log(`[NewsDigestScheduler] ${slotName}新闻推送开始...`)

    try {
      // 1. 采集
      // 若用户有自定义 RSS 源，转为标准格式传给 collectAll
      const customSources = (this.config.customRssSources || [])
        .filter(Boolean)
        .map(url => ({
          url,
          name: new URL(url).hostname.replace(/^www\./, ''),
          category: 'tech' as const,
        }))
      const allItems = await collectAll({
        rss: this.config.sources.rss,
        zhihu: this.config.sources.zhihu,
        finance: this.config.sources.finance,
        github: this.config.sources.github,
        hackernews: this.config.sources.hackernews,
        reddit: this.config.sources.reddit,
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

      // 2b. 跨源去重（不同源报道同一件事）
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
          const llmCall: LLMCallFn = async (systemPrompt, userContent) => {
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
          // 无 provider 时仅做简单热度排序
          filtered = newItems.slice(0, this.config.maxItems).map(item => ({
            item,
            relevanceScore: item.hotScore,
            reason: '热度排序',
            oneLiner: item.summary.slice(0, 80),
            digest: item.summary,
            tags: [item.category],
          }))
        }
      } catch (e) {
        console.warn('[NewsDigestScheduler] LLM 筛选失败，使用热度降级:', e)
        filtered = newItems.slice(0, this.config.maxItems).map(item => ({
          item,
          relevanceScore: item.hotScore,
          reason: '热度排序（LLM 降级）',
          oneLiner: item.summary.slice(0, 80),
          digest: item.summary,
          tags: [item.category],
        }))
      }

      if (filtered.length === 0) {
        console.log('[NewsDigestScheduler] 筛选后无推荐内容')
        return
      }

      // 3a. 分类配额平衡（v2.0「雷达」升级）
      if (this.config.categoryQuota && Object.keys(this.config.categoryQuota).length > 0) {
        const quota = this.config.categoryQuota
        const grouped: Record<string, FilteredItem[]> = {}
        for (const f of filtered) {
          const cat = f.item.category
          if (!grouped[cat]) grouped[cat] = []
          grouped[cat].push(f)
        }
        const balanced: FilteredItem[] = []
        for (const [cat, items] of Object.entries(grouped)) {
          const limit = quota[cat]
          if (limit !== undefined && items.length > limit) {
            // 该分类超出配额，按相关性截断
            const sorted = items.sort((a, b) => b.relevanceScore - a.relevanceScore)
            balanced.push(...sorted.slice(0, limit))
            console.log(`[NewsDigestScheduler] 配额平衡: ${cat} ${items.length} → ${limit} 条`)
          } else {
            balanced.push(...items)
          }
        }
        // 按原顺序重新排列
        const keptIds = new Set(balanced.map(f => f.item.id))
        const reordered = filtered.filter(f => keptIds.has(f.item.id))
        filtered = reordered
        console.log(`[NewsDigestScheduler] 配额平衡后: ${filtered.length} 条（总）`)
      }

      // 3b. 背景信息补充（异步，不阻塞推送）
      if (this.config.enrichment) {
        try {
          await enrichItemsBackground(filtered, this.config.interests)
        } catch (e) {
          console.warn('[NewsDigestScheduler] 背景补充失败:', e)
        }
      }

      // 4. 组装邮件正文
      const dateStr = new Date().toLocaleDateString('zh-CN', {
        year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
      })
      const title = `📡 Lumina ${slotName}新闻 — ${dateStr}`

      // Markdown 正文（本地邮箱用）+ HTML（SMTP 用）
      const body = assembleDigestBody(filtered, { title, maxItems: this.config.maxItems })
      // 双语模式：传配置给 assembleDigestHTML
      const htmlBody = assembleDigestHTML(filtered, {
        title,
        maxItems: this.config.maxItems,
        bilingual: this.config.bilingual,
      })

      // 5. 发送到本地邮箱（自动触发 SMTP 外发）
      sendMail(title, body, 'normal')

      // 单独存储 HTML 版本供 SMTP 使用（mailStore 已支持）
      // 通过全局事件通知渲染进程
      globalEventBus.emit('news:digest-pushed', {
        slot,
        slotName,
        title,
        count: filtered.length,
        time: new Date().toISOString(),
      })

      // 6. 更新推送记录
      this.config.lastPushedAt[slot] = Date.now()
      this.saveConfig()

      console.log(`[NewsDigestScheduler] ✅ ${slotName}推送完成 (${filtered.length} 条)`)
    } catch (err: any) {
      console.error(`[NewsDigestScheduler] ${slotName}推送失败:`, err.message)
    }
  }

  /**
   * 手动触发一次推送（供调试/测试用）
   */
  async triggerManualPush(slot?: PushTimeSlot): Promise<{ ok: boolean; count?: number; error?: string }> {
    const targetSlot = slot || new Date().getHours() as PushTimeSlot
    if (![8, 12, 18, 22].includes(targetSlot)) {
      // 不在标准时段也允许手动触发（降级用当前小时）
      await this.doPush(targetSlot)
      return { ok: true }
    }
    await this.doPush(targetSlot)
    return { ok: true }
  }

  /** 重置推送冷却（允许立刻重推） */
  resetCooldown(): void {
    this.config.lastPushedAt = {}
    this.lastPushMinute = -1
    this.saveConfig()
  }
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
