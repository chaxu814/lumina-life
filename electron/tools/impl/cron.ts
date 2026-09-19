// ============================================================
// impl/cron.ts — 定时任务工具 (v2.5 增强)
//
// v2.5: 新增主进程级 cron 调度循环
//   - 30 秒轮询检查所有任务
//   - Cron 表达式匹配 (分 时 日 月 周)
//   - 持久化 last-run 时间戳 (防止同分钟内重复触发)
//   - 通过 IPC 推送触发事件到渲染进程
// ============================================================

import type { ToolDef, ToolResult } from '../types'
import { BrowserWindow } from 'electron'

// ═══════════════════════════════════════════════════════════
// 数据结构
// ═══════════════════════════════════════════════════════════

interface CronEntry {
  id: number
  name: string
  schedule: string        // cron 表达式: "分 时 日 月 周"
  action: string          // 要执行的操作描述
  enabled: boolean
  createdAt: string
  lastRunAt?: string      // ISO 时间戳，防重复触发
}

let cronEntries: CronEntry[] = []
let cronNextId = 1
let cronLoopInterval: ReturnType<typeof setInterval> | null = null
let mainWindowRef: BrowserWindow | null = null

// ═══════════════════════════════════════════════════════════
// Cron 表达式匹配
// ═══════════════════════════════════════════════════════════

function cronMatches(schedule: string, now: Date): boolean {
  const parts = schedule.split(' ')
  if (parts.length !== 5) {return false}

  const [cronMin, cronHour, cronDay, cronMonth, cronWeek] = parts
  const minute = now.getMinutes()
  const hour = now.getHours()
  const dayOfMonth = now.getDate()
  const month = now.getMonth() + 1 // JS: 0-11 → 1-12
  const dayOfWeek = now.getDay()   // 0=周日

  const matchField = (cron: string, value: number): boolean => {
    if (cron === '*') {return true}
    // */N 步进: 每 N 个单位触发一次
    if (cron.startsWith('*/')) {
      const step = parseInt(cron.slice(2))
      return value % step === 0
    }
    // 逗号分隔: 匹配任一值
    if (cron.includes(',')) {
      return cron.split(',').some(s => parseInt(s) === value)
    }
    // 数字精确匹配
    return parseInt(cron) === value
  }

  return (
    matchField(cronMin, minute) &&
    matchField(cronHour, hour) &&
    matchField(cronDay, dayOfMonth) &&
    matchField(cronMonth, month) &&
    matchField(cronWeek, dayOfWeek)
  )
}

// ═══════════════════════════════════════════════════════════
// 调度循环
// ═══════════════════════════════════════════════════════════

function checkAndTrigger(now: Date): void {
  for (const entry of cronEntries) {
    if (!entry.enabled) {continue}
    if (!cronMatches(entry.schedule, now)) {continue}

    // 防止同一分钟重复触发
    const minuteKey = `${now.getHours()}:${now.getMinutes()}`
    const lastMinuteKey = entry.lastRunAt
      ? `${new Date(entry.lastRunAt).getHours()}:${new Date(entry.lastRunAt).getMinutes()}`
      : null
    if (lastMinuteKey === minuteKey) {continue}

    entry.lastRunAt = now.toISOString()

    const timeStr = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })

    // 推送到渲染进程
    if (mainWindowRef && !mainWindowRef.isDestroyed()) {
      mainWindowRef.webContents.send('cron:triggered', {
        id: entry.id,
        name: entry.name,
        action: entry.action,
        schedule: entry.schedule,
        time: timeStr,
      })
    }

    console.log(`[Cron] ⏰ 触发: #${entry.id} "${entry.name}" — ${timeStr}`)
  }
}

/**
 * 启动 cron 调度循环
 * @param mainWindow 渲染进程窗口引用
 * @param intervalMs 检查间隔 (默认 30 秒)
 */
export function startCronLoop(mainWindow: BrowserWindow, intervalMs = 30000): void {
  mainWindowRef = mainWindow
  if (cronLoopInterval) {clearInterval(cronLoopInterval)}

  // 首次立即检查
  checkAndTrigger(new Date())

  cronLoopInterval = setInterval(() => {
    checkAndTrigger(new Date())
  }, intervalMs)

  console.log(`[Cron] 调度循环已启动 (间隔 ${intervalMs / 1000}s, ${cronEntries.length} 个任务)`)
}

/** 停止 cron 调度循环 */
export function stopCronLoop(): void {
  if (cronLoopInterval) {
    clearInterval(cronLoopInterval)
    cronLoopInterval = null
  }
  mainWindowRef = null
}

/** 获取 cron 状态 */
export function getCronStats(): { running: boolean; entryCount: number; entries: CronEntry[] } {
  return {
    running: cronLoopInterval !== null,
    entryCount: cronEntries.length,
    entries: [...cronEntries],
  }
}

// ═══════════════════════════════════════════════════════════
// 工具定义 (Agent 可调用)
// ═══════════════════════════════════════════════════════════

/** 清空并替换全部 cron 条目（从渲染进程同步） */
export function replaceAllCronEntries(entries: Array<{ name: string; schedule: string; action: string; enabled: boolean }>): void {
  cronEntries = entries.map((e, i) => ({
    id: i + 1,
    name: e.name,
    schedule: e.schedule,
    action: e.action,
    enabled: e.enabled,
    createdAt: new Date().toISOString(),
  }))
  cronNextId = cronEntries.length + 1
  console.log(`[Cron] 已同步 ${cronEntries.length} 个任务到主进程`)
}

export const cronDef: ToolDef = {
  name: 'cron_schedule',
  description: '创建定时任务。支持标准 cron 表达式（分 时 日 月 周），如 "0 8 * * *" 表示每天早上8点、"*/30 * * * *" 表示每30分钟。',
  params: {
    name: { type: 'string', description: '任务名称', required: true },
    schedule: { type: 'string', description: 'Cron 表达式（5段: 分 时 日 月 周）。例如: "0 8 * * *"(早8点)、"*/30 * * * *"(每30分钟)、"0 10 * * 1"(每周一10点)', required: true },
    action: { type: 'string', description: '要执行的操作描述', required: true },
  },
  toolsets: ['agent'],
}

export const cronListDef: ToolDef = {
  name: 'cron_list',
  description: '列出所有定时任务',
  params: {},
  toolsets: ['agent'],
}

export const cronCancelDef: ToolDef = {
  name: 'cron_cancel',
  description: '取消一个定时任务',
  params: { id: { type: 'number', description: '任务 ID', required: true } },
  toolsets: ['agent'],
}

// ═══════════════════════════════════════════════════════════
// 工具实现
// ═══════════════════════════════════════════════════════════

export async function cronSchedule(args: Record<string, any>): Promise<ToolResult> {
  const entry: CronEntry = {
    id: cronNextId++,
    name: args.name,
    schedule: args.schedule,
    action: args.action,
    enabled: true,
    createdAt: new Date().toISOString(),
  }
  cronEntries.push(entry)
  return {
    callId: '',
    ok: true,
    content: `⏰ 定时任务已创建 [#${entry.id}] "${entry.name}"\n调度: ${entry.schedule}\n操作: ${entry.action}`,
  }
}

export async function cronList(): Promise<ToolResult> {
  if (cronEntries.length === 0) {return { callId: '', ok: true, content: '(无定时任务)' }}
  const list = cronEntries.map(e =>
    `  [${e.enabled ? '⏰' : '❌'}] #${e.id} "${e.name}"\n     调度: ${e.schedule} | 操作: ${e.action}${e.lastRunAt ? ` | 上次: ${new Date(e.lastRunAt).toLocaleString('zh-CN')}` : ''}`
  ).join('\n')
  return { callId: '', ok: true, content: list }
}

export async function cronCancel(args: Record<string, any>): Promise<ToolResult> {
  const e = cronEntries.find(c => c.id === args.id)
  if (!e) {return { callId: '', ok: false, content: '', error: `未找到任务 #${args.id}` }}
  e.enabled = false
  return { callId: '', ok: true, content: `⏰ 任务 #${args.id} "${e.name}" 已取消` }
}
