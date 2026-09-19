// ============================================================
// hooks/hookManager.ts — Agent 生命周期 Hook 管理器 (v3.5)
//
// 借鉴 QwenPaw Hook 系统:
//   按优先级顺序执行 Hook 链，支持 veto (阻止工具调用)
//   Hook 可以修改消息/工具定义/请求体
// ============================================================

import type {
  HookRegistration, HookContext, HookPriority,
  BeforeReasoningInput, AfterReasoningInput,
  BeforeToolCallInput, AfterToolCallInput,
  OnErrorInput, OnCompactionInput,
} from './types'

const PRIORITY_ORDER: HookPriority[] = ['highest', 'high', 'normal', 'low', 'lowest']

export class HookManager {
  private hooks: HookRegistration[] = []
  private static _instance: HookManager | null = null

  static getInstance(): HookManager {
    if (!this._instance) {this._instance = new HookManager()}
    return this._instance
  }

  /** 注册一个 Hook */
  register(hook: HookRegistration): void {
    // 防止重复注册
    if (this.hooks.find(h => h.id === hook.id)) {
      console.warn(`[HookManager] Hook "${hook.id}" 已注册，跳过`)
      return
    }
    this.hooks.push(hook)
    this._sort()
    console.log(`[HookManager] ✅ 注册 Hook: ${hook.name} (${hook.id})`)
  }

  /** 注销一个 Hook */
  unregister(hookId: string): void {
    const before = this.hooks.length
    this.hooks = this.hooks.filter(h => h.id !== hookId)
    if (this.hooks.length < before) {
      console.log(`[HookManager] ❌ 注销 Hook: ${hookId}`)
    }
  }

  /** 启用/禁用 Hook */
  toggle(hookId: string, enabled: boolean): void {
    const hook = this.hooks.find(h => h.id === hookId)
    if (hook) {
      hook.enabled = enabled
      console.log(`[HookManager] ${enabled ? '✅ 启用' : '⏸️ 禁用'} Hook: ${hookId}`)
    }
  }

  /** 列出所有已注册 Hook */
  list(): HookRegistration[] {
    return [...this.hooks]
  }

  /** 获取指定 persona 的活跃 Hook */
  getActiveHooks(persona?: string, phase: keyof HookRegistration = 'beforeReasoning'): HookRegistration[] {
    return this.hooks.filter(h => {
      if (!h.enabled) {return false}
      if (h.personas && h.personas.length > 0 && persona && !h.personas.includes(persona)) {return false}
      return typeof (h as any)[phase] === 'function'
    })
  }

  // ═══════════════════════════════════════════════════════
  // Hook 执行方法
  // ═══════════════════════════════════════════════════════

  async runBeforeReasoning(input: BeforeReasoningInput): Promise<BeforeReasoningInput> {
    const active = this.getActiveHooks(input.ctx.config.personaId, 'beforeReasoning')
    let result = input
    for (const hook of active) {
      if (!hook.beforeReasoning) {continue}
      try {
        const modified = await hook.beforeReasoning(result)
        if (modified) {result = modified}
      } catch (err: any) {
        console.error(`[HookManager] beforeReasoning Hook "${hook.id}" 异常:`, err.message)
      }
    }
    return result
  }

  async runAfterReasoning(input: AfterReasoningInput): Promise<void> {
    const active = this.getActiveHooks(input.ctx.config.personaId, 'afterReasoning')
    for (const hook of active) {
      if (!hook.afterReasoning) {continue}
      try {
        await hook.afterReasoning(input)
      } catch (err: any) {
        console.error(`[HookManager] afterReasoning Hook "${hook.id}" 异常:`, err.message)
      }
    }
  }

  /** 返回 veto 信息（如有 Hook 阻止了此工具调用） */
  async runBeforeToolCall(input: BeforeToolCallInput): Promise<{ vetoed: boolean; reason?: string; approval?: string }> {
    const active = this.getActiveHooks(input.ctx.config.personaId, 'beforeToolCall')
    for (const hook of active) {
      if (!hook.beforeToolCall) {continue}
      try {
        const result = await hook.beforeToolCall(input)
        if (result) {
          // 检查是否被 veto
          if (input.veto) {
            return { vetoed: true, reason: input.vetoReason || `Hook "${hook.id}" 阻止了此工具调用` }
          }
          if (input.requireApproval) {
            return { vetoed: false, approval: input.requireApproval }
          }
        }
      } catch (err: any) {
        console.error(`[HookManager] beforeToolCall Hook "${hook.id}" 异常:`, err.message)
      }
    }
    return { vetoed: false }
  }

  async runAfterToolCall(input: AfterToolCallInput): Promise<void> {
    const active = this.getActiveHooks(input.ctx.config.personaId, 'afterToolCall')
    for (const hook of active) {
      if (!hook.afterToolCall) {continue}
      try {
        await hook.afterToolCall(input)
      } catch (err: any) {
        console.error(`[HookManager] afterToolCall Hook "${hook.id}" 异常:`, err.message)
      }
    }
  }

  async runOnError(input: OnErrorInput): Promise<void> {
    const active = this.getActiveHooks(input.ctx.config.personaId, 'onError')
    for (const hook of active) {
      if (!hook.onError) {continue}
      try {
        await hook.onError(input)
      } catch (err: any) {
        console.error(`[HookManager] onError Hook "${hook.id}" 异常:`, err.message)
      }
    }
  }

  async runOnCompaction(input: OnCompactionInput): Promise<void> {
    const active = this.getActiveHooks(input.ctx.config.personaId, 'onCompaction')
    for (const hook of active) {
      if (!hook.onCompaction) {continue}
      try {
        await hook.onCompaction(input)
      } catch (err: any) {
        console.error(`[HookManager] onCompaction Hook "${hook.id}" 异常:`, err.message)
      }
    }
  }

  /** 获取单个 Hook 注册信息（用于 enable/disable） */
  getRegistration(hookId: string): HookRegistration | undefined {
    return this.hooks.find(h => h.id === hookId)
  }

  // ═══════════════════════════════════════════════════════
  // 内部
  // ═══════════════════════════════════════════════════════

  private _sort(): void {
    this.hooks.sort((a, b) => {
      const ai = PRIORITY_ORDER.indexOf(a.priority)
      const bi = PRIORITY_ORDER.indexOf(b.priority)
      return ai - bi
    })
  }
}

/** 获取所有已注册 Hook 的摘要 */
export function getHooksSummary(): string {
  const manager = HookManager.getInstance()
  const hooks = manager['hooks'] as HookRegistration[]
  if (hooks.length === 0) {return '📋 没有注册的 Hook'}

  const lines = ['**已注册 Hook** (' + hooks.length + ')\n']
  for (const h of hooks) {
    const status = h.enabled ? '✅' : '⏸️'
    const types: string[] = []
    if (h.beforeReasoning) {types.push('beforeReasoning')}
    if (h.afterReasoning) {types.push('afterReasoning')}
    if (h.beforeToolCall) {types.push('beforeToolCall')}
    if (h.afterToolCall) {types.push('afterToolCall')}
    if (h.onError) {types.push('onError')}
    if (h.onCompaction) {types.push('onCompaction')}

    lines.push(`${status} **${h.id}** (\`${h.priority}\`) — ${h.description}`)
    lines.push(`  类型: ${types.join(', ')}`)
  }
  return lines.join('\n')
}

/** 便捷获取 HookManager 单例 */
export function getHookManager(): HookManager {
  return HookManager.getInstance()
}
