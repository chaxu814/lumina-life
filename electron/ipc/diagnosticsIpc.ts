// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// ipc/diagnosticsIpc.ts — 诊断面板 IPC (v3.5)
//
// 借鉴 QwenPaw diagnostics:
//   实时 Token 消耗追踪 + 工具调用时间线 + 错误堆栈
//   LLM 请求/响应耗时统计
// ============================================================

import { ipcMain, BrowserWindow } from 'electron'
import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
// 🆕 2026-10-05：模型体检报告
import { buildModelHealthReport, formatHealthReportText } from '../core/modelHealthReport'

// ═══════════════════════════════════════════════════════════
// 诊断数据存储
// ═══════════════════════════════════════════════════════════

interface TokenEvent {
  timestamp: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  model: string
  durationMs: number
}

interface ToolCallEvent {
  timestamp: string
  toolName: string
  args: string
  result: string
  ok: boolean
  error?: string
  durationMs: number
}

interface LLMErrorEvent {
  timestamp: string
  status: number
  message: string
  model: string
  stage: string
}

class DiagnosticsStore {
  tokenEvents: TokenEvent[] = []
  toolCallEvents: ToolCallEvent[] = []
  errorEvents: LLMErrorEvent[] = []
  maxEvents = 200

  addToken(ev: TokenEvent): void {
    this.tokenEvents.push(ev)
    if (this.tokenEvents.length > this.maxEvents) {this.tokenEvents.shift()}
  }

  addToolCall(ev: ToolCallEvent): void {
    this.toolCallEvents.push(ev)
    if (this.toolCallEvents.length > this.maxEvents) {this.toolCallEvents.shift()}
  }

  addError(ev: LLMErrorEvent): void {
    this.errorEvents.push(ev)
    if (this.errorEvents.length > this.maxEvents) {this.errorEvents.shift()}
  }

  getSummary(): DiagnosticsSummary {
    const totalTokens = this.tokenEvents.reduce((s, e) => s + e.totalTokens, 0)
    const avgLatency = this.tokenEvents.length > 0
      ? this.tokenEvents.reduce((s, e) => s + e.durationMs, 0) / this.tokenEvents.length
      : 0
    const toolSuccessRate = this.toolCallEvents.length > 0
      ? this.toolCallEvents.filter(t => t.ok).length / this.toolCallEvents.length * 100
      : 100
    const errorCount = this.errorEvents.length

    // 工具调用频率 top 10
    const toolFreq = new Map<string, number>()
    for (const t of this.toolCallEvents) {
      toolFreq.set(t.toolName, (toolFreq.get(t.toolName) || 0) + 1)
    }
    const topTools = [...toolFreq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, count]) => ({ name, count }))

    return {
      totalRequests: this.tokenEvents.length,
      totalTokens,
      avgLatencyMs: Math.round(avgLatency),
      toolCalls: this.toolCallEvents.length,
      toolSuccessRate: Math.round(toolSuccessRate * 100) / 100,
      errors: errorCount,
      topTools,
    }
  }

  getTimeline(limit = 50): TimelineItem[] {
    const items: TimelineItem[] = [
      ...this.tokenEvents.map(e => ({
        type: 'llm' as const,
        timestamp: e.timestamp,
        detail: `${e.totalTokens} tokens | ${e.durationMs}ms | ${e.model}`,
      })),
      ...this.toolCallEvents.map(e => ({
        type: 'tool' as const,
        timestamp: e.timestamp,
        detail: `${e.ok ? '✅' : '❌'} ${e.toolName}(${e.args.slice(0, 60)}) → ${e.durationMs}ms`,
      })),
      ...this.errorEvents.map(e => ({
        type: 'error' as const,
        timestamp: e.timestamp,
        detail: `HTTP ${e.status}: ${e.message.slice(0, 80)}`,
      })),
    ]

    // 按时间倒序
    items.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    return items.slice(0, limit)
  }

  clear(): void {
    this.tokenEvents = []
    this.toolCallEvents = []
    this.errorEvents = []
  }
}

interface DiagnosticsSummary {
  totalRequests: number
  totalTokens: number
  avgLatencyMs: number
  toolCalls: number
  toolSuccessRate: number
  errors: number
  topTools: Array<{ name: string; count: number }>
}

interface TimelineItem {
  type: 'llm' | 'tool' | 'error'
  timestamp: string
  detail: string
}

// ═══════════════════════════════════════════════════════════
// 全局 store + IPC
// ═══════════════════════════════════════════════════════════

const store = new DiagnosticsStore()

export function getDiagnosticsStore(): DiagnosticsStore {
  return store
}

export function registerDiagnosticsIpc(mainWindow: BrowserWindow): void {
  // ─── 模型体检报告（2026-10-05）───────────────────────────
  // 把已有但对用户不可见的模型能力信息（服务端 n_ctx / 工具支持 / 视觉能力 /
  // 运行实测反馈）聚合成一份能读懂、能行动的诊断。
  //
  // 为什么放在 diagnostics 而不是 settings：
  //   它是【诊断】而非【配置】。用户是「模型出问题了才来看」，
  //   不需要每次打开设置都被一堆能力字段干扰。
  ipcMain.handle('diagnostics:modelHealth', async (_event, params: {
    modelName?: string
    baseUrl?: string
    userContextWindow?: number | null
  }) => {
    const modelName = String(params?.modelName || '').trim()
    const baseUrl = String(params?.baseUrl || '').trim()
    if (!modelName || !baseUrl) {
      return {
        error: '未配置 LLM 模型 —— 请先在「设置 → LLM 模型」里选择一个模型与 API 地址。',
      }
    }
    try {
      return buildModelHealthReport({
        modelName,
        baseUrl,
        userContextWindow: params?.userContextWindow ?? null,
      })
    } catch (err: any) {
      // 体检本身不该把用户带崩：报告生成失败时也要给出一句人话
      return { error: `生成体检报告失败: ${err?.message || err}` }
    }
  })

  // 纯文本版：供 CLI / 「复制报告」按钮使用
  ipcMain.handle('diagnostics:modelHealthText', async (_event, params: {
    modelName?: string
    baseUrl?: string
    userContextWindow?: number | null
  }) => {
    const modelName = String(params?.modelName || '').trim()
    const baseUrl = String(params?.baseUrl || '').trim()
    if (!modelName || !baseUrl) {return '未配置 LLM 模型。'}
    try {
      return formatHealthReportText(buildModelHealthReport({
        modelName, baseUrl, userContextWindow: params?.userContextWindow ?? null,
      }))
    } catch (err: any) {
      return `生成体检报告失败: ${err?.message || err}`
    }
  })

  // ─── 摘要 ──────────────────────────────────────────
  ipcMain.handle('diagnostics:summary', async () => {
    return store.getSummary()
  })

  // ─── 时间线 ────────────────────────────────────────
  ipcMain.handle('diagnostics:timeline', async (_event, limit?: number) => {
    return store.getTimeline(limit || 50)
  })

  // ─── Token 历史 ────────────────────────────────────
  ipcMain.handle('diagnostics:tokens', async (_event, limit?: number) => {
    return store.tokenEvents.slice(-(limit || 100))
  })

  // ─── 工具调用历史 ─────────────────────────────────
  ipcMain.handle('diagnostics:tool-calls', async (_event, limit?: number) => {
    return store.toolCallEvents.slice(-(limit || 100))
  })

  // ─── 清除 ──────────────────────────────────────────
  ipcMain.handle('diagnostics:clear', async () => {
    store.clear()
    return { success: true }
  })

  // ─── 📊 耗时仪表盘 ─────────────────────────────────
  ipcMain.handle('diagnostics:latency', async (_event, windowMinutes?: number) => {
    const windowMs = (windowMinutes || 30) * 60 * 1000
    const cutoff = Date.now() - windowMs

    // Token events 有 durationMs；按分钟分桶
    const buckets = new Map<string, { count: number; totalMs: number; maxMs: number }>()
    for (const e of store.tokenEvents) {
      const t = new Date(e.timestamp).getTime()
      if (t < cutoff) {continue}
      const key = new Date(t).toISOString().slice(0, 16) // YYYY-MM-DDTHH:mm
      const b = buckets.get(key) || { count: 0, totalMs: 0, maxMs: 0 }
      b.count++
      b.totalMs += e.durationMs
      if (e.durationMs > b.maxMs) {b.maxMs = e.durationMs}
      buckets.set(key, b)
    }

    const series = [...buckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([time, b]) => ({
        time,
        avgMs: Math.round(b.totalMs / b.count),
        maxMs: b.maxMs,
        count: b.count,
      }))

    return series
  })

  // ─── 📋 诊断报告导出 ──────────────────────────────
  ipcMain.handle('diagnostics:export-report', async () => {
    const summary = store.getSummary()
    const now = new Date().toISOString()

    // 系统信息
    const sysInfo = {
      platform: os.platform(),
      release: os.release(),
      hostname: os.hostname(),
      totalMem: `${(os.totalmem() / 1024 / 1024 / 1024).toFixed(1)} GB`,
      freeMem: `${(os.freemem() / 1024 / 1024 / 1024).toFixed(1)} GB`,
      cpus: os.cpus().length,
      uptime: `${Math.round(os.uptime() / 3600)}h`,
    }

    // 错误 TOP
    const recentErrors = store.errorEvents.slice(-20).map(e => ({
      time: e.timestamp,
      status: e.status,
      message: e.message.slice(0, 100),
      model: e.model,
    }))

    const report = {
      generatedAt: now,
      system: sysInfo,
      summary,
      recentErrors,
      timeline: store.getTimeline(30),
    }

    return report
  })

  // ─── 🩺 实时诊断检查 ──────────────────────────────
  ipcMain.handle('diagnostics:quick-check', async () => {
    const checks: Array<{ name: string; pass: boolean; detail: string }> = []

    // 1. Token 消耗是否异常
    const lastMinTokens = store.tokenEvents
      .filter(e => Date.now() - new Date(e.timestamp).getTime() < 60000)
      .reduce((s, e) => s + e.totalTokens, 0)
    checks.push({
      name: 'Token 消耗(1min)',
      pass: lastMinTokens < 50000,
      detail: lastMinTokens > 0 ? `${lastMinTokens} tokens/min` : '无活动',
    })

    // 2. 工具成功率
    const lastTools = store.toolCallEvents.slice(-20)
    if (lastTools.length > 0) {
      const failCount = lastTools.filter(t => !t.ok).length
      checks.push({
        name: '工具调用(近20次)',
        pass: failCount === 0,
        detail: `${lastTools.length - failCount}/${lastTools.length} 成功`,
      })
    }

    // 3. 错误爆发
    const lastMinErrors = store.errorEvents
      .filter(e => Date.now() - new Date(e.timestamp).getTime() < 60000)
    checks.push({
      name: '错误爆发检测',
      pass: lastMinErrors.length < 3,
      detail: lastMinErrors.length > 0 ? `${lastMinErrors.length} 次错误` : '无错误',
    })

    // 4. 平均延迟
    if (store.tokenEvents.length > 0) {
      const avg = store.tokenEvents.reduce((s, e) => s + e.durationMs, 0) / store.tokenEvents.length
      checks.push({
        name: '平均 LLM 延迟',
        pass: avg < 10000,
        detail: `${Math.round(avg)}ms`,
      })
    }

    return checks
  })

  // ─── 实时推送 ──────────────────────────────────────
  // 每 2 秒推送摘要到渲染进程
  const interval = setInterval(() => {
    if (mainWindow.isDestroyed()) {
      clearInterval(interval)
      return
    }
    mainWindow.webContents.send('diagnostics:update', store.getSummary())
  }, 2000)

  mainWindow.on('closed', () => clearInterval(interval))

  console.log('[Diagnostics] 📊 诊断面板已就绪 — 实时推送 2s/次')
}
