// ============================================================
// proactiveChat.ts — 主动对话系统
//
// 借鉴 N.E.K.O 的 24/7 环境感知 + 主动对话设计：
//   - 定时检查时间/天气/新闻，主动发起话题
//   - 监测用户空闲时长，适时问候
//   - 可配置的主动对话策略
// ============================================================

export interface ProactiveTrigger {
  id: string
  type: 'time' | 'idle' | 'weather' | 'news' | 'reminder' | 'greeting'
  condition: string       // cron 表达式 或 条件描述
  prompt: string          // 触发时的对话提示词
  enabled: boolean
  lastTriggered?: number
}

export type ProactiveCallback = (trigger: ProactiveTrigger, message: string) => void

// ═══════════════════════════════════════════════════════════
// 默认主动对话策略
// ═══════════════════════════════════════════════════════════

const DEFAULT_TRIGGERS: ProactiveTrigger[] = [
  {
    id: 'morning-greeting',
    type: 'greeting',
    condition: '0 8 * * *',     // 每天早上 8 点
    prompt: '现在早上 8 点啦！新的一天开始咯~ ☀️ 今天有什么计划吗？',
    enabled: true,
  },
  {
    id: 'noon-reminder',
    type: 'reminder',
    condition: '0 12 * * *',    // 每天中午 12 点
    prompt: '已经中午了哦！记得吃午饭~ 🍱 不要饿着肚子工作呀',
    enabled: false,
  },
  {
    id: 'afternoon-check',
    type: 'time',
    condition: '0 15 * * *',    // 每天下午 3 点
    prompt: '下午 3 点了！要不要喝杯咖啡休息一下？☕ 我陪你聊聊天~',
    enabled: false,
  },
  {
    id: 'evening-wrapup',
    type: 'reminder',
    condition: '0 18 * * *',    // 每天晚上 6 点
    prompt: '天色不早啦~ 🌆 今天完成了哪些事情？需要我帮你整理一下吗？',
    enabled: false,
  },
  {
    id: 'night-check',
    type: 'time',
    condition: '0 22 * * *',    // 每天晚上 10 点
    prompt: '已经很晚了哦，早点休息吧！💤 明天见~',
    enabled: false,
  },
  {
    id: 'idle-5min',
    type: 'idle',
    condition: 'idle:300',      // 空闲 5 分钟
    prompt: '（用户已经 5 分钟没说话了...）你可以跟我说说话呀~ 我一直在这里哦 😊',
    enabled: false,
  },
  {
    id: 'idle-30min',
    type: 'idle',
    condition: 'idle:1800',     // 空闲 30 分钟
    prompt: '（用户离开 30 分钟了）你回来了吗？我有点想你了呢... 💭',
    enabled: false,
  },
]

// ═══════════════════════════════════════════════════════════
// 主动对话管理器
// ═══════════════════════════════════════════════════════════

const TRIGGERS_STORAGE_KEY = 'lumina_proactive_triggers'

export class ProactiveChatManager {
  private triggers: ProactiveTrigger[] = []
  private onTrigger: ProactiveCallback | null = null
  private checkInterval: number | null = null
  private lastUserActivity = Date.now()
  private isRunning = false

  constructor() {
    this.triggers = this.loadTriggers()
  }

  /** 从 localStorage 加载触发器状态，保留用户设置 */
  private loadTriggers(): ProactiveTrigger[] {
    try {
      const saved = localStorage.getItem(TRIGGERS_STORAGE_KEY)
      if (saved) {
        const savedTriggers: Array<{ id: string; enabled: boolean }> = JSON.parse(saved)
        return DEFAULT_TRIGGERS.map(dt => {
          const st = savedTriggers.find(t => t.id === dt.id)
          return st ? { ...dt, enabled: st.enabled } : dt
        })
      }
    } catch {}
    return [...DEFAULT_TRIGGERS]
  }

  /** 保存触发器状态到 localStorage */
  private saveTriggers(): void {
    try {
      const data = this.triggers.map(t => ({ id: t.id, enabled: t.enabled }))
      localStorage.setItem(TRIGGERS_STORAGE_KEY, JSON.stringify(data))
    } catch {}
  }

  /** 注册触发回调 */
  onProactiveTrigger(cb: ProactiveCallback): void {
    this.onTrigger = cb
  }

  /** 启动主动对话检查（每 30 秒检查一次） */
  start(): void {
    if (this.isRunning) {return}
    this.isRunning = true
    this.lastUserActivity = Date.now()

    this.checkInterval = window.setInterval(() => {
      this.checkTriggers()
    }, 30000) // 30 秒

    console.log('[Proactive] 主动对话系统已启动')
  }

  /** 停止 */
  stop(): void {
    this.isRunning = false
    if (this.checkInterval) {
      clearInterval(this.checkInterval)
      this.checkInterval = null
    }
  }

  /** 记录用户活动（重置空闲计时器） */
  recordActivity(): void {
    this.lastUserActivity = Date.now()
  }

  /** 获取所有触发器 */
  getTriggers(): ProactiveTrigger[] {
    return [...this.triggers]
  }

  /** 更新触发器配置 */
  updateTrigger(id: string, updates: Partial<ProactiveTrigger>): void {
    const idx = this.triggers.findIndex(t => t.id === id)
    if (idx >= 0) {
      this.triggers[idx] = { ...this.triggers[idx], ...updates }
      this.saveTriggers()
    }
  }

  /** 手动触发一次 */
  async triggerNow(id: string): Promise<void> {
    const trigger = this.triggers.find(t => t.id === id)
    if (!trigger) {return}
    trigger.lastTriggered = Date.now()
    this.onTrigger?.(trigger, trigger.prompt)
  }

  // ═════════════════════════════════════════════════════════
  // 内部检查
  // ═════════════════════════════════════════════════════════

  private checkTriggers(): void {
    const now = new Date()
    const idleSeconds = Math.floor((Date.now() - this.lastUserActivity) / 1000)

    for (const trigger of this.triggers) {
      if (!trigger.enabled) {continue}

      // 防重复触发（1 小时内不重复）
      if (trigger.lastTriggered && Date.now() - trigger.lastTriggered < 3600000) {continue}

      let shouldTrigger = false

      if (trigger.type === 'idle') {
        // idle:300 格式
        const threshold = parseInt(trigger.condition.replace('idle:', ''), 10)
        if (idleSeconds >= threshold) {shouldTrigger = true}
      } else if (trigger.type === 'time' || trigger.type === 'greeting' || trigger.type === 'reminder') {
        // 简单 cron 模拟：只解析 "分 时 * * *" 格式
        shouldTrigger = this.matchSimpleCron(trigger.condition, now)
      }

      if (shouldTrigger) {
        trigger.lastTriggered = Date.now()
        this.onTrigger?.(trigger, trigger.prompt)
      }
    }
  }

  /** 简单 cron 匹配（仅支持 "分 时" 格式） */
  private matchSimpleCron(cronExpr: string, now: Date): boolean {
    const parts = cronExpr.trim().split(/\s+/)
    if (parts.length < 2) {return false}

    const minute = parseInt(parts[0], 10)
    const hour = parseInt(parts[1], 10)

    // 仅在精确分钟匹配（±30秒窗口由 30s 检查间隔保证）
    return now.getHours() === hour && now.getMinutes() === minute
  }
}

export const proactiveChat = new ProactiveChatManager()
