// ============================================================
// channels/adapters/dingtalk.ts — 📡 钉钉渠道适配器 (Phase C)
//
// 实现:
//   - Stream 模式接收消息（WebSocket 长连接）
//   - HTTP 模式发送消息（钉钉开放平台 API）
//   - 支持单聊和群聊
//
// 前置条件:
//   1. 钉钉开放平台创建应用 https://open.dingtalk.com/
//   2. 获取 Client ID 和 Client Secret
//   3. 配置消息接收模式为 Stream
// ============================================================

import * as https from 'https'
import * as http from 'http'
import type {
  ChannelType, ChannelMessage, ChannelSendRequest,
  ChannelConfig, ChannelAdapter,
} from '../types'

interface DingTalkToken {
  accessToken: string
  expiresAt: number
}

export class DingTalkAdapter implements ChannelAdapter {
  readonly type: ChannelType = 'dingtalk'
  readonly name = 'DingTalk'

  private config!: ChannelConfig
  private token: DingTalkToken | null = null
  private messageHandler: ((msg: ChannelMessage) => void) | null = null
  private streamClient: any = null
  private keepAlive = false

  async init(config: ChannelConfig): Promise<boolean> {
    this.config = config
    this.keepAlive = true

    // 获取 Access Token
    await this.refreshToken()

    // 启动 Stream 模式接收消息（如果有 ws 支持）
    this.startStreamListener()

    console.log('[DingTalk] ✅ 适配器已初始化')
    return true
  }

  async send(request: ChannelSendRequest): Promise<boolean> {
    await this.ensureToken()

    const robotCode = this.config.credentials.robotCode || this.config.credentials.clientId
    if (!robotCode) {
      console.error('[DingTalk] 缺少 robotCode')
      return false
    }

    // 判断单聊/群聊
    if (request.isGroup) {
      return this.sendGroupMessage(robotCode, request.targetId, request.text)
    } else {
      return this.sendSingleMessage(robotCode, request.targetId, request.text)
    }
  }

  onMessage(handler: (msg: ChannelMessage) => void): void {
    this.messageHandler = handler
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.ensureToken()
      return !!this.token
    } catch {
      return false
    }
  }

  async destroy(): Promise<void> {
    this.keepAlive = false
    if (this.streamClient && typeof this.streamClient.close === 'function') {
      this.streamClient.close()
    }
    this.streamClient = null
    this.messageHandler = null
    this.token = null
    console.log('[DingTalk] 适配器已销毁')
  }

  // ── 内部方法 ──────────────────────────────────────

  private async refreshToken(): Promise<void> {
    const { clientId, clientSecret } = this.config.credentials
    if (!clientId || !clientSecret) {
      console.error('[DingTalk] 缺少 Client ID 或 Client Secret')
      return
    }

    try {
      const data = await this.httpRequest(
        'POST',
        'api.dingtalk.com',
        '/v1.0/oauth2/accessToken',
        { appKey: clientId, appSecret: clientSecret },
      )

      if (data.accessToken) {
        this.token = {
          accessToken: data.accessToken,
          expiresAt: Date.now() + (data.expireIn || 7200) * 1000 - 60000,
        }
        console.log('[DingTalk] ✅ Token 已刷新')
      }
    } catch (err: any) {
      console.error('[DingTalk] Token 刷新失败:', err.message)
    }
  }

  private async ensureToken(): Promise<void> {
    if (!this.token || Date.now() >= this.token.expiresAt) {
      await this.refreshToken()
    }
  }

  /** 发送单聊消息 (Webhook 模式) */
  private async sendSingleMessage(robotCode: string, userId: string, text: string): Promise<boolean> {
    try {
      await this.httpRequest(
        'POST',
        'api.dingtalk.com',
        '/v1.0/robot/oToMessages/batchSend',
        {
          robotCode,
          userIds: [userId],
          msgKey: 'sampleText',
          msgParam: JSON.stringify({ content: text }),
        },
        { 'x-acs-dingtalk-access-token': this.token?.accessToken || '' },
      )
      return true
    } catch (err: any) {
      console.error('[DingTalk] 单聊发送失败:', err.message)
      return false
    }
  }

  /** 发送群聊消息 */
  private async sendGroupMessage(robotCode: string, openConversationId: string, text: string): Promise<boolean> {
    try {
      await this.httpRequest(
        'POST',
        'api.dingtalk.com',
        '/v1.0/robot/groupMessages/send',
        {
          robotCode,
          openConversationId,
          msgKey: 'sampleText',
          msgParam: JSON.stringify({ content: text }),
        },
        { 'x-acs-dingtalk-token': this.token?.accessToken || '' },
      )
      return true
    } catch (err: any) {
      console.error('[DingTalk] 群聊发送失败:', err.message)
      return false
    }
  }

  /** Stream 模式接收消息 — 优先使用 @dingtalk/stream，回退 HTTP 轮询 */
  private startStreamListener(): void {
    this.startDtStream().then(ok => {
      if (!ok) {
        console.log('[DingTalk] ⚠️ @dingtalk/stream 不可用，回退到 HTTP 轮询')
        this.startHttpPolling()
      }
    })
  }

  /** 🆕 v16.0-fix: 尝试启动 @dingtalk/stream 长连接 */
  private async startDtStream(): Promise<boolean> {
    try {
      // @ts-ignore — @dingtalk/stream 是可选依赖，安装后才可用
      const { Client, SubscriptionType } = await import('@dingtalk/stream')
      if (!Client || !SubscriptionType) return false

      const client = new Client({
        clientId: this.config.credentials.clientId || '',
        clientSecret: this.config.credentials.clientSecret || '',
      })

      client.on('message', async (msg: any) => {
        // 解析消息
        const parsed = this.parseDingTalkMessage(msg)
        if (parsed && this.messageHandler) {
          this.messageHandler(parsed)
        }
      })

      // 注册回调
      await client.registerCallback(SubscriptionType.Callback, (
        _subscriptionId: string,
        _callbackDto: any,
      ) => {
        // 用 onMessage 处理
      })

      this.streamClient = client
      console.log('[DingTalk] ✅ Stream 长连接已建立')
      return true
    } catch {
      return false
    }
  }

  /** HTTP 轮询接收消息 */
  private startHttpPolling(): void {
    const robotCode = this.config.credentials.robotCode || this.config.credentials.clientId
    if (!robotCode) {
      console.warn('[DingTalk] 缺少 robotCode，无法消息轮询')
      return
    }

    const poll = async () => {
      if (!this.keepAlive) return
      try {
        await this.ensureToken()
        if (!this.token) return
        const data = await this.httpRequest(
          'POST', 'api.dingtalk.com', '/v1.0/robot/message/poll',
          { robotCode, maxResults: 10 },
          { 'x-acs-dingtalk-access-token': this.token.accessToken },
        )
        if (data?.messages) {
          for (const m of data.messages) {
            const parsed = this.parseDingTalkMessage(m)
            if (parsed && this.messageHandler) this.messageHandler(parsed)
          }
        }
      } catch { /* silent */ }
      if (this.keepAlive) setTimeout(poll, 3000)
    }
    poll()
    console.log('[DingTalk] 📡 HTTP 轮询已启动 (3s)')
  }

  /** 处理接收到的钉钉消息（由 webhook 调用） */
  async handleIncoming(rawBody: any): Promise<void> {
    if (!this.messageHandler) return

    // 钉钉回调格式解析
    const msg = this.parseDingTalkMessage(rawBody)
    if (msg) {
      this.messageHandler(msg)
    }
  }

  private parseDingTalkMessage(body: any): ChannelMessage | null {
    try {
      // DingTalk Stream 模式消息格式
      const headers = body?.headers || {}
      const data = body?.data || {}

      const senderId = headers?.senderId || data?.senderId || data?.senderStaffId || ''
      const senderName = headers?.senderNick || data?.senderNick || ''
      const conversationType = headers?.conversationType || data?.conversationType || ''
      const conversationId = headers?.conversationId || data?.conversationId || ''
      const content = data?.text?.content || data?.content || ''
      const msgId = headers?.messageId || data?.messageId || `dt_${Date.now()}`

      if (!senderId || !content) return null

      return {
        id: msgId,
        channel: 'dingtalk',
        fromUser: senderId,
        fromUserName: senderName,
        groupId: conversationType === '2' ? conversationId : undefined,
        groupName: conversationType === '2' ? (data?.conversationTitle || '群聊') : undefined,
        text: typeof content === 'string' ? content : JSON.stringify(content),
        timestamp: Date.now(),
        raw: body,
      }
    } catch {
      return null
    }
  }

  // ── HTTP 工具 ─────────────────────────────────────

  private httpRequest(
    method: string,
    hostname: string,
    path: string,
    body?: any,
    headers?: Record<string, string>,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const postData = body ? JSON.stringify(body) : ''
      const reqHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        ...headers,
      }
      if (postData) reqHeaders['Content-Length'] = Buffer.byteLength(postData).toString()

      const options = {
        hostname,
        path,
        method,
        headers: reqHeaders,
        timeout: 15000,
      }

      const req = https.request(options, (res) => {
        let data = ''
        res.on('data', (chunk: string) => (data += chunk))
        res.on('end', () => {
          try {
            resolve(JSON.parse(data))
          } catch {
            resolve({ raw: data })
          }
        })
      })

      req.on('error', reject)
      req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')) })

      if (postData) req.write(postData)
      req.end()
    })
  }
}
