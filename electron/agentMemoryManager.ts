// ============================================================
// agentMemoryManager.ts — Agent 独立记忆管理器 (P3-4)
//
// 每个 Agent 拥有独立的记忆文件：
//   - MEMORY.md 长期偏好
//   - memory/YYYY-MM-DD.md 每日笔记
// ============================================================

import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { getAgentProfileManager } from './agentProfileManager'

// ═══════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════

export interface MemoryNote {
  date: string // YYYY-MM-DD
  content: string
  tags?: string[]
  createdAt: number
  updatedAt: number
}

export interface AgentMemory {
  version: string
  agentId: string
  lastUpdated: number
  longTerm: string[] // MEMORY.md 内容（按行分割）
  notes: Record<string, MemoryNote> // key = YYYY-MM-DD
}

// ═══════════════════════════════════════════════════════════
// AgentMemoryManager
// ═══════════════════════════════════════════════════════════

export class AgentMemoryManager {
  private _memories: Map<string, AgentMemory> = new Map()
  private _profileManager = getAgentProfileManager()

  /** 加载所有 Agent 的记忆 */
  loadAll(): Record<string, AgentMemory> {
    this._memories.clear()
    const profiles = this._profileManager.getAll()
    
    for (const agentId of Object.keys(profiles)) {
      try {
        const memory = this.load(agentId)
        this._memories.set(agentId, memory)
      } catch (e) {
        console.warn(`[AgentMemory] 加载 ${agentId} 记忆失败:`, e)
      }
    }
    
    return this._getAll()
  }

  /** 加载单个 Agent 的记忆 */
  load(agentId: string): AgentMemory {
    const memoryDir = this._getMemoryDir(agentId)
    const memoryMdPath = path.join(memoryDir, 'MEMORY.md')
    const memoryJsonPath = path.join(memoryDir, 'memory.json')
    
    // 优先从 memory.json 加载结构化数据
    if (fs.existsSync(memoryJsonPath)) {
      try {
        const raw = fs.readFileSync(memoryJsonPath, 'utf-8')
        return JSON.parse(raw) as AgentMemory
      } catch (e) {
        console.warn(`[AgentMemory] 加载 ${agentId} memory.json 失败:`, e)
      }
    }
    
    // 从 MEMORY.md 解析
    const memory: AgentMemory = {
      version: '1.0',
      agentId,
      lastUpdated: Date.now(),
      longTerm: [],
      notes: {},
    }
    
    if (fs.existsSync(memoryMdPath)) {
      try {
        const content = fs.readFileSync(memoryMdPath, 'utf-8')
        memory.longTerm = content.split('\n').filter(line => line.trim())
        
        // 尝试提取每日笔记引用
        const noteRefs = content.match(/\[\[([^\]]+)\]\]/g) || []
        for (const ref of noteRefs) {
          const date = ref.match(/\[\[(.+?)\]\]/)?.[1]
          if (date) {
            const notePath = path.join(memoryDir, `${date}.md`)
            if (fs.existsSync(notePath)) {
              memory.notes[date] = {
                date,
                content: fs.readFileSync(notePath, 'utf-8'),
                createdAt: Date.now(),
                updatedAt: Date.now(),
              }
            }
          }
        }
      } catch (e) {
        console.warn(`[AgentMemory] 解析 ${agentId} MEMORY.md 失败:`, e)
      }
    }
    
    return memory
  }

  /** 保存单个 Agent 的记忆 */
  save(agentId: string, memory: AgentMemory): void {
    const memoryDir = this._getMemoryDir(agentId)
    if (!fs.existsSync(memoryDir)) {
      fs.mkdirSync(memoryDir, { recursive: true })
    }
    
    memory.lastUpdated = Date.now()
    
    // 保存结构化数据
    const memoryJsonPath = path.join(memoryDir, 'memory.json')
    fs.writeFileSync(memoryJsonPath, JSON.stringify(memory, null, 2), 'utf-8')
    
    // 保存 MEMORY.md（可读版本）
    const memoryMdPath = path.join(memoryDir, 'MEMORY.md')
    const mdContent = [
      `# ${this._getAgentName(agentId)} 长期记忆`,
      '',
      `> 最后更新: ${new Date().toLocaleString('zh-CN')}`,
      '',
      '## 长期偏好',
      '',
      ...memory.longTerm,
      '',
      '## 每日笔记',
      '',
      ...Object.keys(memory.notes)
        .sort()
        .reverse()
        .slice(0, 30)
        .map(date => `- [[${date}]]`),
    ].join('\n')
    
    fs.writeFileSync(memoryMdPath, mdContent, 'utf-8')
    
    // 保存每日笔记
    for (const [date, note] of Object.entries(memory.notes)) {
      const notePath = path.join(memoryDir, `${date}.md`)
      fs.writeFileSync(notePath, note.content, 'utf-8')
    }
    
    this._memories.set(agentId, memory)
  }

  /** 获取单个 Agent 的记忆 */
  get(agentId: string): AgentMemory {
    if (!this._memories.has(agentId)) {
      this._memories.set(agentId, this.load(agentId))
    }
    return this._memories.get(agentId)!
  }

  /** 获取所有 Agent 的记忆 */
  getAll(): Record<string, AgentMemory> {
    return this._getAll()
  }

  /** 添加长期记忆 */
  addLongTermMemory(agentId: string, content: string): void {
    const memory = this.get(agentId)
    memory.longTerm.push(content)
    this.save(agentId, memory)
  }

  /** 添加每日笔记 */
  addDailyNote(agentId: string, date: string, content: string, tags?: string[]): void {
    const memory = this.get(agentId)
    
    if (!memory.notes[date]) {
      memory.notes[date] = {
        date,
        content,
        tags,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
    } else {
      memory.notes[date].content = content
      memory.notes[date].tags = tags
      memory.notes[date].updatedAt = Date.now()
    }
    
    this.save(agentId, memory)
  }

  /** 更新每日笔记 */
  updateDailyNote(agentId: string, date: string, content: string): void {
    const memory = this.get(agentId)
    
    if (memory.notes[date]) {
      memory.notes[date].content = content
      memory.notes[date].updatedAt = Date.now()
      this.save(agentId, memory)
    }
  }

  /** 删除每日笔记 */
  deleteDailyNote(agentId: string, date: string): void {
    const memory = this.get(agentId)
    delete memory.notes[date]
    this.save(agentId, memory)
  }

  /** 获取指定日期范围的笔记 */
  getNotesInRange(agentId: string, startDate: string, endDate: string): MemoryNote[] {
    const memory = this.get(agentId)
    const notes: MemoryNote[] = []
    
    for (const [date, note] of Object.entries(memory.notes)) {
      if (date >= startDate && date <= endDate) {
        notes.push(note)
      }
    }
    
    return notes.sort((a, b) => a.date.localeCompare(b.date))
  }

  // ── 私有方法 ─────────────────────────────────────────

  private _getAll(): Record<string, AgentMemory> {
    const result: Record<string, AgentMemory> = {}
    for (const [agentId, memory] of this._memories) {
      result[agentId] = memory
    }
    return result
  }

  private _getMemoryDir(agentId: string): string {
    return this._profileManager.getMemoryDir(agentId)
  }

  private _getAgentName(agentId: string): string {
    const profile = this._profileManager.get(agentId)
    return profile?.name || agentId
  }
}

// ═══════════════════════════════════════════════════════════
// 单例
// ═══════════════════════════════════════════════════════════

let _instance: AgentMemoryManager | null = null

export function getAgentMemoryManager(): AgentMemoryManager {
  if (!_instance) {
    _instance = new AgentMemoryManager()
    _instance.loadAll()
  }
  return _instance
}

export function initAgentMemoryManager(): AgentMemoryManager {
  _instance = new AgentMemoryManager()
  _instance.loadAll()
  return _instance
}
