// ============================================================
// asyncTaskManager.ts — 异步后台任务管理器
//
// 借鉴 TaskManager 设计：
//   1. 提交即返回，不阻塞主对话
//   2. 最多 3 个并发后台任务
//   3. 进度/完成通知通过 IPC 推到渲染进程
//   4. 子任务不继承父对话历史（隔离上下文）
// ============================================================

import { EventEmitter } from 'events'
import { AgentRunner } from './agentRunner'
import type { AgentRunConfig } from './tools/types'

// ── 类型 ──────────────────────────────────────────────────

export type TaskStatus = 'pending' | 'running' | 'done' | 'error' | 'cancelled'

export interface AsyncTask {
  id: string
  title: string
  prompt: string
  status: TaskStatus
  progress: string
  result?: string
  error?: string
  createdAt: number
  config: AgentRunConfig
}

export interface TaskProgressEvent {
  taskId: string
  status: TaskStatus
  progress: string
  result?: string
  error?: string
}

// ── 常量 ──────────────────────────────────────────────────

const MAX_CONCURRENT = 3

// ============================================================
// AsyncTaskManager
// ============================================================

export class AsyncTaskManager extends EventEmitter {
  private tasks = new Map<string, AsyncTask>()
  private queue: string[] = []    // 等待队列
  private running = new Set<string>()  // 正在运行
  private idCounter = 0

  /** 提交任务 → 立即返回 taskId */
  submit(title: string, prompt: string, config: AgentRunConfig): string {
    const id = `task-${++this.idCounter}-${Date.now()}`
    const task: AsyncTask = {
      id, title, prompt,
      status: 'pending',
      progress: '排队等待中...',
      createdAt: Date.now(),
      config,
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
  list(): AsyncTask[] {
    return Array.from(this.tasks.values())
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  /** 取消任务 */
  cancel(id: string): boolean {
    const task = this.tasks.get(id)
    if (!task) return false

    if (task.status === 'pending') {
      this.queue = this.queue.filter((i) => i !== id)
      task.status = 'cancelled'
      this._notify(task, '已取消')
    } else if (task.status === 'running') {
      task.status = 'cancelled'
      this.running.delete(id)
      this._notify(task, '已取消')
      this.tryRunNext()
    }
    return true
  }

  // ── 内部 ─────────────────────────────────────────────

  private _notify(task: AsyncTask, progress: string): void {
    task.progress = progress
    this.emit('task:progress', {
      taskId: task.id,
      status: task.status,
      progress,
      result: task.result,
      error: task.error,
    } as TaskProgressEvent)
  }

  private async tryRunNext(): Promise<void> {
    while (this.running.size < MAX_CONCURRENT && this.queue.length > 0) {
      const id = this.queue.shift()!
      const task = this.tasks.get(id)
      if (!task || task.status === 'cancelled') continue

      this.running.add(id)
      task.status = 'running'
      this._notify(task, '🚀 开始执行...')

      // 异步执行（不等待）
      this._executeTask(task).catch(() => {})
    }
  }

  private async _executeTask(task: AsyncTask): Promise<void> {
    const runner = new AgentRunner(task.config)

    runner.setEventCallback((ev) => {
      if (ev.type === 'tool_start') {
        this._notify(task, `🔧 ${ev.tool}...`)
      } else if (ev.type === 'tool_end') {
        this._notify(task, `✅ ${ev.tool} (${ev.result?.durationMs}ms)`)
      } else if (ev.type === 'error') {
        this._notify(task, `❌ ${ev.error}`)
      }
    })

    try {
      const result = await runner.sendMessage(task.prompt)
      task.status = 'done'
      task.result = result
      this._notify(task, '✨ 任务完成')
      this.running.delete(task.id)
      this.emit('task:done', task)
    } catch (err: any) {
      task.status = 'error'
      task.error = err.message
      this._notify(task, `❌ 错误: ${err.message}`)
      this.running.delete(task.id)
    }

    this.tryRunNext()
  }
}

// ── 单例 ──────────────────────────────────────────────────

export const taskManager = new AsyncTaskManager()
