// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// moodstats/types.ts — Mood × Productivity 看板的共享类型
//
// 【这个功能是什么】
// 情绪门控（emotionGating）已经能在焦虑/疲劳时收紧工具名单，
// 但「收紧到底有没有用」目前只有直觉，没有本地证据。
// 本模块把每次委托 / 每次工具执行连同当时的情绪三维一起记下来，
// 让用户（和作者）能用自己的真实数据回答：
//   · 情绪差的时候，成功率是不是真的更低？
//   · 门控开 / 关两组的失败率差多少？
//
// 【设计纪律 —— 诚实优先】
//   1. 样本不足的桶**不**算百分比结论（见 stats.ts 的 MIN_SAMPLE）。
//   2. 采集钩子的任何异常都绝不允许影响委托或工具执行本身。
//   3. A/B 实验默认关闭（仅观测）；对照组会临时关闭情绪门控——
//      这是一个**安全收紧机制**的实验，UI 必须把这句话原样亮给用户。
// ============================================================

import type { FrontendThree } from '../pet/life/emotionCore'

/** 快照类型：一次委托，或一次工具执行 */
export type SnapshotKind = 'delegate' | 'tool'

/**
 * A/B 分组标签（记录在快照上，事后按当时分组统计）。
 * - treatment：实验组，情绪门控正常生效
 * - control：对照组，情绪门控被临时关闭（仍照常记录）
 * - off：实验未开启 / 用户已退出 —— 不做干预，只观测
 */
export type GroupTag = 'treatment' | 'control' | 'off'

/**
 * 一次委托或工具执行的完整快照。
 * 数值一律来自运行时真实读取，不在这里造数。
 */
export interface MoodSnapshot {
  /** 发生时间（epoch ms） */
  ts: number
  kind: SnapshotKind
  /** 发起方 agentId（工具执行 = 调用者；委托 = 委托方） */
  agentId: string
  /** 委托时的目标 agent（yak / recha / intern_xxx）；工具执行为 null */
  targetAgent: string | null
  /** 工具名（file_read / shell_exec…）或委托动作名（delegate / phaseGate / parallel） */
  action: string
  // ── 执行时的情绪三维（FrontendThree：mood -1~1，energy/affinity 0~1）──
  // 读取失败 / 无情绪信息时为 null —— 宁可为空，不猜。
  mood: number | null
  energy: number | null
  affinity: number | null
  /** 本次执行时情绪门控特性开关是否处于「开」（feature flag × 实验干预后的实际值） */
  gateOn: boolean
  /** 本次被门控收紧掉的工具名（来自 emotionAudit / 门控决策；没有则 []） */
  gateSuppressed: string[]
  /** 命中的门控规则 id（anxiety_irreversible / fatigue_heavy） */
  gateRules: string[]
  /** 本次执行时的实验分组 */
  group: GroupTag
  /** 是否成功 */
  ok: boolean
  /** 错误摘要（截断，不记完整堆栈 / 完整参数）；成功为 null */
  errorSummary: string | null
  /** 重试次数（拿不到时为 0 —— 见 snapshotStore.wrapToolExecutor 的诚实限制注释） */
  retries: number
  /** 耗时 ms（优先用工具自己上报的 durationMs；包裹自计时为兜底） */
  durationMs: number
}

/** 门控状态读取器（由接线层注入，本模块不自己找单例） */
export interface GateStateReader {
  (): {
    /** 门控实际是否生效（已经过 feature flag × A/B 干预） */
    on: boolean
    suppressed: string[]
    rules: string[]
  }
}

/** 情绪读取器：返回运行时真实三维；无信息返回 null */
export type EmotionReader = () => FrontendThree | null

/** 分组读取器 */
export type GroupReader = () => GroupTag
