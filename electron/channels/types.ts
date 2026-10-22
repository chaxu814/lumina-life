// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// channels/types.ts — 📡 渠道连接类型定义 (Phase C)
// ============================================================

/** 渠道平台类型 */
export type ChannelType = 'dingtalk' | 'wechat' | 'slack' | 'telegram' | 'qq' | 'discord' | 'openclaw' | 'custom'

/**
 * 渠道成熟度——**我们自己的诚实度声明，不是平台的能力评价**。
 *
 *   verified     已完成端到端真机验证（收发双向 + 长连接稳定）
 *   experimental 适配器已接线并能启动，但**未经端到端真机验证**
 *
 * 【为什么不直接全开】
 * 业界头部实现（数十个渠道适配器）已全部跑通真机。
 * 我们有 7 个适配器，其中只有 telegram 完成过端到端验证。把 7 个都标成
 * “已支持”是一种容易被社区拆穿的虚报；把没验证的那些默认关掉、明确标
 * experimental，则是「少而真 > 多而虚」。等真机验证过一项，就把它升到 verified。
 */
export type ChannelMaturity = 'verified' | 'experimental'

export interface ChannelCapability {
  type: ChannelType
  /** 界面展示名 */
  label: string
  maturity: ChannelMaturity
  /** 配置该渠道必需凭据的键（用于引导与校验提示） */
  requiredCredentials: string[]
  /** 备注：为什么是这个成熟度 / 已知限制 */
  notes: string
  /** 完成真机验证的日期（仅 verified 填写） */
  verifiedAt?: string
}

/**
 * 渠道能力登记表——**成熟度的唯一真源**。
 * 任何地方要说“这个渠道支不支持”，都从这里取，不要散落硬编码。
 * 升/降级只改这张表。
 */
export const CHANNEL_CAPABILITIES: Record<Exclude<ChannelType, 'custom'>, ChannelCapability> = {
  telegram: {
    type: 'telegram',
    label: 'Telegram',
    maturity: 'verified',
    verifiedAt: '2026-10-05',
    requiredCredentials: ['botToken'],
    notes: '唯一完成端到端真机验证（收发双向 + 长连接）的渠道，建议从这个开始。',
  },
  wechat: {
    type: 'wechat',
    label: '微信',
    maturity: 'experimental',
    requiredCredentials: ['webhookUrl', 'token'],
    notes: '适配器已接线，未经端到端真机验证。需自备可接收回调的地址。',
  },
  qq: {
    type: 'qq',
    label: 'QQ',
    maturity: 'experimental',
    requiredCredentials: ['appId', 'token'],
    notes: 'OneBot 形态，适配器已接线，未经端到端真机验证。',
  },
  dingtalk: {
    type: 'dingtalk',
    label: '钉钉',
    maturity: 'experimental',
    requiredCredentials: ['appKey', 'appSecret'],
    notes: '企业内部应用形态，适配器已接线，未经端到端真机验证。',
  },
  slack: {
    type: 'slack',
    label: 'Slack',
    maturity: 'experimental',
    requiredCredentials: ['botToken', 'signingSecret'],
    notes: '适配器已接线，未经端到端真机验证。事件回调需公网地址。',
  },
  discord: {
    type: 'discord',
    label: 'Discord',
    maturity: 'experimental',
    requiredCredentials: ['botToken'],
    notes: '适配器已接线，未经端到端真机验证。事件回调需公网地址。',
  },
  openclaw: {
    type: 'openclaw',
    label: 'openclaw A2A',
    maturity: 'experimental',
    requiredCredentials: ['baseUrl'],
    notes: '作为 A2A 对接（双向）。适配器已接线，未经端到端真机验证。',
  },
}

/** 取某渠道的成熟度；未知类型按 experimental 处理（宁可保守） */
export function channelMaturity(type: ChannelType): ChannelMaturity {
  if (type === 'custom') {return 'experimental'}
  return CHANNEL_CAPABILITIES[type]?.maturity ?? 'experimental'
}

/** 该渠道是否已通过端到端真机验证 */
export function isChannelVerified(type: ChannelType): boolean {
  return channelMaturity(type) === 'verified'
}

/** 已验证的渠道列表（界面默认只推荐这些） */
export function verifiedChannelTypes(): ChannelType[] {
  return (Object.keys(CHANNEL_CAPABILITIES) as (keyof typeof CHANNEL_CAPABILITIES)[])
    .filter((k) => CHANNEL_CAPABILITIES[k].maturity === 'verified')
    .map((k) => CHANNEL_CAPABILITIES[k].type)
}

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
  /**
   * 显式放行未验证渠道。
   *
   * 渠道成熟度为 experimental 时，**默认拒绝启动**，除非这里显式为 true。
   * 这不是功能性开关，而是诚实度开关：让我们不会在用户不知情的情况下
   * 把一个“能启动但没验证过”的渠道当成“已支持”去用。
   */
  allowExperimental?: boolean
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
