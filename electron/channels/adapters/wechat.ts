// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// channels/adapters/wechat.ts — 📡 企业微信渠道适配器 (Phase C)
//
// 实现:
//   - 企业微信群 Bot Webhook 发送消息
//   - 企业微信回调模式接收消息
//   - 支持 text / markdown 消息格式
//
// 前置条件:
//   1. 企业微信后台创建应用 https://work.weixin.qq.com/
//   2. 获取 Webhook URL 或配置回调 URL
// ============================================================

import * as https from 'https'
import * as http from 'http'
import * as crypto from 'crypto'
import type {
  ChannelType, ChannelMessage, ChannelSendRequest,
  ChannelConfig, ChannelAdapter,
} from '../types'

interface WeChatToken {
  accessToken: string
  expiresAt: number
}

export class WeChatAdapter implements ChannelAdapter {
  readonly type: ChannelType = 'wechat'
  readonly name = 'WeChat'

  private config!: ChannelConfig
  private token: WeChatToken | null = null
  private messageHandler: ((msg: ChannelMessage) => void) | null = null
  private keepAlive = false

  async init(config: ChannelConfig): Promise<boolean> {
    this.config = config
    this.keepAlive = true

    // 企业微信需要 CorpID + CorpSecret 获取 token
    if (config.credentials.corpId && config.credentials.corpSecret) {
      await this.refreshToken()
    }

    console.log('[WeChat] ✅ 适配器已初始化')
    return true
  }

  async send(request: ChannelSendRequest): Promise<boolean> {
    // 优先使用 Webhook URL（最简单）
    const webhookUrl = this.config.credentials.webhookUrl
    if (webhookUrl) {
      return this.sendViaWebhook(webhookUrl, request.text)
    }

    // 否则通过 API
    await this.ensureToken()
    if (!this.token) {return false}

    if (request.isGroup) {
      return this.sendGroupMessage(request.targetId, request.text)
    } else {
      return this.sendSingleMessage(request.targetId, request.text)
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
    this.messageHandler = null
    this.token = null
    console.log('[WeChat] 适配器已销毁')
  }

  /** 处理企业微信回调消息（由 Webhook 路由调用） */
  async handleIncoming(query: any, body: any): Promise<string | null> {
    if (!this.messageHandler) {return null}

    // 企业微信 URL 回调验证
    if (query?.echostr) {
      return this.verifyUrl(query)
    }

    // 解析消息
    const msg = this.parseMessage(body)
    if (msg) {
      this.messageHandler(msg)
    }
    return 'ok'
  }

  // ── 内部方法 ──────────────────────────────────────

  private async refreshToken(): Promise<void> {
    const { corpId, corpSecret } = this.config.credentials
    try {
      const data = await this.httpRequest(
        'GET',
        'qyapi.weixin.qq.com',
        `/cgi-bin/gettoken?corpid=${corpId}&corpsecret=${corpSecret}`,
      )
      if (data.access_token) {
        this.token = {
          accessToken: data.access_token,
          expiresAt: Date.now() + (data.expires_in || 7200) * 1000 - 120000,
        }
      }
    } catch (err: any) {
      console.error('[WeChat] Token 刷新失败:', err.message)
    }
  }

  private async ensureToken(): Promise<void> {
    if (!this.token || Date.now() >= this.token.expiresAt) {
      await this.refreshToken()
    }
  }

  /** Webhook 模式发送 */
  private sendViaWebhook(webhookUrl: string, text: string): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        const url = new URL(webhookUrl)
        const postData = JSON.stringify({
          msgtype: 'text',
          text: { content: text },
        })
        const options: https.RequestOptions = {
          hostname: url.hostname,
          path: url.pathname + url.search,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000,
        }
        const req = https.request(options, (res) => {
          resolve(res.statusCode === 200)
        })
        req.on('error', () => resolve(false))
        req.write(postData)
        req.end()
      } catch {
        resolve(false)
      }
    })
  }

  /** 应用消息（单聊） */
  private async sendSingleMessage(userId: string, text: string): Promise<boolean> {
    try {
      const data = await this.httpRequest(
        'POST',
        'qyapi.weixin.qq.com',
        `/cgi-bin/message/send?access_token=${this.token!.accessToken}`,
        {
          touser: userId,
          msgtype: 'text',
          agentid: this.config.credentials.agentId,
          text: { content: text },
        },
      )
      return data.errcode === 0
    } catch {
      return false
    }
  }

  /** 群聊消息 */
  private async sendGroupMessage(chatId: string, text: string): Promise<boolean> {
    try {
      const data = await this.httpRequest(
        'POST',
        'qyapi.weixin.qq.com',
        `/cgi-bin/appchat/send?access_token=${this.token!.accessToken}`,
        {
          chatid: chatId,
          msgtype: 'text',
          text: { content: text },
        },
      )
      return data.errcode === 0
    } catch {
      return false
    }
  }

  /** URL 回调验证（企业微信要求返回 echostr 原样） */
  private verifyUrl(query: any): string {
    const { msg_signature, timestamp, nonce, echostr } = query
    const token = this.config.credentials.token || ''
    const arr = [token, timestamp, nonce].sort().join('')
    const sha1 = crypto.createHash('sha1').update(arr).digest('hex')
    if (sha1 === msg_signature) {
      return echostr
    }
    return ''
  }

  private parseMessage(_body: any): ChannelMessage | null {
    // 企业微信 XML/JSON 回调解析
    //   企业微信的回调可以是 XML（普通消息）或 JSON（回调）
    try {
      // 尝试 JSON 解析（企业微信回调 JSON 格式）
      if (_body?.MsgType || _body?.msgtype) {
        const msgType = _body.MsgType || _body.msgtype || ''
        const fromUser = _body.FromUserName || _body.fromUserName || _body.fromusername || ''
        const toUser = _body.ToUserName || _body.toUserName || _body.tousername || ''
        const msgId = _body.MsgId || _body.msgid || _body.msgId || `wx_${Date.now()}`
        const createTime = parseInt(_body.CreateTime || _body.createTime || '0', 10) * 1000

        // 文本消息
        if (msgType === 'text') {
          const content = _body.Content || _body.content || ''
          // 企业微信群聊中，chatid 标识群，fromUserName 是发送者
          const chatId = _body.ChatId || _body.chatId || _body.chatid || ''
          return {
            id: String(msgId),
            channel: 'wechat',
            fromUser: fromUser || toUser,  // 用 toUser 作为 fallback
            fromUserName: _body.senderName || _body.sender_name || '',
            groupId: chatId || undefined,
            groupName: _body.chatName || _body.chat_name || undefined,
            text: typeof content === 'string' ? content : String(content),
            timestamp: !isNaN(createTime) ? createTime : Date.now(),
            raw: _body,
          }
        }

        // 图片/语音等非文本消息 — 只记录有文本描述的情况
        if (msgType === 'image' && _body.PicUrl) {
          return {
            id: String(msgId),
            channel: 'wechat',
            fromUser: fromUser || toUser,
            fromUserName: '',
            groupId: _body.ChatId || undefined,
            text: `[图片] ${_body.PicUrl || ''}`,
            timestamp: !isNaN(createTime) ? createTime : Date.now(),
            raw: _body,
          }
        }
      }

      // 如果 _body 是 Buffer/字符串（XML 格式），需要 xml2js 解析
      // 但为了保持零依赖，记录传入标记供后续扩展
      if (typeof _body === 'string' || _body instanceof Buffer) {
        const str = _body instanceof Buffer ? _body.toString('utf-8') : _body
        if (str.includes('<xml>') || str.includes('<MsgType>')) {
          // XML 格式：需要 xml2js 解析，此处返回占位
          console.warn('[WeChat] 收到 XML 格式回调，请安装 xml2js 以解析')
        }
      }
    } catch (err) {
      console.warn('[WeChat] 消息解析异常:', err)
    }
    return null
  }

  private httpRequest(
    method: string,
    hostname: string,
    path: string,
    body?: any,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const postData = body ? JSON.stringify(body) : ''
      const options: https.RequestOptions = {
        hostname, path, method,
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000,
      }
      if (postData) {
        (options.headers as Record<string, string>)['Content-Length'] = Buffer.byteLength(postData).toString()
      }

      const req = https.request(options, (res) => {
        let data = ''
        res.on('data', (chunk: string) => (data += chunk))
        res.on('end', () => {
          try { resolve(JSON.parse(data)) } catch { resolve({ raw: data }) }
        })
      })
      req.on('error', reject)
      if (postData) {req.write(postData)}
      req.end()
    })
  }
}
