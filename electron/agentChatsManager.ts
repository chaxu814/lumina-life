// ============================================================
// agentChatsManager.ts — Agent 独立对话历史管理器 (P3-2)
//
// 每个 Agent 拥有独立的 chats.json，包含：
//   - Lumina 只读自己的对话历史
//   - delegate 给 Yak 时，Yak 在自己的 chats 里记录，不污染 Lumina
// ============================================================

import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { getAgentProfileManager, AgentProfile } from './agentProfileManager'

// ═══════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  timestamp: number
  agentId?: string // 记录消息来源 Agent
  metadata?: {
    toolName?: string
    toolResult?: any
    toolCalls?: any
    delegationFrom?: string // 委托来源
    delegationTo?: string // 委托目标
  }
}

export interface ChatSession {
  id: string
  title: string
  agentId: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
  metadata?: {
    contextSummary?: string // 压缩摘要
    compactedContext?: string // P0-1: 压缩后上下文
  }
}

export interface ChatsStore {
  version: string
  currentSessionId?: string
  sessions: Record<string, ChatSession>
}

// ═══════════════════════════════════════════════════════════
// AgentChatsManager
// ═══════════════════════════════════════════════════════════

export class AgentChatsManager {
  private _stores: Map<string, ChatsStore> = new Map()
  private _profileManager = getAgentProfileManager()

  /** 加载所有 Agent 的对话历史 */
  loadAll(): Record<string, ChatsStore> {
    this._stores.clear()
    const profiles = this._profileManager.getAll()
    
    for (const [agentId, profile] of Object.entries(profiles)) {
      try {
        const store = this.load(agentId)
        this._stores.set(agentId, store)
      } catch (e) {
        console.warn(`[AgentChats] 加载 ${agentId} 对话历史失败:`, e)
      }
    }
    
    return this._getAll()
  }

  /** 加载单个 Agent 的对话历史 */
  load(agentId: string): ChatsStore {
    const chatsPath = this._getChatsPath(agentId)
    
    if (!fs.existsSync(chatsPath)) {
      return this._createEmptyStore(agentId)
    }
    
    try {
      const raw = fs.readFileSync(chatsPath, 'utf-8')
      return JSON.parse(raw) as ChatsStore
    } catch (e) {
      // 🔧 P0 修复（静默丢对话历史）
      // 旧实现：解析失败 → 返回空 store。
      // 而 addMessage 会把这个空 store 缓存下来，下次写入就把
      // **整个 Agent 的完整对话历史**覆盖成 1 条，且原文件不可恢复。
      // 用户丢的是他最不能丢的东西：聊天记录。
      //
      // 现在：先把损坏原文备份到 .corrupted 文件，再抛错。
      // 抛错后调用方不会写入，原文件保持原样，用户还能手动抢救。
      const backup = chatsPath + '.corrupted'
      try {
        if (!fs.existsSync(backup)) {fs.copyFileSync(chatsPath, backup)}
        console.error(
          `[AgentChats] ${agentId} 的 chats.json 已损坏，原文已备份到 ${backup}。` +
          '为避免覆盖历史数据，本次不写入。'
        )
      } catch { /* 备份失败也要继续抛错，绝不能退回「当空」 */ }
      throw new Error(
        `AgentChats: ${agentId} 的对话记录已损坏（原文备份于 ${backup}），已中止写入以免覆盖历史`
      )
    }
  }

  /** 保存单个 Agent 的对话历史 */
  save(agentId: string, store: ChatsStore): void {
    const chatsPath = this._getChatsPath(agentId)
    const dir = path.dirname(chatsPath)
    
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    
    // 🔧 写入前先滚动备份一份（只保留最近 3 份）。
    // 即使是正常路径下的意外覆盖（如 bug 导致写入了残缺数据），
    // 用户也有机会从备份里捞回历史。
    if (fs.existsSync(chatsPath)) {
      try {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const bak = `${chatsPath}.bak.${stamp}`
        fs.copyFileSync(chatsPath, bak)
        // 只保留最近 3 份，避免目录无限膨胀
        try {
          const baks = fs.readdirSync(path.dirname(chatsPath))
            .filter(f => f.startsWith(path.basename(chatsPath) + '.bak.'))
            .sort()
          for (const old of baks.slice(0, Math.max(0, baks.length - 3))) {
            try {fs.unlinkSync(path.join(path.dirname(chatsPath), old))} catch { /* ignore */ }
          }
        } catch { /* 清理失败不影响写入 */ }
      } catch { /* 备份失败不阻塞保存 */ }
    }
    fs.writeFileSync(chatsPath, JSON.stringify(store, null, 2), 'utf-8')
    this._stores.set(agentId, store)
  }

  /** 获取单个 Agent 的对话历史 */
  get(agentId: string): ChatsStore {
    if (!this._stores.has(agentId)) {
      this._stores.set(agentId, this.load(agentId))
    }
    return this._stores.get(agentId)!
  }

  /** 获取所有 Agent 的对话历史 */
  getAll(): Record<string, ChatsStore> {
    return this._getAll()
  }

  /** 添加消息到指定 Agent */
  addMessage(agentId: string, sessionId: string, message: Omit<ChatMessage, 'id' | 'timestamp'>): ChatMessage {
    const store = this.get(agentId)
    const session = store.sessions[sessionId] || this._createSession(agentId, sessionId)
    
    const newMessage: ChatMessage = {
      ...message,
      id: this._generateMessageId(),
      timestamp: Date.now(),
    }
    
    session.messages.push(newMessage)
    session.updatedAt = Date.now()
    store.currentSessionId = sessionId
    
    this.save(agentId, store)
    return newMessage
  }

  /** 创建新会话 */
  createSession(agentId: string, title?: string): ChatSession {
    const store = this.get(agentId)
    const sessionId = this._generateSessionId()
    const session = this._createSession(agentId, sessionId, title)
    
    store.sessions[sessionId] = session
    store.currentSessionId = sessionId
    
    this.save(agentId, store)
    return session
  }

  /** 获取当前会话 */
  getCurrentSession(agentId: string): ChatSession | null {
    const store = this.get(agentId)
    if (!store.currentSessionId) {return null}
    return store.sessions[store.currentSessionId] || null
  }

  /** 删除会话 */
  deleteSession(agentId: string, sessionId: string): void {
    const store = this.get(agentId)
    delete store.sessions[sessionId]
    
    if (store.currentSessionId === sessionId) {
      store.currentSessionId = Object.keys(store.sessions)[0] || undefined
    }
    
    this.save(agentId, store)
  }

  // ── 私有方法 ─────────────────────────────────────────

  private _getAll(): Record<string, ChatsStore> {
    const result: Record<string, ChatsStore> = {}
    for (const [agentId, store] of this._stores) {
      result[agentId] = store
    }
    return result
  }

  private _getChatsPath(agentId: string): string {
    const profile = this._profileManager.get(agentId)
    const agentDir = this._profileManager.getAgentDir(agentId)
    return path.join(agentDir, profile?.paths?.chats || 'chats.json')
  }

  private _createEmptyStore(agentId: string): ChatsStore {
    return {
      version: '1.0',
      currentSessionId: undefined,
      sessions: {},
    }
  }

  private _createSession(agentId: string, sessionId: string, title?: string): ChatSession {
    return {
      id: sessionId,
      title: title || `对话 ${new Date().toLocaleString('zh-CN')}`,
      agentId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    }
  }

  private _generateSessionId(): string {
    return `session_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
  }

  private _generateMessageId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
  }
}

// ═══════════════════════════════════════════════════════════
// 单例
// ═══════════════════════════════════════════════════════════

let _instance: AgentChatsManager | null = null

export function getAgentChatsManager(): AgentChatsManager {
  if (!_instance) {
    _instance = new AgentChatsManager()
    _instance.loadAll()
  }
  return _instance
}

export function initAgentChatsManager(): AgentChatsManager {
  _instance = new AgentChatsManager()
  _instance.loadAll()
  return _instance
}
