// ============================================================
// orchestration/taskBoard.ts — 任务 DAG 看板 (v2.0)
//
// v2.0 新增：
//   - 实习生分配跟踪（assignIntern / getInternTasks）
//   - 并行执行状态（parallelGroup / parallelPhase）
//   - 自动实习生调度（autoAssignInterns）
//   - 执行进度可视化（getProgressReport）
//   - Yak 视角的看板概览（getYakBoardView — 旧角色命名的遗留方法名，内容与角色无关）
//
// v1.0 基础能力：
//   - 任务分解（父→子任务）
//   - 依赖关系（DAG）
//   - 并行检测（无依赖的 Task 可同时执行）
//   - 状态跟踪（pending → running → done / failed）
//   - 自动检测卡点（blocked tasks）
// ============================================================

// ═══════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════

export type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'blocked'
export type TaskPriority = 'low' | 'normal' | 'high' | 'critical'

export interface TaskNode {
  /** 唯一 ID */
  id: string
  /** 所属项目/主任务 ID */
  projectId: string
  /** 任务标题 */
  title: string
  /** 详细描述（给执行者/默认给 Yak 的任务描述） */
  description: string
  /** 状态 */
  status: TaskStatus
  /** 优先级 */
  priority: TaskPriority
  /** 依赖的任务 ID 列表（必须先完成这些） */
  dependsOn: string[]
  /** 分配给谁（'yak' Yak=程序员执行 / 'recha' 热茶=审查 / 'lumina' 老大） */
  assignTo: 'yak' | 'lumina' | 'recha'
  /** 🆕 v2.0: 分配给哪个实习生（intern_xxx ID，非空时表示走实习生模式） */
  assignIntern: string | null
  /** 🆕 v2.0: 所属并行阶段编号（0=未分配，1=阶段1，2=阶段2…） */
  parallelPhase: number
  /** 🆕 v2.0: 同阶段内的并行组编号 */
  parallelGroup: number
  /** 输出/结果摘要 */
  result: string | null
  /** 错误信息 */
  error: string | null
  /** 创建时间 */
  createdAt: string
  /** 开始时间 */
  startedAt: string | null
  /** 完成时间 */
  completedAt: string | null
  /** 耗时 ms */
  elapsedMs: number | null
  /** 重试次数 */
  retryCount: number
}

export interface TaskProject {
  /** 项目 ID */
  id: string
  /** 项目名称 */
  name: string
  /** 原始用户请求 */
  originalRequest: string
  /** 任务列表 */
  tasks: TaskNode[]
  /** 项目状态 */
  status: 'planning' | 'executing' | 'verifying' | 'reviewing' | 'done' | 'failed'
  /** 复杂度分析结果 */
  complexity: 'simple' | 'complex'
  /** 当前阶段 */
  currentPhase: string | null
  /** 🆕 v2.0: 并行执行模式 */
  parallelMode: boolean
  /** 🆕 v2.0: 本次招的实习生 ID 列表 */
  hiredInterns: string[]
  /** 创建时间 */
  createdAt: string
  /** 完成时间 */
  completedAt: string | null
  /** 最终输出 */
  finalResult: string | null
}

// ═══════════════════════════════════════════════════════════
// TaskBoard
// ═══════════════════════════════════════════════════════════

export class TaskBoard {
  private projects: Map<string, TaskProject> = new Map()

  // ═══ 项目管理 ═══

  /**
   * 创建新项目
   */
  createProject(
    name: string,
    originalRequest: string,
    complexity: 'simple' | 'complex',
  ): TaskProject {
    const id = `proj-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const project: TaskProject = {
      id,
      name,
      originalRequest,
      tasks: [],
      status: 'planning',
      complexity,
      currentPhase: null,
      parallelMode: false,
      hiredInterns: [],
      createdAt: new Date().toISOString(),
      completedAt: null,
      finalResult: null,
    }
    this.projects.set(id, project)
    return project
  }

  /**
   * 获取项目
   */
  getProject(id: string): TaskProject | undefined {
    return this.projects.get(id)
  }

  /**
   * 获取所有项目
   */
  getAllProjects(): TaskProject[] {
    return Array.from(this.projects.values())
  }

  /**
   * 删除项目
   */
  deleteProject(id: string): boolean {
    return this.projects.delete(id)
  }

  /**
   * 更新项目阶段
   */
  setProjectPhase(id: string, phase: string): void {
    const project = this.projects.get(id)
    if (!project) {return}
    project.currentPhase = phase
  }

  /**
   * 更新项目状态
   */
  setProjectStatus(id: string, status: TaskProject['status']): void {
    const project = this.projects.get(id)
    if (!project) {return}
    project.status = status
    if (status === 'done' || status === 'failed') {
      project.completedAt = new Date().toISOString()
    }
  }

  /**
   * 设置最终结果
   */
  setFinalResult(id: string, result: string): void {
    const project = this.projects.get(id)
    if (!project) {return}
    project.finalResult = result
    project.status = 'done'
    project.completedAt = new Date().toISOString()
  }

  // ═══ 任务管理 ═══

  /**
   * 添加任务到项目
   */
  addTask(
    projectId: string,
    title: string,
    description: string,
    options?: {
      dependsOn?: string[]
      assignTo?: TaskNode['assignTo']
      priority?: TaskPriority
      assignIntern?: string | null
      parallelPhase?: number
      parallelGroup?: number
    },
  ): TaskNode | null {
    const project = this.projects.get(projectId)
    if (!project) {return null}

    const id = `${projectId}-task-${project.tasks.length + 1}`
    const task: TaskNode = {
      id,
      projectId,
      title,
      description,
      status: 'pending',
      priority: options?.priority || 'normal',
      dependsOn: options?.dependsOn || [],
      // ⚠️ 默认执行者是 yak（Yak，代码工程师）——它才是有写权限/执行权的一方。
      //    历史上默认是 'recha'，而现在的 recha 只能读，等于默认派给了一个干不了活的角色。
      assignTo: options?.assignTo || 'yak',
      assignIntern: options?.assignIntern ?? null,
      parallelPhase: options?.parallelPhase ?? 0,
      parallelGroup: options?.parallelGroup ?? 0,
      result: null,
      error: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      elapsedMs: null,
      retryCount: 0,
    }
    project.tasks.push(task)
    return task
  }

  /**
   * 批量添加任务
   */
  addTasks(projectId: string, tasks: Array<{
    title: string
    description: string
    dependsOn?: string[]
    assignTo?: TaskNode['assignTo']
    priority?: TaskPriority
    assignIntern?: string | null
    parallelPhase?: number
    parallelGroup?: number
  }>): TaskNode[] {
    return tasks
      .map(t => this.addTask(projectId, t.title, t.description, {
        dependsOn: t.dependsOn,
        assignTo: t.assignTo,
        priority: t.priority,
        assignIntern: t.assignIntern,
        parallelPhase: t.parallelPhase,
        parallelGroup: t.parallelGroup,
      }))
      .filter((t): t is TaskNode => t !== null)
  }

  /**
   * 获取项目下的所有任务
   */
  getTasks(projectId: string): TaskNode[] {
    return this.projects.get(projectId)?.tasks || []
  }

  /**
   * 获取任务
   */
  getTask(taskId: string): TaskNode | undefined {
    for (const project of this.projects.values()) {
      const task = project.tasks.find(t => t.id === taskId)
      if (task) {return task}
    }
    return undefined
  }

  /**
   * 更新任务状态
   */
  updateTaskStatus(taskId: string, status: TaskStatus, meta?: {
    result?: string
    error?: string
    elapsedMs?: number
  }): void {
    const task = this.getTask(taskId)
    if (!task) {return}

    task.status = status

    if (status === 'running' && !task.startedAt) {
      task.startedAt = new Date().toISOString()
    }

    if (status === 'done' || status === 'failed') {
      task.completedAt = new Date().toISOString()
      if (meta?.result) {task.result = meta.result}
      if (meta?.error) {task.error = meta.error}
      if (meta?.elapsedMs !== undefined) {task.elapsedMs = meta.elapsedMs}
    }

    // 更新阻塞检测
    this._updateBlockedTasks(task.projectId)
  }

  /**
   * 增加任务重试计数
   */
  incrementRetry(taskId: string): void {
    const task = this.getTask(taskId)
    if (task) {task.retryCount++}
  }

  // ═══════════════════════════════════════════════════════════
  // 实习生分配
  // ═══════════════════════════════════════════════════════════

  /**
   * 给任务分配实习生
   */
  assignIntern(taskId: string, internId: string): boolean {
    const task = this.getTask(taskId)
    if (!task) {return false}
    task.assignIntern = internId
    return true
  }

  /**
   * 批量分配实习生给一组任务
   */
  assignInterns(assignments: Array<{ taskId: string; internId: string }>): number {
    let count = 0
    for (const { taskId, internId } of assignments) {
      if (this.assignIntern(taskId, internId)) {count++}
    }
    return count
  }

  /**
   * 开启项目的并行模式
   */
  enableParallelMode(projectId: string, hiredInterns: string[]): void {
    const project = this.projects.get(projectId)
    if (!project) {return}
    project.parallelMode = true
    project.hiredInterns = hiredInterns
  }

  /**
   * 自动分配实习生给可并行执行的任务
   * 按 parallelPhase 分组，每组内轮询分配实习生
   */
  autoAssignInterns(projectId: string): void {
    const project = this.projects.get(projectId)
    if (!project) {return}

    const interns = project.hiredInterns
    if (interns.length === 0) {return}

    // 按阶段分组
    const phases = new Map<number, TaskNode[]>()
    for (const task of project.tasks) {
      if (task.status !== 'pending') {continue}
      if (task.assignIntern) {continue} // 已分配
      const phase = task.parallelPhase || 1
      if (!phases.has(phase)) {phases.set(phase, [])}
      phases.get(phase)!.push(task)
    }

    // 每阶段内轮询分配
    for (const [, tasks] of phases) {
      let internIdx = 0
      for (const task of tasks) {
        task.assignIntern = interns[internIdx % interns.length]
        internIdx++
      }
    }
  }

  /**
   * 获取指定实习生在一段时间内的所有任务
   */
  getInternTasks(internId: string, projectId?: string): TaskNode[] {
    const allTasks: TaskNode[] = []
    const projects = projectId
      ? [this.projects.get(projectId)].filter(Boolean) as TaskProject[]
      : Array.from(this.projects.values())

    for (const project of projects) {
      for (const task of project.tasks) {
        if (task.assignIntern === internId) {
          allTasks.push(task)
        }
      }
    }
    return allTasks
  }

  // ═══ 依赖与并行 ═══

  /**
   * 获取 ready 状态的任务（依赖都已完成）
   * 这些任务可以并行执行
   */
  getReadyTasks(projectId: string): TaskNode[] {
    const project = this.projects.get(projectId)
    if (!project) {return []}

    return project.tasks.filter(task => {
      if (task.status !== 'pending') {return false}
      // 检查所有依赖是否都已完成
      return task.dependsOn.every(depId => {
        const depTask = this.getTask(depId)
        return depTask?.status === 'done'
      })
    })
  }

  /**
   * 获取可以并行执行的任务组
   * 返回多个组，每组内的任务可并行
   */
  getParallelGroups(projectId: string): TaskNode[][] {
    const project = this.projects.get(projectId)
    if (!project) {return []}

    // 构建 DAG
    const pending = project.tasks.filter(t => t.status === 'pending')
    if (pending.length === 0) {return []}

    const groups: TaskNode[][] = []
    let remaining = [...pending]

    while (remaining.length > 0) {
      const ready = remaining.filter(t =>
        t.dependsOn.every(d => {
          const dep = this.getTask(d)
          return !dep || dep.status === 'done'
        })
      )
      if (ready.length === 0) {break} // 死锁
      groups.push(ready)
      remaining = remaining.filter(t => !ready.includes(t))
    }

    return groups
  }

  /**
   * 🆕 v2.0: 按 parallelPhase 分组
   * 当使用预处理阶段分配时，直接按 parallelPhase 返回有序组
   */
  getParallelPhaseGroups(projectId: string): TaskNode[][] {
    const project = this.projects.get(projectId)
    if (!project) {return []}

    const phaseMap = new Map<number, TaskNode[]>()
    for (const task of project.tasks) {
      if (task.status !== 'pending' && task.status !== 'running') {continue}
      const phase = task.parallelPhase || 0
      if (!phaseMap.has(phase)) {phaseMap.set(phase, [])}
      phaseMap.get(phase)!.push(task)
    }

    // 按 phase 序号排序
    const sortedPhases = Array.from(phaseMap.keys()).sort((a, b) => a - b)
    return sortedPhases.map(p => phaseMap.get(p)!)
  }

  /**
   * 🆕 v2.0: 获取实习生视角的看板
   */
  getInternBoardView(internId: string): {
    assigned: TaskNode[]
    done: TaskNode[]
    failed: TaskNode[]
  } {
    const tasks = this.getInternTasks(internId)
    return {
      assigned: tasks.filter(t => t.status === 'pending' || t.status === 'running'),
      done: tasks.filter(t => t.status === 'done'),
      failed: tasks.filter(t => t.status === 'failed'),
    }
  }

  /**
   * 🆕 v2.0: 获取「程序员视角」的项目看板概览
   *
   * ⚠️ 历史遗留命名：方法名 getYakBoardView 里的 "Yak" 是旧角色口径留下的，
   * 导出名保持不变（对外 API 稳定性优先），实际内容与角色无关，纯看板渲染。
   */
  getYakBoardView(projectId: string): string {
    const project = this.projects.get(projectId)
    if (!project) {return '项目不存在'}

    const lines: string[] = [
      `📋 ${project.name}（${project.status}）`,
      `   复杂度: ${project.complexity}  |  并行模式: ${project.parallelMode ? '✅' : '❌'}`,
      `   实习生: ${project.hiredInterns.length > 0 ? project.hiredInterns.join(', ') : '未招'}`,
      ``,
      `   任务列表:`,
    ]

    for (const task of project.tasks) {
      const statusIcon = {
        pending: '⏳',
        running: '🔄',
        done: '✅',
        failed: '❌',
        blocked: '🚫',
      }[task.status]
      const internLabel = task.assignIntern ? `[${task.assignIntern}]` : ''
      const phaseLabel = task.parallelPhase > 0 ? `(#阶段${task.parallelPhase})` : ''
      lines.push(`   ${statusIcon} ${task.title} ${internLabel} ${phaseLabel}`)
    }

    // 统计
    const done = project.tasks.filter(t => t.status === 'done').length
    const failed = project.tasks.filter(t => t.status === 'failed').length
    const total = project.tasks.length
    lines.push(``)
    lines.push(`   进度: ${done}/${total} | 失败: ${failed} | ${total > 0 ? Math.round(done / total * 100) : 0}%`)

    return lines.join('\n')
  }

  /**
   * 🆕 v2.0: 获取项目进度报告（JSON 格式，供 UI 使用）
   */
  getProgressReport(projectId: string): {
    total: number
    done: number
    failed: number
    running: number
    pending: number
    blocked: number
    percent: number
  } | null {
    const project = this.projects.get(projectId)
    if (!project) {return null}

    const tasks = project.tasks
    const total = tasks.length
    const done = tasks.filter(t => t.status === 'done').length
    const failed = tasks.filter(t => t.status === 'failed').length
    const running = tasks.filter(t => t.status === 'running').length
    const pending = tasks.filter(t => t.status === 'pending').length
    const blocked = tasks.filter(t => t.status === 'blocked').length

    return {
      total,
      done,
      failed,
      running,
      pending,
      blocked,
      percent: total > 0 ? Math.round(done / total * 100) : 0,
    }
  }

  /**
   * 检测死锁（循环依赖）
   */
  detectDeadlocks(projectId: string): string[][] {
    const project = this.projects.get(projectId)
    if (!project) {return []}

    const deadlocks: string[][] = []
    const visited = new Set<string>()
    const recursionStack = new Set<string>()

    const dfs = (taskId: string, path: string[]) => {
      if (recursionStack.has(taskId)) {
        // 找到环
        const cycleStart = path.indexOf(taskId)
        if (cycleStart >= 0) {
          deadlocks.push([...path.slice(cycleStart), taskId])
        }
        return
      }
      if (visited.has(taskId)) {return}

      visited.add(taskId)
      recursionStack.add(taskId)

      const task = this.getTask(taskId)
      if (task) {
        for (const depId of task.dependsOn) {
          if (this.getTask(depId)) {
            dfs(depId, [...path, taskId])
          }
        }
      }

      recursionStack.delete(taskId)
    }

    for (const task of project.tasks) {
      dfs(task.id, [])
    }

    return deadlocks
  }

  /**
   * 检测卡点（blocked 任务 → 依赖方也变 blocked）
   */
  detectBlockedChains(projectId: string): string[] {
    const project = this.projects.get(projectId)
    if (!project) {return []}

    const blockedTasks: string[] = []

    // 找到所有 failed 任务
    const failedIds = new Set(
      project.tasks.filter(t => t.status === 'failed').map(t => t.id),
    )

    // 依赖 failed 的任务也是 blocked
    for (const task of project.tasks) {
      if (task.dependsOn.some(d => failedIds.has(d))) {
        task.status = 'blocked'
        blockedTasks.push(task.id)
      }
    }

    return blockedTasks
  }

  /**
   * 获取指定人的待办任务
   */
  getTasksByAssignee(projectId: string, assignee: TaskNode['assignTo']): TaskNode[] {
    const project = this.projects.get(projectId)
    if (!project) {return []}
    return project.tasks.filter(
      t => t.assignTo === assignee && (t.status === 'pending' || t.status === 'running'),
    )
  }

  /**
   * 清除所有数据
   */
  clear(): void {
    this.projects.clear()
  }

  // ═══ 内部 ═══

  private _updateBlockedTasks(projectId: string): void {
    const project = this.projects.get(projectId)
    if (!project) {return}

    // 检查依赖是否完成
    for (const task of project.tasks) {
      if (task.status === 'pending') {
        const hasFailedDep = task.dependsOn.some(depId => {
          const dep = this.getTask(depId)
          return dep && dep.status === 'failed'
        })
        if (hasFailedDep) {
          (task.status as TaskStatus) = 'blocked'
        }
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════
// 单例
// ═══════════════════════════════════════════════════════════

let _instance: TaskBoard | null = null

export function getTaskBoard(): TaskBoard {
  if (!_instance) {_instance = new TaskBoard()}
  return _instance
}

export function initTaskBoard(): TaskBoard {
  _instance = new TaskBoard()
  return _instance
}
