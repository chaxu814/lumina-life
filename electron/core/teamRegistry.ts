// ============================================================
// teamRegistry.ts — 动态团队注册中心 (v1.0)
//
// 支持运行时添加/移除团队成员，与现有 TeamMember/DelegationManager 集成。
// 内置成员（lumina/yak/recha）不可移除，但可查询。
// ============================================================

import type { AgentState, TeamMember, TeamMemberId } from '../agentTeamTypes'
import { TEAM_MEMBERS } from '../agentTeamPersonas'
import { globalEventBus, BusEvents } from '../eventBus'

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

/** 动态注册的团队成员 ID（任意字符串） */
export type DynamicMemberId = string

/** 动态团队成员注册信息 */
export interface DynamicMemberRegistration {
  id: DynamicMemberId
  name: string
  icon: string
  role: 'worker'
  description: string
  capabilities: string[]
  blindSpots: string[]
  /** 触发词列表 — 当用户提到这些词时，建议委托给此成员 */
  triggers?: string[]
  /** 注册时间 */
  registeredAt: string
}

/** 团队事件负载 */
export interface TeamMemberEventPayload {
  id: string
  name: string
  timestamp: string
}

// ═══════════════════════════════════════════════════════════
// 注册中心
// ═══════════════════════════════════════════════════════════

class TeamRegistry {
  /** 动态成员（内置成员不可移除） */
  private _dynamicMembers = new Map<DynamicMemberId, DynamicMemberRegistration>()

  /** 自定义 runner 工厂 — 由外部注入，用于创建新成员的独立 Runner */
  private _runnerFactory: ((reg: DynamicMemberRegistration) => any) | null = null

  // ── Singleton ──

  private static _instance: TeamRegistry
  static getInstance(): TeamRegistry {
    if (!this._instance) this._instance = new TeamRegistry()
    return this._instance
  }

  // ── Runner 工厂注入 ──

  setRunnerFactory(factory: (reg: DynamicMemberRegistration) => any): void {
    this._runnerFactory = factory
  }

  // ── 成员管理 ──

  /**
   * 注册一个新团队成员
   * @returns 注册成功返回 true；ID 已存在返回 false
   */
  register(reg: DynamicMemberRegistration): boolean {
    if (this._dynamicMembers.has(reg.id)) return false
    if (this.isBuiltIn(reg.id)) return false

    this._dynamicMembers.set(reg.id, {
      ...reg,
      registeredAt: reg.registeredAt || new Date().toISOString(),
    })

    globalEventBus.emit('team:member_added' as any, {
      id: reg.id,
      name: reg.name,
      timestamp: new Date().toISOString(),
    } as TeamMemberEventPayload)

    console.log(`[TeamRegistry] ✅ 动态成员已注册: ${reg.icon} ${reg.name} (${reg.id})`)
    return true
  }

  /**
   * 移除一个动态团队成员
   * @returns 移除成功返回 true；成员不存在或为内置成员返回 false
   */
  unregister(id: DynamicMemberId): boolean {
    if (this.isBuiltIn(id)) return false
    if (!this._dynamicMembers.has(id)) return false

    this._dynamicMembers.delete(id)

    globalEventBus.emit('team:member_removed' as any, {
      id,
      name: id,
      timestamp: new Date().toISOString(),
    } as TeamMemberEventPayload)

    console.log(`[TeamRegistry] 🗑️ 动态成员已移除: ${id}`)
    return true
  }

  /** 获取所有动态成员列表 */
  getDynamicMembers(): DynamicMemberRegistration[] {
    return Array.from(this._dynamicMembers.values())
  }

  /** 获取所有团队成员（内置 + 动态） */
  getAllMembers(): Array<TeamMember | DynamicMemberRegistration> {
    const builtIn = Object.values(TEAM_MEMBERS) as TeamMember[]
    const dynamic = this.getDynamicMembers()
    return [...builtIn, ...dynamic]
  }

  /** 查询单个成员（内置或动态） */
  getMember(id: string): TeamMember | DynamicMemberRegistration | undefined {
    if (this.isBuiltIn(id)) return (TEAM_MEMBERS as Record<string, TeamMember>)[id]
    return this._dynamicMembers.get(id)
  }

  /** 检查 ID 是否为内置成员 */
  isBuiltIn(id: string): boolean {
    return ['lumina', 'yak', 'recha'].includes(id)
  }

  /** 检查成员是否存在 */
  exists(id: string): boolean {
    return this.isBuiltIn(id) || this._dynamicMembers.has(id)
  }

  /** 根据用户输入，建议匹配的动态成员 */
  suggestMember(input: string): DynamicMemberRegistration | undefined {
    const lower = input.toLowerCase()
    for (const [, member] of this._dynamicMembers) {
      if (!member.triggers || member.triggers.length === 0) continue
      if (member.triggers.some(t => lower.includes(t.toLowerCase()))) {
        return member
      }
    }
    return undefined
  }

  /** 🔧 v9.3: 清空所有动态成员（测试用） */
  clearDynamic(): void {
    this._dynamicMembers.clear()
  }
}

// ═══════════════════════════════════════════════════════════
// 快捷函数
// ═══════════════════════════════════════════════════════════

export function getTeamRegistry(): TeamRegistry {
  return TeamRegistry.getInstance()
}

export function registerTeamMember(reg: DynamicMemberRegistration): boolean {
  return TeamRegistry.getInstance().register(reg)
}

export function unregisterTeamMember(id: DynamicMemberId): boolean {
  return TeamRegistry.getInstance().unregister(id)
}

export function listTeamMembers(): Array<TeamMember | DynamicMemberRegistration> {
  return TeamRegistry.getInstance().getAllMembers()
}

/** 🔧 v9.3: 测试用 — 返回一个干净的注册中心实例 */
export function useTestRegistry(): TeamRegistry {
  const inst = TeamRegistry.getInstance()
  inst.clearDynamic()
  return inst
}

export { TeamRegistry }

/** 🆕 v8.1: 初始化 ACP 系统 */
export function initAcpSystem(): void {
  const registry = TeamRegistry.getInstance()
  console.log('[ACP] ACP 系统已就绪')
}
