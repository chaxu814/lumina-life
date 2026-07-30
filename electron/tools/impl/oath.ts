// ============================================================
// impl/oath.ts — 誓约系统 + 预约提醒 (v2.3 / v2.10.1)
//
// Oath: AI 记住与用户的"约定"，跨会话持久化
// Appointment: 定时提醒，集成 cron 系统
// v2.10.1: PowerShell 改用 -EncodedCommand 杜绝编码乱码
// ============================================================

import type { ToolDef, ToolResult } from '../types'
import { getMemoryStore } from '../../memory/memoryStore'
import { execFile } from 'child_process'

// ═══════════════════════════════════════════════════════════
// 誓约系统
// ═══════════════════════════════════════════════════════════

export const oathMakeDef: ToolDef = {
  name: 'oath_make',
  description: '创建一个誓约/约定。用于"我答应你..."、"记住我们的约定"、"下次提醒我..."等场景。AI会记住并持续追踪这个约定。',
  params: {
    content: { type: 'string', description: '约定内容，清晰描述承诺了什么', required: true },
    category: { type: 'string', description: '类别: "promise"(承诺) / "reminder"(提醒) / "goal"(目标) / "habit"(习惯)', required: false },
  },
  toolsets: ['agent', 'memory'],
}

export async function oathMake(args: Record<string, any>): Promise<ToolResult> {
  const store = getMemoryStore()
  const { content } = args
  const category = args.category || 'promise'

  // 格式: [类别] YYYY-MM-DD HH:mm 内容 | 状态:active
  const entry = `[${category}] ${new Date().toLocaleString('zh-CN')} ${content} | 状态:进行中`
  store.saveMemoryConfig({ lessons: [entry] })

  return {
    callId: '',
    ok: true,
    content: `✅ 誓约已记录 [${category}]: "${content.slice(0, 80)}${content.length > 80 ? '...' : ''}"\n我会记住这个约定，你随时可以问我"我们的约定"。`,
  }
}

export const oathListDef: ToolDef = {
  name: 'oath_list',
  description: '列出所有誓约/约定。查看与用户之间的承诺、目标和提醒。',
  params: {
    status: { type: 'string', description: '筛选状态: "active"(进行中) / "fulfilled"(已完成) / "all"(全部)，默认 "active"', required: false },
    category: { type: 'string', description: '按类别筛选: "promise"/"reminder"/"goal"/"habit"', required: false },
  },
  toolsets: ['agent', 'memory'],
}

export async function oathList(args: Record<string, any>): Promise<ToolResult> {
  const store = getMemoryStore()
  const config = store.getMemoryConfig()
  const status = args.status || 'active'
  const category = args.category

  const allOaths = config?.lessons || []
  const oathEntries = allOaths.filter(line => {
    const hasBracket = line.startsWith('[promise]') || line.startsWith('[reminder]') || line.startsWith('[goal]') || line.startsWith('[habit]')
    if (!hasBracket) return false
    if (category && !line.startsWith(`[${category}]`)) return false
    if (status === 'active') return line.includes('状态:进行中')
    if (status === 'fulfilled') return line.includes('状态:已完成')
    return true
  })

  if (oathEntries.length === 0) {
    return { callId: '', ok: true, content: '(暂无誓约记录)' }
  }

  const list = oathEntries.map((line, i) => {
    // 移除状态后缀，简化显示
    const clean = line.replace(/\s*\|?\s*状态:\S+/, '')
    return `${i + 1}. ${clean}`
  }).join('\n')

  return { callId: '', ok: true, content: `📜 誓约列表 (${oathEntries.length}条):\n${list}` }
}

export const oathFulfillDef: ToolDef = {
  name: 'oath_fulfill',
  description: '标记某个誓约为已完成。用于"约定已兑现"、"目标达成"等场景。',
  params: {
    index: { type: 'number', description: '誓约编号 (从 oath_list 获取)', required: true },
  },
  toolsets: ['agent', 'memory'],
}

export async function oathFulfill(args: Record<string, any>): Promise<ToolResult> {
  const store = getMemoryStore()
  const config = store.getMemoryConfig()
  const allOaths = config?.lessons || []

  // 找到所有誓约条目
  const oathIndices: number[] = []
  allOaths.forEach((line, i) => {
    if (line.startsWith('[promise]') || line.startsWith('[reminder]') || line.startsWith('[goal]') || line.startsWith('[habit]')) {
      oathIndices.push(i)
    }
  })

  const idx = args.index - 1 // 用户输入1-based
  if (idx < 0 || idx >= oathIndices.length) {
    return { callId: '', ok: false, content: '', error: `无效编号: ${args.index}。请使用 oath_list 查看编号` }
  }

  const realIdx = oathIndices[idx]
  const original = allOaths[realIdx]
  allOaths[realIdx] = original.replace('状态:进行中', '状态:已完成 ✅')

  // 更新 lessons
  store.saveMemoryConfig({ lessons: allOaths })

  return { callId: '', ok: true, content: `🎉 誓约已完成: ${original.replace(/\s*\|?\s*状态:\S+/, '').slice(0, 80)}` }
}

// ═══════════════════════════════════════════════════════════
// 预约提醒系统
// ═══════════════════════════════════════════════════════════

export const appointmentSetDef: ToolDef = {
  name: 'appointment_set',
  description: '设置预约提醒。定时在指定时间通过系统通知提醒用户。用于"X分钟后提醒我"、"明天下午3点叫我开会"等场景。',
  params: {
    title: { type: 'string', description: '提醒标题', required: true },
    message: { type: 'string', description: '提醒内容', required: true },
    when: { type: 'string', description: '提醒时间。支持: "10min"(10分钟后) / "1h"(1小时后) / "2026-05-12 15:00"(指定时间) / "tomorrow 9:00"(明天9点)', required: true },
  },
  toolsets: ['agent', 'tasks'],
}

export async function appointmentSet(args: Record<string, any>): Promise<ToolResult> {
  const { title, message, when } = args

  return new Promise((resolve) => {
    // 解析时间 → 毫秒延迟
    const delayMs = parseTimeToMs(when)
    if (delayMs === null) {
      resolve({ callId: '', ok: false, content: '', error: `无法解析时间: "${when}"。支持格式: "30min", "2h", "2026-05-12 15:00", "tomorrow 09:00"` })
      return
    }

    if (delayMs > 7 * 24 * 3600 * 1000) {
      resolve({ callId: '', ok: false, content: '', error: '预约时间不能超过 7 天' })
      return
    }

    if (delayMs < 0) {
      resolve({ callId: '', ok: false, content: '', error: '预约时间已过，请指定未来的时间' })
      return
    }

    // 使用 setTimeout 简单实现（也可集成 cron 做持久化）
    const reminderTime = new Date(Date.now() + delayMs)
    const timeoutId = setTimeout(() => {
      // 使用 -EncodedCommand 杜绝编码乱码
      const psScript = [
        '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null;',
        '$t=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);',
        '$n=$t.GetElementsByTagName("text");',
        `$n.Item(0).AppendChild($t.CreateTextNode('${title.replace(/'/g, "''")}')) > $null;`,
        `$n.Item(1).AppendChild($t.CreateTextNode('${message.replace(/'/g, "''")}')) > $null;`,
        '$toast=[Windows.UI.Notifications.ToastNotification]::new($t);',
        `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Lumina').Show($toast);`,
      ].join('\n')
      const b64 = Buffer.from(psScript, 'utf16le').toString('base64')
      execFile('powershell', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', b64,
      ], { timeout: 5000, windowsHide: true }, () => {})
    }, delayMs)

    // 同时保存到记忆（跨会话参考）
    const store = getMemoryStore()
    store.saveMemoryConfig({
      systemInfo: [`[预约] ${reminderTime.toLocaleString('zh-CN')} | ${title}: ${message} | timeoutId:${String(timeoutId)}`],
    })

    const timeDesc = delayMs < 60000
      ? `${Math.round(delayMs / 1000)}秒后`
      : delayMs < 3600000
        ? `${Math.round(delayMs / 60000)}分钟后`
        : `${Math.round(delayMs / 3600000)}小时后`

    resolve({
      callId: '',
      ok: true,
      content: `⏰ 预约已设置: "${title}"\n将在 ${timeDesc} (${reminderTime.toLocaleString('zh-CN')}) 提醒你。`,
    })
  })
}

export const appointmentListDef: ToolDef = {
  name: 'appointment_list',
  description: '列出所有预约提醒。查看当前有哪些待执行的提醒。',
  params: {},
  toolsets: ['agent', 'tasks'],
}

export async function appointmentList(): Promise<ToolResult> {
  const store = getMemoryStore()
  const config = store.getMemoryConfig()
  const items = (config?.systemInfo || []).filter(line => line.startsWith('[预约]'))

  if (items.length === 0) {
    return { callId: '', ok: true, content: '(暂无预约提醒)' }
  }

  const list = items.map((line, i) => {
    // 清理显示
    const clean = line.replace(/\[预约\]\s*/, '').replace(/\s*\|?\s*timeoutId:\S+/, '')
    return `${i + 1}. ${clean}`
  }).join('\n')

  return { callId: '', ok: true, content: `📅 预约列表 (${items.length}条):\n${list}` }
}

// ═══════════════════════════════════════════════════════════
// 时间解析工具
// ═══════════════════════════════════════════════════════════

function parseTimeToMs(input: string): number | null {
  const s = input.trim().toLowerCase()

  // "30min" / "30m" / "30分钟"
  const minMatch = s.match(/^(\d+)\s*(min|m|分钟)$/)
  if (minMatch) return parseInt(minMatch[1]) * 60 * 1000

  // "2h" / "2小时" / "2hour"
  const hourMatch = s.match(/^(\d+)\s*(h|hour|小时)$/)
  if (hourMatch) return parseInt(hourMatch[1]) * 3600 * 1000

  // "10s" / "10秒"
  const secMatch = s.match(/^(\d+)\s*(s|sec|秒)$/)
  if (secMatch) return parseInt(secMatch[1]) * 1000

  // "tomorrow 09:00" / "tomorrow 9:00"
  const tomorrowMatch = s.match(/^tomorrow\s+(\d{1,2}):(\d{2})$/)
  if (tomorrowMatch) {
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    tomorrow.setHours(parseInt(tomorrowMatch[1]), parseInt(tomorrowMatch[2]), 0, 0)
    return tomorrow.getTime() - Date.now()
  }

  // "YYYY-MM-DD HH:mm" 绝对时间
  const absMatch = s.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})$/)
  if (absMatch) {
    const target = new Date(`${absMatch[1]}T${absMatch[2].padStart(2, '0')}:${absMatch[3]}:00`)
    if (isNaN(target.getTime())) return null
    return target.getTime() - Date.now()
  }

  return null
}
