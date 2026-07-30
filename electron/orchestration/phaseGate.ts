// ============================================================
// orchestration/phaseGate.ts — 阶段门控状态机 (v1.0)
//
// 复杂任务的五阶段执行流程：
//   Research → Plan → Execute → Verify → Review
//
// 设计：
//   - 每个阶段有明确的准入/准出条件
//   - 阶段间通过任务看板（TaskBoard）传递工作产物
//   - 支持动态跳过（如不需要 Research 可直达 Execute）
//   - 并行阶段支持（多个无依赖的子任务同时执行）
// ============================================================

import type { TaskNode, TaskProject } from './taskBoard'
import { getTaskBoard } from './taskBoard'

// ═══════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════

export type PhaseName = 'research' | 'plan' | 'execute' | 'verify' | 'review'

/** 阶段执行选项 */
export interface PhaseOptions {
  /** 项目 ID（由 TaskBoard 创建） */
  projectId: string
  /** 原始任务描述 */
  task: string
  /** 是否启用自动验证 */
  enableVerify?: boolean
  /** 是否启用代码审查 */
  enableReview?: boolean
  /** 验证命令 */
  verifyCommands?: string[]
  /** 委托函数（由 DelegationManager 注入） */
  delegateFn?: (to: string, task: string, taskType: string) => Promise<{ success: boolean; content: string }>
}

/** 阶段执行结果 */
export interface PhaseResult {
  phase: PhaseName
  success: boolean
  output: string
  error: string | null
  elapsedMs: number
  /** 产出物（任务 ID 列表） */
  artifacts: string[]
}

/** 门控全景结果 */
export interface GateResult {
  success: boolean
  content: string
  error: string | null
  phaseResults: PhaseResult[]
  totalElapsedMs: number
}

// ═══════════════════════════════════════════════════════════
// 阶段定义
// ═══════════════════════════════════════════════════════════

export interface PhaseDef {
  name: PhaseName
  label: string
  icon: string
  description: string
  /** 该阶段的准入条件（返回 true 才执行） */
  checkGate: (project: TaskProject) => boolean
}

export const PHASES: Record<PhaseName, PhaseDef> = {
  research: {
    name: 'research',
    label: '调研',
    icon: '🔍',
    description: '阅读相关文件、搜索资料、了解现状与依赖项',
    checkGate: (project) => project.originalRequest.length > 100 || /研究|调研|分析|比较|对比|依赖|第三方/i.test(project.originalRequest),
  },
  plan: {
    name: 'plan',
    label: '规划',
    icon: '📋',
    description: '将任务分解为子任务，建立依赖 DAG',
    checkGate: (project) => project.tasks.filter(t => t.status === 'pending').length > 3,
  },
  execute: {
    name: 'execute',
    label: '执行',
    icon: '⚡',
    description: '按任务 DAG 依次/并行执行代码编写',
    checkGate: () => true, // 总是需要执行
  },
  verify: {
    name: 'verify',
    label: '验证',
    icon: '🧪',
    description: '自动编译/测试/类型检查，失败自动修复循环',
    checkGate: (project) => project.tasks.some(t => t.status === 'done' && t.assignTo === 'yak'),
  },
  review: {
    name: 'review',
    label: '审查',
    icon: '👁️',
    description: '由热茶进行代码审查，输出改进建议',
    checkGate: (project) => project.tasks.filter(t => t.status === 'done').length >= 2,
  },
}

// ═══════════════════════════════════════════════════════════
// PhaseGate 门控编排器
// ═══════════════════════════════════════════════════════════

export class PhaseGate {
  private _aborted: boolean = false

  /**
   * 执行完整的五阶段门控流程
   *
   * @param phases - 要执行的阶段列表（自动根据复杂度选择）
   * @param options - 执行选项
   */
  async execute(
    phases: PhaseName[],
    options: PhaseOptions,
  ): Promise<GateResult> {
    this._aborted = false
    const allResults: PhaseResult[] = []
    const start = Date.now()

    for (const phase of phases) {
      if (this._aborted) break

      const phaseDef = PHASES[phase]
      const project = getTaskBoard().getProject(options.projectId)
      if (!project) {
        return {
          success: false,
          content: '',
          error: `项目 ${options.projectId} 不存在`,
          phaseResults: allResults,
          totalElapsedMs: Date.now() - start,
        }
      }

      // 检查准入条件
      if (!phaseDef.checkGate(project)) {
        console.log(`[PhaseGate] ⏭️ 跳过阶段 ${phaseDef.icon} ${phaseDef.label}（条件不满足）`)
        continue
      }

      console.log(`[PhaseGate] 🚀 进入阶段 ${phaseDef.icon} ${phaseDef.label}`)
      getTaskBoard().setProjectPhase(options.projectId, phase)

      const phaseStart = Date.now()
      let phaseResult: PhaseResult

      try {
        phaseResult = await this._executePhase(phase, options)
      } catch (err: any) {
        phaseResult = {
          phase,
          success: false,
          output: '',
          error: err.message || '未知错误',
          elapsedMs: Date.now() - phaseStart,
          artifacts: [],
        }
      }

      phaseResult.elapsedMs = Date.now() - phaseStart
      allResults.push(phaseResult)

      console.log(`[PhaseGate] ${phaseResult.success ? '✅' : '❌'} 阶段 ${phaseDef.label}: ${phaseResult.success ? '通过' : '失败'} (${phaseResult.elapsedMs}ms)`)

      // 如果关键阶段失败，终止后续
      if (!phaseResult.success && (phase === 'execute' || phase === 'verify')) {
        console.log(`[PhaseGate] ⛔ 关键阶段 ${phase} 失败，终止门控流程`)
        break
      }
    }

    // 汇总
    const success = allResults.every(r => r.success)
    const totalElapsed = Date.now() - start

    if (success && options.projectId) {
      getTaskBoard().setProjectStatus(options.projectId, 'done')
    }

    return {
      success,
      content: allResults.map(r =>
        `${PHASES[r.phase].icon} ${PHASES[r.phase].label}: ${r.success ? '✅' : '❌'} (${r.elapsedMs}ms)`
      ).join('\n'),
      error: allResults.find(r => !r.success)?.error || null,
      phaseResults: allResults,
      totalElapsedMs: totalElapsed,
    }
  }

  /** 中止当前执行 */
  abort(): void {
    this._aborted = true
  }

  // ═══ 各阶段执行逻辑 ═══

  private async _executePhase(
    phase: PhaseName,
    options: PhaseOptions,
  ): Promise<PhaseResult> {
    const start = Date.now()

    switch (phase) {
      case 'research':
        return this._doResearch(options)
      case 'plan':
        return this._doPlan(options)
      case 'execute':
        return this._doExecute(options)
      case 'verify':
        return this._doVerify(options)
      case 'review':
        return this._doReview(options)
      default:
        return {
          phase,
          success: false,
          output: '',
          error: `未知阶段: ${phase}`,
          elapsedMs: Date.now() - start,
          artifacts: [],
        }
    }
  }

  /**
   * 🔍 调研阶段：委托给 Yak 做 read-only 调查
   */
  private async _doResearch(options: PhaseOptions): Promise<PhaseResult> {
    const start = Date.now()
    const artifacts: string[] = []

    if (!options.delegateFn) {
      return {
        phase: 'research',
        success: true,
        output: '无委托函数，跳过调研（采用已有信息）',
        error: null,
        elapsedMs: Date.now() - start,
        artifacts,
      }
    }

    const researchTask = `【调研阶段 — 只读不写】
请调查以下任务涉及的所有现有代码和配置，但不做任何修改（只读模式）：

${options.task}

调研要求：
1. 读取所有相关的源代码、配置文件、文档
2. 理解现有的架构和实现
3. 识别需要修改的文件和位置
4. 评估修改的影响范围

输出格式（作为调研报告返回）：
- 📁 涉及的文件列表
- 🔗 关键代码路径
- ⚠️ 潜在风险
- 📐 建议的实现方案（至少 2 种）`

    const result = await options.delegateFn('yak', researchTask, 'code_explain')
    const taskId = `research-${Date.now()}`
    artifacts.push(taskId)

    return {
      phase: 'research',
      success: result.success,
      output: result.content,
      error: result.success ? null : (result as any).error || '调研失败',
      elapsedMs: Date.now() - start,
      artifacts,
    }
  }

  /**
   * 📋 规划阶段：将任务分解为 DAG
   */
  private async _doPlan(options: PhaseOptions): Promise<PhaseResult> {
    const start = Date.now()
    const artifacts: string[] = []

    const board = getTaskBoard()
    const project = board.getProject(options.projectId)

    if (!project) {
      return {
        phase: 'plan',
        success: false,
        output: '',
        error: '项目不存在',
        elapsedMs: Date.now() - start,
        artifacts,
      }
    }

    // 已经添加过任务了？跳过
    if (project.tasks.length > 0) {
      return {
        phase: 'plan',
        success: true,
        output: `已有 ${project.tasks.length} 个任务，跳过规划`,
        error: null,
        elapsedMs: Date.now() - start,
        artifacts: project.tasks.map(t => t.id),
      }
    }

    // 简单拆分：按文件/功能拆分子任务
    // 实际场景中可以在 Research 后由 LLM 细化
    const defaultTasks = [
      {
        title: '准备工作（环境检查 + 读取现有代码）',
        description: `读取现有代码结构，确认运行环境，了解完整的代码组织方式。\n原始任务：${options.task.slice(0, 500)}`,
        dependsOn: [] as string[],
        assignTo: 'yak' as const,
      },
      {
        title: '核心实现',
        description: `实现主要功能。\n原始任务：${options.task.slice(0, 500)}`,
        dependsOn: [] as string[],
        assignTo: 'yak' as const,
      },
      {
        title: '验证与修复',
        description: `运行编译/测试验证，修复可能的问题。\n原始任务：${options.task.slice(0, 500)}`,
        dependsOn: [] as string[],
        assignTo: 'yak' as const,
      },
    ]

    const tasks = board.addTasks(options.projectId, defaultTasks)
    artifacts.push(...tasks.map(t => t.id))

    return {
      phase: 'plan',
      success: true,
      output: `已规划 ${tasks.length} 个子任务`,
      error: null,
      elapsedMs: Date.now() - start,
      artifacts,
    }
  }

  /**
   * ⚡ 执行阶段：按 DAG 顺序/并行执行
   */
  private async _doExecute(options: PhaseOptions): Promise<PhaseResult> {
    const start = Date.now()
    const artifacts: string[] = []
    const board = getTaskBoard()

    if (!options.delegateFn) {
      return {
        phase: 'execute',
        success: false,
        output: '',
        error: '缺少委托函数',
        elapsedMs: Date.now() - start,
        artifacts,
      }
    }

    // 获取 ready 任务（依赖已完成的）
    const readyTasks = board.getReadyTasks(options.projectId)

    if (readyTasks.length === 0) {
      // 检查是否有 pending 但非 ready 的任务
      const allPending = board.getTasks(options.projectId).filter(t => t.status === 'pending')
      if (allPending.length > 0) {
        return {
          phase: 'execute',
          success: false,
          output: '',
          error: `有 ${allPending.length} 个任务因依赖未完成而阻塞`,
          elapsedMs: Date.now() - start,
          artifacts,
        }
      }
      return {
        phase: 'execute',
        success: true,
        output: '没有待执行的任务',
        error: null,
        elapsedMs: Date.now() - start,
        artifacts,
      }
    }

    // 依次执行 ready 任务（未来可改为并行）
    for (const task of readyTasks) {
      board.updateTaskStatus(task.id, 'running')
      console.log(`[PhaseGate] ⚡ 执行任务: ${task.title}`)

      const result = await options.delegateFn(
        task.assignTo,
        task.description,
        'code_write',
      )

      board.updateTaskStatus(task.id, result.success ? 'done' : 'failed', {
        result: result.content,
        error: result.success ? undefined : ((result as any).error || '执行失败'),
      })

      artifacts.push(task.id)
    }

    // 检查是否有新的 ready 任务（依赖链展开）
    const nextReady = board.getReadyTasks(options.projectId)
    if (nextReady.length > 0) {
      console.log(`[PhaseGate] 🔄 依赖链展开，继续执行 ${nextReady.length} 个任务`)
      const nextResult = await this._doExecute(options)
      artifacts.push(...nextResult.artifacts)
    }

    const failedTasks = board.getTasks(options.projectId).filter(t => t.status === 'failed')
    return {
      phase: 'execute',
      success: failedTasks.length === 0,
      output: `已完成 ${board.getTasks(options.projectId).filter(t => t.status === 'done').length} 个任务`,
      error: failedTasks.length > 0 ? `有 ${failedTasks.length} 个任务失败` : null,
      elapsedMs: Date.now() - start,
      artifacts,
    }
  }

  /**
   * 🧪 验证阶段：自动编译/测试/修复循环
   */
  private async _doVerify(options: PhaseOptions): Promise<PhaseResult> {
    const start = Date.now()
    const artifacts: string[] = []

    // 验证逻辑在 verifyLoop.ts 中实现
    // 这里传递给 delegate 调用 verifyLoop
    if (!options.delegateFn) {
      return {
        phase: 'verify',
        success: true,
        output: '无委托函数，跳过自动验证',
        error: null,
        elapsedMs: Date.now() - start,
        artifacts,
      }
    }

    const projectRoot = process.cwd()
    const verifyCommands = options.verifyCommands || ['npx tsc --noEmit 2>&1', 'npm test 2>&1 || echo "no tests"']

    const delegateResult = await options.delegateFn('yak',
      `【验证阶段 — 自动验证】
请在项目根目录执行以下验证命令并收集结果：

1. 编译检查（TypeScript）
2. 单元测试

工作目录：${projectRoot}

请执行验证命令，如果失败：
- 收集完整的错误信息
- 自动分析错误原因
- 修复问题
- 重新验证

验证命令：
${verifyCommands.join('\n')}`, 'code_debug')

    return {
      phase: 'verify',
      success: delegateResult.success,
      output: delegateResult.content,
      error: delegateResult.success ? null : '验证未全部通过',
      elapsedMs: Date.now() - start,
      artifacts: [],
    }
  }

  /**
   * 👁️ 审查阶段：委托给热茶做代码审查
   */
  private async _doReview(options: PhaseOptions): Promise<PhaseResult> {
    const start = Date.now()
    const artifacts: string[] = []

    if (!options.delegateFn) {
      return {
        phase: 'review',
        success: true,
        output: '无委托函数，跳过代码审查',
        error: null,
        elapsedMs: Date.now() - start,
        artifacts,
      }
    }

    const project = getTaskBoard().getProject(options.projectId)
    const doneTasks = project?.tasks.filter(t => t.status === 'done') || []

    const reviewContext = doneTasks
      .map(t => `任务: ${t.title}\n结果摘要: ${(t.result || '').slice(0, 500)}`)
      .join('\n---\n')

    const result = await options.delegateFn('recha',
      `【代码审查 — 请审查以下代码修改】

原始需求：
${options.task}

已完成的任务：
${reviewContext}

审查要求：
1. 检查代码质量、安全性、性能
2. 检查是否符合最佳实践
3. 输出具体的改进建议
4. 标记关键问题（需强制修复）与非关键问题（建议优化）

输出格式：
- ✅ 优秀设计（如有）
- ⚠️ 关键问题（必须修复）
- 💡 改进建议（可选优化）
- 📊 总评: 通过/有条件通过/不通过`, 'code_review')

    return {
      phase: 'review',
      success: result.success,
      output: result.content,
      error: result.success ? null : '代码审查失败',
      elapsedMs: Date.now() - start,
      artifacts: [],
    }
  }
}

// ═══════════════════════════════════════════════════════════
// 便利函数
// ═══════════════════════════════════════════════════════════

/**
 * 从复杂度分析结果中提取阶段列表
 */
export function getPhasesFromComplexity(complexity: {
  level: 'simple' | 'complex'
  suggestedPhases?: string[]
}): PhaseName[] {
  if (complexity.level === 'simple') {
    return ['execute'] // 简单任务：直接执行
  }

  // 复杂的，使用建议的阶段顺序
  const phaseOrder: PhaseName[] = ['research', 'plan', 'execute', 'verify', 'review']
  const suggested = complexity.suggestedPhases || []

  if (suggested.length > 0) {
    return phaseOrder.filter(p => suggested.includes(p))
  }

  // 默认全量
  return phaseOrder
}
