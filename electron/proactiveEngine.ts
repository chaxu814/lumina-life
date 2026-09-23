// ============================================================
// proactiveEngine.ts — 24/7 主动对话引擎 (v2.5 增强版)
//
// 触发类型:
//   1. time     — cron 式定时话题 (早安/午安/晚安)
//   2. idle     — 监测用户不活跃时长
//   3. event    — 应用事件触发 (启动/长会话)
//   4. opportunity — 根据上次对话内容评估是否该搭话
//   5. screen_watch — 🆕 周期性屏幕感知搭话
//   6. hot_topic — 🆕 社交媒体热搜感知
//   7. personal_rhythm — 🆕 用户作息规律学习
//
// 屏幕感知流程（v6.2 恢复真·视觉）:
//   截图 → dHash 帧差节流（稳定画面不花钱）→ VLM 看懂屏幕具体内容
//   → 编排器评估是否值得搭话 → 现场生成台词与表情
//   "哇你在玩《原神》啊，这个胡桃的大招放早了！"
//   "看到你在 B 站看新番！是什么番呀？"
//   （v6.1 曾一度只保留窗口标题粗分类，v6.2 把眼睛接回来）
//
// 热搜感知流程:
//   获取B站/微博热搜 → LLM评估与用户相关性 → 生成搭话
//   "今天热搜上有XX事件，你有关注吗？"
//
// 🆕 Daily Paper 流程:
//   获取arXiv论文 → LLM筛选与摘要 → 生成每日论文推送
//   "今日arXiv精选: XX论文，简述..."
// ============================================================

import { EventEmitter } from 'events'
import * as cp from 'child_process'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'
import https from 'https'
import http from 'http'
import { Notification } from 'electron'
import { getAppIconPath } from './appIcon'
import { stripMarkdown } from './utils/stripMarkdown'
import { globalEventBus, BusEvents } from './eventBus'
import { postObservation, postThought } from './moments/autoPoster'  // 🌸 v2.10
import { hasTodayMomentWithKeyword } from './moments/momentsStore'  // 🔧 v2.12: 每日去重
import { llmCoordinator, PRIORITY } from './llmCoordinator'  // 🆕 v2.18: 智能 LLM 调度
import { getUsageStats } from './usageStats'  // 📊 v3.0: 使用数据统计
import { getAgentConfig } from './agentConfig'  // 配置访问
import { collectAll, type NewsItem } from './tools/impl/newsCollector'  // 🆕 Daily Paper
import { getProactiveOrchestrator } from './proactive/orchestrator'  // 🧭 v6.1 统一编排器
import { isNightTime } from './proactive/gate'  // 🌙 任务二：夜间勿扰（健康触发器双层保险）
import { describeScreenViaVlm } from './pet/vision/screenVision'  // 👁 v6.2 真·屏幕视觉（截图→dHash节流→VLM）

// ═══════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════

export type TriggerType = 'time' | 'idle' | 'event' | 'opportunity' | 'screen_watch' | 'hot_topic' | 'personal_rhythm' | 'daily_paper'

// ═══════════════════════════════════════════════════════════
// 🩺 健康关怀触发器（任务一）
//   water / eye / posture：独立 setInterval 调度，触发后统一汇入
//   orchestrator.onTrigger({ source:'health', payload:{healthType} })，
//   走现有 gate（场景概率/userSpeaking/privacy/夜间勿扰）+ maxDaily=80
//   + minInterval=120s + 7 级退避，不新增骚扰通道。
// ═══════════════════════════════════════════════════════════
export type HealthSubtype = 'water' | 'eye' | 'posture'

export interface HealthTriggerConfig {
  enabled: boolean
  /** 触发间隔（分钟） */
  intervalMinutes: number
  /** 上次触发时间戳 */
  lastTriggered?: number
}

export const HEALTH_DEFAULTS: Record<HealthSubtype, Omit<HealthTriggerConfig, 'lastTriggered'>> = {
  water: { enabled: true, intervalMinutes: 90 },
  eye: { enabled: true, intervalMinutes: 45 },
  posture: { enabled: true, intervalMinutes: 60 },
}

/** 健康类型 → 触发器 id（与 orchestrator triggerId 对齐） */
export const HEALTH_TRIGGER_IDS: Record<HealthSubtype, string> = {
  water: 'health-water',
  eye: 'health-eye',
  posture: 'health-posture',
}


export interface ProactiveTrigger {
  id: string
  type: TriggerType
  /** cron 表达式 或 条件描述 */
  condition: string
  /** 触发时的提示词模板 (可为空，由 LLM 动态生成) */
  template: string
  /** 是否启用 */
  enabled: boolean
  /** 冷却时间 (秒) */
  cooldown: number
  /** 上次触发时间戳 */
  lastTriggered?: number
  /** 优先级 0-10 */
  priority: number
}

export interface ProactiveEvent {
  trigger: ProactiveTrigger
  message: string
  timestamp: number
  delivered: boolean
}

export interface ProactiveConfig {
  enabled: boolean
  minIdleSeconds: number
  minIntervalSeconds: number
  maxDailyProactive: number
  useLlmPolish: boolean
  /** 🆕 屏幕监控间隔 (秒)，默认 300 (5分钟) */
  screenWatchIntervalSeconds: number
  /** 🆕 热搜检查间隔 (秒)，默认 1800 (30分钟) */
  hotTopicIntervalSeconds: number
  /** 🆕 是否启用屏幕感知 */
  screenWatchEnabled: boolean
  /** 🆕 是否启用热搜感知 */
  hotTopicEnabled: boolean
  /** 🆕 Daily Paper 检查间隔 (秒)，默认 86400 (24小时) */
  dailyPaperIntervalSeconds: number
  /** 🆕 是否启用 Daily Paper */
  dailyPaperEnabled: boolean
  /** 🔔 v2.9/v6.x: 是否启用 Windows 弹窗通知 */
  notificationsEnabled: boolean
}

/* ---------- 通知兼容层 ---------- */
function safeNotify(title: string, body: string, icon?: string): void {
  try {
    if (typeof Notification === 'undefined') {return}
    if (!Notification.isSupported()) {return}

    // 先显式请求/检查权限，Windows 上 Electron 有时不会自动弹权限
    const notify = Notification as any
    if (typeof notify.requestPermission === 'function') {
      notify.requestPermission(() => { /* noop */ })
    }

    const n = new Notification({ title: stripMarkdown(title), body: stripMarkdown(body), icon, silent: false })
    n.on('click', () => {
      try {
        // 优先使用应用主窗口单例，避免 getMainWindow  thinly 问题
        const win = (globalThis as any).__luminaMainWindow || require('electron').BrowserWindow.getAllWindows()[0]
        if (win) { win.show(); win.focus() }
      } catch {}
    })
    n.on('failed', () => {
      // 通知失败时不再抛错，避免阻塞主动引擎
    })
    n.show()
  } catch {
    // 静默降级
  }
}

// ═══════════════════════════════════════════════════════════
// 屏幕感知（v6.2）
//
// 由 pet/vision/screenVision.describeScreenViaVlm 统一完成：
//   截图 → dHash 帧差节流（稳定画面不花钱）→ VLM 看懂屏幕具体内容 → 安全降级。
// 本模块只保留一个「最近一次看到的屏幕」快照，供 getLastScreenContext 查询。
// v6.1 曾一度只读 ScreenAwareness.scene 粗分类；v6.2 已恢复真·视觉理解。
// ════════════════════════════════════════════════════════════

interface ScreenContext {
  activity: string
  apps: string[]
  summary: string
  shouldComment: boolean
  commentSuggestions: string[]
  timestamp: number
}

let lastScreenContext: ScreenContext | null = null

// ═══════════════════════════════════════════════════════════
// 热搜感知模块
// ═══════════════════════════════════════════════════════════

interface HotTopic {
  title: string
  source: string
  url: string
  hot: string
}

/** 获取B站热搜 */
async function fetchBilibiliHot(): Promise<HotTopic[]> {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.bilibili.com',
      path: '/x/web-interface/wbi/search/square?limit=10',
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.bilibili.com',
      },
      timeout: 10000,
    }
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => {
        try {
          const json = JSON.parse(data)
          const list = (json?.data?.trending?.list || []).map((item: any) => ({
            title: item.keyword || item.show_name || '',
            source: 'bilibili',
            url: `https://search.bilibili.com/all?keyword=${encodeURIComponent(item.keyword || '')}`,
            hot: item.show_name || '',
          }))
          resolve(list.slice(0, 10))
        } catch { resolve([]) }
      })
    })
    req.on('error', () => resolve([]))
    req.on('timeout', () => { req.destroy(); resolve([]) })
    req.end()
  })
}

/** 获取微博热搜 */
async function fetchWeiboHot(): Promise<HotTopic[]> {
  return new Promise((resolve) => {
    const options = {
      hostname: 'weibo.com',
      path: '/ajax/side/hotSearch',
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'X-Requested-With': 'XMLHttpRequest',
      },
      timeout: 10000,
    }
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => {
        try {
          const json = JSON.parse(data)
          const list = (json?.data?.realtime || []).slice(0, 10).map((item: any) => ({
            title: item.note || item.word || '',
            source: 'weibo',
            url: `https://s.weibo.com/weibo?q=${encodeURIComponent(item.word || '')}`,
            hot: item.num ? `${item.num}万` : '',
          }))
          resolve(list)
        } catch { resolve([]) }
      })
    })
    req.on('error', () => resolve([]))
    req.on('timeout', () => { req.destroy(); resolve([]) })
    req.end()
  })
}

// 注：v6.1 起，热搜/论文的「选话题+生成搭话」统一交给编排器 generator 现场 LLM 生成，
// 本模块只负责把热搜/论文标题抓回来作为 externalTopics 喂给编排器。

// ═══════════════════════════════════════════════════════════
// 🆕 Daily Paper 模块
// ═══════════════════════════════════════════════════════════

interface Paper {
  title: string
  source: string
  url: string
  summary: string
}

/** 获取arXiv论文列表 (复用newsCollector) */
async function fetchArxivPapers(): Promise<Paper[]> {
  try {
    const items = await collectAll({ arxiv: true, rss: false, baidu: false })
    return items
      .filter((item: NewsItem) => item.category === 'paper')
      .slice(0, 15)
      .map((item: NewsItem) => ({
        title: item.title,
        source: item.source,
        url: item.url,
        summary: item.summary.slice(0, 300),
      }))
  } catch {
    return []
  }
}

// ═══════════════════════════════════════════════════════════
// 默认触发策略
// ═══════════════════════════════════════════════════════════

const DEFAULT_TRIGGERS: ProactiveTrigger[] = [
  // ── 时间触发 ─────────────────────────────────
  {
    id: 'morning-greeting',
    type: 'time',
    condition: '0 8 * * *',
    template: '',
    enabled: true,
    cooldown: 3600,
    priority: 5,
  },
  {
    id: 'noon-reminder',
    type: 'time',
    condition: '0 12 * * *',
    template: '',
    enabled: true,
    cooldown: 3600,
    priority: 6,
  },
  {
    id: 'afternoon-break',
    type: 'time',
    condition: '0 15 * * *',
    template: '',
    enabled: true,
    cooldown: 3600,
    priority: 4,
  },
  {
    id: 'evening-wrapup',
    type: 'time',
    condition: '0 18 * * *',
    template: '',
    enabled: false,
    cooldown: 3600,
    priority: 5,
  },
  {
    id: 'night-reminder',
    type: 'time',
    condition: '0 22 * * *',
    template: '',
    enabled: true,
    cooldown: 3600,
    priority: 7,
  },

  // ── 空闲触发 ─────────────────────────────────
  {
    id: 'idle-10min',
    type: 'idle',
    condition: 'idle:600',
    template: '',
    enabled: true,
    cooldown: 1800,
    priority: 3,
  },
  {
    id: 'idle-30min',
    type: 'idle',
    condition: 'idle:1800',
    template: '',
    enabled: true,
    cooldown: 3600,
    priority: 2,
  },

  // ── 事件触发 ─────────────────────────────────
  {
    id: 'startup-greeting',
    type: 'event',
    condition: 'app:start',
    template: '',  // 🔧 v3.9: 留空，由 LLM 动态生成（回退到 TIME_TEMPLATES）
    enabled: true,
    cooldown: 60,
    priority: 8,
  },
  {
    id: 'long-session',
    type: 'event',
    condition: 'session:2h',
    template: '',
    enabled: false,
    cooldown: 7200,
    priority: 4,
  },
  {
    id: 'daily-paper',
    type: 'daily_paper',
    condition: '0 8 * * *',
    template: '',
    enabled: true,
    cooldown: 86400,
    priority: 7,
  },

  // ── 👁 屏幕感知 ──────────────────────────────
  {
    id: 'screen-watch',
    type: 'screen_watch',
    condition: 'interval:120',  // v6.2: 600→120（每 2 分钟看一眼屏幕）
    template: '',
    enabled: true,
    cooldown: 120,
    priority: 6,
  },

  // ── 🆕 热搜感知 ──────────────────────────────
  {
    id: 'hot-topic',
    type: 'hot_topic',
    condition: 'interval:1800',
    template: '',
    enabled: true,              // 🔧 v3.9: 默认开启
    cooldown: 3600,
    priority: 5,
  },

  // ── 🆕 作息规律 ──────────────────────────────
  {
    id: 'personal-rhythm-start',
    type: 'personal_rhythm',
    condition: 'session:start',
    template: '',
    enabled: false,
    cooldown: 600,
    priority: 7,
  },
  {
    id: 'personal-rhythm-lunch',
    type: 'personal_rhythm',
    condition: 'learned:lunch',
    template: '',
    enabled: false,
    cooldown: 3600,
    priority: 5,
  },
  {
    id: 'personal-rhythm-coffee',
    type: 'personal_rhythm',
    condition: 'learned:afternoon',
    template: '',
    enabled: false,
    cooldown: 3600,
    priority: 4,
  },

  // ── 🆕 机会感知 ──────────────────────────────
  {
    id: 'opportunity-after-chat',
    type: 'opportunity',
    condition: 'gap:120',
    template: '',
    enabled: false,
    cooldown: 1800,
    priority: 3,
  },
]

// ═══════════════════════════════════════════════════════════
// 时间模板 (LLM 不可用时回退)
// ═══════════════════════════════════════════════════════════

const TIME_TEMPLATES: Record<string, string> = {
  'startup-greeting': '嗨，又见面啦~ ✨',
  'morning-greeting': '早上好呀~ 🌤️ 今天天气不错呢，要不要出去走走？',
  'noon-reminder': '肚子咕咕叫了~ 🍚 该吃饭啦',
  'afternoon-break': '下午困了吗~ ☕ 起来活动活动？',
  'evening-wrapup': '今天过得怎么样呀~ 🌆 有没有什么开心的事？',
  'night-reminder': '夜深了~ 💤 别太拼了，早点休息',
  'idle-10min': '嘿，在忙啥呢~ 😊 我在这等你',
  'idle-30min': '好久不见啦~ 💭 我还在这儿陪着你',
  'long-session': '你已经连续用了好久了~ 👀 起来伸个懒腰？',
  'personal-rhythm-lunch': '到饭点啦！🍜 今天中午吃什么呀？',
  'personal-rhythm-coffee': '下午茶时间到~ ☕ 要不要来杯咖啡？',
  'opportunity-after-chat': '刚才聊的话题挺有意思的~ 🤔 我想了想……',
  'daily-paper': '今日arXiv精选，来看看有没有感兴趣的研究方向 📚',
}

// ═══════════════════════════════════════════════════════════
// 引擎类
// ═══════════════════════════════════════════════════════════

export class ProactiveEngine extends EventEmitter {
  private triggers: ProactiveTrigger[] = []
  private history: ProactiveEvent[] = []
  private config: ProactiveConfig
  private lastActivity: number = Date.now()
  private lastProactive: number = 0
  private dailyCount: number = 0
  private checkTimer: ReturnType<typeof setInterval> | null = null
  private screenWatchTimer: ReturnType<typeof setInterval> | null = null
  private hotTopicTimer: ReturnType<typeof setInterval> | null = null
  private dailyResetTimer: ReturnType<typeof setInterval> | null = null
  private isScreenWatchRunning = false
  private isHotTopicRunning = false
  private isDailyPaperRunning = false
  private dailyPaperTimer: ReturnType<typeof setInterval> | null = null
  private rhythmTimer: ReturnType<typeof setInterval> | null = null

  // 🩺 健康关怀触发器（任务一）
  private healthTimers: Partial<Record<HealthSubtype, ReturnType<typeof setInterval>>> = {}
  private healthConfig: Record<HealthSubtype, HealthTriggerConfig> = {
    water: { ...HEALTH_DEFAULTS.water },
    eye: { ...HEALTH_DEFAULTS.eye },
    posture: { ...HEALTH_DEFAULTS.posture },
  }

  // 作息学习 + 机会感知
  private activityLog: number[] = []
  private lastUserMessageTime: number = 0
  private opportunityCheckTimer: ReturnType<typeof setInterval> | null = null

  /**
   * 初始化主动对话引擎
   * @param config - 可选的部分配置覆盖，未指定项使用默认值
   * @default 默认启用，屏幕感知和热搜感知 v3.9 起默认开启
   */
  constructor(config?: Partial<ProactiveConfig>) {
    super()
    this.config = {
      enabled: true,
      minIdleSeconds: 300,
      minIntervalSeconds: 120,   // v6.2: 600→120（主动发言最小间隔 2 分钟）
      maxDailyProactive: 80,     // v6.2: 20→80（日上限）
      useLlmPolish: false,
      screenWatchIntervalSeconds: 120, // v6.2: 600→120（每 2 分钟感知一次屏幕）
      hotTopicIntervalSeconds: 1800,
      screenWatchEnabled: true,         // 🔧 v3.9: 默认开启
      hotTopicEnabled: true,            // 🔧 v3.9: 默认开启
      dailyPaperIntervalSeconds: 86400, // 🆕 Daily Paper 24小时间隔
      dailyPaperEnabled: true,          // 🆕 默认开启
      notificationsEnabled: true,       // 🔧 v3.9.1: 默认开启Windows通知
      ...config,
    }
    // 从文件加载用户保存的触发器状态
    this.triggers = this.loadTriggersFromFile()
  }

  /**
   * 🔧 v2.14: 从文件加载触发器配置，保留用户设置
   */
  private getTriggersFilePath(): string {
    return path.join(os.homedir(), '.lumina', 'proactive_triggers.json')
  }

  private loadTriggersFromFile(): ProactiveTrigger[] {
    try {
      const filePath = this.getTriggersFilePath()
      if (fs.existsSync(filePath)) {
        const saved = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
        console.log('[ProactiveEngine] 从文件加载触发器配置')
        // 合并：用保存的 enabled 覆盖默认值
        return DEFAULT_TRIGGERS.map(dt => {
          const st = saved.find((t: any) => t.id === dt.id)
          if (st) {
            return { ...dt, enabled: st.enabled, lastTriggered: st.lastTriggered, cooldown: st.cooldown ?? dt.cooldown }
          }
          return dt
        })
      }
    } catch (e) {
      console.warn('[ProactiveEngine] 加载触发器配置失败:', e)
    }
    return [...DEFAULT_TRIGGERS]
  }

  private saveTriggersToFile(): void {
    try {
      const dir = path.dirname(this.getTriggersFilePath())
      if (!fs.existsSync(dir)) {fs.mkdirSync(dir, { recursive: true })}
      const data = this.triggers.map(t => ({
        id: t.id,
        enabled: t.enabled,
        lastTriggered: t.lastTriggered,
        cooldown: t.cooldown,
        type: t.type,
      }))
      fs.writeFileSync(this.getTriggersFilePath(), JSON.stringify(data, null, 2), 'utf-8')
    } catch (e) {
      console.warn('[ProactiveEngine] 保存触发器配置失败:', e)
    }
  }

  /**
   * 🔧 v2.14: 手动测试触发
   */
  async testTrigger(id: string): Promise<void> {
    const trigger = this.triggers.find(t => t.id === id)
    if (!trigger) {throw new Error(`触发器 ${id} 不存在`)}
    if (!trigger.enabled) {throw new Error(`触发器 ${id} 未启用`)}
    this.activate(trigger)
  }

  /**
   * 启动引擎：注册所有定时器、屏幕感知、热搜监控、作息学习、机会感知
   * 仅在 `config.enabled === true` 时生效
   */
  start(): void {
    if (!this.config.enabled) {return}

    // 每分钟检查常规触发器
    this.checkTimer = setInterval(() => this.checkTriggers(), 60000)

    // 🆕 屏幕监控
    const screenWatchTrigger = this.triggers.find(t => t.id === 'screen-watch')
    if (this.config.screenWatchEnabled && screenWatchTrigger) {
      screenWatchTrigger.enabled = true
      this.screenWatchTimer = setInterval(
        () => this.runScreenWatch(),
        this.config.screenWatchIntervalSeconds * 1000
      )
      // 首次延迟 15 秒执行（v6.2: 30s→15s，开机后更快进入"她在看"的状态）
      setTimeout(() => this.runScreenWatch(), 15000)
    }

    // 🆕 热搜监控
    const hotTopicTrigger = this.triggers.find(t => t.id === 'hot-topic')
    if (this.config.hotTopicEnabled && hotTopicTrigger) {
      hotTopicTrigger.enabled = true
      this.hotTopicTimer = setInterval(
        () => this.runHotTopicCheck(),
        this.config.hotTopicIntervalSeconds * 1000
      )
      setTimeout(() => this.runHotTopicCheck(), 60000)
    }

    // 每天 0 点重置计数
    this.dailyResetTimer = setInterval(() => {
      this.dailyCount = 0
      getProactiveOrchestrator().resetDailyCount()
    }, this.msUntilMidnight())

    // 作息学习 (每30分钟检查一次)
    this.rhythmTimer = setInterval(() => this.runPersonalRhythm(), 30 * 60000)

    // 🆕 Daily Paper 监控 (每日一次)
    const dailyPaperTrigger = this.triggers.find(t => t.id === 'daily-paper')
    if (this.config.dailyPaperEnabled && dailyPaperTrigger) {
      dailyPaperTrigger.enabled = true
      this.dailyPaperTimer = setInterval(
        () => this.runDailyPaperCheck(),
        this.config.dailyPaperIntervalSeconds * 1000
      )
      // 首次延迟10秒执行
      setTimeout(() => this.runDailyPaperCheck(), 10000)
    }

    // 机会感知 (监听聊天间隙)
    this.startOpportunityCheck()

    // 🩺 健康关怀（任务一）：water/eye/posture 独立 setInterval，触发后走统一编排器 gate
    this.startHealthTimers()

    // 🧭 v6.1：配置并启动统一编排器（内驱力硬触发/退避/未答话头）
    // 新行为开关默认开启；沿用现有 config 结构，未配置时全部 true。
    const orch = getProactiveOrchestrator()
    orch.configure({
      maxDaily: this.config.maxDailyProactive,
      minIntervalMs: this.config.minIntervalSeconds * 1000,
      backoffEnabled: (this.config as any).backoffEnabled !== false,
      driveHardTriggerEnabled: (this.config as any).driveHardTriggerEnabled !== false,
      innerThoughtsEnabled: (this.config as any).innerThoughtsEnabled !== false,
      followupTopicsEnabled: (this.config as any).followupTopicsEnabled !== false,
    })
    orch.start()

    const enabledCount = this.triggers.filter(t => t.enabled).length
    const extraInfo = [
      this.config.screenWatchEnabled ? '屏幕感知' : '',
      this.config.hotTopicEnabled ? '热搜感知' : '',
      this.config.dailyPaperEnabled ? 'Daily Paper' : '',
    ].filter(Boolean).join('+')
    console.log(`[ProactiveEngine] 已启动 (${enabledCount} 个触发器${extraInfo ? ', ' + extraInfo : ''})`)
  }

  /**
   * 停止引擎：清除所有定时器，释放资源
   */
  stop(): void {
    if (this.checkTimer) {clearInterval(this.checkTimer)}
    if (this.screenWatchTimer) {clearInterval(this.screenWatchTimer)}
    if (this.hotTopicTimer) {clearInterval(this.hotTopicTimer)}
    if (this.dailyResetTimer) {clearInterval(this.dailyResetTimer)}
    if (this.rhythmTimer) {clearInterval(this.rhythmTimer)}
    if (this.dailyPaperTimer) {clearInterval(this.dailyPaperTimer)}
    // 🩺 健康关怀定时器
    for (const k of Object.keys(this.healthTimers) as HealthSubtype[]) {
      if (this.healthTimers[k]) {clearInterval(this.healthTimers[k] as ReturnType<typeof setInterval>)}
    }
    this.healthTimers = {}
    this.stopOpportunityCheck()
    this.checkTimer = null
    this.screenWatchTimer = null
    this.hotTopicTimer = null
    this.dailyResetTimer = null
    this.rhythmTimer = null
    this.dailyPaperTimer = null
  }

  /**
   * 更新配置并热重启引擎（stop → merge config → start）
   * @param partial - 要更新的配置字段
   */
  updateConfig(partial: Partial<ProactiveConfig>): void {
    this.config = { ...this.config, ...partial }
    // 同步屏幕/热搜开关到对应的触发器
    if (partial.screenWatchEnabled !== undefined) {
      const t = this.triggers.find(t => t.id === 'screen-watch')
      if (t) {t.enabled = partial.screenWatchEnabled}
    }
    if (partial.hotTopicEnabled !== undefined) {
      const t = this.triggers.find(t => t.id === 'hot-topic')
      if (t) {t.enabled = partial.hotTopicEnabled}
    }
    if (partial.dailyPaperEnabled !== undefined) {
      const t = this.triggers.find(t => t.id === 'daily-paper')
      if (t) {t.enabled = partial.dailyPaperEnabled}
    }
    this.saveTriggersToFile()
    this.stop()
    this.start()
  }

  // ── 👁 屏幕感知（v6.2：恢复真·VLM 视觉理解）──────────────
  //
  // 流程：dHash 节流判定 → 画面真的变了才截图问 VLM（描述屏幕具体内容 + 值不值得搭话）
  //       → 把"她看到了什么"作为 screenSummary 喂给编排器现场生成台词和表情。
  // 稳定画面（captured=false）只更新缓存、不消耗主动配额、不打扰；
  // 纯文本模型 / 无 Key / 截图失败 → screenVision 内部安全降级为窗口标题。
  private async runScreenWatch(): Promise<void> {
    if (this.isScreenWatchRunning) {return}
    if (this.dailyCount >= this.config.maxDailyProactive) {return}
    if (Date.now() - this.lastProactive < this.config.minIntervalSeconds * 1000) {return}
    if (!llmCoordinator.requestPermission('Proactive.ScreenWatch', PRIORITY.PROACTIVE)) {return}

    this.isScreenWatchRunning = true
    try {
      const vision = await describeScreenViaVlm(false, Date.now())

      // 无论是否触发，都缓存最近一次"看到"的快照，供 getLastScreenContext / 聊天上下文查询
      lastScreenContext = {
        activity: vision.scene,
        apps: vision.processName ? [vision.processName] : [],
        summary: vision.detail,
        shouldComment: vision.worthComment >= 0.4,
        commentSuggestions: [],
        timestamp: Date.now(),
      }

      // 画面稳定（没新内容）→ 不花钱、不打扰、不消耗主动配额，本轮静默
      if (!vision.captured) {return}

      const trigger = this.triggers.find(t => t.id === 'screen-watch')
      if (trigger) {this.markTriggerFired(trigger)}
      await getProactiveOrchestrator().onTrigger({
        source: 'screen',
        triggerId: 'screen-watch',
        scene: vision.scene,
        // 🆕 真·屏幕内容：她现在知道主人在玩《原神》、在看哪个视频、在写什么代码
        screenSummary: vision.detail,
        payload: {
          saw: vision.saw,
          worthComment: vision.worthComment,
          windowTitle: vision.windowTitle || '',
          change: vision.change,
        },
      })
    } catch (err) {
      console.error('[ProactiveEngine] 屏幕监控异常:', err)
    } finally {
      this.isScreenWatchRunning = false
      llmCoordinator.releasePermission('Proactive.ScreenWatch')
    }
  }

  // ── 🆕 热搜感知 ──────────────────────────────────────

  private async runHotTopicCheck(): Promise<void> {
    if (this.isHotTopicRunning) {return}
    if (this.dailyCount >= this.config.maxDailyProactive) {return}
    if (Date.now() - this.lastProactive < this.config.minIntervalSeconds * 1000) {return}
    if (!llmCoordinator.requestPermission('Proactive.HotTopic', PRIORITY.PROACTIVE)) {return}

    this.isHotTopicRunning = true
    try {
      const [biliTopics, weiboTopics] = await Promise.all([
        fetchBilibiliHot(),
        fetchWeiboHot(),
      ])
      const allTopics = [...biliTopics, ...weiboTopics]
      if (allTopics.length === 0) {return}

      const trigger = this.triggers.find(t => t.id === 'hot-topic')
      if (trigger) {this.markTriggerFired(trigger)}
      // v6.1：选话题+生成搭话交给编排器 generator
      await getProactiveOrchestrator().onTrigger({
        source: 'hot_topic',
        triggerId: 'hot-topic',
        externalTopics: allTopics.slice(0, 6).map(t => t.title),
      })
    } catch (err) {
      console.error('[ProactiveEngine] 热搜检查异常:', err)
    } finally {
      this.isHotTopicRunning = false
      llmCoordinator.releasePermission('Proactive.HotTopic')
    }
  }

  // ── 🆕 Daily Paper ──────────────────────────────────────

  private async runDailyPaperCheck(): Promise<void> {
    if (this.isDailyPaperRunning) {return}
    if (this.dailyCount >= this.config.maxDailyProactive) {return}
    if (Date.now() - this.lastProactive < this.config.minIntervalSeconds * 1000) {return}
    if (!llmCoordinator.requestPermission('Proactive.DailyPaper', PRIORITY.PROACTIVE)) {return}

    this.isDailyPaperRunning = true
    try {
      const papers = await collectAll({ arxiv: true, rss: false, baidu: false })

      // 筛选 paper 类别
      const paperItems = papers.filter((p: NewsItem) => p.category === 'paper')
      if (paperItems.length === 0) {return}

      const trigger = this.triggers.find(t => t.id === 'daily-paper')
      if (trigger) {this.markTriggerFired(trigger)}
      // v6.1：选论文+生成搭话交给编排器 generator
      await getProactiveOrchestrator().onTrigger({
        source: 'daily_paper',
        triggerId: 'daily-paper',
        externalTopics: paperItems.slice(0, 6).map(p => p.title),
      })
    } catch (err) {
      console.error('[ProactiveEngine] Daily Paper 检查异常:', err)
    } finally {
      this.isDailyPaperRunning = false
      llmCoordinator.releasePermission('Proactive.DailyPaper')
    }
  }

  // ── 🆕 作息规律学习 ──────────────────────────────

  private async runPersonalRhythm(): Promise<void> {
    // 收集最近7天的活动数据，识别规律
    const now = Date.now()
    const weekAgo = now - 7 * 86400000
    this.activityLog = this.activityLog.filter(t => t > weekAgo)

    // 按小时统计活跃频率
    const hourCounts = new Array(24).fill(0)
    for (const t of this.activityLog) {
      const h = new Date(t).getHours()
      hourCounts[h]++
    }

    // 找高频活跃时段（>3次记录）
    const activeHours = hourCounts
      .map((count, hour) => ({ hour, count }))
      .filter(h => h.count >= 3)
      .map(h => h.hour)

    // 11-13点为午餐时段，14-16点为下午茶
    const lunchTrigger = this.triggers.find(t => t.id === 'personal-rhythm-lunch')
    const coffeeTrigger = this.triggers.find(t => t.id === 'personal-rhythm-coffee')

    const currentHour = new Date().getHours()
    const currentMinute = new Date().getMinutes()

    if (lunchTrigger && lunchTrigger.enabled && currentHour >= 11 && currentHour <= 13) {
      if (currentMinute >= 30 && currentMinute <= 35) {
        this.markTriggerFired(lunchTrigger)
        void getProactiveOrchestrator().onTrigger({ source: 'rhythm', triggerId: lunchTrigger.id, externalTopics: ['午饭'] })
      }
    }

    if (coffeeTrigger && coffeeTrigger.enabled && currentHour >= 14 && currentHour <= 16) {
      if (currentMinute >= 25 && currentMinute <= 30) {
        this.markTriggerFired(coffeeTrigger)
        void getProactiveOrchestrator().onTrigger({ source: 'rhythm', triggerId: coffeeTrigger.id, externalTopics: ['下午茶'] })
      }
    }

    // 如果学到了明确的作息时间，log 出来
    if (activeHours.length > 0) {
      console.log(`[ProactiveEngine] 学到的活跃时段: ${activeHours.map(h => `${h}:00`).join(', ')}`)
    }
  }

  // ── 🆕 机会感知 ──────────────────────────────────────

  /** 记录用户发送消息（供聊天面板调用，驱动机会感知） */
  noteUserMessage(): void {
    this.lastUserMessageTime = Date.now()
    getProactiveOrchestrator().noteUserInteraction() // v6.1：用户互动→退避清零
  }

  private startOpportunityCheck(): void {
    if (this.opportunityCheckTimer) {return}
    this.opportunityCheckTimer = setInterval(() => this.runOpportunityCheck(), 60000)
  }

  private stopOpportunityCheck(): void {
    if (this.opportunityCheckTimer) {
      clearInterval(this.opportunityCheckTimer)
      this.opportunityCheckTimer = null
    }
  }

  // ── 🩺 健康关怀（任务一）──────────────────────────────

  /** 启动三类健康定时器（已启用的才起；间隔可由配置覆盖） */
  private startHealthTimers(): void {
    for (const type of ['water', 'eye', 'posture'] as HealthSubtype[]) {
      if (this.healthTimers[type]) {continue}
      const cfg = this.healthConfig[type]
      if (!cfg.enabled) {continue}
      const ms = Math.max(1, cfg.intervalMinutes) * 60_000
      const timer = setInterval(() => { try { this.runHealthReminder(type) } catch { /* 不阻塞 */ } }, ms)
      if (typeof (timer as any)?.unref === 'function') {(timer as any).unref()}
      this.healthTimers[type] = timer
    }
  }

  /** 重新调度某一类健康定时器（配置变更后调用） */
  private rescheduleHealthTimer(type: HealthSubtype): void {
    if (this.healthTimers[type]) {
      clearInterval(this.healthTimers[type] as ReturnType<typeof setInterval>)
      this.healthTimers[type] = undefined
    }
    // 仅在引擎已启动（checkTimer 非空）时重建，避免未启动就起定时器
    if (this.checkTimer && this.healthConfig[type].enabled) {
      const ms = Math.max(1, this.healthConfig[type].intervalMinutes) * 60_000
      const timer = setInterval(() => { try { this.runHealthReminder(type) } catch { /* 不阻塞 */ } }, ms)
      if (typeof (timer as any)?.unref === 'function') {(timer as any).unref()}
      this.healthTimers[type] = timer
    }
  }

  /**
   * 跑一次健康提醒：先做廉价前置过滤（夜间/配额/最小间隔），
   * 再交给统一编排器走完整 gate（场景概率/userSpeaking/退避）。
   */
  private runHealthReminder(type: HealthSubtype): void {
    const cfg = this.healthConfig[type]
    if (!cfg || !cfg.enabled) {return}
    // 夜间勿扰双层保险（gate 也会拦，这里提前短路不白叫编排器）
    if (isNightTime()) {return}
    if (this.dailyCount >= this.config.maxDailyProactive) {return}
    if (Date.now() - this.lastProactive < this.config.minIntervalSeconds * 1000) {return}
    this.triggerHealth(type)
  }

  /**
   * 手动触发一次健康关怀（测试按钮/缩短间隔验证用）。
   * 不走夜间/前置过滤，直接进编排器 gate（gate 仍会按场景/退避决定说不说）。
   */
  triggerHealth(type: HealthSubtype): void {
    const now = Date.now()
    this.healthConfig[type].lastTriggered = now
    // 同步引擎旧簿记（与 screen_watch 一致，供设置面板 getStatus 查询）
    this.lastProactive = now
    this.dailyCount++
    void getProactiveOrchestrator().onTrigger({
      source: 'health',
      triggerId: HEALTH_TRIGGER_IDS[type],
      // 编排器会自动从 screenGate 拿当前场景；记忆由 orchestrator.buildMemorySnippet 组装
      payload: { healthType: type },
    })
  }

  /** 查询某类健康触发器当前配置 */
  getHealthTriggerConfig(type: HealthSubtype): HealthTriggerConfig {
    return { ...this.healthConfig[type] }
  }

  /**
   * 更新某类健康触发器配置（enabled / intervalMinutes）。
   * 变更后自动重排定时器；不持久化到文件（与现有触发器文件解耦，配置接口留好）。
   */
  setHealthTriggerConfig(type: HealthSubtype, patch: Partial<Pick<HealthTriggerConfig, 'enabled' | 'intervalMinutes'>>): void {
    if (patch.enabled !== undefined) {this.healthConfig[type].enabled = !!patch.enabled}
    if (patch.intervalMinutes !== undefined) {
      const mins = Number(patch.intervalMinutes)
      this.healthConfig[type].intervalMinutes = Number.isFinite(mins) && mins > 0 ? mins : HEALTH_DEFAULTS[type].intervalMinutes
    }
    this.rescheduleHealthTimer(type)
  }

  private runOpportunityCheck(): void {
    if (this.lastUserMessageTime === 0) {return}
    if (this.dailyCount >= this.config.maxDailyProactive) {return}

    const trigger = this.triggers.find(t => t.id === 'opportunity-after-chat')
    if (!trigger || !trigger.enabled) {return}

    const gapSeconds = Math.floor((Date.now() - this.lastUserMessageTime) / 1000)
    const thresholdMatch = trigger.condition.match(/^gap:(\d+)$/)
    const threshold = thresholdMatch ? parseInt(thresholdMatch[1]) : 120

    if (gapSeconds >= threshold && gapSeconds < threshold + 60) {
      // 用户聊天后停顿了一段时间，是搭话的好时机 → 交给编排器现场生成
      this.markTriggerFired(trigger)
      void getProactiveOrchestrator().onTrigger({ source: 'opportunity', triggerId: trigger.id, gapMinutes: Math.round(gapSeconds / 60) })
    }
  }

  /**
   * 获取触发器配置列表（含运行时状态）
   * @returns 所有触发器的当前状态快照
   */
  getTriggers(): ProactiveTrigger[] {
    return [...this.triggers]
  }

  /**
   * 更新指定触发器的属性（v2.14: 自动持久化）
   * @param id - 触发器唯一标识
   * @param updates - 要更新的字段（部分）
   * @returns 是否成功找到并更新了触发器
   */
  updateTrigger(id: string, updates: Partial<ProactiveTrigger>): boolean {
    const idx = this.triggers.findIndex(t => t.id === id)
    if (idx === -1) {return false}
    this.triggers[idx] = { ...this.triggers[idx], ...updates }
    this.saveTriggersToFile()
    // 如果切换了屏幕感知/热搜感知/Daily Paper，同步到 config 并热重启
    if (id === 'screen-watch' || id === 'hot-topic' || id === 'daily-paper') {
      if (id === 'screen-watch') {this.config.screenWatchEnabled = !!updates.enabled}
      if (id === 'hot-topic') {this.config.hotTopicEnabled = !!updates.enabled}
      if (id === 'daily-paper') {this.config.dailyPaperEnabled = !!updates.enabled}
      this.stop()
      this.start()
    }
    return true
  }

  /**
   * 动态添加新触发器
   * @param trigger - 完整的触发器定义（含 ID、类型、条件、模板等）
   */
  addTrigger(trigger: ProactiveTrigger): void {
    const existing = this.triggers.findIndex(t => t.id === trigger.id)
    if (existing >= 0) {
      this.triggers[existing] = { ...trigger }
    } else {
      this.triggers.push(trigger)
    }
  }

  // ── 活动跟踪 ─────────────────────────────────────────

  /**
   * 用户活动心跳 — 重置空闲计时器，由 IPC `proactive:heartbeat` 调用
   */
  heartbeat(): void {
    this.lastActivity = Date.now()
    // 记录活跃时间戳，供作息学习使用
    this.activityLog.push(Date.now())
    // 只保留最近 14 天
    const twoWeeksAgo = Date.now() - 14 * 86400000
    this.activityLog = this.activityLog.filter(t => t > twoWeeksAgo)
  }

  /** 🆕 v2.9: 强制激活指定触发器（供前端测试按钮使用，绕过冷却） */
  /**
   * 强制激活指定触发器（绕过冷却检查和条件判断）
   * @param id - 触发器 ID
   * @returns 是否找到并激活了触发器
   */
  forceActivate(id: string): boolean {
    const trigger = this.triggers.find(t => t.id === id)
    if (!trigger) {return false}
    const message = trigger.template || TIME_TEMPLATES[trigger.id] || `[测试] 触发器 ${trigger.id} 已激活`
    this.activateWithMessage(trigger, message, true)
    return true
  }

  /**
   * 获取用户空闲秒数（距上次心跳/消息的时间）
   * @returns 空闲秒数
   */
  getIdleSeconds(): number {
    return Math.floor((Date.now() - this.lastActivity) / 1000)
  }

  // ── 事件触发 ─────────────────────────────────────────

  /**
   * 触发指定事件类型的主动行为
   * @param eventType - 事件名（如 'app_start', 'long_session'）
   */
  fireEvent(eventType: string): void {
    const matching = this.triggers.filter(t =>
      t.enabled && t.type === 'event' && t.condition === eventType
    )
    for (const trigger of matching) {
      this.activate(trigger)
    }
  }

  // ── 获取当前屏幕上下文 (供外部查询) ──────────────────

  /**
   * 获取最近一次屏幕感知的上下文（VLM 分析结果）
   * @returns 屏幕上下文快照，或 null（尚未执行/无结果）
   */
  getLastScreenContext(): ScreenContext | null {
    return lastScreenContext
  }

  // ── 内部 ─────────────────────────────────────────────

  private checkTriggers(): void {
    if (this.dailyCount >= this.config.maxDailyProactive) {return}

    const now = Date.now()
    if (now - this.lastProactive < this.config.minIntervalSeconds * 1000) {return}

    for (const trigger of this.triggers) {
      if (!trigger.enabled) {continue}
      if (trigger.lastTriggered && now - trigger.lastTriggered < trigger.cooldown * 1000) {continue}

      switch (trigger.type) {
        case 'time':
          if (this.matchCron(trigger.condition)) {
            this.markTriggerFired(trigger)
            void getProactiveOrchestrator().onTrigger({ source: 'cron', triggerId: trigger.id })
          }
          break
        case 'idle':
          if (this.getIdleSeconds() >= this.parseIdleSeconds(trigger.condition)) {
            this.markTriggerFired(trigger)
            void getProactiveOrchestrator().onTrigger({ source: 'idle', triggerId: trigger.id, gapMinutes: this.getIdleSeconds() / 60 })
          }
          break
        case 'personal_rhythm':
          // 作息触发由 runPersonalRhythm() 独立处理
          break
        case 'opportunity':
          // 机会触发由 runOpportunityCheck() 独立处理
          break
        case 'daily_paper':
          // Daily Paper 由 runDailyPaperCheck() 独立处理
          break
        // event / screen_watch / hot_topic 在外部触发
      }
    }
  }

  /**
   * 触发一个触发器（v6.1：统一交给编排器现场生成，不再走模板/toast）。
   * 保留此方法供 testTrigger/fireEvent 调用。
   */
  private activate(trigger: ProactiveTrigger): void {
    this.markTriggerFired(trigger)
    const sourceMap: Record<string, 'startup' | 'cron' | 'idle' | 'opportunity'> = {
      'startup-greeting': 'startup',
      'long-session': 'startup',
    }
    const source = trigger.type === 'event'
      ? (sourceMap[trigger.id] || 'startup')
      : trigger.type === 'idle' ? 'idle'
      : trigger.type === 'opportunity' ? 'opportunity'
      : 'cron'
    // 重逢分档：startup 用 lifeStateStore 的离线 gap（orchestrator 内读）
    void getProactiveOrchestrator().onTrigger({ source, triggerId: trigger.id })
  }

  /**
   * 标记一个触发器本轮已触发（保留旧的冷却/计数簿，供设置面板 getStatus 查询），
   * 但不再直接发 toast——真正的台词动作由编排器决定。
   */
  private markTriggerFired(trigger: ProactiveTrigger): void {
    const now = Date.now()
    trigger.lastTriggered = now
    this.lastProactive = now
    this.dailyCount++
  }

  private activateWithMessage(trigger: ProactiveTrigger, message: string, skipCooldown = false): void {
    if (!message) {return}

    const now = Date.now()
    if (!skipCooldown && trigger.lastTriggered && now - trigger.lastTriggered < trigger.cooldown * 1000) {return}

    trigger.lastTriggered = now
    this.lastProactive = now
    this.dailyCount++

    // 记录主动推送
    getUsageStats().recordProactive(trigger.id, message)

    const proactiveEvent: ProactiveEvent = {
      trigger,
      message,
      timestamp: now,
      delivered: true,
    }
    this.history.push(proactiveEvent)

    globalEventBus.emit(BusEvents.PROACTIVE_MESSAGE, {
      triggerId: trigger.id,
      message,
      type: trigger.type,
    })

    // 自动发朋友圈 — 每次主动触发都记录（移除技术前缀）
    try {
      const agentId = 'lumina'
      const agentName = 'Lumina'
      const content = message.slice(0, 200)

      // 🔧 v2.12: 启动问候每天只发一次朋友圈，避免刷屏
      if (trigger.id === 'startup-greeting') {
        if (hasTodayMomentWithKeyword(agentId, '欢迎回来') || hasTodayMomentWithKeyword(agentId, '已就绪')) {
          console.log('[ProactiveEngine] 启动问候今日已发过朋友圈，跳过')
        } else {
          postThought(agentId, agentName, content)
        }
      } else if (trigger.type === 'screen_watch' || trigger.type === 'hot_topic') {
        postObservation(agentId, agentName, content, '👀')
      } else if (trigger.type === 'daily_paper') {
        postThought(agentId, agentName, content)
      } else {
        postThought(agentId, agentName, content)
      }
    } catch { /* moments store may not be ready */ }

    // ── 🔧 v3.9.1/v6.x: Windows 系统通知（兼容层，失败不阻塞引擎） ──
    try {
      if (!this.config.notificationsEnabled) {return} // 静默跳过
      const iconPath = getAppIconPath()
      safeNotify('💡 Lumina 有话要说', message.slice(0, 120), iconPath)
    } catch {
      // 静默降级 — 通知失败不影响引擎核心功能
    }

    this.emit('proactive', proactiveEvent)
    console.log(`[ProactiveEngine] 触发: ${trigger.id} → "${message.slice(0, 60)}..."`)
  }

  // ── Cron 解析 ────────────────────────────────────────

  private matchCron(cron: string): boolean {
    const now = new Date()
    const parts = cron.split(' ')
    if (parts.length !== 5) {return false}

    const [minute, hour, day, month, weekday] = parts
    const matches = (field: string, value: number): boolean => {
      if (field === '*') {return true}
      if (field === String(value)) {return true}
      return false
    }

    return (
      matches(minute, now.getMinutes()) &&
      matches(hour, now.getHours()) &&
      matches(day, now.getDate()) &&
      matches(month, now.getMonth() + 1) &&
      matches(weekday, now.getDay())
    )
  }

  private parseIdleSeconds(condition: string): number {
    const match = condition.match(/^idle:(\d+)$/)
    return match ? parseInt(match[1]) : 600
  }

  private msUntilMidnight(): number {
    const now = new Date()
    const midnight = new Date(now)
    midnight.setHours(24, 0, 0, 0)
    return midnight.getTime() - now.getTime()
  }

  // ── 统计 ─────────────────────────────────────────────

  /**
   * 获取引擎完整运行状态（供 ProactiveSidebar 面板消费）
   * @returns 运行标志、触发器列表、配置、计数等完整快照
   */
  getStatus() {
    const idleSeconds = this.getIdleSeconds()
    // 检测 Windows 系统空闲时间（用户无键鼠操作）
    // 使用 -EncodedCommand 同步执行，杜绝编码乱码
    let systemIdleSeconds = 0
    try {
      const psScript = [
        '$ProgressPreference="SilentlyContinue";',
        '$ErrorActionPreference="SilentlyContinue";',
        'Add-Type @"',
        'using System;',
        'using System.Runtime.InteropServices;',
        '[StructLayout(LayoutKind.Sequential)]',
        'public struct LI {',
        '  public uint cbSize;',
        '  public uint dwTime;',
        '}',
        'public class LK {',
        '  [DllImport("user32.dll")]',
        '  public static extern bool GetLastInputInfo(ref LI p);',
        '}',
        '"@ 2>&1 | Out-Null;',
        '$l=New-Object LI;$l.cbSize=8;',
        '[LK]::GetLastInputInfo([ref]$l)|Out-Null;',
        '$t=[Environment]::TickCount-$l.dwTime;',
        'Write-Output $t;',
      ].join('\n')
      const b64 = Buffer.from(psScript, 'utf16le').toString('base64')
      const result = cp.execFileSync('powershell', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', b64,
      ], { timeout: 3000, windowsHide: true, encoding: 'utf-8' }).trim()
      systemIdleSeconds = Math.floor((parseInt(result) || 0) / 1000)
    } catch { /* 非 Windows 环境，忽略 */ }

    return {
      running: this.checkTimer !== null || this.screenWatchTimer !== null || this.hotTopicTimer !== null || this.dailyPaperTimer !== null,
      triggers: this.triggers.map(t => ({
        id: t.id,
        type: t.type,
        condition: t.condition,
        template: t.template,
        enabled: t.enabled,
        cooldown: t.cooldown,
        lastTriggered: t.lastTriggered,
        priority: t.priority,
      })),
      config: {
        enabled: this.config.enabled,
        minIdleSeconds: this.config.minIdleSeconds,
        minIntervalSeconds: this.config.minIntervalSeconds,
        maxDailyProactive: this.config.maxDailyProactive,
        useLlmPolish: this.config.useLlmPolish,
        screenWatchIntervalSeconds: this.config.screenWatchIntervalSeconds,
        hotTopicIntervalSeconds: this.config.hotTopicIntervalSeconds,
        dailyPaperIntervalSeconds: this.config.dailyPaperIntervalSeconds,
        screenWatchEnabled: this.config.screenWatchEnabled,
        hotTopicEnabled: this.config.hotTopicEnabled,
        dailyPaperEnabled: this.config.dailyPaperEnabled,
        notificationsEnabled: this.config.notificationsEnabled,
      },
      dailyCount: this.dailyCount,
      // 🔧 修复：使用真实用户活动时间，非上次触发时间
      lastActivity: this.lastActivity,
      idleSeconds: idleSeconds,
      systemIdleSeconds: systemIdleSeconds,
      lastProactiveTime: this.lastProactive > 0 ? this.lastProactive : undefined,
    }
  }

  /**
   * 🔧 v2.16: 设置是否开启通知
   */
  setNotify(enabled: boolean): void {
    this.config.notificationsEnabled = enabled
    this.saveTriggersToFile()
  }

  /**
   * 🔧 v6.x: 设置是否开启 Daily Paper
   */
  setDailyPaperEnabled(enabled: boolean): void {
    this.config.dailyPaperEnabled = enabled
    const t = this.triggers.find(t => t.id === 'daily-paper')
    if (t) {t.enabled = enabled}
    this.saveTriggersToFile()
    this.stop()
    this.start()
  }

  /**
   * 🔧 v2.16: 获取屏幕上下文（占位，实际由渲染进程实现）
   */
  getScreenContext(): { context: string; timestamp?: number } | null {
    // 屏感知上下文由渲染进程通过 LLM 分析后提供
    return null
  }

  /**
   * 🔧 v2.16: 用户发送消息时调用，用于学习交互节奏
   */
  onUserMessage(): void {
    this.lastUserMessageTime = Date.now()
    this.lastActivity = Date.now()
    this.activityLog.push(Date.now())
    getProactiveOrchestrator().noteUserInteraction() // v6.1：用户互动→退避清零
  }
}

// ═══════════════════════════════════════════════════════════
// 单例
// ═══════════════════════════════════════════════════════════

let _instance: ProactiveEngine | null = null

export function getProactiveEngine(): ProactiveEngine {
  if (!_instance) {
    _instance = new ProactiveEngine()
  }
  return _instance
}

export function initProactiveEngine(config?: Partial<ProactiveConfig>): ProactiveEngine {
  if (_instance) {_instance.stop()}
  _instance = new ProactiveEngine(config)
  return _instance
}
