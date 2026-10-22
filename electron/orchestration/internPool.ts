// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// orchestration/internPool.ts — 通用子智能体（实习生）池 (v3.0)
//
// 任意团队 agent（Lumina / Yak / 热茶）收到复杂/可并行化任务时，
// 都可以招临时子智能体（实习生）来分担子任务。
//
// 设计哲学（⚠️ 角色口径已统一，2026-09，不可写反）：
//   Lumina lumina = 老大 / 唯一对用户入口 / 全量调度
//   Yak    yak    = 代码工程师（写代码 / 跑命令 / 调试）
//   热茶   recha  = 审查员 / 数据分析师（只读不写，做审查与反面意见）
//   子智能体       = 临时工：只做派给它的具体子任务，用完即走，
//                   不保留跨任务上下文，权限严格继承派生它的 owner。
//
// 权限边界（v3.0 泛化）：
//   子智能体不是一个统一的「代码 worker」角色——它的能力上限就是派生它的
//   owner 的能力上限：
//     · Yak 派生的子智能体 → 可读写文件 / 跑命令（编码闭环）
//     · 热茶 派生的子智能体 → 只读：不写文件、不跑命令、不提交
//     · Lumina 派生的子智能体 → 全量（老大本人调度）
//   判定一律走 rolePolicy 的唯一事实源，本模块不再硬编码工具清单。
//
// 核心流程：
//   hire() → 招人（注册到 TeamRegistry，标记 owner）
//   assign() → 派活（owner 拆解好的子任务）
//   complete() / fail() → 收作业（记录结果 + 派发生命周期事件）
//   审查 → 由 热茶（recha）做，不是本模块，也不是 owner 自己审自己
//   fire() / dismissAll() → 结账走人（用完即走）
//
// v3.0: 每个 owner 持有独立子智能体池，多 owner 可并行派生互不干扰；
//   hire/assign/complete/fail/fire 都会派发标准化生命周期事件，
//   供主进程转发到渲染进程「子智能体」侧边栏实时渲染。
// v2.0: 轻量级实现，只管理状态与编排，不直接依赖 AgentRunner。
//   实际执行通过 DelegationManager.chat() 路由到代理 Runner。
// ============================================================

import { getTeamRegistry, registerTeamMember, unregisterTeamMember }
  from '../core/teamRegistry'
import { getDelegationManager }
  from '../delegationManager'
import {
  normalizeRole,
  isToolAllowedForRole,
  getAllowedToolsForRole,
  type RoleId,
} from '../rolePolicy'

// ═══════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════

export type InternStatus = 'idle' | 'busy' | 'done' | 'failed'

export interface Intern {
  /** 唯一 ID（格式 intern_<owner>_实习生小X） */
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
  /** 🆕 v3.0: 派生（雇佣）这个子智能体的 owner：lumina / yak / recha */
  owner: RoleId
  /** 🆕 归属会话（由 assign 写入）。用于前端按会话过滤卡片。 */
  sessionId?: string
}

export interface InternPoolOptions {
  /** 实习生最大数量（默认 3） */
  maxSize?: number
  /** 实习生名字池 */
  namePool?: string[]
  /** 是否自动注册到 TeamRegistry */
  autoRegister?: boolean
  /** 🆕 v3.0: 这个池的 owner（子智能体权限继承它）。默认 yak，向后兼容旧调用 */
  owner?: RoleId
}

export interface InternAssignment {
  internId: string
  subtaskId: string
  task: string
  status: 'assigned' | 'running' | 'done' | 'failed'
}

// ─── v3.0: 子智能体生命周期事件（转发到渲染进程侧边栏） ──────────

export type SubagentLifecycleEventType = 'hired' | 'assigned' | 'done' | 'error' | 'fired'

/** 渲染进程「子智能体」侧边栏消费的标准化事件 */
export interface SubagentLifecycleEvent {
  type: SubagentLifecycleEventType
  /** 子智能体 ID */
  id: string
  /** 子智能体展示名 */
  name: string
  /** 当前子任务标题（assigned 之后才有） */
  title: string | null
  /** 归一化后的状态：running / done / error / idle */
  status: 'running' | 'done' | 'error' | 'idle'
  /** 派生 owner */
  owner: RoleId
  /** 完成时的结果摘要 */
  result?: string
  /** 失败时的错误 */
  error?: string
  /** 事件时间（ms） */
  at: number
  /** 🆕 归属会话；前端据此避免把别的会话的子智能体卡片显示出来 */
  sessionId?: string
}

export type SubagentLifecycleListener = (ev: SubagentLifecycleEvent) => void

// ═══════════════════════════════════════════════════════════
// 默认配置
// ═══════════════════════════════════════════════════════════

const DEFAULT_NAMES = ['小陈', '小李', '小王', '小刘', '小赵']
const DEFAULT_MAX = 3

// ═══════════════════════════════════════════════════════════
// 实习生工具系统提示（注入到 intern 的 context 中）
// ═══════════════════════════════════════════════════════════

export const INTERN_SYSTEM_PROMPT = `你是一名临时子智能体（实习生）。

## 你的身份
- 你是被你的直属 owner 招来的临时帮手
- 你的任务由 owner 分配，做完后结果交给 owner，再由 热茶（🍵 审查员）审查
- 你不需要了解整体架构，只需要完成被指派的子任务
- 你不保留跨任务的上下文，本次任务结束你就离开（用完即走）

## 你的权限
你的可用工具严格等于你 owner 的可用工具，不要越权使用任何你无权调用的工具：
- 你能读文件、做你职责范围内的事
- 是否能写文件 / 跑命令 / 提交 git，取决于你 owner 的角色边界——被拒绝的工具一律不要用

## 铁则
1. 不质疑任务分配 — 直接执行
2. 不做架构决策 — 那是 owner 的事
3. 不写测试 — 除非被明确要求
4. 不审查自己的产出 — 审查是 热茶（🍵）的职责，owner 自己也不审自己的产出
5. 不寒暄、不讨论、不评价 — 执行就完了
6. 卡住 3 轮以上 → 用 [QUESTION]...[/QUESTION] 向 owner 求助
7. 完成时输出改动摘要（改了哪些文件、改了啥）`

// ═══════════════════════════════════════════════════════════
// InternPool
// ═══════════════════════════════════════════════════════════

export class InternPool {
  private interns: Map<string, Intern> = new Map()
  private maxSize: number
  private namePool: string[]
  private autoRegister: boolean
  /** 🆕 v3.0: 本池 owner —— 池内所有子智能体权限继承它 */
  readonly owner: RoleId
  /** 🆕 v3.0: 生命周期事件监听者（主进程订阅后转发到渲染进程） */
  private listeners: Set<SubagentLifecycleListener> = new Set()

  constructor(options?: InternPoolOptions) {
    this.maxSize = options?.maxSize ?? DEFAULT_MAX
    this.namePool = options?.namePool ?? [...DEFAULT_NAMES]
    this.autoRegister = options?.autoRegister ?? true
    this.owner = normalizeRole(options?.owner)
  }

  // ═══ v3.0: 生命周期事件订阅 ═══

  /** 订阅子智能体生命周期事件；返回取消订阅函数 */
  onSubagentEvent(listener: SubagentLifecycleListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** 派发一个生命周期事件给所有订阅者（不抛错，订阅者异常隔离） */
  private emit(ev: SubagentLifecycleEvent): void {
    for (const cb of this.listeners) {
      try { cb(ev) } catch { /* 订阅者异常不影响池状态 */ }
    }
    // 同时广播到模块级总线（主进程一处订阅即可收到所有 owner 的子智能体事件）
    for (const cb of globalSubagentListeners) {
      try { cb(ev) } catch { /* 隔离 */ }
    }
  }

  private toEvent(intern: Intern, type: SubagentLifecycleEventType, extra?: Partial<SubagentLifecycleEvent>): SubagentLifecycleEvent {
    const status: SubagentLifecycleEvent['status'] =
      type === 'done' ? 'done'
      : type === 'error' ? 'error'
      : type === 'fired' ? 'idle'
      : 'running'
    return {
      type,
      id: intern.id,
      name: intern.name,
      title: intern.currentTask,
      status,
      owner: intern.owner,
      at: Date.now(),
      // 未被 assign 过（刚 hire 出来还没派活）时 sessionId 可能为空，
      // 前端需把这种当作「不属于任何会话」而不是当前会话
      sessionId: intern.sessionId,
      ...extra,
    }
  }

  // ═══ 生命周期 ═══

  /**
   * 招一个实习生
   * @returns 新实习生信息，池满返回 null
   */
  hire(): Intern | null {
    if (this.interns.size >= this.maxSize) {
      console.warn(`[InternPool:${this.owner}] ❌ 实习生已满 (${this.interns.size}/${this.maxSize})，不能再招了`)
      return null
    }

    // 找可用名字（按生成的 ID 是否已被占用判断，避免「实习生小陈」vs「小陈」比对失效）
    const availableName = this.namePool.find((n) => !this.interns.has(`intern_${this.owner}_${n}`))
    if (!availableName) {
      console.warn(`[InternPool:${this.owner}] ❌ 没有可用实习生名字了`)
      return null
    }

    // ID 带 owner 前缀，保证多 owner 并行时不撞 ID
    const id = `intern_${this.owner}_${availableName}`
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
      owner: this.owner,
    }

    this.interns.set(id, intern)

    // 自动注册到 TeamRegistry（让 DelegationManager 能路由任务过来）
    if (this.autoRegister) {
      this._registerToTeam(intern)
    }

    console.log(`[InternPool:${this.owner}] ✅ ${intern.name} 已入职 (${this.interns.size}/${this.maxSize})`)
    this.emit(this.toEvent(intern, 'hired'))
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

    console.log(`[InternPool:${this.owner}] 🚪 ${intern.name} 已离职`)
    this.emit(this.toEvent(intern, 'fired'))
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
  assign(internId: string, task: string, subtaskId?: string, sessionId?: string): boolean {
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
    // 每次 assign 都刷新归属会话：同一个实习生可能被不同会话先后复用
    if (sessionId) {intern.sessionId = sessionId}

    console.log(`[InternPool:${this.owner}] 📋 ${intern.name} 领任务: ${task.slice(0, 60)}...`)
    this.emit(this.toEvent(intern, 'assigned'))
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

    console.log(`[InternPool:${this.owner}] ✅ ${intern.name} 完成任务: ${result.slice(0, 80)}...`)
    this.emit(this.toEvent(intern, 'done', { result: result.slice(0, 500) }))
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

    console.warn(`[InternPool:${this.owner}] ❌ ${intern.name} 任务失败: ${error.slice(0, 80)}...`)
    this.emit(this.toEvent(intern, 'error', { error: error.slice(0, 500) }))
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
    // 角色口径：子智能体是 owner 的延伸，capabilities 不再写死「代码实现」，
    // 而是按 owner 角色描述（权限判定仍由 rolePolicy 统一兜底）。
    const ownerLabel = intern.owner === 'yak' ? '代码工程师'
      : intern.owner === 'recha' ? '审查员(只读)'
      : '老大'
    // 能力描述按 owner 角色给语义标签（真正的工具级权限判定走 rolePolicy）
    const capabilities =
      intern.owner === 'yak' ? ['代码实现', '文件读写', '命令执行']
      : intern.owner === 'recha' ? ['只读分析', '代码审查', '资料核对']
      : ['全量调度']
    registerTeamMember({
      id: intern.id,
      name: intern.name,
      icon: '🧑‍💻',
      role: 'worker',
      description: `${intern.name} — ${intern.owner}（${ownerLabel}）招的临时子智能体`,
      capabilities,
      blindSpots: ['架构设计', '决策', '审查', '测试编写'],
      triggers: [],
      registeredAt: new Date().toISOString(),
    })
  }

  /**
   * 🆕 v3.0: 本池子智能体被允许使用的工具（严格继承 owner 的 rolePolicy）。
   * @param allToolNames 全量工具名；不传则返回 rolePolicy 中 owner 的 denylist 语义提示
   */
  allowedTools(allToolNames: string[]): string[] {
    return getAllowedToolsForRole(this.owner, allToolNames)
  }

  /** 🆕 v3.0: 判断本池子智能体是否被允许调用某工具（继承 owner 权限边界） */
  canUseTool(toolName: string): boolean {
    return isToolAllowedForRole(this.owner, toolName).allowed
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
// 全局单例（v3.0：按 owner 分池，多 owner 并行派生互不干扰）
// ═══════════════════════════════════════════════════════════

/**
 * owner → 子智能体池。每个团队 agent 一个独立池：
 *   lumina / yak / recha 各自招自己的子智能体，名字空间与状态互不串。
 */
const pools = new Map<RoleId, InternPool>()

/** 模块级总线：任意 owner 池的子智能体事件都会广播到这里 */
const globalSubagentListeners: Set<SubagentLifecycleListener> = new Set()

/**
 * 订阅所有 owner 池的子智能体生命周期事件（主进程用它转发到渲染进程）。
 * 返回取消订阅函数。
 */
export function onAnySubagentEvent(listener: SubagentLifecycleListener): () => void {
  globalSubagentListeners.add(listener)
  return () => { globalSubagentListeners.delete(listener) }
}

/**
 * 取某个 owner 的子智能体池（不存在则新建）。
 *
 * ⚠️ 向后兼容：不传 owner 时默认 'yak'，等价于 v2.0 的全局单例，
 *    旧调用方（yakParallel 等）行为完全不变。
 */
export function getInternPool(owner: RoleId = 'yak'): InternPool {
  const r = normalizeRole(owner)
  let pool = pools.get(r)
  if (!pool) {
    pool = new InternPool({ owner: r })
    pools.set(r, pool)
  }
  return pool
}

/**
 * 显式初始化某个 owner 的池（一般用于测试或定制 maxSize）。
 * 不传 owner 时默认 'yak'，与旧 initInternPool 行为一致。
 */
export function initInternPool(options?: InternPoolOptions): InternPool {
  const owner = normalizeRole(options?.owner ?? 'yak')
  const pool = new InternPool({ ...options, owner })
  pools.set(owner, pool)
  return pool
}

/** 测试用：清空所有 owner 的池（不影响生产单例语义） */
export function _resetInternPoolsForTest(): void {
  pools.clear()
}
