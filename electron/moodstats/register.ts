// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// moodstats/register.ts — 采集注册（唯一需要集成阶段接线的出口）
//
// 【为什么是这个形状】
// 本功能禁止修改任何现有共享文件（main.ts / delegationManager.ts /
// reactEngine.ts / agentRunner.toolSelection.ts…）。所以采集全部通过
// 「注入」完成：接线方把运行时对象递进来，本函数安全包裹后使用。
//
// 【接线方需要传什么（见文件末「集成清单」注释）】
//   1. store / ab：不传时用默认单例（SQLite + JSON 持久化）；
//   2. emotionReader：默认惰性 require theaterBridge.getCurrentEmotion3D；
//   3. gateReader：默认惰性包装 getEmotionAuditLog().active()；
//   4. groupReader：默认 ab.currentGroup()；
//   5. bus：可选 EventBus —— 订阅 agent:tool_end / delegate:* 事件
//      （目前这些事件没有发出方，订阅了也收不到，属于前向兼容）；
//   6. wrapTargets：要包裹的运行时方法对象列表。
//
// 【包裹纪律】所有包裹都 try/catch 兜底，采集失败绝不影响原行为。
// ============================================================

import type { SnapshotContext, SnapshotStore } from './snapshotStore'
import { createSnapshotStore, wrapToolExecutor, wrapAsyncCall } from './snapshotStore'
import type { AbGroup } from './abGroup'
import { createAbGroup } from './abGroup'
import type { EmotionReader, GateStateReader, GroupReader } from './types'

// ═══════════════════════════════════════════════════════════
// 注册输入
// ═══════════════════════════════════════════════════════════

/** 一个要被安全包裹的运行时方法 */
export interface WrapTarget {
  /** 持有方法的运行时对象（会被就地修改：obj[method] = wrapped） */
  obj: any
  /** 方法名 */
  method: string
  /** 语义类型 */
  kind: 'tool' | 'delegate'
  /** 委托元信息（delegate 时必填） */
  agentId?: string
  targetAgent?: string | null
  action?: string
  /** 从返回值提取 ok/error/retries（委托结果结构各异） */
  extractResult?: (r: any) => { ok: boolean; errorSummary?: string | null; retries?: number }
}

export interface RegisterMoodStatsOptions {
  store?: SnapshotStore
  ab?: AbGroup
  emotionReader?: EmotionReader
  gateReader?: GateStateReader
  groupReader?: GroupReader
  now?: () => number
  /** EventBus 形状：on(type, handler) 返回取消函数 */
  bus?: { on: (type: string, h: (payload: any) => void) => () => void } | null
  /** 要包裹的运行时方法（见上方 WrapTarget） */
  wrapTargets?: WrapTarget[]
  /** 工具执行器包裹（等价于 wrapTargets 里 kind='tool' 的简写） */
  toolExecutor?: { register: (wrapped: (...a: any[]) => Promise<any>) => void }
}

export interface MoodStatsHandle {
  store: SnapshotStore
  ab: AbGroup
  ctx: SnapshotContext
  /** 注销：把所有包裹恢复成原方法 */
  unwrap(): void
}

// ═══════════════════════════════════════════════════════════
// 默认 reader（惰性 require，避免主进程加载期循环依赖 / 测试环境加载 electron）
// ═══════════════════════════════════════════════════════════

function defaultEmotionReader(): EmotionReader {
  return () => {
    try {
      // theaterBridge 在主进程可用；require 失败（测试环境）→ null
      const tb = require('../orchestration/theaterBridge')
      if (typeof tb?.getCurrentEmotion3D === 'function') {
        return tb.getCurrentEmotion3D()
      }
    } catch { /* 读不到情绪 → 快照里情绪字段为 null */ }
    return null
  }
}

function defaultGateReader(): GateStateReader {
  return () => {
    try {
      const audit = require('../orchestration/emotionAudit')
      if (audit?.getEmotionAuditLog) {
        const active = audit.getEmotionAuditLog().active()
        return {
          on: true,
          suppressed: active.flatMap((r: any) => r.suppressed?.map((x: any) => x.tool) ?? []),
          rules: active.flatMap((r: any) => r.rules ?? []),
        }
      }
    } catch { /* 审计读不到 → 不影响记录 */ }
    return { on: true, suppressed: [], rules: [] }
  }
}

// ═══════════════════════════════════════════════════════════
// 注册
// ═══════════════════════════════════════════════════════════

let singleton: MoodStatsHandle | null = null

/**
 * 注册 Mood × Productivity 采集。幂等：重复调用返回同一个 handle，
 * 并在再次注册时先撤销上一次的包裹（防止重复包裹）。
 */
export function registerMoodStats(opts: RegisterMoodStatsOptions = {}): MoodStatsHandle {
  if (singleton) {
    singleton.unwrap()
    singleton = null
  }

  const store = opts.store ?? createSnapshotStore()
  const ab = opts.ab ?? createAbGroup()
  const ctx: SnapshotContext = {
    emotion: opts.emotionReader ?? defaultEmotionReader(),
    gate: opts.gateReader ?? defaultGateReader(),
    group: opts.groupReader ?? (() => ab.currentGroup()),
    now: opts.now,
  }

  const restorers: Array<() => void> = []

  // ── 事件订阅（前向兼容：发方接上以后自动开始收数）──
  if (opts.bus) {
    try {
      const off1 = opts.bus.on('agent:tool_end', (p: any) => {
        // 事件形状未定：尽量从常见字段取；取不到就跳过（不编造记录）
        try {
          store.insert({
            ts: Date.now(),
            kind: 'tool',
            agentId: String(p?.agentId ?? p?.personaId ?? 'unknown'),
            targetAgent: null,
            action: String(p?.toolName ?? p?.name ?? 'unknown'),
            ...emotionOfCtx(ctx),
            ...gateOfCtx(ctx),
            group: ctx.group(),
            ok: !!p?.ok,
            errorSummary: p?.ok ? null : String(p?.error ?? '').slice(0, 300) || null,
            retries: 0,
            durationMs: Number(p?.durationMs ?? 0) || 0,
          } as any)
        } catch { /* 事件处理失败静默 */ }
      })
      restorers.push(off1)
    } catch { /* bus.on 失败不影响其余注册 */ }
  }

  // ── 运行时方法包裹 ──
  for (const t of opts.wrapTargets ?? []) {
    try {
      if (!t.obj || typeof t.method !== 'string' || typeof t.obj[t.method] !== 'function') {
        continue
      }
      const original = t.obj[t.method]
      if (t.kind === 'tool') {
        t.obj[t.method] = wrapToolExecutor(original, ctx, store, t.agentId ?? 'unknown')
      } else {
        t.obj[t.method] = wrapAsyncCall(original, ctx, store, {
          agentId: t.agentId ?? 'unknown',
          targetAgent: t.targetAgent ?? null,
          action: t.action ?? t.method,
          extractResult: t.extractResult,
        })
      }
      restorers.push(() => { t.obj[t.method] = original })
    } catch { /* 单个包裹失败不影响其余 */ }
  }

  const handle: MoodStatsHandle = {
    store,
    ab,
    ctx,
    unwrap() {
      for (const r of restorers) {
        try { r() } catch { /* 恢复失败尽量继续 */ }
      }
    },
  }
  singleton = handle
  return handle
}

function emotionOfCtx(ctx: SnapshotContext) {
  try {
    const e = ctx.emotion()
    if (e) {return { mood: e.mood, energy: e.energy, affinity: e.affinity ?? null }}
  } catch { /* ignore */ }
  return { mood: null, energy: null, affinity: null }
}

function gateOfCtx(ctx: SnapshotContext) {
  try {
    const g = ctx.gate()
    return { gateOn: g.on, gateSuppressed: [...g.suppressed], gateRules: [...g.rules] }
  } catch {
    return { gateOn: true, gateSuppressed: [] as string[], gateRules: [] as string[] }
  }
}

/** 测试钩子 / 集成卸载用 */
export function __resetMoodStats(): void {
  try { singleton?.unwrap() } catch { /* ignore */ }
  singleton = null
}

/** 给 IPC 层取当前注册的 handle（未注册返回 null） */
export function __getMoodStatsHandle(): MoodStatsHandle | null {
  return singleton
}

// ═══════════════════════════════════════════════════════════
// 集成清单（给后续接线阶段 —— 见任务交付回复的同款清单）
// ═══════════════════════════════════════════════════════════
//
// 【main.ts 启动处（或任意已初始化好运行时对象的位置）】
//   import { registerMoodStats } from './moodstats/register'
//   import { registerMoodStatsIpc } from './moodstats/ipc'
//   registerMoodStatsIpc()              // IPC 频道
//   registerMoodStats({                 // 采集（传运行时对象）
//     wrapTargets: [
//       // 工具执行：包裹 tools/registry 导出的 executeToolWithRetry
//       // （注意 ESM 具名导出不可改，接线时应在调用方模块持有引用的位置包裹，
//       //   或在 agentRunner / reactEngine 已有 this. 的对象上包）
//       { obj: registryModule, method: 'executeToolWithRetry', kind: 'tool', agentId: 'lumina' },
//       // 委托：delegationManager 实例上的 delegate / phaseGatedDelegate / spawnSubagent
//       { obj: delegationManagerInstance, method: 'delegate', kind: 'delegate',
//         agentId: 'lumina', action: 'delegate',
//         extractResult: (r) => ({ ok: !!r?.success, errorSummary: r?.error ?? null }) },
//     ],
//   })
//
// 【agentRunner.toolSelection.ts:260 —— 门控开关读点，套一层 A/B 干预】
//   emotionGatingOn = readFeatureFlag('emotionGating', true)
//     → 改成交给 moodstats 决议（本功能不修改此文件，由集成阶段做）：
//     emotionGatingOn = moodstatsHandle.ab.resolveGateFeature(readFeatureFlag('emotionGating', true))
//
// 【preload.ts contextBridge 白名单（见 ipc.ts 头注释）】
//
