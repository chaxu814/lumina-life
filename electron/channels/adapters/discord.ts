// ============================================================
// channels/adapters/discord.ts — 📡 Discord 渠道适配器 (P2-1)
//
// 实现:
//   - Discord Bot API 发送消息
//   - Gateway Intents 接收消息
//   - 支持单聊和群组
//
// 前置条件:
//   1. 在 https://discord.com/developers/applications 创建 Bot
//   2. 获取 Bot Token
//   3. 启用 Message Content Intent
//   4. 邀请 Bot 到服务器
// ============================================================

import * as https from 'https'
import * as http from 'http'
import * as url from 'url'
import type {
  ChannelType, ChannelMessage, ChannelSendRequest,
  ChannelConfig, ChannelAdapter,
} from '../types'

// Discord API 端点
const DISCORD_API = 'https://discord.com/api/v10'
const DISCORD_CDN = 'https://cdn.discordapp.com'

export interface DiscordBotConfig {
  token: string
  applicationId?: string
  guildId?: string
}

export class DiscordAdapter implements ChannelAdapter {
  readonly type: ChannelType = 'discord'
  readonly name = 'Discord'

  private config!: ChannelConfig
  private messageHandler: ((msg: ChannelMessage) => void) | null = null
  private botToken = ''
  private botUserId: string | null = null
  private botUsername: string | null = null
  private ws: WebSocket | null = null
  private heartbeatInterval: NodeJS.Timeout | null = null
  private sequence: number | null = null
  private reconnectAttempts = 0
  private maxReconnectAttempts = 5
  private reconnectDelay = 1000

  async init(config: ChannelConfig): Promise<boolean> {
    this.config = config
    this.botToken = config.credentials.token || config.credentials.botToken || ''

    if (!this.botToken) {
      console.error('[Discord] ❌ 缺少 Bot Token')
      return false
    }

    // 验证 token 并获取 Bot 信息
    const me = await this.discordGet('/users/@me')
    if (me.id && me.username) {
      this.botUserId = me.id
      this.botUsername = `${me.username}#${me.discriminator || '0'}`
      console.log(`[Discord] ✅ 已连接 Bot: ${this.botUsername}`)
      
      // 启动 Gateway 连接
      this.connectGateway()
      return true
    }

    console.error('[Discord] ❌ Token 验证失败:', me.message || 'Unknown error')
    return false
  }

  async send(request: ChannelSendRequest): Promise<boolean> {
    if (!this.botToken) {return false}

    // Discord 用 channel_id 发送消息
    const channelId = request.targetId
    const payload: any = {
      content: request.text,
    }

    // 如果有 replyTo，添加引用
    if (request.replyTo) {
      payload.message_reference = {
        message_id: request.replyTo,
      }
    }

    try {
      const data = await this.discordPost(`/channels/${channelId}/messages`, payload)
      return !!data.id
    } catch (err) {
      console.error('[Discord] 发送消息失败:', err)
      return false
    }
  }

  onMessage(handler: (msg: ChannelMessage) => void): void {
    this.messageHandler = handler
  }

  async healthCheck(): Promise<boolean> {
    if (!this.botToken) {return false}
    try {
      const data = await this.discordGet('/users/@me')
      return !!data.id
    } catch {
      return false
    }
  }

  async destroy(): Promise<void> {
    // 清理 WebSocket 连接
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }
    this.messageHandler = null
    console.log('[Discord] 适配器已销毁')
  }

  // ── WebSocket Gateway 连接 ────────────────────────────

  private connectGateway(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {return}

    // 获取 Gateway URL
    this.discordGet('/gateway').then((data: any) => {
      const gatewayUrl = data.url
      if (!gatewayUrl) {
        console.error('[Discord] 无法获取 Gateway URL')
        return
      }

      const wsUrl = `${gatewayUrl.replace('http', 'ws')}?v=10&encoding=json`
      this.ws = new WebSocket(wsUrl)

      this.ws.onopen = () => {
        console.log('[Discord] Gateway 已连接')
        this.reconnectAttempts = 0
      }

      this.ws.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data)
          this.handleGatewayEvent(payload)
        } catch (err) {
          console.error('[Discord] 解析 Gateway 消息失败:', err)
        }
      }

      this.ws.onerror = (err) => {
        console.error('[Discord] Gateway 错误:', err)
      }

      this.ws.onclose = () => {
        console.log('[Discord] Gateway 已断开')
        this.ws = null
        this.attemptReconnect()
      }
    }).catch((err) => {
      console.error('[Discord] 获取 Gateway URL 失败:', err)
    })
  }

  private async attemptReconnect(): Promise<void> {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[Discord] 达到最大重连次数，停止重连')
      return
    }

    this.reconnectAttempts++
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1)
    console.log(`[Discord] ${delay}ms 后尝试重连 (${this.reconnectAttempts}/${this.maxReconnectAttempts})`)

    await new Promise(resolve => setTimeout(resolve, delay))
    this.connectGateway()
  }

  private handleGatewayEvent(payload: any): void {
    const op = payload.op
    const d = payload.d
    const t = payload.t
    const s = payload.s

    // 更新序列号
    if (s) {
      this.sequence = s
    }

    switch (op) {
      case 10: // Hello
        console.log(`[Discord] 收到 Hello，心跳间隔: ${d.heartbeat_interval}ms`)
        this.startHeartbeat(d.heartbeat_interval)
        // 发送 Identify
        this.sendIdentify()
        break

      case 11: // Heartbeat ACK
        // 心跳确认
        break

      case 0: // Dispatch
        if (t === 'READY') {
          console.log(`[Discord] 已就绪: ${d.user?.username}`)
          this.botUserId = d.user?.id
          this.botUsername = `${d.user?.username}#${d.user?.discriminator || '0'}`
        } else if (t === 'MESSAGE_CREATE') {
          this.handleMessageCreate(d)
        }
        break

      case 7: // Reconnect
        console.log('[Discord] 服务器要求重连')
        this.ws?.close()
        break

      case 9: // Invalid Session
        console.error('[Discord] Session 无效，尝试重新 Identify')
        this.reconnectAttempts = 0
        this.connectGateway()
        break

      default:
        break
    }
  }

  private startHeartbeat(interval: number): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
    }

    this.heartbeatInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          op: 1,
          d: this.sequence,
        }))
      }
    }, interval)
  }

  private sendIdentify(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {return}

    const identify = {
      op: 2,
      d: {
        token: this.botToken,
        intents: 1 << 9 | 1 << 15, // Message Content + Guild Messages + Direct Messages
        properties: {
          os: 'windows',
          browser: 'lumina',
          device: 'lumina',
        },
      },
    }

    this.ws.send(JSON.stringify(identify))
  }

  private handleMessageCreate(data: any): void {
    // 忽略 Bot 自身消息
    if (data.author?.bot) {return}

    const channelId = data.channel_id
    const guildId = data.guild_id
    const isGroup = !!guildId

    // 解析消息内容
    let text = data.content || ''
    if (data.embeds?.length > 0) {
      text += '\n[Embeds]'
      for (const embed of data.embeds.slice(0, 3)) {
        text += `\n- ${embed.title || ''}: ${embed.description || ''}`
      }
    }
    if (data.attachments?.length > 0) {
      text += '\n[Attachments]'
      for (const att of data.attachments) {
        text += `\n- ${att.filename} (${att.url})`
      }
    }

    const msg: ChannelMessage = {
      id: data.id,
      channel: 'discord',
      fromUser: data.author?.id || '',
      fromUserName: data.author?.username || data.author?.display_name || '',
      groupId: isGroup ? guildId : undefined,
      groupName: isGroup ? data.guild?.name : undefined,
      text,
      timestamp: Date.now(),
      raw: data,
    }

    if (this.messageHandler) {
      this.messageHandler(msg)
    }
  }

  // ── HTTP 辅助方法 ──────────────────────────────────────

  private discordGet(path: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'discord.com',
        path: `/api/v10${path}`,
        method: 'GET',
        headers: {
          'Authorization': `Bot ${this.botToken}`,
          'Content-Type': 'application/json',
          'User-Agent': 'LuminaLife/1.0 (https://github.com/nicetocu/lumina)',
        },
        timeout: 10000,
      }

      const req = https.request(options, (res) => {
        let data = ''
        res.on('data', (chunk: string) => (data += chunk))
        res.on('end', () => {
          try { resolve(JSON.parse(data)) }
          catch { resolve({}) }
        })
      })

      req.on('error', reject)
      req.on('timeout', () => {
        req.destroy()
        reject(new Error('Discord API 请求超时'))
      })
      req.end()
    })
  }

  private discordPost(path: string, body: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify(body)
      const options = {
        hostname: 'discord.com',
        path: `/api/v10${path}`,
        method: 'POST',
        headers: {
          'Authorization': `Bot ${this.botToken}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData).toString(),
          'User-Agent': 'LuminaLife/1.0 (https://github.com/nicetocu/lumina)',
        },
        timeout: 10000,
      }

      const req = https.request(options, (res) => {
        let data = ''
        res.on('data', (chunk: string) => (data += chunk))
        res.on('end', () => {
          try { resolve(JSON.parse(data)) }
          catch { resolve({}) }
        })
      })

      req.on('error', reject)
      req.on('timeout', () => {
        req.destroy()
        reject(new Error('Discord API 请求超时'))
      })
      req.write(postData)
      req.end()
    })
  }
}
