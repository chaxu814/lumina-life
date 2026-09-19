// ============================================================
// agentWorkspaceManager.ts — Agent 工作区统一管理入口 (P3-1 ~ P3-5, P4-1 ~ P4-5)
//
// 统一管理：
//   - AgentProfileManager (P3-1: agent.json)
//   - AgentChatsManager (P3-2: chats.json)
//   - AgentJobsManager (P3-3: jobs.json)
//   - AgentMemoryManager (P3-4: memory/)
//   - AgentDialogManager (P4-1: dialog/)
//   - HybridMemoryRetrieval (P4-4: 混合检索)
//   - AutoRefineManager (P4-5: 自动精炼)
// ============================================================

import { app } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { getAgentProfileManager, initAgentProfileManager } from './agentProfileManager'
import { getAgentChatsManager, initAgentChatsManager } from './agentChatsManager'
import { getAgentJobsManager, initAgentJobsManager } from './agentJobsManager'
import { getAgentMemoryManager, initAgentMemoryManager } from './agentMemoryManager'
import { getAgentDialogManager, initAgentDialogManager } from './agentDialogManager'
import { getAgentConfig } from './agentConfig'
import { getHybridMemoryRetrieval } from './hybridMemoryRetrieval'
import { getAutoRefineManager, initAutoRefineManager, type RefineResult } from './autoRefineManager'

// ═══════════════════════════════════════════════════════════
// AgentWorkspaceManager
// ═══════════════════════════════════════════════════════════

export class AgentWorkspaceManager {
  private _initialized: boolean = false
  private _baseDir: string

  constructor(baseDir?: string) {
    this._baseDir = baseDir || path.join(app.getPath('userData'), 'agents')
  }

  /** 初始化所有 Agent 工作区 */
  initialize(): void {
    if (this._initialized) {return}
    
    console.log('[AgentWorkspace] 🚀 初始化 Agent 工作区...')
    
    // 确保基础目录存在
    if (!fs.existsSync(this._baseDir)) {
      fs.mkdirSync(this._baseDir, { recursive: true })
    }
    
    // 初始化各管理器
    initAgentProfileManager(this._baseDir)
    initAgentChatsManager()
    initAgentJobsManager()
    initAgentMemoryManager()
    initAgentDialogManager()
    
    // P4-4: 初始化混合检索
    getHybridMemoryRetrieval()
    
    // P4-5: 初始化自动精炼
    initAutoRefineManager(24) // 每 24 小时精炼一次
    
    // 确保所有 Agent 目录结构完整
    this._ensureAgentDirectories()
    
    this._initialized = true
    console.log('[AgentWorkspace] ✅ 初始化完成')
  }

  /** 获取 Agent 配置管理器 */
  get profiles() {
    return getAgentProfileManager()
  }

  /** 获取 Agent 对话管理器 */
  get chats() {
    return getAgentChatsManager()
  }

  /** 获取 Agent 任务管理器 */
  get jobs() {
    return getAgentJobsManager()
  }

  /** 获取 Agent 记忆管理器 */
  get memory() {
    return getAgentMemoryManager()
  }

  /** 获取 Agent Dialog 管理器 */
  get dialog() {
    return getAgentDialogManager()
  }

  /** 获取 Agent LLM 配置管理器 */
  get config() {
    return getAgentConfig()
  }

  /** 获取混合检索管理器 (P4-4) */
  get retrieval() {
    return getHybridMemoryRetrieval()
  }

  /** 获取自动精炼管理器 (P4-5) */
  get autoRefine() {
    return getAutoRefineManager()
  }

  /** 启动自动精炼定时器 */
  startAutoRefine(): void {
    this.autoRefine.start()
  }

  /** 停止自动精炼定时器 */
  stopAutoRefine(): void {
    this.autoRefine.stop()
  }

  /** 手动触发精炼 */
  async runRefine(): Promise<RefineResult[]> {
    return this.autoRefine.runRefine()
  }

  /** 混合检索 (P4-4) */
  async retrieveMemory(query: string, options: any = {}): Promise<any[]> {
    return this.retrieval.retrieve(query, options)
  }

  /** 获取所有 Agent 工作区状态 */
  getStatus(): Record<string, {
    profile: any
    chats: { sessionCount: number; messageCount: number }
    jobs: { pending: number; running: number; completed: number; failed: number }
    memory: { noteCount: number; lastUpdated: number }
  }> {
    const profiles = this.profiles.getAll()
    const chats = this.chats.getAll()
    const jobs = this.jobs.getAll()
    const memories = this.memory.getAll()
    
    const status: Record<string, any> = {}
    
    for (const agentId of Object.keys(profiles)) {
      const chatStore = chats[agentId]
      const jobStore = jobs[agentId]
      const memory = memories[agentId]
      
      status[agentId] = {
        profile: profiles[agentId],
        chats: {
          sessionCount: Object.keys(chatStore?.sessions || {}).length,
          messageCount: Object.values(chatStore?.sessions || {}).reduce((sum, s) => sum + s.messages.length, 0),
        },
        jobs: {
          pending: Object.values(jobStore?.jobs || {}).filter(j => j.status === 'pending').length,
          running: Object.values(jobStore?.jobs || {}).filter(j => j.status === 'running').length,
          completed: Object.values(jobStore?.jobs || {}).filter(j => j.status === 'completed').length,
          failed: Object.values(jobStore?.jobs || {}).filter(j => j.status === 'failed').length,
        },
        memory: {
          noteCount: Object.keys(memory?.notes || {}).length,
          lastUpdated: memory?.lastUpdated || 0,
        },
      }
    }
    
    return status
  }

  // ── 私有方法 ─────────────────────────────────────────

  /** 确保所有 Agent 目录结构完整 */
  private _ensureAgentDirectories(): void {
    const agentIds = ['lumina', 'yak', 'recha']
    
    for (const agentId of agentIds) {
      const agentDir = path.join(this._baseDir, agentId)
      
      // 创建必要子目录
      const subdirs = ['memory', 'dialog']
      for (const subdir of subdirs) {
        const subdirPath = path.join(agentDir, subdir)
        if (!fs.existsSync(subdirPath)) {
          fs.mkdirSync(subdirPath, { recursive: true })
        }
      }
      
      // 确保 agent.json 存在
      const agentJsonPath = path.join(agentDir, 'agent.json')
      if (!fs.existsSync(agentJsonPath)) {
        const profile = this.profiles.get(agentId)
        if (profile) {
          this.profiles.save(agentId, profile)
        }
      }
      
      // 确保 chats.json 存在
      const chatsPath = path.join(agentDir, 'chats.json')
      if (!fs.existsSync(chatsPath)) {
        this.chats.save(agentId, this.chats.load(agentId))
      }
      
      // 确保 jobs.json 存在
      const jobsPath = path.join(agentDir, 'jobs.json')
      if (!fs.existsSync(jobsPath)) {
        this.jobs.save(agentId, this.jobs.load(agentId))
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════
// 单例
// ═══════════════════════════════════════════════════════════

let _instance: AgentWorkspaceManager | null = null

export function getAgentWorkspaceManager(): AgentWorkspaceManager {
  if (!_instance) {
    _instance = new AgentWorkspaceManager()
    _instance.initialize()
  }
  return _instance
}

export function initAgentWorkspaceManager(baseDir?: string): AgentWorkspaceManager {
  _instance = new AgentWorkspaceManager(baseDir)
  _instance.initialize()
  return _instance
}
