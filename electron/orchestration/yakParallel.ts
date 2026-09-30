// ============================================================
// orchestration/yakParallel.ts — 并行执行引擎 (v2.0)
//
// ⚠️ 文件名/类名（YakParallel / getYakParallel / initYakParallel）是旧角色口径
//    留下的历史命名，为保证对外导出签名不变而保留；引擎本身与角色无关。
//
// 「招实习生」模式的核心编排层。
// 当热茶（recha，程序员）的大任务可以被拆解为独立子任务时，热茶启动此引擎：
//
// 流程：
//   ① splitTask() — 热茶分析任务，拆成可并行子任务
//   ② hireInterns() — 从 InternPool 招人（按需）
//   ③ executeParallel() — 子任务并发派给实习生
//   ④ reviewResults() — 交由 Yak（审查员）把关质量
//   ⑤ integrateResults() — 合并结果成完整输出
//   ⑥ dismissInterns() — 结账走人
//
// 与 DelegationManager 的关系：
//   YakParallel 不直接创建 AgentRunner。
//   它用 DelegationManager.delegate() 将子任务路由到实习生。
//   实习生通过 InternPool + TeamRegistry 注册为临时成员。
// ============================================================

import { getDelegationManager } from '../delegationManager'
import { getTaskBoard } from './taskBoard'
import { getInternPool, type Intern, type InternPool } from './internPool'
import type { DelegationResult } from '../agentTeamTypes'

// ═══════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════

export interface SubTask {
  /** 子任务 ID */
  id: string
  /** 任务标题 */
  title: string
  /** 详细描述 */
  description: string
  /** 预期交付物描述 */
  deliverable: string
  /** 依赖的其他子任务 ID */
  dependsOn: string[]
  /** 分配给哪个实习生（由引擎分配） */
  assignee: string | null
}

export interface SplitResult {
  /** 拆分后的子任务列表（按依赖顺序） */
  subTasks: SubTask[]
  /** 并行组（每组内可并行执行） */
  parallelGroups: SubTask[][]
  /** 是否建议招实习生 */
  suggestHire: boolean
  /** 建议的实习生数量 */
  suggestedInternCount: number
  /** 备注 */
  notes: string[]
}

export interface InternResult {
  internId: string
  internName: string
  subTaskId: string
  subTaskTitle: string
  success: boolean
  content: string
  error: string | null
  elapsedMs: number
}

export interface ParallelExecuteResult {
  /** 每组的执行结果 */
  groupResults: InternResult[][]
  /** 整合后的输出 */
  integratedOutput: string
  /** 审查意见 */
  reviewNotes: string[]
  /** 是否全部成功 */
  allSuccess: boolean
  /** 总耗时 */
  totalElapsedMs: number
}

// ═══════════════════════════════════════════════════════════
// TaskSplitter — 任务拆解（热茶的策略层）
// ═══════════════════════════════════════════════════════════

export class TaskSplitter {
  /**
   * 将大任务拆分为可并行执行的子任务
   *
   * ⚠️ 这是一个结构化的模板方法。
   *   实际拆解由热茶（LLM，recha 程序员）通过分析任务后调用。
   *   这里提供基础的工具函数做自动拆分。
   *
   * @param taskId 关联的 taskBoard 项目 ID
   * @param taskDescription 完整任务描述
   * @returns 拆分结果
   */
  split(
    taskId: string,
    taskDescription: string,
    options?: {
      context?: string
      filePaths?: string[]
    },
  ): SplitResult {
    const board = getTaskBoard()
    const project = board.getProject(taskId)

    if (!project) {
      // 没有 taskBoard 项目 → 返回空拆分
      return {
        subTasks: [],
        parallelGroups: [],
        suggestHire: false,
        suggestedInternCount: 0,
        notes: ['⚠️ taskBoard 项目不存在，无法拆分'],
      }
    }

    const tasks = board.getTasks(taskId)
    if (tasks.length === 0) {
      return {
        subTasks: [],
        parallelGroups: [],
        suggestHire: false,
        suggestedInternCount: 0,
        notes: ['⚠️ 项目中没有任务，无需拆分'],
      }
    }

    // 将 board 中的 TaskNode 映射为 SubTask
    const subTasks: SubTask[] = tasks.map(t => ({
      id: t.id,
      title: t.title,
      description: t.description,
      deliverable: t.result || t.description,
      dependsOn: t.dependsOn,
      assignee: null,
    }))

    // 计算并行组
    const parallelGroups = this._computeParallelGroups(subTasks)

    // 判断是否值得招实习生
    const totalTasks = subTasks.length
    const maxParallel = Math.max(...parallelGroups.map(g => g.length), 1)
    const suggestHire = totalTasks >= 2 && maxParallel >= 2
    const suggestedInternCount = Math.min(maxParallel, 3)

    // 生成备注
    const notes: string[] = []
    if (suggestHire) {
      notes.push(`💡 建议招 ${suggestedInternCount} 名实习生并行处理`)
    }
    if (parallelGroups.length > 1) {
      notes.push(`📊 共 ${parallelGroups.length} 个执行阶段，${totalTasks} 个子任务`)
    }
    if (subTasks.some(s => s.dependsOn.length > 0)) {
      notes.push(`🔗 检测到任务间依赖关系`)
    }

    return { subTasks, parallelGroups, suggestHire, suggestedInternCount, notes }
  }

  /**
   * 将子任务按依赖关系分组（每组内可并行）
   */
  private _computeParallelGroups(subTasks: SubTask[]): SubTask[][] {
    const groups: SubTask[][] = []
    const taskMap = new Map(subTasks.map(t => [t.id, t]))
    const remaining = new Set(subTasks.map(t => t.id))
    let iteration = 0

    while (remaining.size > 0 && iteration < 100) {
      iteration++
      const ready: SubTask[] = []

      for (const id of remaining) {
        const task = taskMap.get(id)!
        // 检查依赖是否都已不在 remaining 中（即已处理过）
        const depsMet = task.dependsOn.every(depId => !remaining.has(depId))
        if (depsMet) {
          ready.push(task)
        }
      }

      if (ready.length === 0) {
        // 死锁 — 把剩余的全部作为一组（标记依赖异常）
        for (const id of remaining) {
          const task = taskMap.get(id)
          if (task) {ready.push(task)}
        }
        break
      }

      groups.push(ready)
      for (const task of ready) {
        remaining.delete(task.id)
      }
    }

    return groups
  }
}

// ═══════════════════════════════════════════════════════════
// YakParallel — 并行执行编排器
// ═══════════════════════════════════════════════════════════

export class YakParallel {
  private splitter: TaskSplitter
  private pool: InternPool

  constructor(pool?: InternPool) {
    this.splitter = new TaskSplitter()
    this.pool = pool ?? getInternPool()
  }

  /** 获取 TaskSplitter 引用 */
  getSplitter(): TaskSplitter {
    return this.splitter
  }

  /**
   * 招实习生并配好
   * @param count 要招的人数
   * @returns 实际招到的实习生列表
   */
  hireTeam(count: number): Intern[] {
    const hired: Intern[] = []
    for (let i = 0; i < count; i++) {
      const intern = this.pool.hire()
      if (intern) {hired.push(intern)}
    }
    return hired
  }

  /**
   * 在并行组内派活并等待结果
   *
   * 热茶（程序员）的视角：
   *   "小陈做模块A，小李做模块B，小王做模块C"
   *   派完等结果，谁先做完谁先交
   *
   * @param group 可并行的一组子任务
   * @param context 全局上下文（项目背景）
   * @returns 组内每个实习生的执行结果
   */
  async executeGroup(
    group: SubTask[],
    context?: string,
  ): Promise<InternResult[]> {
    const results: InternResult[] = []
    const delegationManager = getDelegationManager()

    // 为每个子任务分配空闲实习生
    const assignments: Array<{
      intern: Intern
      task: SubTask
    }> = []

    for (const task of group) {
      const idle = this.pool.getIdle()
      if (idle.length === 0) {
        console.warn(`[YakParallel] ⚠️ 没有空闲实习生执行: ${task.title}`)
        results.push({
          internId: '',
          internName: '（无空闲实习生）',
          subTaskId: task.id,
          subTaskTitle: task.title,
          success: false,
          content: '',
          error: '没有空闲实习生可用',
          elapsedMs: 0,
        })
        continue
      }

      const intern = idle[0]
      this.pool.assign(intern.id, task.description, task.id)
      task.assignee = intern.id
      assignments.push({ intern, task })
    }

    // 并发执行！
    const promises = assignments.map(async ({ intern, task }) => {
      const startTime = Date.now()

      try {
        // 通过 DelegationManager 委托给实习生
        const result: DelegationResult = await delegationManager.delegate(
          'recha', // 发起者：热茶（程序员）派活给实习生
          {
            to: intern.id as any, // 路由到实习生
            task: [
              `【${intern.name} 任务】`,
              ``,
              `热茶 老师让你做这个子任务：`,
              task.description,
              ``,
              task.deliverable
                ? `【预期交付】\n${task.deliverable}` : '',
              ``,
              context
                ? `【项目背景】\n${context.slice(0, 2000)}` : '',
              ``,
              '---',
              '完成直接返回结果，不需要问我确认。做完就是做完了。',
            ].join('\n'),
            taskType: 'code_write',
            context,
          },
        )

        const elapsed = Date.now() - startTime

        if (result.success) {
          this.pool.complete(intern.id, result.content)
          return {
            internId: intern.id,
            internName: intern.name,
            subTaskId: task.id,
            subTaskTitle: task.title,
            success: true,
            content: result.content,
            error: null,
            elapsedMs: elapsed,
          } as InternResult
        } else {
          this.pool.fail(intern.id, result.error || '未知错误')
          return {
            internId: intern.id,
            internName: intern.name,
            subTaskId: task.id,
            subTaskTitle: task.title,
            success: false,
            content: '',
            error: result.error || '委托执行失败',
            elapsedMs: elapsed,
          } as InternResult
        }
      } catch (err: any) {
        const elapsed = Date.now() - startTime
        this.pool.fail(intern.id, err.message)
        return {
          internId: intern.id,
          internName: intern.name,
          subTaskId: task.id,
          subTaskTitle: task.title,
          success: false,
          content: '',
          error: err.message,
          elapsedMs: elapsed,
        } as InternResult
      }
    })

    // 等待这组全部完成
    const groupResults = await Promise.all(promises)
    results.push(...groupResults)

    return results
  }

  /**
   * 串行执行所有阶段（按依赖顺序）
   * 每个阶段内的任务并行，阶段间串行
   */
  async executeAll(
    taskId: string,
    taskDescription: string,
    options?: {
      context?: string
      autoHire?: boolean
    },
  ): Promise<ParallelExecuteResult> {
    const startTime = Date.now()
    const allResults: InternResult[][] = []
    const reviewNotes: string[] = []

    // 1. 拆分任务
    const splitResult = this.splitter.split(taskId, taskDescription)

    if (splitResult.subTasks.length === 0) {
      return {
        groupResults: [],
        integratedOutput: '无子任务可执行',
        reviewNotes: ['任务为空'],
        allSuccess: true,
        totalElapsedMs: Date.now() - startTime,
      }
    }

    // 2. 按需招实习生
    if (options?.autoHire !== false && splitResult.suggestHire) {
      const count = splitResult.suggestedInternCount
      const hired = this.hireTeam(count)
      reviewNotes.push(`👥 招了 ${hired.length}/${count} 名实习生`)
    }

    // 3. 按阶段串行执行
    for (let phaseIdx = 0; phaseIdx < splitResult.parallelGroups.length; phaseIdx++) {
      const group = splitResult.parallelGroups[phaseIdx]

      // 检查这组是否真的有可并行的（>1 个任务且实习生够）
      if (group.length >= 2 && this.pool.idleCount >= 1) {
        // 并行执行
        const groupResult = await this.executeGroup(group, options?.context)
        allResults.push(groupResult)

        // 检查这组是否全部成功
        const allOk = groupResult.every(r => r.success)
        reviewNotes.push(
          `阶段 ${phaseIdx + 1}/${splitResult.parallelGroups.length}: ` +
          `${allOk ? '✅' : '⚠️'} ${groupResult.filter(r => r.success).length}/${groupResult.length} 完成`,
        )
      } else {
        // 串行执行（一个一个来）
        for (const task of group) {
          const groupResult = await this.executeGroup([task], options?.context)
          allResults.push(groupResult)
          reviewNotes.push(
            `任务 "${task.title}": ${groupResult[0]?.success ? '✅' : '❌'}`,
          )
        }
      }
    }

    // 4. 整合结果
    const flatResults = allResults.flat()
    const allSuccess = flatResults.every(r => r.success)
    const integratedOutput = this.integrate(flatResults)

    // 5. 裁掉实习生
    this.pool.dismissAll()

    const totalElapsed = Date.now() - startTime

    console.log(`[YakParallel] 🎯 并行执行完成: ${flatResults.length} 个子任务, ${allSuccess ? '全部成功' : '部分失败'}, ${totalElapsed}ms`)

    return {
      groupResults: allResults,
      integratedOutput,
      reviewNotes,
      allSuccess,
      totalElapsedMs: totalElapsed,
    }
  }

  /**
   * 整合并行执行结果
   * 热茶的合并逻辑（最终质量把关交给 Yak 审查员）
   */
  integrate(results: InternResult[]): string {
    const sections: string[] = []

    for (const r of results) {
      if (r.success) {
        sections.push(
          `## ${r.subTaskTitle}（由 ${r.internName} 完成）\n`,
          r.content.trim(),
          ``,
          `---`,
        )
      } else {
        sections.push(
          `## ${r.subTaskTitle}（由 ${r.internName} 执行，❌失败）\n`,
          `错误: ${r.error}`,
          ``,
          `---`,
        )
      }
    }

    return sections.join('\n')
  }

  /**
   * 热茶对实习生输出做形式检查（通过率/失败原因）
   * 注意：这里只做形式检查，真正的内容审查由 Yak（审查员）负责
   */
  review(results: InternResult[]): string[] {
    const notes: string[] = []

    for (const r of results) {
      if (r.success) {
        notes.push(`✅ ${r.internName} 的 "${r.subTaskTitle}" 看起来没问题（${(r.elapsedMs / 1000).toFixed(1)}s）`)
      } else {
        notes.push(`❌ ${r.internName} 的 "${r.subTaskTitle}" 失败了: ${r.error}`)
      }
    }

    return notes
  }
}

// ═══════════════════════════════════════════════════════════
// 快捷函数
// ═══════════════════════════════════════════════════════════

let _instance: YakParallel | null = null

export function getYakParallel(): YakParallel {
  if (!_instance) {_instance = new YakParallel()}
  return _instance
}

export function initYakParallel(pool?: InternPool): YakParallel {
  _instance = new YakParallel(pool)
  return _instance
}
