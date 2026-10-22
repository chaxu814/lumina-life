// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// cuCrew.ts — Computer Use 三人组：操作员 / 观察员 / 安全员 (v3.33)
//
// 常见实现只有一个 agent 操作电脑。Lumina 把团队协作搬进 CU：
//   操作员（operator）：执行动作（现有 cuCore / 回放 / VLM 决策）
//   安全员（safety）  ：cuPermissions 权限门（白名单/分区/会话锁/人机互斥）
//   观察员（observer）：每步之后核对画面是否真的变了、有没有连续误点
//
// 本模块是观察员的纯策略状态机（可单测、不碰系统）：
//   - 安全员拒绝 → 立即中止（一票否决）
//   - 变更类动作后画面无变化 → 记一次「未命中」，连续 2 次中止
//   - 连续 2 次动作失败 → 中止，上报 Lumina 重看屏幕
//   - 滚动/等待等非变更动作不要求画面变化
// ============================================================

export type CrewActionKind =
  | 'click' | 'double_click' | 'drag' | 'type' | 'keypress' | 'set_value'
  | 'scroll' | 'hover' | 'open' | 'close' | 'wait' | 'other'

export type CrewZone = 'browser' | 'terminal' | 'ide' | 'other'

export interface CrewStepInput {
  actionKind: CrewActionKind
  zone?: CrewZone
  /** 安全员（cuPermissions）是否拒绝 */
  denied?: boolean
  denyReason?: string
  /** 动作本身是否成功（cuCore 返回 ok） */
  ok: boolean
  /** 观察员：动作前后帧是否检测到变化（dHash）；未知传 undefined */
  changed?: boolean
  /** 失败原因（动作失败/无变化） */
  reason?: string
}

export type CrewVerdict = 'proceed' | 'reobserve' | 'abort'

export interface CrewStepResult {
  verdict: CrewVerdict
  reason: string
  state: CrewState
}

export interface CrewState {
  steps: number
  consecutiveNoChange: number
  consecutiveFail: number
  deniedCount: number
  aborted?: string
}

export function newCrewState(): CrewState {
  return { steps: 0, consecutiveNoChange: 0, consecutiveFail: 0, deniedCount: 0 }
}

/** 哪些动作必须引起画面变化（否则视为未命中） */
export function expectsChange(kind: CrewActionKind): boolean {
  return kind !== 'scroll' && kind !== 'hover' && kind !== 'wait'
}

/**
 * 纯函数：根据当前状态 + 本步结果，给出 crew 裁决。
 * 中止永远是安全侧（宁可停下来让 Lumina 重看，也不连环误点）。
 */
export function crewStep(state: CrewState, input: CrewStepInput): CrewStepResult {
  const next: CrewState = {
    ...state,
    steps: state.steps + 1,
    consecutiveNoChange: state.consecutiveNoChange,
    consecutiveFail: state.consecutiveFail,
    deniedCount: state.deniedCount,
  }

  // 1) 安全员一票否决
  if (input.denied) {
    next.deniedCount += 1
    next.aborted = `安全员拒绝动作（${input.denyReason || '权限门'}），CU 三人组中止`
    return { verdict: 'abort', reason: next.aborted, state: next }
  }

  // 2) 动作执行失败：连续 2 次中止
  if (!input.ok) {
    next.consecutiveFail += 1
    if (next.consecutiveFail >= 2) {
      next.aborted = `连续 ${next.consecutiveFail} 次动作失败（${input.reason || '未知原因'}），中止并上报 Lumina 重看屏幕`
      return { verdict: 'abort', reason: next.aborted, state: next }
    }
    return { verdict: 'reobserve', reason: '动作失败，观察员要求重新截图核对后再试', state: next }
  }

  // 3) 变更类动作但画面无变化：连续 2 次中止
  if (expectsChange(input.actionKind) && input.changed === false) {
    next.consecutiveNoChange += 1
    if (next.consecutiveNoChange >= 2) {
      next.aborted = `连续 ${next.consecutiveNoChange} 个变更动作未引起画面变化，疑似点空/界面无响应，中止`
      return { verdict: 'abort', reason: next.aborted, state: next }
    }
    return { verdict: 'reobserve', reason: '动作后画面无变化，重新 desktop_see 定位再继续', state: next }
  }

  // 4) 正常：计数归零
  next.consecutiveFail = 0
  if (input.changed === true) {next.consecutiveNoChange = 0}
  return { verdict: 'proceed', reason: '继续', state: next }
}

/** 把动作名映射到 crew 动作类型（cuCore action 名 → CrewActionKind） */
export function actionKindOf(name: string): CrewActionKind {
  const n = String(name || '').toLowerCase()
  if (n.includes('double')) {return 'double_click'}
  if (n.includes('click') || n === 'click') {return 'click'}
  if (n.includes('drag')) {return 'drag'}
  if (n.includes('type') || n.includes('paste')) {return 'type'}
  if (n.includes('key') || n.includes('press')) {return 'keypress'}
  if (n.includes('value')) {return 'set_value'}
  if (n.includes('scroll') || n.includes('wheel')) {return 'scroll'}
  if (n.includes('hover') || n.includes('move')) {return 'hover'}
  if (n.includes('open') || n.includes('launch')) {return 'open'}
  if (n.includes('close') || n.includes('quit')) {return 'close'}
  if (n.includes('wait') || n.includes('sleep')) {return 'wait'}
  return 'other'
}

/** 三人组执行报告（工具/UI 展示） */
export function formatCrewReport(state: CrewState): string {
  if (state.aborted) {
    return `🛑 CU 三人组中止：${state.aborted}（共执行 ${state.steps} 步，拒绝 ${state.deniedCount} 次）`
  }
  return `✅ CU 三人组完成 ${state.steps} 步（无变化误点 ${state.consecutiveNoChange}，失败 ${state.consecutiveFail}，拒绝 ${state.deniedCount}）`
}
