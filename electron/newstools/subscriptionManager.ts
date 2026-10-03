// ============================================================
// newstools/subscriptionManager.ts — 邮件订阅管理 v1.0
//
// 借鉴 Horizon：支持邮件订阅/退订、自动处理退订请求
// 用户用 "unsubscribe" 回复即可自动退订
// ============================================================

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { app } from 'electron'

export interface SubscriptionState {
  subscribers: Subscriber[]
  autoUnsubscribe: boolean
  subscribeFooter: string
}

export interface Subscriber {
  email: string
  subscribedAt: string
  lastSentAt?: string
  active: boolean
  preferences: {
    categories: string[]    // 空 = 全部
    language: 'zh' | 'en' | 'both'
    frequency: 'daily' | 'weekday' | 'weekly'
  }
}

const DEFAULT_STATE: SubscriptionState = {
  subscribers: [],
  autoUnsubscribe: true,
  subscribeFooter: `\n\n---\n📡 由 Lumina AI 自动推送 · 回复 "unsubscribe" 退订`,
}

class SubscriptionManager {
  private state: SubscriptionState = { ...DEFAULT_STATE }
  private readonly statePath: string

  constructor() {
    try {
      if (app && typeof app.getPath === 'function') {
        this.statePath = path.join(app.getPath('userData'), 'lumina-news-subscriptions.json')
      } else {
        throw new Error('app not ready')
      }
    } catch {
      // ⚠️ 原来退回 process.cwd()（项目根），会在开发模式下往仓库里写文件。
      // 改退系统临时目录：状态不持久可以接受，污染代码仓库不能接受。
      this.statePath = path.join(os.tmpdir(), 'lumina-news-subscriptions.json')
    }
    this._load()
  }

  private _load(): void {
    try {
      if (fs.existsSync(this.statePath)) {
        this.state = { ...DEFAULT_STATE, ...JSON.parse(fs.readFileSync(this.statePath, 'utf-8')) }
      }
    } catch { this.state = { ...DEFAULT_STATE } }
  }

  private _save(): void {
    try {
      const dir = path.dirname(this.statePath)
      if (!fs.existsSync(dir)) {fs.mkdirSync(dir, { recursive: true })}
      fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2), 'utf-8')
    } catch {}
  }

  getState(): SubscriptionState { return { ...this.state } }

  /** 邮件管理入口 */
  async manageSubscription(action: string, email?: string): Promise<{ ok: boolean; message: string; subscribers?: Subscriber[] }> {
    switch (action) {
      case 'subscribe':
        if (!email) {return { ok: false, message: '需要提供邮箱地址' }}
        if (this.state.subscribers.some(s => s.email === email && s.active)) {
          return { ok: true, message: `${email} 已订阅` }
        }
        // 移除旧的退订记录
        this.state.subscribers = this.state.subscribers.filter(s => s.email !== email)
        this.state.subscribers.push({
          email,
          subscribedAt: new Date().toISOString(),
          active: true,
          preferences: { categories: [], language: 'both', frequency: 'daily' },
        })
        this._save()
        return { ok: true, message: `${email} 订阅成功！` }

      case 'unsubscribe':
        if (!email) {return { ok: false, message: '需要提供邮箱地址' }}
        const sub = this.state.subscribers.find(s => s.email === email)
        if (sub) {
          sub.active = false
          this._save()
          return { ok: true, message: `${email} 已退订` }
        }
        return { ok: true, message: `${email} 未找到订阅记录` }

      case 'list':
        return {
          ok: true,
          message: `共 ${this.state.subscribers.filter(s => s.active).length} 个活跃订阅`,
          subscribers: this.state.subscribers,
        }

      case 'status':
        if (email) {
          const sub2 = this.state.subscribers.find(s => s.email === email)
          return { ok: true, message: sub2 ? (sub2.active ? '已订阅' : '已退订') : '未订阅', subscribers: sub2 ? [sub2] : [] }
        }
        return { ok: true, message: `共 ${this.state.subscribers.length} 条订阅记录（${this.state.subscribers.filter(s => s.active).length} 活跃）`, subscribers: this.state.subscribers }

      default:
        return { ok: false, message: `未知操作: ${action}` }
    }
  }

  /** 自动处理邮件退订（邮件中回复 "unsubscribe" 触发）*/
  async autoUnsubscribe(email: string): Promise<boolean> {
    if (!this.state.autoUnsubscribe) {return false}
    await this.manageSubscription('unsubscribe', email)
    return true
  }

  /** 获取活跃订阅列表 */
  getActiveSubscribers(): Subscriber[] {
    return this.state.subscribers.filter(s => s.active)
  }
}

// 全局单例
export const subscriptionManager = new SubscriptionManager()
export const manageSubscription = subscriptionManager.manageSubscription.bind(subscriptionManager)
