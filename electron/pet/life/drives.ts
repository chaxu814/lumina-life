// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// pet/life/drives.ts — ⚡ 内驱力系统 (v0.2)
//
// 之前桌宠的自主行为是「每 8 秒问一次 LLM」的定时反射，没有内在动机。
// 内驱力给它一套会随时间和互动自然消长的「生理/心理需求」：
//   energy    精力（随清醒消耗、深夜走低、睡眠/休息恢复）
//   social    社交需求（越久没理它越高 → 主动搭话/撒娇）
//   curiosity 好奇（长时间没有新刺激就升高 → 张望/走动/提问）
//   comfort   安心感（被夸/陪伴升高，被凶/出错降低）
// 这些内驱力 + 情绪一起决定「现在最想做什么」，再交给大脑生成具体表演。
//
// 纯 TS、时间以分钟注入，便于单测。
// ============================================================

export interface DriveState {
  /** 0 精疲力竭 ~ 1 精力充沛 */
  energy: number
  /** 0 自足 ~ 1 很想找你 */
  social: number
  /** 0 无聊 ~ 1 充满好奇 */
  curiosity: number
  /** 0 不安 ~ 1 安心 */
  comfort: number
}

export const DEFAULT_DRIVES: DriveState = { energy: 0.8, social: 0.3, curiosity: 0.4, comfort: 0.7 }

/** 互动事件类型对各内驱力的影响 */
export type InteractionKind =
  | 'pet' | 'stroke'      // 抚摸
  | 'praise' | 'thanks'   // 夸奖/感谢
  | 'chat' | 'play'       // 聊天/一起玩
  | 'scold' | 'neglect'   // 被凶/被冷落
  | 'task_success'        // 帮上忙
  | 'task_fail'           // 搞砸了
  | 'feed' | 'gift'       // 投喂/礼物
  | 'sleep' | 'rest'      // 睡觉/休息
  | 'novel_stimulus'      // 屏幕/环境出现新鲜事

const INTERACTION_EFFECTS: Record<InteractionKind, Partial<Record<keyof DriveState, number>>> = {
  pet:          { comfort: +0.12, social: -0.18, energy: +0.02 },
  stroke:       { comfort: +0.15, social: -0.2 },
  praise:       { comfort: +0.18, social: -0.12, energy: +0.06 },
  thanks:       { comfort: +0.12, social: -0.1, energy: +0.04 },
  chat:         { social: -0.35, curiosity: -0.12, comfort: +0.05 },
  play:         { social: -0.3, curiosity: -0.2, energy: -0.08, comfort: +0.1 },
  scold:        { comfort: -0.25, social: +0.1, energy: -0.05 },
  neglect:      { comfort: -0.04, social: +0.05 },
  task_success: { comfort: +0.2, energy: -0.05, social: -0.08 },
  task_fail:    { comfort: -0.18, energy: -0.1 },
  feed:         { comfort: +0.1, energy: +0.12 },
  gift:         { comfort: +0.16, social: -0.1 },
  sleep:        { energy: +0.5, comfort: +0.1 },
  rest:         { energy: +0.25 },
  novel_stimulus: { curiosity: -0.3, energy: -0.02 },
}

export interface TickContext {
  /** 距上次 tick 经过的分钟数 */
  dtMin: number
  /** 一天中的小时 0~23（深夜精力回落更快、恢复也快） */
  hourOfDay?: number
  /** 这段时间是否在睡眠 */
  sleeping?: boolean
  /** 这段时间是否有用户互动（无互动则社交需求/无聊上升） */
  hadInteraction?: boolean
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x))

/** 时间推进：内驱力自然消长 */
export function tickDrives(prev: DriveState, ctx: TickContext): DriveState {
  const dt = Math.max(0, ctx.dtMin)
  const hour = ctx.hourOfDay ?? 12
  const isNight = hour >= 23 || hour < 6
  const next: DriveState = { ...prev }

  if (ctx.sleeping) {
    // 睡眠：精力快速恢复，社交/好奇缓降
    next.energy = clamp01(prev.energy + 0.05 * dt)
    next.social = clamp01(prev.social - 0.005 * dt)
    next.curiosity = clamp01(prev.curiosity - 0.004 * dt)
    next.comfort = clamp01(prev.comfort + 0.004 * dt)
    return next
  }

  // 清醒：精力缓慢消耗，夜晚消耗更快
  const energyDrain = (isNight ? 0.006 : 0.0035) * dt
  next.energy = clamp01(prev.energy - energyDrain)
  if (ctx.hadInteraction) {
    next.social = clamp01(prev.social - 0.02 * dt)
    next.curiosity = clamp01(prev.curiosity - 0.008 * dt)
  } else {
    // 被冷落：社交需求与无聊随时间累积
    next.social = clamp01(prev.social + 0.012 * dt)
    next.curiosity = clamp01(prev.curiosity + 0.008 * dt)
  }
  // 低精力会轻微拉低安心感
  next.comfort = clamp01(prev.comfort - Math.max(0, 0.25 - prev.energy) * 0.004 * dt)
  return next
}

/** 应用一次互动事件 */
export function applyInteraction(prev: DriveState, kind: InteractionKind, strength = 1): DriveState {
  const eff = INTERACTION_EFFECTS[kind]
  const next = { ...prev }
  for (const key of Object.keys(eff) as (keyof DriveState)[]) {
    const delta = (eff[key] ?? 0) * strength
    next[key] = clamp01(prev[key] + delta)
  }
  return next
}

/** 行为倾向（供大脑/动作选择加权），数值越高越倾向该行为 */
export interface BehaviorUrges {
  /** 主动搭话/撒娇 */
  seekAttention: number
  /** 睡觉/休息 */
  rest: number
  /** 张望/走动/探索 */
  explore: number
  /** 玩耍/表演 */
  play: number
  /** 安静陪伴（不打扰） */
  calmCompanion: number
}

/** 由内驱力 + 情绪推出当前行为倾向 */
export function behaviorUrges(d: DriveState, emotion?: { valence: number; arousal: number }): BehaviorUrges {
  const v = emotion?.valence ?? 0
  const a = emotion?.arousal ?? 0.4
  return {
    seekAttention: clamp01(d.social * 0.8 + (1 - d.comfort) * 0.3 + (v < -0.3 ? 0.15 : 0)),
    rest: clamp01((1 - d.energy) * 0.9 + (a < 0.25 ? 0.2 : 0)),
    explore: clamp01(d.curiosity * 0.85 + d.energy * 0.2),
    play: clamp01(d.energy * 0.4 + a * 0.4 + v * 0.2),
    calmCompanion: clamp01(d.comfort * 0.6 + (1 - d.social) * 0.3 + (Math.abs(v) < 0.25 ? 0.2 : 0)),
  }
}

/** 选出当前最强倾向（可加随机抖动避免每次相同） */
export function dominantUrge(urges: BehaviorUrges, jitter = 0): keyof BehaviorUrges {
  const entries = Object.entries(urges) as [keyof BehaviorUrges, number][]
  let best: keyof BehaviorUrges = entries[0][0]
  let bestV = -Infinity
  for (const [k, val] of entries) {
    const score = val + (jitter ? (Math.random() - 0.5) * jitter : 0)
    if (score > bestV) { bestV = score; best = k }
  }
  return best
}
