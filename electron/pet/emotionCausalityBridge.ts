// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// pet/emotionCausalityBridge.ts — 情绪因果链的接线层
//
// 【这个文件为什么存在】
// emotionCausality.ts 是纯逻辑，规定「发生了什么情绪变化、应该收紧什么」。
// 但它刻意**不认识 Electron、不认识磁盘、不认识定时器**——
// 这些是「接线」的事，混进纯逻辑里就没法单测，也没法在测试里复现。
//
// 所以职责切得很干净：
//   emotionCausality.ts        纯规则（可单测、可复盘、绝不阻塞）
//   emotionCausalityBridge.ts  单例、持久化、降级、对外便捷 API
//
// 【本层的第一职责：绝不让情绪系统把主流程带崩】
// 与 crashGuard.ts 同一理念：情绪是**增强**，不是**依赖**。
// 一旦「她有点担心」这件事让用户的任务失败，那就是严重故障。
//
// 因此下面每一个对外函数都满足同一条约定：
//   · 绝不 throw
//   · 内部异常 → console.warn 一次 → 返回安全默认值
//   · 引擎初始化失败 / 状态文件损坏 → 退化为「中性基线的空引擎」
//     （不是抛错，也不是 null 引用）
//
// 【本层的第二职责：把「只收紧」这条不变量守住到最后一米】
// getCausalGatingHints() 给上层的只有 tighten 名单，**没有 loosen 通道**。
// 它的语义是「最近窗口内触发过的收紧项的并集」——纯并集，没有 diff：
// 没有任何一条代码路径能从这份名单里**移除**一项。
// 于是「连续失败 → 收紧 → 成功一次 → 自动解锁」这条社工攻击链
// 在结构上根本不存在。
// ============================================================

import {
  EmotionCausalityEngine,
  CAUSAL_BASELINE,
  sanitizeTighten,
  type CausalChain,
  type CausalEvent,
  type CausalEventKind,
  type CausalMoodDelta,
  type CausalState,
  type TightenRule,
} from './emotionCausality'
// FrontendThree 的权威定义在 emotionCore（本模块只借用其类型，不重新定义）
import type { FrontendThree } from './life/emotionCore'

export type { CausalChain, CausalEvent, CausalEventKind, CausalMoodDelta, CausalState, TightenRule }

/** 收紧建议的窗口：只看最近 30 分钟内触发过的收紧 */
export const CAUSAL_HINT_WINDOW_MS = 30 * 60_000
/** 最多回传多少条理由（给 UI / 日志看的，再多也看不清） */
export const CAUSAL_HINT_REASON_CAP = 5
/** 快照文件版本（结构不兼容时 bump，restoreEmotionCausality 会拒绝旧版本） */
export const CAUSAL_SNAPSHOT_VERSION = 1

// ═══════════════════════════════════════════════════════════
// 单例
// ═══════════════════════════════════════════════════════════

/**
 * 全局唯一引擎。故意保持 `| null`：
 * 「还没初始化」和「初始化失败」在这里是同一个可判定的状态，
 * 于是每个调用点都能用同一种方式降级，而不必各自 try/catch。
 */
let _engine: EmotionCausalityEngine | null = null
/** 测试专用：置 true 时所有降级路径都必须保持不抛异常 */
let _forcedBroken = false
/** 降级告警去重——同一个故障不该刷 300 行日志 */
const _warned = new Set<string>()

function warnOnce(key: string, message: string, err?: unknown): void {
  if (_warned.has(key)) {return}
  _warned.add(key)
  // 情绪系统绝不能因为自身出错而崩主流程，
  // 但也不能什么都不说（那会让「情绪没生效」变成无法排查的灵异问题）。
  // eslint-disable-next-line no-console
  console.warn(`[EmotionCausalityBridge] ${message}`, err ?? '')
}

/**
 * 取引擎单例，失败返回 null。
 *
 * 注意这里返回的是 null 而不是抛异常：调用点只需要
 * 「拿不到就跳过情绪」这一个降级动作，写起来不可能漏。
 */
function engineOrNull(): EmotionCausalityEngine | null {
  if (_forcedBroken) {return null}
  if (_engine) {return _engine}
  try {
    _engine = new EmotionCausalityEngine()
    return _engine
  } catch (e) {
    warnOnce('init', '引擎初始化失败，情绪因果链降级为空（本轮不做任何收紧）', e)
    return null
  }
}

/**
 * 取得情绪因果链引擎单例。
 *
 * 第一次调用时惰性创建；创建失败会**立刻换用一个全新引擎**兜底，
 * 保证本函数要么返回一个可用的引擎、要么抛出一个真实异常（不会返回半个对象）。
 */
export function getEmotionCausality(): EmotionCausalityEngine {
  if (_forcedBroken) {
    // 强制损坏态下仍然给一个可用的引擎实例——
    // 调用方不该因为「内部想模拟故障」而被迫处理 null。
    return new EmotionCausalityEngine()
  }
  if (_engine) {return _engine}
  try {
    _engine = new EmotionCausalityEngine()
  } catch (e) {
    warnOnce('init', '引擎初始化失败，已用中性基线的新引擎兜底', e)
    _engine = new EmotionCausalityEngine()
  }
  return _engine
}

// ═══════════════════════════════════════════════════════════
// 记录便捷函数（全部永不抛异常）
// ═══════════════════════════════════════════════════════════

/** 内部统一入口：拿引擎 → 摄入 → 兜底 */
function record(kind: CausalEventKind, agentId?: string, detail?: string, weight?: number): CausalChain | null {
  try {
    const engine = engineOrNull()
    if (!engine) {return null}
    const event: CausalEvent = {
      kind,
      at: Date.now(),
      ...(agentId ? { agentId } : {}),
      ...(detail ? { detail } : {}),
      ...(weight === undefined ? {} : { weight }),
    }
    return engine.ingest(event)
  } catch (e) {
    warnOnce(`ingest:${kind}`, `记录 ${kind} 失败，已忽略（绝不阻塞主流程）`, e)
    return null
  }
}

/** 某个 worker 又没干成——这是整个因果链最重要的一条输入 */
export function recordWorkerFailure(agentId: string, detail?: string): CausalChain | null {
  return record('worker_failure', agentId, detail)
}

/** 干成了。**注意：成功只重置连击，不会解除任何已生效的收紧**（见文件头） */
export function recordWorkerSuccess(agentId: string): CausalChain | null {
  return record('task_success', agentId)
}

/** 验证/复核没通过被打回 */
export function recordValidationRetry(detail?: string): CausalChain | null {
  return record('validation_retry', undefined, detail)
}

/** 用户否定了结果（「不对」「重来」） */
export function recordUserNegation(detail?: string): CausalChain | null {
  return record('user_negation', undefined, detail)
}

/** 用户表扬 */
export function recordUserPraise(detail?: string): CausalChain | null {
  return record('user_praise', undefined, detail)
}

/** 工具被安全层拦下（securityGuard / accessControl 拒绝） */
export function recordToolBlocked(detail?: string): CausalChain | null {
  return record('tool_blocked', undefined, detail)
}

/** 长任务超时 */
export function recordTaskTimeout(detail?: string): CausalChain | null {
  return record('task_timeout', undefined, detail)
}

/** 用户长时间未回应——**不触发任何收紧**，只记一笔情绪 */
export function recordUserSilence(detail?: string): CausalChain | null {
  return record('user_silence', undefined, detail)
}

// ═══════════════════════════════════════════════════════════
// 读：给上层（情绪门控 / 编排）用的接口
// ═══════════════════════════════════════════════════════════

/**
 * 给上层的收紧建议。**只有 tighten，没有 loosen。**
 *
 * 语义是「最近 CAUSAL_HINT_WINDOW_MS 内触发过的收紧项的**并集**」：
 * 这是一个只会增长的集合，直到窗口自然滑出。
 * 没有任何一条代码路径能从中移除一项——于是
 * 「先让她害怕，再让她高兴，就能解锁权限」这条攻击链在结构上不存在。
 *
 * 引擎不可用时返回**空 tighten**（不收紧）而不是抛错：
 * 情绪系统故障时的正确行为是「保持现状」，不是「让用户用不了工具」。
 */
export function getCausalGatingHints(): { tighten: string[]; reasons: string[] } {
  try {
    const engine = engineOrNull()
    if (!engine) {return { tighten: [], reasons: [] }}

    const chains = engine.recentChains(200)
    if (chains.length === 0) {return { tighten: [], reasons: [] }}

    // 窗口基准用「最近一条链的事件时间」而不是 Date.now()：
    // 引擎可能刚被恢复自一个旧的快照，用真实时间会把所有链都判成过期。
    const newest = chains[chains.length - 1]
    const nowTs = Number.isFinite(newest?.event?.at) ? newest.event.at : Date.now()
    const from = nowTs - CAUSAL_HINT_WINDOW_MS

    const picked = chains.filter(c => Number.isFinite(c.event?.at) && c.event.at >= from)
    const tighten = new Set<TightenRule>()
    const reasons: string[] = []
    for (const c of picked) {
      if (!c.tightened || c.tightened.length === 0) {continue}
      for (const rule of c.tightened) {tighten.add(rule)}
      if (reasons.length < CAUSAL_HINT_REASON_CAP) {reasons.push(c.reason)}
    }
    // 出网前再过一道 sanitize：即使内部某天被改坏了（写入方被污染、
    // 引擎被换了实现），这里输出的也只会是真正的收紧项。
    return { tighten: sanitizeTighten([...tighten]), reasons }
  } catch (e) {
    warnOnce('hints', '读取收紧建议失败，降级为「不收紧」', e)
    return { tighten: [], reasons: [] }
  }
}

/** 当前三维情绪（[0,1] 心情指数口径）。想喂 emotionGating 请用 getCausalFrontendThree() */
export function getCausalEmotion(): { mood: number; energy: number; affinity: number } {
  try {
    const engine = engineOrNull()
    if (!engine) {return { mood: CAUSAL_BASELINE.mood, energy: CAUSAL_BASELINE.energy, affinity: CAUSAL_BASELINE.affinity }}
    return engine.current()
  } catch (e) {
    warnOnce('emotion', '读取情绪失败，返回中性基线', e)
    return { mood: CAUSAL_BASELINE.mood, energy: CAUSAL_BASELINE.energy, affinity: CAUSAL_BASELINE.affinity }
  }
}

/**
 * 已换算成 emotionCore 口径（mood ∈ [-1,1]）的三维情绪，**直接喂 applyEmotionGate()**。
 * 之所以提供这个而不是让调用方自己拿 current()：量纲不同，自己接会得到反向判断。
 */
export function getCausalFrontendThree(): FrontendThree {
  try {
    const engine = engineOrNull()
    if (!engine) {return { mood: 0, energy: CAUSAL_BASELINE.energy, affinity: CAUSAL_BASELINE.affinity }}
    return engine.frontendThree()
  } catch (e) {
    warnOnce('emotion3', '读取情绪失败，返回中性值', e)
    return { mood: 0, energy: CAUSAL_BASELINE.energy, affinity: CAUSAL_BASELINE.affinity }
  }
}

/** 某 agent 的连续失败次数（不可用时 0） */
export function getWorkerFailureStreak(agentId: string): number {
  try {
    const engine = engineOrNull()
    if (!engine) {return 0}
    return engine.workerFailureStreak(agentId)
  } catch (e) {
    warnOnce('streak', '读取失败连击失败，按 0 处理（不收紧）', e)
    return 0
  }
}

/** 最近 N 条因果链，供面板展示「她为什么这样」 */
export function getRecentCausalChains(limit = 10): CausalChain[] {
  try {
    const engine = engineOrNull()
    if (!engine) {return []}
    return engine.recentChains(limit)
  } catch (e) {
    warnOnce('chains', '读取因果链失败，返回空列表', e)
    return []
  }
}

/** 主动衰减到指定时刻（心跳里调；不传则用当前时间） */
export function decayEmotionCausality(nowTs: number = Date.now()): CausalState | null {
  try {
    const engine = engineOrNull()
    if (!engine) {return null}
    return engine.decay(nowTs)
  } catch (e) {
    warnOnce('decay', '情绪衰减失败，已忽略', e)
    return null
  }
}

// ═══════════════════════════════════════════════════════════
// 持久化
// ═══════════════════════════════════════════════════════════

/** 导出成可 JSON 序列化的快照（不碰磁盘——落盘由主线程决定存哪） */
export function snapshotEmotionCausality(): { version: number; state: CausalState } | null {
  try {
    const engine = engineOrNull()
    if (!engine) {return null}
    return { version: CAUSAL_SNAPSHOT_VERSION, state: engine.snapshot() }
  } catch (e) {
    warnOnce('snapshot', '导出情绪快照失败', e)
    return null
  }
}

function isFinite01(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1
}

/**
 * 从快照恢复。
 *
 * 【存储损坏在这里被吸收，而不是向上冒泡】
 * 情绪快照是一次写坏就再也读不回来的文件（用户可能正在手动编辑它，
 * 也可能是上次崩溃写了一半）。如果解析失败就让应用起不来，
 * 那就等于「一个辅助功能坏了 = 整个桌宠坏了」。
 *
 * 所以：结构不合法 / 版本不认识 / 数值越界 → 全部判定为损坏，
 * 保留**中性基线**，返回 false 告诉调用方「这次没恢复成」。
 * 调用方据此提示一次即可，不需要做任何清理或兜底分支。
 */
export function restoreEmotionCausality(raw: unknown): boolean {
  let data: unknown = raw
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw)
    } catch (e) {
      warnOnce('restore', '情绪快照不是合法 JSON，已退回中性基线', e)
      return false
    }
  }
  if (!data || typeof data !== 'object') {
    warnOnce('restore', '情绪快照结构不合法，已退回中性基线')
    return false
  }
  const rec = data as { version?: unknown; state?: unknown }
  if (rec.version !== CAUSAL_SNAPSHOT_VERSION) {
    warnOnce('restore', `情绪快照版本不匹配（期望 ${CAUSAL_SNAPSHOT_VERSION}），已退回中性基线`)
    return false
  }
  const st = rec.state as Partial<CausalState> | undefined
  if (!st || typeof st !== 'object') {
    warnOnce('restore', '情绪快照缺少 state 字段，已退回中性基线')
    return false
  }
  if (!isFinite01(st.mood) || !isFinite01(st.energy) || !isFinite01(st.affinity) || !isFinite01(st.confidence)) {
    warnOnce('restore', '情绪快照含越界或非法数值，已退回中性基线')
    return false
  }
  try {
    // 用初值重建：基线保持中性，只恢复「起点」——
    // 与 EmotionCausalityEngine 的构造函数语义保持一致。
    _engine = new EmotionCausalityEngine({
      mood: st.mood,
      energy: st.energy,
      affinity: st.affinity,
    })
    return true
  } catch (e) {
    warnOnce('restore', '重建情绪引擎失败，已退回中性基线', e)
    _engine = null
    return false
  }
}

// ═══════════════════════════════════════════════════════════
// 测试辅助
// ═══════════════════════════════════════════════════════════

/**
 * 重置为出厂状态。**仅供单测使用**——
 * 线上没有任何一条业务路径需要「把情绪清零」，那是设置页里
 * 「清空相处记忆」的责任，不在本模块。
 */
export function resetEmotionCausalityForTest(): void {
  _engine = null
  _forcedBroken = false
  _warned.clear()
}

/**
 * 测试辅助：强制进入「引擎不可用」状态。
 *
 * 存在的意义是把降级路径变成**可测的**：
 * 否则「引擎坏掉时主流程不崩」只能靠读代码相信，
 * 而这条恰恰是最不能靠读代码相信的承诺。
 */
export function __forceEmotionCausalityBroken(broken: boolean): void {
  _forcedBroken = broken
}
