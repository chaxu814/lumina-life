// ============================================================
// channels/adapters/qq.ts — 📡 QQ 频道/群机器人适配器 V2
//
// 实现:
//   - QQ 官方 Bot API 发送消息 (v1)
//   - Webhook 模式接收消息 + Ed25519 签名校验 (2025+)
//   - WebSocket Gateway 模式接收消息 (心跳/重连/Session 恢复)
//   - 支持频道消息、私信、群聊
//
// 前置条件:
//   1. QQ 开放平台创建机器人 https://bot.q.qq.com/
//   2. 获取 Bot App ID、Bot Token、Bot Secret（AppSecret）
//   3. Webhook 模式: 配置公网 HTTPS 回调地址
//   4. WebSocket 模式: 无需公网，配置 IP 白名单
//
// API 文档: https://bot.q.qq.com/wiki/develop/api/
// ============================================================

import * as https from 'https'
import * as crypto from 'node:crypto'
import type {
  ChannelType, ChannelMessage, ChannelSendRequest,
  ChannelConfig, ChannelAdapter,
} from '../types'

// ── 常量 ────────────────────────────────────────────────

/** QQ Bot API 认证头 = "Bot {appID}.{botToken}" */
function buildAuth(appId: string, botToken: string): string {
  return `Bot ${appId}.${botToken}`
}

/** QQ Bot WebSocket 事件订阅 Intents */
const QQ_INTENTS = {
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1,
  GUILD_MESSAGES: 1 << 9,        // AT_MESSAGE_CREATE
  GUILD_MESSAGE_REACTIONS: 1 << 10,
  DIRECT_MESSAGE: 1 << 12,       // DIRECT_MESSAGE_CREATE
  OPEN_FORUM_EVENT: 1 << 18,
  AUDIO_LIVE_CHANNEL: 1 << 19,
  C2C_MESSAGE: 1 << 24,          // C2C_MESSAGE_CREATE
  GROUP_MESSAGE: 1 << 25,        // GROUP_MESSAGE_CREATE
  INTERACTION: 1 << 26,
  MESSAGE_AUDIT: 1 << 27,
  FORUMS_EVENT: 1 << 28,
}

// ── Ed25519 工具 ─────────────────────────────────────────

/** 将 Bot Secret 扩展为 32 字节 Ed25519 种子 */
function expandSeed(secret: string): Buffer {
  const buf = Buffer.from(secret, 'utf-8')
  const seed = Buffer.alloc(32)
  for (let i = 0; i < 32; i++) {
    seed[i] = buf[i % buf.length]
  }
  return seed
}

/** 从 seed 创建 Ed25519 密钥对（PKCS#8 DER 格式） */
function createEd25519KeyPair(seed: Buffer) {
  // Ed25519 PKCS#8 私钥前缀
  const prefix = Buffer.from('302e020100300506032b657004220420', 'hex')
  const derKey = Buffer.concat([prefix, seed])
  const privateKey = crypto.createPrivateKey({
    key: derKey,
    format: 'der',
    type: 'pkcs8',
  })
  const publicKey = crypto.createPublicKey(privateKey)
  return { privateKey, publicKey }
}

/** Ed25519 签名: signature = hex(Ed25519_sign(privateKey, data)) */
function ed25519Sign(secret: string, data: string): string {
  const seed = expandSeed(secret)
  const { privateKey } = createEd25519KeyPair(seed)
  const sig = crypto.sign(null, Buffer.from(data, 'utf-8'), privateKey)
  return sig.toString('hex')
}

/** Ed25519 验签 */
function ed25519Verify(secret: string, data: string, signatureHex: string): boolean {
  try {
    const seed = expandSeed(secret)
    const { publicKey } = createEd25519KeyPair(seed)
    const sig = Buffer.from(signatureHex, 'hex')
    return crypto.verify(null, Buffer.from(data, 'utf-8'), publicKey, sig)
  } catch {
    return false
  }
}

// ── OpCode ──────────────────────────────────────────────

const QQ_OP = {
  DISPATCH: 0,          // 服务端推送事件
  HEARTBEAT: 1,         // 客户端发送心跳
  IDENTIFY: 2,          // 客户端鉴权
  RESUME: 6,            // 恢复连接
  HELLO: 10,            // 服务端发送 Hello（含心跳间隔）
  HEARTBEAT_ACK: 11,    // 服务端回复心跳 ACK
  CALLBACK_VALIDATE: 13,// Webhook 回调验证
}

// ═══════════════════════════════════════════════════════════
// QQAdapter
// ═══════════════════════════════════════════════════════════

export class QQAdapter implements ChannelAdapter {
  readonly type: ChannelType = 'qq'
  readonly name = 'QQ'

  // ── 配置 ──
  private config!: ChannelConfig
  private messageHandler: ((msg: ChannelMessage) => void) | null = null
  private appId = ''
  private botToken = ''
  private botSecret = '' // AppSecret，用于 Ed25519 签名
  private sandbox = false
  private wsMode = false // true=WebSocket, false=Webhook

  // ── 会话类型追踪（用于选择正确的发送 API） ──
  private convTypes = new Map<string, 'channel' | 'channel_dm' | 'c2c' | 'group'>()

  // ── WebSocket 状态 ──
  private ws: WebSocket | null = null
  private wsHeartbeatTimer: ReturnType<typeof setInterval> | null = null
  private wsHeartbeatInterval = 45000
  private wsSessionId = ''
  private wsLastSeq: number | null = null
  private wsReconnectAttempts = 0
  private readonly MAX_RECONNECT_ATTEMPTS = 10
  private readonly RECONNECT_BASE_DELAY = 1000  // 初始 1s，指数退避
  private wsGatewayUrl = ''
  private wsIntents = 0
  private keepAlive = false

  // ── 生命周期 ──────────────────────────────────────────

  async init(config: ChannelConfig): Promise<boolean> {
    this.config = config
    this.appId = config.credentials.appId || ''
    this.botToken = config.credentials.botToken || ''
    this.botSecret = config.credentials.botSecret || ''
    this.sandbox = config.options?.sandbox === true
    this.wsMode = config.options?.wsMode === true

    // 计算订阅 intents
    this.wsIntents =
      (config.options?.intents ?? 0) ||
      QQ_INTENTS.GUILD_MESSAGES | QQ_INTENTS.DIRECT_MESSAGE
    // 如果配置了 C2C/GROUP 选项，追加
    if (config.options?.enableC2C) {this.wsIntents |= QQ_INTENTS.C2C_MESSAGE}
    if (config.options?.enableGroup) {this.wsIntents |= QQ_INTENTS.GROUP_MESSAGE}

    if (!this.appId || !this.botToken) {
      console.warn('[QQ] ⚠️ 缺少 AppID 或 BotToken')
      return false
    }

    // 验证凭证
    const ok = await this.verifyBot()
    if (!ok) {
      console.warn('[QQ] ⚠️ Bot 验证失败，凭证可能有误')
      return false
    }
    console.log(`[QQ] ✅ Bot 凭证有效: ${this.appId}`)

    // WebSocket 模式：建立长连接
    if (this.wsMode) {
      const wsOk = await this.startWebSocket()
      if (!wsOk) {
        console.warn('[QQ] ⚠️ WebSocket 连接失败，回退到 Webhook 模式')
        this.wsMode = false
      }
    }

    console.log(`[QQ] ✅ 适配器已初始化 (mode: ${this.wsMode ? 'WebSocket' : 'Webhook'})`)
    return true
  }

  async send(request: ChannelSendRequest): Promise<boolean> {
    if (!this.appId || !this.botToken) {return false}

    // 根据会话类型选择正确的 API 端点
    const convType = this.convTypes.get(request.targetId)

    if (convType === 'c2c') {
      // QQ 消息列表私信: /v2/users/{openid}/messages
      return this.sendC2CMessage(request.targetId, request.text)
    }
    if (convType === 'group') {
      // QQ 群聊消息: /v2/groups/{group_openid}/messages
      return this.sendGroupMessage(request.targetId, request.text)
    }

    // 频道/频道私信（默认逻辑）
    if (request.isGroup || convType === 'channel') {
      return this.sendChannelMessage(request.targetId, request.text)
    } else {
      return this.sendDirectMessage(request.targetId, request.text)
    }
  }

  onMessage(handler: (msg: ChannelMessage) => void): void {
    this.messageHandler = handler
  }

  async healthCheck(): Promise<boolean> {
    if (!this.appId || !this.botToken) {return false}
    if (this.wsMode) {
      // WebSocket 模式下检查连接状态
      return this.ws !== null && this.ws.readyState === WebSocket.OPEN
    }
    return this.verifyBot()
  }

  async destroy(): Promise<void> {
    this.stopWebSocket()
    this.messageHandler = null
    this.keepAlive = false
    console.log('[QQ] 适配器已销毁')
  }

  // ── Webhook 回调处理 ──────────────────────────────────

  /**
   * 处理 QQ Webhook 回调
   * @param body 请求体
   * @param headers 请求头（用于签名校验）
   */
  async handleIncoming(
    body: any,
    headers?: Record<string, string>,
  ): Promise<{ status: number; body: string }> {
    // ── op=13 回调验证 ──
    if (body?.op === QQ_OP.CALLBACK_VALIDATE) {
      return this.handleValidation(body)
    }

    // ── 签名校验（有 botSecret 时） ──
    if (this.botSecret && headers) {
      const sigHeader = (headers['x-signature-ed25519'] || headers['X-Signature-Ed25519'] || '') as string
      const tsHeader = (headers['x-signature-timestamp'] || headers['X-Signature-Timestamp'] || '') as string
      if (sigHeader && tsHeader) {
        const bodyStr = JSON.stringify(body)
        const isValid = ed25519Verify(this.botSecret, tsHeader + bodyStr, sigHeader)
        if (!isValid) {
          console.warn('[QQ] ⚠️ Webhook 签名校验失败，丢弃请求')
          return { status: 401, body: 'signature verification failed' }
        }
      } else {
        console.warn('[QQ] ⚠️ Webhook 缺少签名头，跳过校验')
      }
    }

    // ── 事件分发 ──
    if (!this.messageHandler) {return { status: 200, body: 'OK' }}

    const eventType = body?.t || ''
    const eventData = body?.d || {}

    // 支持的事件类型（Webhook + WebSocket 统一格式）
    const supportedEvents = [
      'AT_MESSAGE_CREATE',
      'DIRECT_MESSAGE_CREATE',
      'C2C_MESSAGE_CREATE',
      'GROUP_MESSAGE_CREATE',
    ]
    if (supportedEvents.includes(eventType)) {
      const msg = this.parseQQMessage(eventType, eventData, body)
      if (msg) {
        this.messageHandler(msg)
      }
    }

    return { status: 200, body: 'ok' }
  }

  /** 沙箱模式开关 */
  setSandbox(enabled: boolean): void {
    this.sandbox = enabled
  }

  // ── WebSocket 管理 ────────────────────────────────────

  /** 启动 WebSocket Gateway 连接 */
  async startWebSocket(): Promise<boolean> {
    this.keepAlive = true
    this.wsReconnectAttempts = 0

    try {
      // 1. 获取 Gateway URL
      this.wsGatewayUrl = await this.getGatewayUrl()
      if (!this.wsGatewayUrl) {return false}

      // 2. 连接
      await this.connectWebSocket()
      return true
    } catch (err: any) {
      console.error(`[QQ] WebSocket 启动失败:`, err.message)
      return false
    }
  }

  /** 获取 WebSocket Gateway 地址 */
  private async getGatewayUrl(): Promise<string> {
    const data = await this.qqApiGet('/gateway/bot')
    if (data?.url) {
      return data.url
    }
    // fallback 到默认地址
    return this.sandbox
      ? 'wss://sandbox.api.sgroup.qq.com/websocket/'
      : 'wss://api.sgroup.qq.com/websocket/'
  }

  /** 建立 WebSocket 连接 */
  private connectWebSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const ws = new WebSocket(this.wsGatewayUrl)
        const timeout = setTimeout(() => {
          reject(new Error('WebSocket 连接超时'))
        }, 15000)

        ws.onopen = () => {
          clearTimeout(timeout)
          console.log('[QQ] 🔗 WebSocket 已连接')
          this.ws = ws
          this.wsReconnectAttempts = 0
          resolve()
        }

        ws.onmessage = (event: MessageEvent) => {
          this.handleWsMessage(event)
        }

        ws.onclose = (event: CloseEvent) => {
          console.log(`[QQ] WebSocket 断开 (code=${event.code})`)
          this.ws = null
          this.wsHeartbeatTimer = null
          if (this.keepAlive) {
            this.scheduleReconnect()
          }
        }

        ws.onerror = (err: Event) => {
          console.error('[QQ] WebSocket 错误:', err)
          // onclose 会随后触发
        }
      } catch (err) {
        reject(err)
      }
    })
  }

  /** 处理 WebSocket 消息 */
  private handleWsMessage(event: MessageEvent): void {
    try {
      const data = typeof event.data === 'string'
        ? JSON.parse(event.data)
        : JSON.parse(new TextDecoder().decode(event.data as Buffer))

      const op = data.op
      const d = data.d || {}
      const s = data.s // 序列号（仅 DISPATCH 有）
      const t = data.t // 事件类型（仅 DISPATCH 有）

      switch (op) {
        case QQ_OP.HELLO: // 10 — 连接建立，开始心跳
          this.wsHeartbeatInterval = d.heartbeat_interval || 45000
          this.startHeartbeat()
          // 鉴权
          this.sendWsIdentify()
          break

        case QQ_OP.DISPATCH: { // 0 — 事件
          if (s) {this.wsLastSeq = s}
          // 记录 session_id（来自 READY 事件）
          if (t === 'READY') {
            this.wsSessionId = d.session_id || ''
            console.log(`[QQ] ✅ WebSocket 会话已建立: ${this.wsSessionId}`)
            break
          }
          if (t === 'RESUMED') {
            console.log(`[QQ] 🔄 WebSocket 会话已恢复`)
            break
          }
          // 消息事件 -> 分发
          this.dispatchWsEvent(t, d)
          break
        }

        case QQ_OP.HEARTBEAT_ACK: // 11 — 心跳回复
          // 无需处理
          break

        case QQ_OP.CALLBACK_VALIDATE: // 13 — WebSocket 模式下不会出现
          break

        default:
          console.log(`[QQ] 未处理 WebSocket op=${op}`)
      }
    } catch (err: any) {
      console.error(`[QQ] 解析 WebSocket 消息失败:`, err.message)
    }
  }

  /** 分发 WebSocket 事件到消息处理器 */
  private dispatchWsEvent(eventType: string, d: any): void {
    if (!this.messageHandler) {return}

    const supportedEvents = [
      'AT_MESSAGE_CREATE',
      'DIRECT_MESSAGE_CREATE',
      'C2C_MESSAGE_CREATE',
      'GROUP_MESSAGE_CREATE',
    ]
    if (supportedEvents.includes(eventType)) {
      // WebSocket 事件的 d 就是事件数据
      const msg = this.parseQQMessage(eventType, d, { t: eventType, d })
      if (msg) {
        this.messageHandler(msg)
      }
    }
  }

  /** 发送 WebSocket 鉴权（Identify） */
  private sendWsIdentify(): void {
    if (!this.ws) {return}
    // 如果有 session_id 且上次 seq 存在，尝试恢复
    if (this.wsSessionId && this.wsLastSeq !== null) {
      this.ws.send(JSON.stringify({
        op: QQ_OP.RESUME,
        d: {
          token: buildAuth(this.appId, this.botToken),
          session_id: this.wsSessionId,
          seq: this.wsLastSeq,
        },
      }))
      return
    }
    // 新连接鉴权
    this.ws.send(JSON.stringify({
      op: QQ_OP.IDENTIFY,
      d: {
        token: buildAuth(this.appId, this.botToken),
        intents: this.wsIntents,
        shard: [0, 1],
        properties: {
          $os: process.platform,
          $browser: 'Lumina',
          $device: 'Lumina',
        },
      },
    }))
  }

  /** 启动心跳定时器 */
  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.wsHeartbeatTimer = setInterval(() => {
      this.sendWsHeartbeat()
    }, this.wsHeartbeatInterval)
  }

  /** 停止心跳定时器 */
  private stopHeartbeat(): void {
    if (this.wsHeartbeatTimer) {
      clearInterval(this.wsHeartbeatTimer)
      this.wsHeartbeatTimer = null
    }
  }

  /** 发送心跳 */
  private sendWsHeartbeat(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {return}
    this.ws.send(JSON.stringify({
      op: QQ_OP.HEARTBEAT,
      d: this.wsLastSeq,
    }))
  }

  /** 指数退避重连 */
  private scheduleReconnect(): void {
    if (this.wsReconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      console.error(`[QQ] WebSocket 已达最大重连次数 (${this.MAX_RECONNECT_ATTEMPTS})，停止重连`)
      return
    }
    this.wsReconnectAttempts++
    // 获取新的 Gateway URL（可能变了）
    this.getGatewayUrl().then(url => {
      this.wsGatewayUrl = url
      const delay = Math.min(
        this.RECONNECT_BASE_DELAY * Math.pow(2, this.wsReconnectAttempts - 1),
        30000, // 最大 30s
      )
      console.log(`[QQ] 🔄 ${delay}ms 后重连 (第 ${this.wsReconnectAttempts} 次)...`)
      setTimeout(() => {
        if (this.keepAlive) {
          this.connectWebSocket().catch(err => {
            console.error(`[QQ] 重连失败:`, err.message)
          })
        }
      }, delay)
    })
  }

  /** 停止 WebSocket 连接 */
  private stopWebSocket(): void {
    this.keepAlive = false
    this.stopHeartbeat()
    if (this.ws) {
      try {
        this.ws.close(1000, 'adapter destroy')
      } catch {}
      this.ws = null
    }
    this.wsSessionId = ''
    this.wsLastSeq = null
  }

  // ── op=13 回调验证 ────────────────────────────────────

  /** 处理 QQ 回调验证请求 (op=13) */
  private handleValidation(body: any): { status: number; body: string } {
    const d = body?.d || {}
    const plainToken = d.plain_token || ''
    const eventTs = d.event_ts || ''

    if (!plainToken || !eventTs || !this.botSecret) {
      console.warn('[QQ] ⚠️ 回调验证缺少参数或 BotSecret')
      return { status: 200, body: JSON.stringify({ plain_token: plainToken, signature: '' }) }
    }

    try {
      const signature = ed25519Sign(this.botSecret, eventTs + plainToken)
      console.log('[QQ] ✅ 回调验证成功')
      return {
        status: 200,
        body: JSON.stringify({ plain_token: plainToken, signature }),
      }
    } catch (err: any) {
      console.error(`[QQ] ❌ 回调验证签名失败:`, err.message)
      return { status: 200, body: JSON.stringify({ plain_token: plainToken, signature: '' }) }
    }
  }

  // ── 内部方法 ──────────────────────────────────────────

  /** 验证 Bot 凭证 */
  private async verifyBot(): Promise<boolean> {
    try {
      const data = await this.qqApiGet('/users/@me')
      return !!data?.id
    } catch {
      return false
    }
  }

  /** 发送频道消息 */
  private async sendChannelMessage(channelId: string, text: string): Promise<boolean> {
    try {
      const data = await this.qqApiPost(`/channels/${channelId}/messages`, {
        content: text,
        msg_type: 0,
      })
      return !!data?.id
    } catch (err: any) {
      console.error(`[QQ] 频道消息发送失败:`, err.message)
      return false
    }
  }

  /** 发送私信 */
  private async sendDirectMessage(guildId: string, text: string): Promise<boolean> {
    try {
      const data = await this.qqApiPost(`/dms/${guildId}/messages`, {
        content: text,
        msg_type: 0,
      })
      return !!data?.id
    } catch (err: any) {
      console.error(`[QQ] 私信发送失败:`, err.message)
      return false
    }
  }

  /** 发送 C2C 消息（QQ 消息列表私信） */
  private async sendC2CMessage(openId: string, text: string): Promise<boolean> {
    try {
      const data = await this.qqApiPost(`/v2/users/${openId}/messages`, {
        content: text,
        msg_type: 0,
      })
      return !!data?.id
    } catch (err: any) {
      console.error(`[QQ] C2C 消息发送失败:`, err.message)
      return false
    }
  }

  /** 发送群聊消息（QQ 群） */
  private async sendGroupMessage(groupOpenId: string, text: string): Promise<boolean> {
    try {
      const data = await this.qqApiPost(`/v2/groups/${groupOpenId}/messages`, {
        content: text,
        msg_type: 0,
      })
      return !!data?.id
    } catch (err: any) {
      console.error(`[QQ] 群消息发送失败:`, err.message)
      return false
    }
  }

  /** 解析 QQ 消息为统一格式 */
  private parseQQMessage(eventType: string, d: any, raw: any): ChannelMessage | null {
    try {
      const isDirectMessage =
        eventType === 'DIRECT_MESSAGE_CREATE' ||
        eventType === 'C2C_MESSAGE_CREATE' ||
        raw?.type === 'direct_message'

      // 群聊/频道消息
      const isGroupMessage = eventType === 'GROUP_MESSAGE_CREATE'
      const isC2C = eventType === 'C2C_MESSAGE_CREATE'

      // 不同事件类型的字段位置不同
      const author = d?.author || d?.member || {}
      const content = d?.content || ''
      const msgId = d?.id || `qq_${Date.now()}`
      const timestamp = d?.timestamp ? new Date(d.timestamp).getTime() : Date.now()

      // 跳过纯 mention 的空消息
      const cleanContent = (content || '').replace(/<@!\d+>/g, '').replace(/<@\d+>/g, '').trim()
      if (!cleanContent) {return null}

      const userId = author?.id || d?.author?.id || ''
      const userName = author?.username || author?.nick || author?.name || ''

      const msg: ChannelMessage = {
        id: msgId,
        channel: 'qq',
        fromUser: userId,
        fromUserName: userName,
        text: cleanContent,
        timestamp,
        raw,
      }

      // 区分群聊和私信 + 记录会话类型
      if (isGroupMessage) {
        // GROUP_MESSAGE_CREATE: group_openid 标识群
        const groupOpenId = d?.group_openid || d?.group_id || ''
        msg.groupId = groupOpenId
        msg.groupName = 'QQ群'
        if (groupOpenId) {this.convTypes.set(groupOpenId, 'group')}
      } else if (isC2C) {
        // C2C_MESSAGE_CREATE: QQ 消息列表私聊
        this.convTypes.set(userId, 'c2c')
      } else if (!isDirectMessage) {
        // AT_MESSAGE_CREATE（频道）
        const channelId = d?.channel_id || ''
        const guildId = d?.guild_id || ''
        msg.groupId = channelId || guildId
        msg.groupName = d?.guild_name || d?.channel_name || 'QQ频道'
        if (channelId) {this.convTypes.set(channelId, 'channel')}
      } else {
        // DIRECT_MESSAGE_CREATE（频道私信）
        this.convTypes.set(userId, 'channel_dm')
      }

      return msg
    } catch {
      return null
    }
  }

  // ── HTTP 工具 ─────────────────────────────────────────

  private get apiBase(): string {
    return this.sandbox ? 'https://sandbox.api.sgroup.qq.com' : 'https://api.sgroup.qq.com'
  }

  private get authHeader(): string {
    return buildAuth(this.appId, this.botToken)
  }

  private qqApiGet(path: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const hostname = this.sandbox ? 'sandbox.api.sgroup.qq.com' : 'api.sgroup.qq.com'
      const options: https.RequestOptions = {
        hostname,
        path,
        method: 'GET',
        headers: { Authorization: this.authHeader },
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

  private qqApiPost(path: string, body: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify(body)
      const hostname = this.sandbox ? 'sandbox.api.sgroup.qq.com' : 'api.sgroup.qq.com'
      const options: https.RequestOptions = {
        hostname,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: this.authHeader,
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
