// ============================================================
// orchestration/internPool.ts — Yak 实习生池 (v2.0)
//
// Yak 的「招实习生」模式基础设施。
// 当 Yak 收到复杂/可并行化任务时，可以招临时实习生来分担子任务。
//
// 设计哲学：
//   Yak = 正式员工（项目经理 + 主力开发者）
//   实习生 = 临时工（只能做指派的具体代码任务）
//   实习生不保留跨任务的上下文，用完即走
//
// 核心流程：
//   hire() → 招人（注册到 TeamRegistry + DelegationManager）
//   assign() → 派活（Yak 拆解好的子任务）
//   collect() → 收作业（等待完成，拿结果）
//   review() → 审查（Yak 把关质量）
//   dismiss() → 结账走人
//
// v2.0: 轻量级实现，只管理状态与编排，不直接依赖 AgentRunner。
//   实际执行通过 DelegationManager.chat() 路由到代理 Runner。
// ============================================================

import { getTeamRegistry, registerTeamMember, unregisterTeamMember }
  from '../core/teamRegistry'
import { getDelegationManager }
  from '../delegationManager'

// ═══════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════

export type InternStatus = 'idle' | 'busy' | 'done' | 'failed'

export interface Intern {
  /** 唯一 ID（格式 intern_实习生小X） */
  id: string
  /** 中文名（eg. 实习生小陈） */
  name: string
  /** 当前状态 */
  status: InternStatus
  /** 当前子任务描述 */
  currentTask: string | null
  /** 当前子任务在 taskBoard 中的 ID */
  currentSubTaskId: string | null
  /** 执行结果 */
  result: string | null
  /** 错误信息 */
  error: string | null
  /** 招入时间 */
  createdAt: string
  /** 完成当前任务的时间 */
  completedAt: string | null
  /** 累计完成任务数 */
  taskCount: number
}

export interface InternPoolOptions {
  /** 实习生最大数量（默认 3） */
  maxSize?: number
  /** 实习生名字池 */
  namePool?: string[]
  /** 是否自动注册到 TeamRegistry */
  autoRegister?: boolean
}

export interface InternAssignment {
  internId: string
  subtaskId: string
  task: string
  status: 'assigned' | 'running' | 'done' | 'failed'
}

// ═══════════════════════════════════════════════════════════
// 默认配置
// ═══════════════════════════════════════════════════════════

const DEFAULT_NAMES = ['小陈', '小李', '小王', '小刘', '小赵']
const DEFAULT_MAX = 3

// ═══════════════════════════════════════════════════════════
// 实习生工具系统提示（注入到 intern 的 context 中）
// ═══════════════════════════════════════════════════════════

export const INTERN_SYSTEM_PROMPT = `你是 Yak（📊）团队的一名实习生。

## 你的身份
- 你是 Yak 招来的临时帮手
- 你的任务由 Yak 分配，做完后结果交给 Yak 审查
- 你不需要了解整体架构，只需要完成被指派的子任务

## 你的权限
你可以使用以下工具来完成任务：
- 读文件（file_read, grep_search, glob_search）
- 写/改代码（write_file, edit_file）
- 运行命令验证（execute_shell_command — 仅限编译/检查命令）
- 搜索技术资料（web_search — 仅限解决问题需要时）

## 铁则
1. 不质疑任务分配 — 直接执行
2. 不做架构决策 — 那是 Yak 的事
3. 不写测试 — 除非被明确要求
4. 不审查自己的代码 — 那是热茶（🍵）的事
5. 不寒暄、不讨论、不评价 — 执行就完了
6. 卡住 3 轮以上 → 用 [QUESTION]...[/QUESTION] 向 Yak 求助
7. 完成时输出改动摘要（改了哪些文件、改了啥）`

// ═══════════════════════════════════════════════════════════
// InternPool
// ═══════════════════════════════════════════════════════════

export class InternPool {
  private interns: Map<string, Intern> = new Map()
  private maxSize: number
  private namePool: string[]
  private autoRegister: boolean

  constructor(options?: InternPoolOptions) {
    this.maxSize = options?.maxSize ?? DEFAULT_MAX
    this.namePool = options?.namePool ?? [...DEFAULT_NAMES]
    this.autoRegister = options?.autoRegister ?? true
  }

  // ═══ 生命周期 ═══

  /**
   * 招一个实习生
   * @returns 新实习生信息，池满返回 null
   */
  hire(): Intern | null {
    if (this.interns.size >= this.maxSize) {
      console.warn(`[InternPool] ❌ 实习生已满 (${this.maxSize}/${this.maxSize})，不能再招了`)
      return null
    }

    // 找可用名字
    const usedNames = new Set(Array.from(this.interns.values()).map(i => i.name))
    const availableName = this.namePool.find(n => !usedNames.has(n))
    if (!availableName) {
      console.warn(`[InternPool] ❌ 没有可用实习生名字了`)
      return null
    }

    const id = `intern_${availableName}`
    const intern: Intern = {
      id,
      name: `实习生${availableName}`,
      status: 'idle',
      currentTask: null,
      currentSubTaskId: null,
      result: null,
      error: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
      taskCount: 0,
    }

    this.interns.set(id, intern)

    // 自动注册到 TeamRegistry（让 DelegationManager 能路由任务过来）
    if (this.autoRegister) {
      this._registerToTeam(intern)
    }

    console.log(`[InternPool] ✅ ${intern.name} 已入职 (${this.interns.size}/${this.maxSize})`)
    return intern
  }

  /**
   * 开除实习生（一般用完就裁）
   */
  fire(internId: string): boolean {
    const intern = this.interns.get(internId)
    if (!intern) {return false}

    this.interns.delete(internId)

    if (this.autoRegister) {
      this._unregisterFromTeam(internId)
    }

    console.log(`[InternPool] 🚪 ${intern.name} 已离职`)
    return true
  }

  /**
   * 裁掉所有实习生（批量收工）
   */
  dismissAll(): void {
    const ids = Array.from(this.interns.keys())
    for (const id of ids) {
      this.fire(id)
    }
    console.log(`[InternPool] 📦 全部 ${ids.length} 名实习生已离职`)
  }

  // ═══ 任务管理 ═══

  /**
   * 给实习生分配任务
   * @param internId 实习生 ID
   * @param task 任务描述（Yak 拆解好的子任务）
   * @param subtaskId 关联的 taskBoard 子任务 ID（可选）
   * @returns 分配结果
   */
  assign(internId: string, task: string, subtaskId?: string): boolean {
    const intern = this.interns.get(internId)
    if (!intern) {
      console.warn(`[InternPool] ❌ 找不到实习生: ${internId}`)
      return false
    }
    if (intern.status === 'busy') {
      console.warn(`[InternPool] ❌ ${intern.name} 正在忙`)
      return false
    }

    intern.status = 'busy'
    intern.currentTask = task
    intern.currentSubTaskId = subtaskId ?? null
    intern.result = null
    intern.error = null
    intern.completedAt = null

    console.log(`[InternPool] 📋 ${intern.name} 领任务: ${task.slice(0, 60)}...`)
    return true
  }

  /**
   * 标记实习生任务完成
   */
  complete(internId: string, result: string): void {
    const intern = this.interns.get(internId)
    if (!intern) {return}

    intern.status = 'done'
    intern.result = result
    intern.completedAt = new Date().toISOString()
    intern.taskCount++

    console.log(`[InternPool] ✅ ${intern.name} 完成任务: ${result.slice(0, 80)}...`)
  }

  /**
   * 标记实习生任务失败
   */
  fail(internId: string, error: string): void {
    const intern = this.interns.get(internId)
    if (!intern) {return}

    intern.status = 'failed'
    intern.error = error
    intern.completedAt = new Date().toISOString()

    console.warn(`[InternPool] ❌ ${intern.name} 任务失败: ${error.slice(0, 80)}...`)
  }

  /**
   * 重置实习生状态（用于重新分配）
   */
  reset(internId: string): boolean {
    const intern = this.interns.get(internId)
    if (!intern) {return false}

    intern.status = 'idle'
    intern.currentTask = null
    intern.currentSubTaskId = null
    intern.result = null
    intern.error = null
    intern.completedAt = null
    return true
  }

  // ═══ 查询 ═══

  /** 获取指定实习生 */
  get(internId: string): Intern | undefined {
    return this.interns.get(internId)
  }

  /** 获取所有实习生 */
  getAll(): Intern[] {
    return Array.from(this.interns.values())
  }

  /** 获取空闲实习生 */
  getIdle(): Intern[] {
    return this.getAll().filter(i => i.status === 'idle')
  }

  /** 获取忙碌实习生 */
  getBusy(): Intern[] {
    return this.getAll().filter(i => i.status === 'busy')
  }

  /** 获取已完成任务的实习生 */
  getDone(): Intern[] {
    return this.getAll().filter(i => i.status === 'done')
  }

  /** 当前实习生数量 */
  get size(): number {
    return this.interns.size
  }

  /** 当前空闲数量 */
  get idleCount(): number {
    return this.getIdle().length
  }

  /** 是否还有空位 */
  get hasSlot(): boolean {
    return this.interns.size < this.maxSize
  }

  // ═══ 内部 ═══

  /** 注册到 TeamRegistry */
  private _registerToTeam(intern: Intern): void {
    registerTeamMember({
      id: intern.id,
      name: intern.name,
      icon: '🧑‍💻',
      role: 'worker',
      description: `${intern.name} — Yak 招的临时实习生`,
      capabilities: ['代码实现', '文件读写', '命令执行'],
      blindSpots: ['架构设计', '决策', '审查', '测试编写'],
      triggers: [],
      registeredAt: new Date().toISOString(),
    })
  }

  /** 从 TeamRegistry 注销 */
  private _unregisterFromTeam(internId: string): void {
    try {
      unregisterTeamMember(internId)
    } catch {
      // 忽略卸载异常
    }
  }
}

// ═══════════════════════════════════════════════════════════
// 全局单例
// ═══════════════════════════════════════════════════════════

let _instance: InternPool | null = null

export function getInternPool(): InternPool {
  if (!_instance) {_instance = new InternPool()}
  return _instance
}

export function initInternPool(options?: InternPoolOptions): InternPool {
  _instance = new InternPool(options)
  return _instance
}
