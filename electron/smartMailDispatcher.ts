// ============================================================
// smartMailDispatcher.ts — 智能邮件调度器 (v1.1)
//
// 功能:
//   1. 定时报告 — 每日/每周 LLM 自动生成摘要邮件
//   2. 安全警报 — 检测到异常立即邮件通知用户
//   3. Token 告警 — API 超限时提醒
//   4. Agent 自主决策 — Agent 判断需要邮件通知用户的重要事项
// 新闻早报 — 每日自动采集、筛选、推送
// ============================================================

import { sendMail } from './mailStore'
import { globalEventBus, BusEvents } from './eventBus'
import { collectAll } from './tools/impl/newsCollector'
import { filterWithLLM, generateDigestText } from './tools/impl/newsFilter'
import { deduplicate, assembleDigestBody } from './tools/impl/newsDigest'
import { getProviderManager } from './core/providerManager'
import { LLMProvider } from './core/llmProvider'

interface SmartMailRule {
  id: string
  name: string
  checkInterval: number  // ms 检查间隔
  condition: () => boolean
  /** 调用 LLM 生成邮件内容 */
  generateContent: () => Promise<{ subject: string; body: string; priority: 'normal' | 'important' }>
  cooldown: number      // ms 冷却时间
  lastTriggered: number
}

class SmartMailDispatcher {
  private rules: SmartMailRule[] = []
  private timers: Map<string, ReturnType<typeof setInterval>> = new Map()

  constructor() {
    this.registerRules()
    this.setupEventListeners()
  }

  private registerRules() {
    // ── 规则 1: 每日早安摘要 (08:00-09:00 之间触发一次) ──
    this.rules.push({
      id: 'daily-morning-digest',
      name: '早安摘要',
      checkInterval: 5 * 60 * 1000, // 每5分钟检查
      condition: () => {
        const now = new Date()
        return now.getHours() === 8 && now.getMinutes() < 5
      },
      generateContent: async () => {
        const today = new Date().toLocaleDateString('zh-CN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
        return {
          subject: `☀️ Lumina 早安摘要 — ${today}`,
          body: `早上好！☀️

📅 ${today}

Lumina 已就绪，三位 Agent 正在待命：

🐱 **Lumina** — 陪伴你的每一天
🍵 **热茶** — 代码和技术问题随时找他
📊 **Yak** — 数据分析与搜索专家

💡 今日建议：
• 查看待办任务面板，确认今日计划
• 检查邮件收件箱，看看有没有新消息
• 在团队群聊中 @Agent 获取帮助

祝你今天工作顺利！✨

—— Lumina 团队`,
          priority: 'normal' as const,
        }
      },
      cooldown: 23 * 3600000,
      lastTriggered: 0,
    })

    // ── 规则 2: 晚间总结 (21:00-21:05 触发) ──
    this.rules.push({
      id: 'evening-summary',
      name: '晚间总结',
      checkInterval: 5 * 60 * 1000,
      condition: () => {
        const now = new Date()
        return now.getHours() === 21 && now.getMinutes() < 5
      },
      generateContent: async () => {
        return {
          subject: '🌙 Lumina 晚间回顾',
          body: `一天过去了~ 🌙

今天和 Lumina 团队的互动记录已经保存在记忆中。

💤 早点休息，明天见！

—— Lumina 💙`,
          priority: 'normal' as const,
        }
      },
      cooldown: 23 * 3600000,
      lastTriggered: 0,
    })

    // ── 规则 3: 📡 新闻早报 (工作日 07:30 触发) ──
    this.rules.push({
      id: 'morning-news-digest',
      name: '新闻早报',
      checkInterval: 5 * 60 * 1000, // 每5分钟检查一次时间窗口
      condition: () => {
        const now = new Date()
        const day = now.getDay()
        // 仅工作日 (周一至周五), 07:30-07:35 窗口
        return day >= 1 && day <= 5 && now.getHours() === 7 && now.getMinutes() < 5
      },
      generateContent: async () => {
        try {
          console.log('[SmartMailDispatcher] 📡 开始采集新闻...')

          // 1. 采集
          const allItems = await collectAll()
          if (allItems.length === 0) {
            return { subject: '📡 Lumina 新闻早报', body: '📭 今日未能采集到新闻内容。', priority: 'normal' }
          }

          // 2. 去重
          const newItems = deduplicate(allItems)

          // 3. LLM 筛选（使用当前激活的 provider）
          const pm = getProviderManager?.()
          const activeConfig = pm?.getActiveConfig?.()
          let filtered
          if (activeConfig) {
            const provider = new LLMProvider({
              baseUrl: activeConfig.config.baseUrl,
              apiKey: activeConfig.config.apiKey,
              model: activeConfig.config.model,
              maxContextTokens: activeConfig.config.maxContextTokens || 256000,
            })
            const llmCall = async (systemPrompt: string, userContent: string) => {
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
            filtered = await filterWithLLM(newItems, llmCall)
          } else {
            // 无 provider 时使用热度降级
            filtered = await filterWithLLM(newItems, async () => '[]')
          }

          // 4. 组装邮件正文
          const body = assembleDigestBody(filtered, {
            title: `📡 Lumina 新闻早报 — ${new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })}`,
          })

          console.log(`[SmartMailDispatcher] ✅ 新闻早报已生成 (${filtered.length} 条)`)
          return { subject: '📡 Lumina 新闻早报', body, priority: 'normal' }
        } catch (err: any) {
          console.warn('[SmartMailDispatcher] 新闻早报生成失败:', err.message)
          return { subject: '📡 Lumina 新闻早报', body: `⚠️ 今日新闻生成失败: ${err.message}`, priority: 'normal' }
        }
      },
      cooldown: 23 * 3600000, // 23小时冷却（一天一次）
      lastTriggered: 0,
    })

    // ── 规则 4: Token 用量告警 (每30分钟检查) ──
    this.rules.push({
      id: 'token-usage-alert',
      name: 'Token 用量告警',
      checkInterval: 30 * 60 * 1000,
      condition: () => {
        try {
          const { getTokenEstimator } = require('./tokenEstimator')
          const estimator = getTokenEstimator?.()
          if (!estimator) return false
          const usage = estimator.getUsage?.()
          return usage ? usage.today > usage.limit * 0.8 : false
        } catch {
          return false
        }
      },
      generateContent: async () => {
        return {
          subject: '⚠️ Token 用量告警',
          body: `⚠️ 今日 Token 用量已超过限制的 80%

建议操作：
• 降低不必要的大模型调用
• 检查是否有关闭的技能可以节省 token
• 如需增加限额，请前往 设置 → LLM 配置

—— Lumina 安全团队`,
          priority: 'important' as const,
        }
      },
      cooldown: 6 * 3600000,
      lastTriggered: 0,
    })
  }

  private setupEventListeners() {
    // ── 安全事件 → 邮件告警 ──
    globalEventBus.on(BusEvents.SECURITY_ALERT, async (payload: any) => {
      if (!payload) return
      sendMail(
        `🚨 安全告警: ${payload.type || '未知'}`,
        `检测到安全事件:\n\n类型: ${payload.type || '未知'}\n详情: ${payload.detail || payload.message || '无详情'}\n时间: ${new Date().toLocaleString('zh-CN')}`,
        'important'
      )
    })
  }

  /**
   * 启动调度器 — 开始定期检查所有规则
   */
  start() {
    console.log('[SmartMailDispatcher] 🚀 智能邮件调度器已启动')
    for (const rule of this.rules) {
      const timer = setInterval(async () => {
        try {
          if (!rule.condition()) return
          if (Date.now() - rule.lastTriggered < rule.cooldown) return
          rule.lastTriggered = Date.now()
          const { subject, body, priority } = await rule.generateContent()
          sendMail(subject, body, priority)
          console.log(`[SmartMailDispatcher] 📬 已发送: "${subject}"`)
        } catch (err) {
          console.warn(`[SmartMailDispatcher] 规则 ${rule.id} 执行失败:`, err)
        }
      }, rule.checkInterval)
      this.timers.set(rule.id, timer)
    }
  }

  /**
   * 停止调度器 — 清理所有定时器
   */
  stop() {
    for (const [id, timer] of this.timers) {
      clearInterval(timer)
      console.log(`[SmartMailDispatcher] 停止规则: ${id}`)
    }
    this.timers.clear()
  }

  /**
   * 手动触发一封邮件（供 Agent 工具调用）
   */
  triggerMail(subject: string, body: string, priority: 'normal' | 'important' = 'normal') {
    return sendMail(subject, body, priority)
  }
}

let instance: SmartMailDispatcher | null = null

export function initSmartMailDispatcher(): SmartMailDispatcher {
  if (!instance) {
    instance = new SmartMailDispatcher()
    instance.start()
  }
  return instance
}

export function getSmartMailDispatcher(): SmartMailDispatcher | null {
  return instance
}
