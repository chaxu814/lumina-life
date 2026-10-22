// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// asyncTaskManager.ts — 异步后台任务管理器 (P3-3, P4-2, P1-2)
//
// 增强特性：
//   1. 细粒度进度追踪（支持百分比+状态文本）
//   2. 取消功能（排队/运行中任务均可取消）
//   3. 失败保留工作区（任务失败时保留工作区文件）
//   4. 任务状态持久化到磁盘，支持重启后恢复
// ============================================================

import { EventEmitter } from 'events'
import { AgentRunner } from './agentRunner'
import type { AgentRunConfig } from './tools/types'
import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'

// ═══════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════

export type TaskStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled' | 'paused'

export interface AsyncTask {
  id: string
  title: string
  prompt: string
  status: TaskStatus
  progress: string
  progressPercent: number
  result?: string
  error?: string
  createdAt: number
  updatedAt: number
  config: AgentRunConfig
  runner?: AgentRunner
  /** 失败时保留的工作区路径 */
  preservedWorkspace?: string
  /** 任务标签（用于分类） */
  tags?: string[]
  /** 🆕 v02: 执行该任务的 Agent（'yak'|'recha'|...），供任务工作区展示 */
  assignee?: string
}

export interface TaskProgressEvent {
  taskId: string
  status: TaskStatus
  progress: string
  progressPercent: number
  result?: string
  error?: string
  preservedWorkspace?: string
}

export interface TaskSubmitOptions {
  title?: string
  tags?: string[]
  preserveWorkspaceOnError?: boolean
  workspacePath?: string
  /** 🆕 v02: 执行 Agent ID */
  assignee?: string
}

// ═══════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════

const MAX_CONCURRENT = 3
const TASK_TIMEOUT = 10 * 60 * 1000 // 10 分钟
const PERSIST_INTERVAL = 5000 // 持久化间隔（ms）

// ═══════════════════════════════════════════════════════════
// AsyncTaskManager
// ═══════════════════════════════════════════════════════════

export class AsyncTaskManager extends EventEmitter {
  private tasks = new Map<string, AsyncTask>()
  private queue: string[] = []
  private running = new Set<string>()
  private idCounter = 0
  private persistTimer?: NodeJS.Timeout
  private _persistPath: string
  /** Electron app 就绪前先不落盘，等 ready 后再补路径并加载 */
  private _appReady = false

  constructor(persistPath?: string) {
    super()
    this._persistPath = this._resolvePersistPath(persistPath)
    if (this._appReady) {
      this._load()
      this._startPersistTimer()
    } else {
      // 模块顶层 new 时 app 还没就绪（getPath 会抛）。
      // 这里的思路与 quests / subscriptionManager 一致：延后到 app ready，
      // 而不是直接崩掉 —— 那个崩溃曾让 `npm run dev` 完全起不来。
      this._deferUntilAppReady()
    }
  }

  /**
   * 解析落盘路径。app 不可用时退回 cwd（仅在 app 永远不就绪的极端情况下发生）。
   */
  private _resolvePersistPath(explicit?: string): string {
    if (explicit) {return explicit}
    try {
      if (app && typeof app.getPath === 'function') {
        return path.join(app.getPath('userData'), 'async-tasks.json')
      }
    } catch { /* app 未就绪 */ }
    return path.join(process.cwd(), 'async-tasks.json')
  }

  /** 等 app ready 后补上真实路径、加载存量任务并开始定时落盘 */
  private _deferUntilAppReady(): void {
    const run = () => {
      try {
        this._persistPath = this._resolvePersistPath()
        this._load()
        this._startPersistTimer()
        console.log('[AsyncTaskManager] app ready，已启用任务持久化')
      } catch (err: any) {
        console.warn('[AsyncTaskManager] 延迟初始化失败（不影响任务功能）:', err?.message || err)
      }
    }
    try {
      if (app && typeof app.whenReady === 'function') {
        app.whenReady().then(run).catch(() => undefined)
        return
      }
    } catch { /* 极端环境：放弃持久化但不影响使用 */ }
  }

  // ── 提交 ────────────────────────────────────────────────

  /**
   * 提交后台任务（增强版）
   * 
   * @param prompt 任务提示词
   * @param config Agent 配置
   * @param options 可选配置
   * @returns 任务 ID
   */
  submit(prompt: string, config: AgentRunConfig, options: TaskSubmitOptions = {}): string {
    this.idCounter++
    const id = `task-${Date.now()}-${this.idCounter}`
    const task: AsyncTask = {
      id,
      title: options.title || `后台任务 ${this.idCounter}`,
      prompt,
      status: 'queued',
      progress: '排队等待中...',
      progressPercent: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      config,
      tags: options.tags,
      preservedWorkspace: options.workspacePath,
      assignee: options.assignee,
    }

    this.tasks.set(id, task)
    this.queue.push(id)
    this.emit('task:created', task)

    // 尝试启动
    this.tryRunNext()
    return id
  }

  /** 获取任务 */
  get(id: string): AsyncTask | undefined {
    return this.tasks.get(id)
  }

  /** 列出所有任务 */
  list(status?: TaskStatus): AsyncTask[] {
    let tasks = Array.from(this.tasks.values())
    if (status) {
      tasks = tasks.filter(t => t.status === status)
    }
    return tasks.sort((a, b) => b.createdAt - a.createdAt)
  }

  // ── 取消 ────────────────────────────────────────────────

  /**
   * 取消任务（增强版）
   * - 排队中的任务：直接从队列移除
   * - 运行中的任务：调用 runner.abort() 并保留工作区
   */
  cancel(id: string): boolean {
    const task = this.tasks.get(id)
    if (!task || task.status === 'done' || task.status === 'cancelled' || task.status === 'error') {
      return false
    }

    if (task.status === 'queued') {
      this.queue = this.queue.filter(i => i !== id)
      task.status = 'cancelled'
      task.updatedAt = Date.now()
      this._notify(task, '已取消', 0)
      this._persist()
    } else if (task.status === 'running') {
      // 取消运行中的任务
      task.status = 'cancelled'
      task.updatedAt = Date.now()
      task.runner?.abort()
      this.running.delete(id)
      
      // 保留工作区（如果配置了）
      if (task.preservedWorkspace) {
        this._preserveWorkspace(task)
        this._notify(task, '已取消（工作区已保留）', 0)
      } else {
        this._notify(task, '已取消', 0)
      }
      
      this.tryRunNext()
      this._persist()
    }

    return true
  }

  // ── 进度控制 ────────────────────────────────────────────

  /**
   * 获取任务进度
   */
  getProgress(id: string): { progress: string; percent: number } | null {
    const task = this.tasks.get(id)
    if (!task) {return null}
    return { progress: task.progress, percent: task.progressPercent }
  }

  /**
   * 更新任务进度（外部可调用）
   */
  updateProgress(id: string, progress: string, percent: number): void {
    const task = this.tasks.get(id)
    if (!task) {return}
    this._notify(task, progress, percent)
    this._persist()
  }

  // ── 持久化 ──────────────────────────────────────────────

  /** 持久化任务状态到磁盘 */
  private _persist(): void {
    try {
      const dir = path.dirname(this._persistPath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }

      const data = {
        version: '2.0',
        tasks: Array.from(this.tasks.values()).map(t => ({
          id: t.id,
          title: t.title,
          prompt: t.prompt,
          status: t.status,
          progress: t.progress,
          progressPercent: t.progressPercent,
          result: t.result,
          error: t.error,
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
          config: t.config,
          preservedWorkspace: t.preservedWorkspace,
          tags: t.tags,
        })),
        queue: this.queue,
        idCounter: this.idCounter,
      }

      fs.writeFileSync(this._persistPath, JSON.stringify(data, null, 2), 'utf-8')
    } catch (e) {
      console.warn('[AsyncTaskManager] 持久化失败:', e)
    }
  }

  /** 从磁盘加载任务状态 */
  private _load(): void {
    try {
      if (!fs.existsSync(this._persistPath)) {
        return
      }

      const raw = fs.readFileSync(this._persistPath, 'utf-8')
      const data = JSON.parse(raw)

      // 恢复任务（不自动重新运行已失败/取消的任务）
      for (const t of data.tasks || []) {
        if (t.status === 'queued' || t.status === 'running') {
          // 重启后，运行中的任务标记为失败
          t.status = 'error'
          t.error = '应用重启，任务中断'
          t.updatedAt = Date.now()
        }
        this.tasks.set(t.id, t as AsyncTask)
      }

      // 恢复队列（只恢复排队中的任务）
      this.queue = (data.queue || []).filter((id: string) => {
        const task = this.tasks.get(id)
        return task && task.status === 'queued'
      })

      this.idCounter = data.idCounter || 0

      // 尝试运行排队中的任务
      this.tryRunNext()
    } catch (e) {
      console.warn('[AsyncTaskManager] 加载持久化数据失败:', e)
    }
  }

  /** 启动定时持久化 */
  private _startPersistTimer(): void {
    this.persistTimer = setInterval(() => {
      this._persist()
    }, PERSIST_INTERVAL)
  }

  /** 停止持久化定时器 */
  private _stopPersistTimer(): void {
    if (this.persistTimer) {
      clearInterval(this.persistTimer)
      this.persistTimer = undefined
    }
  }

  // ── 内部方法 ────────────────────────────────────────────

  private _notify(task: AsyncTask, progress: string, percent?: number): void {
    task.progress = progress
    if (percent !== undefined) {task.progressPercent = percent}
    task.updatedAt = Date.now()
    this.emit('task:progress', {
      taskId: task.id,
      status: task.status,
      progress,
      progressPercent: task.progressPercent,
      result: task.result,
      error: task.error,
      preservedWorkspace: task.preservedWorkspace,
    } as TaskProgressEvent)
  }

  private tryRunNext(): void {
    while (this.running.size < MAX_CONCURRENT && this.queue.length > 0) {
      const id = this.queue.shift()!
      const task = this.tasks.get(id)
      if (!task || task.status === 'cancelled') {continue}

      this.running.add(id)
      task.status = 'running'
      task.updatedAt = Date.now()
      this._notify(task, '🚀 开始执行...', 5)

      // 异步执行（不等待）
      this._executeTask(task).catch(() => {})
    }
  }

  private async _executeTask(task: AsyncTask): Promise<void> {
    const runner = new AgentRunner(task.config)
    task.runner = runner

    // 监听工具执行事件，更新进度
    runner.setEventCallback((ev) => {
      // v02: 原样转发 runner 事件给任务工作区（工具调用/思考/错误实时可见）
      this.emit('task:runner-event', { taskId: task.id, assignee: task.assignee, event: ev })
      if (ev.type === 'tool_start') {
        this._notify(task, `🔧 ${ev.tool}...`, 30)
      } else if (ev.type === 'tool_end') {
        this._notify(task, `✅ ${ev.tool} (${ev.result?.durationMs}ms)`, 70)
      } else if (ev.type === 'error') {
        this._notify(task, `❌ ${ev.error}`, 0)
      } else if (ev.type === 'thinking') {
        // 思考阶段更新进度
        this._notify(task, `💭 ${ev.text}`, 20)
      }
    })

    try {
      const result: string = await Promise.race([
        runner.sendMessage(task.prompt),
        new Promise<string>((_, reject) => 
          setTimeout(() => reject(new Error('任务超时（10分钟）')), TASK_TIMEOUT)
        )
      ])
      
      task.status = 'done'
      task.result = result
      task.updatedAt = Date.now()
      this._notify(task, '✨ 任务完成', 100)
      this.running.delete(task.id)
      this.emit('task:done', task)
      this._persist()
    } catch (err: any) {
      task.status = 'error'
      task.error = err?.message || String(err)
      task.updatedAt = Date.now()

      // 失败时保留工作区
      if (task.preservedWorkspace) {
        this._preserveWorkspace(task)
        this._notify(task, `❌ 错误: ${err.message}（工作区已保留）`, 0)
      } else {
        this._notify(task, `❌ 错误: ${err.message}`, 0)
      }

      this.running.delete(task.id)
      this.emit('task:error', task)
      this._persist()
    }

    this.tryRunNext()
  }

  /**
   * 保留工作区（失败时）
   */
  private _preserveWorkspace(task: AsyncTask): void {
    if (!task.preservedWorkspace) {return}

    try {
      const preservedDir = path.join(task.preservedWorkspace, `.preserved-${task.id}`)
      if (!fs.existsSync(preservedDir)) {
        fs.mkdirSync(preservedDir, { recursive: true })
      }

      // 复制工作区关键文件
      const filesToPreserve = [
        'workspace.json',
        'memory.json',
        'MEMORY.md',
        'config.json',
      ]

      for (const file of filesToPreserve) {
        const src = path.join(task.preservedWorkspace, file)
        if (fs.existsSync(src)) {
          const dest = path.join(preservedDir, file)
          fs.copyFileSync(src, dest)
        }
      }

      // 保存错误信息
      const errorInfo = {
        taskId: task.id,
        error: task.error,
        timestamp: Date.now(),
        prompt: task.prompt.slice(0, 500),
      }
      fs.writeFileSync(
        path.join(preservedDir, 'error-info.json'),
        JSON.stringify(errorInfo, null, 2),
        'utf-8'
      )

      console.log(`[AsyncTaskManager] 工作区已保留到: ${preservedDir}`)
    } catch (e) {
      console.warn('[AsyncTaskManager] 保留工作区失败:', e)
    }
  }

  /** 销毁管理器（停止定时器） */
  destroy(): void {
    this._stopPersistTimer()
    this._persist()
  }
}

// ═══════════════════════════════════════════════════════════
// 单例
// ═══════════════════════════════════════════════════════════

export const taskManager = new AsyncTaskManager()

/** 获取 AsyncTaskManager 单例 */
export function getAsyncTaskManager(): AsyncTaskManager {
  return taskManager
}
