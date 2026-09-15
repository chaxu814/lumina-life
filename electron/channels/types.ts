// ============================================================
// channels/types.ts — 📡 渠道连接类型定义 (Phase C)
// ============================================================

/** 渠道平台类型 */
export type ChannelType = 'dingtalk' | 'wechat' | 'slack' | 'telegram' | 'qq' | 'discord' | 'custom'

/** 渠道消息 */
export interface ChannelMessage {
  id: string
  channel: ChannelType
  fromUser: string
  fromUserName?: string
  groupId?: string
  groupName?: string
  text: string
  timestamp: number
  raw?: any
}

/** 渠道发送消息请求 */
export interface ChannelSendRequest {
  targetId: string
  isGroup: boolean
  text: string
  replyTo?: string
}

/** 渠道配置 */
export interface ChannelConfig {
  enabled: boolean
  type: ChannelType
  name: string
  credentials: Record<string, string>
  webhookPath?: string
  options?: Record<string, any>
}

/** 渠道适配器接口 */
export interface ChannelAdapter {
  readonly type: ChannelType
  readonly name: string
  init(config: ChannelConfig): Promise<boolean>
  send(request: ChannelSendRequest): Promise<boolean>
  onMessage(handler: (msg: ChannelMessage) => void): void
  healthCheck(): Promise<boolean>
  destroy(): Promise<void>
}

/** 渠道管理器配置 */
export interface ChannelManagerConfig {
  configDir: string
  onMessage?: (msg: ChannelMessage) => Promise<string | void>
}
