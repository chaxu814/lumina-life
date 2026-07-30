// ============================================================
// impl/proactiveTools.ts — 主动对话工具 (v2.5)
// ============================================================

import type { ToolDef, ToolResult } from '../types'
import { getProactiveEngine } from '../../proactiveEngine'

export const proactiveDefs: Array<{ def: ToolDef; handler: (args: Record<string, any>) => Promise<ToolResult> }> = [
  {
    def: {
      name: 'proactive_status',
      description: `获取主动对话引擎状态。返回当前配置、今日已搭话次数、用户空闲时长等信息。
AI 可据此决定是否该主动发消息。`,
      params: {},
      toolsets: ['proactive', 'agent'],
    },
    handler: async () => {
      const engine = getProactiveEngine()
      const status = engine.getStatus()
      const enabledIds = status.triggers.filter(t => t.enabled).map(t => t.id)
      return {
        callId: '',
        ok: true,
        content: `📢 主动对话状态:
启用: ${status.config.enabled ? '✅' : '❌'}
今日已搭话: ${status.dailyCount}/${status.config.maxDailyProactive}
用户空闲: ${Math.floor(status.idleSeconds / 60)} 分钟
上次搭话: ${status.lastProactiveTime ? new Date(status.lastProactiveTime).toLocaleTimeString() : '无'}
已启用触发器: ${enabledIds.join(', ') || '(无)'}`,
      }
    },
  },
  {
    def: {
      name: 'proactive_trigger',
      description: `手动触发一个主动对话事件。用于 AI 在合适时机主动和用户搭话。

参数:
- trigger_id: 触发器 ID (如 "morning-greeting", "idle-10min") 或自定义消息
- message: 自定义搭话内容 (如果 trigger_id 不是预定义的)`,
      params: {
        trigger_id: { type: 'string', description: '触发器ID或自定义描述', required: true },
        message: { type: 'string', description: '自定义消息内容', required: false },
      },
      toolsets: ['proactive', 'agent'],
    },
    handler: async (args) => {
      const engine = getProactiveEngine()
      const triggerId = args.trigger_id as string
      const message = args.message as string

      // 如果是预定义的触发器，直接触发
      const triggers = engine.getTriggers()
      const existing = triggers.find(t => t.id === triggerId)
      if (existing && existing.enabled) {
        engine.fireEvent(triggerId)
        return {
          callId: '',
          ok: true,
          content: `✅ 已触发主动对话: ${triggerId} → "${existing.template.slice(0, 50)}..."`,
        }
      }

      // 自定义消息：通过 event 类型触发
      if (message) {
        engine.fireEvent('custom:' + triggerId)
        return {
          callId: '',
          ok: true,
          content: `✅ 已发送自定义主动消息: "${message.slice(0, 80)}"`,
        }
      }

      return {
        callId: '',
        ok: false,
        content: '',
        error: `触发器 "${triggerId}" 不存在或未启用。可用: ${triggers.filter(t => t.enabled).map(t => t.id).join(', ')}`,
      }
    },
  },
]
