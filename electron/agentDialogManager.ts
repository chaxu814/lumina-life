// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// agentDialogManager.ts — Agent 原始对话归档管理器 (P4-1)
//
// 每个 Agent 拥有独立的 dialog/ 目录：
//   - dialog/YYYY-MM-DD.jsonl — 按日期存储原始消息
//   - 摘要只保留路径指引，恢复时沿路径回读细节
// ============================================================

import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { getAgentProfileManager } from './agentProfileManager'

// ═══════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════

export interface DialogMessage {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>
  timestamp: number
  agentId: string
  sessionId: string
  metadata?: {
    toolName?: string
    toolResult?: any
    toolCalls?: any
    compacted?: boolean // 是否已压缩
    compactedAt?: number // 压缩时间
    summary?: string // 压缩摘要
  }
}

// ═══════════════════════════════════════════════════════════
// AgentDialogManager
// ═══════════════════════════════════════════════════════════

export class AgentDialogManager {
  private _profileManager = getAgentProfileManager()

  /** 写入原始消息到 dialog/YYYY-MM-DD.jsonl */
  appendMessage(agentId: string, sessionId: string, message: Omit<DialogMessage, 'id' | 'timestamp'>): void {
    const dialogDir = this._getDialogDir(agentId)
    const date = new Date().toISOString().split('T')[0] // YYYY-MM-DD
    const dialogPath = path.join(dialogDir, `${date}.jsonl`)
    
    if (!fs.existsSync(dialogDir)) {
      fs.mkdirSync(dialogDir, { recursive: true })
    }
    
    const fullMessage: DialogMessage = {
      ...message,
      id: this._generateMessageId(),
      timestamp: Date.now(),
    }
    
    // 追加到 jsonl
    const line = JSON.stringify(fullMessage) + '\n'
    fs.appendFileSync(dialogPath, line, 'utf-8')
  }

  /** 批量写入消息 */
  appendMessages(agentId: string, sessionId: string, messages: Omit<DialogMessage, 'id' | 'timestamp'>[]): void {
    const dialogDir = this._getDialogDir(agentId)
    const date = new Date().toISOString().split('T')[0] // YYYY-MM-DD
    const dialogPath = path.join(dialogDir, `${date}.jsonl`)
    
    if (!fs.existsSync(dialogDir)) {
      fs.mkdirSync(dialogDir, { recursive: true })
    }
    
    const lines = messages.map(msg => {
      const fullMessage: DialogMessage = {
        ...msg,
        id: this._generateMessageId(),
        timestamp: Date.now(),
      }
      return JSON.stringify(fullMessage)
    }).join('\n') + '\n'
    
    fs.appendFileSync(dialogPath, lines, 'utf-8')
  }

  /** 读取指定日期的对话 */
  readByDate(agentId: string, date: string): DialogMessage[] {
    const dialogDir = this._getDialogDir(agentId)
    const dialogPath = path.join(dialogDir, `${date}.jsonl`)
    
    if (!fs.existsSync(dialogPath)) {
      return []
    }
    
    try {
      const raw = fs.readFileSync(dialogPath, 'utf-8')
      const lines = raw.split('\n').filter(line => line.trim())
      return lines.map(line => JSON.parse(line) as DialogMessage)
    } catch (e) {
      console.warn(`[AgentDialog] 读取 ${agentId}/${date}.jsonl 失败:`, e)
      return []
    }
  }

  /** 读取指定会话的对话 */
  readBySession(agentId: string, sessionId: string, date?: string): DialogMessage[] {
    const messages: DialogMessage[] = []
    
    if (date) {
      // 读取指定日期
      const dayMessages = this.readByDate(agentId, date)
      messages.push(...dayMessages.filter(m => m.sessionId === sessionId))
    } else {
      // 读取该会话所有日期的消息
      const dialogDir = this._getDialogDir(agentId)
      
      if (!fs.existsSync(dialogDir)) {
        return []
      }
      
      const files = fs.readdirSync(dialogDir)
        .filter(f => f.endsWith('.jsonl'))
        .sort()
      
      for (const file of files) {
        const filePath = path.join(dialogDir, file)
        try {
          const raw = fs.readFileSync(filePath, 'utf-8')
          const lines = raw.split('\n').filter(line => line.trim())
          for (const line of lines) {
            const msg = JSON.parse(line) as DialogMessage
            if (msg.sessionId === sessionId) {
              messages.push(msg)
            }
          }
        } catch (e) {
          console.warn(`[AgentDialog] 读取 ${filePath} 失败:`, e)
        }
      }
    }
    
    return messages.sort((a, b) => a.timestamp - b.timestamp)
  }

  /**
   * 列出该 Agent 的所有会话（从 dialog 日志聚合）。
   *
   * 🆕 2026-10-13：为「换了运行模式后前端看不到历史」兜底。
   *
   *   前端的会话存在 **localStorage**，而 localStorage **按 origin 隔离** ——
   *   开发模式是 `http://localhost:5173`、打包模式是 `file://`，
   *   两边互不可见（实测落盘里确实存在两个 origin 的数据）。
   *   用户切换运行方式后会发现「历史全没了」。
   *
   *   而 dialog 日志是**主进程的文件**，不受 origin 影响 —— 所以可以从它重建。
   *
   * 只返回「至少有一条真实用户发言」的会话（过滤掉纯工具/系统残留），
   * 按最后活跃时间倒序；每个会话最多带 `maxMessagesPerSession` 条消息，
   * 避免一次 IPC 传几十 MB（实测单个 session 可有 7791 条）。
   */
  listSessions(agentId: string, maxMessagesPerSession = 200): Array<{
    id: string
    lastAt: number
    count: number
    preview: string
    messages: Array<{ from: string; content: string; time: string }>
  }> {
    const dialogDir = this._getDialogDir(agentId)
    if (!fs.existsSync(dialogDir)) {return []}

    const byId = new Map<string, DialogMessage[]>()
    const files = fs.readdirSync(dialogDir).filter(f => f.endsWith('.jsonl')).sort()
    for (const file of files) {
      const filePath = path.join(dialogDir, file)
      try {
        const raw = fs.readFileSync(filePath, 'utf-8')
        for (const line of raw.split('\n')) {
          if (!line.trim()) {continue}
          let msg: DialogMessage
          try { msg = JSON.parse(line) as DialogMessage } catch { continue }
          if (!msg.sessionId || msg.role === 'system') {continue}
          const arr = byId.get(msg.sessionId)
          if (arr) {arr.push(msg)} else {byId.set(msg.sessionId, [msg])}
        }
      } catch (e) {
        console.warn(`[AgentDialog] 聚合会话时读取 ${filePath} 失败:`, e)
      }
    }

    const out: Array<{
      id: string
      lastAt: number
      count: number
      preview: string
      messages: Array<{ from: string; content: string; time: string }>
    }> = []

    for (const [id, msgs] of byId) {
      msgs.sort((a, b) => a.timestamp - b.timestamp)
      const users = msgs.filter(
        m => m.role === 'user' && typeof m.content === 'string' && m.content.trim(),
      )
      // 没有真实用户发言的（纯工具调用残留）不算会话
      if (users.length === 0) {continue}
      const tail = msgs.slice(-maxMessagesPerSession)
      out.push({
        id,
        lastAt: msgs[msgs.length - 1]?.timestamp || 0,
        count: msgs.length,
        preview: String(users[users.length - 1].content).slice(0, 30),
        messages: tail.map(m => ({
          from: m.role === 'user' ? 'user' : (m.agentId || 'lumina'),
          content: typeof m.content === 'string' ? m.content : '',
          time: new Date(m.timestamp).toLocaleTimeString('zh-CN', {
            hour: '2-digit', minute: '2-digit',
          }),
        })),
      })
    }

    return out.sort((a, b) => b.lastAt - a.lastAt)
  }

  /** 读取指定日期范围的对话 */
  readByDateRange(agentId: string, startDate: string, endDate: string, sessionId?: string): DialogMessage[] {
    const messages: DialogMessage[] = []
    const dialogDir = this._getDialogDir(agentId)
    
    if (!fs.existsSync(dialogDir)) {
      return []
    }
    
    const files = fs.readdirSync(dialogDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => f.replace('.jsonl', ''))
      .filter(date => date >= startDate && date <= endDate)
      .sort()
    
    for (const date of files) {
      const dayMessages = this.readByDate(agentId, date)
      
      if (sessionId) {
        messages.push(...dayMessages.filter(m => m.sessionId === sessionId))
      } else {
        messages.push(...dayMessages)
      }
    }
    
    return messages.sort((a, b) => a.timestamp - b.timestamp)
  }

  /** 删除指定日期的对话归档 */
  deleteByDate(agentId: string, date: string): void {
    const dialogDir = this._getDialogDir(agentId)
    const dialogPath = path.join(dialogDir, `${date}.jsonl`)
    
    if (fs.existsSync(dialogPath)) {
      fs.unlinkSync(dialogPath)
    }
  }

  /** 清理指定日期之前的归档 */
  cleanOldDialogs(agentId: string, beforeDate: string): void {
    const dialogDir = this._getDialogDir(agentId)
    
    if (!fs.existsSync(dialogDir)) {
      return
    }
    
    const files = fs.readdirSync(dialogDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => f.replace('.jsonl', ''))
    
    let cleaned = 0
    for (const date of files) {
      if (date < beforeDate) {
        const dialogPath = path.join(dialogDir, `${date}.jsonl`)
        fs.unlinkSync(dialogPath)
        cleaned++
      }
    }
    
    if (cleaned > 0) {
      console.log(`[AgentDialog] 清理 ${agentId} 的 ${cleaned} 个旧归档`)
    }
  }

  // ── 私有方法 ─────────────────────────────────────────

  private _getDialogDir(agentId: string): string {
    return this._profileManager.getDialogDir(agentId)
  }

  private _generateMessageId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
  }
}

// ═══════════════════════════════════════════════════════════
// 单例
// ═══════════════════════════════════════════════════════════

let _instance: AgentDialogManager | null = null

export function getAgentDialogManager(): AgentDialogManager {
  if (!_instance) {
    _instance = new AgentDialogManager()
  }
  return _instance
}

export function initAgentDialogManager(): AgentDialogManager {
  _instance = new AgentDialogManager()
  return _instance
}
