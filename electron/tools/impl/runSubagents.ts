// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tools/impl/runSubagents.ts — 主动派生并行子智能体
//
// 当一个 owner（lumina/yak/recha）手里有多个彼此独立、可并行的子任务时，
// 调用本工具：为 owner 招 N 个 intern（用完即走），并行派给 DelegationManager
// 执行，无论成败最后在 finally 里 fire 全部 intern（不残留跨任务上下文）。
//
// 子智能体权限 = owner 的权限边界（rolePolicy）：
//   - yak intern：可读写、可跑命令
//   - recha intern：只读、做审查
//   - lumina intern：全量
// ============================================================

import type { ToolDef, ToolResult } from '../types'
import type { RoleId } from '../../rolePolicy'
import { getCurrentOwner } from '../agentRunContext'
import { getInternPool, type Intern } from '../../orchestration/internPool'
// 注意：getDelegationManager 会拉起重依赖链（agentRunner → registerAllTools → electron.app），
// 顶层 import 会让本模块在 node 单测环境里加载即崩。改为 handler 内惰性 require。

// ── 可测核心：依赖全部可注入 ──────────────────────────────────

export interface ParallelSubtask {
  title: string
  description: string
  deliverable?: string
}

/** 注入依赖（生产用 internPool + DelegationManager；测试用 mock） */
export interface SubagentRunDeps {
  hire: () => Intern | null
  assign: (internId: string, task: string, sessionId?: string) => boolean
  complete: (internId: string, result: string) => void
  fail: (internId: string, error: string) => void
  fire: (internId: string) => boolean
  /** 把任务真正路由给 intern 执行（走修好的 delegation） */
  delegate: (owner: RoleId, internId: string, task: string) => Promise<{
    success: boolean
    content?: string
    error?: string
  }>
}

export interface SubagentOutcome {
  title: string
  internId: string | null
  status: 'done' | 'error' | 'skipped'
  detail: string
}

/**
 * 并行跑一组子任务。
 * - 池满 hire() 返回 null → 优雅降级（该子任务标记 skipped，不崩）
 * - try/finally：无论成功/部分失败/整体抛错，已招的 intern 全部 fire
 */
export async function executeParallelSubagents(
  owner: RoleId,
  subtasks: ParallelSubtask[],
  context: string | undefined,
  deps: SubagentRunDeps,
  /** 归属会话；透传给 internPool.assign，最终带到前端卡片，用于按会话过滤 */
  sessionId?: string,
): Promise<{ ok: boolean; content: string; outcomes: SubagentOutcome[]; hiredCount: number }> {
  const hired: string[] = []

  async function runOne(st: ParallelSubtask): Promise<SubagentOutcome> {
    // 1. 招人
    const intern = deps.hire()
    if (!intern) {
      return { title: st.title, internId: null, status: 'skipped', detail: '子智能体池已满，本次跳过（未执行）' }
    }
    hired.push(intern.id)

    // 2. 派活
    deps.assign(intern.id, st.description, sessionId)

    // 3. 执行
    try {
      const taskText =
        `${st.title}\n${st.description}` +
        (st.deliverable ? `\n交付物要求：${st.deliverable}` : '') +
        (context ? `\n共享上下文：${context}` : '')

      const r = await deps.delegate(owner, intern.id, taskText)
      if (r.success) {
        deps.complete(intern.id, r.content || '')
        return { title: st.title, internId: intern.id, status: 'done', detail: r.content || '(无返回内容)' }
      }
      deps.fail(intern.id, r.error || '执行失败')
      return { title: st.title, internId: intern.id, status: 'error', detail: r.error || '执行失败' }
    } catch (err: any) {
      const msg = err?.message || String(err)
      try { deps.fail(intern.id, msg) } catch { /* 收作业失败不阻断清理 */ }
      return { title: st.title, internId: intern.id, status: 'error', detail: msg }
    }
  }

  const outcomes: SubagentOutcome[] = []
  try {
    // 并行：子任务彼此独立，用 allSettled 互不影响
    const settled = await Promise.allSettled(subtasks.map(runOne))
    for (const s of settled) {
      if (s.status === 'fulfilled') {outcomes.push(s.value)}
      else {outcomes.push({ title: '(未知)', internId: null, status: 'error', detail: String(s.reason) })}
    }
  } finally {
    // 用完即走：无论成败，全部 fire，不残留跨任务上下文
    for (const id of hired) {
      try { deps.fire(id) } catch { /* fire 失败不阻断返回 */ }
    }
  }

  const done = outcomes.filter(o => o.status === 'done').length
  const errs = outcomes.filter(o => o.status === 'error').length
  const skipped = outcomes.filter(o => o.status === 'skipped').length
  const ok = errs === 0 && outcomes.length > 0

  const lines = outcomes.map(o => {
    const icon = o.status === 'done' ? '✅' : o.status === 'error' ? '❌' : '⏭️'
    return `${icon} [${o.title}] ${o.detail.slice(0, 300)}`
  }).join('\n')

  const content =
    `并行子任务完成（owner=${owner}）：${done} 成功 / ${errs} 失败 / ${skipped} 跳过，共 ${hired.length} 个子智能体已全部释放。\n\n${lines}`

  return { ok, content, outcomes, hiredCount: hired.length }
}

// ── ToolDef + handler ───────────────────────────────────────

/** 子智能体执行的任务类型按 owner 角色派生（影响 DelegationManager 的路由/上下文）。 */
export function taskTypeForOwner(owner: RoleId): string {
  switch (owner) {
    case 'recha':
      // 热茶派生的只读子智能体：做审查/核对
      return 'code_review'
    case 'yak':
      // Yak 派生的子智能体：编码闭环
      return 'code_write'
    case 'lumina':
    default:
      // 老大派生的全量子智能体：通用执行
      return 'code_write'
  }
}

export const runSubagentsDef: ToolDef = {
  name: 'run_subagents',
  description:
    '🚀 并行派生多个子智能体，同时处理多个彼此独立、可并行的子任务。\n' +
    '什么时候用：当你手里有 N 个互相独立（无前后依赖）、可以同时推进的子任务时，调用本工具一次性并行处理，比串行逐个委托快得多。\n' +
    '子智能体权限与你相同（继承你的角色边界）、用完即走、不保留跨任务上下文。\n' +
    '不适用：有前后依赖的任务（必须先 A 后 B）请用 delegate_to 串行；单一任务直接自己做或委托单个成员。',
  params: {
    subtasks: {
      type: 'array',
      description:
        '子任务数组，每项 {title, description, deliverable?}：\n' +
        '  - title: 子任务标题（简短）\n' +
        '  - description: 子任务详细说明\n' +
        '  - deliverable: 可选，期望的交付物',
      required: true,
    },
    context: {
      type: 'string',
      description: '可选的共享上下文（相关文件路径、用户原话、背景），会附加给每个子智能体。',
      required: false,
    },
  },
  // v3.34: 标记为「不可用于子 Agent」。
  // 工具层堵递归委托：子 Agent 拿不到派生类工具，A→B→A 的无限自我派生
  // 在源头就不成立。此前该机制存在但没有任何工具声明过 true，闸门是空转的。
  blockedInChild: true,
  // v3.34: 委托类工具的真实耗时远超默认 60s。
  // 依据：首次真实跑打包版时观察到 —— 委托会 fork 子 Agent 跑完整 ReAct，
  // 必要时再触发 v9.0 自动验证（真的执行 npx tsc + npx vitest），60s 必然打满；
  // 而「超时」不等于「停止」（Promise.race 只让调用方不再等，底层 promise 继续跑），
  // 于是重试会再开一条完整委托链，后台同时跑着两条。
  timeoutMs: 900000,
  toolsets: ['team', 'agent', 'developer'],
}

export async function runSubagents(args: Record<string, any>): Promise<ToolResult> {
  const callId = `run-subagents-${Date.now()}`
  const raw = args.subtasks

  // 参数校验
  if (!Array.isArray(raw) || raw.length === 0) {
    return { callId, ok: false, content: '', error: 'subtasks 必须是非空数组，每项含 title/description。' }
  }
  const subtasks: ParallelSubtask[] = raw
    .map((s: any) => ({
      title: String(s?.title || '(未命名)'),
      description: String(s?.description || s?.title || ''),
      deliverable: s?.deliverable ? String(s.deliverable) : undefined,
    }))
    .filter((s: ParallelSubtask) => s.description.trim().length > 0)

  if (subtasks.length === 0) {
    return { callId, ok: false, content: '', error: '没有有效的子任务（每项需有 description）。' }
  }

  const owner = getCurrentOwner()
  const pool = getInternPool(owner)
  // 惰性 require：避免顶层加载拉起 agentRunner 重依赖链
  const { getDelegationManager } = require('../../delegationManager') as typeof import('../../delegationManager')
  const dm = getDelegationManager()
  const taskType = taskTypeForOwner(owner)

  const deps: SubagentRunDeps = {
    hire: () => pool.hire(),
    assign: (id, task, sessionId) => pool.assign(id, task, undefined, sessionId),
    complete: (id, result) => pool.complete(id, result),
    fail: (id, err) => pool.fail(id, err),
    fire: (id) => pool.fire(id),
    delegate: (from, internId, task) =>
      dm.delegate(from, { to: internId, task, taskType, context: '' } as any)
        .then((r: any) => ({ success: !!r.success, content: r.content, error: r.error })),
  }

  try {
    const result = await executeParallelSubagents(owner, subtasks, args.context, deps, args.__sessionId)
    return { callId, ok: result.ok, content: result.content, error: result.ok ? undefined : result.content }
  } catch (err: any) {
    return { callId, ok: false, content: '', error: `并行子任务异常: ${err?.message || String(err)}` }
  }
}
