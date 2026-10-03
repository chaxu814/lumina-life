// ============================================================
// pet/agentStateBridge.ts — 桌宠绑定真实 Agent 运行状态 (v0.1)
// ============================================================
//
// 【要解决的问题：cc-haha 没能跨过去的那条线】
// cc-haha 是唯一「成熟 Agent 编排 + 桌面宠物」兼具的项目，但它作者自己写死了边界：
//   「它只是个状态提示和跳转入口，不能替你批准权限，也不能在悬浮窗里直接提问。」
//   —— docs/desktop/pets.md
// 也就是说：**它的桌宠不反映真实执行状态，只是任务三态的指示灯。**
//
// AIRI 的表情来自模型生成的随机/情绪输出，同样**不绑定真实执行状态**。
//
// 【我们的差异化】
// Lumina 的团队里本来就有一个「在干活的角色」——Yak 写代码、热茶审查。
// 既然这些状态是真实存在的，为什么不直接让角色把它演出来？
// 于是：Agent 任务生命周期 → PetIntent（work / wait / fail / wave / idle）。
//
// 【设计原则】
// 1. **不新增 LLM 调用**。这是状态机映射，不是推理。零 token、零延迟。
// 2. **可关闭**。用户可能只想看随机情绪动画，默认开启但可关。
// 3. **有降级**。拿不到 Agent 状态时退回原有情绪驱动，不影响原有表现。
// 4. **纯函数**。映射逻辑可单测，不绑 Electron 运行时。
// ============================================================

import { getTaskBoard, type TaskNode } from '../orchestration/taskBoard'
import { getInternPool } from '../orchestration/internPool'
/** 映射到桌宠的运行态 */
export type AgentRunState =
  | 'idle'        // 没人干活 —— 待机
  | 'working'     // 正在写/改代码 —— 敲键盘
  | 'reviewing'   // 正在审查 —— 皱眉/放大镜
  | 'waiting'     // 在等人处理 —— 踱步
  | 'attention'   // 出错了/需要关注 —— 捂脸
  | 'celebrating' // 刚完成 —— 挥手

export interface AgentStateSnapshot {
  state: AgentRunState
  /** 当前在忙的成员（用于决定演谁） */
  actor: string | null
  /** 正在执行的任务标题 */
  taskTitle: string | null
  /** 本次状态持续了多久（ms），用于避免动作抖动 */
  sinceMs: number
  /** 附带的说明文字（失败原因等） */
  detail?: string
}

// ═══════════════════════════════════════════════════════════
// 状态推导
// ═══════════════════════════════════════════════════════════

/** 判定成员角色 → 演什么（审查员演审查，工程师演敲键盘） */
function stateForMember(task: TaskNode): AgentRunState {
  const assignee = (task.assignTo || '').toLowerCase()
  // 热茶是审查员（recha），她的动作是「看」不是「写」
  if (assignee === 'recha' || assignee === '热茶') return 'reviewing'
  return 'working'
}

let _lastSnapshot: AgentStateSnapshot | null = null
let _lastSnapshotAt = 0

/**
 * 从任务看板 + 实习生池推导当前真实运行态。
 *
 * 优先级：失败 > 阻塞 > 审查中 > 工作中 > 空闲。
 * 失败优先于一切，因为「出错了」是用户最需要立刻知道的信号。
 *
 * 注意：taskBoard.getTasks() 需要真实 projectId，而看板内部对项目 id 是
 * 私有 Map。所以这里用两条腿走路：先试通配（若将来开放全量查询），
 * 再退到实习生池 —— 实习生池��是真实在跑的并行任务，数据可靠。
 */
export function deriveAgentState(now = Date.now()): AgentStateSnapshot {
  let running: TaskNode[] = []
  let failed: TaskNode | null = null
  let blocked: TaskNode | null = null

  // 腿 1：任务看板（若可查询到项目）
  try {
    const board = getTaskBoard()
    for (const projectId of knownProjectIds()) {
      for (const t of board.getTasks(projectId)) {
        if (t.status === 'running') running.push(t)
        else if (t.status === 'failed' && !failed) failed = t
        else if ((t.status === 'blocked' || t.status === 'pending') && !blocked) blocked = t
      }
    }
  } catch { /* 看板不可用则只信实习生池 */ }

  // 腿 2：实习生池（并行 worker 的真实状态）
  try {
    const busy = getInternPool().getAll().filter(i => i.status === 'busy')
    for (const i of busy) {
      running.push({
        id: i.id, title: i.task || '并行任务', description: i.task || '',
        status: 'running', assignTo: i.id, dependsOn: [], result: '',
      } as unknown as TaskNode)
    }
    if (getInternPool().getAll().some(i => i.status === 'failed') && !failed) {
      failed = { title: '并行任务失败' } as unknown as TaskNode
    }
  } catch { /* 池不可用则忽略 */ }

  let snap: AgentStateSnapshot
  if (failed) {
    snap = { state: 'attention', actor: failed.assignTo || null, taskTitle: failed.title, sinceMs: 0, detail: (failed as any).error }
  } else if (running.length === 0 && blocked) {
    snap = { state: 'waiting', actor: blocked.assignTo || null, taskTitle: blocked.title, sinceMs: 0 }
  } else if (running.length > 0) {
    // 优先演审查员（更有信息量：说明有第二双眼睛在看）
    const review = running.find(t => stateForMember(t) === 'reviewing')
    const pick = review ?? running[0]
    snap = { state: stateForMember(pick), actor: pick.assignTo || null, taskTitle: pick.title, sinceMs: 0 }
  } else {
    // 全干完了：如果刚刚才结束，演一次庆祝（会自然衰减掉）
    const prev = _lastSnapshot
    if (prev && (prev.state === 'working' || prev.state === 'reviewing') && now - _lastSnapshotAt < 3000) {
      snap = { state: 'celebrating', actor: prev.actor, taskTitle: prev.taskTitle, sinceMs: 0 }
      _lastSnapshot = snap
      _lastSnapshotAt = now
      return snap
    }
    snap = idleSnapshot(now)
  }

  // 状态未变则继承 sinceMs（防止动画每 tick 重启而抖动）
  if (_lastSnapshot && _lastSnapshot.state === snap.state && _lastSnapshot.taskTitle === snap.taskTitle) {
    snap.sinceMs = now - _lastSnapshotAt
  }
  _lastSnapshot = snap
  _lastSnapshotAt = now
  return snap
}

/** 看板里已知的项目 id（尽量拿，拿不到就返回空数组只走实习生池） */
function knownProjectIds(): string[] {
  try {
    const board: any = getTaskBoard()
    const projects = board.projects
    if (projects instanceof Map) return [...projects.keys()]
    if (Array.isArray(projects)) return projects.map((p: any) => p.id).filter(Boolean)
  } catch { /* 私有字段不可访问是预期内的 */ }
  return []
}

function idleSnapshot(now: number): AgentStateSnapshot {
  return { state: 'idle', actor: null, taskTitle: null, sinceMs: _lastSnapshotAt ? now - _lastSnapshotAt : 0 }
}

/** 测试辅助 */
export function __resetAgentStateBridge(): void {
  _lastSnapshot = null
  _lastSnapshotAt = 0
}

// ═══════════════════════════════════════════════════════════
// 运行态 → PetIntent（桌宠动作）
// ═══════════════════════════════════════════════════════════

/**
 * 把运行态翻译成桌宠动作。
 *
 * 动作名对齐精灵表 8×9 规格（见 pet/spriteSheet.ts）：
 *   idle / work / wait / fail / wave
 * 这样即使还没接精灵表，Live2D/VRM 侧也能按同名 motion 处理。
 */
export function agentStateToMotion(state: AgentRunState): string {
  switch (state) {
    case 'working': return 'work'
    case 'reviewing': return 'review'
    case 'waiting': return 'wait'
    case 'attention': return 'fail'
    case 'celebrating': return 'wave'
    case 'idle':
    default: return 'idle'
  }
}

/** 附带的表情标签（供 Live2D blendShape / 精灵表表情映射使用） */
export function agentStateToExpression(state: AgentRunState): string {
  switch (state) {
    case 'working': return 'focused'    // 专注
    case 'reviewing': return 'suspicious' // 怀疑/审视
    case 'waiting': return 'bored'      // 无聊等待
    case 'attention': return 'worried'   // 担心
    case 'celebrating': return 'happy'
    case 'idle':
    default: return 'neutral'
  }
}

/** 最小驻留时间：状态至少维持这么久才切换动作，避免高频抖动 */
export const AGENT_STATE_MIN_DWELL_MS = 1200

/**
 * 是否应该把桌宠切到 agent 状态驱动。
 *
 * @param snapshot 当前运行态
 * @param now      当前时间
 * @param enabled  用户是否开启该功能（设置项）
 */
export function shouldDrivePetFromAgent(
  snapshot: AgentStateSnapshot,
  now = Date.now(),
  enabled = true,
): boolean {
  if (!enabled) return false
  // 空闲时不接管：空闲时让原有情绪系统自由表现，否则会显得呆板
  if (snapshot.state === 'idle') return false
  // 状态刚变还不足最小驻留时间：等一等
  return snapshot.sinceMs >= AGENT_STATE_MIN_DWELL_MS
}
