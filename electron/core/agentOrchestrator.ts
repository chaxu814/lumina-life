// ============================================================
// agentOrchestrator.ts — Agent 编排器 (v15.0)
//
// 统一持有所有 Agent 管理器的引用，解决：
//   1. 循环依赖：delegationManager →(require) agentSocialEngine → agentTeamManager → ...
//   2. Runner 创建与注册分离：现在 main.ts new Runner 后再 dm.registerRunner()
//   3. 初始化入口分散：4 个管理器各自 export initXxx()
//
// 使用「垫片模式」——旧文件 export 不变，内部委派到此编排器。
// ============================================================

// ═══════════════════════════════════════════════════════════
// 导入（静态 import 让 electron-vite/Rollup 正确打包）
// ═══════════════════════════════════════════════════════════

// 静态导入替代动态 require，解决打包后路径失效问题
// 各模块内使用 try-catch 包裹的动态 require 不会影响顶层导入
import { TeamContextManager } from '../agentTeamContext'
import { ModeManager } from '../agentTeamManager'
import { DelegationManager } from '../delegationManager'
import type { AgentSocialEngine } from '../agentSocialEngine'
import type { AgentRunner } from '../agentRunner'

// ═══════════════════════════════════════════════════════════
// AgentOrchestrator
// ═══════════════════════════════════════════════════════════

export class AgentOrchestrator {
  private static _instance: AgentOrchestrator | null = null

  /** 委托管理器（来自 delegationManager.ts） */
  delegation!: DelegationManager
  /** 模式管理器（来自 agentTeamManager.ts） */
  modeManager!: ModeManager
  /** 团队上下文管理器（来自 agentTeamContext.ts） */
  teamContext!: TeamContextManager
  /** 社交引擎（来自 agentSocialEngine.ts，延迟初始化） */
  socialEngine: AgentSocialEngine | null = null

  /** Runner 注册表 —— 之前分散在 DelegationManager.runners 中，现统管 */
  private _runners: Map<string, AgentRunner> = new Map()

  private constructor() {}

  static getInstance(): AgentOrchestrator {
    if (!AgentOrchestrator._instance) {
      AgentOrchestrator._instance = new AgentOrchestrator()
    }
    return AgentOrchestrator._instance
  }

  /**
   * 初始化 3 个无依赖管理器，依次创建以避免循环 require
   *
   * 顺序：
   *   1. TeamContextManager —— 无依赖，优先
   *   2. ModeManager —— 无依赖
   *   3. DelegationManager —— 依赖 SocialEngine（已通过引用解耦）
   */
  init(): void {
    // 1. TeamContextManager — 通过顶层静态导入，Rollup 已正确打包
    this.teamContext = new TeamContextManager()

    // 2. ModeManager
    this.modeManager = new ModeManager()

    // 3. DelegationManager
    this.delegation = new DelegationManager()

    console.log('[AgentOrchestrator] ✅ 核心管理器已初始化（delegation + modeManager + teamContext）')
  }

  /** 注册社交引擎（SSE 需要 llmCall，在 main.ts/IPC 中创建后注入） */
  setSocialEngine(engine: AgentSocialEngine): void {
    this.socialEngine = engine
  }

  // ═══ Runner 管理 ═══

  /** 注册 Agent Runner */
  registerRunner(id: string, runner: AgentRunner): void {
    this._runners.set(id, runner)
    // 同步到 delegationManager 的 runners（如有）
    if (this.delegation?.registerRunner) {
      try { this.delegation.registerRunner(id, runner) } catch {}
    }
  }

  /** 获取已注册的 Runner */
  getRunner(id: string): AgentRunner | undefined {
    return this._runners.get(id)
  }

  /** 检查成员是否已注册 */
  hasRunner(id: string): boolean {
    return this._runners.has(id)
  }

  /** 列出所有 Runner */
  listRunners(): Array<{ id: string; runner: AgentRunner }> {
    const result: Array<{ id: string; runner: AgentRunner }> = []
    this._runners.forEach((runner, id) => result.push({ id, runner }))
    return result
  }

  /** 统一销毁 */
  destroy(): void {
    this._runners.clear()
    if (this.delegation?.destroy) {
      try { this.delegation.destroy() } catch {}
    }
    // 不销毁 teamContext 和 modeManager（无状态）
    AgentOrchestrator._instance = null
    console.log('[AgentOrchestrator] 🧹 已清理')
  }
}

// ═══════════════════════════════════════════════════════════
// 导出函数
// ═══════════════════════════════════════════════════════════

export function getOrchestrator(): AgentOrchestrator {
  return AgentOrchestrator.getInstance()
}

export function initOrchestrator(): AgentOrchestrator {
  const inst = AgentOrchestrator.getInstance()
  inst.init()
  return inst
}

/** 重置单例（仅用于测试） */
export function resetOrchestrator(): void {
  (AgentOrchestrator as any)._instance = null
}
