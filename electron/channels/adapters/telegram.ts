// ============================================================
// channels/adapters/telegram.ts — 📡 Telegram 渠道适配器 (Phase C)
//
// 实现:
//   - Telegram Bot API 发送消息
//   - Webhook 模式接收消息
//   - 支持单聊和群组
//
// 前置条件:
//   1. 在 @BotFather 创建 Bot
//   2. 获取 Bot Token
//   3. 配置 Webhook URL: https://api.telegram.org/bot<TOKEN>/setWebhook
// ============================================================

import * as https from 'https'
import type {
  ChannelType, ChannelMessage, ChannelSendRequest,
  ChannelConfig, ChannelAdapter,
} from '../types'

export class TelegramAdapter implements ChannelAdapter {
  readonly type: ChannelType = 'telegram'
  readonly name = 'Telegram'

  private config!: ChannelConfig
  private messageHandler: ((msg: ChannelMessage) => void) | null = null
  private botToken = ''

  async init(config: ChannelConfig): Promise<boolean> {
    this.config = config
    this.botToken = config.credentials.botToken || ''

    if (this.botToken) {
      // 验证 token；网络异常/Token 无效都不向上抛穿（保持适配器可被健康检查/重试）
      try {
        const me = await this.telegramGet('getMe')
        if (me.ok) {
          console.log(`[Telegram] ✅ 已连接 Bot: @${me.result?.username}`)
        } else {
          console.warn('[Telegram] Token 校验未通过，渠道保持离线（可稍后重试）')
        }
      } catch (err) {
        console.warn('[Telegram] 初始化网络异常（不影响其它渠道）:', (err as Error)?.message || err)
      }
    }

    return true
  }

  async send(request: ChannelSendRequest): Promise<boolean> {
    if (!this.botToken) return false

    // Telegram 用 chat_id 统一标识用户/群组
    const params: Record<string, any> = {
      chat_id: request.targetId,
      text: request.text,
      parse_mode: 'Markdown',
    }

    if (request.replyTo) {
      params.reply_to_message_id = parseInt(request.replyTo, 10)
    }

    try {
      const data = await this.telegramPost('sendMessage', params)
      return data.ok === true
    } catch {
      return false
    }
  }

  onMessage(handler: (msg: ChannelMessage) => void): void {
    this.messageHandler = handler
  }

  async healthCheck(): Promise<boolean> {
    if (!this.botToken) return false
    try {
      const data = await this.telegramGet('getMe')
      return data.ok === true
    } catch {
      return false
    }
  }

  async destroy(): Promise<void> {
    this.messageHandler = null
    console.log('[Telegram] 适配器已销毁')
  }

  /** 处理 Telegram Webhook 回调 */
  handleWebhook(body: any): { status: number; body: string } {
    if (!this.messageHandler) return { status: 200, body: 'OK' }

    const msg = this.parseUpdate(body)
    if (msg) {
      this.messageHandler(msg)
    }

    return { status: 200, body: 'OK' }
  }

  /** 设置 Webhook URL */
  async setWebhook(url: string): Promise<boolean> {
    try {
      const data = await this.telegramPost('setWebhook', { url })
      return data.ok === true
    } catch {
      return false
    }
  }

  /** 删除 Webhook */
  async deleteWebhook(): Promise<boolean> {
    try {
      const data = await this.telegramGet('deleteWebhook')
      return data.ok === true
    } catch {
      return false
    }
  }

  // ── 内部方法 ──────────────────────────────────────

  /** 解析 Telegram Update 为统一消息格式 */
  private parseUpdate(update: any): ChannelMessage | null {
    const message = update?.message || update?.edited_message
    if (!message) return null

    // 忽略 bot 自身消息
    if (message.from?.is_bot) return null

    const chat = message.chat || {}
    const isGroup = chat.type === 'group' || chat.type === 'supergroup'

    return {
      id: String(message.message_id),
      channel: 'telegram',
      fromUser: String(message.from?.id || ''),
      fromUserName: message.from?.first_name || message.from?.username || '',
      groupId: isGroup ? String(chat.id) : undefined,
      groupName: isGroup ? chat.title : undefined,
      text: message.text || message.caption || '',
      timestamp: (message.date || 0) * 1000,
      raw: update,
    }
  }

  private telegramGet(method: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const options: https.RequestOptions = {
        hostname: 'api.telegram.org',
        path: `/bot${this.botToken}/${method}`,
        method: 'GET',
        timeout: 10000,
      }
      const req = https.request(options, (res) => {
        let data = ''
        res.on('data', (chunk: string) => (data += chunk))
        res.on('end', () => {
          try { resolve(JSON.parse(data)) } catch { resolve({}) }
        })
      })
      req.on('error', reject)
      req.end()
    })
  }

  private telegramPost(method: string, body: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify(body)
      const options: https.RequestOptions = {
        hostname: 'api.telegram.org',
        path: `/bot${this.botToken}/${method}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData).toString(),
        },
        timeout: 10000,
      }
      const req = https.request(options, (res) => {
        let data = ''
        res.on('data', (chunk: string) => (data += chunk))
        res.on('end', () => {
          try { resolve(JSON.parse(data)) } catch { resolve({}) }
        })
      })
      req.on('error', reject)
      req.write(postData)
      req.end()
    })
  }
}
