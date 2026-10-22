// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tools/impl/channelMessage.ts — 📡 渠道消息工具 (Phase C)
//
// 让 Agent 可以通过渠道管理器向外部用户/群组发送消息。
// 支持 DingTalk / WeChat / Slack / Telegram。
// ============================================================

import { getChannelManager } from '../../channels/channelManager'
import type { ToolDef, ToolResult } from '../types'
import type { ChannelSendRequest, ChannelType } from '../../channels/types'

export const channelSendDef: ToolDef = {
  name: 'channel_send',
  description: '📡 通过外部渠道（钉钉/企业微信/Slack/Telegram）向用户或群组发送消息。Agent 可通过此工具与外部人员通讯。',
  params: {
    channel: {
      type: 'string',
      description: '目标渠道: "dingtalk" / "wechat" / "slack" / "telegram"',
      required: true,
    },
    target: {
      type: 'string',
      description: '目标用户 ID、群 ID 或频道 ID',
      required: true,
    },
    text: {
      type: 'string',
      description: '消息内容（支持 Markdown）',
      required: true,
    },
    isGroup: {
      type: 'boolean',
      description: '是否群聊消息，默认 false',
      required: false,
    },
    replyTo: {
      type: 'string',
      description: '回复的消息 ID（可选）',
      required: false,
    },
  },
  toolsets: ['agent', 'social'],
}

export async function channelSend(args: Record<string, any>): Promise<ToolResult> {
  const channel: ChannelType = (args.channel || '').toLowerCase() as ChannelType
  const target: string = args.target || ''
  const text: string = args.text || ''
  const isGroup = args.isGroup === true
  const replyTo: string | undefined = args.replyTo || undefined

  if (!channel || !['dingtalk', 'wechat', 'slack', 'telegram'].includes(channel)) {
    return { callId: '', ok: false, content: '', error: `不支持的渠道: ${channel}。支持: dingtalk, wechat, slack, telegram` }
  }

  if (!target || !text) {
    return { callId: '', ok: false, content: '', error: '请提供 target 和 text' }
  }

  try {
    const manager = getChannelManager()
    const statuses = manager.getStatus()
    const channelStatus = statuses.find(s => s.type === channel)

    if (!channelStatus) {
      return { callId: '', ok: false, content: '', error: `渠道 "${channel}" 未配置。请先在设置中配置渠道凭据。` }
    }

    if (!channelStatus.online) {
      return { callId: '', ok: false, content: '', error: `渠道 "${channel}" 当前离线。请检查凭据是否正确。` }
    }

    const request: ChannelSendRequest = { targetId: target, isGroup, text, replyTo }
    const success = await manager.send(channelStatus.key, request)

    if (success) {
      return {
        callId: '', ok: true,
        content: `✅ 消息已通过 ${channel} 发送到 ${target}`,
      }
    } else {
      return {
        callId: '', ok: false, content: '', error: `消息发送失败，请检查目标 ID 和渠道状态`,
      }
    }
  } catch (err: any) {
    return { callId: '', ok: false, content: '', error: `渠道消息发送异常: ${err.message}` }
  }
}

/** 渠道状态查询工具 */
export const channelStatusDef: ToolDef = {
  name: 'channel_status',
  description: '📡 查看所有已配置的外部渠道连接状态。列出各渠道是否在线、类型和名称。',
  params: {},
  toolsets: ['agent', 'social'],
}

export async function channelStatus(): Promise<ToolResult> {
  try {
    const manager = getChannelManager()
    const statuses = manager.getStatus()

    if (statuses.length === 0) {
      return { callId: '', ok: true, content: '📡 未配置任何外部渠道。请先在设置中配置 DingTalk / WeChat / Slack / Telegram。' }
    }

    const lines = ['📡 渠道连接状态', '---']
    for (const s of statuses) {
      const icon = s.online ? '🟢' : '🔴'
      lines.push(`${icon} ${s.name} (${s.type}) — ${s.online ? '在线' : '离线'}`)
    }
    lines.push('---')
    lines.push('💡 使用 channel_send 工具通过渠道发送消息')

    return { callId: '', ok: true, content: lines.join('\n') }
  } catch (err: any) {
    return { callId: '', ok: false, content: '', error: `渠道状态查询失败: ${err.message}` }
  }
}
