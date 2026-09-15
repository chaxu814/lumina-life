// ============================================================
// sessionManager.ts — Session 持久化与崩溃恢复 (v2.7)
//
// 借鉴 QwenPaw SafeJSONSession:
//   JSON 格式持久化 session → 崩溃恢复
//   Session 元数据 → 标题/时间/Agent/token 统计
//   历史摘要 → 跨 session 上下文注入
//
// 目录结构:
//   {userData}/sessions/
//     ├── index.json                    ← session 索引
//     ├── 2026-05-18-abc123.json        ← session 数据
//     └── 2026-05-17-xyz789.json
// ============================================================

import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import type { AgentMessage } from './tools/types'

// ═══════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════

/** 将 AgentMessage content 安全转为字符串 */
function toText(content: AgentMessage['content']): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(part => part.text || '').join('')
  }
  return ''
}

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

export interface SessionMeta {
  id: string
  title: string
  agentId: string
  mode: 'chat' | 'agent' | 'developer'
  createdAt: string
  lastActiveAt: string
  messageCount: number
  totalTokens: number
  completed: boolean
  tags: string[]
  summary?: string
  compactedContext?: string
}

export interface SessionData {
  meta: SessionMeta
  messages: AgentMessage[]
  compactedContext?: string  // 压缩后的结构化摘要文本
}

export interface SessionIndex {
  sessions: SessionMeta[]
  lastCleanup: string
}

// ═══════════════════════════════════════════════════════════
// SessionManager
// ═══════════════════════════════════════════════════════════

export class SessionManager {
  private sessionsDir: string
  private index: SessionIndex
  private activeSessions = new Map<string, SessionData>()

  constructor() {
    this.sessionsDir = path.join(app.getPath('userData'), 'sessions')
    if (!fs.existsSync(this.sessionsDir)) {
      fs.mkdirSync(this.sessionsDir, { recursive: true })
    }
    this.index = this.loadIndex()
  }

  // ── 索引管理 ───────────────────────────────────────

  private get indexPath(): string {
    return path.join(this.sessionsDir, 'index.json')
  }

  private loadIndex(): SessionIndex {
    try {
      if (fs.existsSync(this.indexPath)) {
        return JSON.parse(fs.readFileSync(this.indexPath, 'utf-8'))
      }
    } catch { /* ignore */ }
    return { sessions: [], lastCleanup: new Date().toISOString() }
  }

  private saveIndex(): void {
    fs.writeFileSync(this.indexPath, JSON.stringify(this.index, null, 2), 'utf-8')
  }

  private getSessionPath(sessionId: string): string {
    const date = sessionId.includes('-') ? sessionId.split('-')[0] : new Date().toISOString().slice(0, 10)
    return path.join(this.sessionsDir, `${date}-${sessionId}.json`)
  }

  // ── 创建 Session ───────────────────────────────────

  createSession(agentId: string, mode: 'chat' | 'agent' | 'developer' = 'chat'): SessionData {
    const id = this.generateId()
    const now = new Date().toISOString()

    const meta: SessionMeta = {
      id,
      title: `新对话 - ${now.slice(0, 10)}`,
      agentId,
      mode,
      createdAt: now,
      lastActiveAt: now,
      messageCount: 0,
      totalTokens: 0,
      completed: false,
      tags: [],
    }

    const data: SessionData = {
      meta,
      messages: [],
    }

    this.activeSessions.set(id, data)
    this.index.sessions.push(meta)
    this.saveIndex()
    this.persistSession(data)

    return data
  }

  // ── 加载 Session ───────────────────────────────────

  loadSession(sessionId: string): SessionData | null {
    // 先从内存
    const active = this.activeSessions.get(sessionId)
    if (active) return active

    // 从磁盘
    const filePath = this.getSessionPath(sessionId)
    if (!fs.existsSync(filePath)) return null

    try {
      const data: SessionData = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      this.activeSessions.set(sessionId, data)
      // 更新最后活跃时间
      data.meta.lastActiveAt = new Date().toISOString()
      this.updateMeta(sessionId, { lastActiveAt: data.meta.lastActiveAt })
      return data
    } catch {
      return null
    }
  }

  // ── 添加消息 ───────────────────────────────────────

  addMessage(sessionId: string, message: AgentMessage): void {
    const data = this.activeSessions.get(sessionId)
    if (!data) return

    data.messages.push(message)
    data.meta.messageCount = data.messages.length
    data.meta.lastActiveAt = new Date().toISOString()
    this.updateMeta(sessionId, {
      messageCount: data.meta.messageCount,
      lastActiveAt: data.meta.lastActiveAt,
    })

    // 每 5 条消息自动持久化
    if (data.messages.length % 5 === 0) {
      this.persistSession(data)
    }
  }

  // ── 添加 Token ─────────────────────────────────────

  addTokens(sessionId: string, tokens: number): void {
    const data = this.activeSessions.get(sessionId)
    if (!data) return

    data.meta.totalTokens += tokens
    this.updateMeta(sessionId, { totalTokens: data.meta.totalTokens })
  }

  // ── 保存压缩上下文 ─────────────────────────────────

  saveCompactedContext(sessionId: string, context: string): void {
    const data = this.activeSessions.get(sessionId)
    if (!data) return

    data.compactedContext = context
    data.meta.summary = context.slice(0, 200)
    this.updateMeta(sessionId, { summary: data.meta.summary })
    this.persistSession(data)
  }

  
  // ── 获取压缩上下文 ─────────────────────────────────

  getCompactedContext(sessionId: string): string | null {
    const data = this.activeSessions.get(sessionId)
    if (data?.compactedContext) return data.compactedContext
    // 从磁盘加载
    const filePath = this.getSessionPath(sessionId)
    if (!fs.existsSync(filePath)) return null
    try {
      const data: SessionData = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      return data.compactedContext || null
    } catch {
      return null
    }
  }

  // ── 清除压缩上下文 ─────────────────────────────────

  clearCompactedContext(sessionId: string): void {
    const data = this.activeSessions.get(sessionId)
    if (data) {
      data.compactedContext = undefined
      this.persistSession(data)
    }
  }

// ── 获取压缩上下文 (用于跨 session 注入) ──────────

  getCompactedContextForInjection(sessionId: string): string | null {
    const data = this.activeSessions.get(sessionId)
    if (data?.compactedContext) return data.compactedContext
    return null
  }

  // ── 更新元数据 ─────────────────────────────────────

  updateMeta(sessionId: string, updates: Partial<SessionMeta>): void {
    const data = this.activeSessions.get(sessionId)
    if (!data) {
      // 只更新索引
      const idx = this.index.sessions.findIndex(s => s.id === sessionId)
      if (idx >= 0) {
        this.index.sessions[idx] = { ...this.index.sessions[idx], ...updates }
        this.saveIndex()
      }
      return
    }

    Object.assign(data.meta, updates)

    const idx = this.index.sessions.findIndex(s => s.id === sessionId)
    if (idx >= 0) {
      this.index.sessions[idx] = { ...this.index.sessions[idx], ...updates }
      this.saveIndex()
    }
  }

  // ── 完成 Session ───────────────────────────────────

  completeSession(sessionId: string): void {
    const data = this.activeSessions.get(sessionId)
    if (!data) return

    data.meta.completed = true
    this.updateMeta(sessionId, { completed: true })
    this.persistSession(data)
    this.activeSessions.delete(sessionId)
  }

  // ── 持久化到磁盘 ───────────────────────────────────

  persistSession(data: SessionData): void {
    try {
      const filePath = this.getSessionPath(data.meta.id)
      // Safe write: 先写临时文件再重命名
      const tmpPath = filePath + '.tmp'
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8')
      fs.renameSync(tmpPath, filePath)
    } catch (err) {
      console.error('[SessionManager] 持久化失败:', err)
    }
  }

  // ── 列出 Sessions ──────────────────────────────────

  listSessions(filter?: { completed?: boolean; agentId?: string; limit?: number }): SessionMeta[] {
    let sessions = [...this.index.sessions]

    if (filter?.completed !== undefined) {
      sessions = sessions.filter(s => s.completed === filter.completed)
    }
    if (filter?.agentId) {
      sessions = sessions.filter(s => s.agentId === filter.agentId)
    }

    sessions.sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime())

    if (filter?.limit) {
      sessions = sessions.slice(0, filter.limit)
    }

    return sessions
  }

  // ── 恢复未完成的 Sessions (崩溃恢复) ──────────────

  recoverIncompleteSessions(): SessionMeta[] {
    const incomplete = this.index.sessions.filter(s => !s.completed)
    const recovered: SessionMeta[] = []

    for (const meta of incomplete) {
      const data = this.loadSession(meta.id)
      if (data) {
        // 标记为恢复
        const recoveryNote: AgentMessage = {
          role: 'system',
          content: `[会话恢复] 此对话从 ${meta.lastActiveAt} 恢复。之前进行了 ${meta.messageCount} 轮对话，共消耗 ${meta.totalTokens} tokens。`,
        }
        data.messages.push(recoveryNote)

        if (data.compactedContext) {
          const contextNote: AgentMessage = {
            role: 'system',
            content: data.compactedContext,
          }
          data.messages.push(contextNote)
        }

        recovered.push(meta)
      }
    }

    return recovered
  }

  // ── 删除 Session ───────────────────────────────────

  deleteSession(sessionId: string): void {
    this.activeSessions.delete(sessionId)

    // 从索引删除
    this.index.sessions = this.index.sessions.filter(s => s.id !== sessionId)
    this.saveIndex()

    // 删除文件
    const filePath = this.getSessionPath(sessionId)
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
    }
  }

  // ── 清理旧 Sessions ────────────────────────────────

  cleanupOldSessions(maxAgeDays: number = 30): number {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - maxAgeDays)

    const toDelete = this.index.sessions.filter(s => {
      return s.completed && new Date(s.lastActiveAt) < cutoff
    })

    for (const meta of toDelete) {
      this.deleteSession(meta.id)
    }

    this.index.lastCleanup = new Date().toISOString()
    this.saveIndex()

    return toDelete.length
  }

  // ── 搜索 Sessions ──────────────────────────────────

  searchSessions(query: string): SessionMeta[] {
    const q = query.toLowerCase()
    return this.index.sessions.filter(s =>
      s.title.toLowerCase().includes(q) ||
      s.tags.some(t => t.toLowerCase().includes(q)) ||
      (s.summary && s.summary.toLowerCase().includes(q)) ||
      (s.compactedContext && s.compactedContext.toLowerCase().includes(q)),
    )
  }

  // ── 导出 ───────────────────────────────────────────

  exportSession(sessionId: string, format: 'json' | 'markdown' = 'json'): string | null {
    const data = this.loadSession(sessionId)
    if (!data) return null

    if (format === 'markdown') {
      const lines: string[] = [
        `# ${data.meta.title}`,
        '',
        `- 时间: ${data.meta.createdAt} → ${data.meta.lastActiveAt}`,
        `- 模式: ${data.meta.mode}`,
        `- 消息数: ${data.meta.messageCount}`,
        `- Tokens: ${data.meta.totalTokens}`,
        '',
        '---',
        '',
      ]

      for (const msg of data.messages) {
        const role = msg.role === 'user' ? '👤 用户' : msg.role === 'assistant' ? '🤖 助手' : `⚙️ ${msg.role}`
        lines.push(`### ${role}`)
        lines.push('')
        lines.push(toText(msg.content).slice(0, 2000))
        lines.push('')
      }

      return lines.join('\n')
    }

    return JSON.stringify(data, null, 2)
  }

  // ── 工具 ───────────────────────────────────────────

  private generateId(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
    let id = ''
    for (let i = 0; i < 16; i++) {
      id += chars[Math.floor(Math.random() * chars.length)]
    }
    return id
  }
}

// ═══════════════════════════════════════════════════════════
// 全局单例
// ═══════════════════════════════════════════════════════════

let globalSessionManager: SessionManager | null = null

export function getSessionManager(): SessionManager {
  if (!globalSessionManager) {
    globalSessionManager = new SessionManager()
  }
  return globalSessionManager
}
