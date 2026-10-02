// ============================================================
// tools/agentRunContext.ts — Agent 运行上下文（AsyncLocalStorage）
//
// 工具 handler 只收到 args，拿不到"是谁在调用"。本模块在 agentRunner
// 跑一轮 ReAct 的最外层注入当前 personaId，工具内即可读到当前 owner。
//
// 为什么用 AsyncLocalStorage 而不是给 executeTool 加 context 入参：
//   executeToolWithRetry / executeToolsParallel 在 registry 里被多处调用，
//   改签名会牵动 agentRunner 一大片调用点；ALS 对现有调用零侵入。
// ============================================================

import { AsyncLocalStorage } from 'node:async_hooks'
import { normalizeRole, type RoleId } from '../rolePolicy'

/** 当前正在跑工具链的 persona（可能是 lumina/yak/recha，或 intern_<owner>_<name>） */
const storage = new AsyncLocalStorage<string>()

/**
 * 进入"agent 运行上下文"。在 runReActLoop 最外层调用一次，
 * 之后这一轮里所有 await 出来的工具调用都能读到同一个 persona。
 *
 * 用 enterWith 而非 .run(fn)：不需要包裹整个方法体，
 * 从当前同步点起，后续异步链自动继承该上下文。
 */
export function enterAgentContext(personaId: string | undefined): void {
  storage.enterWith(personaId || 'lumina')
}

/** 读取当前 persona（未设置时回退 lumina） */
export function getCurrentPersona(): string {
  return storage.getStore() || 'lumina'
}

/** 从任意 persona（含 intern_<owner>_<name>）解析出派生 owner 角色 */
export function ownerOfPersona(personaId: string | undefined | null): RoleId {
  if (!personaId) return 'lumina'
  // 子智能体：intern_<owner>_<name> → owner
  if (personaId.startsWith('intern_')) {
    const parts = personaId.split('_')
    const owner = parts[1]
    if (owner === 'lumina' || owner === 'yak' || owner === 'recha') return owner
  }
  return normalizeRole(personaId)
}

/** 当前调用方的 owner（工具内用它决定为谁招子智能体） */
export function getCurrentOwner(): RoleId {
  return ownerOfPersona(getCurrentPersona())
}
