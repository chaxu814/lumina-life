// ============================================================
// impl/datetime.ts — 日期时间工具
// ============================================================

import type { ToolDef, ToolResult } from '../types'

export const datetimeDef: ToolDef = {
  name: 'datetime',
  description: '获取当前日期时间信息',
  params: {},
  toolsets: ['agent', 'chat'],
}

export async function datetime(args: Record<string, any>): Promise<ToolResult> {
  const now = new Date()
  const weekdays = ['日', '一', '二', '三', '四', '五', '六']

  const info = [
    `日期: ${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`,
    `时间: ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`,
    `星期: ${weekdays[now.getDay()]}`,
    `时区: Asia/Shanghai (UTC+8)`,
  ]

  return {
    callId: '',
    ok: true,
    content: info.join('\n'),
  }
}
