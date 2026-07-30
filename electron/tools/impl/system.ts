// ============================================================
// impl/system.ts — 系统信息/进程/通知/文件打开工具 (v3.2)
// v3.2: openFile 重写 — 智能路径修复 + URL/文件/文件夹/应用全覆盖 + Electron + 系统命令双回退
// ============================================================

import { execFile } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'
import type { ToolDef, ToolResult } from '../types'
import { openFileV2 } from './openFile'

// PowerShell 安全执行
function psExecAsync(script: string, timeout = 5000): Promise<{ ok: boolean; stdout: string; error?: string }> {
  return new Promise((resolve) => {
    const b64 = Buffer.from(script, 'utf16le').toString('base64')
    execFile('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', b64,
    ], { timeout, windowsHide: true }, (err, stdout) => {
      resolve({ ok: !err, stdout: String(stdout || ''), error: err?.message })
    })
  })
}

export const systemInfoDef: ToolDef = {
  name: 'system_info',
  description: '获取系统信息：CPU、内存、磁盘、运行时间等',
  params: {},
  toolsets: ['agent'],
}

export async function systemInfo(): Promise<ToolResult> {
  const totalMem = (os.totalmem() / 1024 / 1024 / 1024).toFixed(1)
  const freeMem = (os.freemem() / 1024 / 1024 / 1024).toFixed(1)
  const info = [
    `系统: ${os.platform()} ${os.release()}`,
    `主机: ${os.hostname()}`,
    `CPU: ${os.cpus()[0]?.model || '未知'} (${os.cpus().length} 核)`,
    `内存: ${freeMem}GB / ${totalMem}GB`,
    `运行时间: ${Math.floor(os.uptime() / 3600)}h ${Math.floor((os.uptime() % 3600) / 60)}m`,
    `用户目录: ${os.homedir()}`,
  ]
  return { callId: '', ok: true, content: info.join('\n') }
}

export const processListDef: ToolDef = {
  name: 'process_list',
  description: '列出正在运行的进程 (Windows)',
  params: {
    filter: { type: 'string', description: '按名称过滤 (可选)', required: false },
    count: { type: 'number', description: '显示数量，默认 15', required: false },
  },
  toolsets: ['agent'],
}

export async function processList(args: Record<string, any>): Promise<ToolResult> {
  const filter = args.filter || ''
  const count = args.count || 15
  const psScript = filter
    ? [
        'Get-Process |',
        `Where-Object {$_.ProcessName -like '*${filter}*'} |`,
        `Select-Object -First ${count} |`,
        `ForEach-Object { '{0,-40} {1,8:N0} KB' -f $_.ProcessName, ($_.WorkingSet64/1KB) };`,
      ].join('\n').replace(/'/g, "''")
    : [
        'Get-Process |',
        'Sort-Object WorkingSet64 -Descending |',
        `Select-Object -First ${count} |`,
        `ForEach-Object { '{0,-40} {1,8:N0} KB' -f $_.ProcessName, ($_.WorkingSet64/1KB) };`,
      ].join('\n')

  const { ok, stdout, error } = await psExecAsync(psScript, 10000)
  if (!ok) {
    return { callId: '', ok: false, content: '', error: error || '进程查询失败' }
  }
  return { callId: '', ok: true, content: stdout.trim() || '(无结果)' }
}

export const notificationDef: ToolDef = {
  name: 'notification',
  description: '发送 Windows 系统通知。用于提醒用户重要事项。',
  params: {
    title: { type: 'string', description: '通知标题', required: true },
    message: { type: 'string', description: '通知内容', required: true },
  },
  toolsets: ['agent'],
}

export async function notification(args: Record<string, any>): Promise<ToolResult> {
  const title = String(args.title || '').replace(/'/g, "''")
  const message = String(args.message || '').replace(/'/g, "''")
  const psScript = [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null;',
    '$t=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);',
    '$n=$t.GetElementsByTagName("text");',
    `$n.Item(0).AppendChild($t.CreateTextNode('${title}')) > $null;`,
    `$n.Item(1).AppendChild($t.CreateTextNode('${message}')) > $null;`,
    '$toast=[Windows.UI.Notifications.ToastNotification]::new($t);',
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Lumina').Show($toast);`,
  ].join('\n')

  const { ok } = await psExecAsync(psScript, 5000)
  if (!ok) {
    return { callId: '', ok: false, content: '', error: '通知发送失败 (可能缺少 Windows 通知权限)' }
  }
  return { callId: '', ok: true, content: `通知已发送: ${args.title}` }
}

export const openFileDef: ToolDef = {
  name: 'open_file',
  description: `打开文件、文件夹、应用程序(.exe)或URL。这是打开任何东西的首选工具。
用法:
  open_file(target="C:/Users/xxx/Desktop")  — 打开文件夹
  open_file(target="report.pdf")              — 打开文件
  open_file(target="wechat")                   — 打开程序（只写名字即可，自动用 where 搜索）
  open_file(target="C:/Program Files/.../app.exe") — 打开程序（完整路径）
  open_file(target="https://baidu.com")       — 用浏览器打开网站
  open_file(target="notepad.exe")             — 运行系统程序

📌 对于 .exe 程序：只写程序名即可（如 "wechat"、"chrome"），系统会自动在 PATH 中搜索。
无需猜测完整安装路径。如果找不到，会返回提示而不是重复尝试。`,
  params: {
    target: { type: 'string', description: '要打开的目标：文件名、文件夹路径、程序名(.exe)、或用 http/https 开头的 URL', required: true },
    args: { type: 'string', description: '命令行参数（打开程序时可选）', required: false },
  },
  toolsets: ['agent'],
}

export async function openFile(args: Record<string, any>): Promise<ToolResult> {
  const target: string = String(args.target || args.path || '').trim()
  if (!target) return { callId: '', ok: false, content: '', error: 'open_file 需要 target 参数' }
  // 委托给增强版 openFileV2（Start Menu扫描 + 多层路径修复 + where/扫盘/直接运行四层回退）
  return openFileV2(target)
}
