// ============================================================
// agentTeamContext.ts — 团队共享上下文管理器 (v3.0)
//
// 解决的问题：
//   1. 每个 agent 不知道其他人在做什么 → 共享任务面板
//   2. 委托结果丢失 → 委托日志
//   3. 项目上下文碎片化 → 项目上下文卡片
//
// 设计理念：
//   - 像一个团队共享的白板，每个人都有读写权限
//   - 自动记录委托历史，供所有 agent 查阅
//   - 项目级别的上下文卡片（语言、框架、关键文件等）
// ============================================================

// ═══════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════

export interface TeamTask {
  id: string
  title: string
  description: string
  status: 'todo' | 'in_progress' | 'done' | 'blocked'
  assignedTo: string
  createdBy: string
  createdAt: number
  updatedAt: number
  result?: string
  dependencies: string[]
}

export interface DelegationLog {
  id: string
  fromAgent: string
  toAgent: string
  task: string
  result: string
  success: boolean
  timestamp: number
  durationMs: number
}

export interface ProjectContext {
  /** 项目名称 */
  name: string
  /** 项目描述 */
  description: string
  /** 编程语言 */
  languages: string[]
  /** 框架 */
  frameworks: string[]
  /** 关键文件路径 */
  keyFiles: string[]
  /** 当前阶段 */
  phase: string
  /** 注意事项（agent 共享的"不要踩的坑"） */
  gotchas: string[]
  /** 最近更新 */
  lastUpdated: number
}

export interface TeamContext {
  /** 项目上下文 */
  project: ProjectContext | null
  /** 活跃任务 */
  tasks: TeamTask[]
  /** 最近的委托记录（最多 20 条） */
  delegationLogs: DelegationLog[]
  /** 团队公告（任何一个 agent 都可以发布） */
  announcements: string[]
}

// ═══════════════════════════════════════════════════════════
// 团队上下文管理器
// ═══════════════════════════════════════════════════════════

export class TeamContextManager {
  private context: TeamContext = {
    project: null,
    tasks: [],
    delegationLogs: [],
    announcements: [],
  }

  // ── 项目上下文 ──────────────────────────────────

  /** 获取上下文摘要（兼容旧接口） */
  getContext(): string | null {
    if (!this.context.project) return null
    return JSON.stringify(this.context.project, null, 2)
  }

  setProject(ctx: ProjectContext): void {
    this.context.project = { ...ctx, lastUpdated: Date.now() }
  }

  getProject(): ProjectContext | null {
    return this.context.project
  }

  updateProject(update: Partial<ProjectContext>): void {
    if (this.context.project) {
      this.context.project = {
        ...this.context.project,
        ...update,
        lastUpdated: Date.now(),
      }
    }
  }

  /** 自动检测项目上下文 */
  detectProject(): string {
    if (!this.context.project) {
      return '未设置项目上下文。可以用 set_project_context 设置。'
    }

    const p = this.context.project
    return `【当前项目】${p.name}
描述：${p.description}
技术栈：${p.languages.join(', ')}${p.frameworks.length ? ' + ' + p.frameworks.join(', ') : ''}
阶段：${p.phase}
关键文件：${p.keyFiles.join(', ')}
注意事项：${p.gotchas.join('; ') || '无'}`.trim()
  }

  // ── 任务管理 ────────────────────────────────────

  addTask(task: Omit<TeamTask, 'id' | 'createdAt' | 'updatedAt'>): TeamTask {
    const full: TeamTask = {
      ...task,
      id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    this.context.tasks.push(full)
    return full
  }

  updateTaskStatus(taskId: string, status: TeamTask['status'], result?: string): boolean {
    const task = this.context.tasks.find((t) => t.id === taskId)
    if (!task) return false
    task.status = status
    task.updatedAt = Date.now()
    if (result) task.result = result
    return true
  }

  getTasks(filter?: { agentId?: string; status?: TeamTask['status'] }): TeamTask[] {
    let tasks = this.context.tasks
    if (filter?.agentId) tasks = tasks.filter((t) => t.assignedTo === filter.agentId)
    if (filter?.status) tasks = tasks.filter((t) => t.status === filter.status)
    return tasks
  }

  /** 获取团队任务面板的文本摘要 */
  getTaskBoard(): string {
    if (this.context.tasks.length === 0) return '暂无团队任务。'

    const todo = this.context.tasks.filter((t) => t.status === 'todo')
    const inProgress = this.context.tasks.filter((t) => t.status === 'in_progress')
    const blocked = this.context.tasks.filter((t) => t.status === 'blocked')
    const done = this.context.tasks.filter((t) => t.status === 'done')

    let board = '【团队任务面板】\n'
    if (inProgress.length) {
      board += '\n🚧 进行中：\n'
      board += inProgress.map((t) => `  - [${t.assignedTo}] ${t.title}`).join('\n')
    }
    if (blocked.length) {
      board += '\n🚫 阻塞：\n'
      board += blocked.map((t) => `  - [${t.assignedTo}] ${t.title}`).join('\n')
    }
    if (todo.length) {
      board += '\n📋 待办：\n'
      board += todo.map((t) => `  - [${t.assignedTo}] ${t.title}`).join('\n')
    }
    if (done.length) {
      board += `\n\n✅ 已完成 ${done.length} 个任务`
    }

    return board.trim()
  }

  // ── 委托日志 ────────────────────────────────────

  logDelegation(
    from: string,
    to: string,
    task: string,
    result: string,
    success = true,
    durationMs = 0
  ): void {
    this.context.delegationLogs.push({
      id: `del-${Date.now()}`,
      fromAgent: from,
      toAgent: to,
      task,
      result: result.slice(0, 500), // 截断存储
      success,
      timestamp: Date.now(),
      durationMs,
    })

    // 保留最近 20 条
    if (this.context.delegationLogs.length > 20) {
      this.context.delegationLogs = this.context.delegationLogs.slice(-20)
    }
  }

  getRecentDelegations(limit = 5): string {
    const logs = this.context.delegationLogs.slice(-limit)
    if (logs.length === 0) return '暂无委托记录。'

    return (
      '【最近委托记录】\n' +
      logs
        .map(
          (l) =>
            `  ${l.success ? '✅' : '❌'} ${l.fromAgent} → ${l.toAgent}: ${l.task.slice(0, 80)}${l.task.length > 80 ? '...' : ''}`
        )
        .join('\n')
    )
  }

  // ── 公告 ────────────────────────────────────────

  addAnnouncement(agentId: string, message: string): void {
    this.context.announcements.push(
      `[${new Date().toLocaleTimeString()}] ${agentId}: ${message}`
    )
    if (this.context.announcements.length > 10) {
      this.context.announcements = this.context.announcements.slice(-10)
    }
  }

  getAnnouncements(): string {
    if (this.context.announcements.length === 0) return ''
    return '【团队公告】\n' + this.context.announcements.map((a) => `  ${a}`).join('\n')
  }

  // ── 完整上下文快照 ──────────────────────────────

  /**
   * 获取完整团队上下文（供 team_context 工具返回）
   */
  getFullContext(): string {
    const parts: string[] = []

    // 项目上下文
    if (this.context.project) {
      parts.push(this.detectProject())
    }

    // 任务面板
    const board = this.getTaskBoard()
    if (board !== '暂无团队任务。') {
      parts.push(board)
    }

    // 委托记录
    const logs = this.getRecentDelegations(3)
    if (logs !== '暂无委托记录。') {
      parts.push(logs)
    }

    // 公告
    const announcements = this.getAnnouncements()
    if (announcements) {
      parts.push(announcements)
    }

    return parts.join('\n\n') || '团队上下文为空。设置项目上下文以获得更好的协作体验。'
  }
}

// ═══════════════════════════════════════════════════════════
// 单例（垫片 → 委派给 AgentOrchestrator）
// ═══════════════════════════════════════════════════════════

let _teamContext: TeamContextManager | null = null

export function getTeamContextManager(): TeamContextManager {
  // 优先从 orchestrator 返回
  try {
    const { getOrchestrator } = require('./core/agentOrchestrator')
    const orch = getOrchestrator()
    if (orch.teamContext) return orch.teamContext
  } catch {}
  if (!_teamContext) _teamContext = new TeamContextManager()
  return _teamContext
}

// ═══════════════════════════════════════════════════════════
// team_context 工具定义
// ═══════════════════════════════════════════════════════════

export const TEAM_CONTEXT_TOOL = {
  name: 'team_context',
  description:
    '查看团队的共享上下文：项目信息、任务进度、最近的委托记录、团队公告。\n' +
    '在开始新任务前，建议先调用此工具了解团队当前状态。',
  params: {},
}

export const SET_PROJECT_CONTEXT_TOOL = {
  name: 'set_project_context',
  description:
    '设置或更新团队的项目上下文。这会让所有队友了解当前在做什么项目。',
  params: {
    name: { type: 'string', description: '项目名称', required: true },
    description: { type: 'string', description: '项目简要描述', required: false },
    languages: { type: 'string', description: '编程语言，逗号分隔（如 "Python,TypeScript"）', required: false },
    frameworks: { type: 'string', description: '框架，逗号分隔（如 "React,FastAPI"）', required: false },
    keyFiles: { type: 'string', description: '关键文件路径，逗号分隔', required: false },
    phase: { type: 'string', description: '当前阶段（如 "开发中"/"测试"/"已上线"）', required: false },
    gotchas: { type: 'string', description: '注意事项，逗号分隔', required: false },
  },
}
