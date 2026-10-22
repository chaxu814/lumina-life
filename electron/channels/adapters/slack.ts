// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// channels/adapters/slack.ts — 📡 Slack 渠道适配器 (Phase C)
//
// 实现:
//   - Slack Web API 发送消息
//   - Slack Events API 接收消息（需 Bolt 框架或自建 HTTP 端点）
//   - 支持单聊和频道消息
//
// 前置条件:
//   1. Slack App 创建 https://api.slack.com/apps
//   2. 获取 Bot Token (xoxb-...) 和 Signing Secret
//   3. 启用 Events API 并配置 Request URL
// ============================================================

import * as https from 'https'
import * as crypto from 'crypto'
import type {
  ChannelType, ChannelMessage, ChannelSendRequest,
  ChannelConfig, ChannelAdapter,
} from '../types'

export class SlackAdapter implements ChannelAdapter {
  readonly type: ChannelType = 'slack'
  readonly name = 'Slack'

  private config!: ChannelConfig
  private messageHandler: ((msg: ChannelMessage) => void) | null = null
  private botToken = ''
  private signingSecret = ''

  async init(config: ChannelConfig): Promise<boolean> {
    this.config = config
    this.botToken = config.credentials.botToken || ''
    this.signingSecret = config.credentials.signingSecret || ''
    console.log('[Slack] ✅ 适配器已初始化')
    return true
  }

  async send(request: ChannelSendRequest): Promise<boolean> {
    if (!this.botToken) {return false}

    if (request.isGroup) {
      return this.sendChannelMessage(request.targetId, request.text)
    } else {
      return this.sendDirectMessage(request.targetId, request.text)
    }
  }

  onMessage(handler: (msg: ChannelMessage) => void): void {
    this.messageHandler = handler
  }

  async healthCheck(): Promise<boolean> {
    if (!this.botToken) {return false}
    try {
      const data = await this.slackApiGet('auth.test')
      return data.ok === true
    } catch {
      return false
    }
  }

  async destroy(): Promise<void> {
    this.messageHandler = null
    console.log('[Slack] 适配器已销毁')
  }

  /** 🆕 v16.0-fix: 增强版 handleEvent — 异步解析用户名后再回调 */
  async handleEvent(body: any): Promise<any> {
    // URL 验证
    if (body.type === 'url_verification') {
      return { challenge: body.challenge }
    }

    // 事件回调
    if (body.type === 'event_callback' && this.messageHandler) {
      const event = body.event
      const msg = this.parseEvent(event)
      if (msg) {
        // 异步解析用户名（不阻塞消息处理）
        if (msg.fromUser) {
          this.resolveUserName(msg.fromUser).then(name => {
            msg.fromUserName = name
          }).catch(() => {})
        }
        this.messageHandler(msg)
      }
    }

    return { ok: true }
  }

  /** 验证 Slack 请求签名 */
  verifySignature(signature: string, timestamp: string, rawBody: string): boolean {
    if (!this.signingSecret) {return true} // 无密钥时不验证
    const base = `v0:${timestamp}:${rawBody}`
    const hash = 'v0=' + crypto.createHmac('sha256', this.signingSecret).update(base).digest('hex')
    return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(signature))
  }

  // ── 内部方法 ──────────────────────────────────────

  /** 发送频道消息 */
  private async sendChannelMessage(channel: string, text: string): Promise<boolean> {
    try {
      const data = await this.slackApiPost('chat.postMessage', {
        channel,
        text,
        mrkdwn: true,
      })
      return data.ok === true
    } catch {
      return false
    }
  }

  /** 发送私信 */
  private async sendDirectMessage(user: string, text: string): Promise<boolean> {
    return this.sendChannelMessage(user, text)
  }

  /** 解析 Slack 事件为统一格式 */
  private parseEvent(event: any): ChannelMessage | null {
    // 只处理消息事件
    if (event.type !== 'message') {return null}
    // 忽略 bot 消息（防止循环）
    if (event.bot_id || event.subtype === 'bot_message') {return null}

    return {
      id: event.client_msg_id || event.ts || `sl_${Date.now()}`,
      channel: 'slack',
      fromUser: event.user || '',
      fromUserName: '', // 需要 users.info 补充
      groupId: event.channel?.startsWith('C') ? event.channel : undefined,
      groupName: undefined,
      text: event.text || '',
      timestamp: parseFloat(event.ts || '0') * 1000,
      raw: event,
    }
  }

  /** 🆕 v16.0-fix: 异步解析用户名，填充 fromUserName */
  async resolveUserName(userId: string): Promise<string> {
    if (!userId || !this.botToken) {return ''}
    try {
      const data = await this.slackApiGet(`users.info?user=${userId}`)
      if (data.ok && data.user) {
        return data.user.real_name || data.user.display_name || data.user.name || ''
      }
    } catch {
      // 静默失败，不影响消息流程
    }
    return ''
  }

  private slackApiGet(method: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const options: https.RequestOptions = {
        hostname: 'slack.com',
        path: `/api/${method}`,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.botToken}`,
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
      req.end()
    })
  }

  private slackApiPost(method: string, body: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify(body)
      const options: https.RequestOptions = {
        hostname: 'slack.com',
        path: `/api/${method}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: `Bearer ${this.botToken}`,
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
