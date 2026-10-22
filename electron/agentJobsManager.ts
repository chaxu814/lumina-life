// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// agentJobsManager.ts — Agent 独立任务管理器 (P3-3)
//
// 每个 Agent 拥有独立的 jobs.json，包含：
//   - 定时任务、后台任务按 Agent 隔离
//   - 任务状态持久化
//   - 支持任务查询、取消、进度跟踪
// ============================================================

import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { getAgentProfileManager } from './agentProfileManager'

// ═══════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
export type JobType = 'cron' | 'async' | 'delegation'

export interface AgentJob {
  id: string
  agentId: string
  type: JobType
  status: JobStatus
  title: string
  description?: string
  createdAt: number
  updatedAt: number
  startedAt?: number
  completedAt?: number
  progress: number // 0-100
  result?: any
  error?: string
  metadata?: {
    cronPattern?: string // for cron jobs
    parentJobId?: string // for delegation
    taskId?: string // for async tasks
  }
}

export interface JobsStore {
  version: string
  jobs: Record<string, AgentJob>
}

// ═══════════════════════════════════════════════════════════
// AgentJobsManager
// ═══════════════════════════════════════════════════════════

export class AgentJobsManager {
  private _stores: Map<string, JobsStore> = new Map()
  private _profileManager = getAgentProfileManager()

  /** 加载所有 Agent 的任务 */
  loadAll(): Record<string, JobsStore> {
    this._stores.clear()
    const profiles = this._profileManager.getAll()
    
    for (const agentId of Object.keys(profiles)) {
      try {
        const store = this.load(agentId)
        this._stores.set(agentId, store)
      } catch (e) {
        console.warn(`[AgentJobs] 加载 ${agentId} 任务失败:`, e)
      }
    }
    
    return this._getAll()
  }

  /** 加载单个 Agent 的任务 */
  load(agentId: string): JobsStore {
    const jobsPath = this._getJobsPath(agentId)
    
    if (!fs.existsSync(jobsPath)) {
      return this._createEmptyStore()
    }
    
    try {
      const raw = fs.readFileSync(jobsPath, 'utf-8')
      return JSON.parse(raw) as JobsStore
    } catch (e) {
      console.warn(`[AgentJobs] 加载 ${agentId} jobs.json 失败:`, e)
      return this._createEmptyStore()
    }
  }

  /** 保存单个 Agent 的任务 */
  save(agentId: string, store: JobsStore): void {
    const jobsPath = this._getJobsPath(agentId)
    const dir = path.dirname(jobsPath)
    
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    
    fs.writeFileSync(jobsPath, JSON.stringify(store, null, 2), 'utf-8')
    this._stores.set(agentId, store)
  }

  /** 获取单个 Agent 的任务列表 */
  getJobs(agentId: string): AgentJob[] {
    const store = this.get(agentId)
    return Object.values(store.jobs).sort((a, b) => b.createdAt - a.createdAt)
  }

  /** 获取单个 Agent 的任务存储 */
  get(agentId: string): JobsStore {
    if (!this._stores.has(agentId)) {
      this._stores.set(agentId, this.load(agentId))
    }
    return this._stores.get(agentId)!
  }

  /** 获取所有 Agent 的任务 */
  getAll(): Record<string, JobsStore> {
    return this._getAll()
  }

  /** 添加任务 */
  addJob(agentId: string, job: Omit<AgentJob, 'id' | 'createdAt' | 'updatedAt' | 'progress'>): AgentJob {
    const store = this.get(agentId)
    
    const newJob: AgentJob = {
      ...job,
      id: this._generateJobId(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      progress: 0,
    }
    
    store.jobs[newJob.id] = newJob
    this.save(agentId, store)
    
    return newJob
  }

  /** 更新任务状态 */
  updateJobStatus(agentId: string, jobId: string, updates: Partial<Pick<AgentJob, 'status' | 'progress' | 'result' | 'error' | 'startedAt' | 'completedAt'>>): void {
    const store = this.get(agentId)
    const job = store.jobs[jobId]
    
    if (!job) {
      console.warn(`[AgentJobs] 任务 ${jobId} 不存在`)
      return
    }
    
    Object.assign(job, updates, { updatedAt: Date.now() })
    this.save(agentId, store)
  }

  /** 取消任务 */
  cancelJob(agentId: string, jobId: string): boolean {
    const store = this.get(agentId)
    const job = store.jobs[jobId]
    
    if (!job || job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
      return false
    }
    
    job.status = 'cancelled'
    job.completedAt = Date.now()
    job.updatedAt = Date.now()
    
    this.save(agentId, store)
    return true
  }

  /** 删除任务 */
  deleteJob(agentId: string, jobId: string): void {
    const store = this.get(agentId)
    delete store.jobs[jobId]
    this.save(agentId, store)
  }

  /** 清理已完成/失败/取消的任务（保留最近 N 条） */
  cleanOldJobs(agentId: string, keepCount: number = 50): void {
    const store = this.get(agentId)
    const jobs = Object.values(store.jobs)
    
    // 筛选可清理的任务
    const cleanable = jobs
      .filter(j => ['completed', 'failed', 'cancelled'].includes(j.status))
      .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0))
    
    // 保留最近的 keepCount 条
    const toDelete = cleanable.slice(keepCount)
    
    for (const job of toDelete) {
      delete store.jobs[job.id]
    }
    
    if (toDelete.length > 0) {
      this.save(agentId, store)
      console.log(`[AgentJobs] 清理 ${agentId} 的 ${toDelete.length} 条旧任务`)
    }
  }

  // ── 私有方法 ─────────────────────────────────────────

  private _getAll(): Record<string, JobsStore> {
    const result: Record<string, JobsStore> = {}
    for (const [agentId, store] of this._stores) {
      result[agentId] = store
    }
    return result
  }

  private _getJobsPath(agentId: string): string {
    const profile = this._profileManager.get(agentId)
    const agentDir = this._profileManager.getAgentDir(agentId)
    return path.join(agentDir, profile?.paths?.jobs || 'jobs.json')
  }

  private _createEmptyStore(): JobsStore {
    return {
      version: '1.0',
      jobs: {},
    }
  }

  private _generateJobId(): string {
    return `job_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
  }
}

// ═══════════════════════════════════════════════════════════
// 单例
// ═══════════════════════════════════════════════════════════

let _instance: AgentJobsManager | null = null

export function getAgentJobsManager(): AgentJobsManager {
  if (!_instance) {
    _instance = new AgentJobsManager()
    _instance.loadAll()
  }
  return _instance
}

export function initAgentJobsManager(): AgentJobsManager {
  _instance = new AgentJobsManager()
  _instance.loadAll()
  return _instance
}
