// ============================================================
// orchestration/visibility.ts — 协作可见性分档（创新功能 3）
//
// 【要解决的问题：铁则一既是我们的优势，也是专业用户的黑盒】
//
// 「铁则一：用户只看到 Lumina」是产品的核心承诺：
// Yak 写代码、Recha 审代码，你在后台群聊里看不到，只有一个统一的 Lumina。
// 对普通用户，这是**保护** —— 三份思考过程是噪音，不是信息。
//
// 但对专业用户，它是**黑盒**：
//   「这个 bug 是谁改的？」「Recha 到底审了什么？」「为什么走了降级路径？」
//   看不见就无法判断结果质量，只能选择「全信」或「全不信」。
// 同类项目靠模型 trace 和依赖泳道画布解决了这个问题，代价是默认全开 ——
// 于是普通用户一上来就被一堆泳道图淹没。
//
// 【我们怎么解：同一套界面，三档可见性，运行时即时切换】
//
//   companion  陪伴模式（默认）—— 只有 Lumina。铁则一原样保留。
//   collab     协作模式      —— 展开三个 Agent 的对话流与各自产出。
//   audit      审计模式      —— 每次委派的工具调用、耗时、成本、路由依据、
//                             以及情绪收紧的完整原因链。
//
// 切换是**运行时即时**的，不重启会话、不丢上下文。
// 于是普通用户永远看不到噪音，专业用户随时能查账 —— 一个产品吃两类人。
//
// 【关键设计：过滤发生在出口，不在源头】
// 后台协作**照常运行**，只是在投递到 UI 前按档位过滤。
// 这样切档是零成本的（不需要重跑任务），也不会因为「用户看不到」
// 就悄悄少做事 —— 那会破坏铁则一原本要保证的「统一人格」完整性。
//
// 【纯函数 + 单例，零 Electron 依赖】
// ============================================================

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

export type VisibilityTier = 'companion' | 'collab' | 'audit'

export interface VisibilityMeta {
  tier: VisibilityTier
  label: string
  /** 一句话说明这一档能看到什么 */
  summary: string
  /** 面向谁 */
  audience: string
  /** 该档位下会看到的事件类型（用于文档与自检，不用于实际过滤） */
  showsEventTypes: string[]
}

export const VISIBILITY_TIERS: Record<VisibilityTier, VisibilityMeta> = {
  companion: {
    tier: 'companion',
    label: '陪伴模式',
    summary: '只有 Lumina。三个 Agent 的后台讨论对你不可见。',
    audience: '普通用户（默认）',
    // 注意 tool_start/tool_end **在陪伴模式下也在列**：
    // 「她正在用某个工具」是统一人格的一部分（也是桌宠反映真实执行状态的来源），
    // 不是协作细节。藏掉它反而会让用户不知道她在干什么。
    // 陪伴模式藏的是「谁在干」—— agent:delegate / route:decision 那一层。
    showsEventTypes: ['text', 'text_stream', 'thinking', 'tool_start', 'tool_end', 'done', 'error', 'approval:pending', 'approval:resolved', 'token_update'],
  },
  collab: {
    tier: 'collab',
    label: '协作模式',
    summary: '展开 Yak / Recha 各自的对话与产出，知道活分给了谁。',
    audience: '想了解分工的用户',
    showsEventTypes: ['text', 'text_stream', 'thinking', 'tool_start', 'tool_end', 'done', 'error', 'approval:pending', 'approval:resolved', 'token_update', 'agent:message', 'agent:delegate'],
  },
  audit: {
    tier: 'audit',
    label: '审计模式',
    summary: '额外显示每次委派的工具调用、耗时、成本、路由依据，以及情绪收紧的原因链。',
    audience: '开发者 / 调试',
    showsEventTypes: ['text', 'text_stream', 'thinking', 'tool_start', 'tool_end', 'done', 'error', 'approval:pending', 'approval:resolved', 'token_update', 'agent:message', 'agent:delegate', 'route:decision', 'gate:audit', 'cost:update', 'latency:update'],
  },
}

/** 各档位有序（从安静到吵闹），UI 用它做档位滑块 */
export const VISIBILITY_ORDER: VisibilityTier[] = ['companion', 'collab', 'audit']

// ═══════════════════════════════════════════════════════════
// 事件可见性判定
// ═══════════════════════════════════════════════════════════

/**
 * 某一事件类型在指定档位下是否应当透出到 UI。
 *
 * 三条规则，按优先级：
 *   ① 协作类事件（agent:*、route:*）在陪伴模式下一律隐藏 —— 铁则一。
 *   ② 审计类事件（gate:audit、cost:*、latency:*）在协作模式下也隐藏 ——
 *      它们是「为什么这么做」的解释，不是「谁做的」。
 *   ③ 其余事件（text / tool / approval / error）全档位可见 ——
 *      工具执行与权限审批是**安全相关**的，任何档位都不该藏。
 *
 * ⚠️ 规则 ③ 里的 approval:* 尤其重要：
 * 无论用户选哪一档，权限请求都必须弹出来。陪伴模式藏掉审批弹窗
 * 会让「情绪门控 + 权限层」在用户眼里变成一个偷偷干活的黑盒，
 * 那是安全倒退，不是体验优化。
 */
export function isEventVisible(type: string, tier: VisibilityTier): boolean {
  const order = VISIBILITY_ORDER.indexOf(tier)
  // 未知档位按最严格处理（只透出 companion 那批）
  if (order < 0) {return isVisibleAt(type, 'companion')}

  if (isVisibleAt(type, 'companion')) {return true}
  if (order >= VISIBILITY_ORDER.indexOf('collab') && isVisibleAt(type, 'collab')) {return true}
  if (order >= VISIBILITY_ORDER.indexOf('audit') && isVisibleAt(type, 'audit')) {return true}
  return false
}

function isVisibleAt(type: string, tier: VisibilityTier): boolean {
  return VISIBILITY_TIERS[tier].showsEventTypes.includes(type)
}

/**
 * 按档位过滤一批事件。
 *
 * 【为什么不原地 mutate 入参】
 * 上游可能还持有同一批对象的引用（例如事件总线也订阅着），
 * 原地删会连带把总线那份也删掉。这里一律返回新数组。
 */
export function filterByVisibility<T extends { type: string }>(
  events: T[],
  tier: VisibilityTier,
): { visible: T[]; hiddenCount: number } {
  const visible: T[] = []
  let hiddenCount = 0
  for (const e of events) {
    if (isEventVisible(e.type, tier)) {visible.push(e)}
    else {hiddenCount++}
  }
  return { visible, hiddenCount }
}

// ═══════════════════════════════════════════════════════════
// 进程级单例
// ═══════════════════════════════════════════════════════════

let currentTier: VisibilityTier = 'companion'
const listeners = new Set<(tier: VisibilityTier) => void>()

/** 取当前档位（默认陪伴模式） */
export function getVisibilityTier(): VisibilityTier {
  return currentTier
}

/**
 * 切换档位。
 *
 * @returns 实际生效的档位（非法值会回落到 companion，不抛错——
 *            一个设置项配错不该让会话崩掉）
 */
export function setVisibilityTier(tier: unknown): VisibilityTier {
  const next: VisibilityTier = (typeof tier === 'string' && tier in VISIBILITY_TIERS)
    ? (tier as VisibilityTier)
    : 'companion'
  if (next === currentTier) {return currentTier}
  currentTier = next
  for (const fn of listeners) {
    try { fn(next) } catch { /* 单个监听器出错不能影响其它监听器 */ }
  }
  return currentTier
}

/** 订阅档位变化（返回取消订阅函数） */
export function onVisibilityChange(fn: (tier: VisibilityTier) => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** 测试钩子 */
export function __resetVisibility(): void {
  currentTier = 'companion'
  listeners.clear()
}
